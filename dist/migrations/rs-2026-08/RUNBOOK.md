# Runbook — rs-2026-08 migration wave

Per-task procedures for the August 2026 wave. Task ledger, wave-wide rules and
conventions: [`README.md`](README.md). New tasks append their own section here.

---

## Task 01 — owl:sameAs → la:equivalent (store sweep)

`owl:sameAs` is retired as an authored
alignment predicate (2026-08-13) in favor of `<https://linked.art/ns/terms/equivalent>`.
Code (RS templates/forms/aliases) and SOT (rs-ldp authority trigs, commit `fb133f6`)
are migrated; this directory is the **database side**. Dev done 2026-08-13;
**prod pending**.

Scripts here follow the `rs-4.1.0-minimal` conventions: numbered `.sparql` steps
with usage in the header, `checks.sh` for verification (`SPARQL`/`RS_USER`/`RS_PASS`
from the environment).

Endpoints: dev `http://127.0.0.1:10214/sparql`, prod `:10215/blazegraph/sparql`.

## Mental model — files before SPARQL

With `forceLDPLoadFromStorages=runtime`, authority graphs are **cleared and
reloaded from `runtime-data/ldp/**` on every startup**. Storage is the source of
truth for those graphs; the DB is downstream. A SPARQL rewrite of a force-loaded
graph is silently reverted at the next boot — for those graphs, the file rewrite
in rs-ldp *is* the migration and the restart is the atomic swap. SPARQL is only
for graphs force-load never touches (form-authored entity data, e.g. `rsp:g/data`).

## Procedure

0. **Back up the journal** (dev precedent:
   `runtime-data/blazegraph-pre-migrate-owl-to-la.jnl`).
1. **Deploy files**: from rs-ldp, `./deploy.sh <env> --go` — **all** authority
   files, not a pattern subset. (A pattern-limited deploy left
   `geopolitical_unit`/`place` stale on dev; only `t01_1_inventory` caught it.)
2. **Restart** the instance. Force-load swaps the file-backed graphs.
3. **`t01_1_inventory.sparql`** — read it, don't skip to 4:
   - file-backed authority graph listed → deploy/restart didn't land; go back to 1;
   - graphs you own → they become 02's `VALUES` allowlist;
   - zero rows → skip to 5.
4. **`t01_2_sweep_data_graphs.sparql`** — edit the `VALUES` allowlist, run once.
   Atomic, idempotent.
5. **`./checks.sh verify`** — I1 zero rows, E1 counts as expected, A1 = 0,
   K1 returns the insert pattern.
   - If K1 is empty: the Linked Art ontology isn't loaded / KPs not generated on
     this instance. Ontology auto-load is first-boot seeding only
     (`LDPAssetsLoader` guard: any existing `owl:Ontology` blocks it) — import
     the ontology via the admin UI (content of
     `apps/default/ldp/ontologies/la.trig`), then
     `POST /rest/kp/generateKps?ontologyIri=https://linked.art/ns/terms/`.
6. **Human checks** (per instance): AlignmentProvenance shows no new
   "no longer recorded" rows (person's unbacked warnings drop by ~48); Wikidata
   thumbnails render on migrated entities; a form save writes `la:equivalent`
   and never `owl:sameAs`; FederationTab lists external links as before.

## What is deliberately NOT swept

- String occurrences of "sameAs" inside note/JSON literals (captured external
  payloads) — literal text, not triples.
- `owl:sameAs` stays permanently tolerated on all **read** paths and
  match-predicate allowlists so imported legacy data remains visible. Do not
  "clean up" the read-path property paths
  `(owl:sameAs|<https://linked.art/ns/terms/equivalent>)`.
- J32 act predicates: zero sameAs-backed acts exist by construction (sameAs was
  only ever minted flat); A1 re-proves the premise per store.

---

## Task 02 — server-side SAM retired (`sam_` → `samlocal_` shape prefix)

The server-side Mirador drawing tool `$.Sam` — which posted to
`../proxy/segmentation/*` — is retired. `$.SamLocal` (in-browser SAM2, WebGPU)
is promoted to be the only SAM tool and loses its "experimental"/"in-browser"
qualifiers. This directory is the **database side**: the code excise and the
proxy/service decommission are tracked separately.
Dev done 2026-08-25; **prod pending**.

## Mental model — the prefix is the tool binding

paper.js serialises a shape's name as the SVG `id` attribute
(`mirador-src/vendors/10-paper.js:14939`); Mirador maps a stored shape back to
the tool that owns it by matching that prefix (`osd-svg-overlay.js:654`, `:818`),
and `:571` needs the resolved tool for `onMouseDrag`. The promoted tool keeps
`idPrefix: 'samlocal_'` — deliberately, because 48 regions on dev already carry
it — so regions drawn by the removed tool must be rewritten or they become
permanently unreshapeable. Rendering, selection and deletion would still work,
which is why this fails quietly rather than loudly.

Unlike task 01, ImageRegion container graphs are **not** file-backed: nothing
matches under `runtime-data/ldp/**` or the app layer, so force-load never sees
them and SPARQL is the correct mechanism. Re-verify per instance (step 1) —
do not assume.

## Procedure

1. **Confirm the graphs are store-only** on this instance:
   ```
   find <runtime> -path '*ldp*' -iname '*ImageRegion*'    # expect: nothing
   grep -rl 'id="sam_' <runtime>/                          # expect: nothing
   ```
   A hit means the region data is file-backed here: migrate the FILES, not the
   store, or the next boot reverts the rewrite.
2. **`t02_1_inventory.sparql`** — read it, don't skip to 3:
   - zero `sam-server` rows → nothing to migrate, go to 6;
   - every namespace listed against `sam-server` must be one you own; that set
     becomes the `VALUES ?ns` allowlist in 02 and 03.
3. **Back up** exactly the rows about to change — the curl is in
   `t02_3_rewrite.sparql`'s header. Write it to `backups/t02_<env>_pre_<date>.json`.
   (The wave rule asks for a journal backup before the wave's first write; on dev
   no such artifact survives from t01, so this targeted export is what covers the
   2026-08-25 run. It is the more precise rollback for a 23-quad change anyway.)
4. **`t02_2_dryrun.sparql`** — edit the allowlist, read the output. `?leftover`
   and `?datatypeChanged` must be false on every row; `?idsRewritten` must be a
   whole number ≥ 1.
5. **`t02_3_rewrite.sparql`** — same allowlist, run once. Atomic, idempotent.
6. **`./checks.sh t02`** — S1 zero rows, S2 all zeros, S3 totals conserved
   (`sam-server` gone, `samlocal` up by exactly the pre-run `sam-server` count,
   `other` unchanged).
7. **Human check** (per instance): open a migrated region in Mirador — the
   toolbar must switch to the SAM tool when the shape is clicked, and the shape
   must drag. This is the check the store cannot make; S1–S3 only prove the
   bytes moved.

## Ordering against the code change

Run the rewrite **before** the code excise deploys. `$.SamLocal` already claims
`samlocal_`, so migrated regions are live immediately and no region is ever
tool-less. The reverse order leaves a window where every old region is frozen.

After the code ships and the toolbar is confirmed, remove the proxy entry and
stop the service — **in that order**:

- dev: `config.proxy.segmentation.targetUri=http://localhost:7860` in
  `runtime-data/config/proxy.prop` (leave `tile-search`, it is unrelated);
- prod: the same key in that instance's config repo.

Until that entry is gone **and** the code is deployed, the removed tool is still
clickable and still mints fresh `sam_` regions — S1 turning non-zero again is the
symptom.

## What is deliberately NOT rewritten

- Regions drawn by other tools (`rectangle_`, `ellipse_`, `smooth_path_`,
  `rough_path_`, `pin_`) — untouched, and S3 asserts their count is unchanged.
- The `samlocal_` prefix itself. It is retained under the promoted name `Sam`
  precisely so no existing region needs migrating; renaming it to `sam_` would
  invert this task.
- Prod model provisioning is not a data step but blocks the deploy: run
  `scripts/fetch-sam2-models.sh <runtime>/assets/no_auth/models/sam2`. The
  availability gate (`SamClientEngine.ts:130-138`) tests only for a WebGPU
  adapter, not for the model files — a host without them shows the tool and
  fails at first use.
