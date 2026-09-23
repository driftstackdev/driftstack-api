// A refunded crypto order takes back the AI credits its term granted even when
// the refund arrives again, or after the term is already over — and a failure
// to take them back reaches a person (S17 audit #10).
//
// The refund IPN's tier revoke is idempotent: a replay finds the entitlement
// already expired and changes no tier. It used to return right there, before
// the credits clawback, so a clawback that failed the first time was never
// retried, and an order refunded after its term ended never clawed at all. The
// clawback is itself idempotent on the order id, so it now runs on both paths;
// the refresh still runs only when the revoke really changed something. And a
// failure is alerted by the clawback service (without the order or the
// account), not only logged, because nothing retries it but a replay.

import { describe, expect, it } from 'vitest';
import type { DrizzleCreditLedgerRepo } from '../../src/db/credit-ledger-repo.js';
import type { DrizzleCreditWindowsRepo } from '../../src/db/credit-windows-repo.js';
import type { Logger } from '../../src/lib/logger.js';
import type { SentryMessage } from '../../src/lib/sentry.js';
import {
  CreditClawbacksService,
  type CreditClawbacks,
  type ReversalOutcome,
} from '../../src/services/credit-clawbacks.js';
import type {
  CreditGrantsService,
  CreditsRefreshResult,
} from '../../src/services/credit-grants.js';
import {
  CRYPTO_ENTITLEMENT_TERM_DAYS,
  CryptoTierActivationService,
} from '../../src/services/crypto-tier-activation.js';
import { InMemoryStripeWebhooksRepo } from '../integration/_helpers/in-memory-stripe-webhooks-repo.js';

const ACCOUNT = 'acc_crypto_refund';
const APPLIED: ReversalOutcome = {
  kind: 'applied',
  accountId: ACCOUNT,
  fractionPpm: 1_000_000,
  clawbacks: [],
};
const REFRESHED: CreditsRefreshResult = {
  expired: [],
  window: { outcome: 'none' },
  level: null,
  repaid: [],
  currentWindowEnd: null,
};

function recordingLogger(): { logger: Logger; errors: Record<string, unknown>[] } {
  const errors: Record<string, unknown>[] = [];
  const logger = {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: (fields: Record<string, unknown>) => {
      errors.push(fields);
    },
  } as unknown as Logger;
  return { logger, errors };
}

function activation(answer: () => Promise<ReversalOutcome> = () => Promise.resolve(APPLIED)) {
  const repo = new InMemoryStripeWebhooksRepo();
  repo.registerAccount({ accountId: ACCOUNT, stripeCustomerId: null, tier: 'free' });
  const { logger, errors } = recordingLogger();
  const clawed: string[] = [];
  const refreshed: string[] = [];
  const clawbacks: CreditClawbacks = {
    applyStripeRefund: () => Promise.reject(new Error('not a Stripe refund')),
    applyStripeDispute: () => Promise.reject(new Error('not a Stripe dispute')),
    reinstateDispute: () => Promise.reject(new Error('not a dispute')),
    applyCryptoRefund: (args) => {
      clawed.push(args.orderId);
      return answer();
    },
  };
  const credits = {
    refreshCredits: (accountId: string) => {
      refreshed.push(accountId);
      return Promise.resolve(REFRESHED);
    },
  };
  const service = new CryptoTierActivationService(repo, logger, null, null, credits, clawbacks);
  return { repo, service, clawed, refreshed, errors };
}

describe('a replayed crypto refund still takes its credits back, and a failure is alerted', () => {
  it('CRITICAL a replayed refund — its entitlement already revoked — still asks for the credits back, and refreshes nothing (audit #10)', async () => {
    const d = activation();
    const paidAt = new Date(Date.now() - 2 * 86_400_000);
    await d.repo.activateCryptoEntitlement({
      accountId: ACCOUNT,
      orderId: 'ord_replayed',
      tier: 'api_builder',
      paidAt,
      termDays: CRYPTO_ENTITLEMENT_TERM_DAYS,
    });
    const first = await d.service.revokeTierForRefundedOrder({
      account_id: ACCOUNT,
      order_id: 'ord_replayed',
      at: new Date(),
    });
    expect(first.revoked).toBe(true);
    const replay = await d.service.revokeTierForRefundedOrder({
      account_id: ACCOUNT,
      order_id: 'ord_replayed',
      at: new Date(),
    });
    expect(replay.revoked).toBe(false);
    expect(d.clawed).toEqual(['ord_replayed', 'ord_replayed']);
    expect(d.refreshed, 'a replay that revoked nothing refreshed').toEqual([ACCOUNT]);
  });

  it('CRITICAL an order refunded after its term already ended still takes back the credits its term granted (audit #10)', async () => {
    const d = activation();
    const longAgo = new Date(Date.now() - (CRYPTO_ENTITLEMENT_TERM_DAYS + 5) * 86_400_000);
    await d.repo.activateCryptoEntitlement({
      accountId: ACCOUNT,
      orderId: 'ord_over',
      tier: 'api_builder',
      paidAt: longAgo,
      termDays: CRYPTO_ENTITLEMENT_TERM_DAYS,
    });
    const refunded = await d.service.revokeTierForRefundedOrder({
      account_id: ACCOUNT,
      order_id: 'ord_over',
      at: new Date(),
    });
    expect(refunded.revoked).toBe(false);
    expect(d.clawed).toEqual(['ord_over']);
  });

  it('a clawback that fails is logged with the order and does not fail the refund, which has already happened (a guard: it held before the fix)', async () => {
    const d = activation(() => Promise.reject(new Error('the ledger refused the row')));
    await d.repo.activateCryptoEntitlement({
      accountId: ACCOUNT,
      orderId: 'ord_failing',
      tier: 'api_builder',
      paidAt: new Date(Date.now() - 86_400_000),
      termDays: CRYPTO_ENTITLEMENT_TERM_DAYS,
    });
    await expect(
      d.service.revokeTierForRefundedOrder({
        account_id: ACCOUNT,
        order_id: 'ord_failing',
        at: new Date(),
      }),
    ).resolves.toMatchObject({ revoked: true });
    expect(d.errors.some((e) => e.order_id === 'ord_failing')).toBe(true);
  });

  it('CRITICAL the clawback service ALERTS when a crypto refund’s credits cannot be taken back — without the order or the account — and rethrows for the caller’s log (audit #10)', async () => {
    const alerts: SentryMessage[] = [];
    const failing = {
      transaction: () => Promise.reject(new Error('the database refused the transaction')),
    } as unknown as DrizzleCreditLedgerRepo;
    const service = new CreditClawbacksService({
      ledger: failing,
      windows: {} as unknown as DrizzleCreditWindowsRepo,
      grants: {} as unknown as CreditGrantsService,
      sentry: {
        captureMessage: (msg) => {
          alerts.push(msg);
        },
      },
    });
    await expect(
      service.applyCryptoRefund({ accountId: ACCOUNT, orderId: 'ord_alerted' }),
    ).rejects.toThrow('the database refused the transaction');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.tags).toMatchObject({
      kind: 'ai_credits_reversal_failed',
      what: 'crypto_refund',
    });
    expect(JSON.stringify(alerts[0])).not.toContain('ord_alerted');
    expect(JSON.stringify(alerts[0])).not.toContain(ACCOUNT);
  });
});
