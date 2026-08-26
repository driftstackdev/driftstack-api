// V-858 — a V-number is a citation target, so it has to resolve to one finding.
//
// `docs/verification-log.md` is append-only and cited from source and test files
// by bare number. V-856 found the number V-759 carrying two unrelated findings —
// a retraction of V-748 and the privacy §9 retention implementation — so a
// reader following a citation reaches whichever heading they hit first.
//
// V-856 also got the surrounding census wrong in every figure it reported, which
// is why this guard measures instead of restating:
//
//   • It said 800 headings. There are 844 lines beginning `## V-`.
//   • It said 783 distinct. 783 is the count of headings in the canonical
//     `## V-<n> ` form; of those, 779 numbers are distinct.
//   • It said nine numbers repeat. Among canonical headings, three do: V-219,
//     V-535, V-759. Flattening the 61 suffixed headings (`V-068.1`, `V-184a`,
//     `V-202b/c/d`, `V-214b`, …) onto their base integers gives 28, of which 25
//     exist only because of that flattening. Nine matched no population.
//
// And it was wrong about the harm. It claimed four test files split two-and-two
// across the two V-759 entries. Nine files cite V-759 — six tests and three
// source modules — and every one means the retention implementation. Nothing
// cites the retraction. V-856 attributed citations from their filenames without
// opening them; `the-retention-audit-does-not-outlive-its-findings` says "V-759
// landed retention-scrub-sweeper.ts", which is the implementation.
//
// That is three consecutive corrections of my own claims in this arc (V-831 on
// V-822, V-836 on V-835, this on V-856), all the same shape: a number or a split
// reported from a derivation nobody re-ran. So this file derives the census from
// the log on every run. A new heading that reuses a number fails here, and a
// number whose two entries are unrelated has to carry a note that tells a reader
// which one they want.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LOG = resolve(REPO_ROOT, 'docs/verification-log.md');
/**
 * V-1215 — the log was split on 2026-08-20: entries through V-1200 moved to a frozen archive
 * because Prettier could no longer parse a 3.4 MB markdown file under the pre-commit hook's 8 GB
 * heap. The uniqueness invariant spans the WHOLE history, not the live tail, so every arm below
 * reads both halves. Reading only the live file would have let a number be reused the moment its
 * first use aged into the archive — which is precisely when a reader is least able to notice.
 *
 * V-1707 — it happened a SECOND time on 2026-08-26 (V-1201..V-1499 to a second archive), which is
 * the tell that archives are a growing set and not a pair. They are DISCOVERED by name now, so the
 * next split is covered the day it lands rather than the day someone remembers this file. The
 * `CRITICAL` arm below exists because the failure mode of discovery is silence: a regex that
 * matches nothing yields an empty list, and the uniqueness check would then pass by reading the
 * live tail alone — green, and blind to every number it was written to protect.
 */
function archives(): string[] {
  return readdirSync(resolve(REPO_ROOT, 'docs'))
    .filter((f) => /^verification-log-archive-through-v\d+\.md$/.test(f))
    .sort()
    .map((f) => resolve(REPO_ROOT, 'docs', f));
}

/** Every half, concatenated. Archives are frozen; the live file is where entries are appended. */
function wholeLog(): string {
  return [...archives().map((a) => readFileSync(a, 'utf8')), readFileSync(LOG, 'utf8')].join('\n');
}

interface Shared {
  /** Why more than one heading carries this number. */
  readonly reason: string;
  /**
   * True when the entries are unrelated findings, so a citation is genuinely
   * ambiguous and the log must carry a note resolving it. False when the
   * headings are self-evidently the same topic, where a note would be noise.
   */
  readonly needsNote: boolean;
}

/**
 * Numbers carried by more than one canonical heading. Every entry is a
 * statement that somebody looked, not that a duplicate was tolerable.
 */
const SHARED_NUMBERS: Record<number, Shared> = {
  219: {
    reason:
      'one V-219 entry plus two that label themselves "V-219 family" — a continuation series ' +
      'on the visual-consistency audit, not a collision. A reader sees the relationship in the ' +
      'heading itself.',
    needsNote: false,
  },
  535: {
    reason:
      'README sanitization, first pass and pass-2, across two waves. One topic, so a citation ' +
      'reaching either entry lands somewhere useful.',
    needsNote: false,
  },
  759: {
    reason:
      'two unrelated findings: the V-748 retraction, and the privacy §9 retention windows ' +
      'implemented as anonymisation. All nine citations in the codebase mean the second, but ' +
      'the number cannot resolve on its own, so the log carries a disambiguation note.',
    needsNote: true,
  },
};

/** Headings in the canonical `## V-<n> ` form, as [number, heading] pairs. */
function canonicalHeadings(): Array<readonly [number, string]> {
  return wholeLog()
    .split('\n')
    .map((l) => /^## V-(\d+) /.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [Number(m[1]), m[0]] as const);
}

function duplicatedNumbers(): number[] {
  const seen = new Map<number, number>();
  for (const [n] of canonicalHeadings()) seen.set(n, (seen.get(n) ?? 0) + 1);
  return [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([n]) => n)
    .sort((a, b) => a - b);
}

describe('V-858 a verification-log number resolves to one finding', () => {
  it('CRITICAL the log really parses into headings. Both arms below compare sets, so an empty parse would report no duplicates over no entries — the shape this guard exists because V-856 shipped.', () => {
    const found = archives();
    expect(
      found.length,
      'archives discovered by name — an empty list narrows every arm below to the live tail while still reporting green',
    ).toBeGreaterThanOrEqual(2);
    expect(
      found.reduce((n, a) => n + statSync(a).size, 0) + statSync(LOG).size,
      'the log file (every archive + live)',
    ).toBeGreaterThan(500_000);
    expect(canonicalHeadings().length, 'canonical `## V-<n> ` headings').toBeGreaterThan(700);

    // Known positives, one per half: V-001 exists only in the first archive, V-1201 only in the
    // second, V-1500 only in the live file — so a discovery that dropped any half fails here
    // rather than passing quietly on a smaller log than it claims to read.
    const whole = wholeLog();
    for (const anchor of ['## V-001 ', '## V-1201 ', '## V-1500 ']) {
      expect(whole.includes(anchor), `${anchor.trim()} is missing from the assembled log`).toBe(
        true,
      );
    }
  });

  it('CRITICAL every number carried by more than one heading is declared with a reason. A V-number is how source and test files cite a finding; reusing one silently makes those citations unresolvable, and the log is append-only so it cannot be fixed by renumbering later.', () => {
    const undeclared = duplicatedNumbers().filter((n) => SHARED_NUMBERS[n] === undefined);
    expect(
      undeclared,
      'this number is on more than one heading. Give the new entry its own number, or declare it here with the reason a citation can still be resolved:',
    ).toEqual([]);
  });

  it('CRITICAL every declared number is still shared, so the roster cannot outlive its reasons. Without this arm the list quietly becomes a set of numbers nobody rechecked — the blindfold shape V-802 names and V-847 guards against on its own roster.', () => {
    const dupes = new Set(duplicatedNumbers());
    const stale = Object.keys(SHARED_NUMBERS)
      .map(Number)
      .filter((n) => !dupes.has(n));
    expect(stale, 'declared as shared but only one heading carries it — delete the entry:').toEqual(
      [],
    );
  });

  it('CRITICAL a number whose entries are unrelated carries a note telling a reader which one they want. This is the V-759 case and the only one that damages a citation: two findings with nothing in common behind one number. The note is the whole remedy available, since append-only rules renumbering out.', () => {
    const log = wholeLog();
    const missing = Object.entries(SHARED_NUMBERS)
      .filter(([, v]) => v.needsNote)
      .map(([n]) => Number(n))
      .filter(
        (n) =>
          !new RegExp(
            `> \\*\\*Disambiguation \\(V-\\d+[^)]*\\)\\.\\*\\* The number V-${String(n)} `,
          ).test(log),
      );

    expect(
      missing,
      'this number has unrelated entries and no disambiguation note resolving it:',
    ).toEqual([]);
  });
});
