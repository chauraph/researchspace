# Probes

Diagnostic browser runs against a live ResearchSpace instance. **These are not
tests.** They assert nothing meaningful and never gate anything — they open a
page and print what they find, so a layout or data problem can be diagnosed from
numbers instead of screenshots.

Kept separate from `e2e/` on purpose: `e2e/` is upstream's assertion suite and
should stay byte-identical to upstream so it rebases cleanly. This directory is
ours, and its contents are expected to churn.

## Setup

```bash
cd probes
npm install
npm run install-browsers      # skipped automatically if Chromium is already cached
```

Playwright downloads its own Chromium to `~/Library/Caches/ms-playwright/`. Your
everyday browser and its profile are never involved.

## Run

Start the stack first (`./gradlew runAll` in the repo root), then:

```bash
npm run probe                       # every probe
npm run probe -- portal             # only probes matching "portal"
npm run probe:headed -- portal      # watch it happen
npm run ui                          # Playwright's interactive UI
```

Point it somewhere else with `RS_BASE_URL`, and override credentials with
`RS_USER` / `RS_PASSWORD`:

```bash
RS_BASE_URL=http://127.0.0.1:10215 npm run probe
```

Login is handled once by `tests/auth.setup.ts`, which saves the session to
`.auth/user.json`; every probe reuses it.

## Probes

| File | What it reports |
|---|---|
| `tests/portal.probe.spec.ts` | Per shelf: card count, real thumbnails vs fallback icons, the rendered count line, and box geometry for the shelf, row, rail and scroller. Plus console errors, failed requests, and screenshots at two viewport widths. |
| `tests/portal.ancestors.spec.ts` | Walks `html → .mp-portal` printing width, display, overflow and `min-width` for every ancestor. Written to find which container blows the page past the viewport. |
| `tests/adjudication.probe.spec.ts` | Alignment adjudication. Four probes: an end-to-end Adopt + Refuse against a scratch member, then three read-only checks against real records. See below. |

### `adjudication.probe.spec.ts`

The only probe here that writes. Everything it writes goes into the scratch graph
`<urn:dsanno:adjtest:data>` under scratch IRIs, and it drops the graph and verifies it
empty before finishing — real records are never touched. The read-only companions open
production records and close the dialog without submitting.

It drives the real UI (`dsanno:AdjudicationTest`, a harness page that mounts
`dsanno:AlignmentProvenance` against any member) and then reads the store back, printing
the act it minted triple by triple. The one thing it shouts about is the timestamp:
`P4_has_time-span/P82` must land as a clean `"…Z"^^xsd:dateTime`, because
`xsd:date(NOW())` is accepted by Blazegraph and yields the malformed `"2026-08-06 CEST"`.

`docs/ldp-authoring/alignment-adjudication.md` has the data shapes and the status rules.

## Writing a new probe

Print, don't assert. A probe that fails is a broken probe; a probe that reports
a surprising number has done its job. Use `page.evaluate()` to pull
`getComputedStyle` / `getBoundingClientRect` out of the live DOM.

Two things worth knowing about this application:

- **Never wait for `networkidle`.** The platform keeps requests in flight — the
  thumbnail resolver federates to Wikidata — so the network never goes quiet and
  the wait times out. Use `domcontentloaded`, then wait for a selector that only
  appears once SPARQL results have rendered.
- Pages are template-driven and mount lazily, so wait for actual content
  (`.mp-card`), not the container.
