/**
 * Live probe for the $.SamLocal Mirador tool (plan-doc phases 3-4) against a
 * running stack. Opens rsp:IIIFSingleImageView on an image found via SPARQL,
 * then reports: toolbar gate (SamLocal button present iff WebGPU), engine
 * global, the phase-4 hover preview (mask painted on the dedicated overlay
 * canvas, changing with the cursor, surviving a viewport change, one encode for
 * the whole hover session), and a driven segmentation — click the image, wait
 * for the mask decode, double-click to commit, count samlocal_ paths, save.
 *
 * Chromium needs real-GPU flags: headless WebGPU otherwise lands on
 * SwiftShader and the availability gate hides the button.
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

// Harness template in the runtime layer with the image IRI baked in — see
// runtime-data/data/templates/…SamLocalTest.html (IIIFSingleImageView is only
// usable as a partial; its [[image]] parameter cannot come from the URL).
const TEMPLATE = 'http://www.researchspace.org/resource/SamLocalTest';

test('samlocal tool in mirador', async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.log(`  [browser error] ${msg.text().slice(0, 250)}`);
    }
  });
  page.on('pageerror', (err) => console.log(`  [pageerror] ${String(err).slice(0, 250)}`));
  page.on('response', (resp) => {
    if (resp.status() >= 400) {
      console.log(`  [http ${resp.status()}] ${resp.url().slice(0, 180)}`);
    }
  });
  // The IIIF info.json gives the full-image pixel size, needed to aim the mouse
  // at the image rather than at the viewer's letterbox (see below).
  let imageSize: { width: number; height: number } | null = null;
  page.on('response', async (resp) => {
    if (!imageSize && /info\.json$/.test(resp.url())) {
      try {
        const json = await resp.json();
        if (json.width && json.height) imageSize = { width: json.width, height: json.height };
      } catch (e) { /* not the image info document */ }
    }
  });

  await page.goto(
    `${baseURL}/resource/?uri=${encodeURIComponent(TEMPLATE)}`,
    { waitUntil: 'domcontentloaded' }
  );

  // Mirador mounts lazily; OSD canvas appearing means the viewer is live.
  try {
    await page.waitForSelector('.mirador-osd canvas', { timeout: 60_000 });
  } catch (e) {
    const miradorDiv = await page.locator('.mirador').count();
    const bodyText = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300);
    console.log(`  [probe] mirador never mounted. .mirador divs=${miradorDiv} body: ${bodyText}`);
    return;
  }
  await page.waitForTimeout(3_000); // let OSD settle tiles

  const gate = await page.evaluate(() => ({
    engine: typeof (window as any).RsSamEngine,
    webgpu: !!(navigator as any).gpu,
  }));
  console.log(`  [probe] RsSamEngine=${gate.engine} navigator.gpu=${gate.webgpu}`);

  // Enter annotation-creation mode (pencil in the HUD), then look at tools.
  const pencil = page.locator('.mirador-osd-annotations-layer').first();
  console.log(`  [probe] annotation layer button: ${await pencil.count()}`);
  /* eslint-disable no-constant-condition */
  if (false) { // pencil diagnostics kept for reference; annotation mode is ON by default in this config
  const handlerDiag = await page.evaluate(() => {
    const el = document.querySelector('.mirador-osd-annotations-layer') as HTMLElement;
    (window as any).__pencilClicks = 0;
    el.addEventListener('click', () => { (window as any).__pencilClicks++; }, true);
    const jq = (window as any).jQuery;
    const events = jq && jq._data ? jq._data(el, 'events') : undefined;
    return { jqueryEvents: events ? Object.keys(events) : null };
  });
  console.log(`  [probe] pencil jquery handlers: ${JSON.stringify(handlerDiag)}`);
  await pencil.click();
  await page.waitForTimeout(1_000);
  console.log(`  [probe] pencil clicks seen in page: ${await page.evaluate(() => (window as any).__pencilClicks)}`);
  const hudDump = await page.evaluate(() => ({
    selected: Array.from(document.querySelectorAll('.selected')).map((el) => el.className.split(' ')[0]).slice(0, 8),
    pencilClasses: document.querySelector('.mirador-osd-annotations-layer')!.className,
    contextControlsHtmlLen: (document.querySelector('.mirador-osd-context-controls') as HTMLElement)?.innerHTML.length,
    annotationToolsContainers: Array.from(document.querySelectorAll('.mirador-osd-context-controls > div')).map(
      (el) => ({ cls: el.className, display: getComputedStyle(el as HTMLElement).display })),
  }));
  console.log(`  [probe] hud after 1 click: ${JSON.stringify(hudDump)}`);
  const clickHandlers = await page.evaluate(() => {
    const el = document.querySelector('.mirador-osd-annotations-layer') as HTMLElement;
    const jq = (window as any).jQuery;
    const events = jq._data(el, 'events');
    return (events.click || []).map((h: any) => String(h.handler).slice(0, 120));
  });
  console.log(`  [probe] click handlers on pencil: ${JSON.stringify(clickHandlers)}`);
  }

  // Annotation mode is on by default (mirador-osd-annotation-controls is
  // display:block at load); the tool anchors reveal on hovering the controls.
  const controls = page.locator('.mirador-osd-annotation-controls').first();
  const controlsBox = await controls.boundingBox();
  console.log(`  [probe] annotation-controls box: ${JSON.stringify(controlsBox)}`);
  if (controlsBox) {
    await page.mouse.move(controlsBox.x + 10, controlsBox.y + 10);
    await page.waitForTimeout(800);
  }
  const toolVis = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.mirador-osd-edit-mode')).map((el) => ({
      cls: el.className.match(/mirador-osd-([a-z_]+)-mode/)?.[1],
      display: getComputedStyle(el as HTMLElement).display,
    })));
  console.log(`  [probe] tools after hover: ${JSON.stringify(toolVis)}`);
  const palette = await page.evaluate(() => {
    const controls = document.querySelector('.mirador-osd-context-controls');
    const tools = Array.from(document.querySelectorAll('.mirador-osd-edit-mode')).map((el) => {
      const rect = (el as HTMLElement).getBoundingClientRect();
      const style = getComputedStyle(el as HTMLElement);
      return { cls: el.className.split(' ')[0], w: rect.width, display: style.display, vis: style.visibility };
    });
    return { controlsPresent: !!controls, tools };
  });
  console.log(`  [probe] palette: ${JSON.stringify(palette)}`);
  await page.screenshot({ path: 'output/samlocal-palette.png' });

  for (const [name, selector] of [
    ['Sam (server)', '.mirador-osd-flare-mode'],
    ['SamLocal', '.mirador-osd-auto_awesome-mode'],
  ]) {
    const count = await page.locator(selector).count();
    console.log(`  [probe] toolbar ${name}: ${count ? 'present' : 'ABSENT'}`);
  }

  const samLocal = page.locator('.mirador-osd-auto_awesome-mode').first();
  if (!(await samLocal.count())) {
    console.log('  [probe] SamLocal button missing — gate closed or registration broken');
    return;
  }
  const toolBox = await samLocal.boundingBox();
  console.log(`  [probe] samLocal box: ${JSON.stringify(toolBox)}`);
  if (toolBox && toolBox.width > 0) {
    await page.mouse.move(toolBox.x + toolBox.width / 2, toolBox.y + toolBox.height / 2);
    await page.waitForTimeout(300);
    await page.mouse.click(toolBox.x + toolBox.width / 2, toolBox.y + toolBox.height / 2);
  } else {
    console.log('  [probe] samLocal button has no box — palette still hidden, aborting drive');
    return;
  }
  await page.waitForTimeout(500);

  const pill = page.locator('.mirador-sam-status-overlay');
  const pillText = async () =>
    (await pill.count()) ? (await pill.first().innerText()).replace(/\s+/g, ' ') : '(no pill)';

  // Hover/click points must land ON the image: this manifest is portrait
  // (2148x3275) inside a landscape viewer, so most of the container is
  // letterbox and a naive container-relative point misses the image entirely
  // (cssToEngine returns null and nothing happens). Recreate OSD's home fit
  // from the container rect + info.json size to convert image fractions into
  // page coordinates. Valid while the viewer is at home, which it is at load.
  const geom = await page.evaluate(([iw, ih]) => {
    const el = document.querySelector('.mirador-osd') as HTMLElement;
    const r = el.getBoundingClientRect();
    const scale = Math.min(r.width / iw, r.height / ih);
    const w = iw * scale, h = ih * scale;
    return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, w, h,
      container: { w: r.width, h: r.height } };
  }, [imageSize?.width ?? 1, imageSize?.height ?? 1]);
  const at = (fx: number, fy: number) => ({ x: geom.left + geom.w * fx, y: geom.top + geom.h * fy });
  console.log(`  [probe] image size ${imageSize?.width}x${imageSize?.height}, on-screen rect ${JSON.stringify(geom)}`);

  const A = at(0.4, 0.35);
  const B = at(0.62, 0.7);
  const C = { x: A.x + 3, y: A.y + 3 };
  const centre = at(0.5, 0.5);

  // Alpha stats of the preview canvas: existence, nonzero-alpha pixel count and
  // a cheap fingerprint (alpha sum) so two masks can be told apart.
  const previewStats = () =>
    page.evaluate(() => {
      const c = document.querySelector('canvas.mirador-samlocal-preview') as HTMLCanvasElement | null;
      if (!c) return { exists: false, w: 0, h: 0, nonzero: 0, alphaSum: 0 };
      const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let nonzero = 0, alphaSum = 0;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 0) { nonzero++; alphaSum += data[i]; }
      }
      return { exists: true, w: c.width, h: c.height, nonzero, alphaSum };
    });

  // --------------------------------------------------------------- phase 4:
  // hover preview, before any click. The first mousemove lazily prepares the
  // embedding (the Playwright profile is fresh every run, so the ~88MB model is
  // always re-downloaded into OPFS), then every move decodes a mask for the
  // cursor and paints it on canvas.mirador-samlocal-preview.
  let regionFetches = 0; // one IIIF region fetch == one encode
  page.on('response', (resp) => {
    if (/\/\d+,\d+,\d+,\d+\/\d+,\/0\/default\.jpg$/.test(resp.url())) regionFetches++;
  });

  await page.mouse.move(A.x, A.y);
  let hoverReady = false, painted = false;
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(1_000);
    // Jiggle: paper only emits mousemove on real movement, and each hover
    // decode is driven by one of those events.
    await page.mouse.move(A.x + (i % 2), A.y);
    const text = await pillText();
    if (i % 5 === 0 || /hover to preview|failed|error/i.test(text)) {
      console.log(`  [hover] t+${i}s status: ${text.slice(0, 140)}`);
    }
    if (/hover to preview/i.test(text)) hoverReady = true;
    if (/failed|error/i.test(text)) break;
    if (hoverReady && (await previewStats()).nonzero > 0) { painted = true; break; }
  }
  console.log(`  [hover] pill reached "Hover to preview": ${hoverReady}; preview painted: ${painted}`);

  await page.mouse.move(A.x, A.y);
  await page.waitForTimeout(2_000);
  const statsA = await previewStats();
  console.log(`  [hover] A ${Math.round(A.x)},${Math.round(A.y)} preview: ${JSON.stringify(statsA)}`);

  await page.mouse.move(B.x, B.y);
  await page.waitForTimeout(2_000);
  const statsB = await previewStats();
  console.log(`  [hover] B ${Math.round(B.x)},${Math.round(B.y)} preview: ${JSON.stringify(statsB)}`);
  console.log(
    `  [hover] A vs B mask changed: ${statsA.nonzero !== statsB.nonzero || statsA.alphaSum !== statsB.alphaSum}` +
      ` (nonzero ${statsA.nonzero} -> ${statsB.nonzero}, alphaSum ${statsA.alphaSum} -> ${statsB.alphaSum})`
  );

  // C: back near A — the coalescing queue must still deliver fresh decodes.
  await page.mouse.move(C.x, C.y);
  await page.waitForTimeout(2_000);
  const statsC = await previewStats();
  console.log(`  [hover] C (near A) preview: ${JSON.stringify(statsC)}`);
  console.log(`  [hover] C differs from B (preview still updating): ${statsC.alphaSum !== statsB.alphaSum}`);
  console.log(`  [hover] IIIF region fetches so far: ${regionFetches} (1 = embedding cache held across A/B/C)`);

  // Move the viewport with the wheel (scroll-to-zoom). A drag would be read as
  // drawing input, and the OSD viewer object is not reachable from window here
  // — Mirador keeps the instance inside the React component, not on a global.
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(2_000);
  const statsZoom = await previewStats();
  console.log(`  [hover] after wheel-zoom preview: ${JSON.stringify(statsZoom)}`);
  console.log(`  [hover] preview survived viewport change (nonzero>0): ${statsZoom.nonzero > 0}`);
  await page.screenshot({ path: 'output/samlocal-hover-preview.png' });

  // Back home so the click flow below works off the geometry computed above.
  await page.mouse.wheel(0, 240);
  await page.waitForTimeout(2_000);

  // --------------------------------------------------------------- phase 5a:
  // mask cycling. Every decode keeps 3 candidates; the hover decode above left
  // them in the tool, so pressing M must repaint the preview with the next one
  // and say so in the pill. Three presses wrap back to where we started.
  // (Candidates can coincide, so "same stats" on one press is not a failure —
  // every press is printed.)
  const cycleStart = await previewStats();
  console.log(`  [cycle] before any press: ${JSON.stringify(cycleStart)} pill: ${(await pillText()).slice(0, 120)}`);
  const cycleStats: Array<{ nonzero: number; alphaSum: number }> = [];
  for (let press = 1; press <= 3; press++) {
    await page.keyboard.press('m');
    await page.waitForTimeout(1_000);
    const s = await previewStats();
    cycleStats.push(s);
    const previous = press === 1 ? cycleStart : cycleStats[press - 2];
    console.log(
      `  [cycle] press ${press}: pill: ${(await pillText()).slice(0, 120)} preview: ${JSON.stringify(s)}` +
        ` differs from previous: ${s.nonzero !== previous.nonzero || s.alphaSum !== previous.alphaSum}`
    );
  }
  const wrapped = cycleStats[2].nonzero === cycleStart.nonzero && cycleStats[2].alphaSum === cycleStart.alphaSum;
  console.log(`  [cycle] 3 presses returned to the starting mask: ${wrapped}`);

  // First click: commits a positive point (the model is warm by now).
  // Click at A, not the viewer centre: the centre of this image is covered by
  // previously saved regions, so a click there is swallowed by paper's hit test.
  // Watch the status pill for progress.
  const cx = A.x, cy = A.y;
  await page.mouse.click(cx, cy);

  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(1_000);
    const text = (await pill.count()) ? (await pill.first().innerText()).replace(/\n/g, ' ') : '(no pill)';
    if (i % 5 === 0 || /updated|failed|error/i.test(text)) {
      console.log(`  [probe] t+${i}s status: ${text.slice(0, 140)}`);
    }
    if (/updated|failed|error/i.test(text)) break;
  }

  // Add a second positive point slightly right, then commit via double-click.
  await page.mouse.click(cx + 40, cy);
  await page.waitForTimeout(3_000);
  await page.mouse.dblclick(cx, cy);
  await page.waitForTimeout(2_000);

  // Count samlocal paths through paper's own scope registry: the Mirador
  // instance lives in the React component, so there is no window.Mirador.viewer
  // to walk, but each annotation overlay owns a scope on a 'draw_canvas_*'.
  const paperPaths = () => page.evaluate(() => {
    const paper = (window as any).paper;
    const scopes: any[] = Object.keys(paper?.PaperScope?._scopes ?? {}).map(
      (k) => paper.PaperScope._scopes[k]);
    let samlocalPaths = 0;
    const names: string[] = [];
    for (const s of scopes) {
      if (String(s?.view?.element?.id ?? '').indexOf('draw_canvas_') !== 0) continue;
      for (const c of s.project?.activeLayer?.children ?? []) {
        if (c.name) names.push(c.name);
        if (c.name && c.name.indexOf('samlocal_') === 0) samlocalPaths++;
      }
    }
    return { scopes: scopes.length, samlocalPaths, names: names.slice(0, 12) };
  });
  console.log(`  [probe] paper paths after commit: ${JSON.stringify(await paperPaths())}`);

  const dialogVisible = await page.locator('.mirador-annotation-editor, .annotation-editor, [class*=annotation-tooltip]').count();
  console.log(`  [probe] annotation editor/tooltip elements: ${dialogVisible}`);

  // Save the annotation and verify it landed in the store as an image region.
  // The title is stored as crm:P190_has_symbolic_content and the SVG hangs off
  // the region as rdf:value (no oa:hasSelector node) — verified against the
  // triples of a region saved by this probe.
  const persistedRegions = async () => {
    const check = await page.request.get(`${baseURL}/sparql`, {
      params: {
        query: `PREFIX rso: <http://www.researchspace.org/ontology/>
          SELECT ?region ?svg WHERE {
            ?region a rso:EX_Digital_Image_Region ;
              <http://www.cidoc-crm.org/cidoc-crm/P190_has_symbolic_content> "SamLocal probe region" .
            OPTIONAL { ?region <http://www.w3.org/1999/02/22-rdf-syntax-ns#value> ?svg }
          }`,
      },
      headers: { Accept: 'application/sparql-results+json' },
    });
    return (await check.json()).results.bindings as any[];
  };

  // Runs accumulate regions under this label, so compare against the set that
  // existed before this run; both commits below save under the same title, so
  // the count of "added by this run" is cumulative.
  const beforeRun = (await persistedRegions()).map((b) => b.region.value);
  const addedThisRun = async () =>
    (await persistedRegions()).filter((b) => beforeRun.indexOf(b.region.value) < 0);

  /** Fill the Title dialog if it appeared, save, and poll for the new region. */
  const saveIfDialog = async (label: string, expected: number) => {
    const titleInput = page.locator('input[placeholder="Title"]');
    if (!(await titleInput.count())) {
      console.log(`  [${label}] no Title input — save dialog not present, nothing persisted`);
      return;
    }
    await titleInput.fill('SamLocal probe region');
    await page.getByRole('button', { name: 'Save' }).click();
    // The write is asynchronous (LDP + triplestore); poll rather than sleep once.
    let added: any[] = [];
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(2_000);
      added = await addedThisRun();
      if (added.length >= expected) break;
    }
    console.log(
      `  [${label}] regions labelled 'SamLocal probe region': ${beforeRun.length} before this run,` +
        ` ${added.length} added so far (expected ${expected})`
    );
    for (const b of added) {
      console.log(`  [${label}]   ${b.region.value} svg=${b.svg ? b.svg.value.slice(0, 120) : '(none)'}`);
    }
  };

  await saveIfDialog('probe', 1);

  await page.screenshot({ path: 'output/samlocal-after-commit.png' });
  console.log('  [probe] screenshot: output/samlocal-after-commit.png');

  // --------------------------------------------------------------- phase 5b:
  // box prompt. Deliberately AFTER the click/commit/save flow above: the commit
  // resets the tool's prompt state, so this is a fresh session and the
  // persistence diff above is uncontaminated. Re-arm the tool first — selecting
  // it again is what the user does after a save.
  const controlsBox2 = await controls.boundingBox();
  if (controlsBox2) {
    await page.mouse.move(controlsBox2.x + 10, controlsBox2.y + 10);
    await page.waitForTimeout(500);
  }
  const toolBox2 = await samLocal.boundingBox();
  if (toolBox2 && toolBox2.width > 0) {
    await page.mouse.click(toolBox2.x + toolBox2.width / 2, toolBox2.y + toolBox2.height / 2);
    await page.waitForTimeout(500);
    console.log('  [box] SamLocal re-armed');
  } else {
    console.log('  [box] SamLocal button has no box — cannot re-arm, skipping box test');
    return;
  }

  const boxFrom = at(0.25, 0.25);
  const boxTo = at(0.75, 0.6);
  const boxShapes = () =>
    page.evaluate(() => {
      const paper = (window as any).paper;
      const scopes: any[] = Object.keys(paper?.PaperScope?._scopes ?? {}).map(
        (k) => paper.PaperScope._scopes[k]);
      const names: string[] = [];
      for (const s of scopes) {
        if (String(s?.view?.element?.id ?? '').indexOf('draw_canvas_') !== 0) continue;
        for (const c of s.project?.activeLayer?.children ?? []) if (c.name) names.push(c.name);
      }
      return names;
    });

  await page.mouse.move(boxFrom.x, boxFrom.y);
  await page.waitForTimeout(300);
  await page.mouse.down();
  const midNames: string[][] = [];
  for (const t of [0.34, 0.67, 1]) {
    await page.mouse.move(boxFrom.x + (boxTo.x - boxFrom.x) * t, boxFrom.y + (boxTo.y - boxFrom.y) * t);
    await page.waitForTimeout(300);
    midNames.push(await boxShapes());
  }
  console.log(
    `  [box] drag ${Math.round(boxFrom.x)},${Math.round(boxFrom.y)} -> ${Math.round(boxTo.x)},${Math.round(boxTo.y)}`
  );
  midNames.forEach((names, i) =>
    console.log(
      `  [box] mid-drag step ${i + 1}: temp_samlocal_box present: ${names.indexOf('temp_samlocal_box') >= 0}` +
        ` (${names.length} shapes in layer)`
    )
  );
  await page.mouse.up();

  let boxPill = '(no pill)';
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1_000);
    boxPill = await pillText();
    if (i % 5 === 0 || /updated|failed|error|warning|box over/i.test(boxPill)) {
      console.log(`  [box] t+${i}s status: ${boxPill.slice(0, 140)}`);
    }
    if (/updated|failed|error|box over/i.test(boxPill)) break;
  }
  const boxStats = await previewStats();
  console.log(`  [box] preview after box decode: ${JSON.stringify(boxStats)}`);
  const afterUp = await boxShapes();
  console.log(
    `  [box] after mouseup: temp_samlocal_box still present: ${afterUp.indexOf('temp_samlocal_box') >= 0}` +
      ` (${afterUp.length} shapes in layer)`
  );

  // Cycling must work after a box prompt too.
  await page.keyboard.press('m');
  await page.waitForTimeout(1_500);
  const boxCycleStats = await previewStats();
  console.log(
    `  [box] after one M press: pill: ${(await pillText()).slice(0, 120)} preview: ${JSON.stringify(boxCycleStats)}` +
      ` differs from box decode: ${boxCycleStats.nonzero !== boxStats.nonzero || boxCycleStats.alphaSum !== boxStats.alphaSum}`
  );

  // Commit the box-prompted mask and see whether a second region persists.
  const boxCentre = { x: (boxFrom.x + boxTo.x) / 2, y: (boxFrom.y + boxTo.y) / 2 };
  await page.mouse.dblclick(boxCentre.x, boxCentre.y);
  await page.waitForTimeout(3_000);
  console.log(`  [box] paper paths after box commit: ${JSON.stringify(await paperPaths())}`);
  await saveIfDialog('box', 2);
  await page.screenshot({ path: 'output/samlocal-box-commit.png' });
  console.log('  [box] screenshot: output/samlocal-box-commit.png');
});
