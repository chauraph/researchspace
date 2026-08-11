/**
 * Live probe for the $.SamLocal Mirador tool (plan-doc phase 3) against a
 * running stack. Opens rsp:IIIFSingleImageView on an image found via SPARQL,
 * then reports: toolbar gate (SamLocal button present iff WebGPU), engine
 * global, and a driven segmentation — enter annotation mode, click the image,
 * wait for the mask decode, double-click to commit, count samlocal_ paths.
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

  // First click: triggers model init/download (possibly ~88MB on first run) +
  // encode + decode. Watch the status pill for progress.
  const canvas = page.locator('.mirador-osd').first();
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.click(cx, cy);

  const pill = page.locator('.mirador-sam-status-overlay');
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

  const outcome = await page.evaluate(() => {
    const overlay = (window as any).overlayInstance; // set by the server tool only
    const scopes = (window as any).paper?.PaperScope?._scopes;
    // Count samlocal paths across all paper scopes reachable from Mirador.
    let samlocalPaths = 0;
    let names: string[] = [];
    document.querySelectorAll('canvas').forEach(() => {});
    const mirador = (window as any).Mirador;
    try {
      const viewer = mirador?.viewer;
      const windows = viewer?.workspace?.windows ?? [];
      for (const w of windows) {
        const children = w?.focusModules?.ImageView?.annotationsLayer?.drawTool?.svgOverlay?.paperScope
          ?.project?.activeLayer?.children ?? [];
        for (const c of children) {
          if (c.name) names.push(c.name);
          if (c.name && c.name.indexOf('samlocal_') === 0) samlocalPaths++;
        }
      }
    } catch (e) { /* structure differs; names stays empty */ }
    return { samlocalPaths, names: names.slice(0, 12) };
  });
  console.log(`  [probe] paper paths after commit: ${JSON.stringify(outcome)}`);

  const dialogVisible = await page.locator('.mirador-annotation-editor, .annotation-editor, [class*=annotation-tooltip]').count();
  console.log(`  [probe] annotation editor/tooltip elements: ${dialogVisible}`);

  // Save the annotation and verify it landed in the store as an image region.
  const titleInput = page.locator('input[placeholder="Title"]');
  if (await titleInput.count()) {
    await titleInput.fill('SamLocal probe region');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForTimeout(4_000);
    const check = await page.request.get(`${baseURL}/sparql`, {
      params: {
        query: `PREFIX rso: <http://www.researchspace.org/ontology/>
          SELECT ?region ?svg WHERE {
            ?region a rso:EX_Digital_Image_Region .
            ?region <http://www.w3.org/2000/01/rdf-schema#label> "SamLocal probe region" .
            OPTIONAL { ?region <http://www.w3.org/ns/oa#hasSelector>/<http://www.w3.org/1999/02/22-rdf-syntax-ns#value> ?svg }
          } LIMIT 3`,
      },
      headers: { Accept: 'application/sparql-results+json' },
    });
    const bindings = (await check.json()).results.bindings;
    console.log(`  [probe] persisted regions labelled 'SamLocal probe region': ${bindings.length}`);
    for (const b of bindings) {
      console.log(`  [probe]   ${b.region.value} svg=${b.svg ? b.svg.value.slice(0, 120) : '(none)'}`);
    }
  } else {
    console.log('  [probe] no Title input — save dialog not present, nothing persisted');
  }

  await page.screenshot({ path: 'output/samlocal-after-commit.png' });
  console.log('  [probe] screenshot: output/samlocal-after-commit.png');
});
