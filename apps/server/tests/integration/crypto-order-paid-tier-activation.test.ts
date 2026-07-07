// S41 2026-07-07 (founder-approved: wire crypto activation) — integration
// tests for account-tier activation on the crypto paid transition.
//
// Closes the S37-audit gap: a paid NowPayments IPN used to fire the
// crypto.order.paid webhook + receipt email but NEVER upgraded the
// account's tier. These tests drive the REAL signed-IPN route (and the
// admin apply-ipn route — the other paid driver) end-to-end and prove:
//   1. a paid IPN upgrades the account to the order's purchased tier,
//      records the subscription.tier_changed audit row (system actor,
//      crypto_order_id/crypto_payment_id payload), and sends the
//      tier-changed email;
//   2. a duplicate / replayed paid IPN is a no-op (no re-apply, no
//      flip-flop, no duplicate audit row or email);
//   3. a STALE order does not downgrade — an account that moved to a
//      higher tier after the order was minted keeps it (the order still
//      settles as paid; only the tier write is skipped);
//   4. a re-purchase of the tier the account already holds is a
//      no-op (no audit row, no email);
//   5. the admin apply-ipn path activates identically (activation lives
//      at the single paid-transition point in applyIpnStatus, not in a
//      route).

import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import type { CryptoOrder } from '../../src/services/crypto-orders.js';

let fx: TestAppFixture;
afterEach(async () => {
  if (fx) await fx.cleanup();
});

const IPN_SECRET = 'ipn-test-secret-s41';
const ROUTE = '/v1/webhooks/nowpayments';

// Signing mirrors webhooks-nowpayments.test.ts — HMAC-SHA512 over the
// canonicalised (sorted-keys) JSON body.
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return out;
}

function signIpn(payload: Record<string, unknown>, secret: string): { body: string; sig: string } {
  const body = JSON.stringify(payload);
  const canonical = JSON.stringify(canonicalize(payload));
  const sig = createHmac('sha512', secret).update(canonical).digest('hex');
  return { body, sig };
}

async function postIpn(
  fixture: TestAppFixture,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; order_state: string | null }> {
  const { body, sig } = signIpn(payload, IPN_SECRET);
  const res = await fixture.app.inject({
    method: 'POST',
    url: ROUTE,
    headers: { 'content-type': 'application/json', 'x-nowpayments-sig': sig },
    payload: body,
  });
  const out = res.json<{ received: boolean; order_state: string | null }>();
  return { statusCode: res.statusCode, order_state: out.order_state };
}

// Seed mirrors admin-crypto-orders-apply-ipn.test.ts.
async function seed(
  fixture: TestAppFixture,
  order: Partial<CryptoOrder> & { order_id: string; product: string },
): Promise<void> {
  const now = Date.now();
  await fixture.cryptoOrdersRepo.upsert({
    account_id: fixture.accountId,
    price_cents: 49900,
    price_currency: 'USD',
    payment_id: null,
    pay_amount: null,
    pay_currency: null,
    status: 'pending',
    customer_note: null,
    internal_note: null,
    events: [{ status: 'pending', at: now, source: 'create' }],
    created_at: now,
    updated_at: now,
    ...order,
  });
}

function tierChangedAuditRows(fixture: TestAppFixture) {
  return fixture.accountAuditRepo.getAll().filter((r) => r.action === 'subscription.tier_changed');
}

function tierChangedEmails(fixture: TestAppFixture) {
  return fixture.emailSends.filter((s) => s.template === 'tier-changed');
}

describe('S41 crypto paid → account tier activation', () => {
  it('paid IPN upgrades the account to the purchased tier + records the audit row + sends the tier-changed email', async () => {
    fx = await buildTestApp({ nowpaymentsIpnSecret: IPN_SECRET, tier: 'free' });
    await seed(fx, {
      order_id: 'ord_s41_upgrade',
      product: 'api_builder',
      payment_id: 'pay_s41_1',
      pay_amount: 0.01,
      pay_currency: 'btc',
    });

    const res = await postIpn(fx, {
      payment_id: 'pay_s41_1',
      payment_status: 'finished',
      order_id: 'ord_s41_upgrade',
      actually_paid: 0.01,
      pay_amount: 0.01,
      pay_currency: 'btc',
      price_amount: 499,
      price_currency: 'USD',
    });
    expect(res.statusCode).toBe(200);
    expect(res.order_state).toBe('paid');

    // The account tier was activated (accounts.tier facet in the shared
    // in-memory Stripe-webhooks repo — the same store Stripe events write).
    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('api_builder');

    // Customer audit row: system actor, existing tier-change action, with
    // the crypto-order cross-reference payload (and NO stripe_* fields).
    const rows = tierChangedAuditRows(fx);
    expect(rows.length).toBe(1);
    expect(rows[0]!.actorType).toBe('system');
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload.from).toBe('free');
    expect(payload.to).toBe('api_builder');
    expect(payload.crypto_order_id).toBe('ord_s41_upgrade');
    expect(payload.crypto_payment_id).toBe('pay_s41_1');
    expect(payload.stripe_event_type).toBeUndefined();

    // Customer-visible audit surface (same route the dashboard reads).
    const auditRes = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=subscription.tier_changed',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(auditRes.statusCode).toBe(200);
    const audit = auditRes.json<{ data: Array<{ action: string }> }>();
    expect(audit.data.length).toBe(1);

    // Tier-changed email went out via the lifecycle dispatcher.
    expect(tierChangedEmails(fx).length).toBe(1);
  });

  it('a duplicate / replayed paid IPN is a no-op — no re-apply, no duplicate audit row or email', async () => {
    fx = await buildTestApp({ nowpaymentsIpnSecret: IPN_SECRET, tier: 'free' });
    await seed(fx, {
      order_id: 'ord_s41_dup',
      product: 'team_manual',
      payment_id: 'pay_s41_2',
    });

    const ipn = {
      payment_id: 'pay_s41_2',
      payment_status: 'finished',
      order_id: 'ord_s41_dup',
    };
    const first = await postIpn(fx, ipn);
    expect(first.order_state).toBe('paid');
    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('team_manual');

    // NowPayments re-delivers the exact same IPN — the order is already
    // paid, so firePaid does not re-fire and the activator is not invoked.
    const second = await postIpn(fx, ipn);
    expect(second.statusCode).toBe(200);
    expect(second.order_state).toBe('paid');

    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('team_manual');
    expect(tierChangedAuditRows(fx).length).toBe(1);
    expect(tierChangedEmails(fx).length).toBe(1);
  });

  it('a STALE order does not downgrade — an account upgraded after the order was minted keeps its higher tier', async () => {
    // The account moved to api_scale (e.g. a Stripe subscription started)
    // AFTER this solo_manual order was minted. The order still settles as
    // paid (payment accepted, receipt available) but the no-downgrade rule
    // skips the tier write: no change, no audit row, no email.
    fx = await buildTestApp({ nowpaymentsIpnSecret: IPN_SECRET, tier: 'api_scale' });
    await seed(fx, {
      order_id: 'ord_s41_stale',
      product: 'solo_manual',
      payment_id: 'pay_s41_3',
    });

    const res = await postIpn(fx, {
      payment_id: 'pay_s41_3',
      payment_status: 'finished',
      order_id: 'ord_s41_stale',
    });
    expect(res.statusCode).toBe(200);
    expect(res.order_state).toBe('paid'); // the ORDER is paid…

    // …but the tier was NOT downgraded, and nothing was emitted.
    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('api_scale');
    expect(tierChangedAuditRows(fx).length).toBe(0);
    expect(tierChangedEmails(fx).length).toBe(0);
  });

  it('re-purchasing the tier the account already holds is a no-op (no flip-flop, no audit row, no email)', async () => {
    fx = await buildTestApp({ nowpaymentsIpnSecret: IPN_SECRET, tier: 'api_builder' });
    await seed(fx, {
      order_id: 'ord_s41_same',
      product: 'api_builder',
      payment_id: 'pay_s41_4',
    });

    const res = await postIpn(fx, {
      payment_id: 'pay_s41_4',
      payment_status: 'finished',
      order_id: 'ord_s41_same',
    });
    expect(res.order_state).toBe('paid');

    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('api_builder');
    expect(tierChangedAuditRows(fx).length).toBe(0);
    expect(tierChangedEmails(fx).length).toBe(0);
  });

  it('the admin apply-ipn path activates identically (activation lives at the single paid transition in applyIpnStatus)', async () => {
    fx = await buildTestApp({
      tier: 'free',
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    await seed(fx, { order_id: 'ord_s41_admin', product: 'agency_manual' });

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/crypto-orders/ord_s41_admin/apply-ipn',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
      },
      payload: { provider_status: 'finished', payment_id: 'pay_s41_5' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('paid');

    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('agency_manual');
    const rows = tierChangedAuditRows(fx);
    expect(rows.length).toBe(1);
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload.from).toBe('free');
    expect(payload.to).toBe('agency_manual');
    expect(payload.crypto_order_id).toBe('ord_s41_admin');
  });

  it('an under-paid "finished" IPN routes to partial and does NOT activate the tier', async () => {
    // Amount-reconciliation guard interplay: NowPayments "finished" with a
    // short crypto amount lands in `partial` — no goods, no tier.
    fx = await buildTestApp({ nowpaymentsIpnSecret: IPN_SECRET, tier: 'free' });
    await seed(fx, {
      order_id: 'ord_s41_short',
      product: 'api_builder',
      payment_id: 'pay_s41_6',
      pay_amount: 0.01,
      pay_currency: 'btc',
    });

    const res = await postIpn(fx, {
      payment_id: 'pay_s41_6',
      payment_status: 'finished',
      order_id: 'ord_s41_short',
      actually_paid: 0.005, // well under the 1%-tolerance floor
      pay_amount: 0.01,
      pay_currency: 'btc',
    });
    expect(res.order_state).toBe('partial');

    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('free');
    expect(tierChangedAuditRows(fx).length).toBe(0);
    expect(tierChangedEmails(fx).length).toBe(0);
  });
});
