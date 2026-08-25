// W476.C — drift guard for apps/gui-client/src/components/CryptoOrderStatusBadge.tsx.
// V-534.U CryptoOrderStatusBadge. Drift here drops the
// 'Partial — contact support' label (customers with partial-pay
// orders see raw 'partial' string and don't know they need to
// reach out), or moves isTerminalCryptoOrderStatus off the set
// the server enforces.
//
// V-1056 — this header used to justify the helper's two-value form
// as what the polling hook stops on. The hook has never imported
// it, and builds {paid, failed, cancelled} plus 'partial' itself.
// The helper now matches isTerminalForward in
// services/crypto-orders.ts, which refuses to move an order out of
// paid / failed / cancelled.
//
//   • V-534.U framing pinned: 'CryptoOrderStatusBadge
//     presentational component.' + the header naming all six
//     covered statuses.
//   • CryptoOrderStatus 6-value union, matching
//     CryptoOrderStatusSchema. It was five, excluding 'cancelled',
//     under a note claiming cancelled was surfaced by a separate
//     code path — the STATUS_LABEL and STATUS_TONE maps in the
//     same file have always carried it.
//   • STATUS_LABEL: pending→'Awaiting payment', confirming→
//     'Confirming on-chain', paid→'Paid', failed→'Failed',
//     partial→'Partial — contact support'.
//   • STATUS_TONE: pending→neutral, confirming→busy, paid→
//     success, failed→error, partial→warning.
//   • Exported isTerminalCryptoOrderStatus: returns true for
//     'paid' || 'failed' || 'cancelled', matching isTerminalForward
//     in services/crypto-orders.ts.
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

  it("V-1056 V-534.U framing pinned, with the header no longer naming five of the six statuses it covers. It listed pending / confirming / paid / failed / partial while the label and tone maps below carried 'cancelled' too, so the file described itself as handling less than it did.", () => {
    expect(body).toMatch(/\/\/ V-534\.U — CryptoOrderStatusBadge presentational component\./);
    expect(body).toMatch(/All six statuses in CryptoOrderStatusSchema are covered\./);
    expect(
      body,
      'the header lists a five-status roster again, while the maps below carry six',
    ).not.toMatch(/status \(pending \/ confirming \/ paid \/ failed \/\s*\/\/ partial\)/);
  });

  it("V-1056 CryptoOrderStatus is the 6-value union CryptoOrderStatusSchema declares + CryptoOrderStatusBadgeProps: status + size? 'sm'|'md'. It was five, excluding 'cancelled', under a note claiming cancelled came through a separate code path — the maps in this same file have always carried it, and nothing imported the union, so the divergence was invisible.", () => {
    for (const value of ['pending', 'confirming', 'paid', 'failed', 'partial', 'cancelled']) {
      expect(body, `CryptoOrderStatus no longer includes '${value}'`).toMatch(
        new RegExp(`\\| '${value}'|= '${value}'`),
      );
    }
    expect(
      body,
      "the union is the five-value form again, so 'cancelled' cannot be represented",
    ).not.toMatch(
      /export type CryptoOrderStatus = 'pending' \| 'confirming' \| 'paid' \| 'failed' \| 'partial';/,
    );
    expect(body).toMatch(
      /export interface CryptoOrderStatusBadgeProps \{\s*status: string;\s*size\?: 'sm' \| 'md';\s*\}/,
    );
  });

  it("STATUS_LABEL pinned: pending→'Awaiting payment', confirming→'Confirming on-chain', paid→'Paid', failed→'Failed', partial→'Partial — contact support' (em-dash + 'contact support' framing — pinned so customers with partial-pay orders know they need to reach out)", () => {
    expect(body).toMatch(
      /const STATUS_LABEL: Record<string, string> = \{\s*pending: 'Awaiting payment',\s*confirming: 'Confirming on-chain',\s*paid: 'Paid',\s*failed: 'Failed',\s*partial: 'Partial — contact support',\s*cancelled: 'Cancelled',\s*\};/,
    );
  });

  it('STATUS_TONE pinned: pending→neutral, confirming→busy, paid→success, failed→error, partial→warning + TONE_CLASSES 5-entry mapping + SIZE_CLASSES sm/md', () => {
    expect(body).toMatch(
      /const STATUS_TONE: Record<string, Tone> = \{\s*pending: 'neutral',\s*confirming: 'busy',\s*paid: 'success',\s*failed: 'error',\s*partial: 'warning',\s*cancelled: 'neutral',\s*\};/,
    );
    expect(body).toMatch(
      /const TONE_CLASSES: Record<Tone, string> = \{\s*neutral: 'bg-surface-inset text-ink-secondary border-surface-divider',\s*success: 'bg-status-success\/15 text-status-success border-status-success\/30',\s*busy: 'bg-status-busy\/15 text-status-busy border-status-busy\/30',\s*warning: 'bg-status-warning\/15 text-status-warning border-status-warning\/30',\s*error: 'bg-status-error\/15 text-status-error border-status-error\/30',\s*\};/,
    );
    expect(body).toMatch(
      /const SIZE_CLASSES: Record<NonNullable<CryptoOrderStatusBadgeProps\['size'\]>, string> = \{\s*sm: 'px-1\.5 py-0\.5 text-xs',\s*md: 'px-2 py-0\.5 text-sm',\s*\};/,
    );
  });

  it("V-1056 isTerminalCryptoOrderStatus returns true for 'paid', 'failed' AND 'cancelled' — the set the server enforces in isTerminalForward, which refuses to move an order out of any of the three so a late IPN cannot revive an abandoned one. It excluded 'cancelled' under a rationale about the polling hook that was not true of the hook.", () => {
    expect(body).toMatch(
      /export function isTerminalCryptoOrderStatus\(status: string\): boolean \{\s*return status === 'paid' \|\| status === 'failed' \|\| status === 'cancelled';\s*\}/,
    );

    // The retracted two-value form does not come back.
    expect(
      body,
      'isTerminalCryptoOrderStatus is two-value again; a cancelled order would read as still ' +
        'moving, against isTerminalForward in services/crypto-orders.ts',
    ).not.toMatch(/return status === 'paid' \|\| status === 'failed';/);

    // 'partial' stays out: the server treats it as semi-terminal, so an order
    // there can still move to paid or failed.
    expect(
      body,
      "'partial' was added to the terminal set; the server still lets paid/failed override it",
    ).not.toMatch(/status === 'partial'[^;]*;\s*\}/);
  });

  it("Render: role='status' + aria-label `Crypto order status: ${label}` + size default 'md' + busy-tone dot with animate-pulse (confirming on-chain visual indicator) + ternary chain for dot bg color; cryptoOrderStatusLabelFor + cryptoOrderStatusToneFor exported with ?? fallback for forward-compat", () => {
    expect(body).toMatch(
      /export function cryptoOrderStatusLabelFor\(status: string\): string \{\s*return STATUS_LABEL\[status\] \?\? status;\s*\}/,
    );
    expect(body).toMatch(
      /export function cryptoOrderStatusToneFor\(status: string\): Tone \{\s*return STATUS_TONE\[status\] \?\? 'neutral';\s*\}/,
    );
    expect(body).toMatch(/role="status"\s*aria-label=\{`Crypto order status: \$\{label\}`\}/);
    expect(body).toMatch(
      /tone === 'success'\s*\? 'bg-status-success'\s*: tone === 'busy'\s*\? 'bg-status-busy animate-pulse'\s*: tone === 'warning'\s*\? 'bg-status-warning'\s*: tone === 'error'\s*\? 'bg-status-error'\s*: 'bg-ink-muted'/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
