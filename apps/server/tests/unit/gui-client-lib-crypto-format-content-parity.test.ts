// W464.B — drift guard for apps/gui-client/src/lib/crypto-format.ts.
// V-534.AF shared crypto-orders view formatting. Drift here either
// drops the cents/100 division on formatCents (price displays
// 100x too high — "1995 USD" instead of "19.95 USD") or changes the
// formatRelative bucket thresholds (UI shows "0d ago" for events
// 23 hours old, makes the history view look broken).
//
//   • V-534.AF framing pinned: 'shared formatting helpers for the
//     crypto-orders view family. Previously each view (history,
//     detail, checkout flow, receipt) declared its own local
//     `formatCents` / `formatRelative` helpers; this module
//     consolidates them.'
//   • formatCents: `${(cents / 100).toFixed(2)} ${currency}` exact.
//   • formatRelative: 'now' override test-seam framing 'Optional
//     now override is for tests; production callers pass nothing.'
//   • formatRelative 4-bucket: <60_000 → 'just now'; <60*60_000
//     → 'Xm ago'; <24*60*60_000 → 'Xh ago'; else → 'Xd ago'.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/crypto-format.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W464.B apps/gui-client/src/lib/crypto-format.ts content parity', () => {
  const body = read(LIB);

  it("V-534.AF framing pinned: 'V-534.AF — shared formatting helpers for the crypto-orders view family. Previously each view (history, detail, checkout flow, receipt) declared its own local `formatCents` / `formatRelative` helpers; this module consolidates them.'", () => {
    expect(body).toMatch(
      /\/\/ V-534\.AF — shared formatting helpers for the crypto-orders view\s*\/\/ family\. Previously each view \(history, detail, checkout flow, receipt\)\s*\/\/ declared its own local `formatCents` \/ `formatRelative` helpers; this\s*\/\/ module consolidates them\./,
    );
  });

  it('formatCents: `${(cents / 100).toFixed(2)} ${currency}` exact (cents/100 division + toFixed(2) precision + space-separated currency code)', () => {
    expect(body).toMatch(
      /export function formatCents\(cents: number, currency: string\): string \{\s*return `\$\{\(cents \/ 100\)\.toFixed\(2\)\} \$\{currency\}`;\s*\}/,
    );
  });

  it('formatRelative JSDoc framing pinned: \'"5m ago" / "2h ago" / "3d ago" relative formatting against `Date.now()`. Optional `now` override is for tests; production callers pass nothing.\'', () => {
    expect(body).toMatch(
      /\*\s*"5m ago" \/ "2h ago" \/ "3d ago" relative formatting against `Date\.now\(\)`\.\s*\*\s*Optional `now` override is for tests; production callers pass nothing\./,
    );
  });

  it("formatRelative 4-bucket cascade pinned: <60_000 → 'just now'; <60*60_000 → 'Xm ago' (floor(ago/60_000)); <24*60*60_000 → 'Xh ago' (floor(ago/(60*60_000))); else → 'Xd ago' (floor(ago/(24*60*60_000)))", () => {
    expect(body).toMatch(
      /export function formatRelative\(iso: string, now: number = Date\.now\(\)\): string \{\s*const then = new Date\(iso\)\.getTime\(\);\s*const ago = now - then;\s*if \(ago < 60_000\) return 'just now';\s*if \(ago < 60 \* 60_000\) return `\$\{Math\.floor\(ago \/ 60_000\)\.toString\(\)\}m ago`;\s*if \(ago < 24 \* 60 \* 60_000\) return `\$\{Math\.floor\(ago \/ \(60 \* 60_000\)\)\.toString\(\)\}h ago`;\s*return `\$\{Math\.floor\(ago \/ \(24 \* 60 \* 60_000\)\)\.toString\(\)\}d ago`;\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
