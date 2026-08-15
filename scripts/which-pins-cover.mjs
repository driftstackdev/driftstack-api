#!/usr/bin/env node
// Which parity/invariant tests pin a given source file — and, optionally, a
// given LINE of it.
//
// This exists because of a measured, repeated defect class rather than a
// hypothetical one. On 2026-08-15 alone:
//
//   - `BadRequestError` joined the error-handler import roster. TWO guards pin
//     that line. One was updated, the shared gate went red on the other, and a
//     second agent spent a commit fixing it.
//   - The checkout idempotency line turned out to be pinned in THREE places; the
//     third was found the same way — by the gate, after the fact.
//
// Both times the author knew parity guards existed and updated the ones they
// knew about. The failure is not carelessness, it is that nothing answers "which
// pins cover this?" before you commit. Grepping for the symbol finds the source
// and the tests that merely mention it; grepping for the file path finds tests
// that read it but not which assertion would break.
//
// Usage:
//   node scripts/which-pins-cover.mjs apps/server/src/middleware/error-handler.ts
//   node scripts/which-pins-cover.mjs apps/server/src/middleware/error-handler.ts "ApiError, InternalError"
//
// With a second argument it also reports which of those tests contain that text
// — usually a fragment of the line you are about to change. Those are the ones
// that will fail, and the ones to update in the SAME commit.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');

/** Every *.test.ts under any tests/ directory, skipping build + vendor trees. */
function testFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) testFiles(full, out);
    else if (entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const [rawSource, snippet] = process.argv.slice(2);
if (!rawSource) {
  console.error('usage: which-pins-cover.mjs <source-path> [line-snippet]');
  process.exit(2);
}

// Accept absolute or repo-relative; pins reference the repo-relative form.
const sourceRel = relative(REPO_ROOT, resolve(REPO_ROOT, rawSource));
try {
  statSync(resolve(REPO_ROOT, sourceRel));
} catch {
  console.error(`no such source file: ${sourceRel}`);
  process.exit(2);
}

const readers = [];
for (const file of testFiles(REPO_ROOT)) {
  const text = readFileSync(file, 'utf8');
  if (!text.includes(sourceRel)) continue;
  const rel = relative(REPO_ROOT, file);
  const lines = text.split('\n');
  const refLine = lines.findIndex((l) => l.includes(sourceRel)) + 1;
  const snippetLines = snippet ? lines.flatMap((l, i) => (l.includes(snippet) ? [i + 1] : [])) : [];
  readers.push({ rel, refLine, snippetLines });
}

if (readers.length === 0) {
  console.log(`no test reads ${sourceRel}`);
  process.exit(0);
}

console.log(`${readers.length} test file(s) read ${sourceRel}:\n`);
for (const r of readers.sort((a, b) => a.rel.localeCompare(b.rel))) {
  const mark = snippet && r.snippetLines.length > 0 ? ' <-- PINS THE SNIPPET' : '';
  console.log(`  ${r.rel}:${r.refLine}${mark}`);
  for (const l of r.snippetLines) console.log(`      snippet at :${l}`);
}

if (snippet) {
  const hits = readers.filter((r) => r.snippetLines.length > 0);
  console.log(
    `\n${hits.length} of ${readers.length} pin that snippet — update ALL of them in the same commit.`,
  );
  if (hits.length === 0) {
    console.log(
      '(none pin it literally; a pin may still match it by regex, so read the readers above)',
    );
  }
}
