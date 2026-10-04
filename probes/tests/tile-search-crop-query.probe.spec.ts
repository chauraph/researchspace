/**
 * Diagnostic probe for "Search with this crop": what the crop fetch actually hits and why it fails.
 * Prints; never asserts.
 */
import { test } from '@playwright/test';

const PAGE = '/resource/PyramidalTileSearch';

test('probe: search with crop', async ({ page }) => {
  const log: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log.push(`console.${m.type()}: ${m.text().slice(0, 300)}`); });
  page.on('requestfailed', (r) => log.push(`FAILED ${r.resourceType()} ${r.url()} -> ${r.failure()?.errorText}`));
  page.on('response', (r) => {
    if (/default\.jpg/.test(r.url()) && r.request().resourceType() === 'fetch') {
      log.push(`fetch resp ${r.status()} ${r.url()} acao=${r.headers()['access-control-allow-origin']}`);
    }
  });

  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pts', { timeout: 60_000 });
  await page.locator('.pts__input').first().fill('a soldier with a pike');
  await page.locator('.pts .btn-action').first().click();
  const ok = await page.waitForSelector('.pts__card', { timeout: 120_000 }).then(() => true).catch(() => false);
  console.log('results:', ok);
  if (!ok) { console.log(log.join('\n')); return; }

  await page.locator('.pts__card .pts__caplabel').first().click();
  await page.waitForTimeout(800);
  console.log('detail buttons:', await page.locator('.pts__actions button').allTextContents());
  const btn = page.locator('button', { hasText: 'Search with this crop' }).first();
  console.log('crop button present:', await btn.count());
  if (!(await btn.count())) { console.log(log.join('\n')); return; }
  await btn.click();
  await page.waitForTimeout(8000);
  console.log('error banner:', await page.locator('.pts').evaluate((el) => {
    const e = el.querySelector('[class*="error"], .alert');
    return e ? e.textContent!.slice(0, 300) : '(none)';
  }));
  console.log('query thumb:', await page.locator('.pts__filethumb').count());
  console.log(log.join('\n'));
});
