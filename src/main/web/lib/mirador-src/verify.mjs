#!/usr/bin/env node
// Proves ../mirador/mirador.js is exactly what build.mjs produces from this source.
//
//   node verify.mjs             compare against the committed artifact
//   node verify.mjs --anchor    compare against the recorded anchor hash
//
// A green run proves source<->artifact CONSISTENCY. It says nothing about whether
// the viewer works -- that is what probes/ is for. Do not read a passing verify
// as "tested".

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { build, ARTIFACT } from './build.mjs';

// The anchor: what this source is expected to build to. Its first value proved
// the 2025 source-refactor changed nothing at runtime (the 2020 artifact,
// md5 fd0292137dea9d4c7dc73cfc7814908b). That claim ended deliberately in
// 2026-08, when removing the server-side SAM tool changed the bytes on purpose.
// Repoint it whenever the artifact is MEANT to change, so the next refactor can
// prove, as that one did, that its bytes did not move.
const ANCHOR_MD5 = '736b6fa77bb274a115c633a638ffb0d2';   // 2026-08-25, server SAM removed

const md5 = (s) => createHash('md5').update(s).digest('hex');

// --allow-missing tolerates source files absent from the tree. Only tools/land.sh
// uses it, while walking through the pre-SAM stages of the migration.
const built = build(process.argv.includes('--allow-missing'));
const anchor = process.argv.includes('--anchor') || process.argv.includes('--bootstrap');

if (anchor) {
  const got = md5(built);
  if (got === ANCHOR_MD5) {
    console.log(`OK  build == anchor  (md5 ${got})`);
    process.exit(0);
  }
  console.error(`FAIL  md5 ${got}\n      expected ${ANCHOR_MD5}`);
  process.exit(1);
}

const onDisk = readFileSync(ARTIFACT, 'utf8');
if (built === onDisk) {
  console.log(`OK  ${ARTIFACT} matches source  (md5 ${md5(built)}, ${built.length} bytes)`);
  process.exit(0);
}

// "buffers differ" is a useless error message. Report where, and in which file.
const a = built.split('\n');
const b = onDisk.split('\n');
let i = 0;
while (i < a.length && i < b.length && a[i] === b[i]) i++;
console.error(`FAIL  ${ARTIFACT} does not match source`);
console.error(`      first divergence at line ${i + 1}`);
console.error(`      built    : ${JSON.stringify((a[i] ?? '<eof>').slice(0, 90))}`);
console.error(`      on disk  : ${JSON.stringify((b[i] ?? '<eof>').slice(0, 90))}`);
console.error(`      lines    : built ${a.length}, on disk ${b.length}`);
console.error('');
console.error('Usual causes, in order of likelihood:');
console.error('  1. you edited mirador/mirador.js directly -- edit mirador-src/js/src/** instead');
console.error('  2. an editor stripped or added a trailing newline (annotationTooltip.js');
console.error('     must end with a blank line)');
console.error('  3. CRLF from a checkout without the .gitattributes -text rules');
console.error('  4. you added a source file but not to the SOURCES manifest in build.mjs');
process.exit(1);
