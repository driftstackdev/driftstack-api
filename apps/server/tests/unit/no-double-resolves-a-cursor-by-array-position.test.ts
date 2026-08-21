// V-1243 — the guard for the class V-1237, V-1241 and V-1242 kept finding by hand.
//
// Six in-memory doubles resolved a pagination cursor with `findIndex` inside the array they had
// already filtered, then sliced from that index. Every Drizzle repo looks the cursor row up by id —
// scoped to the tenancy filter only — and selects rows strictly after it.
//
// `findIndex` returns -1 the moment the cursor row stops passing the filter, and the slice read
// that as "start from the top". Page two comes back as page one. The trigger is never an error: a
// key revoked, a session finishing, an override expiring, an account suspended, a row purged.
//
// The fix existed in this repository for a long time — the profiles double carries it under a
// comment labelled "FIX 3" — and was applied to one double while five others kept the defect. That
// is what this guard is for. Finding the class by hand a fourth time is not a plan.
//
// WHY THE SIGNATURE AND NOT "must import keysetPage": three doubles page correctly with cursor
// shapes the shared helper does not model — a composite `{ startedAt, id }` object, a delivery
// cursor with a legacy created_at-only form, and an anchor variant in profiles. Requiring the
// helper would mean churning correct code to satisfy a test. The defect has its own signature, so
// the guard looks for that instead.

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { codeOnly } from './_helpers/code-only.js';

const HELPERS = resolve(import.meta.dirname, '../integration/_helpers');

/**
 * V-1254 — comment stripping is the SHARED scanner, not a private regex.
 *
 * Comments FIRST: every one of these doubles now carries a comment explaining the defect it used
 * to have, and those comments say `findIndex` next to the word `cursor`. A scanner that reads raw
 * source reports the explanations as the defect, so an audit that cannot tell code from prose
 * measures nothing.
 *
 * This used to be a two-`replace` one-liner here. It was wrong twice over, and `code-only.ts`
 * already says so in its own header: the block-comment pass runs first and has no idea a `/*`
 * inside a LINE comment is not an opener, and it modelled neither string nor regex literals. It
 * also DELETED block comments outright, so the line numbers this guard reports drifted by the
 * height of the comments above each hit — the reported line for a regression planted in the
 * snapshots double was 60 where the truth was 71.
 */

interface Hit {
  file: string;
  line: number;
  text: string;
}

/** A positional cursor resolution: `findIndex`/`indexOf` with `cursor` within a few lines. */
function positionalCursorHits(src: string, file: string): Hit[] {
  const lines = codeOnly(src).split('\n');
  const out: Hit[] = [];
  for (const [i, line] of lines.entries()) {
    if (!/\b(?:findIndex|indexOf)\s*\(/.test(line)) continue;
    // The cursor may be named on the same line or in the predicate just below it.
    const window = lines.slice(Math.max(0, i - 2), i + 4).join('\n');
    if (/\bcursor\b/i.test(window)) out.push({ file, line: i + 1, text: line.trim().slice(0, 90) });
  }
  return out;
}

function doubles(): string[] {
  return readdirSync(HELPERS).filter((f) => f.startsWith('in-memory-') && f.endsWith('.ts'));
}

describe('no in-memory double resolves a pagination cursor by array position', () => {
  it('CRITICAL the scan reaches the doubles at all and can still see a positional cursor. Without this the arm below passes just as happily against an empty directory listing or a signature that no longer matches anything — a guard reporting zero because it looked nowhere is indistinguishable from a guard reporting zero because the defect is gone.', () => {
    const files = doubles();
    expect(files.length, 'no in-memory doubles were found to scan').toBeGreaterThan(20);

    const control = [
      'let rows = all.filter((r) => r.accountId === id);',
      'const idx = rows.findIndex((r) => r.id === opts.cursor);',
      'if (idx >= 0) rows = rows.slice(idx + 1);',
    ].join('\n');
    expect(
      positionalCursorHits(control, 'control.ts').length,
      'the signature no longer detects the defect it was written for',
    ).toBe(1);
  });

  it('CRITICAL comments are stripped before scanning, so an explanation of the old defect is not counted as the defect. Every converted double now describes what it used to do, in prose containing both `findIndex` and `cursor`; a raw-source scan reports all of them and the guard becomes noise nobody can act on.', () => {
    const commentary = [
      '// This used to be an offset: findIndex inside the filtered array, resolving',
      '// the cursor by position, which returned -1 once the row left the filter.',
      '/* findIndex(cursor) — the old shape, kept here for context. */',
      'const page = keysetPage({ anchorSet, rows, cursor, limit, id, at });',
    ].join('\n');
    expect(
      positionalCursorHits(commentary, 'commentary.ts'),
      'prose describing the defect was counted as the defect',
    ).toEqual([]);
  });

  it('CRITICAL a reported line number is the REAL line number, even when a block comment sits above the hit. Deleting comments rather than blanking them collapses the lines they spanned, so the guard names a line that does not contain the defect — and the file:line is the only part of this output anybody acts on. Every double here opens with a block comment, so the drift applied to essentially all of them.', () => {
    const src = [
      'const a = 1;',
      '/* a block',
      '   spanning',
      '   four lines */',
      'const idx = rows.findIndex((r) => r.id === cursor);',
    ].join('\n');
    const hits = positionalCursorHits(src, 'lines.ts');
    expect(hits.length, 'the control snippet was not detected at all').toBe(1);
    expect(hits[0]?.line, 'the reported line drifted by the height of the block comment').toBe(5);
  });

  it('CRITICAL no double resolves a cursor by array position. The Drizzle side pages by keyset and lets the cursor row leave the visible page; a positional resolution silently restarts at the top instead, which the caller sees as rows it has already been given rather than as an error.', () => {
    const hits = doubles().flatMap((f) =>
      positionalCursorHits(readFileSync(resolve(HELPERS, f), 'utf8'), f),
    );
    expect(
      hits.map((h) => `${h.file}:${String(h.line)}  ${h.text}`),
      'positional cursor resolution — use keysetPage, or a composite comparison against the ' +
        'cursor row resolved from the TENANCY-scoped set',
    ).toEqual([]);
  });
});
