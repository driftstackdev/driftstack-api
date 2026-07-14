// C1 — unit tests for the crypto entitlement expiry sweeper.
//
// Proves: (1) a lapsed entitlement drops the account to its best REMAINING
// entitlement (another valid crypto grant, a live Stripe sub, or free), not
// blindly to free; (2) a still-valid higher grant is untouched (no spurious
// emit); (3) multiple entitlements expiring together for one account collapse
// to a single recompute; (4) work-then-mark is crash-idempotent (a re-run after
// a "crash before mark" produces no second downgrade / emit); (5) the
// bootstrap/re-arm dedup rule matches session-duration-sweeper.

import { describe, expect, it, vi } from 'vitest';
import type { AccountTier } from '@driftstack/api-types';
import {
  CRYPTO_ENTITLEMENT_EXPIRY_SWEEP_INTERVAL_MS,
  CRYPTO_ENTITLEMENT_EXPIRY_SWEEP_JOB_TYPE,
  CryptoEntitlementExpirySweeperService,
  enqueueNextCryptoEntitlementExpirySweep,
  registerCryptoEntitlementExpirySweepJob,
} from '../../src/services/crypto-entitlement-expiry-sweeper.js';
import { InMemoryStripeWebhooksRepo } from '../integration/_helpers/in-memory-stripe-webhooks-repo.js';
import type { Logger } from '../../src/lib/logger.js';
import type { AccountLifecycleService } from '../../src/services/account-lifecycle.js';
import type { AuthCache } from '../../src/services/auth-cache.js';

function makeLogger(): Logger {
  const noop = () => undefined;
  return {
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: function () {
      return this;
    },
  } as unknown as Logger;
}

const TERM_DAYS = 31;
// A paidAt far enough in the past that paidAt + 31d is still < NOW (expired).
const LONG_AGO = new Date('2020-01-01T00:00:00.000Z');
const NOW = new Date('2026-07-08T12:00:00.000Z');

function makeSweeper(repo: InMemoryStripeWebhooksRepo) {
  const emit = vi.fn().mockResolvedValue(undefined);
  const invalidateAccount = vi.fn().mockResolvedValue(undefined);
  const sweeper = new CryptoEntitlementExpirySweeperService({
    repo,
    logger: makeLogger(),
    accountLifecycle: { emit } as unknown as AccountLifecycleService,
    authCache: { invalidateAccount } as unknown as AuthCache,
  });
  return { sweeper, emit, invalidateAccount };
}

describe('C1 CryptoEntitlementExpirySweeperService.tickOnce', () => {
  it('no expired rows → no-op (no downgrade, no emit)', async () => {
    const repo = new InMemoryStripeWebhooksRepo();
    repo.registerAccount({ accountId: 'acc_1', stripeCustomerId: null, tier: 'free' });
    const { sweeper, emit } = makeSweeper(repo);
    const r = await sweeper.tickOnce(NOW);
    expect(r).toEqual({ processed: 0, downgraded: 0 });
    expect(emit).not.toHaveBeenCalled();
  });

  it('lapsed entitlement with nothing remaining → downgrades to free, emits tier_changed, marks processed', async () => {
    const repo = new InMemoryStripeWebhooksRepo();
    repo.registerAccount({ accountId: 'acc_1', stripeCustomerId: null, tier: 'free' });
    // Grant api_builder via an already-expired entitlement (paidAt 2020).
    await repo.activateCryptoEntitlement({
      accountId: 'acc_1',
      orderId: 'ord_1',
      tier: 'api_builder',
      paidAt: LONG_AGO,
      termDays: TERM_DAYS,
    });
    expect(repo.readAccount('acc_1')?.tier).toBe('api_builder'); // upgrade applied

    const { sweeper, emit, invalidateAccount } = makeSweeper(repo);
    const r = await sweeper.tickOnce(NOW);
    expect(r).toEqual({ processed: 1, downgraded: 1 });
    expect(repo.readAccount('acc_1')?.tier).toBe('free');
    expect(invalidateAccount).toHaveBeenCalledWith('acc_1');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('acc_1', {
      kind: 'subscription.tier_changed',
      fromTier: 'api_builder',
      toTier: 'free',
      effectiveAt: NOW,
      cryptoOrderId: 'ord_1',
    });
    // Marked processed → a second tick finds nothing.
    expect(repo.listCryptoEntitlements()[0]?.expiredProcessedAt).toEqual(NOW);
    const second = await sweeper.tickOnce(NOW);
    expect(second).toEqual({ processed: 0, downgraded: 0 });
  });

  it('lapsed lower grant while a higher grant is still valid → account tier unchanged, no emit', async () => {
    const repo = new InMemoryStripeWebhooksRepo();
    repo.registerAccount({ accountId: 'acc_1', stripeCustomerId: null, tier: 'free' });
    // Still-valid higher grant (paidAt recent → expires ~31d out, after NOW).
    await repo.activateCryptoEntitlement({
      accountId: 'acc_1',
      orderId: 'ord_valid',
      tier: 'api_scale',
      paidAt: new Date('2026-07-01T00:00:00.000Z'),
      termDays: TERM_DAYS,
    });
    // Expired lower grant.
    await repo.activateCryptoEntitlement({
      accountId: 'acc_1',
      orderId: 'ord_expired',
      tier: 'solo_manual',
      paidAt: LONG_AGO,
      termDays: TERM_DAYS,
    });
    expect(repo.readAccount('acc_1')?.tier).toBe('api_scale');

    const { sweeper, emit } = makeSweeper(repo);
    const r = await sweeper.tickOnce(NOW);
    expect(r).toEqual({ processed: 1, downgraded: 0 }); // only the expired row processed
    expect(repo.readAccount('acc_1')?.tier).toBe('api_scale'); // floored by the valid grant
    expect(emit).not.toHaveBeenCalled();
  });

  it('lapsed entitlement while a live Stripe sub exists → downgrades to the sub tier, not free', async () => {
    const repo = new InMemoryStripeWebhooksRepo();
    repo.registerAccount({ accountId: 'acc_1', stripeCustomerId: 'cus_1', tier: 'free' });
    await repo.upsertSubscription({
      accountId: 'acc_1',
      stripeSubscriptionId: 'sub_1',
      stripePriceId: 'price_starter',
      tier: 'api_starter',
      status: 'active',
      currentPeriodEnd: new Date('2026-08-01T00:00:00.000Z'),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      at: new Date('2026-07-01T00:00:00.000Z'),
    });
    // Expired crypto grant that had raised the account to api_scale.
    await repo.activateCryptoEntitlement({
      accountId: 'acc_1',
      orderId: 'ord_1',
      tier: 'api_scale',
      paidAt: LONG_AGO,
      termDays: TERM_DAYS,
    });
    expect(repo.readAccount('acc_1')?.tier).toBe('api_scale');

    const { sweeper, emit } = makeSweeper(repo);
    const r = await sweeper.tickOnce(NOW);
    expect(r).toEqual({ processed: 1, downgraded: 1 });
    expect(repo.readAccount('acc_1')?.tier).toBe('api_starter'); // falls to the live sub, not free
    expect(emit).toHaveBeenCalledWith('acc_1', {
      kind: 'subscription.tier_changed',
      fromTier: 'api_scale',
      toTier: 'api_starter',
      effectiveAt: NOW,
      cryptoOrderId: 'ord_1',
    });
  });

  it('several entitlements expiring together for one account → one recompute, all marked', async () => {
    const repo = new InMemoryStripeWebhooksRepo();
    repo.registerAccount({ accountId: 'acc_1', stripeCustomerId: null, tier: 'free' });
    for (const [orderId, tier] of [
      ['ord_a', 'solo_manual'],
      ['ord_b', 'team_manual'],
    ] as Array<[string, AccountTier]>) {
      await repo.activateCryptoEntitlement({
        accountId: 'acc_1',
        orderId,
        tier,
        paidAt: LONG_AGO,
        termDays: TERM_DAYS,
      });
    }
    const { sweeper, emit } = makeSweeper(repo);
    const r = await sweeper.tickOnce(NOW);
    expect(r.processed).toBe(2);
    expect(r.downgraded).toBe(1); // grouped → single account-level downgrade
    expect(emit).toHaveBeenCalledTimes(1);
    expect(repo.listCryptoEntitlements().every((e) => e.expiredProcessedAt !== null)).toBe(true);
  });

  it('work-then-mark: a re-run after a crash-before-mark produces no second downgrade or emit', async () => {
    const repo = new InMemoryStripeWebhooksRepo();
    repo.registerAccount({ accountId: 'acc_1', stripeCustomerId: null, tier: 'free' });
    await repo.activateCryptoEntitlement({
      accountId: 'acc_1',
      orderId: 'ord_1',
      tier: 'api_builder',
      paidAt: LONG_AGO,
      termDays: TERM_DAYS,
    });
    // Simulate a crash after the recompute but before the mark: stub the mark to
    // throw the first time, so the row stays unprocessed.
    const markSpy = vi
      .spyOn(repo, 'markCryptoEntitlementsProcessed')
      .mockRejectedValueOnce(new Error('crash'));
    const { sweeper, emit } = makeSweeper(repo);
    await expect(sweeper.tickOnce(NOW)).rejects.toThrow('crash');
    expect(repo.readAccount('acc_1')?.tier).toBe('free'); // downgrade did happen
    expect(emit).toHaveBeenCalledTimes(1);
    markSpy.mockRestore();

    // Next tick re-lists the still-unprocessed row; the recompute is a pure
    // function of current state → previousTier === appliedTier → no second emit.
    const r = await sweeper.tickOnce(NOW);
    expect(r).toEqual({ processed: 1, downgraded: 0 });
    expect(emit).toHaveBeenCalledTimes(1); // still exactly one
  });

  it('respects the per-tick batch limit', async () => {
    const repo = new InMemoryStripeWebhooksRepo();
    for (let i = 0; i < 5; i++) {
      repo.registerAccount({ accountId: `acc_${i}`, stripeCustomerId: null, tier: 'free' });
      await repo.activateCryptoEntitlement({
        accountId: `acc_${i}`,
        orderId: `ord_${i}`,
        tier: 'solo_manual',
        paidAt: LONG_AGO,
        termDays: TERM_DAYS,
      });
    }
    const sweeper = new CryptoEntitlementExpirySweeperService({
      repo,
      logger: makeLogger(),
      batchLimit: 2,
    });
    const r = await sweeper.tickOnce(NOW);
    expect(r.processed).toBe(2);
  });

  it('one account failing is isolated — other accounts still downgrade+mark, the failed rows stay unprocessed (retry next tick), tick does not throw', async () => {
    const repo = new InMemoryStripeWebhooksRepo();
    repo.registerAccount({ accountId: 'acc_good', stripeCustomerId: null, tier: 'free' });
    repo.registerAccount({ accountId: 'acc_fail', stripeCustomerId: null, tier: 'free' });
    await repo.activateCryptoEntitlement({
      accountId: 'acc_good',
      orderId: 'ord_good',
      tier: 'api_builder',
      paidAt: LONG_AGO,
      termDays: TERM_DAYS,
    });
    await repo.activateCryptoEntitlement({
      accountId: 'acc_fail',
      orderId: 'ord_fail',
      tier: 'api_builder',
      paidAt: LONG_AGO,
      termDays: TERM_DAYS,
    });
    const { sweeper, emit } = makeSweeper(repo);
    // One account's tier-changed emit throws (a transient downstream failure)
    // — this happens INSIDE the per-account guard, so it must isolate to that
    // account without aborting the tick or marking its rows processed.
    emit.mockImplementation((accountId: string) =>
      accountId === 'acc_fail' ? Promise.reject(new Error('emit boom')) : Promise.resolve(),
    );

    // Must NOT throw — the whole tick survives one account's failure.
    const r = await sweeper.tickOnce(NOW);
    // Only the clean account's row is marked processed; both were attempted.
    expect(r.processed).toBe(1);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(repo.readAccount('acc_good')?.tier).toBe('free');
    // Exactly one row marked (acc_good); the failed account's row stays
    // unprocessed and is re-listed next tick (idempotent recompute).
    expect(repo.listCryptoEntitlements().filter((e) => e.expiredProcessedAt !== null)).toHaveLength(
      1,
    );
    expect(repo.listCryptoEntitlements().filter((e) => e.expiredProcessedAt === null)).toHaveLength(
      1,
    );
  });
});

describe('C1 crypto entitlement sweep scheduling (dedup rule)', () => {
  function fakeScheduledJobs() {
    const enqueues: Array<{
      jobType: string;
      dedup: boolean;
      dedupAfterRunAt?: Date;
      runAt: Date;
    }> = [];
    let handler: ((job: unknown) => Promise<void>) | null = null;
    const scheduledJobs = {
      register: (_jobType: string, h: (job: unknown) => Promise<void>) => {
        handler = h;
      },
      enqueue: (args: {
        jobType: string;
        dedupOnAccountAndType: boolean;
        dedupAfterRunAt?: Date;
        runAt: Date;
      }) => {
        enqueues.push({
          jobType: args.jobType,
          dedup: args.dedupOnAccountAndType,
          dedupAfterRunAt: args.dedupAfterRunAt,
          runAt: args.runAt,
        });
        return Promise.resolve({ enqueued: true });
      },
    };
    return { scheduledJobs, enqueues, invoke: () => handler!({ runAt: NOW }) };
  }

  it('bootstrap dedups all pending; re-arm dedups only future successors', async () => {
    const f = fakeScheduledJobs();
    const repo = new InMemoryStripeWebhooksRepo();
    const sweeper = new CryptoEntitlementExpirySweeperService({ repo, logger: makeLogger() });

    // Bootstrap enqueue → dedup TRUE (one chain across restarts).
    await enqueueNextCryptoEntitlementExpirySweep({
      scheduledJobs: f.scheduledJobs as any,
    });
    expect(f.enqueues.at(-1)).toMatchObject({
      jobType: CRYPTO_ENTITLEMENT_EXPIRY_SWEEP_JOB_TYPE,
      dedup: true,
    });

    // Register + fire the handler → tickOnce then re-arm with a run-time boundary.
    registerCryptoEntitlementExpirySweepJob({
      scheduledJobs: f.scheduledJobs as any,
      sweeper,
      nowFn: () => NOW.getTime(),
    });
    await f.invoke();
    const reArm = f.enqueues.at(-1)!;
    expect(reArm.dedup).toBe(true);
    expect(reArm.dedupAfterRunAt).toEqual(NOW);
    expect(reArm.runAt).toEqual(
      new Date(NOW.getTime() + CRYPTO_ENTITLEMENT_EXPIRY_SWEEP_INTERVAL_MS),
    );
  });

  it('the re-arm survives a tickOnce failure (chain never dies) and does not fan out', async () => {
    const f = fakeScheduledJobs();
    // A tick that always throws (e.g. the DB list query fails) must not stop the
    // self-re-arming chain: the handler swallows + re-arms exactly once. If it
    // re-threw, the poller would retry to maxAttempts then markFailed with no
    // pending sweep — the chain would die and no entitlement would ever expire.
    // Captured mock (read off the variable, not the object → no-unbound-method).
    const tickOnce = vi.fn().mockRejectedValue(new Error('db down'));
    const sweeper = { tickOnce } as unknown as CryptoEntitlementExpirySweeperService;

    registerCryptoEntitlementExpirySweepJob({
      scheduledJobs: f.scheduledJobs as any,
      sweeper,
      nowFn: () => NOW.getTime(),
      logger: makeLogger(),
    });

    // The handler must resolve (not reject) despite the failing tick.
    await expect(f.invoke()).resolves.toBeUndefined();
    // Exactly one re-arm enqueued → chain alive, no duplicate parallel chains.
    expect(f.enqueues).toHaveLength(1);
    expect(f.enqueues[0]).toMatchObject({
      jobType: CRYPTO_ENTITLEMENT_EXPIRY_SWEEP_JOB_TYPE,
      dedup: true,
      dedupAfterRunAt: NOW,
    });
    expect(tickOnce).toHaveBeenCalledTimes(1);
  });
});
