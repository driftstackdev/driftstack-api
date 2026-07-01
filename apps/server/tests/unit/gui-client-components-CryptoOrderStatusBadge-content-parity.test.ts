// W476.C — drift guard for apps/gui-client/src/components/CryptoOrderStatusBadge.tsx.
// V-534.U CryptoOrderStatusBadge. Drift here either drops the
// 'Partial — contact support' label (customers with partial-pay
// orders see raw 'partial' string and don't know they need to
// reach out) or breaks the isTerminalCryptoOrderStatus 2-value
// signature (polling hooks rely on this to stop hammering the
// order endpoint once paid/failed — drift here resumes
// rate-limit-storm).
//
//   • V-534.U framing pinned: 'CryptoOrderStatusBadge
//     presentational component.' + 'Maps a crypto-order status
//     (pending / confirming / paid / failed / partial) to a
//     label + tone for the checkout-confirmation view.'
//   • CryptoOrderStatus 5-value union (pending | confirming |
//     paid | failed | partial — NOT cancelled; cancelled is
//     surfaced via a separate code path).
//   • STATUS_LABEL: pending→'Awaiting payment', confirming→
//     'Confirming on-chain', paid→'Paid', failed→'Failed',
//     partial→'Partial — contact support'.
//   • STATUS_TONE: pending→neutral, confirming→busy, paid→
//     success, failed→error, partial→warning.
//   • Exported isTerminalCryptoOrderStatus: returns true for
//     'paid' || 'failed' (terminal-stop trigger for V-534.T
//     useCryptoOrder polling).
//   • Render: role='status' + aria-label `Crypto order status:
//     ${label}` + busy-tone dot with animate-pulse for the
//     'confirming' on-chain step.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/components/CryptoOrderStatusBadge.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W476.C apps/gui-client/src/components/CryptoOrderStatusBadge.tsx content parity', () => {
  const body = read(LIB);

  it("V-534.U framing pinned: 'V-534.U — CryptoOrderStatusBadge presentational component.' + 'Maps a crypto-order status (pending / confirming / paid / failed / partial) to a label + tone for the checkout-confirmation view.'", () => {
    expect(body).toMatch(/\/\/ V-534\.U — CryptoOrderStatusBadge presentational component\./);
    expect(body).toMatch(
      /\/\/ Maps a crypto-order status \(pending \/ confirming \/ paid \/ failed \/\s*\n?\s*\/\/ partial\) to a label \+ tone for the checkout-confirmation view\./,
    );
  });

  it("CryptoOrderStatus 5-value union ('pending' | 'confirming' | 'paid' | 'failed' | 'partial' — NOT 'cancelled'; cancelled status is surfaced via a separate code path) + CryptoOrderStatusBadgeProps: status + size? 'sm'|'md'", () => {
    expect(body).toMatch(
      /export type CryptoOrderStatus = 'pending' \| 'confirming' \| 'paid' \| 'failed' \| 'partial';/,
    );
    expect(body).toMatch(
      /export interface CryptoOrderStatusBadgeProps \{\s*\n?\s*status: string;\s*\n?\s*size\?: 'sm' \| 'md';\s*\n?\s*\}/,
    );
  });

  it("STATUS_LABEL pinned: pending→'Awaiting payment', confirming→'Confirming on-chain', paid→'Paid', failed→'Failed', partial→'Partial — contact support' (em-dash + 'contact support' framing — pinned so customers with partial-pay orders know they need to reach out)", () => {
    expect(body).toMatch(
      /const STATUS_LABEL: Record<string, string> = \{\s*\n?\s*pending: 'Awaiting payment',\s*\n?\s*confirming: 'Confirming on-chain',\s*\n?\s*paid: 'Paid',\s*\n?\s*failed: 'Failed',\s*\n?\s*partial: 'Partial — contact support',\s*\n?\s*cancelled: 'Cancelled',\s*\n?\s*\};/,
    );
  });

  it('STATUS_TONE pinned: pending→neutral, confirming→busy, paid→success, failed→error, partial→warning + TONE_CLASSES 5-entry mapping + SIZE_CLASSES sm/md', () => {
    expect(body).toMatch(
      /const STATUS_TONE: Record<string, Tone> = \{\s*\n?\s*pending: 'neutral',\s*\n?\s*confirming: 'busy',\s*\n?\s*paid: 'success',\s*\n?\s*failed: 'error',\s*\n?\s*partial: 'warning',\s*\n?\s*cancelled: 'neutral',\s*\n?\s*\};/,
    );
    expect(body).toMatch(
      /const TONE_CLASSES: Record<Tone, string> = \{\s*\n?\s*neutral: 'bg-surface-inset text-ink-secondary border-surface-divider',\s*\n?\s*success: 'bg-status-success\/15 text-status-success border-status-success\/30',\s*\n?\s*busy: 'bg-status-busy\/15 text-status-busy border-status-busy\/30',\s*\n?\s*warning: 'bg-status-warning\/15 text-status-warning border-status-warning\/30',\s*\n?\s*error: 'bg-status-error\/15 text-status-error border-status-error\/30',\s*\n?\s*\};/,
    );
    expect(body).toMatch(
      /const SIZE_CLASSES: Record<NonNullable<CryptoOrderStatusBadgeProps\['size'\]>, string> = \{\s*\n?\s*sm: 'px-1\.5 py-0\.5 text-xs',\s*\n?\s*md: 'px-2 py-0\.5 text-sm',\s*\n?\s*\};/,
    );
  });

  it("isTerminalCryptoOrderStatus exported: returns true ONLY for status === 'paid' || status === 'failed' — pinned so V-534.T useCryptoOrder polling auto-stops on the same 2-value terminal set; drift here resumes rate-limit-storm or never stops polling on a paid order", () => {
    expect(body).toMatch(
      /export function isTerminalCryptoOrderStatus\(status: string\): boolean \{\s*\n?\s*return status === 'paid' \|\| status === 'failed';\s*\n?\s*\}/,
    );
  });

  it("Render: role='status' + aria-label `Crypto order status: ${label}` + size default 'md' + busy-tone dot with animate-pulse (confirming on-chain visual indicator) + ternary chain for dot bg color; cryptoOrderStatusLabelFor + cryptoOrderStatusToneFor exported with ?? fallback for forward-compat", () => {
    expect(body).toMatch(
      /export function cryptoOrderStatusLabelFor\(status: string\): string \{\s*\n?\s*return STATUS_LABEL\[status\] \?\? status;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export function cryptoOrderStatusToneFor\(status: string\): Tone \{\s*\n?\s*return STATUS_TONE\[status\] \?\? 'neutral';\s*\n?\s*\}/,
    );
    expect(body).toMatch(/role="status"\s*\n?\s*aria-label=\{`Crypto order status: \$\{label\}`\}/);
    expect(body).toMatch(
      /tone === 'success'\s*\n?\s*\? 'bg-status-success'\s*\n?\s*: tone === 'busy'\s*\n?\s*\? 'bg-status-busy animate-pulse'\s*\n?\s*: tone === 'warning'\s*\n?\s*\? 'bg-status-warning'\s*\n?\s*: tone === 'error'\s*\n?\s*\? 'bg-status-error'\s*\n?\s*: 'bg-ink-muted'/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
