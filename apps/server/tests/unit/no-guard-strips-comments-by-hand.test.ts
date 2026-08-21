// V-1258 — the guard for the class V-1254, V-1256 and V-1257 fixed by hand.
//
// Nine test files carried their own block-comment regex. `tests/unit/_helpers/code-only.ts` exists
// for exactly this job and its header explains, at length, why the obvious one-liner is wrong. The
// private copies were wrong in three separate ways, each measured on real files:
//
//   block-first  `/\*[\s\S]*?\*\//` runs before line comments, so the `/*` in
//                `// AI-D — /v1/agent-sessions/* routes` opens a comment that closes far below.
//                That file lost all 61 of its imports; three guards were scanning an empty string
//                and reporting nothing wrong (V-1256).
//   line-first   dodges that, but strips `//` inside string literals too, truncating a URL
//                mid-token. Not currently damaging, which is luck rather than design (V-1258).
//   line drift   deleting a block comment collapses the lines it spanned, so a reported
//                `file:line` names a line that does not contain the finding — measured at eleven
//                lines off (V-1254).
//
// Fixing nine by hand and stopping is how the positional-cursor class survived: the fix existed in
// one file under a comment labelled "FIX 3" and nobody swept the rest. So: a guard.
//
// IT SCANS WITH `codeOnly` ITSELF. Twice while enumerating this class by grep I matched the regex
// inside PROSE — once in a guard whose comment explains that it deliberately does not strip, and
// which therefore is not a violation at all. A guard for "do not hand-roll this" that cannot tell
// code from a comment about code would be the joke telling itself.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { codeOnly } from './_helpers/code-only.js';

const TESTS = resolve(import.meta.dirname, '..');

/**
 * Files allowed to strip comments themselves, each with the reason. The list may only shrink.
 *
 * A file earns a place here only by being unable to use `codeOnly` — not by being inconvenient to
 * change. Both current entries are about the LANGUAGE being stripped, not about effort.
 */
// `code-only.ts` itself is deliberately NOT listed. It is a hand-written scanner, not a
// regex stripper, so the signature does not match it — and the staleness arm below said so
// the first time this guard ran, on an entry added out of caution rather than evidence.
const ALLOWED = new Map<string, string>([
  [
    'unit/migrations-destructive-statements-are-declared.test.ts',
    'strips SQL, where /* */ and -- are the comment forms; codeOnly models TypeScript',
  ],
]);

/** The hand-rolled block-comment pass, in the shapes it is actually written in. */
const HAND_ROLLED = /\/\\\*\[\\s\\S\]\*\?\\\*\\\//;

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) acc.push(full);
  }
  return acc;
}

interface Hit {
  rel: string;
  line: number;
  text: string;
}

/** Hand-rolled comment stripping in CODE, never in a comment about it. */
function handRolledStrippers(src: string, rel: string): Hit[] {
  const out: Hit[] = [];
  for (const [i, line] of codeOnly(src).split('\n').entries()) {
    if (HAND_ROLLED.test(line)) out.push({ rel, line: i + 1, text: line.trim().slice(0, 76) });
  }
  return out;
}

describe('no guard strips comments by hand', () => {
  it('CRITICAL the scan reaches the test tree and still recognises a hand-rolled stripper. A guard reporting zero because its signature stopped matching reads exactly like one reporting zero because the class is gone.', () => {
    expect(walk(TESTS).length, 'no test files were found to scan').toBeGreaterThan(100);

    const control =
      "  return src.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '').replace(/\\/\\/[^\\n]*/g, '');";
    expect(
      handRolledStrippers(control, 'control.ts').length,
      'the signature no longer detects a hand-rolled stripper',
    ).toBe(1);
  });

  it('CRITICAL a comment ABOUT the pattern is not a violation. Two of my three enumerations of this class were wrong, and one of them flagged a guard whose comment explains that it deliberately does not strip comments — the opposite of an offender. Scanning raw source would re-make that mistake every run.', () => {
    const prose = [
      '// A naive `/\\*[\\s\\S]*?\\*\\//` strip swallowed fourteen real reads here, so this',
      '// file deliberately does NOT strip comments.',
      'const reads = countEnvReads(src);',
    ].join('\n');
    expect(
      handRolledStrippers(prose, 'prose.ts'),
      'a comment about the pattern was counted as the pattern',
    ).toEqual([]);
  });

  it('CRITICAL no test file strips comments by hand. `code-only.ts` models line comments, string literals and regex literals, and preserves line numbers; a private copy gets at least one of those wrong, and the failure is silent — the guard keeps passing while it scans a file it has blanked.', () => {
    const flagged = walk(TESTS)
      .map((full) => ({ full, rel: full.slice(TESTS.length + 1) }))
      .filter(({ rel }) => !ALLOWED.has(rel))
      .flatMap(({ full, rel }) => handRolledStrippers(readFileSync(full, 'utf8'), rel));

    expect(
      flagged.map((h) => `${h.rel}:${String(h.line)}  ${h.text}`),
      'hand-rolled comment stripping — call codeOnly from tests/unit/_helpers/code-only.ts, or ' +
        'add the file to ALLOWED with the reason codeOnly cannot serve it',
    ).toEqual([]);
  });

  it('CRITICAL every ALLOWED entry still names a file that stands out. An exemption for a file that no longer strips anything, or that has been renamed away, is a licence nobody is using and it hides the next file that needs looking at.', () => {
    const stale = [...ALLOWED.keys()]
      .filter((rel) => {
        try {
          return handRolledStrippers(readFileSync(resolve(TESTS, rel), 'utf8'), rel).length === 0;
        } catch {
          return true; // missing file — equally stale
        }
      })
      .sort();
    expect(stale, 'stale exemption(s) — remove them').toEqual([]);
  });
});
