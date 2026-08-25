// W717 — recapture-automation dedupKey NUL-byte delimiter parity.
// Forty-fourth in the cross-SDK drift-guard series (W649 + W675-
// W717).
//
// Pins packages/recapture-automation/src/matrix.ts dedupKey() as
// using a LITERAL 0x00 NUL byte as the field delimiter — NOT a
// space, comma, or other printable character.
//
// Why NUL: dedupKey concatenates 4 fields (surfaceId + outcome +
// baselineValue + recapturedValue) into a single string used as a
// Set key. Any printable separator (space, ',', '.') can appear
// INSIDE a baselineValue (e.g. a fingerprint string that legitimately
// contains commas). Using a NUL byte makes collisions structurally
// impossible — no valid customer-data field carries 0x00 bytes
// (they are stripped at API ingress by Fastify's JSON parser).
//
// CRITICAL invariant: drift to a printable delimiter would let
// adversarially-shaped baselineValue + recapturedValue tuples
// collide in the dedup set — e.g. `{ baseline: 'a b', recaptured:
// 'c' }` vs `{ baseline: 'a', recaptured: 'b c' }` both produce
// 'surfaceId.outcome.a b.c' under a dot-separator. NUL-byte
// separator prevents this.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const MATRIX = resolve(REPO_ROOT, 'packages/recapture-automation/src/matrix.ts');

describe('W717 recapture-automation dedupKey NUL-byte delimiter parity', () => {
  it('matrix.ts file exists', () => {
    expect(existsSync(MATRIX), `missing ${MATRIX}`).toBe(true);
  });

  it("CRITICAL dedupKey() join delimiter is the LITERAL 0x00 NUL byte (NOT a space, NOT a comma, NOT a dot). Drift to a printable separator would let adversarially-shaped baselineValue + recapturedValue tuples collide. The byte between the two single-quotes in `.join('X')` MUST be 0x00.", () => {
    // Read the matrix.ts file as raw bytes so the NUL byte survives.
    const buf = readFileSync(MATRIX);
    // Look for the byte pattern: `].join('` + 0x00 + `')`
    // ASCII codes: 0x5d 0x2e 0x6a 0x6f 0x69 0x6e 0x28 0x27 0x00 0x27 0x29
    const pattern = Buffer.from([
      0x5d, // ]
      0x2e, // .
      0x6a, // j
      0x6f, // o
      0x69, // i
      0x6e, // n
      0x28, // (
      0x27, // '
      0x00, // NUL byte (delimiter)
      0x27, // '
      0x29, // )
    ]);
    expect(buf.includes(pattern), 'NUL-byte delimiter inside .join(...) pattern').toBe(true);
  });

  it('CRITICAL UTF-8 string-level: dedupKey body matches the canonical 4-field tuple shape with `\\x00` separator. Read returns the file as UTF-8; the NUL byte survives as `\\x00`.', () => {
    const src = read(MATRIX);
    // The dedupKey body — 4 fields joined with \x00 (build via String.fromCharCode to
    // avoid embedding the NUL byte directly in the source — ESLint flags
    // \x00 control characters in regex literals via no-control-regex).
    const nul = String.fromCharCode(0);
    const nulPattern = `function dedupKey\\(c: FingerprintComparison\\): string \\{\\s*\\n?\\s*return \\[c\\.surfaceId, c\\.outcome, c\\.baselineValue \\?\\? '', c\\.recapturedValue \\?\\? ''\\]\\.join\\('${nul}'\\);\\s*\\n?\\s*\\}`;
    expect(src).toMatch(new RegExp(nulPattern));
  });

  it("CRITICAL 4-tuple dedupKey field roster pinned — surfaceId + outcome + baselineValue + recapturedValue. The 4 fields are what carry the semantic identity of a comparison; drift to dropping outcome (e.g.) would let 'match' and 'diff' for the same surface collapse into one row.", () => {
    const src = read(MATRIX);
    // All 4 fields appear in the dedupKey() body.
    expect(src).toMatch(/c\.surfaceId/);
    expect(src).toMatch(/c\.outcome/);
    expect(src).toMatch(/c\.baselineValue \?\? ''/);
    expect(src).toMatch(/c\.recapturedValue \?\? ''/);
  });

  it("CRITICAL nullish-coalesce default-to-empty-string pinned on baselineValue + recapturedValue (`?? ''`). Drift to `?? null` or `String(...)` would let `null` collide with `'null'` (string).", () => {
    const src = read(MATRIX);
    expect(src).toMatch(/c\.baselineValue \?\? ''/);
    expect(src).toMatch(/c\.recapturedValue \?\? ''/);
  });

  it('CRITICAL dedupKey docstring framing pinned — "notes and other free-form fields are dropped from the dedup key — they may differ by run timestamp / capture environment without changing the semantic outcome". The drop-notes-from-key invariant is what lets multiple runs of the same surface collapse to one entry.', () => {
    const src = read(MATRIX);
    expect(src).toMatch(/`notes` and\s*\*\s*other free-form fields are dropped from the dedup key/);
    expect(src).toMatch(
      /they may differ\s*\*\s*by run timestamp \/ capture environment without changing the semantic\s*\*\s*outcome/,
    );
  });

  it('CRITICAL dedupComparisons stable-wrt-input-order pinned — "first occurrence of each dedup key wins; subsequent duplicates are dropped. Stable wrt input order". Drift to last-wins would silently change which run\'s row survives.', () => {
    const src = read(MATRIX);
    expect(src).toMatch(/first occurrence of each dedup key/);
    expect(src).toMatch(/wins; subsequent duplicates are dropped/);
    expect(src).toMatch(/Stable wrt input order/);
  });

  it('CRITICAL V-533.A anchor pinned — "capture-matrix runner + dedup. First sub-slice of V-533 per the anti-substitution clause". The anchor threads the matrix-layer slice provenance.', () => {
    const src = read(MATRIX);
    expect(src).toMatch(/V-533\.A — capture-matrix runner \+ dedup/);
    expect(src).toMatch(/First sub-slice of V-533 per the anti-substitution clause/);
  });

  it('CRITICAL cross-agent-contract framing pinned. The doc reference tells engineers Agent 1 + Agent 2 are coordinating via the contract doc; drift to dropping the reference would lose the cross-agent provenance.', () => {
    const src = read(MATRIX);
    expect(src).toMatch(/Cross-agent contract:/);
    expect(src).toMatch(/docs\/internal\/v533-cross-agent-contract\.md/);
  });

  it('CRITICAL expandCaptureMatrix at-least-1-archetype guard pinned — `if (spec.archetypeIds.length === 0) { throw new Error(...) }`. Drift to allowing zero archetypes would let a no-op matrix run silently fan out to nothing.', () => {
    const src = read(MATRIX);
    expect(src).toMatch(
      /if \(spec\.archetypeIds\.length === 0\) \{\s*throw new Error\('expandCaptureMatrix: archetypeIds must contain at least 1 entry'\);/,
    );
  });

  it("CRITICAL groupComparisonsByCategory uses .indexOf('.') for the category prefix. Drift to `.split('.')` would over-allocate; drift to dropping the indexOf fallback (-1 means whole surfaceId is category) would error on surfaceIds without a dot.", () => {
    const src = read(MATRIX);
    expect(src).toMatch(/const dotIndex = c\.surfaceId\.indexOf\('\.'\);/);
    expect(src).toMatch(
      /const category = dotIndex === -1 \? c\.surfaceId : c\.surfaceId\.slice\(0, dotIndex\);/,
    );
  });

  it('CRITICAL ComparisonSummary 6-field shape pinned — total + matchCount + diffCount + errorCount + newSurfaceCount + missingSurfaceCount. The 6-bucket roster matches the 5 FingerprintComparisonOutcome values + total. Drift to dropping any bucket would silently mis-render the per-archetype pivot.', () => {
    const src = read(MATRIX);

    expect(src).toMatch(/export interface ComparisonSummary \{/);
    expect(src).toMatch(/total: number;/);
    expect(src).toMatch(/matchCount: number;/);
    expect(src).toMatch(/diffCount: number;/);
    expect(src).toMatch(/errorCount: number;/);
    expect(src).toMatch(/newSurfaceCount: number;/);
    expect(src).toMatch(/missingSurfaceCount: number;/);
  });

  it('CRITICAL 5-outcome switch coverage pinned in summarizeComparisons — match + diff + capture_error + new_surface + missing_surface. The 5-case switch matches FingerprintComparisonOutcome 5-value enum; drift to dropping a case would silently miss-count.', () => {
    const src = read(MATRIX);

    const outcomes = ['match', 'diff', 'capture_error', 'new_surface', 'missing_surface'];
    for (const outcome of outcomes) {
      expect(src, `outcome case '${outcome}'`).toMatch(new RegExp(`case '${outcome}':`));
    }
  });

  it('Server matrix.ts 5-invariant cluster — V-533.A anchor + dedupKey NUL-byte + 4-tuple dedup field roster + drop-notes-from-key + 1-archetype-minimum guard + ComparisonSummary 6-field shape. Drift on any would fragment the recapture-automation matrix layer.', () => {
    const buf = readFileSync(MATRIX);
    const src = buf.toString('utf8');

    // NUL byte pattern in raw bytes.
    expect(
      buf.includes(Buffer.from([0x6a, 0x6f, 0x69, 0x6e, 0x28, 0x27, 0x00, 0x27])),
      'NUL byte inside .join(',
    ).toBe(true);

    expect(src).toMatch(/V-533\.A/);
    expect(src).toMatch(/c\.surfaceId/);
    expect(src).toMatch(/dropped from the dedup key/);
    expect(src).toMatch(/at least 1 entry/);
    expect(src).toMatch(/interface ComparisonSummary/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/recapture-dedup-key-nul-byte-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
