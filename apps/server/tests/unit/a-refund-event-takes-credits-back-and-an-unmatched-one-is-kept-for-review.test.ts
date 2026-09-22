// The Stripe events a reversed payment arrives as, driven through the real
// StripeWebhooksService with the in-memory repo, a recording logger, a
// recording alert client and a FAKE clawbacks service that records what it
// was asked. What the handlers must do:
//
//   · `charge.refunded` hands the charge, the invoice the event names, and the
//     CUMULATIVE `amount_refunded` to the refund path — never a delta computed
//     here, which is the service's business against what it has recorded;
//   · `charge.dispute.created` hands the dispute, its charge and its amount to
//     the dispute path; `charge.dispute.closed` reinstates ONLY when the
//     dispute is won (`funds_reinstated` always is), and a lost dispute leaves
//     the clawback standing;
//   · a reversal that matches nothing and names no invoice asks Stripe for the
//     charge ONCE and tries again with the invoice it names; a charge with no
//     invoice stays unmatched, and nothing is guessed;
//   · with AI credits off (no clawbacks wired) every reversal is logged and
//     acknowledged, and nothing else happens;
//   · a non-transient failure is logged with the charge and alerted WITHOUT it,
//     and the delivery is still acknowledged; a transient one is rethrown so
//     Stripe retries the whole event.

import { describe, expect, it } from 'vitest';

import type { Logger } from '../../src/lib/logger.js';
import type { SentryMessage } from '../../src/lib/sentry.js';
import { buildStripePriceMaps } from '../../src/lib/stripe-billing-facts.js';
import type {
  CreditClawbacks,
  ReinstateOutcome,
  ReversalOutcome,
} from '../../src/services/credit-clawbacks.js';
import { StripeWebhooksService, type StripeEvent } from '../../src/services/stripe-webhooks.js';
import { InMemoryStripeWebhooksRepo } from '../integration/_helpers/in-memory-stripe-webhooks-repo.js';

const MAPS = buildStripePriceMaps({
  api_builder: { monthly: 'price_builder_m', annual: 'price_builder_y' },
});

interface LogLine {
  level: 'info' | 'warn' | 'error';
  fields: Record<string, unknown>;
  message: string;
}

function recordingLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const at =
    (level: LogLine['level']) =>
    (fields: Record<string, unknown>, message: string): void => {
      lines.push({ level, fields, message });
    };
  const logger = { info: at('info'), warn: at('warn'), error: at('error'), debug: () => {} };
  return { logger: logger as unknown as Logger, lines };
}

type Call =
  | { kind: 'refund'; chargeId: string; stripeInvoiceId: string | null; cumulative: number }
  | {
      kind: 'dispute';
      disputeId: string;
      chargeId: string;
      stripeInvoiceId: string | null;
      amount: number;
    }
  | { kind: 'reinstate'; disputeId: string }
  | { kind: 'crypto'; orderId: string };

function fakeClawbacks(script: {
  refund?: (invoiceId: string | null) => ReversalOutcome | Error;
  dispute?: (invoiceId: string | null) => ReversalOutcome | Error;
  reinstate?: () => ReinstateOutcome | Error;
}): { clawbacks: CreditClawbacks; calls: Call[] } {
  const calls: Call[] = [];
  const answer = <T>(value: T | Error): Promise<T> =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  const clawbacks: CreditClawbacks = {
    applyStripeRefund: (args) => {
      calls.push({
        kind: 'refund',
        chargeId: args.chargeId,
        stripeInvoiceId: args.stripeInvoiceId,
        cumulative: args.cumulativeRefundedMinor,
      });
      return answer(
        script.refund?.(args.stripeInvoiceId) ?? {
          kind: 'applied',
          accountId: 'acc',
          fractionPpm: 1_000_000,
          clawbacks: [],
        },
      );
    },
    applyStripeDispute: (args) => {
      calls.push({
        kind: 'dispute',
        disputeId: args.disputeId,
        chargeId: args.chargeId,
        stripeInvoiceId: args.stripeInvoiceId,
        amount: args.amountMinor,
      });
      return answer(
        script.dispute?.(args.stripeInvoiceId) ?? {
          kind: 'applied',
          accountId: 'acc',
          fractionPpm: 1_000_000,
          clawbacks: [],
        },
      );
    },
    reinstateDispute: (args) => {
      calls.push({ kind: 'reinstate', disputeId: args.disputeId });
      return answer(
        script.reinstate?.() ?? {
          kind: 'reinstated',
          accountId: 'acc',
          reversed: 1,
          regrantedMicro: 0,
          forgivenMicro: 0,
        },
      );
    },
    applyCryptoRefund: (args) => {
      calls.push({ kind: 'crypto', orderId: args.orderId });
      return Promise.resolve({
        kind: 'applied',
        accountId: 'acc',
        fractionPpm: 1_000_000,
        clawbacks: [],
      });
    },
  };
  return { clawbacks, calls };
}

function harness(options: {
  clawbacks?: CreditClawbacks | null;
  charge?: (chargeId: string) => Promise<Record<string, unknown>>;
}): {
  service: StripeWebhooksService;
  lines: LogLine[];
  alerts: SentryMessage[];
  fetched: string[];
} {
  const repo = new InMemoryStripeWebhooksRepo();
  const { logger, lines } = recordingLogger();
  const alerts: SentryMessage[] = [];
  const fetched: string[] = [];
  const charge = options.charge;
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
    creditClawbacks: options.clawbacks === undefined ? null : options.clawbacks,
  });
  return { service, lines, alerts, fetched };
}

let seq = 0;
function event(type: string, object: Record<string, unknown>): StripeEvent {
  seq += 1;
  return {
    id: `evt_${type.replace(/\./g, '_')}_${String(seq)}`,
    type,
    api_version: '2024-12-18.acacia',
    created: 1_790_000_000,
    livemode: false,
    data: { object },
  };
}

const refunded = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'ch_1',
  object: 'charge',
  amount: 4900,
  amount_refunded: 2450,
  refunded: false,
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

describe('a refund event takes credits back', () => {
  it('CRITICAL charge.refunded hands the charge, the invoice and the CUMULATIVE amount refunded to the refund path, and is acknowledged', async () => {
    const { clawbacks, calls } = fakeClawbacks({});
    const h = harness({ clawbacks });
    const outcome = await h.service.handle(event('charge.refunded', refunded()), '{}');
    expect(outcome).toBe('handled');
    expect(calls).toEqual([
      { kind: 'refund', chargeId: 'ch_1', stripeInvoiceId: 'in_1', cumulative: 2450 },
    ]);
    expect(h.fetched).toEqual([]);
  });

  it('CRITICAL charge.dispute.created hands the dispute, its charge and its amount to the dispute path', async () => {
    const { clawbacks, calls } = fakeClawbacks({});
    const h = harness({ clawbacks });
    expect(await h.service.handle(event('charge.dispute.created', dispute()), '{}')).toBe(
      'handled',
    );
    expect(calls).toEqual([
      { kind: 'dispute', disputeId: 'dp_1', chargeId: 'ch_1', stripeInvoiceId: null, amount: 4900 },
    ]);
  });

  it('CRITICAL a dispute CLOSED as won reinstates; closed as lost leaves the clawback standing; funds_reinstated always reinstates', async () => {
    const { clawbacks, calls } = fakeClawbacks({});
    const h = harness({ clawbacks });
    await h.service.handle(event('charge.dispute.closed', dispute({ status: 'lost' })), '{}');
    expect(calls).toEqual([]);
    await h.service.handle(event('charge.dispute.closed', dispute({ status: 'won' })), '{}');
    expect(calls).toEqual([{ kind: 'reinstate', disputeId: 'dp_1' }]);
    await h.service.handle(
      event('charge.dispute.funds_reinstated', dispute({ status: 'warning_closed' })),
      '{}',
    );
    expect(calls).toHaveLength(2);
  });

  it('CRITICAL a reversal that matches nothing and names no invoice asks Stripe for the charge ONCE and tries again with the invoice it names', async () => {
    const { clawbacks, calls } = fakeClawbacks({
      dispute: (invoiceId) =>
        invoiceId === null
          ? { kind: 'unmatched' }
          : { kind: 'applied', accountId: 'acc', fractionPpm: 1_000_000, clawbacks: [] },
    });
    const h = harness({
      clawbacks,
      charge: (id) => Promise.resolve({ id, object: 'charge', invoice: 'in_9' }),
    });
    await h.service.handle(event('charge.dispute.created', dispute()), '{}');
    expect(h.fetched).toEqual(['ch_1']);
    expect(calls.map((c) => (c.kind === 'dispute' ? c.stripeInvoiceId : c.kind))).toEqual([
      null,
      'in_9',
    ]);
  });

  it('a charge Stripe says has no invoice stays unmatched — nothing is guessed, nothing is asked twice', async () => {
    const { clawbacks, calls } = fakeClawbacks({ refund: () => ({ kind: 'unmatched' }) });
    const h = harness({
      clawbacks,
      charge: (id) => Promise.resolve({ id, object: 'charge', invoice: null }),
    });
    await h.service.handle(event('charge.refunded', refunded({ invoice: null })), '{}');
    expect(h.fetched).toEqual(['ch_1']);
    expect(calls).toHaveLength(1);
    expect(h.lines.some((l) => String(l.fields.kind).includes('credits unmatched'))).toBe(true);
  });

  it('CRITICAL with AI credits off, a reversal is logged and acknowledged and nothing else happens', async () => {
    const h = harness({ clawbacks: null });
    expect(await h.service.handle(event('charge.refunded', refunded()), '{}')).toBe('handled');
    expect(h.lines.some((l) => String(l.fields.kind).includes('AI credits off'))).toBe(true);
    expect(h.alerts).toEqual([]);
  });

  it('CRITICAL a non-transient failure is logged WITH the charge, alerted WITHOUT it, and the delivery is acknowledged', async () => {
    const { clawbacks } = fakeClawbacks({ refund: () => new Error('the ledger refused the row') });
    const h = harness({ clawbacks });
    expect(await h.service.handle(event('charge.refunded', refunded()), '{}')).toBe('handled');
    const failure = h.lines.find((l) => l.level === 'error');
    expect(failure?.fields.chargeId).toBe('ch_1');
    expect(h.alerts).toHaveLength(1);
    expect(JSON.stringify(h.alerts[0])).not.toContain('ch_1');
    expect(JSON.stringify(h.alerts[0])).not.toContain('in_1');
  });

  it('CRITICAL a transient failure is rethrown so Stripe retries the whole event, and no processed row is written', async () => {
    const transient = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    const { clawbacks } = fakeClawbacks({ refund: () => transient });
    const h = harness({ clawbacks });
    // `handle` lets a transient failure escape BEFORE it records the event as
    // processed — that is what makes Stripe's retry a first delivery again.
    await expect(h.service.handle(event('charge.refunded', refunded()), '{}')).rejects.toThrow(
      'connection reset',
    );
    expect(h.alerts).toEqual([]);
  });

  it('an event missing what it needs is logged and acknowledged, and the clawback path is never asked', async () => {
    const { clawbacks, calls } = fakeClawbacks({});
    const h = harness({ clawbacks });
    const broken = refunded();
    delete broken.amount_refunded;
    expect(await h.service.handle(event('charge.refunded', broken), '{}')).toBe('handled');
    expect(calls).toEqual([]);
    expect(h.lines.some((l) => l.level === 'warn')).toBe(true);
  });
});
