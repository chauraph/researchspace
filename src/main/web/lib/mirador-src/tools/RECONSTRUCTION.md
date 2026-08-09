# Recovering the source of `lib/mirador/mirador.js`

`src/main/web/lib/mirador/mirador.js` is a build artifact (`//! mirador 2.6.1 / Built on 2020-09-16`,
148,919 lines). Its source is the fork **https://github.com/researchspace/mirador**, branch `master`,
HEAD `ec049bcd2` (2020-07-01). Since 2023 the bundle has been hand-patched in this repo and the fork
was never updated; the files here close that gap.

## Provenance of the fork

- `ec049bcd2` contains **all of upstream `v2.7.0`** (`32e6bd589`, ProjectMirador/mirador2) —
  `git rev-list --left-right --count v2.7.0...master` → `0  8`. Nothing upstream is missing.
- The 8 RS-only commits carry three trivial content changes: three `<div … />` → `<div></div>`
  fixes in `js/src/widgets/contextControls.js`, `openseadragon` pinned to `2.4.1`,
  `iiif-evented-canvas` pointed at `github:researchspace/iiif-evented-canvas`, plus a committed lockfile.
- **Upstream 2.x is dead.** `ProjectMirador/mirador2` has 5 commits after `v2.7.0`: a deprecation
  notice, issue templates, and a package URL edit. No code. Mirador 3 (`ProjectMirador/mirador`,
  branch `main`) is a React rewrite, not an upgrade path. There is nothing to rebase onto.

## The delta: bundle → source

Recovered by concatenating `js/src/**` in `Gruntfile.js` order (separator `\n`) and diffing against
the bundle's source section (`mirador.js:132896`–end).

**The fork is stale for upstream too.** `researchspace/researchspace@master`'s bundle is *also* not a
clean build of `ec049bcd2` — it carries 14 hunks / 80 lines of hand patches the RS team made in the
platform repo and never pushed back to the mirador fork. Both bundles still advertise the same banner,
`//! mirador 2.6.1 / Built on 2020-09-16`, so the banner is worthless as a version marker.

| Artifact | Content |
|---|---|
| `upstream-bundle-delta.patch` | 13 hunks / 8 files — `ec049bcd2` → the bundle in `researchspace/researchspace@master` |
| `rs-bundle-delta.patch` | 17 hunks / 8 files — `ec049bcd2` → the bundle on this branch |
| `osd-svg-sam.js` | 559 lines, the `$.Sam` SAM2 segmentation drawing tool (new file) |

Both patches apply cleanly to a fresh `researchspace/mirador@ec049bcd2` checkout. Blank-line-only
hunks at concat boundaries were dropped as build noise.

### Who owns which change

- **Shared with upstream** (already in `researchspace/researchspace@master`): `highlightAnnotation`
  method + bus subscription in `osd-region-draw-tool.js`, qtip `container: _this.element`,
  `DialogBuilder(jQuery('body'))`, `btn-primary` → `btn-action`, `<rs-…>` in the share-url control,
  workspace drag/drop handlers commented out, hit `tolerance`. Files: `viewer/bookmarkPanel.js`,
  `viewer/mainMenu.js`, `annotations/annotationTooltip.js`, `annotations/osd-region-draw-tool.js`,
  `annotations/osd-svg-overlay.js`, `annotations/tinymce-annotation-editor.js`, `workspaces/slot.js`,
  `utils/iiif.js`.
- **This branch only** (never upstreamed): the `$.Sam` tool + its registration in `js/src/settings.js`
  (`availableAnnotationDrawingTools`), the session/viewport work in
  `annotations/miradorDualStrategy.js` (+35), and the SAM entries in `osd-region-draw-tool.js`.
  Repo commits `d27d25a5b`, `f3c98d1bd`, `a5cfe05b5`, `0fcea98af`, `66b8312d0`, `6a561c211`.
- **Upstream only — missing here.** `f1ac332ee` (2025-05-21) is not an ancestor of this branch and
  changed two bundle lines: the thumbnail URL builder in `utils/iiif.js`
  (`/0/native.jpg` → `/0/default.jpg`, a real IIIF 2.x correctness fix) and the tag-input placeholder
  in `tinymce-annotation-editor.js`. `mirador.js:147960` here still emits `native.jpg`.

## Verification performed

```
git clone https://github.com/researchspace/mirador && cd mirador
git apply .../rs-bundle-delta.patch
cp .../osd-svg-sam.js js/src/annotations/
# concat in Gruntfile order, with osd-svg-sam.js placed directly after osd-svg-pin.js
diff <concat> <tail -n +132896 of lib/mirador/mirador.js>
```

→ **byte-identical**, `md5 = fd0292137dea9d4c7dc73cfc7814908b`, once two trailing-newline
adjustments are made (see below). No grunt, no npm, no Node 6 involved in the check.

The same check against the upstream platform bundle (`upstream-bundle-delta.patch`, no SAM file)
yields 0 non-blank differing lines.

### Two trailing newlines

Grunt joins the source files with `\n`, so a file ending in `\n\n` produces a blank line at the join.
The 2020 build had exactly two such files. To reproduce byte-for-byte:

- append one newline to `js/src/annotations/annotationTooltip.js`
- `osd-svg-sam.js` here already carries its extra trailing newline

### The vendor prelude never changes

Bundle lines 1–132,895 (banner + all 27 vendor libraries, 4.4 MB) are **byte-identical**
(`md5 = 1afab04fcd97b941ec05bfada174af1d`) across this branch, `researchspace/researchspace@master`,
and the `iiif-viewer-events` branch as of 2026-07-17. Nobody has touched them in six years.
Freezing that prelude as a file reduces the whole build to a concatenation.

## Upstream is not replacing Mirador 2

Checked 2026-08-09. `researchspace/researchspace@master` still registers `rs-iiif-mirador` →
`ImageRegionEditor.ts` in `components.json`, has no `mirador` npm dependency, and none of the 76
commits on master since our merge-base mention a viewer migration. Their live IIIF branch,
`iiif-viewer-events` (ahead 217 / behind 3, last commit 2026-07-17), still ships the identical
`//! mirador 2.6.1 / Built on 2020-09-16` bundle and adds ~663 more hand-patched lines to it
(annotation labels, pin anchors, `semanticAnnotationModeChanged`, `AnnotationsLayer.prototype`
wrappers appended inside the bundle). Mirador 2 is the platform's viewer for the foreseeable future.

## Rebuilding

`Gruntfile.js` must be edited before the build reproduces what ships:

1. Add `js/src/annotations/osd-svg-sam.js` to `sources`, ordered after `osd-svg-pin.js`
   (the plain `js/src/annotations/*.js` glob would sort it last — harmless functionally,
   but it breaks byte-comparison against the current bundle).
2. The shipped bundle contains **unminified** vendors (full jQuery 3.5.1 source), while the
   committed `vendors` list concatenates `*.min.js`. Whoever built it in 2020 changed this locally
   and never committed it.
3. `package-lock.json` locks `paper@0.10.3`, but the bundle carries **Paper.js 0.12.11**
   (`mirador.js:103236`). The lockfile is not authoritative for the shipped artifact.
4. `"engine": "node < 7.0.0"`, `grunt >=0.4.5 <1.0.0`, phantomjs — build under Node 6
   (`nvm use 6` or a `node:6` container).

Then `bash src/main/web/lib/update-mirador.bash` (expects the fork checked out at `../mirador`
relative to this repo). It does not emit the `@import '~basic-styles.scss';` line that the
committed `lib/mirador/css/mirador.scss` starts with — re-add it by hand.
