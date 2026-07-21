#!/usr/bin/env bash
# checks.sh — runnable verification queries for the minimal CRM migration.
#
#   ./checks.sh list              show all checks
#   ./checks.sh show P1           print a query without running it
#   ./checks.sh P1                run one check
#   ./checks.sh baseline          run the Phase 4 set  (P1 T1)
#   ./checks.sh verify            run the Phase 10 set (P1 M1 T2 C2 C3)
#
# Endpoint and credentials come from the environment:
#   SPARQL   default http://localhost:10214/blazegraph/sparql
#   RS_USER  default admin
#   RS_PASS  default admin
#
# Example:
#   SPARQL=http://localhost:10214/blazegraph/sparql RS_PASS=secret ./checks.sh baseline
set -uo pipefail

SPARQL="${SPARQL:-http://localhost:10214/blazegraph/sparql}"
RS_USER="${RS_USER:-admin}"
RS_PASS="${RS_PASS:-admin}"

# ─────────────────────────────────────────────────────────────────────────────
q_P1() { cat <<'EOF'
# P1 — PINNED DATA INTACT. Run before and after; counts must be identical.
SELECT ?ns ?position (COUNT(*) AS ?n) WHERE {
  { ?s a ?t . BIND(REPLACE(STR(?t), "^(.*[/#])[^/#]*$", "$1") AS ?ns) BIND("type" AS ?position) }
  UNION
  { ?s ?p ?o . BIND(REPLACE(STR(?p), "^(.*[/#])[^/#]*$", "$1") AS ?ns) BIND("predicate" AS ?position) }
  FILTER(?ns IN ("http://www.ics.forth.gr/isl/CRMdig/",
                 "http://iflastandards.info/ns/fr/frbr/frbroo/"))
} GROUP BY ?ns ?position ORDER BY ?ns ?position
EOF
}

q_M1() { cat <<'EOF'
# M1 — MIGRATION COMPLETE. Must return ZERO rows after 01_prefixes + import.
SELECT ?ns ?position (COUNT(*) AS ?n) WHERE {
  { ?s a ?t . BIND(REPLACE(STR(?t), "^(.*[/#])[^/#]*$", "$1") AS ?ns) BIND("type" AS ?position) }
  UNION
  { ?s ?p ?o . BIND(REPLACE(STR(?p), "^(.*[/#])[^/#]*$", "$1") AS ?ns) BIND("predicate" AS ?position) }
  FILTER(?ns IN ("http://www.cidoc-crm.org/cidoc-crm/CRMsci/",
                 "http://www.ics.forth.gr/isl/CRMsci/",
                 "http://www.ics.forth.gr/isl/CRMgeo/",
                 "http://www.ics.forth.gr/isl/CRMinf/",
                 "http://www.cidoc-crm.org/cidoc-crm/CRMba/",
                 "http://www.cidoc-crm.org/cidoc-crm/CRMarchaeo/",
                 "http://www.cidoc-crm.org/cidoc-crm/influence/"))
} GROUP BY ?ns ?position ORDER BY ?ns ?position
EOF
}

# T1 (before) and T2 (after) are the same query; the expectation differs.
q_T1() { cat <<'EOF'
# T1/T2 — RENAMED TERMS. Before: sizes the work (zero = 02 unnecessary).
#         After:  only the *_CORRECT rows may be non-zero.
SELECT ?term (COUNT(*) AS ?n) WHERE {
 { ?s a <http://www.ics.forth.gr/isl/CRMsci/S4_Observation>                    BIND("OLD  S4_Observation" AS ?term) }
 UNION { ?s a <http://www.cidoc-crm.org/cidoc-crm/CRMsci/S4_Observation>       BIND("OLD2 S4_Observation" AS ?term) }
 UNION { ?s a <http://www.cidoc-crm.org/extensions/crmsci/S4_Observation>      BIND("DEAD S4_Observation" AS ?term) }
 UNION { ?s a <http://www.cidoc-crm.org/extensions/crmsci/S4_Single_Observation> BIND("S4_CORRECT" AS ?term) }
 UNION { ?s a <http://www.cidoc-crm.org/extensions/crmsci/S27_Observation>     BIND("S27_CORRECT" AS ?term) }
 UNION { ?s <http://www.ics.forth.gr/isl/CRMsci/O21_has_found_at> ?o           BIND("OLD  O21_has_found_at" AS ?term) }
 UNION { ?s <http://www.cidoc-crm.org/extensions/crmsci/O21_has_found_at> ?o   BIND("DEAD O21_has_found_at" AS ?term) }
 UNION { ?s <http://www.cidoc-crm.org/extensions/crmsci/O21_encountered_at> ?o BIND("O21_CORRECT" AS ?term) }
 UNION { ?s <http://www.ics.forth.gr/isl/CRMsci/O19i_was_object_found_by> ?o   BIND("OLD  O19i_was_object_found_by" AS ?term) }
 UNION { ?s <http://www.cidoc-crm.org/extensions/crmsci/O19i_was_object_found_by> ?o BIND("DEAD O19i_was_object_found_by" AS ?term) }
 UNION { ?s <http://www.cidoc-crm.org/extensions/crmsci/O19i_was_object_encountered_through> ?o BIND("O19i_CORRECT" AS ?term) }
 UNION { ?s <http://www.ics.forth.gr/isl/CRMinf/J3_applies> ?o                 BIND("OLD  J3_applies" AS ?term) }
 UNION { ?s <http://www.cidoc-crm.org/extensions/crminf/J3_applies> ?o         BIND("DEAD J3_applies" AS ?term) }
 UNION { ?s <http://www.cidoc-crm.org/extensions/crminf/J3_applied> ?o         BIND("J3_CORRECT" AS ?term) }
 UNION { ?s a <http://www.cidoc-crm.org/extensions/influence/SO30_Influence>   BIND("DEAD SO30_Influence" AS ?term) }
 UNION { ?s a <http://www.cidoc-crm.org/extensions/influence/IN30_Influence>   BIND("IN30_CORRECT" AS ?term) }
} GROUP BY ?term ORDER BY DESC(?n)
EOF
}
q_T2() { q_T1; }

q_C1() { cat <<'EOF'
# C1 — CRMdig PIN VIOLATIONS, before 03. Expect ONLY the six artefact graphs.
#      Anything else means real data moved — stop and investigate.
SELECT ?g (COUNT(*) AS ?n) WHERE {
  GRAPH ?g { ?s ?p ?o }
  FILTER(STRSTARTS(STR(?s), "http://www.cidoc-crm.org/extensions/crmdig/")
      || STRSTARTS(STR(?p), "http://www.cidoc-crm.org/extensions/crmdig/")
      || (isIRI(?o) && STRSTARTS(STR(?o), "http://www.cidoc-crm.org/extensions/crmdig/")))
} GROUP BY ?g ORDER BY DESC(?n)
EOF
}
q_C2() { q_C1; }   # after 03: must return zero rows

q_C3() { cat <<'EOF'
# C3 — FUNCTIONAL PROOF of 03. Every row must have ?creation bound.
PREFIX crm: <http://www.cidoc-crm.org/cidoc-crm/>
PREFIX crmdig: <http://www.ics.forth.gr/isl/CRMdig/>
SELECT ?subject ?record ?creation WHERE {
  VALUES ?subject {
    <http://www.researchspace.org/resource/vocab/level_of_confidence>
    <http://www.researchspace.org/resource/vocab/level_of_confidence/certain>
    <http://www.researchspace.org/resource/vocab/level_of_confidence/uncertain>
    <http://www.researchspace.org/resource/vocab/technique>
  }
  ?subject crm:P129i_is_subject_of ?record .
  OPTIONAL { ?record crmdig:L11i_was_output_of ?creation }
}
EOF
}

q_G1() { cat <<'EOF'
# G1 — stale auto-KP context graphs (Phase 7 drop target). Count before/after.
SELECT (COUNT(DISTINCT ?g) AS ?graphs) WHERE {
  GRAPH ?g { ?s ?p ?o }
  FILTER(CONTAINS(STR(?g), "cidoc-crm/CRMsci/") || CONTAINS(STR(?g), "isl/CRMinf/")
      || CONTAINS(STR(?g), "isl/CRMgeo/")      || CONTAINS(STR(?g), "cidoc-crm/CRMba/")
      || CONTAINS(STR(?g), "cidoc-crm/CRMarchaeo/") || CONTAINS(STR(?g), "cidoc-crm/influence/"))
}
EOF
}

ALL="P1 M1 T1 T2 C1 C2 C3 G1"

run_one() {
  local name="$1"
  if ! declare -F "q_$name" >/dev/null; then
    echo "unknown check '$name' — try: $ALL" >&2; return 2
  fi
  local body; body="$(q_$name)"
  local header; header="$(printf '%s\n' "$body" | grep '^#' | head -3)"
  echo "───────────────────────────────────────────────────────────────"
  printf '%s\n' "$header"
  echo "───────────────────────────────────────────────────────────────"
  local out rc
  out=$(curl -sS -m 120 -u "$RS_USER:$RS_PASS" -H 'Accept: text/csv' \
        "$SPARQL" --data-urlencode "query=$body" 2>&1); rc=$?
  if [ $rc -ne 0 ]; then echo "REQUEST FAILED (curl $rc): $out" >&2; return 1; fi
  if printf '%s' "$out" | grep -qi '<html\|error\|exception'; then
    echo "ENDPOINT ERROR:"; printf '%s\n' "$out" | head -20; return 1
  fi
  local rows; rows=$(printf '%s\n' "$out" | tail -n +2 | grep -c . || true)
  printf '%s\n' "$out"
  echo "  → $rows data row(s)"
  echo
}

case "${1:-}" in
  ""|-h|--help|help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//' ;;
  list)     for c in $ALL; do printf '  %-4s %s\n' "$c" "$(q_$c | grep '^#' | head -1 | sed 's/^# *//')"; done ;;
  show)     shift; q_"${1:?need a check name}" ;;
  baseline) for c in P1 T1;             do run_one "$c"; done ;;
  verify)   for c in P1 M1 T2 C2 C3;    do run_one "$c"; done ;;
  all)      for c in $ALL;              do run_one "$c"; done ;;
  *)        for c in "$@";              do run_one "$c"; done ;;
esac
