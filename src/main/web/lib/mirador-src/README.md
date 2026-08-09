# Mirador (vendored source)

`../mirador/mirador.js` is **generated**. Edit the files here, run `node build.mjs`,
commit both. Never edit the artifact directly — `verify.mjs` will catch it.

| | |
|---|---|
| Upstream | https://github.com/researchspace/mirador |
| Revision | `ec049bcd2961410e07c6746176a78d52f54729b4` — 2020-07-01, Artem Kozlov |
| Version | **2.7.0** — see "the 2.6.1 trap" below |
| Tracks upstream | **No.** Hard fork. `ProjectMirador/mirador2` is deprecated: 5 commits after `v2.7.0` (2019), none of them code. Mirador 3 is an unrelated React rewrite. |
| License | Apache-2.0 (`LICENSE.md`) |
| Shipped | yes |
| Security critical | yes — see "vendor libraries" |

Every provenance claim below is stored as the command that produces it, not as a
conclusion. Re-run them rather than trusting this file.

```bash
# the vendored source is exactly ec049bcd2
git clone https://github.com/researchspace/mirador && cd mirador && git checkout ec049bcd2
find js/src -name '*.js' | sort | xargs shasum -a 256 | diff - <path>/BASE.sha256

# ec049bcd2 contains all of upstream v2.7.0 (left = upstream-only commits)
git remote add up https://github.com/ProjectMirador/mirador2 && git fetch up --tags
git rev-list --left-right --count v2.7.0...ec049bcd2      # => 0   8

# the 2.6.1 trap: upstream tagged v2.7.0 without bumping the version field,
# and Gruntfile.js stamps the banner from package.json. Every 2.7.0 build
# therefore calls itself 2.6.1. The code here is 2.7.0.
git show v2.7.0:package.json | grep '"version"'           # => "2.6.1"
```

## Layout

```
vendors/                 27 third-party libraries, 132,895 lines, NEVER edited
vendors.manifest.json    concat order + what each chunk contains
js/src/**                Mirador itself — the only files you edit
build.mjs                vendors + js/src  ->  ../mirador/mirador.js
verify.mjs               proves the artifact matches this source
BASE.sha256              hashes of the 58 pristine files, for the check above
tools/                   the patches this tree was reconstructed from
```

## Build and verify

```bash
node build.mjs      # ~1s. No npm install, no grunt, no Node 6.
node verify.mjs     # artifact == build(source)?  Run it in a pre-commit hook.
```

The original Grunt build is not reproducible and is not used: `package.json`
pinned `node < 7.0.0` and phantomjs; the lockfile says `paper@0.10.3` while the
shipped bundle contains 0.12.11; the committed `vendors` list concatenates
`*.min.js` while the shipped bundle has them unminified. The 2020 build machine
had uncommitted changes. The bytes in the artifact are the only surviving record,
which is why `vendors/` is committed rather than resolved from a package manager.

A green `verify.mjs` proves source↔artifact **consistency**, not correctness.
For behaviour, use `probes/`.

## Local modifications

| Source | Lines | What |
|---|---|---|
| `tools/upstream-bundle-delta.patch` | 78 | RS platform team, 2020–2025: `highlightAnnotation` + bus subscription, qtip `container`, `DialogBuilder(jQuery('body'))`, `btn-primary`→`btn-action`, `<rs-…>` share control, workspace drag/drop disabled, hit tolerance. Authors: Artem Kozlov, Cristina Giancristofaro, Diana T. |
| `tools/rs-local.patch` | 566 | This fork, 2025, chauraph: the `$.Sam` SAM2 segmentation tool (`js/src/annotations/osd-svg-sam.js`, 559 lines) + its registration in `settings.js` and `osd-svg-overlay.js`, session support in `miradorDualStrategy.js`. |
| `tools/f1ac332ee-iiif-default-jpg.patch` | 2 | Upstream fix this branch lacked: `/0/native.jpg` → `/0/default.jpg` (IIIF Image API 2.x) and a tag placeholder. |

Two files must end with a **blank line** — `annotationTooltip.js` and
`osd-svg-sam.js`. Grunt joined parts with `\n`, so their `\n\n` produces the blank
line at the join. Stripping it shifts every later byte. `verify.mjs` will tell you.

## Vendor libraries

Frozen at their 2019–2020 versions; `vendors.manifest.json` records what is in each
chunk. Notable, with their exposure in RS:

| Library | Version | Reachable from |
|---|---|---|
| Handlebars | 4.7.6 | `Mirador.ts:312` compiles the page-supplied `annotation-view-tooltip-template`. Advisories exist for < 4.7.7 in the compile path. |
| sanitize-html | `practicefusion` fork @ `d6e3e04` (2016) | cleans annotation body text before display — input from anyone who can write an annotation. Pinned to a fork, so upstream advisories do not track it. |
| jQuery | 3.5.1 | carries the 2020 fixes |
| TinyMCE | 4.9.10 | **not reachable**: `ImageRegionEditor.ts:614` replaces the body editor with `researchspaceAnnotationBodyEditor`, so `tinymce.init` never runs. Loaded and parsed only. |
| OpenSeadragon / paper.js | 2.4.1 / 0.12.11 | the viewer canvas |

**Threat model, stated as a decision:** these libraries are frozen and this viewer
assumes authenticated, trusted authors. If that stops being true for a deployment,
Handlebars and sanitize-html are the two to upgrade first — replace the file in
`vendors/`, rebuild, and the diff will show exactly one library changed.

## Merging upstream

`researchspace/researchspace` still treats the artifact as source and hand-edits it;
their `iiif-viewer-events` branch (ahead 217, last commit 2026-07-17) carries ~663
more such lines. On conflict, do **not** hand-merge the 5 MB file:

```bash
git checkout --ours src/main/web/lib/mirador/mirador.js   # keep the generated one
node tools/extract.mjs <their-mirador.js>                 # map their hunks to js/src
# port only what you want, then:
node build.mjs && node verify.mjs
```

`.gitattributes` marks the artifact `merge=binary -diff -text` so git never attempts
a textual auto-merge on it.
