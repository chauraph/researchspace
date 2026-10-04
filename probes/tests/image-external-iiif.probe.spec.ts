/**
 * Probe for the Image form: a new image that is served by an
 * external IIIF service, with NO local file. Before the fix the form refused to save
 * ("Required a minimum of 1 values but 0 provided" on the image file input).
 *
 * STEP=submit (default): open the new-image editor, fill name + IIIF image service, Save; print the
 *   form errors, the persistence response and the SPARQL row of the created image.
 * STEP=cleanup: delete every quad the probe image created (image IRI, its minted children, the
 *   scratch service IRI) in GRAPH <http://www.researchspace.org/assets/images>. The scratch service
 *   IRI is under w3id.org/dsanno/scratch/, so nothing real is touched.
 */
import { test, Page } from '@playwright/test';

const CONFIG = 'http://www.researchspace.org/resource/system/resource_configurations_container/data/Image';
const GRAPH = 'http://www.researchspace.org/assets/images';
const SERVICE = 'https://w3id.org/dsanno/scratch/probe-iiif-service/external-no-file';
const STEP = process.env.STEP ?? 'submit';

async function sparql(page: Page, baseURL: string, query: string, update = false) {
  const r = await page.request.post(`${baseURL}/sparql`, {
    headers: { Accept: 'text/csv', Authorization: 'Basic ' + Buffer.from('admin:admin').toString('base64') },
    form: update ? { update: query } : { query },
  });
  return `${r.status()} ${(await r.text()).trim()}`;
}
const FIND = `SELECT ?img ?file WHERE { GRAPH <${GRAPH}> { ?img <http://www.cidoc-crm.org/cidoc-crm/P129i_is_subject_of>/<http://www.cidoc-crm.org/cidoc-crm/P129i_is_subject_of> <${SERVICE}> .
  OPTIONAL { ?img <http://www.cidoc-crm.org/extensions/crmdig/L60i_is_documented_by>/<http://www.cidoc-crm.org/extensions/crmdig/L11_had_output> ?file } } }`;

test('image with external IIIF service and no local file', async ({ page, baseURL }) => {
  const b = baseURL!;
  if (STEP === 'cleanup') {
    console.log('  [before]', await sparql(page, b, FIND));
    const upd = `DELETE { GRAPH <${GRAPH}> { ?s ?p ?o } } WHERE { GRAPH <${GRAPH}> {
      { ?img <http://www.cidoc-crm.org/cidoc-crm/P129i_is_subject_of>/<http://www.cidoc-crm.org/cidoc-crm/P129i_is_subject_of> <${SERVICE}> . ?s ?p ?o .
        FILTER(?s = ?img || STRSTARTS(STR(?s), CONCAT(STR(?img), "/")) || ?o = ?img || STRSTARTS(STR(?o), CONCAT(STR(?img), "/")) || ?s = <${SERVICE}>) }
      UNION { ?s ?p ?o . FILTER(?s = <${SERVICE}>) } } }`;
    console.log('  [delete]', await sparql(page, b, upd, true));
    console.log('  [after]', await sparql(page, b, FIND));
    return;
  }
  page.on('pageerror', (e) => console.log(`  [pageerror] ${String(e).slice(0, 300)}`));
  page.on('response', async (r) => {
    if (r.url().includes('/form-persistence/') || r.url().includes('/rest/data/rdf/')) {
      console.log(`  [persist ${r.request().method()} ${r.status()}] ${r.url().slice(b.length, b.length + 80)} ${(await r.text()).slice(0, 200)}`);
    }
  });
  const url = `${b}/resource/?uri=http%3A%2F%2Fwww.researchspace.org%2Fresource%2FThinkingFrames&view=resource-editor&entityTypeConfig=${encodeURIComponent(CONFIG)}&mode=new`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.semantic-form input[placeholder="Enter IIIF image service"]', { timeout: 90_000 });
  await page.waitForTimeout(3000);
  const fieldIri = await page.evaluate(() => {
    const el = document.querySelector('semantic-form, .semantic-form');
    return el ? (el.getAttribute('fields') || '').match(/[^"]*file_identifier[^"]*/)?.[0] : null;
  });
  console.log('  [file field in form]', fieldIri);
  console.log('  [required markers]', await page.locator('.semantic-form-input-decorator__label-required').count());
  await page.locator('.semantic-form input[placeholder="Enter image name"]').first().fill('Probe image (external IIIF, no file)');
  await page.locator('.semantic-form input[placeholder="Enter IIIF image service"]').first().fill(SERVICE);
  await page.waitForTimeout(1000);
  console.log('  [submit button]', await page.locator('.semantic-form button[name=submit]').first().innerText()); await page.locator('.semantic-form button[name=submit]').first().click();
  await page.waitForTimeout(6000);
  const errors = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.semantic-form-errors, .semantic-form-validation-messages, .has-error, .alert-danger'))
      .map((e) => (e as HTMLElement).innerText.trim()).filter(Boolean).slice(0, 10));
  console.log('  [form errors]', JSON.stringify(errors));
  console.log('  [url after save]', page.url().slice(b.length, b.length + 160));
  console.log('  [store]', await sparql(page, b, FIND));
});
