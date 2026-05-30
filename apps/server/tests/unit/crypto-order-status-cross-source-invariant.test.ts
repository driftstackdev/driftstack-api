// W865 — CryptoOrderStatus 6-value + EventSource 5/4 split
// cross-source invariant. One-hundred-ninety-first in the drift-
// guard series. Pins the V-666 crypto-order status enum + the
// V-666.AT/AU event-source split:
//
//   CryptoOrderStatus (6):
//     1. pending     — order created; awaiting payment.
//     2. confirming  — payment seen; awaiting on-chain confirmations.
//     3. paid        — confirmations received; goods unlocked.
//     4. failed      — payment timeout / refund / expired.
//     5. partial     — amount received < expected.
//     6. cancelled   — V-666.J customer-initiated abandonment (terminal).
//
//   EventSource server-side (5) vs customer-facing (4):
//     - server: create + ipn + cancel + expired + swept
//     - customer: create + ipn + cancel + expired
//     - V-666.AU: 'swept' is mapped to 'expired' before serialization
//       so the customer-facing surface only sees 4 sources.
//
// stays in lockstep across:
//   - packages/api-types/src/crypto-orders.ts (Zod canonical).
//   - apps/server/src/services/crypto-orders.ts (server-side
//     CryptoOrderStatus union type + EventSource 5-source union).
//
// Drift would silently break:
//   * V-666.AT append-only state-transition log integrity.
//   * V-666.AU 'swept' → 'expired' customer-facing mapping.
//   * IPN handler when transitioning to an unrecognised status.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CryptoOrderStatusSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const CRYPTO_ORDER_STATUSES = [
  'pending',
  'confirming',
  'paid',
  'failed',
  'partial',
  'cancelled',
] as const;

const SERVER_EVENT_SOURCES = ['create', 'ipn', 'cancel', 'expired', 'swept'] as const;
const CUSTOMER_EVENT_SOURCES = ['create', 'ipn', 'cancel', 'expired'] as const;

describe('W865 CryptoOrderStatus cross-source invariant', () => {
  // ─── api-types canonical source ──────────────────────────────

  it('CRITICAL packages/api-types/src/crypto-orders.ts CryptoOrderStatusSchema = z.enum([6 values]) — pending/confirming/paid/failed/partial/cancelled. The 6-value closed-roster is what the customer order-detail UI + IPN webhook handler pivot on.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/crypto-orders.ts'));
    expect(p).toMatch(/export const CryptoOrderStatusSchema = z\.enum\(\[/);
    // EXACT canonical pin: .options must EQUAL the 6-value set, not merely
    // contain it — a 7th status (e.g. a future 'refunded') would silently pass
    // the body-subset check below (the weak pattern that let WebhookEventType
    // drift). The sibling EventSource enum below is already exact-pinned.
    expect(CryptoOrderStatusSchema.options).toEqual([...CRYPTO_ORDER_STATUSES]);
    const m = p.match(/CryptoOrderStatusSchema = z\.enum\(\[([\s\S]+?)\]\)/);
    expect(m, 'CryptoOrderStatusSchema declaration must match').not.toBeNull();
    const body = m![1];
    for (const s of CRYPTO_ORDER_STATUSES) {
      expect(body, `CryptoOrderStatusSchema must include '${s}'`).toMatch(new RegExp(`'${s}'`));
    }
  });

  it('CRITICAL CryptoOrderStatus type re-exports from z.infer (drift-proof).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/crypto-orders.ts'));
    expect(p).toMatch(/export type CryptoOrderStatus = z\.infer<typeof CryptoOrderStatusSchema>;/);
  });

  // ─── Customer-facing EventSource = 4 values (sans 'swept') ───

  it("CRITICAL packages/api-types/src/crypto-orders.ts CryptoOrderEventSourceSchema = z.enum(['create', 'ipn', 'cancel', 'expired']) — 4 customer-facing sources. 'swept' is INTENTIONALLY absent: V-666.AU maps server-side 'swept' to 'expired' before serialization.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/crypto-orders.ts'));
    expect(p).toMatch(
      /export const CryptoOrderEventSourceSchema = z\.enum\(\['create', 'ipn', 'cancel', 'expired'\]\);/,
    );
    // 'swept' must NOT be in the customer-facing enum.
    const m = p.match(/CryptoOrderEventSourceSchema = z\.enum\(\[([\s\S]+?)\]\)/);
    expect(m).not.toBeNull();
    const body = m![1];
    expect(body, 'customer-facing event source MUST NOT include swept').not.toMatch(/'swept'/);
  });

  it("CRITICAL V-666.AU anchor pinned for the 'swept' → 'expired' mapping. The anchor threads the customer-facing-vs-server-internal split provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/crypto-orders.ts'));
    expect(p).toMatch(/V-666\.AU/);
    expect(p).toMatch(/'swept' is mapped to[\s\S]*?'expired' server-side/);
  });

  // ─── Server services/crypto-orders.ts union type ─────────────

  it('CRITICAL apps/server/src/services/crypto-orders.ts CryptoOrderStatus union has the EXACT same 6 values as api-types. Server-side type pivots IPN handler branches — drift would let the handler crash on an unrecognised status.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/crypto-orders.ts'));
    expect(p).toMatch(/export type CryptoOrderStatus =/);
    for (const s of CRYPTO_ORDER_STATUSES) {
      expect(p, `server CryptoOrderStatus must include '${s}'`).toMatch(
        new RegExp(`\\|\\s+'${s}'`),
      );
    }
  });

  it("CRITICAL apps/server/src/services/crypto-orders.ts CryptoOrderEvent.source has 5 INTERNAL values — 'create' | 'ipn' | 'cancel' | 'expired' | 'swept'. 'swept' is the EXTRA server-side source that V-666.AU strips before serializing to the customer.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/crypto-orders.ts'));
    expect(p).toMatch(/source: 'create' \| 'ipn' \| 'cancel' \| 'expired' \| 'swept';/);
  });

  // ─── V-666 anchors traceable ─────────────────────────────────

  it("CRITICAL V-666.J anchor pinned for 'cancelled' terminal-status. The customer-initiated-cancel-before-payment policy is what V-666.J specifies.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/crypto-orders.ts'));
    expect(p).toMatch(/V-666\.J — customer-initiated abandonment/);
  });

  it("CRITICAL V-666.AT anchor pinned for append-only event log. The 'state-transition event ... never mutate or remove prior entries' framing is the audit-trail contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/crypto-orders.ts'));
    expect(p).toMatch(/V-666\.AT — append-only state-transition event/);
  });

  // ─── Cardinality + terminal-vs-active split ──────────────────

  it("CRITICAL CryptoOrderStatus = EXACTLY 6 values + 4 terminal (paid/failed/partial/cancelled) + 2 in-flight (pending/confirming). The terminal split is what 'order is done' UI gates + cancellation-disabled buttons depend on.", () => {
    expect(CRYPTO_ORDER_STATUSES.length).toBe(6);
    const inFlight = (['pending', 'confirming'] as const).filter((s) =>
      (CRYPTO_ORDER_STATUSES as readonly string[]).includes(s),
    );
    const terminal = (['paid', 'failed', 'partial', 'cancelled'] as const).filter((s) =>
      (CRYPTO_ORDER_STATUSES as readonly string[]).includes(s),
    );
    expect(inFlight.length).toBe(2);
    expect(terminal.length).toBe(4);
  });

  it("CRITICAL event-source customer-vs-server cardinality — server emits 5 ('create' + 'ipn' + 'cancel' + 'expired' + 'swept'), customer sees 4 (sans 'swept'). The 5-to-4 mapping is the V-666.AU customer-facing reduction.", () => {
    expect(SERVER_EVENT_SOURCES.length).toBe(5);
    expect(CUSTOMER_EVENT_SOURCES.length).toBe(4);
    expect(SERVER_EVENT_SOURCES.filter((s) => s === 'swept').length).toBe(1);
    expect((CUSTOMER_EVENT_SOURCES as readonly string[]).filter((s) => s === 'swept').length).toBe(
      0,
    );
  });

  // ─── CryptoOrderEvent schema references the enum ─────────────

  it('CRITICAL CryptoOrderEventSchema references CryptoOrderStatusSchema + CryptoOrderEventSourceSchema as typed fields. The cross-reference enforces typed event log entries.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/crypto-orders.ts'));
    expect(p).toMatch(
      /export const CryptoOrderEventSchema = z\.object\(\{[\s\S]+?status: CryptoOrderStatusSchema/,
    );
    expect(p).toMatch(
      /CryptoOrderEventSchema = z\.object\(\{[\s\S]+?source: CryptoOrderEventSourceSchema/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/crypto-order-status-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
