// S41 2026-07-07 (founder-approved: wire crypto activation) — unit tests
// for the upgrade-only decision rule + CryptoTierActivationService.
//
// The integration suite (tests/integration/crypto-order-paid-tier-
// activation.test.ts) proves the end-to-end IPN flow; this file pins the
// MONEY-critical decision table (price-rank strict-greater; free lowest;
// enterprise/unpriced never overwritten; cross-ladder compares by price)
// and the service's fan-out/skip behaviour against a mock repo.

import { describe, expect, it, vi } from 'vitest';
import { AccountTierSchema, type AccountTier } from '@driftstack/api-types';
import { TIER_MONTHLY_PRICE_CENTS } from '../../src/lib/cost-defaults.js';
import {
  CRYPTO_ENTITLEMENT_TERM_DAYS,
  CryptoTierActivationService,
  isCryptoTierUpgrade,
  tierActivationRank,
} from '../../src/services/crypto-tier-activation.js';
import type { Logger } from '../../src/lib/logger.js';
import type { AccountLifecycleService } from '../../src/services/account-lifecycle.js';
import type { AuthCache } from '../../src/services/auth-cache.js';
import { InMemoryStripeWebhooksRepo } from '../integration/_helpers/in-memory-stripe-webhooks-repo.js';

function makeLogger(): Logger & {
  errors: unknown[][];
  warns: unknown[][];
  infos: unknown[][];
} {
  const errors: unknown[][] = [];
  const warns: unknown[][] = [];
  const infos: unknown[][] = [];
  return {
    errors,
    warns,
    infos,
    error: (...args: unknown[]) => void errors.push(args),
    warn: (...args: unknown[]) => void warns.push(args),
    info: (...args: unknown[]) => void infos.push(args),
    debug: () => undefined,
    trace: () => undefined,
    fatal: () => undefined,
    child: function () {
      return this;
    },
  } as unknown as Logger & { errors: unknown[][]; warns: unknown[][]; infos: unknown[][] };
}

describe('S41 tierActivationRank', () => {
  it('free ranks 0 — below every purchasable tier', () => {
    expect(tierActivationRank('free')).toBe(0);
  });

  it('the six self-serve tiers rank by monthly price (pairwise distinct)', () => {
    const ranks = [
      'solo_manual',
      'api_starter',
      'team_manual',
      'api_builder',
      'agency_manual',
      'api_scale',
    ].map((t) => tierActivationRank(t as AccountTier));
    // $79 < $149 < $249 < $499 < $699 < $1,499 — strictly increasing.
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]!).toBeGreaterThan(ranks[i - 1]!);
    }
  });

  it('enterprise (no self-serve price) ranks +Infinity — never overwritable by a self-serve purchase', () => {
    expect(tierActivationRank('enterprise')).toBe(Number.POSITIVE_INFINITY);
  });

  // V-1732 — the arm above pins the two tiers that are deliberately unpriced, and
  // the one above THAT walks the six self-serve tiers as a hardcoded list. Neither
  // can notice a SEVENTH. `tierActivationRank` falls back to
  // `?? Number.POSITIVE_INFINITY`, so a tier added to the enum and forgotten in
  // TIER_MONTHLY_PRICE_CENTS does not rank low or throw — it ranks ABOVE EVERY
  // PAID TIER, and `isCryptoTierUpgrade` then treats buying it as an upgrade from
  // any state while refusing every later move away from it. That is a money
  // decision failing open, silently, on an omission rather than a mistake.
  //
  // Every other consumer iterates `Object.keys(TIER_MONTHLY_PRICE_CENTS)`, which
  // walks the MAP and is therefore structurally blind to an enum member missing
  // from it. This arm walks the ENUM instead — the one direction that can see the
  // omission — and requires each tier to be priced or deliberately ranked.
  it('CRITICAL every AccountTier is priced or deliberately unpriced. The rank fallback is +Infinity, so a tier added to the enum and forgotten here outranks $1,499/mo api_scale and can never be upgraded away from.', () => {
    const DELIBERATELY_UNPRICED = new Map<AccountTier, number>([
      // Lowest by construction; the rank function special-cases it.
      ['free', 0],
      // No self-serve price by design — sales-negotiated — so a crypto purchase
      // must never overwrite it and no self-serve tier may outrank it.
      ['enterprise', Number.POSITIVE_INFINITY],
    ]);
    const all = AccountTierSchema.options as readonly AccountTier[];
    expect(all.length, 'the tier enum parsed').toBeGreaterThan(2);

    const unaccounted = all.filter(
      (t) => TIER_MONTHLY_PRICE_CENTS[t] === undefined && !DELIBERATELY_UNPRICED.has(t),
    );
    expect(
      unaccounted,
      'tiers absent from TIER_MONTHLY_PRICE_CENTS and not declared deliberately unpriced — price them, or add them above with the rank they should carry and why',
    ).toEqual([]);

    // The declared ranks must be what the function actually returns, so this
    // roster cannot drift from the behaviour it claims to describe.
    for (const [tier, rank] of DELIBERATELY_UNPRICED) {
      expect(tierActivationRank(tier), `${tier} does not rank as declared`).toBe(rank);
    }
    // And a priced tier must rank by its price, not by the fallback.
    for (const tier of all.filter((t) => TIER_MONTHLY_PRICE_CENTS[t] !== undefined)) {
      expect(tierActivationRank(tier), `${tier} should rank by price`).toBe(
        TIER_MONTHLY_PRICE_CENTS[tier],
      );
    }
  });
});

describe('S41 isCryptoTierUpgrade decision table', () => {
  const cases: Array<[AccountTier, AccountTier, boolean]> = [
    // account on free → every paid tier applies
    ['free', 'solo_manual', true],
    ['free', 'api_scale', true],
    // real upgrades within + across ladders (price-ranked)
    ['solo_manual', 'api_builder', true],
    ['team_manual', 'agency_manual', true],
    ['api_starter', 'team_manual', true], // $149 → $249: cross-ladder upgrade
    // same tier — idempotent no-op, not an upgrade
    ['api_builder', 'api_builder', false],
    // downgrades never apply
    ['api_builder', 'solo_manual', false],
    ['api_scale', 'agency_manual', false], // $1,499 > $699 even cross-ladder
    ['team_manual', 'api_starter', false], // $249 > $149: cross-ladder downgrade
    // enterprise is never overwritten
    ['enterprise', 'api_scale', false],
    // purchasing "free" can never apply (rank 0 is never strictly greater)
    ['solo_manual', 'free', false],
    ['free', 'free', false],
  ];
  for (const [current, purchased, expected] of cases) {
    it(`${current} + purchased ${purchased} → ${expected ? 'apply' : 'skip'}`, () => {
      expect(isCryptoTierUpgrade(current, purchased)).toBe(expected);
    });
  }
});

describe('C1 CryptoTierActivationService (entitlement-backed)', () => {
  const intent = {
    account_id: 'acc_1',
    order_id: 'ord_1',
    product: 'api_builder',
    payment_id: 'pay_1',
    paid_at: '2026-07-07T10:00:00.000Z',
  };
  const START = new Date('2026-07-07T10:00:00.000Z');
  const EXPIRES = new Date('2026-08-07T10:00:00.000Z');

  function makeDeps(repoResult: {
    previousTier: AccountTier | null;
    applied: boolean;
    entitlementInserted: boolean;
    startsAt?: Date;
    expiresAt?: Date;
  }) {
    const full = { startsAt: START, expiresAt: EXPIRES, ...repoResult };
    const repo = {
      activateCryptoEntitlement: vi.fn().mockResolvedValue(full),
      revokeCryptoEntitlementByOrderId: vi.fn().mockResolvedValue({ revoked: false }),
      downgradeAccountTierToBestRemaining: vi
        .fn()
        .mockResolvedValue({ previousTier: null, appliedTier: 'free' as AccountTier }),
    };
    const emit = vi.fn().mockResolvedValue(undefined);
    const lifecycle = { emit } as unknown as AccountLifecycleService;
    const invalidateAccount = vi.fn().mockResolvedValue(undefined);
    const authCache = { invalidateAccount } as unknown as AuthCache;
    const logger = makeLogger();
    const service = new CryptoTierActivationService(repo, logger, lifecycle, authCache);
    return { repo, emit, invalidateAccount, logger, service };
  }

  it('upgrade applied → records the entitlement, invalidates cache, emits tier_changed with the crypto cross-reference', async () => {
    const d = makeDeps({ previousTier: 'free', applied: true, entitlementInserted: true });
    await d.service.activateTierForPaidOrder(intent);
    expect(d.repo.activateCryptoEntitlement).toHaveBeenCalledWith({
      accountId: 'acc_1',
      orderId: 'ord_1',
      tier: 'api_builder',
      paidAt: START,
      termDays: CRYPTO_ENTITLEMENT_TERM_DAYS,
    });
    expect(d.invalidateAccount).toHaveBeenCalledWith('acc_1');
    expect(d.emit).toHaveBeenCalledTimes(1);
    expect(d.emit).toHaveBeenCalledWith('acc_1', {
      kind: 'subscription.tier_changed',
      fromTier: 'free',
      toTier: 'api_builder',
      effectiveAt: START,
      cryptoOrderId: 'ord_1',
      cryptoPaymentId: 'pay_1',
    });
    const [obj] = d.logger.infos.at(-1) as [Record<string, unknown>];
    expect(obj.event).toBe('crypto_paid_tier_activated');
    expect(obj.expires_at).toBe(EXPIRES.toISOString());
  });

  it('replay (order already recorded) → no cache invalidation, no emit, replay info log', async () => {
    const d = makeDeps({ previousTier: 'api_builder', applied: false, entitlementInserted: false });
    await d.service.activateTierForPaidOrder(intent);
    expect(d.invalidateAccount).not.toHaveBeenCalled();
    expect(d.emit).not.toHaveBeenCalled();
    expect(d.logger.errors.length).toBe(0);
    const [obj] = d.logger.infos.at(-1) as [Record<string, unknown>];
    expect(obj.event).toBe('crypto_paid_tier_activation_replay');
  });

  it('same-tier re-purchase (entitlement extended, tier unchanged) → no emit, extended info log', async () => {
    const d = makeDeps({ previousTier: 'api_builder', applied: false, entitlementInserted: true });
    await d.service.activateTierForPaidOrder(intent);
    expect(d.emit).not.toHaveBeenCalled();
    expect(d.logger.warns.length).toBe(0);
    const [obj] = d.logger.infos.at(-1) as [Record<string, unknown>];
    expect(obj.event).toBe('crypto_paid_tier_activation_extended');
    expect(obj.expires_at).toBe(EXPIRES.toISOString());
  });

  it('lower-tier purchase while holding a higher tier → entitlement recorded as a floor, no emit, info (not warn)', async () => {
    const d = makeDeps({ previousTier: 'api_scale', applied: false, entitlementInserted: true });
    await d.service.activateTierForPaidOrder({ ...intent, product: 'solo_manual' });
    expect(d.invalidateAccount).not.toHaveBeenCalled();
    expect(d.emit).not.toHaveBeenCalled();
    expect(d.logger.warns.length).toBe(0);
    const [obj] = d.logger.infos.at(-1) as [Record<string, unknown>];
    expect(obj.event).toBe('crypto_paid_tier_activation_recorded_below_current');
    expect(obj.current_tier).toBe('api_scale');
    expect(obj.purchased_tier).toBe('solo_manual');
  });

  it('account not found → integrity-alarm error log, no emit (no entitlement recorded)', async () => {
    const d = makeDeps({ previousTier: null, applied: false, entitlementInserted: false });
    await d.service.activateTierForPaidOrder(intent);
    expect(d.emit).not.toHaveBeenCalled();
    expect(d.logger.errors.length).toBe(1);
    const [obj] = d.logger.errors[0] as [Record<string, unknown>];
    expect(obj.event).toBe('crypto_paid_tier_activation_account_missing');
  });

  it('non-activatable product (legacy/ops-seeded) → repo NEVER called + integrity-alarm error log', async () => {
    for (const product of ['trial_pack', 'free', 'enterprise', 'not-a-tier']) {
      const d = makeDeps({ previousTier: 'free', applied: true, entitlementInserted: true });
      await d.service.activateTierForPaidOrder({ ...intent, product });
      expect(d.repo.activateCryptoEntitlement).not.toHaveBeenCalled();
      expect(d.emit).not.toHaveBeenCalled();
      expect(d.logger.errors.length).toBe(1);
      const [obj] = d.logger.errors[0] as [Record<string, unknown>];
      expect(obj.event).toBe('crypto_paid_tier_activation_unactivatable_product');
    }
  });

  it('malformed paid_at falls back to now() — the entitlement write never gets an Invalid Date', async () => {
    const d = makeDeps({ previousTier: 'free', applied: true, entitlementInserted: true });
    const before = Date.now();
    await d.service.activateTierForPaidOrder({ ...intent, paid_at: 'garbage' });
    const arg = d.repo.activateCryptoEntitlement.mock.calls[0]![0] as { paidAt: Date };
    expect(Number.isNaN(arg.paidAt.getTime())).toBe(false);
    expect(arg.paidAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('auth-cache failure never blocks activation (lifecycle still emits)', async () => {
    const d = makeDeps({ previousTier: 'free', applied: true, entitlementInserted: true });
    d.invalidateAccount.mockRejectedValueOnce(new Error('redis down'));
    await d.service.activateTierForPaidOrder(intent);
    expect(d.emit).toHaveBeenCalledTimes(1);
  });
});

// C3 — refund/chargeback clawback (revokeTierForRefundedOrder). Backed by the
// real InMemoryStripeWebhooksRepo so the entitlement revoke + the SAME
// best-remaining reconcile machinery (downgradeAccountTierToBestRemaining) run
// exactly as in prod — proving non-stranding + idempotency end-to-end, not just
// against a mock repo.
describe('C3 CryptoTierActivationService.revokeTierForRefundedOrder', () => {
  const NOW = new Date('2026-07-10T12:00:00.000Z');
  const PAID_AT = new Date('2026-07-08T10:00:00.000Z');

  function makeRefundDeps() {
    const repo = new InMemoryStripeWebhooksRepo();
    const emit = vi.fn().mockResolvedValue(undefined);
    const lifecycle = { emit } as unknown as AccountLifecycleService;
    const invalidateAccount = vi.fn().mockResolvedValue(undefined);
    const authCache = { invalidateAccount } as unknown as AuthCache;
    const logger = makeLogger();
    const service = new CryptoTierActivationService(repo, logger, lifecycle, authCache);
    return { repo, emit, invalidateAccount, logger, service };
  }

  it('(a) sole access refunded → entitlement expires, tier reconciles to free, tier_changed emitted', async () => {
    const d = makeRefundDeps();
    d.repo.registerAccount({ accountId: 'acc_1', stripeCustomerId: null, tier: 'free' });
    // Grant an api_builder entitlement (this raises the account tier to api_builder).
    await d.repo.activateCryptoEntitlement({
      accountId: 'acc_1',
      orderId: 'ord_refund',
      tier: 'api_builder',
      paidAt: PAID_AT,
      termDays: CRYPTO_ENTITLEMENT_TERM_DAYS,
    });
    expect(d.repo.readAccount('acc_1')?.tier).toBe('api_builder');

    const res = await d.service.revokeTierForRefundedOrder({
      account_id: 'acc_1',
      order_id: 'ord_refund',
      at: NOW,
    });
    expect(res.revoked).toBe(true);
    // Entitlement was brought forward to NOW (no longer floors the tier).
    const ent = d.repo.listCryptoEntitlements().find((e) => e.orderId === 'ord_refund');
    expect(ent?.expiresAt.getTime()).toBe(NOW.getTime());
    // expired_processed_at left NULL so the sweeper can still pick it up.
    expect(ent?.expiredProcessedAt).toBeNull();
    // Account reconciled to free (no remaining access).
    expect(d.repo.readAccount('acc_1')?.tier).toBe('free');
    expect(d.invalidateAccount).toHaveBeenCalledWith('acc_1');
    expect(d.emit).toHaveBeenCalledTimes(1);
    expect(d.emit).toHaveBeenCalledWith('acc_1', {
      kind: 'subscription.tier_changed',
      fromTier: 'api_builder',
      toTier: 'free',
      effectiveAt: NOW,
      cryptoOrderId: 'ord_refund',
    });
  });

  it('(b1) concurrent still-valid Stripe sub → tier floors to the sub, NOT free', async () => {
    const d = makeRefundDeps();
    d.repo.registerAccount({ accountId: 'acc_2', stripeCustomerId: null, tier: 'api_builder' });
    // A live active Stripe subscription at api_starter floors the account.
    await d.repo.upsertSubscription({
      accountId: 'acc_2',
      stripeSubscriptionId: 'sub_live',
      stripePriceId: 'price_api_starter',
      tier: 'api_starter',
      status: 'active',
      currentPeriodEnd: new Date('2026-08-10T00:00:00.000Z'),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      at: PAID_AT,
    });
    // The refunded crypto order granted a HIGHER api_builder entitlement.
    await d.repo.activateCryptoEntitlement({
      accountId: 'acc_2',
      orderId: 'ord_higher',
      tier: 'api_builder',
      paidAt: PAID_AT,
      termDays: CRYPTO_ENTITLEMENT_TERM_DAYS,
    });
    expect(d.repo.readAccount('acc_2')?.tier).toBe('api_builder');

    const res = await d.service.revokeTierForRefundedOrder({
      account_id: 'acc_2',
      order_id: 'ord_higher',
      at: NOW,
    });
    expect(res.revoked).toBe(true);
    // Floors to the live Stripe sub — NOT stranded to free.
    expect(d.repo.readAccount('acc_2')?.tier).toBe('api_starter');
    expect(d.emit).toHaveBeenCalledTimes(1);
    expect(d.emit).toHaveBeenCalledWith('acc_2', {
      kind: 'subscription.tier_changed',
      fromTier: 'api_builder',
      toTier: 'api_starter',
      effectiveAt: NOW,
      cryptoOrderId: 'ord_higher',
    });
  });

  it('(b2) another still-valid crypto entitlement → tier floors to it, NOT free', async () => {
    const d = makeRefundDeps();
    d.repo.registerAccount({ accountId: 'acc_3', stripeCustomerId: null, tier: 'free' });
    // A separate, valid solo_manual entitlement (a different order) also floors.
    await d.repo.activateCryptoEntitlement({
      accountId: 'acc_3',
      orderId: 'ord_keep',
      tier: 'solo_manual',
      paidAt: PAID_AT,
      termDays: CRYPTO_ENTITLEMENT_TERM_DAYS,
    });
    // The refunded order granted a HIGHER api_builder entitlement.
    await d.repo.activateCryptoEntitlement({
      accountId: 'acc_3',
      orderId: 'ord_higher',
      tier: 'api_builder',
      paidAt: PAID_AT,
      termDays: CRYPTO_ENTITLEMENT_TERM_DAYS,
    });
    expect(d.repo.readAccount('acc_3')?.tier).toBe('api_builder');

    const res = await d.service.revokeTierForRefundedOrder({
      account_id: 'acc_3',
      order_id: 'ord_higher',
      at: NOW,
    });
    expect(res.revoked).toBe(true);
    // Floors to the OTHER still-valid crypto entitlement — not free.
    expect(d.repo.readAccount('acc_3')?.tier).toBe('solo_manual');
    // The kept entitlement is untouched (still valid, still unprocessed).
    const kept = d.repo.listCryptoEntitlements().find((e) => e.orderId === 'ord_keep');
    expect(kept?.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect(kept?.expiredProcessedAt).toBeNull();
    expect(d.emit).toHaveBeenCalledTimes(1);
    expect(d.emit).toHaveBeenCalledWith('acc_3', {
      kind: 'subscription.tier_changed',
      fromTier: 'api_builder',
      toTier: 'solo_manual',
      effectiveAt: NOW,
      cryptoOrderId: 'ord_higher',
    });
  });

  it('(c) replayed refund IPN (entitlement already expired) → no-op, no second emit', async () => {
    const d = makeRefundDeps();
    d.repo.registerAccount({ accountId: 'acc_4', stripeCustomerId: null, tier: 'free' });
    await d.repo.activateCryptoEntitlement({
      accountId: 'acc_4',
      orderId: 'ord_replay',
      tier: 'api_builder',
      paidAt: PAID_AT,
      termDays: CRYPTO_ENTITLEMENT_TERM_DAYS,
    });
    // First refund — real clawback.
    const first = await d.service.revokeTierForRefundedOrder({
      account_id: 'acc_4',
      order_id: 'ord_replay',
      at: NOW,
    });
    expect(first.revoked).toBe(true);
    expect(d.repo.readAccount('acc_4')?.tier).toBe('free');
    expect(d.emit).toHaveBeenCalledTimes(1);

    // Replayed refund IPN — the entitlement is already expired → no-op.
    const second = await d.service.revokeTierForRefundedOrder({
      account_id: 'acc_4',
      order_id: 'ord_replay',
      at: new Date(NOW.getTime() + 60_000),
    });
    expect(second.revoked).toBe(false);
    expect(second.previousTier).toBeNull();
    expect(second.appliedTier).toBeNull();
    // No second downgrade, no second emit, no cache invalidation on the replay.
    expect(d.emit).toHaveBeenCalledTimes(1);
    expect(d.invalidateAccount).toHaveBeenCalledTimes(1);
    const [obj] = d.logger.infos.at(-1) as [Record<string, unknown>];
    expect(obj.event).toBe('crypto_refund_clawback_noop');
  });

  it('(d) a normal activation (non-refund path) leaves entitlements intact — no regression', async () => {
    const d = makeRefundDeps();
    d.repo.registerAccount({ accountId: 'acc_5', stripeCustomerId: null, tier: 'free' });
    await d.service.activateTierForPaidOrder({
      account_id: 'acc_5',
      order_id: 'ord_normal',
      product: 'api_builder',
      payment_id: 'pay_x',
      paid_at: PAID_AT.toISOString(),
    });
    // Upgrade applied — the entitlement is recorded and STILL valid (not revoked).
    expect(d.repo.readAccount('acc_5')?.tier).toBe('api_builder');
    const ent = d.repo.listCryptoEntitlements().find((e) => e.orderId === 'ord_normal');
    expect(ent).toBeDefined();
    expect(ent?.expiresAt.getTime()).toBeGreaterThan(PAID_AT.getTime());
    expect(ent?.expiredProcessedAt).toBeNull();
  });

  it('entitlement revoked but a HIGHER floor remains → tier unchanged, no emit', async () => {
    const d = makeRefundDeps();
    d.repo.registerAccount({ accountId: 'acc_6', stripeCustomerId: null, tier: 'free' });
    // A HIGHER api_scale entitlement floors the account.
    await d.repo.activateCryptoEntitlement({
      accountId: 'acc_6',
      orderId: 'ord_top',
      tier: 'api_scale',
      paidAt: PAID_AT,
      termDays: CRYPTO_ENTITLEMENT_TERM_DAYS,
    });
    // Refund a LOWER solo_manual entitlement — it was never the active floor.
    await d.repo.activateCryptoEntitlement({
      accountId: 'acc_6',
      orderId: 'ord_low',
      tier: 'solo_manual',
      paidAt: PAID_AT,
      termDays: CRYPTO_ENTITLEMENT_TERM_DAYS,
    });
    expect(d.repo.readAccount('acc_6')?.tier).toBe('api_scale');

    const res = await d.service.revokeTierForRefundedOrder({
      account_id: 'acc_6',
      order_id: 'ord_low',
      at: NOW,
    });
    expect(res.revoked).toBe(true);
    // Still floored by api_scale — no tier change, no emit.
    expect(d.repo.readAccount('acc_6')?.tier).toBe('api_scale');
    expect(d.emit).not.toHaveBeenCalled();
    expect(d.invalidateAccount).not.toHaveBeenCalled();
    const [obj] = d.logger.infos.at(-1) as [Record<string, unknown>];
    expect(obj.event).toBe('crypto_refund_entitlement_revoked_tier_unchanged');
  });
});
