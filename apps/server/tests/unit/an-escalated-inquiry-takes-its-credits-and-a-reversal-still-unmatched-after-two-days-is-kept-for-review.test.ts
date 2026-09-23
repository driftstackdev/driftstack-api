// Two Stripe-side findings of the re-audit of the S17 rework, driven through
// the real StripeWebhooksService with the in-memory repo, a recording logger, a
// recording alert client and a FAKE clawbacks service that records what it
// was asked. Each arm failed on the code the re-audit read.
//
//   · re-audit #9 — an INQUIRY takes nothing when it opens (`warning_*`), and
//     when it escalates to a chargeback Stripe withdraws the funds on the SAME
//     dispute: `charge.dispute.funds_withdrawn`, and a `charge.dispute.updated`
//     whose status is a chargeback's. Both were `ignored`, so a lost escalated
//     inquiry kept its credits. Both are now applied exactly as
//     `charge.dispute.created` is (the service applies a dispute once per id,
//     which the integration arms prove); any other update changes nothing.
//     What the pinned API version (2024-12-18.acacia) documents was read from
//     docs.stripe.com: `funds_withdrawn` "occurs when funds are removed from
//     your account due to a dispute"; `updated` "occurs when the dispute is
//     updated (usually with evidence)"; escalating an inquiry "transitions the
//     inquiry to a full dispute and debits your account"; an inquiry's statuses
//     are `warning_needs_response`, `warning_under_review`, `warning_closed`.
//
//   · re-audit #14 — a reversal naming an invoice that is not on record is
//     refused for a retry while the event is younger than 48 hours (Stripe's
//     `created`); from 48 hours it is recorded as handled and kept for review —
//     logged with the charge, alerted without it — so nothing is dropped
//     silently when Stripe stops retrying (about three days).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { Logger } from '../../src/lib/logger.js';
import type { SentryMessage } from '../../src/lib/sentry.js';
import { buildStripePriceMaps } from '../../src/lib/stripe-billing-facts.js';
import {
  CreditReversalAwaitsPaymentError,
  REVERSAL_AWAITS_PAYMENT_FOR_MS,
  type CreditClawbacks,
  type ReversalOutcome,
} from '../../src/services/credit-clawbacks.js';
import { StripeWebhooksService, type StripeEvent } from '../../src/services/stripe-webhooks.js';
import { InMemoryStripeWebhooksRepo } from '../integration/_helpers/in-memory-stripe-webhooks-repo.js';

const MAPS = buildStripePriceMaps({
  api_builder: { monthly: 'price_builder_m', annual: 'price_builder_y' },
});

const APPLIED: ReversalOutcome = {
  kind: 'applied',
  accountId: 'acc',
  fractionPpm: 1_000_000,
  clawbacks: [],
};

const SENT = 1_790_000_000;

interface Harness {
  service: StripeWebhooksService;
  repo: InMemoryStripeWebhooksRepo;
  asked: string[];
  errors: Record<string, unknown>[];
  alerts: SentryMessage[];
}

function harness(opts: {
  /** How long after the event was sent the webhook handles it. */
  ageMs?: number;
  refund?: () => ReversalOutcome | Error;
  dispute?: () => ReversalOutcome | Error;
}): Harness {
  const asked: string[] = [];
  const answer = (value: ReversalOutcome | Error): Promise<ReversalOutcome> =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  const clawbacks: CreditClawbacks = {
    applyStripeRefund: () => {
      asked.push('refund');
      return answer(opts.refund?.() ?? APPLIED);
    },
    applyStripeDispute: (args) => {
      asked.push(`dispute:${args.disputeId}`);
      return answer(opts.dispute?.() ?? APPLIED);
    },
    reinstateDispute: () => {
      asked.push('reinstate');
      return Promise.resolve({ kind: 'nothing_to_reinstate' });
    },
    applyCryptoRefund: () => Promise.resolve(APPLIED),
  };
  const repo = new InMemoryStripeWebhooksRepo();
  const errors: Record<string, unknown>[] = [];
  const alerts: SentryMessage[] = [];
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
    creditClawbacks: clawbacks,
    now: () => new Date(SENT * 1000 + (opts.ageMs ?? 60_000)),
  });
  return { service, repo, asked, errors, alerts };
}

let seq = 0;
function event(
  type: string,
  object: Record<string, unknown>,
  /** Null: an event that carries no `created` at all. */
  created: number | null = SENT,
): StripeEvent {
  seq += 1;
  return {
    id: `evt_s17r2_${type.replace(/\./g, '_')}_${String(seq)}`,
    type,
    api_version: '2024-12-18.acacia',
    ...(created === null ? {} : { created }),
    livemode: false,
    data: { object },
  };
}

const dispute = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'dp_r2',
  object: 'dispute',
  charge: 'ch_r2',
  amount: 4900,
  status: 'needs_response',
  ...over,
});

const refunded = (): Record<string, unknown> => ({
  id: 'ch_r2',
  object: 'charge',
  amount: 4900,
  amount_refunded: 4900,
  invoice: 'in_r2',
});

const HOUR = 60 * 60 * 1000;

describe('an escalated inquiry takes its credits (re-audit #9)', () => {
  it('CRITICAL an inquiry that escalates takes its credits when the funds are withdrawn: `charge.dispute.funds_withdrawn` is applied as `created` is', async () => {
    const h = harness({});
    await h.service.handle(
      event('charge.dispute.created', dispute({ status: 'warning_needs_response' })),
      '{}',
    );
    expect(h.asked).toEqual([]);
    const outcome = await h.service.handle(
      event('charge.dispute.funds_withdrawn', dispute({ status: 'needs_response' })),
      '{}',
    );
    expect(outcome).toBe('handled');
    expect(h.asked).toEqual(['dispute:dp_r2']);
  });

  it('CRITICAL an update that turns an inquiry into a chargeback is applied as `created` is, whichever chargeback status it carries', async () => {
    for (const status of ['needs_response', 'under_review', 'lost']) {
      const h = harness({});
      const outcome = await h.service.handle(
        event('charge.dispute.updated', dispute({ status })),
        '{}',
      );
      expect(outcome, status).toBe('handled');
      expect(h.asked, status).toEqual(['dispute:dp_r2']);
    }
  });

  it('an update that leaves an inquiry an inquiry, or a decision `closed` carries, takes nothing', async () => {
    for (const status of [
      'warning_needs_response',
      'warning_under_review',
      'warning_closed',
      'won',
      'prevented',
    ]) {
      const h = harness({});
      const outcome = await h.service.handle(
        event('charge.dispute.updated', dispute({ status })),
        '{}',
      );
      expect(outcome, status).toBe('handled');
      expect(h.asked, status).toEqual([]);
    }
  });

  it('a `funds_withdrawn` that somehow carries an inquiry’s status takes nothing either: no funds leave for an inquiry', async () => {
    const h = harness({});
    await h.service.handle(
      event('charge.dispute.funds_withdrawn', dispute({ status: 'warning_needs_response' })),
      '{}',
    );
    expect(h.asked).toEqual([]);
  });

  it('the endpoint documentation lists both events among those the production endpoint must be subscribed to', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const doc = readFileSync(
      resolve(here, '..', '..', '..', '..', 'docs', 'deployment', 'stripe-webhook-testing.md'),
      'utf8',
    );
    const table = doc.slice(doc.indexOf('## Events the production endpoint must be subscribed to'));
    expect(table).toContain('charge.dispute.funds_withdrawn');
    expect(table).toContain('charge.dispute.updated');
  });
});

describe('a reversal still unmatched after two days is kept for review (re-audit #14)', () => {
  it('CRITICAL younger than 48 hours it is refused for a retry: no processed row, no alert', async () => {
    const h = harness({
      ageMs: REVERSAL_AWAITS_PAYMENT_FOR_MS - 1_000,
      refund: () => new CreditReversalAwaitsPaymentError('refund'),
    });
    await expect(
      h.service.handle(event('charge.refunded', refunded()), '{}'),
    ).rejects.toBeInstanceOf(CreditReversalAwaitsPaymentError);
    expect(h.repo.list()).toEqual([]);
    expect(h.alerts).toEqual([]);
  });

  it('CRITICAL from 48 hours it is recorded as handled, logged with the charge and alerted without any id — nothing is dropped when Stripe stops retrying', async () => {
    const h = harness({
      ageMs: REVERSAL_AWAITS_PAYMENT_FOR_MS,
      refund: () => new CreditReversalAwaitsPaymentError('refund'),
    });
    const outcome = await h.service.handle(event('charge.refunded', refunded()), '{}');
    expect(outcome).toBe('handled');
    expect(h.repo.list().map((r) => r.result)).toEqual(['handled']);
    expect(h.errors.some((e) => e.chargeId === 'ch_r2')).toBe(true);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]?.tags).toMatchObject({
      kind: 'ai_credits_reversal_unmatched',
      what: 'refund',
    });
    expect(JSON.stringify(h.alerts[0])).not.toContain('ch_r2');
    expect(JSON.stringify(h.alerts[0])).not.toContain('in_r2');
  });

  it('the same boundary holds for a dispute', async () => {
    const young = harness({
      ageMs: 47 * HOUR,
      dispute: () => new CreditReversalAwaitsPaymentError('dispute'),
    });
    await expect(
      young.service.handle(event('charge.dispute.created', dispute()), '{}'),
    ).rejects.toBeInstanceOf(CreditReversalAwaitsPaymentError);
    const old = harness({
      ageMs: 49 * HOUR,
      dispute: () => new CreditReversalAwaitsPaymentError('dispute'),
    });
    await expect(
      old.service.handle(event('charge.dispute.created', dispute()), '{}'),
    ).resolves.toBe('handled');
    expect(old.alerts.map((a) => a.tags)).toEqual([
      { kind: 'ai_credits_reversal_unmatched', what: 'dispute' },
    ]);
  });

  it('an event with no `created` cannot be aged, so it is kept for review rather than retried until Stripe gives up', async () => {
    const h = harness({ refund: () => new CreditReversalAwaitsPaymentError('refund') });
    await expect(h.service.handle(event('charge.refunded', refunded(), null), '{}')).resolves.toBe(
      'handled',
    );
    expect(h.alerts).toHaveLength(1);
  });
});
