# Migration worklist

Running record of what has been inspected, decided, and still open. One section
per review round. Keep append-only — supersede entries rather than deleting, so
the reasoning stays legible.

---

## Round 1 — `temp/ldp_pre-crm-migration` (runtime LDP snapshot, 129 files)

Source: clone of runtime LDP storage taken before migration.
`assets` 70 · `authorities` 27 · `configurations` 32.

### Findings

| signal | result | meaning |
|---|---|---|
| migrating namespaces (CRMsci, CRMgeo, CRMinf, CRMba, CRMarchaeo, influence) | **0 files** | `01_prefixes.py` is a **no-op** on runtime LDP data |
| `isl/CRMdig/` | **102 files, 1503 non-prefix lines** | pin is correct here; also the strongest evidence *for* pinning |
| `extensions/crmdig/` | **0 files** | no contamination in runtime storage |
| `fr/frbr/frbroo/` | 5 lines / 5 files | `F2_Expression` ×4, `F33_Reproduction_Event` ×1 |
| `lrm/lrmoo/` | 326 lines / 9 files | F1_Work ×67, F2_Expression ×62, R3i_realises ×60, R3_is_realised_in ×60, R10_is_member_of ×56 |
| dead terms (S4_Observation, O21_has_found_at, O19i_…, J3_applies, SO30/SO31, EO2) | **0** | `02_term_renames.sparql` unnecessary here |

### Decisions

- **CRMdig — keep pinned.** 1503 lines across 102 runtime files at `isl/CRMdig/`,
  zero at `extensions/`. Consistent with the code layer. No action.
- **Migrating namespaces — no action.** Absent from runtime data entirely; they
  only ever lived in ontologies and system KPs.
- **Dead terms — no action.** None present.

### Open — needs a decision

- ⚠️ **`F2_Expression` is split across both namespaces in the same dataset:**
  4 files use `frbroo:F2_Expression`, 3 files use `lrmoo:F2_Expression`.
  This is a **pre-existing inconsistency**, not something the migration caused.
  The frbroo pin was justified by a DB census (~12 instances); in runtime storage
  the ratio is inverted — 5 frbroo references against 326 lrmoo. Migrating the 5
  stragglers would *repair* the split rather than create one, unlike CRMdig.
  Affected files:
  - `configurations/…Knowledge_map.trig` — `frbroo:F2_Expression`
  - `configurations/…Reproduction_Event.trig` — `frbroo:F33_Reproduction_Event`
  - `assets/…Visual_origin_from_illustrated_chronicle.trig`
  - `assets/…Analysis.trig`
  - `assets/…Visual_Narrative_Analysis_-_Traveling_women…trig`

  Options: (a) migrate the 5 to lrmoo and drop the frbroo pin for runtime data;
  (b) leave split, accept two classes meaning the same thing;
  (c) migrate and keep the pin only for CRMdig — reword README accordingly.

---

### ⚠️ Storage model finding that reframes this audit

`runtime-data/config/global.prop` sets:
```text
loadDefaultConfig = 1
forceLDPLoadFromStorages = runtime
```

Under FORCE mode (`LDPAssetsLoader.java:338-349`) the loader does
`conn.clear(contexts)` then `conn.add(model)` for every graph present in runtime
storage — **no comparison, no consistency check, storage wins on every startup.**

Consequences for this migration:

1. `runtime-data/ldp/**` is the **source of truth** for its graphs. Migrating the
   database without migrating these files means the next boot reverts them.
2. Conversely, fixing these files is **sufficient** — force-load carries the change
   into the DB with no SPARQL update needed.
3. This is why the snapshot audit matters more than the DB census: the DB is
   downstream of these files.

Full reference: [`docs/researchspace-storage-layers.md`](../../../docs/researchspace-storage-layers.md)

---

## Round 2 — config + templates (`temp/runtime`, `temp/app`)

### Config comparison

`.prop` files merge **per-key** across layers; `runtime` (1) outranks plugin apps (3).
The two config sets are complementary — **no key is defined in both**.

| file | runtime | app |
|---|---|---|
| `namespaces.prop` | 1 key (`wdt`) | 32 keys |
| `ui.prop` | `preferredThumbnails` | `deploymentTitle` |
| `global.prop` | `forceLDPLoadFromStorages`, `loadDefaultConfig` | *empty* |
| `environment.prop` | `shiroAuthenticationFilter` | `platformBaseIri` |
| `shiro.ini` | present | `.sample` only |
| `repositories/` | `iiif-canvas-extraction.ttl`, `tests.ttl` | — |
| `page-layout/login.hbs` | — | present |

All other CRM bindings are correct: `frbroo` old (pinned), `lrmoo` added alongside,
`crmarchaeo`/`crmba`/`crmgeo`/`crmsci`/`crminf`/`crminfluence` all `…/extensions/…`,
zero stale migrating namespaces anywhere in either tree.

### ⚠️ The one defect — `crmdig` bound to the new namespace

`temp/app/config/namespaces.prop:21`
```text
crmdig = http://www.cidoc-crm.org/extensions/crmdig/     ← wrong
```
Only line differing from the dev volume copy, which has `isl/CRMdig/`.
Nothing in the runtime layer re-pins it, so this is the **effective value**.

Three-way split it creates: config says `extensions/`, data says `isl/`
(1503 lines / 102 LDP files + 11,687 DB triples), code says `isl/`
(`CRMdig.java`, `crmdig.ts`).

### Templates — 4 overrides, all shadowing image templates

```text
temp/runtime/template/   ResourceContent.html · Start.html
temp/app/templates/      IIIFConfig.html · KnowledgeMapOntodiaConfig.html
```
No runtime/app collision. Templates are first-match-wins **whole file**.

| template | `isl/CRMdig` | `extensions/crmdig` | stale ns | `crmdig:` prefixed | diff vs image |
|---|---:|---:|---:|---:|---:|
| `ResourceContent.html` | 2 | 0 | 0 | 18 | 206 lines |
| `Start.html` | 0 | 0 | 0 | 9 | 522 lines |
| `IIIFConfig.html` | 0 | 0 | 0 | 4 | 18 lines |
| `KnowledgeMapOntodiaConfig.html` | 5 | 0 | 0 | 0 | **0 lines** |

Content is CRM-clean. **None of the four image counterparts was touched by the
migration commits** (0 commits each in `097521243..HEAD`), so these overrides do
not block any merged fix.

### Decisions

- **Templates need no content migration.** No stale namespaces, no new-namespace CRMdig.
- **Blast radius of the `crmdig` config defect is larger than it first looked:**
  31 prefixed refs in templates + 29 in `runtime/ui.prop` = **60 references** that
  resolve through `namespaces.prop`. `ResourceContent.html` mixes both forms
  (2 full IRIs at `isl/` + 18 prefixed), so a wrong binding makes one file query
  two namespaces. → RUNBOOK Phase 3 is load-bearing; verification step added.

### Open — low severity

- `KnowledgeMapOntodiaConfig.html` is **byte-identical to the image version**.
  It overrides nothing but pins that template forever — future image changes to it
  will silently never apply. Candidate for removal from the app layer.
- `ResourceContent.html` exists in **three** versions: image (git), runtime override
  (206 lines different), and uncommitted in the dev worktree. The dev edit can never
  take effect while the runtime override exists. Decide which is canonical.

---

## Round 3 — execution on the deployment (COMPLETE ✅)

Ran the runbook against the remote instance (`:10215`). Outcome: **migration
verified**. Phases 5 and 8 turned out to be unnecessary; everything else applied.

### Baseline (Phase 4)

```text
P1   crmdig  type 5279 · predicate 5479      frbroo  type 4
T1   0 rows  → 02_term_renames.sparql confirmed unnecessary on production
```

`T1` returning zero was the last real unknown — dev had no image annotations, so
it proved nothing about production. Production is clean too. `02` stays deleted.

### Phase 7 — 198 graphs dropped

`G2`/`G3` breakdown before dropping:

| content | count | size |
|---|---|---|
| ontology context graphs | 6 | 100–326 triples each (~1282 total) |
| auto-KP context graphs | 192 | uniformly 25–26 triples |

Distribution was exactly "6 ontologies + flat KP tail" — no outlier hiding
hand-authored content. `G3` is the check that would have caught one.

Families: crmsci 49 · crmgeo 41 · crmarchaeo 39 · influence 39 · crmba 16 ·
crminf 14. No `isl/CRMsci/` row — that graph never existed, which is the one the
old doc's `DROP GRAPH` loop would have errored on for lack of `SILENT`.

### ⚠️ Discovery — a UI-created ontology that existed only in the database

After the drop, `O1` was still true. `O2` found one survivor:

```text
https://w3id.org/dsanno/ontology/socio-spatiotemporal#/context   11 triples
```

Created 2025-05-10 by `admin` **through the platform UI**. No source file
anywhere; absent from LDP storage (ontologies are not in `repositoriesLDPSave`,
which is `[assets]`); absent from the LDP snapshot. It defines
`DSAPS1_Geosociopolitical_Unit` (`subClassOf crm:E74_Group`), used by the
in-progress `GeosociopoliticalUnit` form.

**Dropping it would have been permanent and silent.** Rescued as
`ldp/ontologies/dsanno-socio-spatiotemporal.trig` (commit `f4e41f563`), then
dropped, then reloaded from the image.

> **Generalise this.** Any ontology added through the UI lives only in the DB and
> dies at the next Phase 7. `O2` *before* dropping is the inventory step that
> catches them. This one was found by luck — the guard stayed true and forced a
> look.

Also noted: the loader accepts only `.trig` / `.nq` / `.trix`
(`LDPAssetsLoader.java:309-313`) and **silently skips `.ttl`** with no log line.
A Protégé export dropped into `ldp/ontologies/` does nothing at all.

### Verification (Phase 10)

```text
M1   0 rows                                  no stale migrating namespaces
T2   0 rows                                  no renamed-term data
C1   0 rows / C2 0 rows                      no extensions/crmdig anywhere
C3   5 rows, every ?creation bound           03 worked
P1   crmdig type 5284 (+5) · predicate 5485 (+6) · frbroo 4 (unchanged)
```

**The P1 rise is correct, not drift.** `03` moves artefact triples *into*
`isl/CRMdig/`, so the count must go up by exactly what it normalised; `C1 → 0`
confirms none are left on the other side. The invariant is **"must not
decrease"** — a fall would mean pinned data was lost. `checks.sh` P1 header has
been corrected accordingly (it previously said "must be identical").

UI checks passed: thumbnails render (proves the `crmdig` prefix binding), new
image annotation writes `S4_Single_Observation`.

### Audit of `docs/crm-minimal-migration.md` — 11 flaws

Four fail **silently**:

| line | flaw | effect |
|---|---|---|
| 428 | `-u admin:im` | Phase 3.3 auto-KP drop returns 401; `-s` hides it — the drop never runs |
| 553 | `-u admin:int` | Phase 4.3 pinned-data check same |
| 458 | `cidoc_crm.org` (underscore) | verification never counts influence graphs → **false pass** |
| 133, 423, 538, 562 | `ns/fr/frbroo/` missing `frbr/` | FRBRoo instance count always 0 → would argue *against* the pin |

Structural:

- **Phase 3.2 cannot work.** Drops 7 ontology graphs; all 19 files declare
  `a owl:Ontology`, so the guard stays true and the new extension ontologies
  never load. Superseded by `07_drop_stale_graphs.sparql` (26 graphs).
- Line 419 `DROP GRAPH` without `SILENT` — errors on a non-existent graph.
- **Phase 3.5 `forceLDPLoadFromStorages=default` is risky.** With force on both
  `default` and `runtime`, storage batches iterate in HashMap order
  (`LDPAssetsLoader.java:131`) — for the 29 shared authority/configuration
  graphs, whichever runs last wins, non-deterministically.
- Line 480 greps `forceLDPLoad_fromStorages` (underscore) — never matches.
- Phase 3.4 backs up into `ldp/`; correct depth, but a pre-existing target gives
  `ldp/backup/assets/*.trig` → grandparent ≠ `ldp` → **startup aborts**.
- Phase 3.6's reasoning is wrong (FORCE bypasses `selectContentToLoad`
  entirely); the `CLEAR` itself is fine.
- Line 70 `--name-ly` typo.

`RUNBOOK.md` supersedes that document for deployment.

---

## Standing checks (run every round)

```bash
D=<snapshot dir>
# stale migrating namespaces — expect 0
grep -rl -e 'cidoc-crm.org/cidoc-crm/CRMsci/' -e 'ics.forth.gr/isl/CRMsci/' \
  -e 'ics.forth.gr/isl/CRMgeo/' -e 'ics.forth.gr/isl/CRMinf/' \
  -e 'cidoc-crm.org/cidoc-crm/CRMba/' -e 'cidoc-crm.org/cidoc-crm/CRMarchaeo/' \
  -e 'cidoc-crm.org/cidoc-crm/influence/' "$D" | wc -l

# CRMdig pin — expect >0 at isl, 0 at extensions
grep -rl 'ics.forth.gr/isl/CRMdig/'      "$D" | wc -l
grep -rl 'cidoc-crm.org/extensions/crmdig/' "$D" | wc -l

# frbroo / lrmoo split
grep -rl 'fr/frbr/frbroo/' "$D" | wc -l
grep -rl 'lrm/lrmoo/'      "$D" | wc -l

# dead terms — expect none
grep -rlE 'S4_Observation|O21_has_found_at|O19i_was_object_found_by|J3_applies|SO3[01]_|EO2_Event_Pattern' "$D"
```text

---

## Carried over from the merge work

- [ ] `git rm dist/migrations/rs-4.1.0-minimal/02_term_renames.sparql`; point README step 4 at doc Phase 3.3
- [ ] Retire or rebase `feature/crm-migration-remaining` (sits on the reverted merge `f9750a2a5`)
- [ ] Production volume inventory before image rebuild — shadow copies in `runtime-data/`
- [ ] `checks.sparql` P1 + T1 against the restored production snapshot
- [ ] Uncommitted WIP breaks karma: `TypeError: Cannot read properties of undefined (reading 'data')` — unrelated to migration
