// V-921 — an arm whose EVERY assertion sits inside a conditional passes the
// moment that condition goes false, and reports as a pass while checking
// nothing.
//
// This arc found eleven of them. Four were doc-parity gates that retired when
// the feature they gated shipped (V-917 egress, V-918 crypto-order
// subscribability). Two were named for a wait barrier in `recipe-library` and
// passed with every wait barrier in the library deleted (V-919). Two were
// seeded-generator loops one seed away from comparing nothing (V-920). Three
// more are fixed alongside this file.
//
// The shape is worth a ratchet rather than eleven fixes because it is a
// CONTROL-FLOW property — "do these assertions run" — with no judgement in it.
// V-908 tried to detect weak assertions by scoring matchers and was abandoned:
// a matcher census cannot tell a precondition from a weak assertion, and its
// top hit was one of the better test files in the repo. This asks a different
// question and can answer it exactly.
//
// The detector was WRONG on its first run and that is worth recording here,
// because the same trap is one edit away: `\b(?:it|test)\s*\(` also matches the
// `test(` in `re.test(readFileSync(p))`, which sits in a helper above the first
// arm in several doc-parity files. That false match consumed the real first arm
// and the scan reported zero against four files known to contain the defect.
// Hence the lookbehind below, and hence the calibration: it read 4/4 on the
// pre-fix files and 0/4 after.
//
// Legitimate exceptions exist and are declared at their own site with a reason,
// not listed here. An arm may opt out with a `vacuity-exempt:` comment in its
// body — which keeps the justification next to the code it excuses, and keeps
// this guard from becoming a curated exclusion list, which is where a real miss
// hides.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SELF = 'a-test-arm-may-not-hide-all-its-assertions.test.ts';
const ROOTS = ['apps', 'packages'] as const;

/** Strip comments. The negative lookbehind keeps `https://` intact. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');
}

/** Index of the brace matching the `{` at openIdx, or -1. */
function matchBrace(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i += 1) {
    if (s[i] === '{') depth += 1;
    else if (s[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Every `it(...)` / `it.skipIf(x)(...)` / `test(...)` callback body. */
function arms(src: string): { title: string; body: string }[] {
  // The lookbehind is load-bearing — see the header note about `re.test(`.
  const re = /(?<![.\w])(?:it|test)(?:\.\w+\([^)]*\))?\s*\(/g;
  const starts = [...src.matchAll(re)].map((m) => m.index);
  const out: { title: string; body: string }[] = [];
  for (let k = 0; k < starts.length; k += 1) {
    const from = starts[k] as number;
    const limit = k + 1 < starts.length ? (starts[k + 1] as number) : src.length;
    const arrow = src.indexOf('=> {', from);
    if (arrow === -1 || arrow >= limit) continue;
    const open = src.indexOf('{', arrow);
    const close = matchBrace(src, open);
    if (close === -1) continue;
    const t = /['"`]([^'"`]{0,80})/.exec(src.slice(from, arrow));
    out.push({ title: t?.[1] ?? '(untitled)', body: src.slice(open, close + 1) });
  }
  return out;
}

/** Ranges of every `if (...) { ... }` block inside an arm body. */
function ifBlocks(body: string): [number, number][] {
  const re = /\bif\s*\(/g;
  const out: [number, number][] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const open = body.indexOf('{', m.index);
    if (open === -1) continue;
    // A `;` before the brace means the `if` had no block (early return etc).
    if (body.slice(m.index, open).includes(';')) continue;
    const close = matchBrace(body, open);
    if (close === -1) continue;
    out.push([m.index, close]);
    re.lastIndex = close;
  }
  return out;
}

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    if (entry === 'node_modules' || entry === 'dist') return [];
    if (statSync(p).isDirectory()) return testFiles(p);
    return p.endsWith('.test.ts') && !p.endsWith(SELF) ? [p] : [];
  });
}

function hiddenArms(): string[] {
  const out: string[] = [];
  for (const root of ROOTS) {
    for (const file of testFiles(resolve(REPO_ROOT, root))) {
      const raw = readFileSync(file, 'utf8');
      // Parsed twice on purpose. The vacuity test needs comments GONE, or prose
      // quoting an assertion counts as one. The exemption marker IS a comment,
      // so it only survives in the raw parse — matched back by arm title so an
      // exemption covers the one arm that justified it, not every arm in the
      // file, including ones added later.
      const exempt = new Set(
        arms(raw)
          .filter((a) => /vacuity-exempt:/.test(a.body))
          .map((a) => a.title),
      );
      for (const arm of arms(code(raw))) {
        const expects = [...arm.body.matchAll(/\bexpect\s*\(/g)].map((e) => e.index);
        if (expects.length === 0) continue;
        const blocks = ifBlocks(arm.body);
        if (blocks.length === 0) continue;
        if (!expects.every((i) => blocks.some(([s, e]) => i > s && i < e))) continue;
        if (exempt.has(arm.title)) continue;
        out.push(`${file.slice(REPO_ROOT.length + 1)} :: ${arm.title}`);
      }
    }
  }
  return out;
}

describe('V-921 a test arm may not hide all its assertions', () => {
  it('CRITICAL the scan reaches the test corpus. The arm below reports an ABSENCE, so a broken walk returning nothing would satisfy it having examined no files — the exact false green this guard exists to prevent, and the failure mode the first version of this scanner actually had.', () => {
    const count = ROOTS.reduce((n, r) => n + testFiles(resolve(REPO_ROOT, r)).length, 0);
    expect(count, 'test files walked under apps/ and packages/').toBeGreaterThan(2500);
  });

  it('CRITICAL no arm puts every one of its assertions behind a conditional. Such an arm passes while checking nothing the moment the condition goes false — which happened to eleven arms in this repo: four doc-parity gates that retired when their feature shipped, two named for a wait barrier that passed with every wait barrier deleted, and two seeded loops one seed away from comparing nothing. Declare a genuine exception with a `vacuity-exempt:` comment and a reason at the site.', () => {
    expect(
      hiddenArms(),
      'these arms report a pass without necessarily asserting anything:',
    ).toEqual([]);
  });
});
