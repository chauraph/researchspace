/**
 * Full cycle probe for <dsanno-pyramidal-tile-search>. Always passes; read the output.
 *   cd probes && RS_BASE_URL=http://127.0.0.1:10214 npx playwright test tile-search-cycle
 */
import { test } from '@playwright/test';

test('probe: tile search full cycle', async ({ page }) => {
  const errors: string[] = [];
  const calls: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('response', (r) => {
    if (r.url().includes('/proxy/tile-search')) calls.push(`HTTP ${r.status()} ${r.url().split('/proxy/')[1]}`);
  });

  await page.setViewportSize({ width: 1500, height: 1200 });
  await page.goto('/resource/PyramidalTileSearch', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pts__toolbar', { timeout: 60_000 });

  await page.fill('.pts__input', 'soldiers with pikes and armour');
  await page.click('.pts__queryline .btn');
  // Encoding dominates and can take many seconds on a cold model.
  await page.waitForSelector('.pts__card', { timeout: 180_000 });

  const r = await page.evaluate(() => {
    const n = (s: string) => document.querySelectorAll(s).length;
    const t = (s: string) => { const e = document.querySelector(s); return e ? (e as HTMLElement).innerText.trim().slice(0, 120) : null; };
    return {
      cards: n('.pts__card'), marks: n('.pts__mark'), dots: n('.pts__mdot'),
      hairlines: n('.pts__mfaint'), count: t('.pts__count'),
      pipeVisible: n('.pts__pipe'), simShown: n('.pts__sim'),
      firstLabel: t('.pts__caplabel'), diagToggle: n('.pts__check input'),
      thumbs: n('.pts__thumb img'),
    };
  });
  console.log('--- after text search ---');
  console.log(JSON.stringify(r, null, 1));

  // Diagnostics toggle: show-diagnostics='toggle' renders the control and starts clean.
  await page.check('.pts__check input');
  await page.waitForTimeout(600);
  const d = await page.evaluate(() => ({
    pipe: document.querySelectorAll('.pts__pipe').length,
    sim: document.querySelectorAll('.pts__sim').length,
    lvl: document.querySelectorAll('.pts__lvl').length,
    label: (document.querySelector('.pts__caplabel') as HTMLElement)?.innerText.trim(),
  }));
  console.log('--- diagnostics on ---'); console.log(JSON.stringify(d));

  // Open a hit.
  await page.click('.pts__caplabel');
  await page.waitForSelector('[data-open="true"]', { timeout: 20_000 });
  const o = await page.evaluate(() => ({
    bbox: (document.querySelector('.pts__bbox') as HTMLElement)?.innerText,
    mintDisabled: (document.querySelector('.pts__actions button') as HTMLButtonElement)?.disabled,
    hint: (document.querySelector('.pts__actions .pts__hint') as HTMLElement)?.innerText.slice(0, 90),
    mergePills: document.querySelectorAll('.pts__pill').length,
  }));
  console.log('--- hit opened ---'); console.log(JSON.stringify(o));

  const merged = await page.locator('.pts__pill').count();
  if (merged > 0) {
    await page.locator('.pts__pill').first().click();
    await page.waitForTimeout(800);
    const m = await page.evaluate(() => ({
      members: document.querySelectorAll('.pts__mem').length,
      head: (document.querySelector('.pts__mergehead') as HTMLElement)?.innerText.slice(0, 90),
    }));
    console.log('--- merge inspector ---'); console.log(JSON.stringify(m));
  } else {
    console.log('--- merge inspector --- no merged hit in this result set');
  }

  console.log('proxy calls   :', calls);
  console.log('console errors:', errors.length ? errors : 'none');
  await page.screenshot({ path: 'output/tile-search.png', fullPage: false });
});
