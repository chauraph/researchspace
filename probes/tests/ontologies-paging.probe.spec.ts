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
 * The Ontologies list (`assets/Ontologies`) is a `semantic-table` with a `tuple-template`: paging re-uses the row
 * components with new data. Each row's title and its View button are `semantic-link`s with their own text; a link
 * that drops its label when its IRI changes renders nothing. Per page: rows, titles, View buttons.
 *
 * Read-only, and stricter than the guard alone: opening this page asks `GET /rs/kp/getGeneratedKpsAndResponse`
 * for some ontologies, which REGENERATES their knowledge patterns. Those requests are aborted here.
 * Reports, never asserts.
 */
import { test } from '@playwright/test';
import { guard, resourceUrl } from './readonly.lib';

test('Ontologies list: every row keeps its title and View button after paging', async ({ page, context, baseURL }) => {
  const blocked = await guard(context);
  let kp = 0;
  await context.route('**/rs/kp/**', (r) => { kp++; return r.abort(); });
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  await page.goto(resourceUrl(baseURL!, 'http://www.researchspace.org/resource/assets/Ontologies'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=knowledge pattern', { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(6000);
  const read = () => page.evaluate(() => {
    const out: any[] = [];
    document.querySelectorAll('h3').forEach((h) => {
      const card = h.parentElement!;
      const a = h.querySelector('a');
      out.push({ iri: card.querySelector('p')?.textContent?.trim(), link: !!a, title: a?.textContent?.trim() ?? null, h3: h.innerHTML.trim().slice(0, 90) });
    });
    return out;
  });
  for (let pg = 1; pg <= 4; pg++) {
    const rows = await read();
    console.log(`--- page ${pg}: rows=${rows.length} views=${await page.locator('button[title="View ontology"]').count()} kpGetAborted=${kp} writesBlocked=${blocked.length}`);
    for (const r of rows) console.log(JSON.stringify(r));
    const next = page.locator('.pagination li:not(.disabled) a', { hasText: String(pg + 1) }).first();
    if (!(await next.count())) break;
    await next.click();
    await page.waitForTimeout(5000);
  }
  console.log('view buttons:', await page.locator('button[title="View ontology"]').count());
  console.log('console errors:', errors.length, JSON.stringify([...new Set(errors)].slice(0, 6)));
});
