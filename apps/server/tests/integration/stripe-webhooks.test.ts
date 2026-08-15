// Integration tests for the V-080 Stripe webhook surface.
//
// Covers signature verification (valid / invalid / replay), idempotency
// (duplicate event.id short-circuits to 200), event-type dispatch
// (handled vs ignored), and malformed payloads.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { signStripePayload } from '../../src/lib/stripe-signing.js';

interface PostBody {
  raw: string;
  signature: string;
}

/**
 * Build a Stripe event payload for tests. For subscription events we
 * synthesize the minimal shape the V-089 handler needs: `id`, `customer`,
 * `status`, and an `items.data[0].price.id` array. Caller can override
 * any field via `extra`.
 */
function makeEvent(eventId: string, type: string, extra: Record<string, unknown> = {}): string {
  const isSubscription = type.startsWith('customer.subscription.');
  const baseObject: Record<string, unknown> = isSubscription
    ? {
        id: 'sub_test_123',
        customer: 'cus_test_default',
        status: 'active',
        cancel_at_period_end: false,
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        items: {
          data: [{ price: { id: 'price_api_builder_monthly' } }],
        },
        ...extra,
      }
    : { id: 'sub_test_123', ...extra };

  return JSON.stringify({
    id: eventId,
    object: 'event',
    type,
    api_version: '2024-12-18.acacia',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: { object: baseObject },
    request: { id: 'req_test', idempotency_key: null },
  });
}

function signWithFixture(fx: TestAppFixture, raw: string, timestampSec?: number): PostBody {
  const sig = signStripePayload({
    rawBody: raw,
    secret: fx.stripeWebhookSigningSecret,
    timestampSec,
  });
  return { raw, signature: sig };
}

describe('POST /v1/webhooks/stripe — signature verification', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('200 on valid signature + known event type', async () => {
    fx = await buildTestApp();
    const raw = makeEvent('evt_001', 'customer.subscription.created');
    const { signature } = signWithFixture(fx, raw);

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: {
        'stripe-signature': signature,
        'content-type': 'application/json',
      },
      payload: raw,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ received: boolean; outcome: string }>();
    expect(body.received).toBe(true);
    expect(body.outcome).toBe('handled');
    expect(fx.stripeWebhooksRepo.list()).toHaveLength(1);
  });

  // V-742 — a subscription whose Stripe price id is NOT in priceToTier must not
  // be mirrored as 'enterprise'.
  //
  // The mirror row needs a tier to satisfy the NOT NULL column, and the filler
  // used to be 'enterprise'. It was inert when written (the grant on this event
  // is gated on the price being mapped) and became load-bearing once the
  // rank-aware recompute began reading subscriptions.tier back out:
  // tierActivationRank derives from TIER_MONTHLY_PRICE_CENTS, which has no
  // enterprise entry, so it falls through to POSITIVE_INFINITY and the placeholder
  // outranks every real tier unconditionally. The recompute then writes
  // accounts.tier = 'enterprise' — 32 concurrent fleet browsers against
  // api_starter's 2, unlimited session minutes, and profile-storage-quota clamps
  // enterprise to 'soft' so the launch gate's hard block never fires. Nothing
  // recomputes accounts.tier from Stripe truth afterwards.
  it('mirrors an UNMAPPED price without claiming enterprise, and leaves the account tier alone', async () => {
    fx = await buildTestApp();
    fx.stripeWebhooksRepo.registerAccount({
      accountId: fx.accountId,
      stripeCustomerId: 'cus_test_default',
      tier: 'api_starter',
    });

    const raw = makeEvent('evt_unmapped_price', 'customer.subscription.created', {
      customer: 'cus_test_default',
      items: { data: [{ price: { id: 'price_bespoke_not_in_map' } }] },
    });
    const { signature } = signWithFixture(fx, raw);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);

    const mirrored = fx.stripeWebhooksRepo.listSubscriptions();
    expect(mirrored).toHaveLength(1);
    // The defect at its source: the filler must never be the top-ranked tier.
    expect(mirrored[0]!.tier).not.toBe('enterprise');
    // And it is the account's CURRENT tier, so the row cannot move the account in
    // either direction — which is what the handler's log line already claims
    // ("mirror written without tier change").
    expect(mirrored[0]!.tier).toBe('api_starter');
    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('api_starter');
  });

  it('401 on missing Stripe-Signature header', async () => {
    fx = await buildTestApp();
    const raw = makeEvent('evt_002', 'customer.subscription.created');
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: raw,
    });
    expect(res.statusCode).toBe(401);
  });

  // The third refusal on this route, and the only one that was uncovered —
  // measured by neutralizing each of the four in turn: the missing-header and
  // invalid-signature refusals red existing arms, this one did not.
  //
  // ⚠️ It is NOT a security boundary, and saying so is the point of covering it
  // deliberately rather than by reflex. An empty body would fail signature
  // verification anyway, so nothing gets past by removing this. What it owns is
  // the ORDER: a present-but-empty body is answered 400 "Empty request body."
  // before any HMAC work, so an integrator misconfiguring their endpoint reads a
  // sentence about their body instead of "Invalid Stripe signature" — which
  // would send them to rotate a secret that was never the problem.
  //
  // LEDGER — control 13/13:
  //
  //   :73 empty-body guard neutralized            1 red
  //   :89 invalid-signature guard neutralized     3 red (pre-existing)
  //   the empty-body check moved AFTER verify     1 red
  //
  // The third row is why this arm signs the empty string rather than sending a
  // bare request: with the check deleted and `rawBody ?? ''` flowing on, the
  // request reaches signature verification and is refused THERE. Only a
  // legitimately-signed empty body can tell the two orderings apart, and that is
  // exactly the misconfigured-integrator case the guard exists for.
  it('400 on a present signature with an EMPTY body, before signature verification', async () => {
    fx = await buildTestApp();
    // A real signature over the empty string: the header is well-formed, so the
    // request cannot be refused for the reason the arm above covers.
    const sig = signStripePayload({ rawBody: '', secret: fx.stripeWebhookSigningSecret });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': sig },
      payload: '',
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ detail: string }>().detail).toMatch(/empty request body/i);
  });

  it('401 on invalid signature (wrong secret)', async () => {
    fx = await buildTestApp();
    const raw = makeEvent('evt_003', 'customer.subscription.created');
    const sig = signStripePayload({ rawBody: raw, secret: 'whsec_wrong_secret' });

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: {
        'stripe-signature': sig,
        'content-type': 'application/json',
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(401);
    expect(fx.stripeWebhooksRepo.list()).toHaveLength(0);
  });

  it('401 on signature outside the tolerance window (timestamp 10 minutes old)', async () => {
    fx = await buildTestApp();
    const raw = makeEvent('evt_004', 'customer.subscription.created');
    const tenMinAgo = Math.floor(Date.now() / 1000) - 10 * 60;
    const { signature } = signWithFixture(fx, raw, tenMinAgo);

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: {
        'stripe-signature': signature,
        'content-type': 'application/json',
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(401);
  });

  it('401 on malformed signature header', async () => {
    fx = await buildTestApp();
    const raw = makeEvent('evt_005', 'customer.subscription.created');

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: {
        'stripe-signature': 'this is not a valid stripe signature',
        'content-type': 'application/json',
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /v1/webhooks/stripe — idempotency', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('duplicate event.id returns 200 with outcome=duplicate; only first is recorded', async () => {
    fx = await buildTestApp();
    const raw = makeEvent('evt_dup_001', 'invoice.payment_succeeded');
    const { signature } = signWithFixture(fx, raw);

    const first = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      payload: raw,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ outcome: string }>().outcome).toBe('handled');

    // Re-deliver the SAME event (Stripe does this within 3 days).
    const second = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      payload: raw,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ outcome: string }>().outcome).toBe('duplicate');

    expect(fx.stripeWebhooksRepo.list()).toHaveLength(1);
  });
});

describe('POST /v1/webhooks/stripe — dispatch', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('handles subscription lifecycle events', async () => {
    fx = await buildTestApp();
    for (const t of [
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
    ]) {
      const raw = makeEvent(`evt_sub_${t}`, t);
      const { signature } = signWithFixture(fx, raw);
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/webhooks/stripe',
        headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
        payload: raw,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ outcome: string }>().outcome).toBe('handled');
    }
    expect(fx.stripeWebhooksRepo.list()).toHaveLength(3);
  });

  it('handles invoice.payment events', async () => {
    fx = await buildTestApp();
    for (const t of ['invoice.payment_succeeded', 'invoice.payment_failed', 'invoice.finalized']) {
      const raw = makeEvent(`evt_inv_${t}`, t);
      const { signature } = signWithFixture(fx, raw);
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/webhooks/stripe',
        headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
        payload: raw,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ outcome: string }>().outcome).toBe('handled');
    }
  });

  it('returns outcome=ignored for unknown event types', async () => {
    fx = await buildTestApp();
    const raw = makeEvent('evt_radar_001', 'radar.early_fraud_warning.created');
    const { signature } = signWithFixture(fx, raw);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ outcome: string }>().outcome).toBe('ignored');
  });
});

describe('POST /v1/webhooks/stripe — concurrent delivery race (V-085)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('two concurrent deliveries of the same event end with exactly one ledger row', async () => {
    fx = await buildTestApp();
    const raw = makeEvent('evt_concurrent_001', 'customer.subscription.created');
    const { signature } = signWithFixture(fx, raw);

    // Fire the same event twice in parallel — both should pass signature
    // verification, but only one should win the recordEvent insert
    // (ON CONFLICT DO NOTHING in Drizzle; first-writer-wins in
    // InMemoryStripeWebhooksRepo).
    const [first, second] = await Promise.all([
      fx.app.inject({
        method: 'POST',
        url: '/v1/webhooks/stripe',
        headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
        payload: raw,
      }),
      fx.app.inject({
        method: 'POST',
        url: '/v1/webhooks/stripe',
        headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
        payload: raw,
      }),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const outcomes = [
      first.json<{ outcome: string }>().outcome,
      second.json<{ outcome: string }>().outcome,
    ];
    // One should be 'handled' (the winner) and the other should be
    // 'duplicate' (the loser saw the row in hasEvent OR lost the
    // ON CONFLICT race in recordEvent).
    expect(outcomes.sort()).toEqual(['duplicate', 'handled']);
    expect(fx.stripeWebhooksRepo.list()).toHaveLength(1);
  });
});

describe('POST /v1/webhooks/stripe — malformed payloads', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('400 when the body parses but is missing event.id', async () => {
    fx = await buildTestApp();
    const raw = JSON.stringify({ type: 'customer.subscription.created', data: { object: {} } });
    const { signature } = signWithFixture(fx, raw);

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      payload: raw,
    });
    expect(res.statusCode).toBe(400);
  });
});
