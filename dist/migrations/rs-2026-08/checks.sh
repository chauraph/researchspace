#!/usr/bin/env bash
# checks.sh — runnable verification for the rs-2026-08 migration wave.
# Check IDs are task-scoped; see README.md for the task ledger.
#
#   ./checks.sh list              show all checks
#   ./checks.sh show I1           print a query without running it
#   ./checks.sh I1                run one check
#   ./checks.sh t01               run task 01's set (I1 E1 A1 K1 — sameAs→equivalent)
#   ./checks.sh verify            run every task's checks
#
# Endpoint and credentials come from the environment:
#   SPARQL   default http://127.0.0.1:10214/sparql   (prod: :10215/blazegraph/sparql)
#   RS_USER  default admin
#   RS_PASS  default admin
set -uo pipefail

SPARQL="${SPARQL:-http://127.0.0.1:10214/sparql}"
RS_USER="${RS_USER:-admin}"
RS_PASS="${RS_PASS:-admin}"

# ─────────────────────────────────────────────────────────────────────────────
q_I1() { cat <<'EOF'
# I1 — RESIDUE INVENTORY. Must return ZERO rows after the sweep. Any row is
#      either a missed deploy (file-backed graph) or a missed allowlist entry.
PREFIX owl: <http://www.w3.org/2002/07/owl#>
SELECT ?g (COUNT(*) AS ?n)
WHERE { GRAPH ?g { ?s owl:sameAs ?o } }
GROUP BY ?g ORDER BY DESC(?n)
EOF
}

q_E1() { cat <<'EOF'
# E1 — REWRITTEN TRIPLES ARRIVED, by graph. Dev expectation 2026-08-13:
#      person 62, geopolitical_unit 61, g/data 30, place small.
SELECT ?g (COUNT(*) AS ?n)
WHERE { GRAPH ?g { ?s <https://linked.art/ns/terms/equivalent> ?o } }
GROUP BY ?g ORDER BY DESC(?n)
EOF
}

q_A1() { cat <<'EOF'
# A1 — PREMISE CHECK: no owl:sameAs-backed adjudication acts. Must be 0
#      (was 0 before the sweep by construction; the sweep never edits J32).
PREFIX owl: <http://www.w3.org/2002/07/owl#>
SELECT (COUNT(*) AS ?acts) WHERE {
  ?d29 <http://www.cidoc-crm.org/extensions/crminf/J32_has_property_type> owl:sameAs }
EOF
}

q_K1() { cat <<'EOF'
# K1 — KNOWLEDGE PATTERN PRESENT. The la:equivalent field must exist or the
#      Equivalent form input renders dead (see RUNBOOK: ontology import +
#      POST /rest/kp/generateKps if this returns no rows).
PREFIX field: <http://www.researchspace.org/resource/system/fields/>
PREFIX sp: <http://spinrdf.org/sp#>
SELECT ?text WHERE {
  <https://linked.art/ns/terms/equivalent> a field:Field ;
    field:insertPattern/sp:text ?text }
EOF
}

q_S1() { cat <<'EOF'
# S1 — RESIDUE INVENTORY (task 02). Must return ZERO rows after the rewrite.
#      Any row is a region the allowlist missed, or one drawn by the removed
#      server tool after the rewrite ran (proxy still wired? see RUNBOOK t02).
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?s WHERE {
  GRAPH ?g { ?s rdf:value ?v . FILTER(CONTAINS(STR(?v), 'id="sam_')) } }
ORDER BY ?s
EOF
}

q_S2() { cat <<'EOF'
# S2 — REWRITE PRE/POST ASSERTION. Before t02_3 this is the dry-run aggregate;
#      after it every column must be 0. The three bad_* columns must be 0 in
#      BOTH states — they assert the rewrite is lossless, not that it has run.
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT (COUNT(*) AS ?regionsAffected)
       (SUM((STRLEN(STR(?new)) - STRLEN(STR(?old))) / 5) AS ?pathIdsRewritten)
       (SUM(IF(CONTAINS(STR(?new), 'id="sam_'), 1, 0)) AS ?bad_leftoverPrefix)
       (SUM(IF(STR(?new) = STR(?old), 1, 0)) AS ?bad_noChange)
       (SUM(IF(DATATYPE(?new) != DATATYPE(?old), 1, 0)) AS ?bad_datatypeChanged)
WHERE {
  GRAPH ?g { ?s rdf:value ?old . FILTER(CONTAINS(STR(?old), 'id="sam_')) }
  BIND(STRDT(REPLACE(STR(?old), 'id="sam_', 'id="samlocal_'), xsd:string) AS ?new) }
EOF
}

q_S3() { cat <<'EOF'
# S3 — TOOL CENSUS. Totals must be conserved across the rewrite: every
#      sam-server region becomes a samlocal one, nothing else moves.
#      Dev 2026-08-25: before 23/25/32, after 0/48/32 (80 throughout).
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?tool (COUNT(*) AS ?n) WHERE {
  GRAPH ?g { ?s rdf:value ?v . FILTER(isLiteral(?v) && CONTAINS(STR(?v), "<svg")) }
  BIND(IF(CONTAINS(STR(?v), 'id="samlocal_'), "samlocal",
       IF(CONTAINS(STR(?v), 'id="sam_'),      "sam-server", "other")) AS ?tool) }
GROUP BY ?tool ORDER BY DESC(?n)
EOF
}

T01="I1 E1 A1 K1"          # task 01: owl:sameAs → la:equivalent
T02="S1 S2 S3"              # task 02: server SAM retired, sam_ → samlocal_
ALL="$T01 $T02"             # extend as tasks are added

run_one() {
  local id="$1"
  echo "── $id ─────────────────────────────────────────────"
  "q_$id" | grep '^#' | sed 's/^# \{0,1\}//'
  curl -s -u "$RS_USER:$RS_PASS" -H "Accept: text/csv" "$SPARQL" \
       --data-urlencode "query=$("q_$id" | grep -v '^#')"
  echo
}

case "${1:-verify}" in
  list)   for c in $ALL; do "q_$c" | head -2 | sed 's/^# \{0,1\}//'; done ;;
  show)   "q_$2" ;;
  t01)    for c in $T01; do run_one "$c"; done ;;
  t02)    for c in $T02; do run_one "$c"; done ;;
  verify) for c in $ALL; do run_one "$c"; done ;;
  *)      run_one "$1" ;;
esac
