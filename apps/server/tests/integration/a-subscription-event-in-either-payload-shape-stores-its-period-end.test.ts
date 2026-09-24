// A subscription event in either payload shape stores its period end
// (live-billing audit #13).
//
// The shape a Stripe webhook delivers is set on the Stripe endpoint, not in this
// repository. In the newer shape a subscription's `current_period_start` and
// `current_period_end` live on its first item, not on the subscription itself.
// The period START was read from either place; the END only from the top level,
// so a newer-shape payload stored no period end and the billing page showed
// "Renews —". The end is now read exactly as the start is.
//
// Driven through the real StripeWebhooksService against the Drizzle repo on a
// Postgres rebuilt from the migrations, plus the reader itself.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleStripeWebhooksRepo } from '../../src/db/stripe-webhooks-repo.js';
import type { Logger } from '../../src/lib/logger.js';
import * as facts from '../../src/lib/stripe-billing-facts.js';
import { StripeWebhooksService, type StripeEvent } from '../../src/services/stripe-webhooks.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_period_end_shapes';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

let client: postgres.Sql | null = null;
let pool: Database | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME);
  if (opened === null) return;
  client = opened.sql;
  pool = createDb(opened.url, { max: 2 });
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await pool?.close().catch(() => {});
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

const silent = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const MAPS = facts.buildStripePriceMaps({
  api_starter: { monthly: 'price_starter_m', annual: 'price_starter_y' },
});

const START = Date.parse('2026-09-01T10:00:00Z') / 1000;
const END = Date.parse('2026-10-01T10:00:00Z') / 1000;

/** A subscription object in the older shape (period on the subscription) or the newer (on its item). */
function subscription(
  shape: 'older' | 'newer',
  spec: { id: string; customerId: string; status: string },
): Record<string, unknown> {
  const period = { current_period_start: START, current_period_end: END };
  return {
    id: spec.id,
    object: 'subscription',
    customer: spec.customerId,
    status: spec.status,
    cancel_at_period_end: false,
    canceled_at: null,
    ...(shape === 'older' ? period : {}),
    items: {
      data: [
        { id: 'si_1', price: { id: 'price_starter_m' }, ...(shape === 'newer' ? period : {}) },
      ],
    },
  };
}

function event(
  type: 'customer.subscription.created' | 'customer.subscription.deleted',
  object: Record<string, unknown>,
  createdSec: number,
): StripeEvent {
  return {
    id: `evt_period_end_${randomUUID()}`,
    type,
    created: createdSec,
    livemode: false,
    data: { object },
  };
}

async function newCustomer(): Promise<string> {
  const accountId = randomUUID();
  const customerId = `cus_${accountId.replace(/-/g, '').slice(0, 20)}`;
  await db()`INSERT INTO accounts (id, email, tier, stripe_customer_id)
             VALUES (${accountId}::uuid, ${`period-end-${accountId}@example.test`},
                     'free'::account_tier, ${customerId})`;
  return customerId;
}

async function storedPeriod(
  stripeSubscriptionId: string,
): Promise<{ start: string | null; end: string | null } | null> {
  const [row] = await db()<Array<{ start: Date | null; end: Date | null }>>`
    SELECT current_period_start AS start, current_period_end AS "end"
      FROM subscriptions WHERE stripe_subscription_id = ${stripeSubscriptionId}`;
  return row === undefined
    ? null
    : { start: row.start?.toISOString() ?? null, end: row.end?.toISOString() ?? null };
}

describe.skipIf(!RUN_DB_TESTS)(
  'a subscription event in either payload shape stores its period end',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every Postgres arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    function webhooks(): StripeWebhooksService {
      if (pool === null) throw new Error('isolated database unreachable');
      return new StripeWebhooksService(new DrizzleStripeWebhooksRepo(pool), {
        logger: silent,
        priceToTier: MAPS.priceToTier,
        priceToInterval: MAPS.priceToInterval,
      });
    }

    for (const shape of ['older', 'newer'] as const) {
      it(`CRITICAL [${shape} shape] a created event stores the period's start AND its end`, async () => {
        const customerId = await newCustomer();
        const id = `sub_${randomUUID()}`;
        const e = event(
          'customer.subscription.created',
          subscription(shape, { id, customerId, status: 'active' }),
          START,
        );
        expect(await webhooks().handle(e, JSON.stringify(e))).toBe('handled');
        expect(await storedPeriod(id)).toEqual({
          start: '2026-09-01T10:00:00.000Z',
          end: '2026-10-01T10:00:00.000Z',
        });
      });

      it(`CRITICAL [${shape} shape] a deleted event stores the period end the cancellation ran to`, async () => {
        const customerId = await newCustomer();
        const id = `sub_${randomUUID()}`;
        const w = webhooks();
        const created = event(
          'customer.subscription.created',
          subscription(shape, { id, customerId, status: 'active' }),
          START,
        );
        await w.handle(created, JSON.stringify(created));
        const deleted = event(
          'customer.subscription.deleted',
          subscription(shape, { id, customerId, status: 'canceled' }),
          START + 3600,
        );
        expect(await w.handle(deleted, JSON.stringify(deleted))).toBe('handled');
        expect((await storedPeriod(id))?.end).toBe('2026-10-01T10:00:00.000Z');
      });
    }
  },
);

describe('readSubscriptionPeriodEnd reads the end exactly where the start is read', () => {
  const read = (sub: Record<string, unknown>): Date | null =>
    (
      facts as unknown as { readSubscriptionPeriodEnd: (s: Record<string, unknown>) => Date | null }
    ).readSubscriptionPeriodEnd(sub);

  it('CRITICAL it exists beside the start reader', () => {
    expect(typeof (facts as Record<string, unknown>).readSubscriptionPeriodEnd).toBe('function');
  });

  it("CRITICAL the subscription's own end, else its first item's", () => {
    expect(read({ current_period_end: END })?.toISOString()).toBe('2026-10-01T10:00:00.000Z');
    expect(read({ items: { data: [{ current_period_end: END }] } })?.toISOString()).toBe(
      '2026-10-01T10:00:00.000Z',
    );
    expect(
      read({
        current_period_end: END,
        items: { data: [{ current_period_end: START }] },
      })?.toISOString(),
    ).toBe('2026-10-01T10:00:00.000Z');
  });

  it('agrees with the start reader on every shape, including the absent and the malformed', () => {
    const shapes: Array<Record<string, unknown>> = [
      {},
      { items: { data: [] } },
      { items: 'nope' },
      { current_period_start: 0, current_period_end: 0 },
      { current_period_start: 1e18, current_period_end: 1e18 },
      { current_period_start: '1', current_period_end: '1' },
      { items: { data: [{ current_period_start: START, current_period_end: START }] } },
    ];
    for (const s of shapes) {
      expect(read(s)?.getTime() ?? null, JSON.stringify(s)).toBe(
        facts.readSubscriptionPeriodStart(s)?.getTime() ?? null,
      );
    }
  });
});
