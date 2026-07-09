// W476.A — drift guard for apps/gui-client/src/components/CryptoOrderSummaryCard.tsx.
// V-534.AF presentational summary card + V-534.BF V-666.AV
// expires_at countdown row. Drift here either drops the
// nowFn ?? Date.now test seam (countdown row becomes non-
// deterministic in unit tests so the 'pay window elapsed' /
// 'minutes remaining' branches can't be exercised) or breaks
// the showExpiry triple-guard (status === 'pending' && typeof
// expires_at === 'string' && length > 0 — without all three a
// paid order with stale expires_at on the wire would render
// 'Pay by' row when payment already cleared).
//
//   • V-534.AF framing pinned: 'presentational summary card for
//     a single crypto order.' + V-534.BF framing 'surfaces V-666
//     .AV expires_at as a human-readable "pay before X"
//     countdown row when the order is pending.'
//   • CryptoOrderSummaryCardProps 3-field: order +
//     footer?: React.ReactNode + nowFn? testing-seam Default
//     Date.now.
//   • describeExpiry pure: diff <= 0 → 'pay window elapsed' +
//     minutes < 1 → 'less than a minute remaining' + minutes < 60
//     → `${minutes}m remaining` + otherwise `${hours}h ${rem}m
//     remaining`.
//   • showExpiry triple-guard: status==='pending' &&
//     typeof expires_at==='string' && length>0.
//   • payment_id !== null conditional row + Pay by row only
//     when showExpiry true + (nowFn ?? Date.now)() invocation
//     so default-to-Date.now happens at render time, not
//     module-load.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/components/CryptoOrderSummaryCard.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W476.A apps/gui-client/src/components/CryptoOrderSummaryCard.tsx content parity', () => {
  const body = read(LIB);

  it("V-534.AF framing pinned: 'V-534.AF — presentational summary card for a single crypto order.' + V-534.BF framing 'V-534.BF — surfaces V-666.AV expires_at as a human-readable \"pay before X\" countdown row when the order is pending.' + 'Replaces the inline <dl> block previously embedded in CryptoOrderDetailView. Pure presentational; no fetching, no actions. Callers compose this with cancel buttons / receipt panels around it.'", () => {
    expect(body).toMatch(
      /\/\/ V-534\.AF — presentational summary card for a single crypto order\./,
    );
    expect(body).toMatch(
      /\/\/ V-534\.BF — surfaces V-666\.AV expires_at as a human-readable\s*\n?\s*\/\/\s+"pay before X" countdown row when the order is pending\./,
    );
    expect(body).toMatch(
      /\/\/ Replaces the inline <dl> block previously embedded in\s*\n?\s*\/\/ CryptoOrderDetailView\. Pure presentational; no fetching, no actions\.\s*\n?\s*\/\/ Callers compose this with cancel buttons \/ receipt panels around it\./,
    );
  });

  it("CryptoOrderSummaryCardProps 3-field: order: CryptoOrderData + footer? React.ReactNode 'Optional content rendered below the summary fields (cancel button, etc.).' + nowFn? V-534.BF 'testing seam so the countdown is deterministic. Defaults to Date.now.'", () => {
    expect(body).toMatch(
      /export interface CryptoOrderSummaryCardProps \{\s*\n?\s*order: CryptoOrderData;\s*\n?\s*\/\*\* Optional content rendered below the summary fields \(cancel button, etc\.\)\. \*\/\s*\n?\s*footer\?: React\.ReactNode;\s*\n?\s*\/\*\* V-534\.BF — testing seam so the countdown is deterministic\. Defaults to Date\.now\. \*\/\s*\n?\s*nowFn\?: \(\) => number;\s*\n?\s*\}/,
    );
  });

  it("describeExpiry pure: diff <= 0 → 'pay window elapsed' early-return + minutes < 1 → 'less than a minute remaining' + minutes < 60 → `${minutes}m remaining` + otherwise hours+rem decomposition `${hours}h ${rem}m remaining`; all toString() casts present (explicit number-to-string)", () => {
    expect(body).toMatch(
      /function describeExpiry\(expiresAtIso: string, nowMs: number\): string \{\s*\n?\s*const expiresMs = new Date\(expiresAtIso\)\.getTime\(\);\s*\n?\s*const diff = expiresMs - nowMs;\s*\n?\s*if \(diff <= 0\) return 'pay window elapsed';\s*\n?\s*const minutes = Math\.floor\(diff \/ \(60 \* 1000\)\);\s*\n?\s*if \(minutes < 1\) return 'less than a minute remaining';\s*\n?\s*if \(minutes < 60\) return `\$\{minutes\.toString\(\)\}m remaining`;\s*\n?\s*const hours = Math\.floor\(minutes \/ 60\);\s*\n?\s*const rem = minutes % 60;\s*\n?\s*return `\$\{hours\.toString\(\)\}h \$\{rem\.toString\(\)\}m remaining`;\s*\n?\s*\}/,
    );
  });

  it("showExpiry triple-guard: status === 'pending' && typeof order.expires_at === 'string' && order.expires_at.length > 0 — pinned so a paid order with stale expires_at on the wire doesn't render the 'Pay by' row", () => {
    expect(body).toMatch(
      /const showExpiry =\s*\n?\s*order\.status === 'pending' &&\s*\n?\s*typeof order\.expires_at === 'string' &&\s*\n?\s*order\.expires_at\.length > 0;/,
    );
  });

  it("Render shape: <section> rounded-md border + <header> with 'Order' h3 + order_id font-mono + CryptoOrderStatusBadge status delegation + <dl> grid-cols-2 + Product/Amount(formatCents)/payment_id conditional/Created/Updated rows; Pay by row only when showExpiry with (nowFn ?? Date.now)() invocation at render time + footer !== undefined conditional render", () => {
    expect(body).toMatch(
      /<h3 className="text-base font-semibold">Order<\/h3>\s*\n?\s*<p className="font-mono text-xs text-ink-secondary">\{order\.order_id\}<\/p>/,
    );
    expect(body).toMatch(/<CryptoOrderStatusBadge status=\{order\.status\} \/>/);
    expect(body).toMatch(/<dd>\{formatCents\(order\.price_cents, order\.price_currency\)\}<\/dd>/);
    expect(body).toMatch(
      /\{order\.payment_id !== null && \(\s*\n?\s*<>\s*\n?\s*<dt className="text-ink-secondary">Payment id<\/dt>\s*\n?\s*<dd className="font-mono text-xs">\{order\.payment_id\}<\/dd>\s*\n?\s*<\/>\s*\n?\s*\)\}/,
    );
    expect(body).toMatch(
      /\{showExpiry && \(\s*\n?\s*<>\s*\n?\s*<dt className="text-ink-secondary">Pay by<\/dt>\s*\n?\s*<dd>\s*\n?\s*<span>\{formatTimestamp\(order\.expires_at as string\)\}<\/span>\{' '\}\s*\n?\s*<span className="text-xs text-ink-secondary">\s*\n?\s*\(\{describeExpiry\(order\.expires_at as string, \(nowFn \?\? Date\.now\)\(\)\)\}\)\s*\n?\s*<\/span>\s*\n?\s*<\/dd>\s*\n?\s*<\/>\s*\n?\s*\)\}/,
    );
    expect(body).toMatch(/\{footer !== undefined && <div className="mt-4">\{footer\}<\/div>\}/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
