/**
 * Probe for the query-column track solver. Always passes; read the output.
 *   cd probes && RS_BASE_URL=http://127.0.0.1:10214 npx playwright test tile-search-qcol
 */
import { test } from '@playwright/test';

const WIDTHS = [1500, 1280, 1024, 900, 700];

test('probe: query cell matches a card track at every width', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });

  await page.setViewportSize({ width: WIDTHS[0], height: 1100 });
  await page.goto('/resource/PyramidalTileSearch', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pts__toolbar', { timeout: 60_000 });
  await page.fill('.pts__input', 'soldiers with pikes and armour');
  await page.click('.pts__queryline .btn');
  await page.waitForSelector('.pts__card', { timeout: 180_000 });

  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 1100 });
    await page.waitForTimeout(700);
    const m = await page.evaluate(() => {
      const box = (s: string) => {
        const e = document.querySelector(s) as HTMLElement | null;
        return e ? Math.round(e.getBoundingClientRect().width) : null;
      };
      const grid = document.querySelector('.pts__grid') as HTMLElement | null;
      return {
        qcol: box('.pts__qcol'),
        card: box('.pts__card'),
        tracks: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : null,
        inline: grid ? grid.style.gridTemplateColumns : null,
      };
    });
    console.log(`viewport ${w} -> ${JSON.stringify(m)} delta=${m.qcol !== null && m.card !== null ? m.qcol - m.card : 'n/a'}`);
  }
  console.log('console errors:', errors.length ? errors : 'none');
});
