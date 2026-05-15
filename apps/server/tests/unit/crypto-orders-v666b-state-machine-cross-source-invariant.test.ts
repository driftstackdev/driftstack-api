// W944 — V-666.B crypto-orders state machine cross-source invariant.
// Two-hundred-seventieth in the drift-guard series. Pins the crypto-
// order service contract:
//
//   V-666.B anchor — 'crypto-orders service. In-memory order store +
//   state machine for the NowPayments IPN flow. Customer-side
//   /checkout/crypto opens an order → backend records it + returns
//   the payment address → NowPayments IPN posts status updates →
//   service transitions the order state'.
//
//   V-666.B posture — 'no DB persistence yet (crypto_orders table
//   is a V-666.C follow-up gated on real merchant traffic). The
//   in-memory store works for the early-customer manual-handoff
//   cadence the founder expects in the first 4-8 weeks
//   post-merchant-account-go-live'.
//
//   CryptoOrderStatus 6-value union:
//     - 'pending' (awaiting payment).
//     - 'confirming' (payment seen; awaiting on-chain confirmations).
//     - 'paid' (confirmations received; goods unlocked).
//     - 'failed' (payment timeout / refund / expired).
//     - 'partial' (amount received < expected).
//     - 'cancelled' (V-666.J — customer abandonment; terminal).
//
//   V-666.J cancelled framing — 'customer-initiated abandonment of
//   a pending order before any payment was received. Terminal; the
//   IPN flow won't transition out of it (a late-arriving payment
//   leaves the order cancelled but records the payment_id so support
//   can reconcile)'.
//
//   V-666.AT append-only event log — 'append-only state-transition
//   event. Each entry records the status the order moved to + the
//   source of that transition. The list grows on every state change;
//   we never mutate or remove prior entries. Used by support to
//   reconstruct an order's history without grepping logs'.
//
//   CryptoOrderEvent.source 5-value union: 'create' | 'ipn' |
//     'cancel' | 'expired' | 'swept'.
//
//   idempotencyBodyFingerprint(product, price_cents, price_currency)
//     — sha256 hex of JSON-canonicalised 3-field tuple.
//
//   mapNowpaymentsStatus — 9 → 5 provider→internal mapping:
//     - waiting → pending.
//     - confirming / sending → confirming.
//     - partially_paid → partial.
//     - finished → paid.
//     - failed / expired / refunded → failed.
//     - default → null (unknown).
//
//   V-666.I optional webhook emitter — 'when provided, applyIpnStatus
//     fires crypto.order.paid whenever an order transitions to the
//     paid state. Best-effort: emission failures don't roll back
//     the state transition'.
//
// stays in lockstep across apps/server/src/services/crypto-orders.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  idempotencyBodyFingerprint,
  mapNowpaymentsStatus,
} from '../../src/services/crypto-orders.js';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W944 V-666.B crypto-orders cross-source invariant', () => {
  // ─── V-666.B anchor + state-machine framing ──────────────────

  it("CRITICAL apps/server/src/services/crypto-orders.ts header pins V-666.B anchor — 'V-666.B — crypto-orders service. In-memory order store + state machine for the NowPayments IPN flow'. The V-666.B anchor is the policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/crypto-orders.ts'));
    expect(p).toMatch(/V-666\.B — crypto-orders service/);
    expect(p).toMatch(/In-memory order store \+ state machine for the NowPayments IPN flow/);
  });

  // ─── 4-step flow framing ─────────────────────────────────────

  it("CRITICAL 4-step flow framing — 'Customer-side /checkout/crypto opens an order → backend records it + returns the payment address → NowPayments IPN posts status updates → service transitions the order state'. The arrow-flow is the customer-facing crypto-checkout protocol.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/crypto-orders.ts'));
    expect(p).toMatch(/Customer-side `\/checkout\/crypto` opens an order → backend records/);
    expect(p).toMatch(/it \+ returns the payment address → NowPayments IPN posts status/);
    expect(p).toMatch(/updates → service transitions the order state/);
  });

  // ─── V-666.B in-memory posture + V-666.C follow-up ───────────

  it("CRITICAL V-666.B in-memory posture framing — 'no DB persistence yet (crypto_orders table is a V-666.C follow-up gated on real merchant traffic). The in-memory store works for the early-customer manual-handoff cadence the founder expects in the first 4-8 weeks post-merchant-account-go-live'. The 4-8-week + manual-handoff scope is the V-666.B trade-off.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/crypto-orders.ts'));
    expect(p).toMatch(/V-666\.B posture: no DB persistence yet \(crypto_orders table is a/);
    expect(p).toMatch(/V-666\.C follow-up gated on real merchant traffic\)\./);
    expect(p).toMatch(/The in-memory/);
    expect(p).toMatch(/store works for the early-customer manual-handoff cadence the/);
    expect(p).toMatch(/founder expects in the first 4-8 weeks post-merchant-account-go-live/);
  });

  // ─── CryptoOrderStatus 6-value union ─────────────────────────

  it("CRITICAL CryptoOrderStatus 6 values — 'pending' (awaiting) + 'confirming' (on-chain confirmations) + 'paid' (unlocked) + 'failed' (timeout/refund/expired) + 'partial' (< expected) + 'cancelled' (V-666.J). The 6-value enum covers the full order lifecycle including V-666.J customer abandonment.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/crypto-orders.ts'));
    expect(p).toMatch(/export type CryptoOrderStatus =/);
    expect(p).toMatch(/\| 'pending'.*\/\/ order created; awaiting payment/);
    expect(p).toMatch(/\| 'confirming'.*\/\/ payment seen; awaiting on-chain confirmations/);
    expect(p).toMatch(/\| 'paid'.*\/\/ confirmations received; goods unlocked/);
    expect(p).toMatch(/\| 'failed'.*\/\/ payment timeout \/ refund \/ expired/);
    expect(p).toMatch(/\| 'partial'.*\/\/ amount received < expected/);
    expect(p).toMatch(/\| 'cancelled';/);
  });

  // ─── V-666.J cancelled-is-terminal framing ───────────────────

  it("CRITICAL V-666.J cancelled framing — 'V-666.J — customer-initiated abandonment of a pending order before any payment was received. Terminal; the IPN flow won't transition out of it (a late-arriving payment leaves the order cancelled but records the payment_id so support can reconcile)'. The terminal-but-records-payment-id design is what makes support-reconciliation possible.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/crypto-orders.ts'));
    expect(p).toMatch(/V-666\.J — customer-initiated abandonment of a pending order before/);
    expect(p).toMatch(/any payment was received\. Terminal; the IPN flow won't transition/);
    expect(p).toMatch(/out of it \(a late-arriving payment leaves the order cancelled but/);
    expect(p).toMatch(/records the payment_id so support can reconcile\)/);
  });

  // ─── V-666.AT append-only event log framing ──────────────────

  it("CRITICAL V-666.AT framing — 'V-666.AT — append-only state-transition event. Each entry records the status the order moved to + the source of that transition. The list grows on every state change; we never mutate or remove prior entries. Used by support to reconstruct an order's history without grepping logs'. The append-only + support-reconstruction design is the audit-trail-for-orders contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/crypto-orders.ts'));
    expect(p).toMatch(/V-666\.AT — append-only state-transition event\. Each entry records/);
    expect(p).toMatch(/the status the order moved to \+ the source of that transition\./);
    expect(p).toMatch(/The list grows on every state change; we never mutate or remove/);
    expect(p).toMatch(/prior entries\. Used by support to reconstruct an order's history/);
    expect(p).toMatch(/without grepping logs/);
  });

  it('CRITICAL CryptoOrderEvent 3-field shape — status + at (ms-since-epoch timestamp) + source. The 3-field event row is the V-666.AT log entry shape.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/crypto-orders.ts'));
    expect(p).toMatch(/export interface CryptoOrderEvent \{/);
    expect(p).toMatch(/Status the order entered/);
    expect(p).toMatch(/status: CryptoOrderStatus;/);
    expect(p).toMatch(/Server timestamp \(ms since epoch\) of the transition/);
    expect(p).toMatch(/at: number;/);
    expect(p).toMatch(/source: 'create' \| 'ipn' \| 'cancel' \| 'expired' \| 'swept';/);
  });

  // ─── 5-value source union ────────────────────────────────────

  it("CRITICAL CryptoOrderEvent.source 5-value union — 'create' (initial pending) + 'ipn' (NowPayments IPNs + admin-replays) + 'cancel' (customer cancel) + 'expired' (customer-side expiry) + 'swept' (admin background sweep). The 5-source taxonomy is what support uses to reconstruct who-drove-each-transition.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/crypto-orders.ts'));
    expect(p).toMatch(/'create' for the initial pending,/);
    expect(p).toMatch(/'ipn' for NowPayments IPNs \(including admin-replayed IPNs\),/);
    expect(p).toMatch(/'cancel' for customer-initiated cancellation, 'expired' for/);
    expect(p).toMatch(/customer-side expiry on the cancel endpoint, 'swept' for an/);
    expect(p).toMatch(/admin background sweep/);
  });

  // ─── idempotencyBodyFingerprint sha256 + 3-field shape ───────

  it('CRITICAL idempotencyBodyFingerprint args have 3 fields — product + price_cents + price_currency. The 3-field idempotency key dedupes by per-order-shape; drift would let identical orders create duplicate rows.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/crypto-orders.ts'));
    expect(p).toMatch(/export function idempotencyBodyFingerprint\(args: \{/);
    expect(p).toMatch(/product: string;/);
    expect(p).toMatch(/price_cents: number;/);
    expect(p).toMatch(/price_currency: string;/);
  });

  it('CRITICAL idempotencyBodyFingerprint uses sha256 hex of JSON-canonicalised 3-field tuple. Runtime parity verified against createHash("sha256")...digest("hex").', () => {
    const fp = idempotencyBodyFingerprint({
      product: 'tier_a',
      price_cents: 1000,
      price_currency: 'USD',
    });
    const expected = createHash('sha256')
      .update(JSON.stringify({ product: 'tier_a', price_cents: 1000, price_currency: 'USD' }))
      .digest('hex');
    expect(fp).toBe(expected);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('CRITICAL idempotencyBodyFingerprint distinct inputs produce distinct hashes — different product / price_cents / price_currency yield 3 distinct sha256 outputs. The discriminating-hash is what makes the idempotency key reliable.', () => {
    const a = idempotencyBodyFingerprint({
      product: 'tier_a',
      price_cents: 1000,
      price_currency: 'USD',
    });
    const b = idempotencyBodyFingerprint({
      product: 'tier_b',
      price_cents: 1000,
      price_currency: 'USD',
    });
    const c = idempotencyBodyFingerprint({
      product: 'tier_a',
      price_cents: 2000,
      price_currency: 'USD',
    });
    const d = idempotencyBodyFingerprint({
      product: 'tier_a',
      price_cents: 1000,
      price_currency: 'EUR',
    });
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  // ─── mapNowpaymentsStatus 9→5 mapping ────────────────────────

  it("CRITICAL mapNowpaymentsStatus JSDoc — 'NowPayments payment_status values map to our internal status set'. The mapping is the protocol-translation layer between NowPayments + CryptoOrderStatus.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/crypto-orders.ts'));
    expect(p).toMatch(/NowPayments payment_status values map to our internal status set/);
  });

  it('CRITICAL mapNowpaymentsStatus 9-value provider input → 5-value internal output: waiting→pending, confirming/sending→confirming, partially_paid→partial, finished→paid, failed/expired/refunded→failed, default→null. The 9→5 mapping is verified mechanically.', () => {
    expect(mapNowpaymentsStatus('waiting')).toBe('pending');
    expect(mapNowpaymentsStatus('confirming')).toBe('confirming');
    expect(mapNowpaymentsStatus('sending')).toBe('confirming');
    expect(mapNowpaymentsStatus('partially_paid')).toBe('partial');
    expect(mapNowpaymentsStatus('finished')).toBe('paid');
    expect(mapNowpaymentsStatus('failed')).toBe('failed');
    expect(mapNowpaymentsStatus('expired')).toBe('failed');
    expect(mapNowpaymentsStatus('refunded')).toBe('failed');
    expect(mapNowpaymentsStatus('unknown_status')).toBeNull();
  });

  it("CRITICAL mapNowpaymentsStatus returns null on unknown — 'unknown provider status — caller decides what to do'. The null-on-unknown contract lets the service layer decide ignore-vs-log-warn-vs-fail policy.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/crypto-orders.ts'));
    expect(p).toMatch(/return null;\s*\/\/ unknown provider status — caller decides what to do/);
  });

  // ─── V-666.I optional webhook emitter ────────────────────────

  it("CRITICAL V-666.I framing — 'V-666.I — optional webhook emitter (wire-ready posture). When provided, applyIpnStatus fires crypto.order.paid whenever an order transitions to the paid state. Best-effort: emission failures don't roll back the state transition'. The optional + best-effort design lets the service work without webhook wiring + decouples webhook failures from state machine.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/crypto-orders.ts'));
    expect(p).toMatch(/V-666\.I — optional webhook emitter \(wire-ready posture\)\. When/);
    expect(p).toMatch(/provided, applyIpnStatus fires `crypto\.order\.paid` whenever an/);
    expect(p).toMatch(/order transitions to the paid state\. Best-effort: emission/);
    expect(p).toMatch(/failures don't roll back the state transition/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/crypto-orders-v666b-state-machine-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
