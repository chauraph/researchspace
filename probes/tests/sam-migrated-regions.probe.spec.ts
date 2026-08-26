/**
 * Probe for the one property the store cannot prove after
 * dist/migrations/rs-2026-08 task 02: that regions drawn by the RETIRED
 * server-side SAM tool, whose shape ids were rewritten `sam_` → `samlocal_`,
 * are still bound to a drawing tool and can therefore still be RESHAPED.
 *
 * Why this is the check that matters. Mirador maps a stored shape back to its
 * tool by matching the shape id's prefix (osd-svg-overlay.js:654 for the
 * toolbar, :818 for getTool), and :571 hands a drag to that tool. A shape whose
 * prefix matches no tool still renders, still selects and still deletes — it is
 * only dragging that silently does nothing. So a screenshot proves nothing here
 * and only a driven drag does.
 *
 * Image 5d0bdf04 was chosen because all 15 of its regions are migrated ones.
 *
 * NOTHING IS SAVED. The drag is left uncommitted and the page is reloaded, so
 * the store is untouched; the probe re-reads the census at the end to say so.
 *
 * Reports, never asserts. A failing probe is a broken probe.
 */
import { test } from '@playwright/test';

test.use({
  launchOptions: {
    args: [
      '--enable-unsafe-webgpu',
      '--use-angle=metal',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--disable-software-rasterizer',
    ],
  },
});

const TEMPLATE = 'http://www.researchspace.org/resource/SamMigratedRegionsTest';

test('migrated sam regions are still reshapeable', async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`  [browser error] ${msg.text().slice(0, 200)}`);
    if (msg.type() === 'warning' && /^Sam[: ]/.test(msg.text())) {
      console.log(`  [tool warn] ${msg.text().slice(0, 200)}`);
    }
  });
  page.on('pageerror', (err) => console.log(`  [pageerror] ${String(err).slice(0, 200)}`));

  await page.goto(`${baseURL}/resource/?uri=${encodeURIComponent(TEMPLATE)}`, {
    waitUntil: 'domcontentloaded',
  });
  try {
    await page.waitForSelector('.mirador-osd canvas', { timeout: 60_000 });
  } catch (e) {
    console.log('  [probe] mirador never mounted');
    return;
  }
  // Regions arrive with the annotation list, well after the canvas exists.
  await page.waitForTimeout(8_000);

  // Walk paper's scope registry for the annotation overlay's canvas — the
  // Mirador instance is inside the React component, so there is no
  // window.Mirador.viewer to reach for (same trick as sam2-mirador.probe).
  const shapes = () => page.evaluate(() => {
    const paper = (window as any).paper;
    const scopes: any[] = Object.keys(paper?.PaperScope?._scopes ?? {}).map(
      (k) => paper.PaperScope._scopes[k]);
    const out: { name: string; prefix: string }[] = [];
    for (const s of scopes) {
      if (String(s?.view?.element?.id ?? '').indexOf('draw_canvas_') !== 0) continue;
      for (const c of s.project?.activeLayer?.children ?? []) {
        if (!c.name) continue;
        out.push({ name: c.name, prefix: String(c.name).split('_')[0] + '_' });
      }
    }
    return out;
  });

  const drawn = await shapes();
  const byPrefix: Record<string, number> = {};
  drawn.forEach((s) => { byPrefix[s.prefix] = (byPrefix[s.prefix] ?? 0) + 1; });
  console.log(`  [probe] shapes rendered: ${drawn.length} ${JSON.stringify(byPrefix)}`);
  if (!drawn.some((s) => s.prefix === 'samlocal_')) {
    console.log('  [probe] no samlocal_ shape on canvas — nothing to drive');
    return;
  }

  // Drive one shape PER PREFIX, not just a migrated one. Without the control
  // shapes this probe cannot tell "this prefix binds to no tool" apart from
  // "the viewer is not in a mode where anything can be dragged": rectangle_ and
  // ellipse_ belong to tools that certainly still exist, so if they do not move
  // either, the probe is measuring the mode and reports nothing about task 02.
  const pickPoint = (prefix: string) => page.evaluate((pfx: string) => {
    const paper = (window as any).paper;
    const scopes: any[] = Object.keys(paper.PaperScope._scopes).map((k) => paper.PaperScope._scopes[k]);
    for (const s of scopes) {
      if (String(s?.view?.element?.id ?? '').indexOf('draw_canvas_') !== 0) continue;
      for (const c of s.project?.activeLayer?.children ?? []) {
        if (!c.name || String(c.name).indexOf(pfx) !== 0) continue;
        const p = c.getPointAt ? c.getPointAt(c.length / 2) : c.bounds.center;
        const v = s.view.projectToView(p);
        const r = s.view.element.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        return {
          name: c.name,
          page: { x: r.left + v.x / dpr, y: r.top + v.y / dpr },
          bounds: { x: c.bounds.x, y: c.bounds.y, w: c.bounds.width, h: c.bounds.height },
        };
      }
    }
    return null;
  }, prefix);

  const boundsOf = (name: string) => page.evaluate((n: string) => {
    const paper = (window as any).paper;
    const scopes: any[] = Object.keys(paper.PaperScope._scopes).map((k) => paper.PaperScope._scopes[k]);
    for (const s of scopes) {
      for (const c of s.project?.activeLayer?.children ?? []) {
        if (c.name === n) return { x: c.bounds.x, y: c.bounds.y, w: c.bounds.width, h: c.bounds.height };
      }
    }
    return null;
  }, name);

  // THE CHECK. Mirador.getTools memoises the live tool instances on the global
  // (osd-svg-overlay.js:2-9), so the page can run the very lookups the viewer
  // runs — getTool's substring match (:818) and the toolbar's first-underscore
  // / longPrefix match (:654) — against every shape actually on the canvas.
  // A stored prefix that resolves to no tool is exactly the task-02 regression,
  // and unlike a drag this needs no particular editing mode to observe.
  const binding = await page.evaluate(() => {
    const M = (window as any).Mirador;
    const tools = (M?.svgOverlayTools ?? []).map((t: any) => ({
      name: t.name, idPrefix: t.idPrefix, logoClass: t.logoClass,
    }));
    const paper = (window as any).paper;
    const scopes: any[] = Object.keys(paper?.PaperScope?._scopes ?? {}).map((k) => paper.PaperScope._scopes[k]);
    const names: string[] = [];
    for (const s of scopes) {
      if (String(s?.view?.element?.id ?? '').indexOf('draw_canvas_') !== 0) continue;
      for (const c of s.project?.activeLayer?.children ?? []) if (c.name) names.push(String(c.name));
    }
    const resolve = (n: string) => {
      // getTool, osd-svg-overlay.js:818
      const byGetTool = tools.find((t: any) => n.indexOf(t.idPrefix) !== -1);
      // toolbar lookup, osd-svg-overlay.js:643-656
      const prefix = n.substring(0, n.indexOf('_') + 1);
      const parts = n.split('_');
      const longPrefix = parts[0] + '_' + parts[1] + '_';
      const byToolbar = tools.find((t: any) => t.idPrefix === prefix || t.idPrefix === longPrefix);
      return { byGetTool: byGetTool?.name ?? null, byToolbar: byToolbar?.name ?? null };
    };
    const perPrefix: Record<string, any> = {};
    for (const n of names) {
      const pfx = n.split('_')[0] + '_';
      if (!perPrefix[pfx]) perPrefix[pfx] = { count: 0, ...resolve(n) };
      perPrefix[pfx].count++;
    }
    return { tools, perPrefix };
  });
  console.log(`  [tools] registered: ${JSON.stringify(binding.tools)}`);
  for (const [pfx, r] of Object.entries<any>(binding.perPrefix)) {
    const ok = r.byGetTool && r.byToolbar;
    console.log(`  [bind] ${pfx.padEnd(11)} x${String(r.count).padEnd(3)} getTool=${String(r.byGetTool).padEnd(9)} ` +
                `toolbar=${String(r.byToolbar).padEnd(9)} ${ok ? 'BOUND' : '*** UNBOUND — regression ***'}`);
  }
  const retired = binding.tools.some((t: any) => t.idPrefix === 'sam_');
  console.log(`  [tools] retired server-side tool (idPrefix sam_) still registered: ${retired ? 'YES — excise incomplete' : 'no'}`);

  // Which HUD controls exist, and what is selected. Editing an existing shape
  // needs the overlay out of pointer mode; without that every drag below is a
  // no-op regardless of prefix.
  const hud = await page.evaluate(() => Array.from(document.querySelectorAll('[class*="mirador-osd-"]'))
    .map((el) => (el as HTMLElement).className)
    .filter((c) => /mode|layer/.test(c))
    .slice(0, 20));
  console.log(`  [probe] hud controls: ${JSON.stringify(hud)}`);
  const editBtn = page.locator('.mirador-osd-edit-mode').first();
  if (await editBtn.count()) {
    await editBtn.click({ force: true });
    await page.waitForTimeout(800);
    console.log(`  [probe] clicked edit-mode; class now: ${await editBtn.getAttribute('class')}`);
  } else {
    console.log('  [probe] no .mirador-osd-edit-mode control on the page');
  }

  const results: string[] = [];
  for (const prefix of Object.keys(byPrefix)) {
    const t = await pickPoint(prefix);
    if (!t) { results.push(`${prefix} (no shape)`); continue; }
    await page.mouse.move(t.page.x, t.page.y);
    await page.waitForTimeout(300);
    await page.mouse.down();
    await page.waitForTimeout(150);
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(t.page.x + i * 8, t.page.y + i * 4);
      await page.waitForTimeout(50);
    }
    await page.mouse.up();
    await page.waitForTimeout(500);
    const after = await boundsOf(t.name);
    const moved = !!after && (Math.abs(after.x - t.bounds.x) > 1e-6 || Math.abs(after.y - t.bounds.y) > 1e-6);
    console.log(`  [drag] ${prefix.padEnd(11)} ${t.name.slice(0, 46)} moved=${moved ? 'YES' : 'no '} ` +
                `dx=${after ? (after.x - t.bounds.x).toFixed(1) : 'n/a'}`);
    results.push(`${prefix}${moved ? 'YES' : 'no'}`);
  }
  console.log(`  [probe] drag outcome per prefix: ${results.join('  ')}`);
  console.log('  [probe] The drag is a SECONDARY signal: it only moves a shape when the viewer');
  console.log('  [probe]   is in a mode that edits existing annotations. If every prefix says no,');
  console.log('  [probe]   read the [bind] lines above instead — those are mode-independent.');
  await page.screenshot({ path: 'output/sam-migrated-regions.png' });

  // Leave without saving, then prove the store is untouched.
  await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
  const census = await page.request.get(`${baseURL}/sparql`, {
    params: {
      query: `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
              SELECT ?tool (COUNT(*) AS ?n) WHERE {
                ?s rdf:value ?v . FILTER(isLiteral(?v) && CONTAINS(STR(?v), "<svg"))
                BIND(IF(CONTAINS(STR(?v), 'id="samlocal_'), "samlocal",
                     IF(CONTAINS(STR(?v), 'id="sam_'), "sam-server", "other")) AS ?tool)
              } GROUP BY ?tool`,
    },
    headers: { Accept: 'text/csv' },
  });
  console.log(`  [probe] store after (unchanged expected):\n${(await census.text()).trim()}`);
});
