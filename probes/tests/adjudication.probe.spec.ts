/**
 * Diagnostic probe for the alignment adjudication write path — not an assertion suite.
 *
 * It builds a throwaway member with two machine "pending adjudication" findings in the
 * scratch graph <urn:dsanno:adjtest:data>, drives Adopt and Refuse through the real UI
 * (dsanno:AdjudicationTest mounts dsanno:AlignmentProvenance against that member), reads
 * back what actually landed in the triplestore, and drops the graph again.
 *
 * It prints; it does not gate. The one thing it shouts about is P4_has_time-span: an act
 * whose timestamp is missing, untyped, or a malformed xsd:date is worthless as provenance,
 * and NOW() has a known cast trap in Blazegraph (xsd:date(NOW()) yields "2026-08-06 CEST"),
 * so the datatype and lexical form are checked and flagged loudly.
 *
 *   cd probes && RS_BASE_URL=http://127.0.0.1:10214 npx playwright test adjudication
 */

import { test, expect, Page, APIRequestContext, Locator } from '@playwright/test';

const GRAPH = 'urn:dsanno:adjtest:data';
const BASE = 'https://w3id.org/murtenpanorama/resource/vocab/adjtest/';
const MEMBER = `${BASE}member-1`;
const ACT = `${BASE}member-1_appraisal_machine-1`;
const TARGET_A = 'http://www.wikidata.org/entity/Q4294967295';
const TARGET_B = 'http://vocab.getty.edu/aat/300000000';
// orphaned adoption: a machine alignment whose flat triple is (deliberately) never seeded
const ACT2 = `${BASE}member-1_appraisal_machine-2`;
const TARGET_C = 'http://vocab.getty.edu/aat/300000001';
// strength divergence: a pending exactMatch beside a seeded standing closeMatch (the Stone-ball shape)
const ACT3 = `${BASE}member-1_appraisal_machine-3`;
const TARGET_D = 'http://vocab.getty.edu/aat/300000002';
const EXACT = 'http://www.w3.org/2004/02/skos/core#exactMatch';

const HARNESS =
  '/resource/?uri=' +
  encodeURIComponent('https://w3id.org/dsanno/platform/AdjudicationTest') +
  '&member=' +
  encodeURIComponent(MEMBER);

const PREFIXES = `
PREFIX crm:    <http://www.cidoc-crm.org/cidoc-crm/>
PREFIX crmdig: <http://www.ics.forth.gr/isl/CRMdig/>
PREFIX crminf: <http://www.cidoc-crm.org/extensions/crminf/>
PREFIX skos:   <http://www.w3.org/2004/02/skos/core#>
PREFIX rdfs:   <http://www.w3.org/2000/01/rdf-schema#>
PREFIX xsd:    <http://www.w3.org/2001/XMLSchema#>
PREFIX rat:    <https://w3id.org/murtenpanorama/resource/vocab/resolution_annotation_type/>
PREFIX t:      <${BASE}>
`;

type Row = Record<string, { value: string; datatype?: string; type: string }>;

async function select(api: APIRequestContext, query: string): Promise<Row[]> {
  const res = await api.post('/sparql', {
    headers: { Accept: 'application/sparql-results+json' },
    form: { query: PREFIXES + query },
  });
  if (!res.ok()) throw new Error(`SELECT failed ${res.status()}: ${(await res.text()).slice(0, 400)}`);
  return (await res.json()).results.bindings as Row[];
}

async function update(api: APIRequestContext, q: string): Promise<void> {
  const res = await api.post('/sparql', { form: { update: PREFIXES + q } });
  if (!res.ok()) throw new Error(`UPDATE failed ${res.status()}: ${(await res.text()).slice(0, 400)}`);
}

/** every quad in the scratch graph whose subject sits under a given prefix */
async function describeUnder(api: APIRequestContext, prefix: string) {
  return select(
    api,
    `SELECT ?s ?p ?o WHERE { GRAPH <${GRAPH}> { ?s ?p ?o }
       FILTER(STRSTARTS(STR(?s), "${prefix}")) } ORDER BY ?s ?p`
  );
}

function line(...parts: unknown[]) {
  console.log(parts.join(' '));
}

/**
 * Wait for a real condition instead of sleeping a guessed number of milliseconds.
 *
 * A probe must never throw, so a timeout here prints and continues — the caller's own
 * output then shows what was missing. Fixed waitForTimeout() calls were wrong in both
 * directions: dead time when the app was fast, and an intermittent lie when it was slow.
 */
async function settle(what: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch {
    line(`  (gave up waiting for ${what} — continuing; counts below may be short)`);
  }
}

/**
 * Wait until a locator's count STOPS CHANGING, then return it.
 *
 * The status table re-queries SPARQL asynchronously after every decision, so "the first row
 * is visible" is not the same as "the table has finished rendering". Waiting on the first
 * element made this probe read a half-built table and report phantom template regressions
 * (missing orphan/divergent rows, 0 skos inputs). A fixed sleep hid that by accident; this
 * waits for the real condition instead.
 */
async function stable(
  what: string,
  loc: Locator,
  { min = 1, settleMs = 700, timeout = 30_000 } = {}
): Promise<number> {
  const deadline = Date.now() + timeout;
  let last = -1;
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    const n = await loc.count();
    if (n !== last) {
      last = n;
      lastChange = Date.now();
    } else if (n >= min && Date.now() - lastChange >= settleMs) {
      return n;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  line(`  (${what} never settled at >=${min} within ${timeout}ms; last count ${last})`);
  return last;
}

/** Statuses as the page currently renders them, read out of the live DOM. */
async function readStatuses(page: Page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('.provenance-status')];
    return rows.map((r) => ({
      badge: r.querySelector('.badge.origin-badge')?.textContent?.trim().replace(/\s+/g, ' ') ?? '(none)',
      outstanding: r.classList.contains('provenance-status--outstanding'),
      predicate: r.querySelector('.provenance-predicate')?.textContent?.trim() ?? '',
      target: r.querySelector('.provenance-adopted-row a')?.getAttribute('href') ?? '',
      buttons: [...r.querySelectorAll('.provenance-decisions button')].map((b) => b.textContent?.trim()),
    }));
  });
}

async function seed(api: APIRequestContext) {
  await update(api, `DROP SILENT GRAPH <${GRAPH}>`);
  await update(
    api,
    `INSERT DATA {
      GRAPH <${GRAPH}> {
        t:member-1 a crm:E55_Type , skos:Concept ;
            rdfs:label "ADJTEST scratch member" ;
            skos:prefLabel "ADJTEST scratch member" .

        t:member-1_appraisal_machine-1 a crmdig:D30_Annotation_Event ;
            crm:P14_carried_out_by <urn:adjtest:agent> ;
            crm:P4_has_time-span t:member-1_appraisal_machine-1_ts ;
            crm:P3_has_note "ADJTEST machine appraisal, wave 0." ;
            crmdig:L48_created_annotation t:member-1_appraisal_machine-1_annotation_a ,
                                          t:member-1_appraisal_machine-1_annotation_b .
        t:member-1_appraisal_machine-1_ts a crm:E52_Time-Span ;
            crm:P82_at_some_time_within "2026-08-01T09:00:00.000Z"^^xsd:dateTime .

        t:member-1_appraisal_machine-1_annotation_a a crmdig:D29_Annotation_Object ;
            crm:P2_has_type rat:pending-adjudication ;
            crminf:J30_has_domain t:member-1 ;
            crminf:J32_has_property_type skos:exactMatch ;
            crminf:J31_has_range <${TARGET_A}> ;
            crm:P3_has_note "ADJTEST pending A: two candidates were indistinguishable on the evidence captured." .

        t:member-1_appraisal_machine-1_annotation_b a crmdig:D29_Annotation_Object ;
            crm:P2_has_type rat:pending-adjudication ;
            crminf:J30_has_domain t:member-1 ;
            crminf:J32_has_property_type skos:closeMatch ;
            crminf:J31_has_range <${TARGET_B}> ;
            crm:P3_has_note "ADJTEST pending B: plausible but the sortal reading is unsettled." .

        t:member-1_appraisal_machine-2 a crmdig:D30_Annotation_Event ;
            crm:P14_carried_out_by <urn:adjtest:agent> ;
            crm:P4_has_time-span t:member-1_appraisal_machine-2_ts ;
            crm:P3_has_note "ADJTEST machine appraisal, wave 0, adoption whose flat triple was later hand-removed." ;
            crmdig:L48_created_annotation t:member-1_appraisal_machine-2_annotation_c .
        t:member-1_appraisal_machine-2_ts a crm:E52_Time-Span ;
            crm:P82_at_some_time_within "2026-08-01T09:05:00.000Z"^^xsd:dateTime .

        t:member-1_appraisal_machine-2_annotation_c a crmdig:D29_Annotation_Object ;
            crm:P2_has_type rat:alignment ;
            crminf:J30_has_domain t:member-1 ;
            crminf:J32_has_property_type skos:exactMatch ;
            crminf:J31_has_range <${TARGET_C}> ;
            crm:P3_has_note "ADJTEST adopted C: the flat triple is deliberately NOT seeded — an orphaned adoption." .

        t:member-1_appraisal_machine-3 a crmdig:D30_Annotation_Event ;
            crm:P14_carried_out_by <urn:adjtest:agent> ;
            crm:P4_has_time-span t:member-1_appraisal_machine-3_ts ;
            crm:P3_has_note "ADJTEST machine appraisal, wave 1: proposes exactMatch where closeMatch stands." ;
            crmdig:L48_created_annotation t:member-1_appraisal_machine-3_annotation_d .
        t:member-1_appraisal_machine-3_ts a crm:E52_Time-Span ;
            crm:P82_at_some_time_within "2026-08-01T09:10:00.000Z"^^xsd:dateTime .

        t:member-1_appraisal_machine-3_annotation_d a crmdig:D29_Annotation_Object ;
            crm:P2_has_type rat:pending-adjudication ;
            crminf:J30_has_domain t:member-1 ;
            crminf:J32_has_property_type skos:exactMatch ;
            crminf:J31_has_range <${TARGET_D}> ;
            crm:P3_has_note "ADJTEST pending D: the standing closeMatch is too weak; the evidence supports identity." .

        t:member-1 skos:closeMatch <${TARGET_D}> .
      }
    }`
  );
}

/**
 * Open the per-row dialog whose trigger button carries `label`, on the row for `target`,
 * type a note, submit, and wait for the status table to come back.
 */
async function decide(page: Page, target: string, label: string, note: string) {
  const row = page.locator('.provenance-status', { has: page.locator(`a[href="${target}"]`) });
  const literal = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // Move buttons carry parentheses
  await row.locator('.provenance-decisions button', { hasText: new RegExp(`^${literal}$`) }).click();

  const dialog = page.locator('.modal-dialog', { hasText: 'Record decision' });
  await dialog.waitFor({ state: 'visible', timeout: 30_000 });

  // the inner form is a real semantic-form: wait for it to become submittable
  const submit = dialog.locator('button:has-text("Record decision")');
  await expect(submit).toBeEnabled({ timeout: 30_000 });

  line(`    dialog title:   ${(await page.locator('.modal-title').first().textContent())?.trim()}`);

  const textarea = dialog.locator('textarea');
  if (await textarea.count()) await textarea.first().fill(note);
  else await dialog.locator('input[type="text"]').first().fill(note);

  await submit.click();
  await dialog.waitFor({ state: 'detached', timeout: 60_000 });

  // The dialog detaching means the update committed, which is enough for a read via the
  // SPARQL API — but callers also read the UI status table, and that re-queries on its own
  // schedule. Wait for it to stop changing before returning.
  await stable('status rows after the decision', page.locator('.provenance-status'));
}

test('probe: alignment adjudication end to end', async ({ page }) => {
  test.setTimeout(300_000);

  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().includes('favicon')) consoleErrors.push(`HTTP ${r.status()} ${r.url().slice(0, 140)}`);
  });

  const api = page.request; // carries the Shiro session from auth.setup.ts

  line('\n=== 1. scratch fixture ===============================================');
  await seed(api);
  const seeded = await describeUnder(api, BASE);
  line(`  ${seeded.length} quads written into <${GRAPH}>`);
  line(`  member        ${MEMBER}`);
  line(`  machine act   ${ACT}`);
  line(`  pending A     exactMatch  -> ${TARGET_A}`);
  line(`  pending B     closeMatch  -> ${TARGET_B}`);

  line('\n=== 2. the harness page ==============================================');
  await page.setViewportSize({ width: 1500, height: 1200 });
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  // wait for content, never for the container: the section mounts only once SPARQL returns
  await page.waitForSelector('.provenance-status', { timeout: 90_000 });
  line(`  status rows rendered: ${await stable('the status table', page.locator('.provenance-status'))}`);

  const notice = await page
    .locator('.provenance-outstanding-notice')
    .first()
    .textContent()
    .catch(() => null);
  line(`  outstanding notice: ${notice ? notice.trim().replace(/\s+/g, ' ') : '(absent)'}`);
  for (const s of await readStatuses(page)) line('  status row:', JSON.stringify(s));

  line('\n=== 3. Adopt pending A ===============================================');
  await decide(page, TARGET_A, 'Adopt', 'ADJTEST adopt: the Wikidata item is the same thing; the second candidate is a namesake.');
  // no wait needed: decide() returns only once the dialog has detached, which means the
  // form submitted and the update committed. The read below goes to the API, not the UI.

  const acts = await select(
    api,
    `SELECT ?act ?p ?o WHERE { GRAPH <${GRAPH}> { ?act crm:P17_was_motivated_by <${ACT}> ; ?p ?o } } ORDER BY ?act ?p`
  );
  const actIris = [...new Set(acts.map((r) => r.act.value))];
  line(`  human acts now present: ${actIris.length}`);
  for (const r of acts) line(`    ${r.act.value.replace(BASE, 't:')}  ${r.p.value.replace(/^.*[#/]/, '')}  ${r.o.value}`);

  const adoptAct = actIris[0];
  const anno = await select(
    api,
    `SELECT ?anno ?p ?o WHERE { GRAPH <${GRAPH}> { <${adoptAct}> crmdig:L48_created_annotation ?anno . ?anno ?p ?o } } ORDER BY ?p`
  );
  line('  D29 payload minted by that act:');
  for (const r of anno) line(`    ${r.p.value.replace(/^.*[#/]/, '')}  ${r.o.value}`);

  line('\n  --- P4_has_time-span, checked hard ---');
  const ts = await select(
    api,
    `SELECT ?ts ?when WHERE { GRAPH <${GRAPH}> { <${adoptAct}> crm:P4_has_time-span ?ts . ?ts crm:P82_at_some_time_within ?when } }`
  );
  if (ts.length === 0) {
    line('  *** FAIL LOUD: the act carries NO P4_has_time-span/P82 at all. ***');
  } else {
    const when = ts[0].when;
    const dt = when.datatype ?? '(none)';
    const parsed = new Date(when.value);
    const typedOk = dt === 'http://www.w3.org/2001/XMLSchema#dateTime';
    const parseOk = !Number.isNaN(parsed.getTime());
    line(`  time-span node: ${ts[0].ts.value}`);
    line(`  P82 lexical:    "${when.value}"`);
    line(`  P82 datatype:   ${dt}`);
    line(`  parses as date: ${parseOk ? parsed.toISOString() : 'NO'}`);
    if (!typedOk || !parseOk || /CEST|CET|[A-Z]{3}$/.test(when.value)) {
      line('  *** FAIL LOUD: P4 did NOT land as a clean xsd:dateTime.');
      line('      Expected "…Z"^^xsd:dateTime from plain NOW(); a value ending in a timezone');
      line('      NAME means someone reintroduced xsd:date(NOW()), which Blazegraph mangles. ***');
    } else {
      line('  P4 landed typed and parseable — OK');
    }
  }

  const flat = await select(
    api,
    `SELECT ?g WHERE { GRAPH ?g { <${MEMBER}> <${EXACT}> <${TARGET_A}> } }`
  );
  line(`\n  flat triple <member> skos:exactMatch <${TARGET_A}>: ` +
    (flat.length ? `present in ${flat.map((r) => r.g.value).join(', ')}` : '*** ABSENT — Adopt did not write it ***'));

  line('\n  --- section after re-render ---');
  for (const s of await readStatuses(page)) line('  status row:', JSON.stringify(s));
  const adjudicatedBlocks = await page.locator('td.table-title:has-text("Adjudicated")').count();
  line(`  act blocks headed "Adjudicated": ${adjudicatedBlocks}`);
  const noticeAfter = await page
    .locator('.provenance-outstanding-notice')
    .first()
    .textContent()
    .catch(() => null);
  line(`  outstanding notice: ${noticeAfter ? noticeAfter.trim().replace(/\s+/g, ' ') : '(absent)'}`);

  line('\n=== 4. Refuse pending B ==============================================');
  const beforeRefuse = await select(
    api,
    `SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { <${MEMBER}> ?p <${TARGET_B}> } }`
  );
  await decide(page, TARGET_B, 'Refuse', 'ADJTEST refuse: the AAT concept is a different sortal; recorded so the next wave does not re-surface it.');

  const afterRefuse = await select(
    api,
    `SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { <${MEMBER}> ?p <${TARGET_B}> } }`
  );
  line(`  triples member -> ${TARGET_B}: before=${beforeRefuse[0].n.value} after=${afterRefuse[0].n.value}` +
    (afterRefuse[0].n.value === beforeRefuse[0].n.value ? '  (unchanged — correct)' : '  *** Refuse changed the record ***'));

  const refusal = await select(
    api,
    `SELECT ?act ?anno ?p ?o WHERE {
       GRAPH <${GRAPH}> {
         ?act crm:P17_was_motivated_by <${ACT}> ; crmdig:L48_created_annotation ?anno .
         ?anno crm:P2_has_type <https://w3id.org/murtenpanorama/resource/vocab/resolution_annotation_type/rejected> .
         ?anno ?p ?o } } ORDER BY ?p`
  );
  line('  rejected D29 payload:');
  for (const r of refusal) line(`    ${r.p.value.replace(/^.*[#/]/, '')}  ${r.o.value}`);

  const refusalNote = await select(
    api,
    `SELECT ?note WHERE { GRAPH <${GRAPH}> { ?act crm:P17_was_motivated_by <${ACT}> ; crm:P3_has_note ?note } }`
  );
  line('  notes on the human acts:');
  for (const r of refusalNote) line(`    "${r.note.value}"`);

  line('\n  --- section after re-render ---');
  for (const s of await readStatuses(page)) line('  status row:', JSON.stringify(s));

  line('\n=== 4b. Refuse the orphaned adoption =================================');
  // the row for TARGET_C: a machine rat:alignment payload with no flat triple. It should
  // present as "No longer recorded" with BOTH buttons — Reinstate and Refuse (the Refuse
  // dialog sits outside the pending-vs-orphan branch in the template, so upholding a
  // removal is possible with provenance, not just reversing it).
  const orphanRows = (await readStatuses(page)).filter((s) => s.target === TARGET_C);
  for (const s of orphanRows) line('  orphan status row:', JSON.stringify(s));
  if (!orphanRows.length) line('  *** no status row for the orphaned adoption — template regression ***');

  await decide(page, TARGET_C, 'Refuse', 'ADJTEST refuse orphan: the removal was deliberate; upholding it.');

  const afterOrphan = await select(
    api,
    `SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { <${MEMBER}> ?p <${TARGET_C}> } }`
  );
  line(`  triples member -> ${TARGET_C}: after=${afterOrphan[0].n.value}` +
    (afterOrphan[0].n.value === '0' ? '  (still absent — correct: refusing an orphan writes no triple)' : '  *** Refuse wrote a triple ***'));

  const orphanRefusal = await select(
    api,
    `SELECT ?anno ?p ?o WHERE {
       GRAPH <${GRAPH}> {
         ?act crm:P17_was_motivated_by <${ACT2}> ; crmdig:L48_created_annotation ?anno .
         ?anno crm:P2_has_type <https://w3id.org/murtenpanorama/resource/vocab/resolution_annotation_type/rejected> .
         ?anno ?p ?o } } ORDER BY ?p`
  );
  line('  rejected D29 payload (upholding the removal):');
  for (const r of orphanRefusal) line(`    ${r.p.value.replace(/^.*[#/]/, '')}  ${r.o.value}`);
  const segOk = orphanRefusal.length && /\/annotation\//.test(orphanRefusal[0].anno.value);
  line(`  D29 IRI segment: ${orphanRefusal.length ? orphanRefusal[0].anno.value.replace(BASE, 't:') : '(none minted)'}` +
    (segOk ? '  (/annotation/ — correct for a declining verdict)' : '  *** wrong segment or no D29 ***'));

  line('\n  --- section after re-render ---');
  for (const s of (await readStatuses(page)).filter((x) => x.target === TARGET_C)) line('  status row:', JSON.stringify(s));

  line('\n=== 4c. The strength move ============================================');
  // TARGET_D: a pending exactMatch beside a seeded standing closeMatch. This row used to
  // be swallowed as "settled"; it must now surface as divergent, and adopting must be a
  // MOVE — one act, two D29s, closeMatch deleted and exactMatch written in one update.
  const moveRows = (await readStatuses(page)).filter((s) => s.target === TARGET_D);
  for (const s of moveRows) line('  divergent status row:', JSON.stringify(s));
  if (!moveRows.length) line('  *** no status row for the divergent pending — it is being swallowed again ***');

  await decide(page, TARGET_D, 'Adopt exactMatch (replaces closeMatch)',
    'ADJTEST move: identity is supported by the captured bytes; closeMatch was too weak.');

  const standing = await select(
    api,
    `SELECT ?p WHERE { GRAPH ?g { <${MEMBER}> ?p <${TARGET_D}> } }`
  );
  const props = standing.map((r) => r.p.value.replace(/^.*[#/]/, '')).sort().join(', ');
  line(`  flat triples member -> ${TARGET_D}: [${props}]` +
    (props === 'exactMatch' ? '  (closeMatch deleted, exactMatch written — correct)' : '  *** move did not swap the strengths ***'));

  const moveAnnos = await select(
    api,
    `SELECT ?act ?anno ?verdict ?prop WHERE {
       GRAPH <${GRAPH}> {
         ?act crm:P17_was_motivated_by <${ACT3}> ; crmdig:L48_created_annotation ?anno .
         ?anno crm:P2_has_type ?verdict ; crminf:J32_has_property_type ?prop } } ORDER BY ?verdict`
  );
  line(`  D29s under the move act: ${moveAnnos.length}` + (moveAnnos.length === 2 ? '  (one granted, one vacated — correct)' : '  *** expected exactly 2 ***'));
  for (const r of moveAnnos) {
    const seg = /\/alignment\//.test(r.anno.value) ? '/alignment/' : /\/annotation\//.test(r.anno.value) ? '/annotation/' : '???';
    line(`    ${r.verdict.value.replace(/^.*[#/]/, '')}  @${r.prop.value.replace(/^.*[#/]/, '')}  segment ${seg}`);
  }
  const oneAct = new Set(moveAnnos.map((r) => r.act.value)).size;
  line(`  distinct human acts: ${oneAct}` + (oneAct === 1 ? '  (one decision, one act — correct)' : '  *** the move split into several acts ***'));

  line('\n  --- section after re-render ---');
  for (const s of (await readStatuses(page)).filter((x) => x.target === TARGET_D)) line('  status row:', JSON.stringify(s));

  line('\n=== 5. teardown ======================================================');
  await update(api, `DROP SILENT GRAPH <${GRAPH}>`);
  const left = await select(api, `SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${GRAPH}> { ?s ?p ?o } }`);
  const strays = await select(
    api,
    `SELECT ?g (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o }
       FILTER(STRSTARTS(STR(?s), "${BASE}") || STRSTARTS(STR(?o), "${BASE}")) } GROUP BY ?g`
  );
  line(`  quads left in <${GRAPH}>: ${left[0].n.value}`);
  line(`  scratch IRIs left anywhere: ${strays.length ? strays.map((r) => `${r.g.value}=${r.n.value}`).join(', ') : 'none'}`);
  if (left[0].n.value !== '0' || strays.length) line('  *** FAIL LOUD: scratch data survived teardown ***');

  line('\n=== console/network errors ===========================================');
  if (consoleErrors.length === 0) line('  none');
  for (const e of [...new Set(consoleErrors)].slice(0, 25)) line('  ' + e);
  line('');
});

/**
 * Read-only companion. Picks a real member out of the store — one that actually carries
 * payload appraisals — and prints what the section makes of it. Nothing is written; this
 * is the regression check that the extended template still renders production data, and
 * the fastest way to see how many alignments in the store have quietly lost their triple.
 */
test('probe: alignment provenance on a real member (read-only)', async ({ page }) => {
  test.setTimeout(180_000);
  const api = page.request;

  const candidates = await select(
    api,
    `SELECT ?entity (COUNT(DISTINCT ?anno) AS ?n) WHERE {
       ?act a crmdig:D30_Annotation_Event ; crmdig:L48_created_annotation ?anno .
       ?anno crminf:J30_has_domain ?entity ; crminf:J31_has_range ?target ; crm:P2_has_type ?t .
       FILTER(STRENDS(STR(?t), "/alignment") || STRENDS(STR(?t), "/pending-adjudication"))
       FILTER(!STRSTARTS(STR(?entity), "${BASE}"))
     } GROUP BY ?entity ORDER BY DESC(?n) LIMIT 1`
  );
  if (candidates.length === 0) {
    line('  no real member carries a payload appraisal — nothing to check');
    return;
  }
  const member = candidates[0].entity.value;
  line(`\n=== real member: ${member}  (${candidates[0].n.value} payload appraisals) ===`);

  await page.setViewportSize({ width: 1500, height: 1400 });
  await page.goto(
    '/resource/?uri=' + encodeURIComponent('https://w3id.org/dsanno/platform/AdjudicationTest') +
      '&member=' + encodeURIComponent(member),
    { waitUntil: 'domcontentloaded' }
  );
  await page.waitForSelector('.provenance-act, .provenance-status', { timeout: 90_000 });
  await settle('an act block to render', () =>
    page.locator('.provenance-act').first().waitFor({ state: 'visible', timeout: 30_000 }));

  const notice = await page.locator('.provenance-outstanding-notice').first().textContent().catch(() => null);
  line(`  outstanding notice: ${notice ? notice.trim().replace(/\s+/g, ' ') : '(absent)'}`);
  line(`  act blocks:        ${await page.locator('.provenance-act').count()}` +
    ` (of which "Adjudicated": ${await page.locator('td.table-title:has-text("Adjudicated")').count()})`);
  line(`  "Admitted under" rows: ${await page.locator('td.table-title:has-text("Admitted under")').count()}`);
  line(`  "Adopted" rows:        ${await page.locator('td.table-title:has-text("Adopted")').count()}`);
  line(`  "Evidence" rows:       ${await page.locator('td.table-title:has-text("Evidence")').count()}`);
  line(`  "Also established":    ${await page.locator('td.table-title:has-text("Also established")').count()}`);
  line(`  bare deferral rows:    ${await page.locator('td.table-title:has-text("Outstanding"), td.table-title:has-text("Was deferred")').count()}`);
  for (const s of await readStatuses(page)) line('  status row:', JSON.stringify(s));
  line('');
});

/**
 * The one that matters for the nesting trap, and still read-only.
 *
 * The section normally renders inside FormMetadataTab — i.e. inside a live <semantic-form>
 * whose child walk descends into every element that has children. A nested form seen by
 * that walk blanks the WHOLE outer form with "Errors in form configuration"; the dialogs
 * escape it only because they sit inside a <template> body. Nothing else in the repo
 * combines a dialog, a nested form and an outer form, so this is the check that the
 * escape actually holds in the real editor.
 *
 * It opens a real record that has an outstanding appraisal, opens the Adopt dialog, and
 * closes it again. It never submits, so the store is untouched.
 */
test('probe: the dialog inside the real record editor (read-only)', async ({ page }) => {
  test.setTimeout(240_000);
  const api = page.request;

  const hit = await select(
    api,
    `SELECT ?entity ?config ?target WHERE {
       ?act a crmdig:D30_Annotation_Event ; crmdig:L48_created_annotation ?anno .
       FILTER NOT EXISTS { ?act crm:P17_was_motivated_by ?m }
       ?anno crminf:J30_has_domain ?entity ; crminf:J31_has_range ?target ;
             crminf:J32_has_property_type ?prop ;
             crm:P2_has_type <https://w3id.org/murtenpanorama/resource/vocab/resolution_annotation_type/pending-adjudication> .
       FILTER(?prop IN (skos:exactMatch, skos:closeMatch, skos:broadMatch, skos:narrowMatch,
                        skos:relatedMatch, <http://www.w3.org/2002/07/owl#sameAs>,
                        <https://linked.art/ns/terms/equivalent>))
       FILTER NOT EXISTS { GRAPH ?g { ?entity ?anyp ?target }
                           FILTER(?anyp IN (skos:exactMatch, skos:closeMatch, skos:broadMatch,
                                            skos:narrowMatch, skos:relatedMatch,
                                            <http://www.w3.org/2002/07/owl#sameAs>,
                                            <https://linked.art/ns/terms/equivalent>)) }
       ?entity a ?class .
       ?config <http://www.researchspace.org/pattern/system/resource_configuration/resource_ontology_class> ?class ;
               a <http://www.researchspace.org/resource/system/resource_configuration> .
     } LIMIT 1`
  );
  if (hit.length === 0) {
    line('\n  no real record currently has an outstanding appraisal — nothing to open');
    return;
  }
  const { entity, config, target } = { entity: hit[0].entity.value, config: hit[0].config.value, target: hit[0].target.value };
  line(`\n=== real editor: ${entity}`);
  line(`    config:  ${config}`);
  line(`    pending: ${target}`);

  const url =
    '/resource/?uri=' + encodeURIComponent('http://www.researchspace.org/resource/ThinkingFrames') +
    '&view=resource-editor&entityTypeConfig=' + encodeURIComponent(config) +
    '&resource=' + encodeURIComponent(entity) + '&mode=edit';

  await page.setViewportSize({ width: 1600, height: 1300 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.semantic-form', { timeout: 120_000 });
  await settle('the editor tab strip', () =>
    page.locator('[role=tab]').first().waitFor({ state: 'visible', timeout: 60_000 }));

  line(`  outer form blanked by config errors: ${await page.locator('text=Errors in form configuration').count()} (0 is what we want)`);

  const ext = page.locator('[role=tab]', { hasText: 'External Authority' });
  if (await ext.count()) {
    await ext.first().click();
    await stable('the External Authority skos inputs',
      page.locator('input[placeholder*="match URL" i], input[placeholder*="sameAs URL" i]'));
  }
  const notice = await page.locator('.provenance-outstanding-notice').first().textContent().catch(() => null);
  line(`  External Authority tab — notice: ${notice ? notice.trim().replace(/\s+/g, ' ') : '(absent)'}`);
  line(`  External Authority tab — skos text inputs still present: ${await page.locator('input[placeholder*="match URL" i], input[placeholder*="sameAs URL" i]').count()}`);

  const md = page.locator('[role=tab]', { hasText: /^Metadata$/ });
  if (await md.count()) {
    await md.first().click();
    await stable('the Metadata act blocks', page.locator('.provenance-act'), { timeout: 60_000 });
    await stable('the Metadata status rows', page.locator('.provenance-status'), { timeout: 60_000 });
  }
  line(`  Metadata tab — act blocks: ${await page.locator('.provenance-act').count()}, status rows: ${await page.locator('.provenance-status').count()}`);
  line(`  Metadata tab — decision buttons: ${JSON.stringify(await page.locator('.provenance-decisions button').allTextContents())}`);

  const adopt = page.locator('.provenance-decisions button', { hasText: /^Adopt$/ }).first();
  if (await adopt.count()) {
    await adopt.click();
    await page.locator('.modal-dialog').waitFor({ state: 'visible', timeout: 30_000 });
    // The submit button is visible well before the nested semantic-form has mounted its note
    // field and become submittable, so waiting on the button alone read 0 fields / disabled.
    // Wait for the field to settle and the button to enable; if either genuinely never happens
    // this prints and the measurements below still report the real state.
    await stable('the note field in the dialog', page.locator('.modal-dialog textarea'));
    await settle('the dialog submit to enable', () =>
      expect(page.locator('.modal-dialog button:has-text("Record decision")')).toBeEnabled({ timeout: 30_000 }));
    line(`  dialog title:            ${(await page.locator('.modal-title').first().textContent())?.trim()}`);
    line(`  nested semantic-form:    ${await page.locator('.modal-dialog .semantic-form').count()}`);
    line(`  note field:              ${await page.locator('.modal-dialog textarea').count()}`);
    line(`  submit enabled:          ${await page.locator('.modal-dialog button:has-text("Record decision")').isEnabled()}`);
    line(`  config errors in dialog: ${await page.locator('.modal-dialog').getByText('Errors in form configuration').count()}`);
    await page.locator('.modal-header button.close').click(); // closed, never submitted
    await settle('the dialog to close', () =>
      page.locator('.modal-dialog').waitFor({ state: 'hidden', timeout: 30_000 }));
    line(`  dialog closed again:     ${!(await page.locator('.modal-dialog').isVisible().catch(() => false))}`);
  } else {
    line('  no Adopt button rendered on this record');
  }
  line(`  outer form still intact:   ${(await page.locator('text=Errors in form configuration').count()) === 0}`);
  line('');
});
