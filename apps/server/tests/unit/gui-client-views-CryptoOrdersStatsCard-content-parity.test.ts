// W482.A — drift guard for apps/gui-client/src/views/CryptoOrdersStatsCard.tsx.
// V-534.AI admin stats summary card + V-534.AP per-product
// revenue/ARPU breakdown. Drift here either drops the
// productRows sort-by-total-desc (highest-grossing tier no
// longer at the top — admin scans the table top-to-bottom and
// misses the strategic info) or breaks the formatDurationMs
// piecewise breakpoints (avg time-to-pay shows '14400000s' for
// a 4-hour delay because the >60min branch never fires).
//
//   • V-534.AI framing pinned: 'admin stats summary card for
//     crypto orders.' + V-666.N + V-666.W endpoint wrap +
//     'compact at-a-glance card'.
//   • V-534.AP framing pinned: 'adds per-product revenue + ARPU
//     breakdown using the V-666.AE fields. Pure read-only; no
//     actions.'
//   • STATUS_LABELS 6-entry (Pending/Confirming/Paid/Failed/
//     Partial/Cancelled) + STATUS_ORDER 6-tuple (same as
//     V-534.U union).
//   • formatDurationMs piecewise: <60_000 → 's' + <60*60_000
//     → 'm' (toFixed 1) + else 'h' (toFixed 1).
//   • productRows: paid_revenue_by_product ?? {} fallback +
//     Object.values reduce total + paid_count_by_product?.[p]
//     ?? 0 fallback + sort by total desc.
//   • Top 4-stat grid: Total + Paid + Pending + Avg time-to-pay
//     with '—' em-dash fallback for null.
//   • truncated warning + paid revenue empty 'No paid orders in
//     scope.' fallback.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/views/CryptoOrdersStatsCard.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W482.A apps/gui-client/src/views/CryptoOrdersStatsCard.tsx content parity', () => {
  const body = read(LIB);

  it("V-534.AI + V-534.AP framing pinned: 'V-534.AI — admin stats summary card for crypto orders.' + 'Surfaces the /v1/admin/crypto-orders/stats response (V-666.N + V-666.W) as a compact at-a-glance card: total orders, per-status counts, paid revenue per currency, and the avg time-to-paid KPI.' + 'V-534.AP — adds per-product revenue + ARPU breakdown using the V-666.AE fields. Pure read-only; no actions.'", () => {
    expect(body).toMatch(/\/\/ V-534\.AI — admin stats summary card for crypto orders\./);
    expect(body).toMatch(
      /\/\/ Surfaces the \/v1\/admin\/crypto-orders\/stats response \(V-666\.N \+\s*\/\/ V-666\.W\) as a compact at-a-glance card: total orders, per-status\s*\/\/ counts, paid revenue per currency, and the avg time-to-paid KPI\./,
    );
    expect(body).toMatch(
      /\/\/ V-534\.AP — adds per-product revenue \+ ARPU breakdown using the\s*\/\/ V-666\.AE fields\. Pure read-only; no actions\./,
    );
  });

  it('STATUS_LABELS 6-entry + STATUS_ORDER 6-tuple (same as V-534.U/.AH union order: pending/confirming/paid/failed/partial/cancelled)', () => {
    expect(body).toMatch(
      /const STATUS_LABELS: Record<AdminCryptoStatsStatus, string> = \{\s*pending: 'Pending',\s*confirming: 'Confirming',\s*paid: 'Paid',\s*failed: 'Failed',\s*partial: 'Partial',\s*cancelled: 'Cancelled',\s*\};/,
    );
    expect(body).toMatch(
      /const STATUS_ORDER: AdminCryptoStatsStatus\[\] = \[\s*'pending',\s*'confirming',\s*'paid',\s*'failed',\s*'partial',\s*'cancelled',\s*\];/,
    );
  });

  it("formatDurationMs piecewise: ms < 60_000 → `${Math.round(ms/1_000)}s` + ms < 60 * 60_000 → `${minutes.toFixed(1)}m` + else `${hours.toFixed(1)}h` — pinned so a 4h delay doesn't render '14400000s' because the >60min branch never fired", () => {
    expect(body).toMatch(
      /function formatDurationMs\(ms: number\): string \{\s*if \(ms < 60_000\) return `\$\{Math\.round\(ms \/ 1_000\)\.toString\(\)\}s`;\s*if \(ms < 60 \* 60_000\) \{\s*const minutes = ms \/ 60_000;\s*return `\$\{minutes\.toFixed\(1\)\}m`;\s*\}\s*const hours = ms \/ \(60 \* 60_000\);\s*return `\$\{hours\.toFixed\(1\)\}h`;\s*\}/,
    );
  });

  it("State-machine early returns: idle|loading → 'Loading stats…' empty state + error → ErrorBanner with retry-on-dismiss=>refetch + ready → full card; revenueEntries = Object.entries(paid_revenue_cents); productRows: paid_revenue_by_product ?? {} fallback + Object.values reduce total + paid_count_by_product?.[product] ?? 0 fallback + sort by total desc — pinned so highest-grossing tier stays at top", () => {
    expect(body).toMatch(
      /if \(state\.kind === 'idle' \|\| state\.kind === 'loading'\) \{\s*return \(\s*<div className="rounded-md border border-surface-divider bg-surface-inset p-4 text-sm text-ink-secondary">\s*Loading stats…\s*<\/div>\s*\);\s*\}/,
    );
    expect(body).toMatch(
      /if \(state\.kind === 'error'\) \{\s*return <ErrorBanner message=\{state\.message\} onDismiss=\{\(\) => void refetch\(\)\} \/>;\s*\}/,
    );
    expect(body).toMatch(
      /\/\/ V-534\.AP — sort product rows by total cents desc so the highest-\s*\/\/ grossing tier is first\. Multi-currency totals are summed for the\s*\/\/ sort key only; display preserves each currency separately\./,
    );
    expect(body).toMatch(
      /const productRows = Object\.entries\(data\.paid_revenue_by_product \?\? \{\}\)\s*\.map\(\(\[product, byCurrency\]\) => \{\s*const total = Object\.values\(byCurrency\)\.reduce\(\(a, b\) => a \+ b, 0\);\s*const count = data\.paid_count_by_product\?\.\[product\] \?\? 0;\s*return \{ product, byCurrency, total, count \};\s*\}\)\s*\.sort\(\(a, b\) => b\.total - a\.total\);/,
    );
  });

  it("4-stat top grid (Total + Paid + Pending + Avg time-to-pay) with avg_time_to_paid_ms !== null formatDurationMs delegation else '—' em-dash fallback for null", () => {
    expect(body).toMatch(
      /<p className="text-xs uppercase text-ink-secondary">Total orders<\/p>\s*<p className="text-xl font-semibold">\{data\.total\}<\/p>/,
    );
    expect(body).toMatch(
      /<p className="text-xs uppercase text-ink-secondary">Avg time-to-pay<\/p>\s*<p className="text-xl font-semibold">\s*\{data\.avg_time_to_paid_ms !== null \? formatDurationMs\(data\.avg_time_to_paid_ms\) : '—'\}\s*<\/p>/,
    );
  });

  it("By-status dl: STATUS_ORDER.map iteration with STATUS_LABELS[s] dt + data.by_status[s] dd; Paid revenue section: revenueEntries.length === 0 → 'No paid orders in scope.' fallback else <ul> with formatCents(cents, currency) per entry", () => {
    expect(body).toMatch(
      /\{STATUS_ORDER\.map\(\(s\) => \(\s*<div key=\{s\} className="flex items-center justify-between gap-2">\s*<dt className="text-ink-secondary">\{STATUS_LABELS\[s\]\}<\/dt>\s*<dd>\{data\.by_status\[s\]\}<\/dd>\s*<\/div>\s*\)\)\}/,
    );
    expect(body).toMatch(
      /\{revenueEntries\.length === 0 \? \(\s*<p className="text-sm text-ink-secondary">No paid orders in scope\.<\/p>\s*\) : \(\s*<ul className="flex flex-wrap gap-3 text-sm">\s*\{revenueEntries\.map\(\(\[currency, cents\]\) => \(\s*<li key=\{currency\} className="font-mono">\s*\{formatCents\(cents, currency\)\}/,
    );
  });

  it("Per-product table: data-testid='paid-by-product' container + only renders when productRows.length > 0 + Product/Count/Revenue 3-col header + per-row data-testid=`product-row-${product}` + multi-currency Object.entries map inside Revenue cell (each currency rendered separately even though sort key was summed)", () => {
    expect(body).toMatch(/\{productRows\.length > 0 && \(\s*<div data-testid="paid-by-product">/);
    expect(body).toMatch(
      /<tr>\s*<th className="py-1 pr-3 font-medium">Product<\/th>\s*<th className="py-1 pr-3 font-medium">Count<\/th>\s*<th className="py-1 font-medium">Revenue<\/th>\s*<\/tr>/,
    );
    expect(body).toMatch(/data-testid=\{`product-row-\$\{row\.product\}`\}/);
    expect(body).toMatch(
      /\{Object\.entries\(row\.byCurrency\)\.map\(\(\[currency, cents\]\) => \(\s*<span key=\{currency\}>\{formatCents\(cents, currency\)\}<\/span>\s*\)\)\}/,
    );
  });

  it("truncated warning surface: 'Stats scanned {data.scanned} orders and stopped at the scan-window limit. Numbers may be undercounts; widen the analytics window if this becomes routine.' in text-status-warning — pinned so admin sees a clear undercount note when V-666.N scan window was hit", () => {
    expect(body).toMatch(
      /\{data\.truncated && \(\s*<p className="text-xs text-status-warning">\s*Stats scanned \{data\.scanned\} orders and stopped at the scan-window limit\. Numbers may be\s*undercounts; widen the analytics window if this becomes routine\.\s*<\/p>\s*\)\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
