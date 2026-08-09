/**
 * Diagnostic probe for the External Authority search panel (dsanno:ExternalAuthoritySearch).
 *
 * Renders the partial standalone at /resource/?uri=<template IRI> and drives each source tab:
 * types a term, then prints row count, per-source breakdown, how many rows carried a
 * description, and the first few rows. Console errors are printed, not asserted.
 *
 * Reading the output:
 *   - "Wikidata + GND" is a UNION, so ONE failing service yields zero rows for that tab while
 *     the per-source tabs still work. If it is empty but the singles are not, that is the cause.
 *   - VIAF supplies no description field at all, so 0/N with description is correct there, not a
 *     bug. VIAF is not in the union (names only, plus a shared ~1000/day quota).
 *   - GND is German: 'Vergoldung' should hit, 'gilding' should mostly not.
 *   - Watch the per-source split on the union tab. Branches come back contiguously grouped, so
 *     too small a page size hides the later source entirely — that is what made GND look like it
 *     returned nothing when the page size was 10.
 *
 *   cd probes && RS_BASE_URL=http://127.0.0.1:10214 npx playwright test external-authority
 */

import { test, Locator } from '@playwright/test';


const PAGE_URL = '/resource/?uri=' + encodeURIComponent('https://w3id.org/dsanno/platform/ExternalAuthoritySearch');

const CASES = [
  { tab: 'Wikidata + GND', term: 'rembrandt' },
  { tab: 'Wikidata + GND', term: 'Vergoldung' },
  { tab: 'Wikidata', term: 'gilding' },
  { tab: 'GND', term: 'Vergoldung' },
  { tab: 'VIAF', term: 'rembrandt' },
];

/** Values the Source column can hold. Anything else in that cell is not a data row —
 *  the table's pagination control also lives in a <tr>, and counting it as a result was
 *  what made an earlier run report "11 rows" for a 10-row page. */
const SOURCES = ['Wikidata', 'GND', 'VIAF', 'AAT'];

function line(...parts: unknown[]) {
  console.log(parts.join(' '));
}

/** All four tab panes are mounted at once, so every locator must be scoped to the active one. */
function activePane(page: import('@playwright/test').Page): Locator {
  return page.locator('.tab-pane.active');
}

test('external authority search: per-source tabs and union', async ({ page }) => {
  test.setTimeout(600_000);
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });

  const tabs = page.getByRole('tab');
  await tabs.first().waitFor({ state: 'visible', timeout: 30_000 });
  const tabNames: string[] = [];
  for (let i = 0; i < (await tabs.count()); i++) {
    tabNames.push((await tabs.nth(i).innerText()).trim());
  }
  line('source tabs mounted:', JSON.stringify(tabNames));

  for (const { tab, term } of CASES) {
    line('');
    line(`=== [${tab}] "${term}" ===`);

    await page.getByRole('tab', { name: tab, exact: true }).click();
    // Load-bearing: the pane switch is not synchronous with the click, and resolving
    // .tab-pane.active too early scopes every later locator to the PREVIOUS pane — the probe
    // then types into the wrong tab and reports zero rows for a healthy service. Tried
    // replacing this with a wait on aria-selected; the attribute flips before the pane does,
    // so the race came back. Keep the tick.
    await page.waitForTimeout(300);

    const pane = activePane(page);
    const input = pane.getByRole('textbox').first();
    try {
      await input.waitFor({ state: 'visible', timeout: 15_000 });
    } catch {
      line('  keyword input not visible in the active pane');
      continue;
    }

    await input.fill('');
    await input.fill(term);

    const rows = pane.locator('table tbody tr');
    try {
      await rows.first().waitFor({ state: 'visible', timeout: 45_000 });
    } catch {
      line('  NO ROWS after 45s');
      continue;
    }
    // Load-bearing for the same reason: branches land one service at a time. A settle-to-stable
    // count was tried here and, combined with the change above, broke cases 3-5; this pairing is
    // the configuration that reproduces the baseline exactly.
    await page.waitForTimeout(2_000);

    // Pull the whole table in ONE round-trip. Reading cells individually cost 4 locator
    // resolutions per row — ~436 across the five cases, each re-resolving
    // .tab-pane.active -> table -> tbody -> tr[i] -> td[j] with actionability checks, which
    // was essentially the probe's entire 7.8-minute runtime.
    const table: string[][] = await rows.evaluateAll((trs) =>
      trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => (td as HTMLElement).innerText.trim()))
    );

    const bySource: Record<string, number> = {};
    let withDescription = 0;
    const samples: string[] = [];

    // Source / Label / Description / Match+kind / Actions
    const dataOnly = table.filter((cells) => SOURCES.includes(cells[0]));

    for (const cells of dataOnly) {
      const [source, rawLabel, rawDesc, rawDetail] = cells;
      const label = (rawLabel ?? '').replace(/\s+/g, ' ');
      const desc = rawDesc ?? '';
      const detail = (rawDetail ?? '').slice(0, 30);

      bySource[source] = (bySource[source] || 0) + 1;
      if (desc && desc !== '—') withDescription++;

      if (samples.length < 8) {
        samples.push(`  [${source}] ${label} | ${desc.slice(0, 45) || '(no desc)'} | ${detail}`);
      }
    }

    const dataRows = dataOnly.length;
    line('  data rows:', dataRows, '| by source:', JSON.stringify(bySource),
         `| with description: ${withDescription}/${dataRows}`);
    for (const s of samples) line(s);
    if (table.length !== dataRows) {
      line(`  (${table.length - dataRows} non-result row(s) skipped — pagination control)`);
    }

    const copyButtons = await pane.locator('button:has-text("Copy URI")').count();
    line('  Copy URI buttons:', copyButtons);
  }

  line('');
  if (consoleErrors.length) {
    line('console errors:');
    for (const e of consoleErrors.slice(0, 10)) line('  ', e.slice(0, 200));
  } else {
    line('no console errors');
  }
});
