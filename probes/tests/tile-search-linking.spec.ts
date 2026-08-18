/**
 * Diagnostic probe for the linked locator, the order switch, and the pinned map.
 * Prints measurements; never asserts.
 */
import { test } from '@playwright/test';

const PAGE = '/resource/PyramidalTileSearch';

test('probe: locator linking and pinned map', async ({ page }) => {
  const errs: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });

  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pts', { timeout: 60_000 });

  const input = page.locator('.pts__input').first();
  await input.fill('a soldier with a pike');
  await page.locator('.pts .btn-action').first().click();

  const gotResults = await page.waitForSelector('.pts__card', { timeout: 120_000 })
    .then(() => true).catch(() => false);
  console.log('results rendered:', gotResults);
  if (!gotResults) { console.log('console errors:', errs); return; }
  await page.waitForTimeout(1500);

  console.log('cards            :', await page.locator('.pts__card').count());
  console.log('markers          :', await page.locator('.pts__mark').count());
  console.log('rank badges      :', await page.locator('.pts__rank').count());
  console.log('query tiles     :', await page.locator('.pts__qtile').count(), '| toolbar thumb', await page.locator('.pts__filethumb').count());
  console.log('place bars (off) :', await page.locator('.pts__place').count(), '— expected 0 without diagnostics');
  console.log('order buttons    :', await page.locator('.pts__panelhead .pts__seg button').count());
  console.log('scroller present :', await page.locator('.pts__scroller').count());

  const cd = await page.locator('.pts__grid .pts__card').nth(2).boundingBox();
  await page.mouse.move(cd!.x + cd!.width / 2, cd!.y + cd!.height / 2);
  await page.waitForTimeout(400);
  const markerOpacity = await page.$$eval('.pts__mark', (els) =>
    Array.from(new Set(els.map((e) => getComputedStyle(e).opacity))).join(','));
  console.log('card hover  -> hot markers', await page.locator('.pts__mark[data-hot="1"]').count(),
              '| marker opacities', markerOpacity,
              '| flag', await page.locator('.pts__mark[data-hot="1"] .pts__mflag')
                .evaluate((e) => getComputedStyle(e).opacity).catch(() => 'n/a'),
              '| dot halo', await page.locator('.pts__mark[data-hot="1"] .pts__mdot')
                .evaluate((e) => getComputedStyle(e).boxShadow.slice(0, 46)).catch(() => 'n/a'));

  // move the pointer to the marker's centre rather than using hover(), which scrolls the
  // element into view first and can land off a 16px-wide target
  const mk = await page.locator('.pts__mark').nth(1).boundingBox();
  await page.mouse.move(mk!.x + mk!.width / 2, mk!.y + mk!.height / 2);
  await page.waitForTimeout(400);
  const cardOpacity = await page.$$eval('.pts__card', (els) =>
    Array.from(new Set(els.map((e) => getComputedStyle(e).opacity))).join(','));
  console.log('marker hover-> hot cards  ', await page.locator('.pts__card[data-hot="1"]').count(),
              '| card opacities', cardOpacity,
              '| ring', await page.locator('.pts__card[data-hot="1"]')
                .evaluate((e) => getComputedStyle(e).boxShadow.slice(0, 40)).catch(() => 'n/a'));

  // the grid should fill what is left of the window, and follow a resize
  const fit = async () => page.locator('.pts__scroller').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), h: Math.round(r.height),
             max: getComputedStyle(el).maxHeight, vh: window.innerHeight };
  });
  console.log('scroller @1000  :', JSON.stringify(await fit()));
  await page.setViewportSize({ width: 1500, height: 700 });
  await page.waitForTimeout(500);
  console.log('scroller @700   :', JSON.stringify(await fit()));
  await page.setViewportSize({ width: 1500, height: 1300 });
  await page.waitForTimeout(500);
  console.log('scroller @1300  :', JSON.stringify(await fit()));

  const before = await page.locator('.pts__strip').boundingBox();
  await page.locator('.pts__scroller').evaluate((el) => { el.scrollTop = 600; });
  await page.waitForTimeout(400);
  const after = await page.locator('.pts__strip').boundingBox();
  console.log('strip y before/after scroll:', before?.y, after?.y,
              '| scrollTop', await page.locator('.pts__scroller').evaluate((el) => el.scrollTop));

  await page.locator('.pts__panelhead .pts__seg button').nth(1).click();
  await page.waitForTimeout(600);
  const xs = await page.$$eval('.pts__mark', (els) =>
    els.map((e) => parseFloat((e as HTMLElement).style.left)));
  const monotonic = xs.every((v, i) => i === 0 || v >= xs[i - 1]);
  console.log('left-to-right: markers ascending?', monotonic);

  // diagnostics on: the place bar appears
  const diag = page.locator('.pts__check input');
  if (await diag.count()) {
    await diag.check();
    await page.waitForTimeout(500);
    console.log('place bars (diag):', await page.locator('.pts__place').count());
  } else {
    console.log('place bars (diag): no diagnostics toggle on this page');
  }

  await page.screenshot({ path: 'linking.png', fullPage: false });
  console.log('console errors:', errs.length ? errs : 'none');
});
