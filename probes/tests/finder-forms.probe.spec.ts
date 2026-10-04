/**
 * ResearchSpace
 * Copyright (C) 2026, Tsz Kin Chau, eM+ / EPFL
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

/**
 * Every semantic form the Finder offers, opened in CREATE mode.
 * Per form: whether it mounted, field count, required markers, raw IRIs shown as labels, console errors.
 * Nothing is typed and nothing is submitted; the request guard aborts any write.
 * Reports, never asserts.
 */
import { test } from '@playwright/test';
import { guard, watch, frameUrl, open, counts, text, select, tripleCount } from './readonly.lib';

const ONLY = process.env.ONLY ?? '';

test('Finder forms in create mode', async ({ page, context, baseURL }) => {
  test.setTimeout(900_000);
  const blocked = await guard(context);
  const w = watch(page);
  const base = baseURL!;
  console.log(`  [store] triples before: ${await tripleCount(page, base)}`);

  const forms = await select(page, base, `
    PREFIX rc: <http://www.researchspace.org/pattern/system/resource_configuration/>
    SELECT ?cfg ?name ?form WHERE { ?cfg rc:resource_in_finder ?f ; rc:resource_name ?name . OPTIONAL { ?cfg rc:resource_form ?form } }
    ORDER BY ?name`);
  console.log(`  [finder] configurations in the Finder: ${forms.length}; with a form: ${forms.filter((f) => f.form).length}`);

  for (const f of forms) {
    if (ONLY && !f.name.includes(ONLY)) continue;
    if (!f.form) { console.log(`  [form ${f.name}] no resource_form on the configuration: skipped`); continue; }
    w.reset();
    const ok = await open(page, `form ${f.name}`, frameUrl(base, { view: 'resource-editor', entityTypeConfig: f.cfg, mode: 'new' }), '.semantic-form', 3000, 45_000);
    const c = await counts(page, {
      forms: '.semantic-form',
      fields: '.semantic-form-input-decorator',
      labels: '.semantic-form-input-decorator__label',
      required: '.semantic-form-input-decorator__label-required',
      inputs: '.semantic-form input, .semantic-form textarea, .semantic-form select',
      submit: '.semantic-form button[name=submit]',
      formErrors: '.semantic-form .has-error, .semantic-form-validation-messages__error, .semantic-form-errors__error',
      spinners: '.semantic-form .system-spinner, .semantic-form .Spinner',
      alerts: '.alert-danger, .ErrorNotification, .error-notification',
    });
    const t = await text(page, '.semantic-form', 90);
    console.log(`  [form ${f.name}] mounted=${ok} ${JSON.stringify(c)} rawIris=${(t as any).rawIriCount ?? 0} ${JSON.stringify(t.rawIris)}`);
    if (!ok) console.log(`  [form ${f.name}] body: ${(await text(page, 'body', 260)).snippet}`);
    w.report(`form ${f.name}`);
  }
  console.log(`  [guard] writes blocked: ${blocked.length}`);
  console.log(`  [store] triples after: ${await tripleCount(page, base)}`);
});
