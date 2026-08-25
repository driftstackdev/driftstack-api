// W479.A — drift guard for apps/gui-client/src/views/CryptoOrdersPendingAgeView.tsx.
// V-534.AO admin pending-orders age histogram view + V-666.AC.
// Drift here either drops the 4-bucket framing
// (under_1h/h1_to_6h/h6_to_24h/over_24h — ops loses the
// at-a-glance read for spotting stale pending orders) or breaks
// the 'Sweep candidate' hint on the over_24h bucket (the
// operationally interesting bucket loses its action label and
// ops doesn't know to fire the sweep-expired endpoint).
//
//   • V-534.AO framing pinned: 'admin pending-orders age
//     histogram view.' + 'Companion to V-534.AG (admin list) +
//     V-534.AH (daily breakdown). Renders the four age buckets
//     returned by /v1/admin/crypto-orders/pending-age (V-666.AC)
//     so ops can spot stale pending orders at a glance. The
//     over_24h bucket is the most operationally interesting —
//     those are candidates for the sweep-expired endpoint.'
//   • BucketDef + BUCKETS 4-entry array: under_1h→'Under 1h'+
//     'Fresh', h1_to_6h→'1–6h'+'Normal', h6_to_24h→'6–24h'+
//     'Watch', over_24h→'Over 24h'+'Sweep candidate'.
//   • truncated warning surface with 'widen the analytics window
//     if this becomes routine.'
//   • pending_value_cents empty-state 'No pending value.' +
//     non-empty Object.entries formatCents iteration.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/views/CryptoOrdersPendingAgeView.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W479.A apps/gui-client/src/views/CryptoOrdersPendingAgeView.tsx content parity', () => {
  const body = read(LIB);

  it("V-534.AO framing pinned: 'V-534.AO — admin pending-orders age histogram view.' + 'Companion to V-534.AG (admin list) + V-534.AH (daily breakdown). Renders the four age buckets returned by /v1/admin/crypto-orders/pending-age (V-666.AC) so ops can spot stale pending orders at a glance. The over_24h bucket is the most operationally interesting — those are candidates for the sweep-expired endpoint.'", () => {
    expect(body).toMatch(/\/\/ V-534\.AO — admin pending-orders age histogram view\./);
    expect(body).toMatch(
      /\/\/ Companion to V-534\.AG \(admin list\) \+ V-534\.AH \(daily breakdown\)\.\s*\/\/ Renders the four age buckets returned by\s*\/\/ \/v1\/admin\/crypto-orders\/pending-age \(V-666\.AC\) so ops can spot stale\s*\/\/ pending orders at a glance\. The over_24h bucket is the most\s*\/\/ operationally interesting — those are candidates for the\s*\/\/ sweep-expired endpoint\./,
    );
  });

  it("BucketDef type 4-value key union ('under_1h' | 'h1_to_6h' | 'h6_to_24h' | 'over_24h') + label + hint — pinned so the 4-bucket histogram surface stays in lockstep with the V-666.AC server contract", () => {
    expect(body).toMatch(
      /interface BucketDef \{\s*key: 'under_1h' \| 'h1_to_6h' \| 'h6_to_24h' \| 'over_24h';\s*label: string;\s*hint: string;\s*\}/,
    );
  });

  it("BUCKETS 4-entry pinned: under_1h→'Under 1h'+'Fresh' / h1_to_6h→'1–6h'+'Normal' (en-dash, not hyphen) / h6_to_24h→'6–24h'+'Watch' / over_24h→'Over 24h'+'Sweep candidate' — pinned so the over_24h bucket keeps the 'Sweep candidate' action hint and ops knows when to fire the sweep-expired endpoint", () => {
    expect(body).toMatch(
      /const BUCKETS: BucketDef\[\] = \[\s*\{ key: 'under_1h', label: 'Under 1h', hint: 'Fresh' \},\s*\{ key: 'h1_to_6h', label: '1–6h', hint: 'Normal' \},\s*\{ key: 'h6_to_24h', label: '6–24h', hint: 'Watch' \},\s*\{ key: 'over_24h', label: 'Over 24h', hint: 'Sweep candidate' \},\s*\];/,
    );
  });

  it("Header + refresh button: 'Pending orders — age histogram' h2 + Refresh button disabled while state.kind === 'loading' + button label switches to 'Loading…' during fetch; ErrorBanner wired with message + onDismiss=>refetch (retry-on-dismiss for transient blips)", () => {
    expect(body).toMatch(
      /<h2 className="text-lg font-semibold">Pending orders — age histogram<\/h2>/,
    );
    expect(body).toMatch(
      /<button\s*type="button"\s*onClick=\{\(\) => void refetch\(\)\}\s*disabled=\{state\.kind === 'loading'\}/,
    );
    expect(body).toMatch(/\{state\.kind === 'loading' \? 'Loading…' : 'Refresh'\}/);
    expect(body).toMatch(
      /\{state\.kind === 'error' && \(\s*<ErrorBanner message=\{state\.message\} onDismiss=\{\(\) => void refetch\(\)\} \/>\s*\)\}/,
    );
  });

  it("Ready-state totals header: <strong>{total}</strong> pending order{s} + total === 1 ? '' : 's' singular/plural toggle + truncated warning 'Scan truncated at {scanned} — widen the analytics window if this becomes routine.' in status-warning tint — pinned so admin sees a clear note when the V-666.AC scan window was hit", () => {
    expect(body).toMatch(
      /<strong>\{state\.data\.total\}<\/strong> pending order\s*\{state\.data\.total === 1 \? '' : 's'\} in scope\./,
    );
    expect(body).toMatch(
      /\{state\.data\.truncated && \(\s*<span className="ml-2 text-status-warning">\s*Scan truncated at \{state\.data\.scanned\} — widen the analytics window if this becomes\s*routine\.\s*<\/span>\s*\)\}/,
    );
  });

  it("Bucket grid: data-testid='pending-age-buckets' container + BUCKETS.map with data-testid=`bucket-${key}` per card + label uppercase tracking-wide + count tabular-nums + hint + pending_value_cents section: empty state 'No pending value.' + non-empty Object.entries map with formatCents(cents, currency) + data-testid=`pending-value-${currency}`", () => {
    expect(body).toMatch(/data-testid="pending-age-buckets"/);
    expect(body).toMatch(/data-testid=\{`bucket-\$\{b\.key\}`\}/);
    expect(body).toMatch(/const count = state\.data\.buckets\[b\.key\];/);
    expect(body).toMatch(
      /<h3 className="text-sm font-medium text-ink-secondary">Pending value by currency<\/h3>\s*\{Object\.keys\(state\.data\.pending_value_cents\)\.length === 0 \? \(\s*<p className="mt-1 text-sm text-ink-secondary">No pending value\.<\/p>\s*\) : \(/,
    );
    expect(body).toMatch(
      /\{Object\.entries\(state\.data\.pending_value_cents\)\.map\(\(\[currency, cents\]\) => \(\s*<li\s*key=\{currency\}\s*className="rounded border border-surface-divider bg-surface-base px-3 py-1 font-mono"\s*data-testid=\{`pending-value-\$\{currency\}`\}\s*>\s*\{formatCents\(cents, currency\)\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
