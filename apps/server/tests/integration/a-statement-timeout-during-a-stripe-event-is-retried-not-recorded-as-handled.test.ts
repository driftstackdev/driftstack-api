// A statement timeout during a Stripe event is retried, not recorded as handled
// (live-billing audit #10).
//
// The deployment docs recommend DB_STATEMENT_TIMEOUT_MS. Once it is set, a
// statement that waits on a lock past it is cancelled by Postgres with SQLSTATE
// 57014 (query_canceled). That code was not on the transient list, so the
// webhook treated it as a permanent handler error: acked 200, recorded in the
// processed-events ledger as `error:…`, and a manual resend from the Stripe
// dashboard was deduped by the event id. A customer who had paid was never
// upgraded, and nothing alerted on it.
//
// 57014 is now transient: the delivery fails, nothing is recorded, and Stripe's
// redelivery applies the event once the lock is gone. And a Stripe event that
// still ends as a handler `error:` now raises an alert (ops/alerts).
//
// The timeout here is a REAL one: a second connection holds the account row, the
// webhook repo runs on a pool with a 300 ms statement timeout, and Postgres
// cancels the statement.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleStripeWebhooksRepo } from '../../src/db/stripe-webhooks-repo.js';
import type { Logger } from '../../src/lib/logger.js';
import { buildStripePriceMaps } from '../../src/lib/stripe-billing-facts.js';
import { isTransientInfraError } from '../../src/lib/transient-error.js';
import { StripeWebhooksService, type StripeEvent } from '../../src/services/stripe-webhooks.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_live_billing_statement_timeout';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const HERE = dirname(fileURLToPath(import.meta.url));
const ALERTS = resolve(HERE, '..', '..', '..', '..', 'ops', 'alerts', 'driftstack.yml');

let client: postgres.Sql | null = null;
let timed: Database | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME);
  if (opened === null) return;
  client = opened.sql;
  timed = createDb(opened.url, { max: 1, statementTimeoutMs: 300 });
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await timed?.close().catch(() => {});
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

const MAPS = buildStripePriceMaps({
  api_starter: { monthly: 'price_starter_m', annual: 'price_starter_y' },
});

const silent = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

async function tierOf(accountId: string): Promise<string | null> {
  const [row] = await db()<Array<{ tier: string }>>`
    SELECT tier::text FROM accounts WHERE id = ${accountId}::uuid`;
  return row?.tier ?? null;
}

async function ledgerHas(eventId: string): Promise<boolean> {
  const [row] = await db()<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM processed_stripe_events WHERE event_id = ${eventId}`;
  return (row?.n ?? 0) > 0;
}

describe('SQLSTATE 57014 (statement timeout) is transient', () => {
  it('a 57014 is retryable, bare or wrapped the way drizzle wraps a driver error', () => {
    const pg = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
    expect(isTransientInfraError(pg)).toBe(true);
    expect(isTransientInfraError(new Error('Failed query', { cause: pg }))).toBe(true);
  });

  it('CONTROL a permanent error is still not retryable (a unique violation, a check violation)', () => {
    expect(isTransientInfraError(Object.assign(new Error('dup'), { code: '23505' }))).toBe(false);
    expect(isTransientInfraError(Object.assign(new Error('check'), { code: '23514' }))).toBe(false);
  });
});

describe('a Stripe event that ends as a handler error raises an alert', () => {
  it('ops/alerts has a rule on the Stripe webhook `error` outcome that fires on any occurrence', () => {
    const yaml = readFileSync(ALERTS, 'utf8');
    const rules = yaml.split(/\n\s*- alert: /).slice(1);
    const rule = rules.find((r) => /driftstack_stripe_webhook_total\{outcome="error"\}/.test(r));
    expect(rule, 'no alert selects the Stripe webhook error outcome').toBeDefined();
    expect(rule).toMatch(/> 0/);
    expect(rule).toMatch(/severity: (critical|warning)/);
    expect(rule).toMatch(/summary: /);
    expect(rule).toMatch(/description: /);
  });
});

describe.skipIf(!RUN_DB_TESTS)(
  'a statement timeout during a stripe event is retried, not recorded as handled',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise the arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    it('CRITICAL a subscription event whose write times out on a held lock fails the delivery and records nothing; the redelivery after the lock is gone upgrades the customer', async () => {
      if (timed === null) throw new Error('isolated database unreachable');
      const accountId = randomUUID();
      const customerId = `cus_${accountId.replace(/-/g, '').slice(0, 20)}`;
      await db()`INSERT INTO accounts (id, email, tier, stripe_customer_id)
                 VALUES (${accountId}::uuid, ${`timeout-${accountId}@example.test`},
                         'free'::account_tier, ${customerId})`;
      const nowSec = Math.floor(Date.now() / 1000);
      const event: StripeEvent = {
        id: `evt_timeout_${randomUUID()}`,
        type: 'customer.subscription.created',
        created: nowSec,
        livemode: false,
        data: {
          object: {
            id: `sub_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
            object: 'subscription',
            customer: customerId,
            status: 'active',
            cancel_at_period_end: false,
            canceled_at: null,
            current_period_start: nowSec,
            current_period_end: nowSec + 30 * 24 * 60 * 60,
            items: { data: [{ id: 'si_1', price: { id: 'price_starter_m' } }] },
          },
        },
      };
      const raw = JSON.stringify(event);
      const webhooks = new StripeWebhooksService(new DrizzleStripeWebhooksRepo(timed), {
        logger: silent,
        priceToTier: MAPS.priceToTier,
        priceToInterval: MAPS.priceToInterval,
      });

      // Another transaction holds the account row for as long as the first delivery runs.
      let release!: () => void;
      const released = new Promise<void>((r) => {
        release = r;
      });
      let locked!: () => void;
      const lockTaken = new Promise<void>((r) => {
        locked = r;
      });
      const holder = db().begin(async (tx) => {
        await tx`SELECT id FROM accounts WHERE id = ${accountId}::uuid FOR UPDATE`;
        locked();
        await released;
      });
      await lockTaken;

      let first: unknown;
      try {
        first = await webhooks.handle(event, raw);
      } catch (err) {
        first = err;
      } finally {
        release();
        await holder;
      }

      expect(
        first,
        'the timed-out event was acked as handled — Stripe will never deliver it again',
      ).toBeInstanceOf(Error);
      expect(isTransientInfraError(first)).toBe(true);
      expect(await ledgerHas(event.id), 'the event was recorded in the ledger').toBe(false);
      expect(await tierOf(accountId)).toBe('free');

      expect(await webhooks.handle(event, raw)).toBe('handled');
      expect(await tierOf(accountId)).toBe('api_starter');
      expect(await ledgerHas(event.id)).toBe(true);
    });
  },
);
