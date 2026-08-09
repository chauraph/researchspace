# Deployment runbook — minimal CRM migration

End-to-end procedure: revert to the pre-migration state, migrate, verify.
Companion docs: [`README.md`](README.md) (policy), [`WORKLIST.md`](WORKLIST.md)
(findings per round), [`../../../docs/ldp-authoring/storage-layers.md`](../../../docs/ldp-authoring/storage-layers.md)
(override model).

**Mental model.** Three stores with different lifecycles:

- **Image** — rebuilt from git. Ships `default` / `system` / `help`.
- **Volume** — survives rebuilds. `runtime-data/config`, `runtime-data/apps/*`,
  `runtime-data/ldp/**`, the journal.
- **Database** — changed only by migration, never by a deploy.

With `forceLDPLoadFromStorages=runtime`, `runtime-data/ldp/**` **overwrites** its
graphs in the DB on every startup. Storage is the source of truth for those
graphs; the DB is downstream.

---

## Path map — dev tree vs deployment

Commands below are written against the **dev tree** layout. On the docker
deployment the same logical locations live elsewhere. Translate as you go, or
export these once and use the variables.

| logical | dev tree | deployment host (`basic/`) | in container |
|---|---|---|---|
| runtime storage | `runtime-data/` | `basic/researchspace/runtime-data/` | `/runtime-data` |
| plugin app | `runtime-data/apps/murten-app/` | `basic/murten-app/` | `/apps/murten-app` |
| Blazegraph journal | `runtime-data/blazegraph.jnl` | `basic/blazegraph/blazegraph.jnl` | `/blazegraph-data/…` |
| uploaded images | `runtime-data/images/` | `basic/researchspace/data/images/` | `/images` |
| migration scripts | `dist/migrations/` | — | `/migrations` |

```bash
# run once on the deployment host, from the compose directory
export RT=./researchspace/runtime-data
export APP=./murten-app
export JNL=./blazegraph
```

Two consequences worth noting:

- **The plugin app is NOT under runtime storage on the deployment.** In the dev
  tree it sits at `runtime-data/apps/…`; on the host it is a sibling directory
  mounted to `/apps/murten-app`. Backups and greps that walk `runtime-data/` will
  silently miss it — `$APP` must be included explicitly. This matters most in
  Phase 3, where the defective `crmdig` binding lives in `$APP/config/namespaces.prop`.
- **The journal is not under runtime-data in docker.** It lives in the Blazegraph
  container's own volume, `$JNL/`. Phase 1 and Phase 2 must target that path.
- The stock `basic/docker-compose.yml` ships **no `/apps` mount** — yours is a
  local addition. Confirm the mount line still exists after any compose update,
  or the plugin app silently stops loading and `default` takes over its templates
  and namespaces.

---

## Phase 0 — Preflight (before touching anything)

These four answers determine whether the rest of the runbook is valid on this
deployment. Do not proceed until all are known.

Set `$RT`, `$APP`, `$JNL` from the path map first. **Every check must cover both
`$RT` and `$APP`** — on the deployment the plugin app is outside runtime storage,
so a glob like `$RT/apps/*` expands to nothing and the check passes while
inspecting nothing.

```bash
# sanity: both trees must exist before any check is meaningful
ls -d $RT $APP $JNL || echo "PATHS WRONG — fix before continuing"

# 0.1  Is force mode on?  Is loadDefaultConfig set?
cat $RT/config/global.prop
#   expect: forceLDPLoadFromStorages=runtime   AND   loadDefaultConfig = 1
#   If forceLDPLoadFromStorages is absent → runtime LDP runs in NORMAL mode:
#     authorities/configurations silently keep the DB copy and `assets` can
#     throw "Inconsistent state". Stop and re-plan.
#   If loadDefaultConfig is 0 or absent → the four built-in repos are skipped
#     entirely and no image change lands. Stop and re-plan.
#   Note: global.prop merges per-key across layers — check $APP/config/global.prop too.
cat $APP/config/global.prop 2>/dev/null

# 0.2  Does any higher layer shadow what the image fixes?
#   Template overrides are EXPECTED (this deployment has 4). They are not a
#   problem per se — templates are first-match-wins whole-file, so an override
#   only matters if the image version changed. Inventory them, then check.
ls $RT/data/templates/ $APP/data/templates/ 2>/dev/null

#   For each override found, was the image counterpart touched by the migration?
#   (run this part in a checkout of the repo, not on the deployment host)
for f in $RT/data/templates/* $APP/data/templates/*; do
  [ -f "$f" ] || continue
  n=$(basename "$f")
  echo "$n : $(git log --oneline 097521243..HEAD -- \
      "src/main/resources/org/researchspace/apps/*/data/templates/$n" | wc -l) migration commits"
done
#   0 commits  → override is orthogonal, leave it
#   >0 commits → the override BLOCKS a fix you just merged. Reconcile or delete it.

#   Do any overrides carry the wrong CRMdig namespace, or stale namespaces?
grep -rl 'cidoc-crm.org/extensions/crmdig/' $RT/data/templates/ $APP/data/templates/ 2>/dev/null
grep -rlE 'cidoc-crm\.org/cidoc-crm/(CRMsci|CRMba|CRMarchaeo|influence)/|ics\.forth\.gr/isl/(CRMsci|CRMgeo|CRMinf)/' \
     $RT/data/templates/ $APP/data/templates/ 2>/dev/null
#   both expect NO output

#   LDP shadowing of the six crmdig artefacts
ls $RT/ldp/authorities/ | grep -i level_of_confidence
ls $RT/ldp/configurations/ \
  | grep -E 'data%2F(Argumentation|Belief|Inference_logic|Inference_making|Proposition_set)\.trig$'
#   expect no output from the last two
#   also check the plugin app, which may ship its own ldp/
ls $APP/ldp/ 2>/dev/null

# 0.3  Wrong-namespace CRMdig anywhere on the volume — BOTH trees
grep -rl 'extensions/crmdig' $RT $APP 2>/dev/null
#   expect only $APP/config/namespaces.prop  ← that one is Phase 3

# 0.4  Effective prefix bindings across layers
grep -h '^crmdig\|^frbroo\|^lrmoo' $RT/config/namespaces.prop \
                                   $APP/config/namespaces.prop 2>/dev/null
#   crmdig MUST be http://www.ics.forth.gr/isl/CRMdig/   ← see Phase 3

# 0.5  Is the /apps mount still present?  (stock compose has none — yours is local)
grep -n '/apps' docker-compose.yml
#   no match → the plugin app is NOT loading; `default` silently supplies its
#   templates and namespaces. Restore the mount before proceeding.
```

Also confirm `config/repositories/assets.ttl` still proxies to `default`
(`proxy:proxiedID "default"`). Repository `.ttl` is first-match-wins **whole
file** — a higher layer replaces it entirely, it does not merge.

---

## Phase 1 — Stop and back up

```bash
docker compose stop researchspace blazegraph     # deployment
STAMP=$(date +%Y%m%d_%H%M)

cp    $JNL/blazegraph.jnl  $JNL/blazegraph.rollback-$STAMP.jnl
cp -r $RT/ldp              $RT/ldp.rollback-$STAMP
cp -r $RT/config           $RT/config.rollback-$STAMP
cp -r $APP                 ${APP}.rollback-$STAMP      # ← plugin app is OUTSIDE runtime-data
```

The journal copy is the only true rollback for data. Everything else is files.

⚠️ Do not skip the `$APP` copy. On the deployment the plugin app is a sibling of
`runtime-data`, not inside it, so a backup of `$RT` alone leaves it unprotected —
and Phase 3 edits it.

---

## Phase 2 — Revert to the pre-migration state

Revert the **database and LDP storage together**. They were consistent at that
point; reverting one without the other creates a split that force-load will
resolve in a direction you did not choose.

```bash
cp <pre-migration>.jnl $JNL/blazegraph.jnl

rm -rf $RT/ldp
cp -r  <ldp-snapshot>/ $RT/ldp
ls $RT/ldp/*   # expect assets 70 · authorities 27 · configurations 32
```

---

## Phase 3 — Fix the config inconsistency

The plugin app's `namespaces.prop` binds `crmdig` to the **new** namespace,
contradicting the pinned data (1503 lines across 102 LDP files, 11,687 DB
triples) and the code constants (`CRMdig.java`, `crmdig.ts`). Nothing in the
runtime layer re-pins it, so it is the **effective value**.

**This is not cosmetic.** 60 references resolve through this one binding:

| consumer | prefixed `crmdig:` refs |
|---|---:|
| `runtime/config/ui.prop` (`preferredThumbnails`) | 29 |
| `ResourceContent.html` override | 18 |
| `Start.html` override | 9 |
| `IIIFConfig.html` override | 4 |
| **total** | **60** |

`ResourceContent.html` mixes both forms — 2 full IRIs at `isl/` plus 18 prefixed —
so a wrong binding makes a single file query two namespaces at once.

```bash
sed -i.bak 's|^crmdig *= *http://www.cidoc-crm.org/extensions/crmdig/|crmdig = http://www.ics.forth.gr/isl/CRMdig/|' \
  $APP/config/namespaces.prop

# verify the binding across BOTH layers
grep -h '^crmdig' $RT/config/namespaces.prop $APP/config/namespaces.prop 2>/dev/null
#   expect ONLY: crmdig = http://www.ics.forth.gr/isl/CRMdig/

# verify nothing else still declares the new namespace — note BOTH trees
grep -rn 'crmdig *= *http://www.cidoc-crm.org/extensions/crmdig/' $RT $APP 2>/dev/null
#   expect NO output
```

After Phase 9, confirm it took: a thumbnail should render on any resource with an
image (`preferredThumbnails` traverses `crmdig:L60i_is_documented_by/crmdig:L11_had_output`).
A blank thumbnail across the board is the signature of this binding being wrong.

---

## Phase 4 — Baseline

Record the output; you compare against it in Phase 10.

Run `checks.sparql` **P1** (pinned data intact) and **T1** (renamed terms).

T1 is the one genuine unknown: dev had zero, but production may hold image
annotations typed `S4_Observation`. **If T1 is non-zero, restore
`02_term_renames.sparql` from git and add it after Phase 9.**

---

## Phase 5 — Storage edits (only if taking the frbroo option)

Under force mode, editing these files *is* the migration for their graphs — no
SPARQL needed. See `WORKLIST.md` Round 1 for the open decision.

```bash
D=runtime-data/ldp
grep -rl 'fr/frbr/frbroo/' $D    # expect 5 files
# if migrating: rewrite those 5 references to http://iflastandards.info/ns/lrm/lrmoo/
```

Leave `crmdig` alone — 102 files / 1503 lines, all correctly at `isl/CRMdig/`.

---

## Phase 6 — Wipe the asset mirror copies

`ldp/assets/*` are mirrors of DB content (doc Phase 3.4). `authorities/` and
`configurations/` are **not** — they hold app-modified content that exists
nowhere else. Do not touch those.

```bash
cp -r $RT/ldp/assets $RT/ldp/assets_backup_$(date +%Y%m%d_%H%M)
rm -f $RT/ldp/assets/*.trig
```

Note: these do not "regenerate from the DB" automatically. Force-load flows
storage → DB, never the reverse. Files reappear only as resources are saved
through the UI.

---

## Phase 7 — Drop stale DB graphs (server still stopped)

Mandatory. Without this the `ontologies` repo is skipped entirely
(`LDPAssetsLoader.java:196-206` — skipped whenever any `owl:Ontology` exists) and
your new ontology files never load.

⚠️ The old doc's Phase 3.2 **cannot work**: it drops 6 ontology graphs, but all
19 shipped files declare `a owl:Ontology`, so the guard stays true. Use the
script here, which drops all 26.

```bash
# 1. INVENTORY FIRST — what are you about to remove?
./checks.sh pre7          # G1 count · G2 by family · G3 largest 15 · O1 guard
```

`G3` is the safety gate. Auto-KP graphs are uniformly ~25 triples; ontology
contexts are 100–330. **Anything else large is hand-authored content that will
not come back** — inspect before proceeding.

```bash
# 2. DROP
curl -sS "$SPARQL" --data-urlencode "update=$(cat 07_drop_stale_graphs.sparql)"

# 3. GATE — all three must pass before restart
./checks.sh phase7        # O1 false · O2 empty · G1 zero
```

🔴 **If `O1` is still true, `O2` names the survivor — do not just drop it.**
An ontology added through the platform UI exists *only* in the database
(ontologies are absent from `repositoriesLDPSave`, which is `[assets]`). Dropping
one is permanent and silent. Export it, turn it into a `.trig` under
`ldp/ontologies/`, ship it, *then* drop:

```bash
G='<the IRI O2 reported>'
curl -s -H 'Accept: text/turtle' "$SPARQL" \
  --data-urlencode "query=CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <$G> { ?s ?p ?o } }" \
  > rescued.ttl
```

Wrap it as `<$G> { … }` in a **`.trig`** — the loader accepts only
`.trig`/`.nq`/`.trix` and **silently skips `.ttl`** with no log line
(`LDPAssetsLoader.java:309-313`). A Protégé export dropped in as-is does nothing.

Encountered live: `https://w3id.org/dsanno/ontology/socio-spatiotemporal#/context`,
11 triples, defining the class the Geosociopolitical form depends on.

---

## Phase 8 — Instance-data migration

```bash
dist/migrations/4.1.0/export.sh <data_folder> <graphs_file>
dist/migrations/rs-4.1.0-minimal/01_prefixes.py --show          # review first
dist/migrations/rs-4.1.0-minimal/01_prefixes.py -i <data_folder> -o <out_folder>
dist/migrations/4.1.0/import.sh <out_folder> <graphs_file>
```

⚠️ Run `01_prefixes.py`, **never** `4.1.0/replace_prefixes.py` — the latter is
upstream's unmodified script and migrates CRMdig and FRBRoo.

The wrapper refuses to run if upstream's `MAPPING` has gained a row it has not
classified. That is deliberate — classify the row, don't bypass it.

---

## Phase 9 — Start the new image

```bash
git pull origin develop     # → build image → deploy
```

On boot, expect:
- `ontologies` loads (graphs now empty from Phase 7)
- `Reload system KP that changed:` for the two `S27_Observation` KPs
- `Do not reload authority document as it's been changed by application` — normal
- runtime LDP force-loads over its graphs
- **no** `Inconsistent state of the LDP assets storage`

Then:

```bash
curl -u <user>:<pass> "$SPARQL" \
  --data-urlencode "update=$(cat dist/migrations/rs-4.1.0-minimal/03_pin_crmdig_artefacts.sparql)"
```

This normalises the six preloaded artefacts that ship with upstream's CRMdig
namespace. **It must re-run after every provisioning from a snapshot that
predates the crminf slice** — those graphs load empty and pristine each time.

---

## Phase 10 — Verify

| check | expectation |
|---|---|
| `checks.sh` P1 | **must not DECREASE.** A rise equal to what `03` normalised is expected; `frbroo` unchanged |
| `checks.sh` M1 | empty — no stale migrating namespaces |
| `checks.sh` C2 | empty — no `extensions/crmdig` left |
| `checks.sh` C3 | every `?creation` bound |
| `checks.sh` T2 | only `*_CORRECT` rows non-zero (if T1 was non-zero) |

Then two UI checks that no query can cover:

1. **Thumbnails render.** `preferredThumbnails` traverses
   `crmdig:L60i_is_documented_by/crmdig:L11_had_output`. Blank thumbnails
   everywhere = the Phase 3 binding is still wrong.
2. **Create one image annotation.** The `classtype` should be written as
   `http://www.cidoc-crm.org/extensions/crmsci/S4_Single_Observation`. The
   workspace template was adopted wholesale from upstream and has moved since
   4.0.0, so rendering needs eyes on it.

---

## Rollback

| after phase | action |
|---|---|
| 2–7 | restore `blazegraph.jnl`, `ldp/`, `config/` from the Phase 1 copies |
| 8 | same — the export/import is not in-place, the journal copy is intact |
| 9–10 | restore journal + volume copies, redeploy the previous image |

Source-side rollback is `git revert` on develop; the migration commits are
`e76a0e4e4` (revert) and `c64fd81f2` (merge).

---

## Known gaps

- Nothing records which migration ran. There is no ledger anywhere in the Java.
  Consider writing a marker graph after Phase 10 — ~5 triples, and the only thing
  that makes this procedure safe to hand to someone else.
- `ontodia-entity-metadata.html` and `OntologyPropertiesSearch.html` still carry
  pre-migration IRIs, deliberately. They reference classes (`SO30_Influence`,
  `EO2_Event_Pattern`, `SP5_Geometric_Place_Expression`) absent from the shipped
  ontologies under any name, so those features are already broken and a namespace
  fix would not restore them.
- **Redundant template override.** `KnowledgeMapOntodiaConfig.html` in the plugin
  app is byte-identical to the image version. It overrides nothing but pins that
  template forever — future image changes to it will silently never apply.
  Unrelated to this migration; worth deleting from the app layer at some point.
- **`ResourceContent.html` exists in three versions** — image (git), runtime
  override (206 lines different), and an uncommitted dev-worktree edit. The dev
  edit cannot take effect on any deployment carrying the runtime override.
  Decide which is canonical before investing in the third.
