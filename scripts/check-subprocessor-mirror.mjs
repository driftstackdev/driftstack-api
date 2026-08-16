#!/usr/bin/env node
// V-271 — Sub-processor mirror linter.
//
// Ensures the customer-facing sub-processor list in
// `apps/marketing-site/src/data/sub-processors.ts` stays in sync with
// the canonical DPA Annex 3 entries in `docs/legal/dpa.md`.
//
// V-264 + V-255 both noted that these two surfaces must move in
// lockstep — adding or removing a sub-processor triggers an Article
// 28(2) GDPR notice + a re-acceptance flow, so silent drift between
// the two is a compliance bug, not just a doc-rot annoyance.
//
// Drift detection (substring-based, not strict 1:1):
//   - Each entry name in `data/sub-processors.ts` must match a row in
//     the DPA Annex 3 table (case-insensitive substring of the row's
//     "Sub-processor" column).
//   - Each row in DPA Annex 3 must have a corresponding entry in
//     `data/sub-processors.ts` (substring match in either direction).
//   - The Stripe split (Stripe Payments Europe Ltd + Stripe, Inc. in
//     the DPA → "Stripe" in the public list) is the documented
//     exception; both DPA rows resolve to the single public "Stripe"
//     entry.
//
// Exit codes:
//   0 — in sync.
//   1 — drift detected; prints what's missing on which side.
//
// Usage:
//   node scripts/check-subprocessor-mirror.mjs
//
// Wired into CI by being run from the lint stage; lands as a
// follow-up commit if landed standalone first.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const PUBLIC_LIST_PATH = join(REPO_ROOT, 'apps/marketing-site/src/data/sub-processors.ts');
const DPA_PATH = join(REPO_ROOT, 'docs/legal/dpa.md');

function fail(message) {
  console.error('✗ subprocessor mirror check failed');
  console.error(message);
  process.exit(1);
}

function pass(message) {
  console.log('✓ subprocessor mirror check passed');
  if (message) console.log(message);
}

// Extract names from `apps/marketing-site/src/data/sub-processors.ts`
// by parsing the literal `name: 'X'` and `name: "X"` strings inside
// the SUB_PROCESSORS array.
function readPublicNames() {
  const src = readFileSync(PUBLIC_LIST_PATH, 'utf8');
  const matches = [...src.matchAll(/name:\s*['"]([^'"]+)['"]/g)];
  if (matches.length === 0) {
    fail(`No \`name: '...'\` entries found in ${PUBLIC_LIST_PATH}.`);
  }
  return matches.map((m) => m[1]);
}

// Extract names from DPA Annex 3 by finding the table after the
// `## Annex 3` heading and reading the first cell of each data row.
function readDpaNames() {
  const src = readFileSync(DPA_PATH, 'utf8');
  const annexIdx = src.indexOf('## Annex 3');
  if (annexIdx === -1) {
    fail(`Could not locate "## Annex 3" heading in ${DPA_PATH}.`);
  }
  // Walk forward; capture every line of shape `| <name> | ...`.
  // Stop at the next `## ` heading or the end of file.
  const tail = src.slice(annexIdx);
  const nextHeadingIdx = tail.indexOf('\n## ', 1);
  const section = nextHeadingIdx === -1 ? tail : tail.slice(0, nextHeadingIdx);
  const rows = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    // cells[0] = '' (leading), cells[1] = first column.
    const first = cells[1];
    if (!first) continue;
    // Skip header + separator rows.
    if (/^[-\s|]+$/.test(first)) continue;
    if (/^sub-?processor/i.test(first)) continue;
    rows.push(first);
  }
  if (rows.length === 0) {
    fail(`Annex 3 table has no rows in ${DPA_PATH}.`);
  }
  return rows;
}

// Entity-suffix + generic-product-noun stop-list. These words don't
// uniquely identify a vendor; we strip them before token comparison so
// "Hetzner Cloud" matches "Hetzner Online GmbH" via the shared
// distinctive token "hetzner".
const STOPWORDS = new Set([
  'inc',
  'ltd',
  'limited',
  'gmbh',
  'bv',
  'b.v.',
  'pbc',
  'llc',
  'corp',
  'corporation',
  'co',
  'company',
  'cloud',
  'online',
  'r2',
  'commerce',
  'payments',
  'europe',
  'the',
  'and',
  'a',
  'an',
  'of',
]);

function tokens(name) {
  return name
    .toLowerCase()
    .replace(/[.,()]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

// Match if any distinctive (post-stopword-strip) token overlaps in
// either direction. The Stripe split ("Stripe Payments Europe Ltd",
// "Stripe, Inc." → public "Stripe") matches via the shared token
// `stripe`. "Hetzner Cloud" ↔ "Hetzner Online GmbH" matches via
// `hetzner`. "Cloudflare R2" ↔ "Cloudflare, Inc." matches via
// `cloudflare`.
function findMatch(target, candidates) {
  const targetTokens = new Set(tokens(target));
  if (targetTokens.size === 0) return null;
  for (const c of candidates) {
    const cTokens = tokens(c);
    for (const ct of cTokens) {
      if (targetTokens.has(ct)) return c;
    }
  }
  return null;
}

/**
 * Compare the two surfaces and report drift in BOTH directions.
 *
 * Pure, and exported, so the comparison can be tested without reading the real
 * files or exiting the process. This linter runs inside `npm run lint`, which CI
 * runs — a compliance guard that silently stopped detecting drift would keep
 * printing its success line while the two surfaces diverged, which is worse than
 * having no linter at all because it reads as active protection.
 */
export function compareSubprocessorLists({ publicNames, dpaNames }) {
  const missingFromPublic = [];
  const missingFromDpa = [];
  for (const dpaName of dpaNames) {
    if (!findMatch(dpaName, publicNames)) {
      missingFromPublic.push(dpaName);
    }
  }
  for (const publicName of publicNames) {
    if (!findMatch(publicName, dpaNames)) {
      missingFromDpa.push(publicName);
    }
  }
  return { missingFromPublic, missingFromDpa };
}

/* c8 ignore start — CLI wiring; the comparison above is what the tests drive. */
if (process.argv[1]?.endsWith('check-subprocessor-mirror.mjs') === true) {
  runCli();
}

function runCli() {
  const publicNames = readPublicNames();
  const dpaNames = readDpaNames();

  const { missingFromPublic, missingFromDpa } = compareSubprocessorLists({ publicNames, dpaNames });

  if (missingFromPublic.length > 0 || missingFromDpa.length > 0) {
    let msg = '';
    if (missingFromPublic.length > 0) {
      msg += `\n  Listed in DPA Annex 3 but missing from data/sub-processors.ts:\n`;
      for (const n of missingFromPublic) msg += `    - ${n}\n`;
    }
    if (missingFromDpa.length > 0) {
      msg += `\n  Listed in data/sub-processors.ts but missing from DPA Annex 3:\n`;
      for (const n of missingFromDpa) msg += `    - ${n}\n`;
    }
    msg +=
      `\nSub-processor changes are an Article 28(2) GDPR amendment + force a customer\n` +
      `re-acceptance flow. Both surfaces MUST move in lockstep. Update the missing side\n` +
      `to match, OR (if the change is intentional) update both. After fixing, re-run:\n\n` +
      `    node scripts/check-subprocessor-mirror.mjs\n`;
    fail(msg);
  }

  pass(
    `${publicNames.length.toString()} public entries, ${dpaNames.length.toString()} DPA Annex 3 rows — all matched.`,
  );
}
/* c8 ignore stop */
