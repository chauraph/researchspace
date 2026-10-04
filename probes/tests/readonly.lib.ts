/**
 * ResearchSpace
 * Copyright (C) 2026, Tsz Kin Chau, eM+ / EPFL
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

/**
 * Shared helpers for probes that must not change the store: they open pages, read and report.
 *
 * READ-ONLY BY CONSTRUCTION: `guard()` routes every request of the context and aborts anything that is
 * not a read (SPARQL update, form persistence, LDP container write, file upload). A blocked request is
 * printed as `[WRITE BLOCKED]`, so a probe that tries to write says so instead of writing.
 *
 * Reports, never asserts.
 */
import { BrowserContext, Page, Request } from '@playwright/test';

export const TF = 'http://www.researchspace.org/resource/ThinkingFrames';
export const CFG = 'http://www.researchspace.org/resource/system/resource_configurations_container/data/';

function isRead(req: Request): boolean {
  const m = req.method();
  const u = req.url();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  if (m !== 'POST') return false;
  if (/\/sparql(\?|$)/.test(u)) {
    const ct = req.headers()['content-type'] || '';
    if (ct.includes('sparql-update')) return false;
    let body = req.postData() || '';
    try { body = decodeURIComponent(body.replace(/\+/g, ' ')); } catch { /* keep raw */ }
    if (/(^|&)update=/.test(req.postData() || '')) return false;
    if (/(^|[\s}])(INSERT|DELETE|LOAD|CLEAR|DROP|CREATE|ADD|MOVE|COPY)\s+(DATA|WHERE|\{|GRAPH|SILENT|<)/i.test(body)) return false;
    return true;
  }
  // read-style POSTs the probed pages were seen to need; anything else is treated as a write.
  // Widen this list only for a path a `[WRITE BLOCKED]` line shows and the Java endpoint proves read-only.
  return /\/rest\/(template|data\/rdf\/utils|security|fields)\b/.test(u);
}

export async function guard(ctx: BrowserContext): Promise<string[]> {
  const blocked: string[] = [];
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    if (isRead(req)) return route.continue();
    const line = `${req.method()} ${req.url().replace(/^https?:\/\/[^/]+/, '').slice(0, 140)} :: ${(req.postData() || '').slice(0, 160).replace(/\s+/g, ' ')}`;
    blocked.push(line);
    console.log(`  [WRITE BLOCKED] ${line}`);
    return route.abort();
  });
  return blocked;
}

export interface Watch { errors: Map<string, number>; failed: Map<string, number>; reset(): void; report(label: string): void; }

export function watch(page: Page): Watch {
  const errors = new Map<string, number>();
  const failed = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  page.on('console', (msg) => { if (msg.type() === 'error') bump(errors, msg.text().replace(/\s+/g, ' ').slice(0, 230)); });
  page.on('pageerror', (e) => bump(errors, `PAGEERROR ${String(e).replace(/\s+/g, ' ').slice(0, 230)}`));
  page.on('response', (r) => {
    if (r.status() >= 400) bump(failed, `${r.status()} ${r.request().method()} ${r.url().replace(/^https?:\/\/127\.0\.0\.1:\d+/, '').slice(0, 150)}`);
  });
  return {
    errors, failed,
    reset() { errors.clear(); failed.clear(); },
    report(label: string) {
      const total = [...errors.values()].reduce((a, b) => a + b, 0);
      console.log(`  [${label}] console errors: ${total} (${errors.size} distinct); http>=400: ${[...failed.values()].reduce((a, b) => a + b, 0)}`);
      [...errors.entries()].slice(0, 6).forEach(([k, n]) => console.log(`      err x${n}: ${k}`));
      [...failed.entries()].slice(0, 6).forEach(([k, n]) => console.log(`      http x${n}: ${k}`));
    },
  };
}

export function frameUrl(base: string, params: Record<string, string>): string {
  const q = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `${base}/resource/?uri=${encodeURIComponent(TF)}&${q}`;
}

export function resourceUrl(base: string, iri: string): string {
  return `${base}/resource/?uri=${encodeURIComponent(iri)}`;
}

/** Go to a URL, wait for content (never networkidle), settle, and say how long the content took. */
export async function open(page: Page, label: string, url: string, ready: string | null, settle = 2500, timeout = 60_000): Promise<boolean> {
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  let ok = true;
  if (ready) ok = await page.waitForSelector(ready, { timeout, state: 'attached' }).then(() => true).catch(() => false);
  const t = Date.now() - t0;
  await page.waitForTimeout(settle);
  console.log(`  [${label}] ready(${ready ?? 'none'})=${ok} after ${t} ms`);
  return ok;
}

export async function counts(page: Page, selectors: Record<string, string>): Promise<Record<string, number>> {
  return page.evaluate((sel) => {
    const out: Record<string, number> = {};
    for (const k of Object.keys(sel)) out[k] = document.querySelectorAll(sel[k]).length;
    return out;
  }, selectors);
}

/** Visible text of a container: length, a snippet, and raw IRIs shown where a label is expected. */
export async function text(page: Page, selector = 'body', snippet = 160) {
  return page.evaluate(({ selector, snippet }) => {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (!el) return { found: false, length: 0, snippet: '', rawIris: [] as string[] };
    const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
    const iris = Array.from(new Set(t.match(/https?:\/\/[^\s"'<>)]+/g) ?? []));
    return { found: true, length: t.length, snippet: t.slice(0, snippet), rawIris: iris.slice(0, 8), rawIriCount: iris.length };
  }, { selector, snippet });
}

export async function select(page: Page, base: string, query: string): Promise<Record<string, string>[]> {
  const r = await page.request.get(`${base}/sparql`, {
    params: { query },
    headers: { Accept: 'application/sparql-results+json' },
  });
  if (!r.ok()) { console.log(`  [sparql] HTTP ${r.status()}`); return []; }
  const j = await r.json();
  return j.results.bindings.map((b: any) => Object.fromEntries(Object.keys(b).map((k) => [k, b[k].value])));
}

export async function tripleCount(page: Page, base: string): Promise<string> {
  const rows = await select(page, base, 'SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } }');
  return rows[0]?.n ?? '?';
}
