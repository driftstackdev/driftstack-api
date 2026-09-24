// A paid crypto order and its `crypto.order.paid` webhook are committed together.
//
// Webhooks audit #5 (2026-09-24, plausible). The IPN handler committed the order
// as `paid` inside `withOrderLock`, then queued the webhook in a SEPARATE step
// and swallowed any failure. A connection reset between the two lost the event
// for good: NowPayments re-sends the IPN, but an already-paid order "does not
// fire the event again" (crypto-events page). The customer never hears of the
// payment, and nothing records it.
//
// Now the paid event's delivery rows are written with the order's own
// transaction: both commit, or neither does — and when neither does, the IPN
// fails, NowPayments retries it, and the retry finds the order still unpaid and
// fires the event once.
//
// Real Postgres in a database of its own, because the property IS the
// transaction. The failure injected in the second arm is a trigger that refuses
// the delivery insert — a real error raised inside the real transaction.

import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiKeyScope } from '@driftstack/api-types';
import * as schema from '../../src/db/schema.js';
import { DrizzleCryptoOrdersRepo } from '../../src/db/crypto-orders-repo.js';
import type { AccountContext } from '../../src/services/auth.js';
import {
  CryptoOrdersService,
  type CryptoOrderWebhookEmitter,
} from '../../src/services/crypto-orders.js';
import { WebhooksService } from '../../src/services/webhooks.js';
import { openWebhookDeliveryDb, type WebhookDeliveryDb } from './_helpers/webhook-delivery-db.js';

const ISOLATED_DB_NAME = 'driftstack_iso_crypto_paid_outbox';

let fx: WebhookDeliveryDb | null = null;

beforeAll(async () => {
  fx = await openWebhookDeliveryDb(ISOLATED_DB_NAME);
});

beforeEach(async () => {
  if (!fx) return;
  await fx.wipe();
  await fx.client`DROP TRIGGER IF EXISTS test_refuse_paid_delivery ON webhook_deliveries`;
});

afterAll(async () => {
  if (fx) {
    await fx.client`DROP TRIGGER IF EXISTS test_refuse_paid_delivery ON webhook_deliveries`;
    await fx.wipe();
    await fx.close();
  }
});

function ownerCtx(accountId: string): AccountContext {
  return {
    account: { id: accountId },
    apiKey: { id: 'key_crypto', scopes: ['account_owner'] as ApiKeyScope[] },
  } as unknown as AccountContext;
}

interface Fixture {
  accountId: string;
  endpointId: string;
  orderId: string;
  crypto: CryptoOrdersService;
}

/** An account subscribed to crypto.order.paid, and one pending order of its own. */
async function paidOrderFixture(webhooks: 'bootstrap' | 'failing'): Promise<Fixture> {
  const db = fx!;
  const accountId = await db.seedAccount();
  const webhooksService = new WebhooksService(db.repo);
  const { row } = await webhooksService.create(ownerCtx(accountId), {
    url: 'https://hooks.test.local/crypto',
    events: ['crypto.order.paid'],
    description: null,
  });
  // `bootstrap` is the wiring production runs; `failing` is the audit's connection
  // reset on the after-commit enqueue.
  const emitter: CryptoOrderWebhookEmitter =
    webhooks === 'bootstrap'
      ? { enqueueEvent: (acc, type, data) => webhooksService.enqueueEvent(acc, type, data) }
      : { enqueueEvent: () => Promise.reject(new Error('connection reset')) };
  const crypto = new CryptoOrdersService({
    repo: new DrizzleCryptoOrdersRepo({
      client: db.client,
      db: drizzle(db.client, { schema }),
      close: async () => {},
    }),
    webhooks: emitter,
  });
  const orderId = `ord_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  await crypto.create({
    order_id: orderId,
    account_id: accountId,
    product: 'api_starter',
    price_cents: 2900,
    price_currency: 'usd',
  });
  return { accountId, endpointId: row.id, orderId, crypto };
}

async function paidDeliveries(
  endpointId: string,
): Promise<Array<{ event_id: string; payload: Record<string, unknown> }>> {
  return fx!.client<Array<{ event_id: string; payload: Record<string, unknown> }>>`
    SELECT event_id, payload FROM webhook_deliveries
    WHERE webhook_id = ${endpointId} AND event_type = 'crypto.order.paid'
    ORDER BY created_at`;
}

async function statusOf(orderId: string): Promise<string | undefined> {
  const [row] = await fx!.client<Array<{ status: string }>>`
    SELECT status FROM crypto_orders WHERE order_id = ${orderId}`;
  return row?.status;
}

const finished = (orderId: string) => ({
  order_id: orderId,
  payment_id: 'np_outbox_1',
  provider_status: 'finished',
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'a paid crypto order and its webhook are committed together',
  () => {
    it('CRITICAL the isolated database was reached', () => {
      expect(fx, `could not create or reach ${ISOLATED_DB_NAME}`).not.toBeNull();
    });

    it('CRITICAL the paid event is queued with the order — so a failure of the after-commit step (the audit’s connection reset) no longer loses it', async () => {
      const f = await paidOrderFixture('failing');
      const order = await f.crypto.applyIpnStatus(finished(f.orderId));
      expect(order?.status).toBe('paid');
      const rows = await paidDeliveries(f.endpointId);
      expect(rows, 'the order is paid and its crypto.order.paid was lost').toHaveLength(1);
      expect(rows[0]?.payload).toMatchObject({
        id: rows[0]?.event_id,
        type: 'crypto.order.paid',
        data: {
          order_id: f.orderId,
          product: 'api_starter',
          price_cents: 2900,
          price_currency: 'usd',
          payment_id: 'np_outbox_1',
        },
      });
    });

    it('CRITICAL when the delivery rows cannot be written, the order is NOT marked paid either — the IPN fails, and the provider’s retry then pays the order and fires the event exactly once', async () => {
      const f = await paidOrderFixture('bootstrap');
      await fx!.client.unsafe(`
        CREATE OR REPLACE FUNCTION test_refuse_paid_delivery() RETURNS trigger AS $$
        BEGIN
          IF NEW.event_type = 'crypto.order.paid' THEN
            RAISE EXCEPTION 'delivery insert refused by the test';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await fx!.client`
        CREATE TRIGGER test_refuse_paid_delivery BEFORE INSERT ON webhook_deliveries
        FOR EACH ROW EXECUTE FUNCTION test_refuse_paid_delivery()`;

      const first = await f.crypto.applyIpnStatus(finished(f.orderId)).then(
        (o) => ({ ok: true as const, status: o?.status }),
        (err: unknown) => ({ ok: false as const, err }),
      );
      expect(
        await statusOf(f.orderId),
        'the order committed as paid while its event was lost — a retried IPN will never fire it',
      ).toBe('pending');
      expect(first.ok, 'the IPN must fail so the provider retries it').toBe(false);

      await fx!.client`DROP TRIGGER test_refuse_paid_delivery ON webhook_deliveries`;
      const retried = await f.crypto.applyIpnStatus(finished(f.orderId));
      expect(retried?.status).toBe('paid');
      expect(await paidDeliveries(f.endpointId)).toHaveLength(1);
    });

    it('CRITICAL a re-delivered IPN for an order already paid queues no second event', async () => {
      const f = await paidOrderFixture('bootstrap');
      await f.crypto.applyIpnStatus(finished(f.orderId));
      await f.crypto.applyIpnStatus(finished(f.orderId));
      expect(await paidDeliveries(f.endpointId)).toHaveLength(1);
    });
  },
);
