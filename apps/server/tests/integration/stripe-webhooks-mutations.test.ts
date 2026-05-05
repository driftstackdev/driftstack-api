// V-089: integration tests for inbound Stripe webhook mutations.
//
// Covers the actual state mutations on subscription / checkout events:
//   - customer.subscription.created → subscription mirror INSERT + tier upgrade
//   - customer.subscription.updated → subscription mirror UPDATE
//   - customer.subscription.deleted → status='canceled' + tier downgrade
//   - checkout.session.completed (mode=payment) → trial-pack provisioning
//   - checkout.session.completed (mode=subscription) → informational, no-op
//
// The V-080 test file `stripe-webhooks.test.ts` covers signature
// verification + idempotency + dispatch happy/sad paths; this file
// focuses on what gets WRITTEN as a result.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { signStripePayload } from '../../src/lib/stripe-signing.js';

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function buildSubscriptionEvent(args: {
  eventId: string;
  type:
    | 'customer.subscription.created'
    | 'customer.subscription.updated'
    | 'customer.subscription.deleted';
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  priceId: string;
  status?: string;
  cancelAtPeriodEnd?: boolean;
  currentPeriodEndSec?: number;
  canceledAtSec?: number | null;
}): string {
  return JSON.stringify({
    id: args.eventId,
    object: 'event',
    type: args.type,
    api_version: '2024-12-18.acacia',
    created: nowSec(),
    livemode: false,
    data: {
      object: {
        id: args.stripeSubscriptionId,
        customer: args.stripeCustomerId,
        status: args.status ?? 'active',
        cancel_at_period_end: args.cancelAtPeriodEnd ?? false,
        current_period_end: args.currentPeriodEndSec ?? nowSec() + 30 * 24 * 60 * 60,
        ...(args.canceledAtSec !== undefined && args.canceledAtSec !== null
          ? { canceled_at: args.canceledAtSec }
          : {}),
        items: { data: [{ price: { id: args.priceId } }] },
      },
    },
  });
}

function buildCheckoutEvent(args: {
  eventId: string;
  mode: 'subscription' | 'payment';
  stripeCustomerId: string;
  clientReferenceId?: string | null;
}): string {
  return JSON.stringify({
    id: args.eventId,
    object: 'event',
    type: 'checkout.session.completed',
    api_version: '2024-12-18.acacia',
    created: nowSec(),
    livemode: false,
    data: {
      object: {
        id: 'cs_test_xxxxx',
        mode: args.mode,
        customer: args.stripeCustomerId,
        client_reference_id: args.clientReferenceId ?? null,
      },
    },
  });
}

async function postEvent(fx: TestAppFixture, raw: string): Promise<unknown> {
  const sig = signStripePayload({ rawBody: raw, secret: fx.stripeWebhookSigningSecret });
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/webhooks/stripe',
    headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
    payload: raw,
  });
  return { statusCode: res.statusCode, body: res.json<{ outcome: string }>() };
}

describe('customer.subscription.created — mirror INSERT + tier upgrade', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('inserts a subscription mirror row and upgrades account tier on active status', async () => {
    fx = await buildTestApp({ tier: 'trial_pack' });

    const raw = buildSubscriptionEvent({
      eventId: 'evt_sub_created_001',
      type: 'customer.subscription.created',
      stripeSubscriptionId: 'sub_001',
      stripeCustomerId: 'cus_test_default',
      priceId: 'price_api_builder_monthly',
      status: 'active',
    });
    const result = (await postEvent(fx, raw)) as { statusCode: number; body: { outcome: string } };
    expect(result.statusCode).toBe(200);
    expect(result.body.outcome).toBe('handled');

    const subs = fx.stripeWebhooksRepo.listSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0]?.stripeSubscriptionId).toBe('sub_001');
    expect(subs[0]?.tier).toBe('api_builder');
    expect(subs[0]?.status).toBe('active');

    const acct = fx.stripeWebhooksRepo.readAccount(fx.accountId);
    expect(acct?.tier).toBe('api_builder');
  });

  it('does not change account tier when status is incomplete (payment hasnt cleared)', async () => {
    fx = await buildTestApp({ tier: 'trial_pack' });

    const raw = buildSubscriptionEvent({
      eventId: 'evt_sub_incomplete_001',
      type: 'customer.subscription.created',
      stripeSubscriptionId: 'sub_002',
      stripeCustomerId: 'cus_test_default',
      priceId: 'price_api_starter_monthly',
      status: 'incomplete',
    });
    await postEvent(fx, raw);

    const acct = fx.stripeWebhooksRepo.readAccount(fx.accountId);
    expect(acct?.tier).toBe('trial_pack'); // unchanged
    const subs = fx.stripeWebhooksRepo.listSubscriptions();
    expect(subs[0]?.status).toBe('incomplete'); // mirror written
  });

  it('returns ignored when stripe customer doesnt match a known account', async () => {
    fx = await buildTestApp();
    const raw = buildSubscriptionEvent({
      eventId: 'evt_sub_unknown_001',
      type: 'customer.subscription.created',
      stripeSubscriptionId: 'sub_003',
      stripeCustomerId: 'cus_unknown_xxx',
      priceId: 'price_api_builder_monthly',
    });
    const result = (await postEvent(fx, raw)) as { statusCode: number; body: { outcome: string } };
    expect(result.statusCode).toBe(200);
    expect(result.body.outcome).toBe('ignored');
    expect(fx.stripeWebhooksRepo.listSubscriptions()).toHaveLength(0);
  });
});

describe('customer.subscription.updated — UPDATE existing mirror', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('upserts a row into the same stripe_subscription_id slot', async () => {
    fx = await buildTestApp({ tier: 'trial_pack' });
    const subId = 'sub_upsert_001';

    // Create
    await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_create',
        type: 'customer.subscription.created',
        stripeSubscriptionId: subId,
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_starter_monthly',
        status: 'active',
      }),
    );
    expect(fx.stripeWebhooksRepo.listSubscriptions()).toHaveLength(1);

    // Update — change status + tier (price moves up to builder)
    await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_update',
        type: 'customer.subscription.updated',
        stripeSubscriptionId: subId,
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_builder_monthly',
        status: 'active',
        cancelAtPeriodEnd: true,
      }),
    );

    const subs = fx.stripeWebhooksRepo.listSubscriptions();
    expect(subs).toHaveLength(1); // upsert, not insert
    expect(subs[0]?.tier).toBe('api_builder');
    expect(subs[0]?.cancelAtPeriodEnd).toBe(true);

    const acct = fx.stripeWebhooksRepo.readAccount(fx.accountId);
    expect(acct?.tier).toBe('api_builder'); // upgraded
  });
});

describe('customer.subscription.deleted — cancel + downgrade', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('marks the mirror canceled and downgrades account tier to trial_pack', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });

    // Create the subscription first so the mirror exists
    await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_create_pre_delete',
        type: 'customer.subscription.created',
        stripeSubscriptionId: 'sub_delete_target',
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_builder_monthly',
        status: 'active',
      }),
    );

    // Now delete it
    const result = (await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_deleted',
        type: 'customer.subscription.deleted',
        stripeSubscriptionId: 'sub_delete_target',
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_builder_monthly',
        status: 'canceled',
        canceledAtSec: nowSec(),
      }),
    )) as { statusCode: number; body: { outcome: string } };
    expect(result.body.outcome).toBe('handled');

    const subs = fx.stripeWebhooksRepo.listSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0]?.status).toBe('canceled');
    expect(subs[0]?.canceledAt).toBeInstanceOf(Date);

    const acct = fx.stripeWebhooksRepo.readAccount(fx.accountId);
    expect(acct?.tier).toBe('trial_pack');
  });
});

describe('checkout.session.completed — trial-pack provisioning', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('payment-mode session provisions trial-pack credit + sets expires_at +14 days', async () => {
    fx = await buildTestApp({ tier: 'trial_pack' });

    const before = Date.now();
    const raw = buildCheckoutEvent({
      eventId: 'evt_checkout_payment_001',
      mode: 'payment',
      stripeCustomerId: 'cus_test_default',
      clientReferenceId: fx.accountId,
    });
    const result = (await postEvent(fx, raw)) as { statusCode: number; body: { outcome: string } };
    expect(result.body.outcome).toBe('handled');

    const acct = fx.stripeWebhooksRepo.readAccount(fx.accountId);
    expect(acct?.trialPackPurchasedAt).toBeInstanceOf(Date);
    expect(acct?.trialPackCreditCents).toBe(299);
    expect(acct?.trialPackExpiresAt).toBeInstanceOf(Date);
    expect(acct?.trialPackRedeemed).toBe(false);
    const expiresMs = acct!.trialPackExpiresAt!.getTime();
    const fourteenDays = 14 * 24 * 60 * 60 * 1000;
    expect(expiresMs).toBeGreaterThanOrEqual(before + fourteenDays - 5_000);
    expect(expiresMs).toBeLessThanOrEqual(Date.now() + fourteenDays + 5_000);
  });

  it('subscription-mode session is informational only; no trial-pack mutation', async () => {
    fx = await buildTestApp({ tier: 'trial_pack' });
    const raw = buildCheckoutEvent({
      eventId: 'evt_checkout_subscription_001',
      mode: 'subscription',
      stripeCustomerId: 'cus_test_default',
      clientReferenceId: fx.accountId,
    });
    const result = (await postEvent(fx, raw)) as { statusCode: number; body: { outcome: string } };
    expect(result.body.outcome).toBe('handled');

    const acct = fx.stripeWebhooksRepo.readAccount(fx.accountId);
    expect(acct?.trialPackPurchasedAt).toBeNull();
  });

  it('second trial-pack checkout for the same account is a no-op (already provisioned)', async () => {
    fx = await buildTestApp({ tier: 'trial_pack' });
    const raw1 = buildCheckoutEvent({
      eventId: 'evt_first',
      mode: 'payment',
      stripeCustomerId: 'cus_test_default',
      clientReferenceId: fx.accountId,
    });
    await postEvent(fx, raw1);
    const acctAfterFirst = fx.stripeWebhooksRepo.readAccount(fx.accountId);
    const firstPurchasedAt = acctAfterFirst!.trialPackPurchasedAt;
    expect(firstPurchasedAt).toBeInstanceOf(Date);

    const raw2 = buildCheckoutEvent({
      eventId: 'evt_second',
      mode: 'payment',
      stripeCustomerId: 'cus_test_default',
      clientReferenceId: fx.accountId,
    });
    const result = (await postEvent(fx, raw2)) as { statusCode: number; body: { outcome: string } };
    expect(result.body.outcome).toBe('handled');

    // The trial-pack timestamp should NOT have been overwritten.
    const acctAfterSecond = fx.stripeWebhooksRepo.readAccount(fx.accountId);
    expect(acctAfterSecond?.trialPackPurchasedAt?.getTime()).toBe(firstPurchasedAt!.getTime());
  });
});

// V-226 — subscription.tier_changed customer-facing audit emit.
describe('V-226 — subscription tier changes emit account audit entries', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  interface AuditListResponse {
    data: Array<{
      action: string;
      actor_type: string;
      payload: Record<string, unknown> | null;
    }>;
    next_cursor: string | null;
  }

  async function listTierChanges(fixture: TestAppFixture): Promise<AuditListResponse> {
    const res = await fixture.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=subscription.tier_changed',
      headers: { authorization: `Bearer ${fixture.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json<AuditListResponse>();
  }

  it('emits subscription.tier_changed when subscription.created upgrades the tier', async () => {
    fx = await buildTestApp({ tier: 'trial_pack' });
    const raw = buildSubscriptionEvent({
      eventId: 'evt_v226_upgrade',
      type: 'customer.subscription.created',
      stripeSubscriptionId: 'sub_v226_a',
      stripeCustomerId: 'cus_test_default',
      priceId: 'price_api_builder_monthly',
      status: 'active',
    });
    await postEvent(fx, raw);

    const log = await listTierChanges(fx);
    expect(log.data.length).toBe(1);
    const entry = log.data[0]!;
    expect(entry.actor_type).toBe('system');
    const payload = entry.payload as { from?: string; to?: string; stripe_event_type?: string };
    expect(payload.from).toBe('trial_pack');
    expect(payload.to).toBe('api_builder');
    expect(payload.stripe_event_type).toBe('customer.subscription.created');
  });

  it('emits subscription.tier_changed when subscription.deleted downgrades to trial_pack', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const raw = buildSubscriptionEvent({
      eventId: 'evt_v226_downgrade',
      type: 'customer.subscription.deleted',
      stripeSubscriptionId: 'sub_v226_b',
      stripeCustomerId: 'cus_test_default',
      priceId: 'price_api_builder_monthly',
      status: 'canceled',
      canceledAtSec: nowSec(),
    });
    await postEvent(fx, raw);

    const log = await listTierChanges(fx);
    expect(log.data.length).toBe(1);
    const payload = log.data[0]!.payload as { from?: string; to?: string };
    expect(payload.from).toBe('api_builder');
    expect(payload.to).toBe('trial_pack');
  });

  it('does NOT emit when subscription.updated keeps the same tier', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    // Send an update that keeps the same price (same tier).
    const raw = buildSubscriptionEvent({
      eventId: 'evt_v226_noop',
      type: 'customer.subscription.updated',
      stripeSubscriptionId: 'sub_v226_c',
      stripeCustomerId: 'cus_test_default',
      priceId: 'price_api_builder_monthly',
      status: 'active',
    });
    await postEvent(fx, raw);

    const log = await listTierChanges(fx);
    expect(log.data.length).toBe(0);
  });
});
