# rs-4.1.0-minimal — CRM namespace migration, conservative variant

**This is not upstream's 4.1.0 migration.** It is a deliberately reduced variant
maintained by this fork. Running upstream's `dist/migrations/4.1.0/` against this
deployment instead of this directory will migrate CRMdig and FRBRoo and split
production data. See *Relationship to upstream 4.1.0* below.

## What it does

| Namespace | Action |
|---|---|
| `cidoc-crm/CRMarchaeo/` → `extensions/crmarchaeo/` | migrate |
| `cidoc-crm/CRMba/` → `extensions/crmba/` | migrate |
| `isl/CRMgeo/` → `extensions/crmgeo/` | migrate |
| `cidoc-crm/influence/` → `extensions/influence/` | migrate |
| `cidoc-crm/CRMsci/`, `isl/CRMsci/` → `extensions/crmsci/` | migrate |
| `isl/CRMinf/` → `extensions/crminf/` | migrate |
| `isl/CRMdig/` → `extensions/crmdig/` | **NOT migrated (pinned)** |
| `fr/frbr/frbroo/` → `lrm/lrmoo/` | **NOT migrated (pinned)** |

Plus two things upstream's script does not do at all:

- **Term renames.** `S4_Observation` → `S4_Single_Observation`,
  `O21_has_found_at` → `O21_encountered_at`, `J3_applies` → `J3_applied`.
  Upstream rewrites namespaces only, so a prefix-only pass produces IRIs that
  look migrated but resolve to nothing.
- **CRMdig pin enforcement on preloaded artefacts.** Six LDP artefacts
  cherry-picked from `upstream/cidoc-extensions-forms` already carry the new
  CRMdig namespace and contradict the pin.

## Why CRMdig and FRBRoo are pinned

Migrating a namespace is safe only where there is no instance data to orphan.
Counts observed on the dev instance, 2026-07-21:

```text
http://www.ics.forth.gr/isl/CRMdig/          5230 types / 6457 predicate uses
http://iflastandards.info/ns/fr/frbr/frbroo/   12 types /    0 predicate uses
every migrated namespace                        0 types /    0 predicate uses
```

CRMdig is additionally hard-referenced by `CRMdig.java`, `crmdig.ts`,
`IIIFMetadataExtractor.java`, `config/ui.prop`, and the whole form-record
template family — a namespace move requires those to change in lockstep.
FRBRoo → LRMoo is a term *rename*, not a relocation, so a prefix rewrite alone
would leave dangling IRIs.

> **Policy status: DEFERRED, not abandoned.** This fork intends to converge on
> upstream's CRMdig and LRMoo namespaces eventually. The pin stays in place
> until every local extension that depends on CRMdig or FRBRoo has been cleared
> of that dependence — i.e. until no fork-local form, template, field
> definition, vocabulary or Java/TS constant reads or writes those namespaces
> outside of a single controlled mapping layer. Only then is a coordinated
> `rs-4.2.0-*` migration (data + code in lockstep) worth attempting.
>
> Concretely, lifting the pin requires all of:
>
> - `CRMdig.java`, `crmdig.ts`, `IIIFMetadataExtractor.java` migrated together
>   with the data
> - `config/ui.prop` `preferredThumbnails` patterns rewritten
>   (`crmdig:L60i_is_documented_by` / `crmdig:L11_had_output`)
> - the form-record template family (`FormEntityRecord.html`,
>   `FormMetadataTab.html`, `FormAssetSidebar.html`, `ActivityCardTemplate.html`,
>   `SystemActivityFrame.html`, `FormDefaultActions.html`) and the 12 provenance
>   KPs (`formRecord*`, `had_output_record`, `record_created_by`, `date`,
>   `was_attributed_to`, `file_identifier*`, `web_URL_embed*`) migrated together
> - FRBRoo → LRMoo handled as a *term* rename, not a prefix rewrite
>
> When that day comes: delete `03_pin_crmdig_artefacts.sparql`, move both rows
> out of `EXCLUDED` in `01_prefixes.py`, and add the FRBRoo term renames to
> `02_term_renames.sparql`.

## Order of operations

Steps 1–4 mirror upstream's procedure; only step 2 differs.

```bash
SPARQL=http://localhost:10214/blazegraph/sparql

# 0. Snapshot the journal. This is the only true rollback for data.
cp runtime-data/blazegraph.jnl runtime-data/blazegraph.pre-migration.jnl

# 0b. Baseline — record the output, you compare against it in step 5
#     (checks.sparql, queries P1 and T1)

# 1. Export
../4.1.0/export.sh <data_folder> <graphs_file>

# 2. Rewrite — local policy, upstream engine
./01_prefixes.py --show                       # review the mapping first
./01_prefixes.py -i <data_folder> -o <out_folder>

# 3. Load back
../4.1.0/import.sh <out_folder> <graphs_file>

# 4. Term renames + CRMdig pin enforcement
curl -u admin:admin "$SPARQL" --data-urlencode "update=$(cat 02_term_renames.sparql)"
curl -u admin:admin "$SPARQL" --data-urlencode "update=$(cat 03_pin_crmdig_artefacts.sparql)"

# 5. Verify — checks.sparql: P1 unchanged, M1 empty, T2 clean, C2 empty, C3 all bound
```

### Which steps re-run on a rebuild

- **Container restart, same journal** — nothing. `LDPAssetsLoader` skips reload
  for `authorities`/`configurations` when stored and loaded models differ
  (`LDPAssetsLoader.java:446-454`), so the rewrite survives.
- **Fresh journal, or a restored snapshot predating the crminf slice** — the six
  artefact graphs are empty and load pristine, so **step 4 (`03`) must run
  again**. Steps 1–3 only apply to a database that still holds pre-migration
  IRIs.

Note that nothing in the platform records which migrations have been applied —
there is no ledger in the Java. Consider writing a marker graph after step 5.

## Relationship to upstream 4.1.0

`dist/migrations/4.1.0/` is upstream's and is kept **byte-identical** to it.
The policy lives here instead, for one reason:

Encoding "do not migrate CRMdig" as the *absence* of a line in upstream's
`MAPPING` is fragile in a way that fails silently and destructively. Upstream
edits that exact block — commit `08daa7e51` (2025-06-05) added a row to
`MAPPING` inside an unrelated OSM-geo PR. A future merge that restores our two
deleted rows produces no conflict marker and no error; the next run just
rewrites ~5,230 CRMdig triples. An explicit `EXCLUDED` list in a file upstream
does not have cannot be un-deleted by a merge.

`01_prefixes.py` imports upstream's engine rather than copying it, so upstream
fixes to the file walker and replacement code reach us. Only the policy table
is local.

### Staying in sync with upstream

`01_prefixes.py` holds `REVIEWED_UPSTREAM_ROWS`, a snapshot of upstream's
`MAPPING` as of commit `08daa7e51`. If upstream adds a row we have not
classified, the script **refuses to run** and names the row. Classify it —
migrate or exclude — then update `REVIEWED_UPSTREAM_ROWS` (and `EXCLUDED` if
pinning). Do not silence this check by widening the snapshot without deciding.

## Files

| File | Role |
|---|---|
| `01_prefixes.py` | Namespace rewrite. Upstream engine, local policy + drift guard |
| `02_term_renames.sparql` | `S4_Observation`, `O21_has_found_at`, `J3_applies` renames |
| `03_pin_crmdig_artefacts.sparql` | Normalises preloaded artefacts back to pinned CRMdig |
| `checks.sparql` | Pre/post verification queries (P1, M1, T1/T2, C1/C2/C3) |
