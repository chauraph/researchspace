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
 * The Reactodia workspace of a saved knowledge map, ALL IN MEMORY.
 * Adds an entity, opens the halo, drags the halo's establish-link handle to another card, creates a link
 * through the model, exports SVG and PNG through the toolbar. The map is never saved: the Save button is
 * not touched, the request guard aborts every write, and the saved layout is re-counted at the end.
 *
 * The workspace object is not exported to the page, so it is reached from the DOM: from a card element, walk
 * the React fiber chain upwards to the context provider whose value holds { model, editor, view }.
 *
 * MAP=<diagram IRI> and ADD=<entity IRI> choose the map and the entity to add; without them the probe takes the
 * first saved diagram and the first E53 Place of the store.
 * Reports, never asserts.
 */
import { test } from '@playwright/test';
import * as fs from 'node:fs';
import { guard, watch, frameUrl, open, select } from './readonly.lib';

const FIRST_MAP = `PREFIX o: <http://ontodia.org/schema/v1#>
  SELECT ?d WHERE { GRAPH ?g { ?d a o:Diagram . ?el a o:Element } } GROUP BY ?d HAVING(COUNT(?el) > 1) ORDER BY ?d LIMIT 1`;
const FIRST_PLACE = `SELECT ?p WHERE { ?p a <http://www.cidoc-crm.org/cidoc-crm/E53_Place> } ORDER BY ?p LIMIT 1`;
const saved = (map: string) => `PREFIX o: <http://ontodia.org/schema/v1#>
  SELECT (COUNT(DISTINCT ?el) AS ?elements) (COUNT(DISTINCT ?ln) AS ?links) WHERE {
    GRAPH ?g { <${map}> a o:Diagram . { ?el a o:Element } UNION { ?ln a o:Link } } }`;

test('knowledge map workspace: add / halo / link / export, in memory', async ({ page, context, baseURL }) => {
  test.setTimeout(420_000);
  const base = baseURL!;
  const blocked = await guard(context);
  const w = watch(page);
  const MAP = process.env.MAP ?? (await select(page, base, FIRST_MAP))[0]?.d;
  const ADD = process.env.ADD ?? (await select(page, base, FIRST_PLACE))[0]?.p;
  if (!MAP || !ADD) { console.log(`  [input] no saved map (${MAP}) or no place to add (${ADD}): stop`); return; }
  console.log(`  [input] map ${MAP}`);
  console.log(`  [input] entity to add ${ADD}`);
  const SAVED = saved(MAP);
  const saved0 = (await select(page, base, SAVED))[0];
  console.log(`  [store] saved layout before: ${saved0?.elements} elements / ${saved0?.links} links`);

  const ok = await open(page, 'map', frameUrl(base, { view: 'knowledge-map', resource: MAP }), '[data-element-id]', 10_000, 90_000);
  if (!ok) { console.log('  [map] no card rendered: stop'); w.report('map'); return; }

  const dom = () => page.evaluate(() => ({
    elements: new Set(Array.from(document.querySelectorAll('[data-element-id]')).map((e) => e.getAttribute('data-element-id'))).size,
    links: new Set(Array.from(document.querySelectorAll('[data-link-id]')).map((e) => e.getAttribute('data-link-id'))).size,
    halo: document.querySelectorAll('.reactodia-halo').length,
    actions: Array.from(document.querySelectorAll('.reactodia-selection-action')).map((b) => (String((b as HTMLElement).className).match(/reactodia-selection-action__[a-z-]+/) || ['?'])[0].replace('reactodia-selection-action__', '')),
    dialogs: document.querySelectorAll('.reactodia-dialog, [role="dialog"], .modal.in').length,
  }));

  const ws = await page.evaluate(() => {
    const el = document.querySelector('[data-element-id]') as any;
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    if (!key) return { key: null as string | null, found: false, model: 0, links: 0, api: [] as string[] };
    for (let f = el[key]; f; f = f.return) {
      const v = f.type && f.type._context && f.memoizedProps && f.memoizedProps.value;
      if (v && v.model && v.editor && v.view) {
        (window as any).__mgWs = v;
        return {
          key: key.split('$')[0], found: true, model: v.model.elements.length, links: v.model.links.length,
          api: ['createElement', 'requestElementData', 'requestLinks', 'createLinks', 'addLink', 'setSelection'].filter((n) => typeof v.model[n] === 'function')
            .concat(['createRelation', 'createEntity'].filter((n) => typeof v.editor[n] === 'function').map((n) => `editor.${n}`)),
        };
      }
    }
    return { key: key.split('$')[0], found: false, model: 0, links: 0, api: [] };
  });
  console.log(`  [react] fiber key prefix: ${ws.key} (React 17+ uses __reactFiber, 16 uses __reactInternalInstance)`);
  console.log(`  [workspace] reached=${ws.found}; model: ${ws.model} elements / ${ws.links} links; API: ${JSON.stringify(ws.api)}`);
  console.log(`  [map] rendered at load: ${JSON.stringify(await dom())}`);
  w.report('map load'); w.reset();
  if (!ws.found) return;

  // 0. the class tree lives in the collapsed left panel of the workspace
  await page.locator('button[title="Expand panel"]').first().click().catch(() => console.log('  [class tree] no "Expand panel" button'));
  await page.waitForSelector('.reactodia-class-tree', { timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(6000);
  const tree = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('.reactodia-class-tree-item__label, .reactodia-class-tree-item__body')).map((e) => ((e as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const cls = Array.from(new Set(Array.from(document.querySelectorAll('[class*="reactodia-class-tree"]')).flatMap((e) => String((e as any).className?.baseVal ?? (e as any).className).split(/\s+/)).filter((c) => /class-tree/.test(c))));
    return { present: document.querySelectorAll('.reactodia-class-tree').length, items: document.querySelectorAll('.reactodia-class-tree-item').length, labels: labels.length, rawIri: labels.filter((l) => /https?:\/\//.test(l)).length, first: labels.slice(0, 10), cls: cls.slice(0, 20) };
  });
  console.log(`  [class tree] ${JSON.stringify(tree)}`);
  w.report('class tree'); w.reset();

  // 1. add an entity (in memory)
  const added = await page.evaluate(async (iri) => {
    const { model } = (window as any).__mgWs;
    try {
      const el = model.createElement(iri);
      el.setPosition?.({ x: 80, y: 80 });
      await model.requestElementData([iri]);
      if (typeof model.requestLinks === 'function') await model.requestLinks();
      return { id: el.id as string, label: JSON.stringify(el.data?.label ?? el.data?.properties ?? '').slice(0, 120), types: (el.data?.types ?? []).slice(0, 3), elements: model.elements.length, links: model.links.length, error: '' };
    } catch (e) { return { id: '', label: '', types: [], elements: model.elements.length, links: model.links.length, error: String(e).slice(0, 200) }; }
  }, ADD);
  await page.waitForTimeout(4000);
  console.log(`  [add entity] ${JSON.stringify(added)}`);
  const cardText = added.id ? await page.locator(`[data-element-id="${added.id}"]`).first().innerText().catch(() => '(not in DOM)') : '(no id)';
  console.log(`  [add entity] card text: "${cardText.replace(/\s+/g, ' ').slice(0, 100)}"; DOM: ${JSON.stringify(await dom())}`);
  w.report('add entity'); w.reset();

  // 2. halo: click the new card
  if (added.id) {
    await page.evaluate(() => (window as any).__mgWs.view.findAnyCanvas()?.zoomToFit?.());
    await page.waitForTimeout(1500);
    await page.locator(`[data-element-id="${added.id}"]`).first().click({ position: { x: 12, y: 12 } }).catch((e) => console.log(`  [halo] click failed: ${String(e).slice(0, 120)}`));
    await page.waitForTimeout(1500);
    const h = await dom();
    const sel = await page.evaluate(() => (window as any).__mgWs.model.selection.length);
    console.log(`  [halo] selection: ${sel}; halo nodes: ${h.halo}; actions: ${JSON.stringify(h.actions)}`);
    w.report('halo'); w.reset();

    // 3. draw a link: drag the halo's establish-link handle onto another card
    const handle = page.locator('.reactodia-selection-action__establish-link').first();
    const target = page.locator(`[data-element-id]:not([data-element-id="${added.id}"])`).first();
    const hb = await handle.boundingBox().catch(() => null);
    const tb = await target.boundingBox().catch(() => null);
    const linksBefore = await page.evaluate(() => (window as any).__mgWs.model.links.length);
    if (hb && tb) {
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
      await page.mouse.down();
      await page.mouse.move(hb.x + hb.width / 2 + 20, hb.y + hb.height / 2 + 20, { steps: 4 });
      await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 12 });
      const mid = await page.evaluate(() => ({ temp: document.querySelectorAll('.reactodia-halo-link, [class*="establish"], [class*="drag-link" i], [class*="temporary" i]').length }));
      await page.mouse.up();
      await page.waitForTimeout(2500);
      const after = await page.evaluate(() => {
        const m = (window as any).__mgWs.model;
        const dlg = document.querySelector('.reactodia-dialog, [role="dialog"], .modal.in') as HTMLElement | null;
        return { links: m.links.length, dialog: !!dlg, dialogText: (dlg?.innerText || '').replace(/\s+/g, ' ').slice(0, 220), authoring: (window as any).__mgWs.editor?.inAuthoringMode };
      });
      console.log(`  [draw link] handle found; nodes during drag: ${mid.temp}; model links ${linksBefore} -> ${after.links}; dialog opened: ${after.dialog}; authoring mode: ${after.authoring}`);
      if (after.dialog) console.log(`  [draw link] dialog: "${after.dialogText}"`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
    } else {
      console.log(`  [draw link] establish-link handle box: ${JSON.stringify(hb)}; target box: ${JSON.stringify(tb)} (no drag done)`);
    }
    w.report('draw link (UI)'); w.reset();

    // 3b. the same through the model, so a link is in memory even if the UI path needs a type choice
    const api = await page.evaluate((id) => {
      const { model } = (window as any).__mgWs;
      const other = model.elements.find((e: any) => e.id !== id && e.data);
      const src = model.elements.find((e: any) => e.id === id);
      const before = model.links.length;
      try {
        if (typeof model.createLinks === 'function') {
          model.createLinks({ sourceId: src.data.id, targetId: other.data.id, linkTypeId: 'http://www.cidoc-crm.org/cidoc-crm/P67_refers_to', properties: {} });
        }
        return { before, after: model.links.length, error: '' };
      } catch (e) { return { before, after: model.links.length, error: String(e).slice(0, 200) }; }
    }, added.id);
    await page.waitForTimeout(1500);
    console.log(`  [draw link (model.createLinks)] ${JSON.stringify(api)}; DOM: ${JSON.stringify(await dom())}`);
    w.report('draw link (model)'); w.reset();
  }

  // 4. export through the toolbar menu
  for (const kind of ['SVG', 'PNG']) {
    try {
      await page.locator('#export-diagram-button').first().click();
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 60_000 }),
        page.getByText(`Export as ${kind}`, { exact: false }).first().click(),
      ]);
      const p = await dl.path();
      const buf = p ? fs.readFileSync(p) : Buffer.alloc(0);
      const head = kind === 'SVG' ? buf.subarray(0, 60).toString('utf8').replace(/\s+/g, ' ') : buf.subarray(0, 8).toString('hex');
      const extra = kind === 'SVG' ? `; <svg: ${buf.toString('utf8').includes('<svg')}; foreignObject: ${(buf.toString('utf8').match(/<foreignObject/g) || []).length}; paths: ${(buf.toString('utf8').match(/<path/g) || []).length}` : `; PNG signature: ${buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'}`;
      console.log(`  [export ${kind}] file ${dl.suggestedFilename()}, ${buf.length} bytes, starts "${head}"${extra}`);
    } catch (e) {
      console.log(`  [export ${kind}] no download: ${String(e).replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    w.report(`export ${kind}`); w.reset();
  }

  const saved1 = (await select(page, base, SAVED))[0];
  console.log(`  [store] saved layout after: ${saved1?.elements} elements / ${saved1?.links} links (before ${saved0?.elements}/${saved0?.links})`);
  console.log(`  [guard] writes blocked: ${blocked.length}`);
});
