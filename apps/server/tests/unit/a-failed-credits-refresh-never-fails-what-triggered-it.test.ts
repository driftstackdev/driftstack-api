// A failed credits refresh never fails what triggered it.
//
// Three things that change what an account has paid for end by refreshing its
// monthly AI credits: a Stripe billing event, a crypto payment being activated
// or refunded, and an admin changing a plan. In every one, the refresh runs
// AFTER the trigger's own work is committed — the tier is changed, the
// entitlement recorded, the payment stored — so a refresh that fails must not
// undo, fail or re-run any of it.
//
//   · Off: with no refresher wired (AI credits switched off) the call does
//     nothing at all, and the trigger does exactly what it always did.
//   · A TRANSIENT failure is re-thrown only where the sender retries and the
//     retry is safe: the Stripe webhook. A crypto notification's redelivery is a
//     replay that stops early, and an admin's request is not retried by anyone,
//     so for those a re-throw would only turn a finished action into an error.
//   · Every other failure is logged with the account, alerted WITHOUT it, and
//     swallowed; the coverage sweep retries the account within minutes.

import { describe, expect, it, vi } from 'vitest';
import type { AccountTier } from '@driftstack/api-types';
import { AccountsAdminService, type AccountsAdminRepo } from '../../src/services/admin-accounts.js';
import type { AccountContext, AccountRow } from '../../src/services/auth.js';
import {
  refreshCreditsAfter,
  type CreditsRefresher,
  type CreditsRefreshResult,
} from '../../src/services/credit-grants.js';
import { CryptoTierActivationService } from '../../src/services/crypto-tier-activation.js';
import { createTestLogger } from '../../src/lib/logger.js';
import { InMemoryStripeWebhooksRepo } from '../integration/_helpers/in-memory-stripe-webhooks-repo.js';

const ACCOUNT = '3f2b8c1e-5a4d-4e6f-9a7b-0c1d2e3f4a5b';

const DONE: CreditsRefreshResult = {
  expired: [],
  window: { outcome: 'none' },
  level: null,
  repaid: [],
  currentWindowEnd: null,
};

const transient = (): Error => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
const lockTimeout = (): Error =>
  Object.assign(new Error('Failed query: select … for update'), {
    cause: Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
  });

function refresher(
  behave: () => Promise<CreditsRefreshResult>,
): CreditsRefresher & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    refreshCredits: (accountId) => {
      calls.push(accountId);
      return behave();
    },
  };
}

function observers(): {
  logger: { error: (obj: Record<string, unknown>, msg: string) => void };
  sentry: { captureMessage: (e: Record<string, unknown>) => void };
  logged: Array<Record<string, unknown>>;
  alerted: Array<Record<string, unknown>>;
} {
  const logged: Array<Record<string, unknown>> = [];
  const alerted: Array<Record<string, unknown>> = [];
  return {
    logged,
    alerted,
    logger: { error: (obj) => void logged.push(obj) },
    sentry: { captureMessage: (e) => void alerted.push(e) },
  };
}

describe('refreshCreditsAfter', () => {
  it('CRITICAL with no refresher — AI credits switched off — it does nothing: no call, no log, no alert', async () => {
    const o = observers();
    for (const none of [null, undefined]) {
      await refreshCreditsAfter(none, ACCOUNT, {
        trigger: 'stripe_webhook',
        rethrowTransient: true,
        logger: o.logger,
        sentry: o.sentry as never,
      });
    }
    expect(o.logged).toEqual([]);
    expect(o.alerted).toEqual([]);
  });

  it('a refresh that works is one call for that account, and says nothing', async () => {
    const o = observers();
    const r = refresher(() => Promise.resolve(DONE));
    await refreshCreditsAfter(r, ACCOUNT, {
      trigger: 'admin_tier_change',
      rethrowTransient: false,
      logger: o.logger,
      sentry: o.sentry as never,
    });
    expect(r.calls).toEqual([ACCOUNT]);
    expect(o.logged).toEqual([]);
    expect(o.alerted).toEqual([]);
  });

  it('CRITICAL a transient failure is RE-THROWN when the caller’s sender retries (the Stripe webhook), bare or wrapped by the query layer — and is not logged as a failure, because the retry is the handling', async () => {
    for (const make of [transient, lockTimeout]) {
      const o = observers();
      const err = make();
      await expect(
        refreshCreditsAfter(
          refresher(() => Promise.reject(err)),
          ACCOUNT,
          {
            trigger: 'stripe_webhook',
            rethrowTransient: true,
            logger: o.logger,
            sentry: o.sentry as never,
          },
        ),
      ).rejects.toBe(err);
      expect(o.logged).toEqual([]);
      expect(o.alerted).toEqual([]);
    }
  });

  it('CRITICAL the SAME transient failure is swallowed where nobody retries: a finished admin action or crypto activation must not be reported as failed', async () => {
    const o = observers();
    await expect(
      refreshCreditsAfter(
        refresher(() => Promise.reject(transient())),
        ACCOUNT,
        {
          trigger: 'crypto_activation',
          rethrowTransient: false,
          logger: o.logger,
          sentry: o.sentry as never,
        },
      ),
    ).resolves.toBeUndefined();
    expect(o.logged).toHaveLength(1);
  });

  it('CRITICAL any other failure is swallowed even for the Stripe webhook — retrying a bug for three days fixes nothing — and is logged WITH the account and alerted WITHOUT it', async () => {
    const o = observers();
    await expect(
      refreshCreditsAfter(
        refresher(() => Promise.reject(new RangeError('not a safe integer'))),
        ACCOUNT,
        {
          trigger: 'stripe_webhook',
          rethrowTransient: true,
          logger: o.logger,
          sentry: o.sentry as never,
        },
      ),
    ).resolves.toBeUndefined();

    expect(o.logged).toHaveLength(1);
    expect(o.logged[0]).toMatchObject({
      event: 'ai_credits_refresh_failed',
      trigger: 'stripe_webhook',
      accountId: ACCOUNT,
    });
    expect(o.alerted).toHaveLength(1);
    expect(o.alerted[0]).toMatchObject({
      level: 'error',
      fingerprint: ['billing', 'ai_credits_refresh_failed', 'stripe_webhook'],
      tags: { kind: 'ai_credits_refresh_failed', trigger: 'stripe_webhook' },
    });
    expect(JSON.stringify(o.alerted[0]), 'the alert carries an account id').not.toContain(ACCOUNT);
  });

  it('an alert client that throws, or a missing logger, changes nothing: the failure is still swallowed', async () => {
    await expect(
      refreshCreditsAfter(
        refresher(() => Promise.reject(new Error('boom'))),
        ACCOUNT,
        {
          trigger: 'crypto_refund',
          rethrowTransient: false,
          sentry: {
            captureMessage: () => {
              throw new Error('the alert client is down');
            },
          },
        },
      ),
    ).resolves.toBeUndefined();
  });
});

describe('an admin plan change', () => {
  const ADMIN = {
    apiKey: { scopes: ['driftstack_internal_admin'] },
  } as unknown as AccountContext;

  function adminService(credits: CreditsRefresher | null, order: string[]): AccountsAdminService {
    const repo = {
      setTier: (accountId: string, tier: AccountTier) => {
        order.push(`tier set to ${tier}`);
        return Promise.resolve({ id: accountId, tier } as unknown as AccountRow);
      },
    } as unknown as AccountsAdminRepo;
    const authCache = {
      invalidateAccount: () => {
        order.push('cache invalidated');
        return Promise.resolve();
      },
    };
    return new AccountsAdminService(
      repo,
      authCache as never,
      null,
      null,
      null,
      null,
      null,
      null,
      credits,
    );
  }

  it('CRITICAL refreshes the account’s credits LAST, after the tier is written and the cache invalidated', async () => {
    const order: string[] = [];
    const r: CreditsRefresher = {
      refreshCredits: (accountId) => {
        order.push(`credits refreshed for ${accountId}`);
        return Promise.resolve(DONE);
      },
    };
    const updated = await adminService(r, order).changeTier(ADMIN, ACCOUNT, 'api_scale');
    expect(updated).toMatchObject({ id: ACCOUNT, tier: 'api_scale' });
    expect(order).toEqual([
      'tier set to api_scale',
      'cache invalidated',
      `credits refreshed for ${ACCOUNT}`,
    ]);
  });

  it('CRITICAL a refresh that fails — transiently or not — does not fail the plan change, which has already happened', async () => {
    for (const err of [transient(), new Error('a bug')]) {
      const order: string[] = [];
      const service = adminService({ refreshCredits: () => Promise.reject(err) }, order);
      await expect(service.changeTier(ADMIN, ACCOUNT, 'team_manual')).resolves.toMatchObject({
        tier: 'team_manual',
      });
      expect(order).toEqual(['tier set to team_manual', 'cache invalidated']);
    }
  });

  it('with AI credits off (no refresher) the plan change is exactly what it was', async () => {
    const order: string[] = [];
    await adminService(null, order).changeTier(ADMIN, ACCOUNT, 'api_starter');
    expect(order).toEqual(['tier set to api_starter', 'cache invalidated']);
  });
});

describe('a crypto payment', () => {
  function activator(credits: CreditsRefresher | null): {
    service: CryptoTierActivationService;
    repo: InMemoryStripeWebhooksRepo;
  } {
    const repo = new InMemoryStripeWebhooksRepo();
    repo.registerAccount({ accountId: ACCOUNT, stripeCustomerId: 'cus_1', tier: 'free' });
    return {
      repo,
      service: new CryptoTierActivationService(repo, createTestLogger(), null, null, credits),
    };
  }

  const paid = (
    orderId: string,
    product = 'team_manual',
  ): Parameters<CryptoTierActivationService['activateTierForPaidOrder']>[0] => ({
    account_id: ACCOUNT,
    order_id: orderId,
    payment_id: `pay_${orderId}`,
    product,
    paid_at: new Date().toISOString(),
  });

  it('CRITICAL activating a paid order refreshes the account once the entitlement is recorded — and AGAIN on a replay, which is what repairs a first delivery whose refresh failed', async () => {
    const r = refresher(() => Promise.resolve(DONE));
    const { service, repo } = activator(r);
    const entitlementsAtRefresh: number[] = [];
    const real = r.refreshCredits.bind(r);
    r.refreshCredits = (accountId) => {
      entitlementsAtRefresh.push(repo.listCryptoEntitlements().length);
      return real(accountId);
    };

    await service.activateTierForPaidOrder(paid('ord_1'));
    await service.activateTierForPaidOrder(paid('ord_1'));
    expect(r.calls).toEqual([ACCOUNT, ACCOUNT]);
    expect(entitlementsAtRefresh, 'the refresh ran before the entitlement was recorded').toEqual([
      1, 1,
    ]);
  });

  it('an order that records no entitlement refreshes nothing: a product that is not a plan, and an account this server does not have', async () => {
    const r = refresher(() => Promise.resolve(DONE));
    const { service } = activator(r);
    await service.activateTierForPaidOrder(paid('ord_pack', 'trial_pack'));
    await service.activateTierForPaidOrder({ ...paid('ord_ghost'), account_id: 'no-such-account' });
    expect(r.calls).toEqual([]);
  });

  it('CRITICAL a refresh that fails does not fail the activation: the customer paid, the entitlement and the plan stand', async () => {
    const { service, repo } = activator({ refreshCredits: () => Promise.reject(transient()) });
    await expect(service.activateTierForPaidOrder(paid('ord_2'))).resolves.toBeUndefined();
    expect(repo.listCryptoEntitlements()).toHaveLength(1);
  });

  it('a refund refreshes the account when it really revoked an entitlement, and not on a replay that revoked nothing', async () => {
    const r = refresher(() => Promise.resolve(DONE));
    const { service } = activator(r);
    await service.activateTierForPaidOrder(paid('ord_3'));
    r.calls.length = 0;

    const first = await service.revokeTierForRefundedOrder({
      account_id: ACCOUNT,
      order_id: 'ord_3',
      at: new Date(),
    });
    expect(first.revoked).toBe(true);
    expect(r.calls).toEqual([ACCOUNT]);

    const replay = await service.revokeTierForRefundedOrder({
      account_id: ACCOUNT,
      order_id: 'ord_3',
      at: new Date(),
    });
    expect(replay.revoked).toBe(false);
    expect(r.calls, 'a replayed refund refreshed again').toEqual([ACCOUNT]);
  });

  it('spy sanity: vitest’s own spies see the same single call, so the hand-rolled refresher above is not what makes these pass', async () => {
    const refreshCredits = vi.fn(() => Promise.resolve(DONE));
    const { service } = activator({ refreshCredits });
    await service.activateTierForPaidOrder(paid('ord_4'));
    expect(refreshCredits).toHaveBeenCalledTimes(1);
    expect(refreshCredits).toHaveBeenCalledWith(ACCOUNT);
  });
});
