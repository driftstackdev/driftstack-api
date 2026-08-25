// W386.C — drift guard for gui-client CryptoOrderSummaryCard
// component source. Existing CryptoOrderSummaryCard.test.tsx covers
// render behavior; this guard pins the load-bearing V-534.AF/BF
// claims (V-666.AV expires_at countdown + pure-presentational
// posture). Used by CryptoOrderDetailView; pure component (no
// fetching, no actions).
//
//   • V-534.AF + V-534.BF framing pinned.
//   • V-666.AV expires_at countdown ("pay before X") only on
//     pending orders.
//   • describeExpiry: 4 branches (elapsed / <1 min / <60 min / hours+rem).
//   • Pure presentational (no fetching / no actions framing).
//   • Replaces inline <dl> from CryptoOrderDetailView (refactor
//     framing).
//   • Imports CryptoOrderStatusBadge + shared crypto formatters + CryptoOrderData.
//   • Optional footer slot + optional nowFn testing seam.
//   • <dl> 2-col grid: Product / Amount / Payment id (conditional)
//     / Created / Updated / Pay by (conditional).
//   • aria-: <header><h3>Order</h3> + font-mono order_id.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const COMPONENT = resolve(REPO_ROOT, 'apps/gui-client/src/components/CryptoOrderSummaryCard.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W386.C gui-client CryptoOrderSummaryCard content parity', () => {
  const body = read(COMPONENT);

  it('V-534.AF + V-534.BF framing pinned (V-666.AV expires_at countdown)', () => {
    expect(body).toMatch(/V-534\.AF — presentational summary card for a single crypto order/);
    expect(body).toMatch(/V-534\.BF — surfaces V-666\.AV expires_at as a human-readable/);
    expect(body).toMatch(/"pay before X" countdown row when the order is pending/);
  });

  it('"Replaces the inline <dl> block previously embedded in CryptoOrderDetailView" framing pinned', () => {
    expect(body).toMatch(
      /Replaces the inline <dl> block previously embedded in\s*\/\/\s*CryptoOrderDetailView\. Pure presentational; no fetching, no actions/,
    );
  });

  it('imports: CryptoOrderStatusBadge + shared crypto formatters + CryptoOrderData', () => {
    expect(body).toMatch(/import \{ CryptoOrderStatusBadge \} from '\.\/CryptoOrderStatusBadge';/);
    expect(body).toMatch(
      /import \{ formatCents, formatProduct, formatTimestamp \} from '\.\.\/lib\/crypto-format';/,
    );
    expect(body).toMatch(/import type \{ CryptoOrderData \} from '\.\.\/lib\/use-crypto-order';/);
  });

  it('Props: order required + optional footer slot + optional nowFn testing seam', () => {
    expect(body).toMatch(/order: CryptoOrderData;/);
    expect(body).toMatch(/footer\?: React\.ReactNode;/);
    expect(body).toMatch(
      /\/\*\* V-534\.BF — testing seam so the countdown is deterministic\. Defaults to Date\.now\. \*\//,
    );
    expect(body).toMatch(/nowFn\?: \(\) => number;/);
  });

  it('describeExpiry 4 branches: elapsed / <1 min / <60 min / hours+rem', () => {
    expect(body).toMatch(/if \(diff <= 0\) return 'pay window elapsed';/);
    expect(body).toMatch(/if \(minutes < 1\) return 'less than a minute remaining';/);
    expect(body).toMatch(/if \(minutes < 60\) return `\$\{minutes\.toString\(\)\}m remaining`;/);
    expect(body).toMatch(/return `\$\{hours\.toString\(\)\}h \$\{rem\.toString\(\)\}m remaining`;/);
  });

  it('expires_at countdown gated on pending status + non-empty expires_at', () => {
    expect(body).toMatch(
      /const showExpiry =\s*order\.status === 'pending' &&\s*typeof order\.expires_at === 'string' &&\s*order\.expires_at\.length > 0;/,
    );
  });

  it('<dl> 2-col grid with 6 row labels (Product / Amount / Payment id / Created / Updated / Pay by)', () => {
    expect(body).toMatch(/<dl className="mt-4 grid grid-cols-2 gap-y-1 text-sm">/);
    expect(body).toMatch(/<dt className="text-ink-secondary">Product<\/dt>/);
    expect(body).toMatch(/<dt className="text-ink-secondary">Amount<\/dt>/);
    expect(body).toMatch(/<dt className="text-ink-secondary">Payment id<\/dt>/);
    expect(body).toMatch(/<dt className="text-ink-secondary">Created<\/dt>/);
    expect(body).toMatch(/<dt className="text-ink-secondary">Updated<\/dt>/);
    expect(body).toMatch(/<dt className="text-ink-secondary">Pay by<\/dt>/);
  });

  it('Payment id row conditional (only when order.payment_id !== null)', () => {
    expect(body).toMatch(/\{order\.payment_id !== null && \(/);
    expect(body).toMatch(/<dd className="font-mono text-xs">\{order\.payment_id\}<\/dd>/);
  });

  it('Amount row uses formatCents(price_cents, price_currency) for currency-aware formatting', () => {
    expect(body).toMatch(/\{formatCents\(order\.price_cents, order\.price_currency\)\}/);
  });

  it('Pay by row shows the shared formatted timestamp + describeExpiry parenthetical countdown', () => {
    expect(body).toMatch(/\{showExpiry && \(/);
    expect(body).toMatch(/<span>\{formatTimestamp\(order\.expires_at as string\)\}<\/span>/);
    expect(body).toMatch(
      /\(\{describeExpiry\(order\.expires_at as string, \(nowFn \?\? Date\.now\)\(\)\)\}\)/,
    );
  });

  it('header: "Order" h3 + font-mono order_id + CryptoOrderStatusBadge', () => {
    expect(body).toMatch(/<header className="flex items-center justify-between">/);
    expect(body).toMatch(/<h3 className="text-base font-semibold">Order<\/h3>/);
    expect(body).toMatch(
      /<p className="font-mono text-xs text-ink-secondary">\{order\.order_id\}<\/p>/,
    );
    expect(body).toMatch(/<CryptoOrderStatusBadge status=\{order\.status\} \/>/);
  });

  it('optional footer slot rendered when defined (cancel buttons / receipt panels)', () => {
    expect(body).toMatch(/\{footer !== undefined && <div className="mt-4">\{footer\}<\/div>\}/);
    expect(body).toMatch(/Callers compose this with cancel buttons \/ receipt panels around it/);
  });

  it('section wrapper: rounded border + surface-inset bg + p-4', () => {
    expect(body).toMatch(
      /<section className="rounded-md border border-surface-divider bg-surface-inset p-4">/,
    );
  });

  it('component file + dependencies exist at canonical paths', () => {
    expect(existsSync(COMPONENT)).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'apps/gui-client/src/lib/crypto-format.ts'))).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'apps/gui-client/src/lib/use-crypto-order.ts'))).toBe(
      true,
    );
  });
});
