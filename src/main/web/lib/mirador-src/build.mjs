#!/usr/bin/env node
// Materialises ../mirador/mirador.js from the vendored prelude + Mirador source.
//
// Mirador 2 is pre-module ES5: every file in js/src is an IIFE that hangs
// properties on one global namespace object. There are no imports. Concatenation
// IS the link step, which is why this replaces the original Grunt build entirely
// (its other tasks -- uglify, less, cssmin, lint -- do not affect the shipped file).
//
//   node build.mjs            write ../mirador/mirador.js
//   node build.mjs --stdout   print to stdout instead
//
// Ordering is an explicit manifest, never a directory glob: glob order varies by
// platform, filesystem and locale, and a single reordering shifts every later byte.

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ARTIFACT = join(HERE, '..', 'mirador', 'mirador.js');

// Vendor prelude: bundle lines 1-132,895, split at self-identifying banners.
// Order and contents are pinned in vendors.manifest.json.
const manifest = JSON.parse(readFileSync(join(HERE, 'vendors.manifest.json'), 'utf8'));
const VENDORS = manifest.order.map((entry) => join(HERE, 'vendors', entry.file));

// Mirador source: the order of the original Gruntfile `sources` array, expanded.
// js/src/mirador.js must come first (it creates the namespace); utils/handlebars.js
// second (five files call Handlebars.compile at load time).
export const SOURCES = [
  'js/src/mirador.js',
  'js/src/utils/handlebars.js',
  'js/src/settings.js',
  'js/src/viewer.js',
  'js/src/workspace.js',
  'js/src/viewer/bookmarkPanel.js',
  'js/src/viewer/collectionTreeManifestsPanel.js',
  'js/src/viewer/mainMenu.js',
  'js/src/viewer/manifestListItem.js',
  'js/src/viewer/manifestsPanel.js',
  'js/src/viewer/workspacePanel.js',
  'js/src/manifests/collection.js',
  'js/src/manifests/manifest.js',
  'js/src/annotations/annotation-utils.js',
  'js/src/annotations/annotationTooltip.js',
  'js/src/annotations/catchEndpoint.js',
  'js/src/annotations/endpoint.js',
  'js/src/annotations/legacyOpenAnnotationStrategy.js',
  'js/src/annotations/localStorageEndpoint.js',
  'js/src/annotations/mirador21Strategy.js',
  'js/src/annotations/miradorDualStrategy.js',
  'js/src/annotations/miradorLegacyStrategy.js',
  'js/src/annotations/osd-region-draw-tool.js',
  'js/src/annotations/osd-svg-ellipse.js',
  'js/src/annotations/osd-svg-freehand.js',
  'js/src/annotations/osd-svg-overlay.js',
  'js/src/annotations/osd-svg-pin.js',
  // RS-local: the SAM2 segmentation tool. Pinned here rather than in
  // alphabetical position, where the retired server-side tool used to sit.
  'js/src/annotations/osd-svg-sam-local.js',
  'js/src/annotations/osd-svg-polygon.js',
  'js/src/annotations/osd-svg-rectangle.js',
  'js/src/annotations/simpleASEndpoint.js',
  'js/src/annotations/tinymce-annotation-editor.js',
  'js/src/workspaces/slot.js',
  'js/src/workspaces/window.js',
  'js/src/widgets/annotationsLayer.js',
  'js/src/widgets/annotationsTab.js',
  'js/src/widgets/bookView.js',
  'js/src/widgets/contextControls.js',
  'js/src/widgets/hud.js',
  'js/src/widgets/imageView.js',
  'js/src/widgets/layersTab.js',
  'js/src/widgets/metadataView.js',
  'js/src/widgets/scrollView.js',
  'js/src/widgets/searchTab.js',
  'js/src/widgets/searchWithinResults.js',
  'js/src/widgets/sidePanel.js',
  'js/src/widgets/statusBar.js',
  'js/src/widgets/tabs.js',
  'js/src/widgets/thumbnailsView.js',
  'js/src/widgets/toc.js',
  'js/src/utils/dialog-builder.js',
  'js/src/utils/eventemitter.js',
  'js/src/utils/iiif.js',
  'js/src/utils/jsonBlobApi.js',
  'js/src/utils/jsonLd.js',
  'js/src/utils/localJsonBlobApi.js',
  'js/src/utils/openSeadragon.js',
  'js/src/utils/saveController.js',
  'js/src/utils/utils.js',
];

// SOURCES is an explicit manifest, so a new file that nobody lists would be
// silently omitted from the bundle. Catch that here rather than in a debugger.
function checkNoUnlistedSources() {
  const listed = new Set(SOURCES);
  const found = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(join(HERE, dir), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(`${dir}/${e.name}`, r);
      else if (e.name.endsWith('.js')) found.push(r);
    }
  };
  walk('js/src', 'js/src');
  const unlisted = found.filter((f) => !listed.has(f));
  if (unlisted.length) {
    throw new Error(
      `these files exist in js/src but are not in the SOURCES manifest in build.mjs, ` +
      `so they would not reach the bundle:\n  ${unlisted.join('\n  ')}\n` +
      `Add them to SOURCES (order matters only in that js/src/mirador.js must be first).`
    );
  }
}

// Grunt joined every part with a single "\n". A source file ending in "\n\n"
// therefore contributes a blank line at the join -- annotationTooltip.js relies
// on this. Do not "tidy" its trailing whitespace: it is load-bearing for
// byte-identity. (osd-svg-sam.js was the other such file until the server-side
// SAM tool was removed in 2026-08.)
export function build(existingOnly = false) {
  if (!existingOnly) checkNoUnlistedSources();
  const parts = [];
  for (const f of VENDORS) parts.push(readFileSync(f, 'utf8'));
  for (const rel of SOURCES) {
    const p = join(HERE, rel);
    try {
      parts.push(readFileSync(p, 'utf8'));
    } catch (e) {
      if (existingOnly && e.code === 'ENOENT') continue;
      throw new Error(`missing source file: ${rel}`);
    }
  }
  // Vendor chunks are stored without a trailing newline, so the same "\n" join
  // applies uniformly across the vendor/source seam.
  const vendorText = parts.slice(0, VENDORS.length).join('\n');
  const sourceText = parts.slice(VENDORS.length).join('\n');
  return vendorText + '\n' + sourceText;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = build(process.argv.includes('--allow-missing'));
  if (process.argv.includes('--stdout')) process.stdout.write(out);
  else {
    writeFileSync(ARTIFACT, out);
    console.log(`wrote ${ARTIFACT} (${out.length} bytes)`);
  }
}
