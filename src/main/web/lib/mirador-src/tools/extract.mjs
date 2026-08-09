#!/usr/bin/env node
// Maps hunks in a foreign mirador.js bundle back onto files in js/src.
//
//   node tools/extract.mjs /path/to/their-mirador.js
//
// Use when upstream (or anyone) hand-edits the artifact and you need their change
// as source. The build is a plain line-preserving concatenation, so a bundle line
// number maps deterministically to exactly one source file and line -- this is the
// tool that makes their bundle-level edits mechanically portable instead of a
// 5 MB merge conflict.
//
// Prints a per-file report; it does not write anything.

import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { SOURCES, build } from '../build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');

const theirs = process.argv[2];
if (!theirs) {
  console.error('usage: node tools/extract.mjs <their-mirador.js>');
  process.exit(2);
}

// Where each source file lands in our build output.
const ours = build();
const vendorLines = ours.split('\n').length - SOURCES.reduce(
  (n, f) => n + readFileSync(join(SRC, f), 'utf8').split('\n').length, 0);

const spans = [];
let line = vendorLines + 1;
for (const f of SOURCES) {
  const n = readFileSync(join(SRC, f), 'utf8').split('\n').length;
  spans.push({ file: f, start: line, end: line + n - 1 });
  line += n;
}
const locate = (l) => spans.find((s) => l >= s.start && l <= s.end);

// Diff their bundle against ours; attribute each hunk.
let diff = '';
try {
  execFileSync('diff', ['-u', '-', theirs], { input: ours, encoding: 'utf8' });
} catch (e) {
  diff = e.stdout || '';
}
if (!diff.trim()) {
  console.log('identical to our build — nothing to extract');
  process.exit(0);
}

const byFile = new Map();
for (const m of diff.matchAll(/^@@ -(\d+),(\d+) \+\d+,(\d+) @@/gm)) {
  const at = Number(m[1]);
  const s = locate(at);
  const key = s ? s.file : `VENDOR PRELUDE (line ${at})`;
  const rel = s ? at - s.start + 1 : at;
  const delta = Number(m[3]) - Number(m[2]);
  if (!byFile.has(key)) byFile.set(key, []);
  byFile.get(key).push({ rel, delta });
}

console.log(`hunks: ${[...byFile.values()].reduce((n, v) => n + v.length, 0)}  files: ${byFile.size}\n`);
for (const [file, hunks] of byFile) {
  const net = hunks.reduce((n, h) => n + h.delta, 0);
  console.log(`${file}  (${hunks.length} hunk(s), ${net >= 0 ? '+' : ''}${net} lines)`);
  for (const h of hunks) console.log(`    at line ~${h.rel}`);
}
console.log('\nA hunk attributed to VENDOR PRELUDE means they modified a third-party');
console.log('library in place — inspect before porting; it may be a security patch.');
