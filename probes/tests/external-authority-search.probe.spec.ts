/**
 * Diagnostic probe for the External Authority search panel (dsanno:ExternalAuthoritySearch).
 *
 * Renders the partial standalone at /resource/?uri=<template IRI> and drives each source tab:
 * types a term, then prints row count, per-source breakdown, how many rows carried a
 * description, and the first few rows. Console errors are printed, not asserted.
 *
 * Reading the output:
 *   - "All sources" is a UNION, so ONE failing service yields zero rows for that tab while the
 *     per-source tabs still work. If All is empty but the singles are not, that is the cause.
 *   - VIAF supplies no description, so 0/N with description is correct there, not a bug.
 *   - GND is German: 'Vergoldung' should hit, 'gilding' should mostly not.
 *
 *   cd probes && RS_BASE_URL=http://127.0.0.1:10214 npx playwright test external-authority
 */

import { test, Locator } from '@playwright/test';

const PAGE_URL = '/resource/?uri=' + encodeURIComponent('https://w3id.org/dsanno/platform/ExternalAuthoritySearch');

const CASES = [
  { tab: 'All sources', term: 'rembrandt' },
  { tab: 'All sources', term: 'Vergoldung' },
  { tab: 'Wikidata', term: 'gilding' },
  { tab: 'GND', term: 'Vergoldung' },
  { tab: 'VIAF', term: 'rembrandt' },
];

function line(...parts: unknown[]) {
  console.log(parts.join(' '));
}

/** All four tab panes are mounted at once, so every locator must be scoped to the active one. */
function activePane(page: import('@playwright/test').Page): Locator {
  return page.locator('.tab-pane.active');
}

test('external authority search: per-source tabs and union', async ({ page }) => {
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
    await page.waitForTimeout(2_000); // let the remaining UNION branches land

    const count = await rows.count();
    const bySource: Record<string, number> = {};
    let withDescription = 0;
    const samples: string[] = [];

    for (let i = 0; i < count; i++) {
      const cells = rows.nth(i).locator('td');
      const source = (await cells.nth(0).innerText().catch(() => '?')).trim();
      const label = (await cells.nth(1).innerText().catch(() => '')).trim().replace(/\s+/g, ' ');
      const desc = (await cells.nth(2).innerText().catch(() => '')).trim();
      const detail = (await cells.nth(3).innerText().catch(() => '')).trim().slice(0, 30);

      bySource[source] = (bySource[source] || 0) + 1;
      if (desc && desc !== '—') withDescription++;

      if (samples.length < 6) {
        samples.push(`  [${source}] ${label} | ${desc.slice(0, 45) || '(no desc)'} | ${detail}`);
      }
    }

    line('  rows:', count, '| by source:', JSON.stringify(bySource), `| with description: ${withDescription}/${count}`);
    for (const s of samples) line(s);

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
