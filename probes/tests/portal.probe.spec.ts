/**
 * Diagnostic probe for the Murten Portal page — not an assertion suite.
 *
 * Dumps box geometry and computed styles for every shelf so a layout bug can be
 * diagnosed from numbers rather than screenshots. Always passes; read the output.
 *
 *   cd e2e && RS_BASE_URL=http://127.0.0.1:10214 npx playwright test portal.probe
 */

import { test, expect } from '@playwright/test';

const PORTAL = '/resource/Portal';

test('probe: portal layout', async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('requestfailed', (r) => {
    failedRequests.push(`${r.failure()?.errorText ?? '?'}  ${r.url().slice(0, 120)}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) failedRequests.push(`HTTP ${r.status()}  ${r.url().slice(0, 120)}`);
  });

  await page.setViewportSize({ width: 1600, height: 1200 });
  // NOT networkidle: RS keeps requests in flight (federated Wikidata thumbnail
  // lookups among them), so the network never goes quiet.
  await page.goto(PORTAL, { waitUntil: 'domcontentloaded' });

  // Shelves are rendered by semantic-query, so wait for content rather than DOM.
  await page.waitForSelector('.mp-shelf', { timeout: 90_000 });
  await page.waitForSelector('.mp-card', { timeout: 90_000 });
  await page.waitForTimeout(6000); // let the SPARQL-backed cards settle

  const report = await page.evaluate(() => {
    const px = (n: number) => Math.round(n);
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        cls: el.className?.toString().slice(0, 60),
        x: px(r.x), w: px(r.width),
        display: cs.display, float: cs.float,
        flex: cs.flex, width: cs.width, paddingLeft: cs.paddingLeft,
      };
    };

    const shelves = [...document.querySelectorAll('.mp-shelf')].map((sh, i) => ({
      index: i,
      title: sh.querySelector('h3')?.textContent?.trim() ?? '?',
      count: sh.querySelector('.mp-count')?.textContent?.trim() ?? '(no count rendered)',
      cards: sh.querySelectorAll('.mp-card').length,
      thumbs: sh.querySelectorAll('.mp-card-thumb img').length,
      icons: sh.querySelectorAll('.mp-card-icon').length,
      shelf: box(sh),
      row: box(sh.querySelector('.row, bs-row')),
      rail: box(sh.querySelector('.mp-rail')),
      railParent: box(sh.querySelector('.mp-rail')?.parentElement ?? null),
      scroller: box(sh.querySelector('.mp-scroller')),
      scrollerParent: box(sh.querySelector('.mp-scroller')?.parentElement ?? null),
    }));

    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      bootstrapGridPresent: !!document.querySelector('.col-md-2, .col-md-10'),
      rawTags: {
        bsRow: document.querySelectorAll('bs-row').length,
        bsCol: document.querySelectorAll('bs-col').length,
        divRow: document.querySelectorAll('div.row').length,
        colMd2: document.querySelectorAll('.col-md-2').length,
        colMd10: document.querySelectorAll('.col-md-10').length,
      },
      portalWrapper: box(document.querySelector('.mp-portal')),
      shelves,
    };
  });

  console.log('\n══════ PORTAL PROBE ══════');
  console.log('viewport      :', report.viewport);
  console.log('bootstrap grid:', report.bootstrapGridPresent);
  console.log('tag counts    :', report.rawTags);
  console.log('portal wrapper:', report.portalWrapper);
  for (const s of report.shelves) {
    console.log(`\n── shelf ${s.index}: ${s.title}`);
    console.log('   count text :', s.count);
    console.log('   cards      :', s.cards, '| img thumbs:', s.thumbs, '| icons:', s.icons);
    console.log('   shelf      :', s.shelf);
    console.log('   row        :', s.row);
    console.log('   railParent :', s.railParent);
    console.log('   rail       :', s.rail);
    console.log('   scrollParnt:', s.scrollerParent);
    console.log('   scroller   :', s.scroller);
  }
  console.log('\n── console errors ──');
  console.log(consoleErrors.length ? consoleErrors.join('\n') : '  none');
  console.log('\n── failed requests ──');
  console.log(failedRequests.length ? [...new Set(failedRequests)].slice(0, 15).join('\n') : '  none');

  await page.screenshot({ path: testInfo.outputPath('portal-1600.png'), fullPage: true });
  await page.setViewportSize({ width: 2000, height: 1200 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: testInfo.outputPath('portal-2000.png'), fullPage: true });
  console.log('\nscreenshots:', testInfo.outputPath('portal-1600.png'));

  expect(report.shelves.length).toBeGreaterThan(0);
});
