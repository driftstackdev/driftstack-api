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

/**
 * V-922: which characters are CODE — not inside a comment, string, template
 * literal, or regex literal.
 *
 * The first version of this guard stripped comments with a regex and then
 * counted raw `{` / `}`. Measured against a literal-aware pass, that
 * mis-delimited 2350 of 27413 arm bodies — 8.6% — because a regex literal such
 * as `/\$\{[^}]+\}/` or a string containing a brace unbalances the count. Some
 * bodies ended early, some late, some found no closing brace at all. The verdict
 * did not change (0 offenders either way, checked), but the guard was reporting
 * coverage over 91% of arms while claiming all of them.
 */
function codeMask(src: string): boolean[] {
  const mask = new Array<boolean>(src.length).fill(true);
  const n = src.length;
  let i = 0;
  const blank = (): void => {
    mask[i] = false;
    i += 1;
  };
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') blank();
      continue;
    }
    if (c === '/' && next === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) blank();
      blank();
      blank();
      continue;
    }
    if (c === "'" || c === '"') {
      blank();
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') blank();
        if (i < n) blank();
      }
      blank();
      continue;
    }
    if (c === '`') {
      blank();
      while (i < n) {
        if (src[i] === '\\') {
          blank();
          blank();
          continue;
        }
        // `${ … }` is code, but its braces must not count toward the arm body.
        if (src[i] === '$' && src[i + 1] === '{') {
          blank();
          blank();
          let depth = 1;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth += 1;
            else if (src[i] === '}') {
              depth -= 1;
              if (depth === 0) {
                blank();
                break;
              }
            }
            i += 1;
          }
          continue;
        }
        if (src[i] === '`') {
          blank();
          break;
        }
        blank();
      }
      continue;
    }
    if (c === '/') {
      let j = i - 1;
      while (j >= 0 && /\s/.test(src[j] as string)) j -= 1;
      const prev = j >= 0 ? (src[j] as string) : '';
      const valuePosition =
        prev === '' ||
        '(,=:[!&|?{};+*%~^-'.includes(prev) ||
        /\b(?:return|typeof)$/.test(src.slice(Math.max(0, j - 7), j + 1));
      if (valuePosition) {
        blank();
        let inClass = false;
        while (i < n) {
          if (src[i] === '\\') {
            blank();
            blank();
            continue;
          }
          if (src[i] === '[') inClass = true;
          else if (src[i] === ']') inClass = false;
          else if (src[i] === '/' && !inClass) {
            blank();
            break;
          } else if (src[i] === '\n') break;
          blank();
        }
        continue;
      }
    }
    i += 1;
  }
  return mask;
}

/** Index of the brace matching the `{` at openIdx, counting CODE braces only. */
function matchBrace(s: string, mask: boolean[], openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i += 1) {
    if (!mask[i]) continue;
    if (s[i] === '{') depth += 1;
    else if (s[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Every `it(...)` / `it.skipIf(x)(...)` / `test(...)` callback body.
 *
 * `body` has every non-code character blanked, so `expect(` or `if (` appearing
 * inside a string or a comment cannot be mistaken for the real thing. `rawBody`
 * keeps the text as written, which is where the exemption marker lives.
 */
function arms(src: string, mask: boolean[]): { title: string; body: string; rawBody: string }[] {
  // The lookbehind is load-bearing — see the header note about `re.test(`.
  const re = /(?<![.\w])(?:it|test)(?:\.\w+\([^)]*\))?\s*\(/g;
  const starts = [...src.matchAll(re)].map((m) => m.index).filter((idx) => mask[idx]);
  const out: { title: string; body: string; rawBody: string }[] = [];
  for (let k = 0; k < starts.length; k += 1) {
    const from = starts[k] as number;
    const limit = k + 1 < starts.length ? (starts[k + 1] as number) : src.length;
    let arrow = -1;
    for (let i = from; i < Math.min(limit, src.length - 3); i += 1) {
      if (mask[i] && src.startsWith('=> {', i)) {
        arrow = i;
        break;
      }
    }
    if (arrow === -1) continue;
    const open = src.indexOf('{', arrow);
    const close = matchBrace(src, mask, open);
    if (close === -1) continue;
    const t = /['"`]([^'"`]{0,80})/.exec(src.slice(from, arrow));
    let body = '';
    for (let i = open; i <= close; i += 1) body += mask[i] ? src[i] : ' ';
    out.push({
      title: t?.[1] ?? '(untitled)',
      body,
      rawBody: src.slice(open, close + 1),
    });
  }
  return out;
}

/**
 * Ranges of every `if (...) { ... }` block inside an arm body. Plain brace
 * counting is safe here because `body` already has non-code characters blanked.
 */
function ifBlocks(body: string): [number, number][] {
  const re = /\bif\s*\(/g;
  const out: [number, number][] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const open = body.indexOf('{', m.index);
    if (open === -1) continue;
    // A `;` before the brace means the `if` had no block (early return etc).
    if (body.slice(m.index, open).includes(';')) continue;
    let depth = 0;
    let close = -1;
    for (let i = open; i < body.length; i += 1) {
      if (body[i] === '{') depth += 1;
      else if (body[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
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
      const mask = codeMask(raw);
      // One parse now. `body` is code-only so prose quoting an assertion cannot
      // count as one; `rawBody` still holds the comments, which is where the
      // exemption marker lives — matched per arm so an exemption covers the one
      // arm that justified it, not every arm in the file, including later ones.
      const parsed = arms(raw, mask);
      const exempt = new Set(
        parsed.filter((a) => /vacuity-exempt:/.test(a.rawBody)).map((a) => a.title),
      );
      for (const arm of parsed) {
        const expects = [...arm.body.matchAll(/\bexpect\s*\(/g)].map((e) => e.index);
        // An arm with no `expect(` at all is NOT flagged. Measured: 11 such arms
        // exist and all 11 delegate to an `expect`-prefixed helper or are
        // implicit no-throw tests. A rule whose every current hit is a false
        // positive would need an exclusion list to ship, and that is where a
        // real miss hides (V-903, V-908).
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
  it('CRITICAL the parser does not count braces inside literals. This is pinned because the first version of this guard did, which mis-delimited 8.6% of arm bodies — a regex literal containing a brace unbalanced the count, so bodies ended early, late, or never. A guard whose parser silently loses arms reports a green over a corpus it did not read.', () => {
    // An arm whose body contains a brace inside a regex literal AND a string.
    const fixture = [
      "it('x', () => {",
      '  const re = /\\$\\{[^}]+\\}/;',
      '  const s = "a } b {";',
      '  if (re.test(s)) {',
      '    expect(s).toBe(s);',
      '  }',
      '});',
    ].join('\n');
    const parsedFixture = arms(fixture, codeMask(fixture));
    expect(parsedFixture.length, 'the fixture arm is found').toBe(1);
    const only = parsedFixture[0];
    // The body must reach the real closing brace — it ends with `}` and contains
    // the assertion. Naive counting stopped at the `}` inside the regex class.
    expect(only?.body.trimEnd().endsWith('}'), 'body closes at the arm brace').toBe(true);
    expect(only?.body, 'body reaches the assertion').toMatch(/expect\(/);
    // And the braces that live inside the literals must be blanked, so they
    // cannot be mistaken for block delimiters.
    expect(only?.body, 'literal contents are blanked').not.toMatch(/\[\^}\]/);
  });

  it('CRITICAL the scan reaches the test corpus. The arm below reports an ABSENCE, so a broken walk returning nothing would satisfy it having examined no files — the exact false green this guard exists to prevent, and the failure mode the first version of this scanner actually had.', () => {
    const count = ROOTS.reduce((n, r) => n + testFiles(resolve(REPO_ROOT, r)).length, 0);
    // V-1992 — floor raised to just under the measured 3055; it stood at 2500,
    // so this scan could have lost 18% of its corpus and still reported the
    // absence below as checked rather than not looked.
    expect(count, 'test files walked under apps/ and packages/').toBeGreaterThan(2750);
  });

  it('CRITICAL no arm puts every one of its assertions behind a conditional. Such an arm passes while checking nothing the moment the condition goes false — which happened to eleven arms in this repo: four doc-parity gates that retired when their feature shipped, two named for a wait barrier that passed with every wait barrier deleted, and two seeded loops one seed away from comparing nothing. Declare a genuine exception with a `vacuity-exempt:` comment and a reason at the site.', () => {
    expect(
      hiddenArms(),
      'these arms report a pass without necessarily asserting anything:',
    ).toEqual([]);
  });
});
