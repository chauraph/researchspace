#!/usr/bin/env python3
"""
01_prefixes.py — namespace rewrite for the *minimal* CRM migration.

This is a thin policy wrapper around upstream's engine at
``dist/migrations/4.1.0/replace_prefixes.py``. It reuses upstream's file walker
and replacement code verbatim and only overrides *which* namespaces are
rewritten, so upstream fixes to the engine reach us for free.

Policy: rewrite the CRM extension namespaces that have **no instance data**,
and leave CRMdig and FRBRoo alone. See README.md for the counts and reasoning.

Usage:
    ./01_prefixes.py -i INPUT_DIR -o OUTPUT_DIR [--backup]
    ./01_prefixes.py --show          # print the effective mapping and exit

Run this on the exported .nt files produced by ``4.1.0/export.sh``, then load
them back with ``4.1.0/import.sh``. Run 02_term_renames.sparql afterwards.
"""
import argparse
import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
UPSTREAM_SCRIPT = HERE.parent / "4.1.0" / "replace_prefixes.py"


def _load_upstream():
    """Import upstream's replace_prefixes.py as a module (it is __main__-guarded)."""
    if not UPSTREAM_SCRIPT.is_file():
        sys.exit(f"Error: upstream engine not found at '{UPSTREAM_SCRIPT}'.")
    # Don't drop a __pycache__ into upstream's directory — it would show up as an
    # untracked file in a tree we are deliberately keeping identical to upstream.
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("rs_upstream_replace_prefixes", UPSTREAM_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ─────────────────────────────────────────────────────────────────────────────
# Policy
# ─────────────────────────────────────────────────────────────────────────────
# Namespaces we deliberately do NOT migrate. Stated as an explicit list, never
# as a deletion from upstream's table — a deletion can be silently undone by a
# merge, and the failure is destructive and quiet.
EXCLUDED = {
    # (old, new) exactly as they appear in upstream's MAPPING
    ("http://www.ics.forth.gr/isl/CRMdig/", "http://www.cidoc-crm.org/extensions/crmdig/"),
    ("http://iflastandards.info/ns/fr/frbr/frbroo/", "http://iflastandards.info/ns/lrm/lrmoo/"),
}

EXCLUSION_REASON = {
    "http://www.ics.forth.gr/isl/CRMdig/":
        "~5,230 typed instances + ~6,457 predicate uses in production data; "
        "CRMdig is also referenced directly by CRMdig.java, crmdig.ts, "
        "IIIFMetadataExtractor.java, ui.prop and the form-record templates.",
    "http://iflastandards.info/ns/fr/frbr/frbroo/":
        "~12 typed instances; frbroo->lrmoo is a term *rename*, not a relocation, "
        "so a prefix rewrite alone would produce dangling IRIs.",
}

# Upstream's MAPPING as reviewed at commit 08daa7e51 (2025-06-05). Every row
# upstream ships must be consciously classified as migrate-or-exclude; if
# upstream adds a row we have not seen, this script refuses to run rather than
# guessing. See README.md "Staying in sync with upstream".
REVIEWED_UPSTREAM_ROWS = {
    ("http://www.cidoc-crm.org/cidoc-crm/CRMarchaeo/", "http://www.cidoc-crm.org/extensions/crmarchaeo/"),
    ("http://www.cidoc-crm.org/cidoc-crm/CRMba/", "http://www.cidoc-crm.org/extensions/crmba/"),
    ("http://www.ics.forth.gr/isl/CRMdig/", "http://www.cidoc-crm.org/extensions/crmdig/"),
    ("http://www.ics.forth.gr/isl/CRMgeo/", "http://www.cidoc-crm.org/extensions/crmgeo/"),
    ("http://www.cidoc-crm.org/cidoc-crm/influence/", "http://www.cidoc-crm.org/extensions/influence/"),
    ("http://www.cidoc-crm.org/cidoc-crm/CRMsci/", "http://www.cidoc-crm.org/extensions/crmsci/"),
    ("http://www.ics.forth.gr/isl/CRMsci/", "http://www.cidoc-crm.org/extensions/crmsci/"),
    ("http://www.ics.forth.gr/isl/CRMinf/", "http://www.cidoc-crm.org/extensions/crminf/"),
    ("http://iflastandards.info/ns/fr/frbr/frbroo/", "http://iflastandards.info/ns/lrm/lrmoo/"),
}


def effective_mapping(upstream):
    """Upstream's mapping minus our exclusions, with a drift guard."""
    upstream_rows = {tuple(row) for row in upstream.MAPPING}

    unreviewed = upstream_rows - REVIEWED_UPSTREAM_ROWS
    if unreviewed:
        lines = "\n".join(f"    {old}  ->  {new}" for old, new in sorted(unreviewed))
        sys.exit(
            "Refusing to run: upstream's MAPPING contains rows this policy has not\n"
            "classified. Decide migrate-or-exclude for each, then add them to\n"
            f"REVIEWED_UPSTREAM_ROWS (and EXCLUDED if pinning):\n{lines}"
        )

    missing = REVIEWED_UPSTREAM_ROWS - upstream_rows
    if missing:
        lines = "\n".join(f"    {old}  ->  {new}" for old, new in sorted(missing))
        print(
            "Warning: rows we reviewed are no longer present upstream (upstream may\n"
            f"have revised them). Re-check before relying on this run:\n{lines}",
            file=sys.stderr,
        )

    return [row for row in upstream.MAPPING if tuple(row) not in EXCLUDED]


def show(mapping):
    print(f"Engine:   {UPSTREAM_SCRIPT}")
    print(f"\nMigrating ({len(mapping)}):")
    for old, new in mapping:
        print(f"    {old}\n        -> {new}")
    print(f"\nPinned / NOT migrated ({len(EXCLUDED)}):")
    for old, new in sorted(EXCLUDED):
        print(f"    {old}\n        (upstream would map to {new})")
        print(f"        reason: {EXCLUSION_REASON[old]}")
    print(
        "\nNote: term renames (S4_Observation, O21_has_found_at, J3_applies) are NOT\n"
        "handled here — run 02_term_renames.sparql after loading."
    )


def main():
    parser = argparse.ArgumentParser(
        description="Minimal CRM namespace rewrite (upstream engine, local policy)."
    )
    parser.add_argument("-i", "--input", help="Input directory containing files to process")
    parser.add_argument("-o", "--output", help="Output directory for modified files")
    parser.add_argument(
        "-b", "--backup", action="store_true",
        help="Backup existing output files with a .bak extension",
    )
    parser.add_argument(
        "--show", action="store_true",
        help="Print the effective mapping and exit without touching any files",
    )
    args = parser.parse_args()

    upstream = _load_upstream()
    mapping = effective_mapping(upstream)

    if args.show:
        show(mapping)
        return

    if not args.input or not args.output:
        parser.error("-i/--input and -o/--output are required (or use --show)")

    in_dir = Path(args.input)
    out_dir = Path(args.output)
    if not in_dir.is_dir():
        sys.exit(f"Error: input '{in_dir}' is not a directory.")

    show(mapping)
    print()

    for src_path in in_dir.rglob("*"):
        if src_path.is_file():
            dst_path = out_dir / src_path.relative_to(in_dir)
            upstream.process_file(src_path, dst_path, mapping, backup=args.backup)


if __name__ == "__main__":
    main()
