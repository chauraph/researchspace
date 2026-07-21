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
```
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
```
crmdig = http://www.cidoc-crm.org/extensions/crmdig/     ← wrong
```
Only line differing from the dev volume copy, which has `isl/CRMdig/`.
Nothing in the runtime layer re-pins it, so this is the **effective value**.

Three-way split it creates: config says `extensions/`, data says `isl/`
(1503 lines / 102 LDP files + 11,687 DB triples), code says `isl/`
(`CRMdig.java`, `crmdig.ts`).

### Templates — 4 overrides, all shadowing image templates

```
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
```

---

## Carried over from the merge work

- [ ] `git rm dist/migrations/rs-4.1.0-minimal/02_term_renames.sparql`; point README step 4 at doc Phase 3.3
- [ ] Retire or rebase `feature/crm-migration-remaining` (sits on the reverted merge `f9750a2a5`)
- [ ] Production volume inventory before image rebuild — shadow copies in `runtime-data/`
- [ ] `checks.sparql` P1 + T1 against the restored production snapshot
- [ ] Uncommitted WIP breaks karma: `TypeError: Cannot read properties of undefined (reading 'data')` — unrelated to migration
