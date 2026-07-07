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

import { afterEach, describe, expect, it, vi } from 'vitest';
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
  /**
   * Override `event.created` (unix seconds). Drives the event-recency
   * guard: an event with a smaller `created` is older. Defaults to now.
   */
  createdSec?: number;
}): string {
  return JSON.stringify({
    id: args.eventId,
    object: 'event',
    type: args.type,
    api_version: '2024-12-18.acacia',
    created: args.createdSec ?? nowSec(),
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
    fx = await buildTestApp({ tier: 'free' });

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
    fx = await buildTestApp({ tier: 'free' });

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
    expect(acct?.tier).toBe('free'); // unchanged
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
    fx = await buildTestApp({ tier: 'free' });
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

  it('marks the mirror canceled and downgrades account tier to free', async () => {
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
    expect(acct?.tier).toBe('free');
  });

  it('does NOT downgrade when a SUPERSEDED subscription is deleted while another subscription is still active (Fable billing re-audit 2026-07-02)', async () => {
    fx = await buildTestApp({ tier: 'free' });
    // sub_A active on api_builder → account tier api_builder.
    await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_subA_create',
        type: 'customer.subscription.created',
        stripeSubscriptionId: 'sub_A',
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_builder_monthly',
        status: 'active',
        createdSec: 1000,
      }),
    );
    // The customer re-checks out (permitted while the old one is past_due) → a
    // SECOND active subscription sub_B on api_scale. Two subscription rows now
    // exist for the one account (only stripe_subscription_id is unique).
    await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_subB_create',
        type: 'customer.subscription.created',
        stripeSubscriptionId: 'sub_B',
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_scale_monthly',
        status: 'active',
        createdSec: 1001,
      }),
    );
    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('api_scale');

    // Stripe's dunning on the OLD sub_A finally concludes → subscription.deleted
    // for sub_A. This must NOT downgrade the account — sub_B is active + billing.
    const result = (await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_subA_deleted',
        type: 'customer.subscription.deleted',
        stripeSubscriptionId: 'sub_A',
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_builder_monthly',
        status: 'canceled',
        canceledAtSec: 1002,
        createdSec: 1002,
      }),
    )) as { statusCode: number; body: { outcome: string } };
    expect(result.body.outcome).toBe('handled');
    // sub_A is canceled but the account stays on api_scale (from sub_B), NOT free.
    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('api_scale');
  });

  it('does NOT downgrade when a routine UPDATE fires on a SUPERSEDED lower subscription while a higher one is still active (Fable last-hours audit 2026-07-07, C4)', async () => {
    fx = await buildTestApp({ tier: 'free' });
    // sub_A active on api_builder, then sub_B active on api_scale → api_scale.
    await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_c4_subA_create',
        type: 'customer.subscription.created',
        stripeSubscriptionId: 'sub_A',
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_builder_monthly',
        status: 'active',
        createdSec: 2000,
      }),
    );
    await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_c4_subB_create',
        type: 'customer.subscription.created',
        stripeSubscriptionId: 'sub_B',
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_scale_monthly',
        status: 'active',
        createdSec: 2001,
      }),
    );
    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('api_scale');

    // A routine customer.subscription.updated on the LOWER sub_A — e.g. a
    // payment-method swap or metadata touch, still active on api_builder. Before
    // C4 the active branch blindly wrote api_builder, silently downgrading a
    // customer who is still paying for api_scale via sub_B. Now the branch
    // reconciles to the account's BEST active tier, so sub_A's own event can't
    // drop the account below its highest live entitlement.
    const result = (await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_c4_subA_update',
        type: 'customer.subscription.updated',
        stripeSubscriptionId: 'sub_A',
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_builder_monthly',
        status: 'active',
        createdSec: 2002,
      }),
    )) as { statusCode: number; body: { outcome: string } };
    expect(result.body.outcome).toBe('handled');
    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('api_scale');
  });

  it('a genuine single-subscription plan downgrade (api_scale → api_builder on the SAME sub) still applies (C4 does not over-block)', async () => {
    fx = await buildTestApp({ tier: 'free' });
    await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_c4_solo_create',
        type: 'customer.subscription.created',
        stripeSubscriptionId: 'sub_solo',
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_scale_monthly',
        status: 'active',
        createdSec: 3000,
      }),
    );
    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('api_scale');
    // The customer downgrades their ONE subscription to api_builder. Best-active
    // now equals the sub's new tier, so the account correctly drops to api_builder.
    await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_c4_solo_downgrade',
        type: 'customer.subscription.updated',
        stripeSubscriptionId: 'sub_solo',
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_builder_monthly',
        status: 'active',
        createdSec: 3001,
      }),
    );
    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('api_builder');
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
    fx = await buildTestApp({ tier: 'free' });
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
    expect(payload.from).toBe('free');
    expect(payload.to).toBe('api_builder');
    expect(payload.stripe_event_type).toBe('customer.subscription.created');
  });

  it('emits subscription.tier_changed when subscription.deleted downgrades to free', async () => {
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
    expect(payload.to).toBe('free');
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

// Auth-cache invalidation on a Stripe-driven tier change. The cached
// AccountContext carries the account's tier (and its derived rate-limit
// capacity); without an explicit invalidate the new tier would lag the
// 30s cache TTL after an upgrade/downgrade/cancel. Mirrors
// AdminAccountsService.changeTier (the admin path already invalidates).
// The guard matches the audit emit: real tier changes only.
describe('Stripe tier change invalidates the cached AccountContext', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('invalidates the auth cache when subscription.created upgrades the tier', async () => {
    fx = await buildTestApp({ tier: 'free' });
    const spy = vi.spyOn(fx.authCache, 'invalidateAccount');
    await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_cache_upgrade',
        type: 'customer.subscription.created',
        stripeSubscriptionId: 'sub_cache_a',
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_builder_monthly',
        status: 'active',
      }),
    );
    expect(spy).toHaveBeenCalledWith(fx.accountId);
  });

  it('invalidates the auth cache when subscription.deleted downgrades to free', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const spy = vi.spyOn(fx.authCache, 'invalidateAccount');
    await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_cache_downgrade',
        type: 'customer.subscription.deleted',
        stripeSubscriptionId: 'sub_cache_b',
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_builder_monthly',
        status: 'canceled',
        canceledAtSec: nowSec(),
      }),
    );
    expect(spy).toHaveBeenCalledWith(fx.accountId);
  });

  it('does NOT invalidate when subscription.updated keeps the same tier (no needless eviction)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const spy = vi.spyOn(fx.authCache, 'invalidateAccount');
    await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_cache_noop',
        type: 'customer.subscription.updated',
        stripeSubscriptionId: 'sub_cache_c',
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_builder_monthly',
        status: 'active',
      }),
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────
// Audit #79 — event-recency guard for out-of-order / retried Stripe events.
//
// Stripe gives NO webhook delivery-order guarantee and re-delivers failed
// deliveries for up to 3 days. Dispatch is idempotent on event.id but
// imposes no ordering, so without a recency guard a stale (older-`created`)
// `customer.subscription.updated` processed AFTER a newer one blindly
// reverts accounts.tier + the subscription mirror (current_period_end,
// status, price) to the stale value — the customer is mis-tiered (over- or
// under-privileged vs what they pay for) until the next in-order event.
//
// The fix stamps the mirror's updated_at with event.created and only
// applies an upsert when the incoming event is strictly newer than the
// stored row; the account-tier mutation is then gated on the upsert
// actually applying. These tests pin all four required behaviours and FAIL
// on the pre-fix (blind-write, processing-time) code.
// ───────────────────────────────────────────────────────────────────────
describe('Audit #79 — out-of-order / retried Stripe subscription events', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  const T1 = 1_700_000_000; // older event.created
  const T2 = T1 + 3600; // newer event.created (one hour later)
  const PERIOD_END_NEW = T2 + 30 * 24 * 60 * 60;
  const PERIOD_END_OLD = T1 + 30 * 24 * 60 * 60;

  it('(1) a stale "updated" event processed AFTER a newer one does NOT revert tier or current_period_end', async () => {
    fx = await buildTestApp({ tier: 'free' });
    const subId = 'sub_recency_revert';

    // Newer event lands first: upgrades to api_builder with the later period end.
    await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_recency_new',
        type: 'customer.subscription.updated',
        stripeSubscriptionId: subId,
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_builder_monthly',
        status: 'active',
        createdSec: T2,
        currentPeriodEndSec: PERIOD_END_NEW,
      }),
    );

    // Sanity: newer event applied.
    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('api_builder');
    let subs = fx.stripeWebhooksRepo.listSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0]?.currentPeriodEnd?.getTime()).toBe(PERIOD_END_NEW * 1000);

    // Stale (older `created`) re-delivery of a DIFFERENT price/period arrives
    // LATE. Pre-fix it blindly reverts tier→api_starter + period→OLD; with the
    // recency guard it is skipped and acked as handled.
    const stale = (await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_recency_stale',
        type: 'customer.subscription.updated',
        stripeSubscriptionId: subId,
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_starter_monthly',
        status: 'active',
        createdSec: T1,
        currentPeriodEndSec: PERIOD_END_OLD,
      }),
    )) as { statusCode: number; body: { outcome: string } };
    expect(stale.statusCode).toBe(200);
    expect(stale.body.outcome).toBe('handled');

    // Mirror + tier must STILL reflect the newer event.
    subs = fx.stripeWebhooksRepo.listSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0]?.tier).toBe('api_builder');
    expect(subs[0]?.stripePriceId).toBe('price_api_builder_monthly');
    expect(subs[0]?.currentPeriodEnd?.getTime()).toBe(PERIOD_END_NEW * 1000);
    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('api_builder');
  });

  it('(2) a newer "updated" event processed AFTER an older one DOES update the mirror + tier', async () => {
    fx = await buildTestApp({ tier: 'free' });
    const subId = 'sub_recency_apply';

    // Older event first: starter tier.
    await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_recency_old_first',
        type: 'customer.subscription.updated',
        stripeSubscriptionId: subId,
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_starter_monthly',
        status: 'active',
        createdSec: T1,
        currentPeriodEndSec: PERIOD_END_OLD,
      }),
    );
    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('api_starter');

    // Newer event in order: must upgrade to builder + advance the period end.
    await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_recency_new_second',
        type: 'customer.subscription.updated',
        stripeSubscriptionId: subId,
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_builder_monthly',
        status: 'active',
        createdSec: T2,
        currentPeriodEndSec: PERIOD_END_NEW,
      }),
    );

    const subs = fx.stripeWebhooksRepo.listSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0]?.tier).toBe('api_builder');
    expect(subs[0]?.stripePriceId).toBe('price_api_builder_monthly');
    expect(subs[0]?.currentPeriodEnd?.getTime()).toBe(PERIOD_END_NEW * 1000);
    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('api_builder');
  });

  it('(3) a fresh subscription with no existing mirror row still INSERTs + sets tier (conservative: insert always applies)', async () => {
    fx = await buildTestApp({ tier: 'free' });

    const result = (await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_recency_fresh',
        type: 'customer.subscription.created',
        stripeSubscriptionId: 'sub_recency_fresh',
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_builder_monthly',
        status: 'active',
        // Deliberately an OLD created stamp — a fresh insert has no row to
        // compare against, so it must apply regardless of how old the event is.
        createdSec: T1,
        currentPeriodEndSec: PERIOD_END_OLD,
      }),
    )) as { statusCode: number; body: { outcome: string } };
    expect(result.statusCode).toBe(200);
    expect(result.body.outcome).toBe('handled');

    const subs = fx.stripeWebhooksRepo.listSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0]?.tier).toBe('api_builder');
    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('api_builder');
  });

  it('(4) a stale "deleted" event processed AFTER a newer "updated" does NOT re-cancel / downgrade', async () => {
    fx = await buildTestApp({ tier: 'free' });
    const subId = 'sub_recency_delete';

    // An OLD cancel was generated at T1 (e.g. a failed-payment cancel) but its
    // delivery is retried for days. Meanwhile the customer fixed payment and a
    // NEWER updated event at T2 reactivated + upgraded them.
    await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_recency_reactivated',
        type: 'customer.subscription.updated',
        stripeSubscriptionId: subId,
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_builder_monthly',
        status: 'active',
        createdSec: T2,
        currentPeriodEndSec: PERIOD_END_NEW,
      }),
    );
    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('api_builder');

    // The stale cancel (created at T1 < T2) finally arrives. Pre-fix it marks
    // the mirror canceled + downgrades the active, paying customer to free.
    const stale = (await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_recency_stale_cancel',
        type: 'customer.subscription.deleted',
        stripeSubscriptionId: subId,
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_builder_monthly',
        status: 'canceled',
        createdSec: T1,
        canceledAtSec: T1,
      }),
    )) as { statusCode: number; body: { outcome: string } };
    expect(stale.statusCode).toBe(200);
    expect(stale.body.outcome).toBe('handled');

    // Mirror stays active/builder; account stays api_builder (paying customer
    // must NOT be downgraded by a stale cancel).
    const subs = fx.stripeWebhooksRepo.listSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0]?.status).toBe('active');
    expect(subs[0]?.tier).toBe('api_builder');
    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('api_builder');
  });

  it('(4b) an in-order "deleted" newer than the mirror STILL cancels + downgrades (guard does not over-block)', async () => {
    fx = await buildTestApp({ tier: 'free' });
    const subId = 'sub_recency_delete_inorder';

    await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_recency_active_first',
        type: 'customer.subscription.created',
        stripeSubscriptionId: subId,
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_builder_monthly',
        status: 'active',
        createdSec: T1,
        currentPeriodEndSec: PERIOD_END_OLD,
      }),
    );
    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('api_builder');

    // Newer cancel — must apply.
    await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_recency_cancel_second',
        type: 'customer.subscription.deleted',
        stripeSubscriptionId: subId,
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_builder_monthly',
        status: 'canceled',
        createdSec: T2,
        canceledAtSec: T2,
      }),
    );

    const subs = fx.stripeWebhooksRepo.listSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0]?.status).toBe('canceled');
    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('free');
  });
});

// ───────────────────────────────────────────────────────────────────────
// billing-edges audit — past_due/unpaid never downgraded tier.
//
// handleSubscriptionUpsert (customer.subscription.created/updated, which is
// what every Stripe dunning-status transition arrives as) only mutated
// accounts.tier when status was active/trialing. A card decline during
// Stripe's Smart Retries dunning window moves the subscription to
// past_due — and a Stripe account configured with the "mark unpaid"
// dunning policy parks it at unpaid forever — WITHOUT ever firing
// customer.subscription.deleted. Neither status touched tier, so a
// customer who stopped being billed kept full paid-tier access (session
// caps, profile caps, rate limits) indefinitely. Fixed by downgrading to
// the same `cancelDowngradeTier` target handleSubscriptionDeleted already
// uses, triggered by past_due/unpaid status too. The subscription MIRROR
// still records the real status (not 'canceled') so Stripe's own retry
// recovering the subscription to 'active' naturally re-upgrades via the
// existing active/trialing branch — no separate recovery path needed.
// ───────────────────────────────────────────────────────────────────────
describe('billing-edges audit — past_due/unpaid subscription status downgrades tier', () => {
  let fx: TestAppFixture;

  const T1 = 1_700_000_000; // older event.created
  const T2 = T1 + 3600; // newer event.created (one hour later)

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('downgrades the account to the free tier when an active subscription moves to past_due', async () => {
    fx = await buildTestApp({ tier: 'free' });
    const subId = 'sub_pastdue_001';

    // Active first — establishes the paid tier.
    await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_pastdue_active',
        type: 'customer.subscription.created',
        stripeSubscriptionId: subId,
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_builder_monthly',
        status: 'active',
        createdSec: T1,
      }),
    );
    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('api_builder');

    // Card declines; Stripe's dunning moves the subscription to past_due
    // via customer.subscription.updated. No deletion ever fires.
    const result = (await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_pastdue_update',
        type: 'customer.subscription.updated',
        stripeSubscriptionId: subId,
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_builder_monthly',
        status: 'past_due',
        createdSec: T2,
      }),
    )) as { statusCode: number; body: { outcome: string } };
    expect(result.body.outcome).toBe('handled');

    // Tier is downgraded...
    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('free');
    // ...but the mirror keeps the REAL status (past_due, not canceled) so
    // the distinction from an explicit cancel survives in the DB.
    const subs = fx.stripeWebhooksRepo.listSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0]?.status).toBe('past_due');
  });

  it('downgrades the account to the free tier when a subscription moves to unpaid (terminal dunning, never deletes)', async () => {
    fx = await buildTestApp({ tier: 'free' });
    const subId = 'sub_unpaid_001';

    await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_unpaid_active',
        type: 'customer.subscription.created',
        stripeSubscriptionId: subId,
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_builder_monthly',
        status: 'active',
        createdSec: T1,
      }),
    );
    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('api_builder');

    await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_unpaid_update',
        type: 'customer.subscription.updated',
        stripeSubscriptionId: subId,
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_builder_monthly',
        status: 'unpaid',
        createdSec: T2,
      }),
    );

    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('free');
    const subs = fx.stripeWebhooksRepo.listSubscriptions();
    expect(subs[0]?.status).toBe('unpaid');
  });

  it('re-upgrades the account when Stripe recovers a past_due subscription back to active (own retry succeeds)', async () => {
    fx = await buildTestApp({ tier: 'free' });
    const subId = 'sub_pastdue_recover_001';

    // Active -> past_due (downgrade) -> active again (Stripe's own retry
    // succeeded, e.g. the customer updated their card and Smart Retries
    // billed it successfully). Same handler, same code path, just a
    // different status value each time.
    await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_recover_active_1',
        type: 'customer.subscription.created',
        stripeSubscriptionId: subId,
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_builder_monthly',
        status: 'active',
        createdSec: T1,
      }),
    );
    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('api_builder');

    await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_recover_pastdue',
        type: 'customer.subscription.updated',
        stripeSubscriptionId: subId,
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_builder_monthly',
        status: 'past_due',
        createdSec: T2,
      }),
    );
    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('free');

    const T3 = T2 + 3600;
    const result = (await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_recover_active_2',
        type: 'customer.subscription.updated',
        stripeSubscriptionId: subId,
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_builder_monthly',
        status: 'active',
        createdSec: T3,
      }),
    )) as { statusCode: number; body: { outcome: string } };
    expect(result.body.outcome).toBe('handled');

    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('api_builder');
    const subs = fx.stripeWebhooksRepo.listSubscriptions();
    expect(subs[0]?.status).toBe('active');
  });

  it('does not downgrade on incomplete/incomplete_expired/paused (only past_due/unpaid trigger the dunning downgrade)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const subId = 'sub_other_status_001';

    await postEvent(
      fx,
      buildSubscriptionEvent({
        eventId: 'evt_other_status',
        type: 'customer.subscription.updated',
        stripeSubscriptionId: subId,
        stripeCustomerId: 'cus_test_default',
        priceId: 'price_api_builder_monthly',
        status: 'paused',
        createdSec: T1,
      }),
    );

    // Unchanged — 'paused' is neither an active-paying status nor a
    // dunning-downgrade status; this test pins that the new branch is
    // scoped to exactly past_due/unpaid and doesn't over-fire.
    expect(fx.stripeWebhooksRepo.readAccount(fx.accountId)?.tier).toBe('api_builder');
  });
});
