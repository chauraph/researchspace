# rs-2026-08 — August 2026 migration wave

Multi-task data migration wave, following the `rs-4.1.0-minimal` conventions:
task-prefixed `.sparql` steps (`tNN_M_*.sparql`, usage in each header), one
shared `checks.sh` (checks are task-scoped, `SPARQL`/`RS_USER`/`RS_PASS` from
the environment), and `RUNBOOK.md` holding the per-task procedures.

Unlike the version-named migrations (`4.1.0`, `rs-4.1.0-minimal`), this wave is
not tied to a platform upgrade — it is a batch of fork-local data migrations
run against dev first, then prod.

## Task ledger

| task | what | scripts | status |
|---|---|---|---|
| **t01** | `owl:sameAs` retired → `la:equivalent` (store sweep; code + rs-ldp SOT migrated separately) | `t01_1_inventory`, `t01_2_sweep_data_graphs`, checks `I1 E1 A1 K1` | **dev DONE 2026-08-13; prod pending** |
| **t02** | server-side SAM tool retired; `sam_` → `samlocal_` shape prefix in stored ImageRegion SVG (code excise + proxy decommission tracked separately) | `t02_1_inventory`, `t02_2_dryrun`, `t02_3_rewrite`, checks `S1 S2 S3` | **dev DONE 2026-08-25; prod pending** |

Adding a task: define it here, add `tNN_M_*.sparql` steps (header comment states
purpose, ordering constraints, idempotency, usage curl line), add its checks to
`checks.sh` with task-prefixed IDs, and write its procedure as a section in
`RUNBOOK.md`.

## Wave-wide rules

- **Back up the Blazegraph journal before the first write of the wave** on each
  instance (dev precedent: `runtime-data/blazegraph-pre-migrate-owl-to-la.jnl`).
- **Files before SPARQL.** `forceLDPLoadFromStorages = runtime` clears and
  reloads file-backed graphs from `runtime-data/ldp/**` on every startup — a
  SPARQL rewrite of those graphs is reverted at the next boot. File-backed
  graphs migrate via rs-ldp + `deploy.sh` + restart; SPARQL steps here touch
  only graphs force-load never sees.
- **Allowlists, not blocklists.** Every destructive update scopes itself with
  `VALUES ?g { … }` built from a fresh inventory — never `FILTER(?g != …)`.
- **Verify per instance, per task**: `./checks.sh verify` (or a task's own
  check IDs) after each task, on the instance it ran against.
