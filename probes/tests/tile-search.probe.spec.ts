/**
 * Diagnostic probe for <dsanno-pyramidal-tile-search> — not an assertion suite.
 *
 * Reports whether the component mounted, whether the proxy answers, and what the
 * capabilities call returned. Always passes; read the output.
 *
 *   cd probes && RS_BASE_URL=http://127.0.0.1:10214 npx playwright test tile-search
 */

import { test } from '@playwright/test';

const PAGE = '/resource/PyramidalTileSearch';

test('probe: pyramidal tile search', async ({ page }) => {
  const consoleErrors: string[] = [];
  const proxyCalls: string[] = [];

  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 220));
  });
  page.on('response', (r) => {
    if (r.url().includes('/proxy/tile-search')) {
      proxyCalls.push(`HTTP ${r.status()}  ${r.url().split('/proxy/')[1]}`);
    }
  });

  await page.setViewportSize({ width: 1500, height: 1100 });
  // NOT networkidle: RS keeps requests in flight, so the network never goes quiet.
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });

  // The tag is registered lazily, so wait for what the component renders, not the tag.
  const mounted = await page
    .waitForSelector('.pts, .pts__state, [class*="ErrorNotification"], .system-spinner', {
      timeout: 60_000,
    })
    .then(() => true)
    .catch(() => false);

  await page.waitForTimeout(5000);

  const report = await page.evaluate(() => {
    const q = (s: string) => document.querySelector(s);
    const text = (s: string) => (q(s) ? (q(s) as HTMLElement).innerText.slice(0, 260) : null);
    return {
      tagPresent: !!document.querySelector('dsanno-pyramidal-tile-search'),
      rootRendered: !!q('.pts'),
      toolbar: !!q('.pts__toolbar'),
      modeButtons: document.querySelectorAll('.pts__seg button').length,
      levelChips: document.querySelectorAll('.pts__chip').length,
      warning: text('.pts__warning'),
      error: text('[class*="ErrorNotification"]'),
      state: text('.pts__state'),
    };
  });

  console.log('--- pyramidal tile search probe ---');
  console.log('mounted selector found :', mounted);
  console.log('report                 :', JSON.stringify(report, null, 2));
  console.log('proxy calls            :', proxyCalls.length ? proxyCalls : 'none');
  console.log('console errors         :', consoleErrors.length ? consoleErrors : 'none');
});
