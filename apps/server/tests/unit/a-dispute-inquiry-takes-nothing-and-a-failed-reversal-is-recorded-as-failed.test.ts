// The Stripe side of the S17 audit's fixes, driven through the real
// StripeWebhooksService with the in-memory repo, a recording logger, a
// recording alert client and a FAKE clawbacks service that records what it
// was asked. Each arm failed on the code the audit read:
//
//   · an INQUIRY (`warning_*`) takes nothing when it opens, and nothing when it
//     closes: no funds left, so no credits go (audit #9);
//   · a won dispute hands the reinstatement its CHARGE and AMOUNT, so the
//     invoice is put back even when the dispute took nothing (audit #2) — and
//     when neither finds the payment, Stripe is asked once which invoice the
//     charge paid;
//   · a reversal whose invoice has no payment on record yet (it arrived before
//     `invoice.paid`) fails the delivery so Stripe redelivers it — no processed
//     row, no alert (audit #8);
//   · a failed reversal AND a failed reinstatement are recorded in the
//     processed-events ledger as `error:…`, not as handled, and both raise the
//     id-free alert (audit #15).

import { describe, expect, it } from 'vitest';

import type { Logger } from '../../src/lib/logger.js';
import type { SentryMessage } from '../../src/lib/sentry.js';
import { buildStripePriceMaps } from '../../src/lib/stripe-billing-facts.js';
import {
  CreditReversalAwaitsPaymentError,
  type CreditClawbacks,
  type ReinstateOutcome,
  type ReversalOutcome,
} from '../../src/services/credit-clawbacks.js';
import { StripeWebhooksService, type StripeEvent } from '../../src/services/stripe-webhooks.js';
import { InMemoryStripeWebhooksRepo } from '../integration/_helpers/in-memory-stripe-webhooks-repo.js';

const MAPS = buildStripePriceMaps({
  api_builder: { monthly: 'price_builder_m', annual: 'price_builder_y' },
});

type Call =
  | { kind: 'refund'; stripeInvoiceId: string | null }
  | { kind: 'dispute'; stripeInvoiceId: string | null }
  | {
      kind: 'reinstate';
      disputeId: string;
      chargeId: string | null;
      stripeInvoiceId: string | null;
      amountMinor: number | null;
    };

const APPLIED: ReversalOutcome = {
  kind: 'applied',
  accountId: 'acc',
  fractionPpm: 1_000_000,
  clawbacks: [],
};
const REINSTATED: ReinstateOutcome = {
  kind: 'reinstated',
  accountId: 'acc',
  reversed: 1,
  regrantedMicro: 0,
  forgivenMicro: 0,
};

function fakeClawbacks(script: {
  refund?: (invoiceId: string | null) => ReversalOutcome | Error;
  dispute?: (invoiceId: string | null) => ReversalOutcome | Error;
  reinstate?: (invoiceId: string | null) => ReinstateOutcome | Error;
}): { clawbacks: CreditClawbacks; calls: Call[] } {
  const calls: Call[] = [];
  const answer = <T>(value: T | Error): Promise<T> =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  const clawbacks: CreditClawbacks = {
    applyStripeRefund: (args) => {
      calls.push({ kind: 'refund', stripeInvoiceId: args.stripeInvoiceId });
      return answer(script.refund?.(args.stripeInvoiceId) ?? APPLIED);
    },
    applyStripeDispute: (args) => {
      calls.push({ kind: 'dispute', stripeInvoiceId: args.stripeInvoiceId });
      return answer(script.dispute?.(args.stripeInvoiceId) ?? APPLIED);
    },
    reinstateDispute: (args) => {
      calls.push({
        kind: 'reinstate',
        disputeId: args.disputeId,
        chargeId: args.chargeId,
        stripeInvoiceId: args.stripeInvoiceId,
        amountMinor: args.amountMinor,
      });
      return answer(script.reinstate?.(args.stripeInvoiceId) ?? REINSTATED);
    },
    applyCryptoRefund: () => Promise.resolve(APPLIED),
  };
  return { clawbacks, calls };
}

function harness(
  clawbacks: CreditClawbacks,
  charge?: (chargeId: string) => Promise<Record<string, unknown>>,
): {
  service: StripeWebhooksService;
  repo: InMemoryStripeWebhooksRepo;
  errors: Record<string, unknown>[];
  alerts: SentryMessage[];
  fetched: string[];
} {
  const repo = new InMemoryStripeWebhooksRepo();
  const errors: Record<string, unknown>[] = [];
  const alerts: SentryMessage[] = [];
  const fetched: string[] = [];
  const logger = {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: (fields: Record<string, unknown>) => {
      errors.push(fields);
    },
  } as unknown as Logger;
  const service = new StripeWebhooksService(repo, {
    logger,
    priceToTier: MAPS.priceToTier,
    priceToInterval: MAPS.priceToInterval,
    sentry: {
      captureMessage: (msg) => {
        alerts.push(msg);
      },
    },
    ...(charge !== undefined
      ? {
          invoiceFetcher: {
            getInvoice: () => Promise.reject(new Error('not asked for an invoice here')),
            getCharge: (id: string) => {
              fetched.push(id);
              return charge(id);
            },
          },
        }
      : {}),
    creditClawbacks: clawbacks,
    // An hour after every event below was sent: well inside the two days a
    // reversal awaiting its payment is retried for (re-audit #14).
    now: () => new Date((EVENT_CREATED + 3600) * 1000),
  });
  return { service, repo, errors, alerts, fetched };
}

const EVENT_CREATED = 1_790_000_000;

let seq = 0;
function event(type: string, object: Record<string, unknown>): StripeEvent {
  seq += 1;
  return {
    id: `evt_s17fix_${type.replace(/\./g, '_')}_${String(seq)}`,
    type,
    api_version: '2024-12-18.acacia',
    created: EVENT_CREATED,
    livemode: false,
    data: { object },
  };
}

const refunded = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'ch_1',
  object: 'charge',
  amount: 4900,
  amount_refunded: 4900,
  invoice: 'in_1',
  ...over,
});

const dispute = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'dp_1',
  object: 'dispute',
  charge: 'ch_1',
  amount: 4900,
  status: 'needs_response',
  ...over,
});

describe('a dispute inquiry takes nothing and a failed reversal is recorded as failed', () => {
  it('CRITICAL an inquiry opening (`warning_needs_response`) takes no credits: the dispute path is never asked (audit #9)', async () => {
    const { clawbacks, calls } = fakeClawbacks({});
    const h = harness(clawbacks);
    const outcome = await h.service.handle(
      event('charge.dispute.created', dispute({ status: 'warning_needs_response' })),
      '{}',
    );
    expect(outcome).toBe('handled');
    expect(calls).toEqual([]);
  });

  it('an inquiry closing (`warning_closed`) puts nothing back, because it took nothing (a guard: it held before the fix)', async () => {
    const { clawbacks, calls } = fakeClawbacks({});
    const h = harness(clawbacks);
    await h.service.handle(
      event('charge.dispute.closed', dispute({ status: 'warning_closed' })),
      '{}',
    );
    expect(calls).toEqual([]);
  });

  it('CRITICAL a won dispute hands the reinstatement its charge and its amount, so the invoice is put back even when the dispute took nothing (audit #2)', async () => {
    const { clawbacks, calls } = fakeClawbacks({});
    const h = harness(clawbacks);
    await h.service.handle(
      event('charge.dispute.closed', dispute({ status: 'won', amount: 2450 })),
      '{}',
    );
    expect(calls).toEqual([
      {
        kind: 'reinstate',
        disputeId: 'dp_1',
        chargeId: 'ch_1',
        stripeInvoiceId: null,
        amountMinor: 2450,
      },
    ]);
  });

  it('CRITICAL a won dispute whose charge names no recorded payment asks Stripe once which invoice it paid, and tries again with it', async () => {
    const { clawbacks, calls } = fakeClawbacks({
      reinstate: (invoiceId) =>
        invoiceId === null ? { kind: 'nothing_to_reinstate' } : REINSTATED,
    });
    const h = harness(clawbacks, (id) =>
      Promise.resolve({ id, object: 'charge', invoice: 'in_9' }),
    );
    await h.service.handle(
      event('charge.dispute.funds_reinstated', dispute({ status: 'won' })),
      '{}',
    );
    expect(h.fetched).toEqual(['ch_1']);
    expect(calls.map((c) => (c.kind === 'reinstate' ? c.stripeInvoiceId : c.kind))).toEqual([
      null,
      'in_9',
    ]);
  });

  it('CRITICAL a refund that arrived before invoice.paid recorded its payment fails the delivery so Stripe redelivers it: no processed row, no alert (audit #8)', async () => {
    const { clawbacks } = fakeClawbacks({
      refund: () => new CreditReversalAwaitsPaymentError('refund'),
    });
    const h = harness(clawbacks);
    await expect(
      h.service.handle(event('charge.refunded', refunded()), '{}'),
    ).rejects.toBeInstanceOf(CreditReversalAwaitsPaymentError);
    expect(h.repo.list()).toEqual([]);
    expect(h.alerts).toEqual([]);
  });

  it('CRITICAL the same holds for a dispute whose invoice Stripe names only when asked', async () => {
    const { clawbacks } = fakeClawbacks({
      dispute: (invoiceId) =>
        invoiceId === null
          ? { kind: 'unmatched' }
          : new CreditReversalAwaitsPaymentError('dispute'),
    });
    const h = harness(clawbacks, (id) =>
      Promise.resolve({ id, object: 'charge', invoice: 'in_7' }),
    );
    await expect(
      h.service.handle(event('charge.dispute.created', dispute()), '{}'),
    ).rejects.toBeInstanceOf(CreditReversalAwaitsPaymentError);
    expect(h.repo.list()).toEqual([]);
  });

  it('CRITICAL a failed reversal is recorded as `error:ai_credits_reversal_failed`, not as handled, and alerted without the charge or invoice (audit #15)', async () => {
    const { clawbacks } = fakeClawbacks({ refund: () => new Error('the ledger refused the row') });
    const h = harness(clawbacks);
    const outcome = await h.service.handle(event('charge.refunded', refunded()), '{}');
    expect(outcome).toBe('error:ai_credits_reversal_failed');
    expect(h.repo.list().map((r) => r.result)).toEqual(['error:ai_credits_reversal_failed']);
    expect(h.errors.some((e) => e.chargeId === 'ch_1')).toBe(true);
    expect(h.alerts).toHaveLength(1);
    expect(JSON.stringify(h.alerts[0])).not.toContain('ch_1');
    expect(JSON.stringify(h.alerts[0])).not.toContain('in_1');
  });

  it('CRITICAL a failed reinstatement is recorded as `error:ai_credits_reinstate_failed` and ALERTED — it used to be logged only, and recorded as handled (audit #15)', async () => {
    const { clawbacks } = fakeClawbacks({
      reinstate: () => new Error('the ledger refused the row'),
    });
    const h = harness(clawbacks);
    const outcome = await h.service.handle(
      event('charge.dispute.closed', dispute({ status: 'won' })),
      '{}',
    );
    expect(outcome).toBe('error:ai_credits_reinstate_failed');
    expect(h.repo.list().map((r) => r.result)).toEqual(['error:ai_credits_reinstate_failed']);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]?.tags).toMatchObject({ kind: 'ai_credits_reinstate_failed' });
    expect(JSON.stringify(h.alerts[0])).not.toContain('dp_1');
    expect(JSON.stringify(h.alerts[0])).not.toContain('ch_1');
  });

  it('a transient failure of a reinstatement is still rethrown, unrecorded and unalerted, so Stripe retries it', async () => {
    const transient = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    const { clawbacks } = fakeClawbacks({ reinstate: () => transient });
    const h = harness(clawbacks);
    await expect(
      h.service.handle(event('charge.dispute.closed', dispute({ status: 'won' })), '{}'),
    ).rejects.toThrow('connection reset');
    expect(h.repo.list()).toEqual([]);
    expect(h.alerts).toEqual([]);
  });
});
