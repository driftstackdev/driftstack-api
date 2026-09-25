// Crypto checkout keeps at most five unpaid orders open per account (security
// sweep 2026-09-24, finding #18).
//
// POST /v1/billing/crypto-checkout created a new pending order on every request
// without an Idempotency-Key and, with NowPayments wired, minted a provider
// payment for each one. Nothing bounded how many unpaid orders one account could
// hold, so a signed-in owner could spend the provider's API quota and fill the
// order table at the global rate limit. An account now holds at most
// MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT orders waiting for payment; one more is
// refused with 409 before any order is written or any payment is minted. Paying,
// cancelling or the 24-hour expiry frees a place. A request that repeats an
// Idempotency-Key is a replay, not a new order, and is never refused.
//
// Route arms run on the test app with the NowPayments client doubled; the
// Drizzle arms run the service on a private schema of the test database.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Database } from '../../src/db/client.js';
import { DrizzleCryptoOrdersRepo } from '../../src/db/crypto-orders-repo.js';
import type { CreatePaymentResult, NowPaymentsApiClient } from '../../src/lib/nowpayments-api.js';
import {
  CryptoOrdersService,
  MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT,
} from '../../src/services/crypto-orders.js';
import {
  buildTestApp,
  seedAdditionalAccount,
  type TestAppFixture,
} from './_helpers/build-test-app.js';

function nowpaymentsDouble(): {
  client: NowPaymentsApiClient;
  createPayment: ReturnType<typeof vi.fn>;
} {
  let n = 0;
  const createPayment = vi.fn((): Promise<CreatePaymentResult> => {
    n += 1;
    return Promise.resolve({
      paymentId: `pay_cap_${String(n)}`,
      payAddress: `0xPAYADDRESS${String(n)}`,
      payCurrency: 'btc',
      payAmount: 0.0012,
      priceAmount: 79,
      priceCurrency: 'usd',
      paymentStatus: 'waiting',
    });
  });
  return { client: { createPayment } as unknown as NowPaymentsApiClient, createPayment };
}

async function checkout(
  fx: TestAppFixture,
  opts: { idempotencyKey?: string; bearer?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/billing/crypto-checkout',
    headers: {
      authorization: `Bearer ${opts.bearer ?? fx.plaintext}`,
      ...(opts.idempotencyKey !== undefined ? { 'idempotency-key': opts.idempotencyKey } : {}),
    },
    payload: { product: 'solo_manual', price_cents: 7900, price_currency: 'USD' },
  });
  return { status: res.statusCode, body: res.json<Record<string, unknown>>() };
}

async function pendingOrders(fx: TestAppFixture, accountId = fx.accountId): Promise<number> {
  const orders = await fx.cryptoOrdersRepo.listAll({ accountId, limit: 100 });
  return orders.filter((o) => o.status === 'pending').length;
}

describe('crypto checkout keeps at most five unpaid orders open per account', () => {
  let fx: TestAppFixture | undefined;

  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('the limit is five', () => {
    expect(MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT).toBe(5);
  });

  it('CRITICAL a sixth checkout while five orders wait for payment is refused with 409, and neither writes an order nor mints a payment', async () => {
    const { client, createPayment } = nowpaymentsDouble();
    fx = await buildTestApp({ nowpaymentsClient: client });
    for (let i = 0; i < MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT; i += 1) {
      expect((await checkout(fx)).status).toBe(201);
    }
    expect(createPayment).toHaveBeenCalledTimes(MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT);

    const refused = await checkout(fx);

    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(String(refused.body.detail)).toMatch(/5 crypto orders waiting for payment/);
    expect(refused.body.limit).toBe(MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT);
    expect(createPayment, 'a refused checkout still minted a payment').toHaveBeenCalledTimes(
      MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT,
    );
    expect(await pendingOrders(fx)).toBe(MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT);
  });

  it('CRITICAL thirty checkouts in a row mint five payments, not thirty', async () => {
    const { client, createPayment } = nowpaymentsDouble();
    fx = await buildTestApp({ nowpaymentsClient: client });
    const statuses: number[] = [];
    for (let i = 0; i < 30; i += 1) statuses.push((await checkout(fx)).status);

    expect(statuses.filter((s) => s === 201)).toHaveLength(MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT);
    expect(statuses.filter((s) => s === 409)).toHaveLength(30 - MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT);
    expect(createPayment).toHaveBeenCalledTimes(MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT);
    expect(await pendingOrders(fx)).toBe(MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT);
  });

  it('CRITICAL thirty checkouts sent at once mint five payments, not thirty — the count and the write are one step', async () => {
    const { client, createPayment } = nowpaymentsDouble();
    fx = await buildTestApp({ nowpaymentsClient: client });
    const app = fx;

    const statuses = (await Promise.all(Array.from({ length: 30 }, () => checkout(app)))).map(
      (r) => r.status,
    );

    expect(statuses.filter((s) => s === 201)).toHaveLength(MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT);
    expect(statuses.filter((s) => s === 409)).toHaveLength(30 - MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT);
    expect(createPayment).toHaveBeenCalledTimes(MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT);
    expect(await pendingOrders(app)).toBe(MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT);
  });

  it('CRITICAL thirty checkouts sent at once, each with its own Idempotency-Key, open five orders', async () => {
    const { client, createPayment } = nowpaymentsDouble();
    fx = await buildTestApp({ nowpaymentsClient: client });
    const app = fx;

    const statuses = (
      await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          checkout(app, { idempotencyKey: `cap-burst-${String(i)}` }),
        ),
      )
    ).map((r) => r.status);

    expect(statuses.filter((s) => s === 201)).toHaveLength(MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT);
    expect(createPayment).toHaveBeenCalledTimes(MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT);
    expect(await pendingOrders(app)).toBe(MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT);
  });

  it('cancelling an unpaid order frees a place', async () => {
    const { client } = nowpaymentsDouble();
    fx = await buildTestApp({ nowpaymentsClient: client });
    const first = await checkout(fx);
    for (let i = 1; i < MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT; i += 1) await checkout(fx);
    expect((await checkout(fx)).status).toBe(409);

    const cancelled = await fx.app.inject({
      method: 'POST',
      url: `/v1/billing/crypto-orders/${String(first.body.order_id)}/cancel`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(cancelled.statusCode).toBe(200);

    expect((await checkout(fx)).status).toBe(201);
  });

  it('CRITICAL repeating an Idempotency-Key at the limit replays the original order instead of refusing it', async () => {
    const { client, createPayment } = nowpaymentsDouble();
    fx = await buildTestApp({ nowpaymentsClient: client });
    const original = await checkout(fx, { idempotencyKey: 'cap-replay-1' });
    for (let i = 1; i < MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT; i += 1) await checkout(fx);

    const replay = await checkout(fx, { idempotencyKey: 'cap-replay-1' });

    expect(replay.status).toBe(201);
    expect(replay.body.order_id).toBe(original.body.order_id);
    expect(createPayment).toHaveBeenCalledTimes(MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT);
  });

  it('a new Idempotency-Key at the limit is a new order, and is refused', async () => {
    const { client } = nowpaymentsDouble();
    fx = await buildTestApp({ nowpaymentsClient: client });
    for (let i = 0; i < MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT; i += 1) await checkout(fx);

    expect((await checkout(fx, { idempotencyKey: 'cap-new-key' })).status).toBe(409);
  });

  it('control: one account at its limit does not limit another', async () => {
    const { client } = nowpaymentsDouble();
    fx = await buildTestApp({ nowpaymentsClient: client });
    for (let i = 0; i < MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT; i += 1) await checkout(fx);
    const other = await seedAdditionalAccount(fx);

    expect((await checkout(fx, { bearer: other.plaintext })).status).toBe(201);
  });
});

// ── the same limit against Postgres ─────────────────────────────────────────

const DB_URL =
  process.env.DATABASE_URL ?? 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const TEST_SCHEMA = `cx_open_orders_${randomUUID().replaceAll('-', '')}`;

let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;
let reachable = false;

beforeAll(async () => {
  if (!process.env.CI && !process.env.DATABASE_URL) return;
  admin = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await admin`SELECT 1`;
    reachable = true;
  } catch {
    await admin.end({ timeout: 1 }).catch(() => {});
    admin = null;
    return;
  }
  await admin.unsafe(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  for (const table of ['accounts', 'crypto_orders']) {
    await admin.unsafe(
      `CREATE TABLE "${TEST_SCHEMA}"."${table}" (LIKE public."${table}" INCLUDING ALL)`,
    );
  }
  // A pool of several connections, each opened on the private schema, so the
  // concurrent arms below race on separate Postgres sessions as servers do.
  client = postgres(DB_URL, {
    max: 10,
    connection: { options: `-c search_path=${TEST_SCHEMA},public` },
  });
  try {
    await client`SELECT 1 FROM crypto_orders LIMIT 0`;
  } catch {
    reachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
}, 60_000);

afterAll(async () => {
  if (admin) {
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
    await admin.end({ timeout: 5 }).catch(() => {});
  }
  await client?.end({ timeout: 5 }).catch(() => {});
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'the open-order limit on the Drizzle repo (real Postgres)',
  () => {
    function repo(): DrizzleCryptoOrdersRepo {
      if (client === null) throw new Error('real PostgreSQL setup failed');
      return new DrizzleCryptoOrdersRepo({
        client,
        db: drizzle(client),
        close: async () => {},
      } as unknown as Database);
    }

    async function account(): Promise<string> {
      const id = randomUUID();
      await client!`INSERT INTO accounts (id, email) VALUES (${id}, ${`cap-${id}@example.test`})`;
      return id;
    }

    function orderArgs(accountId: string): {
      order_id: string;
      account_id: string;
      product: string;
      price_cents: number;
      price_currency: string;
    } {
      return {
        order_id: `ord_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        account_id: accountId,
        product: 'solo_manual',
        price_cents: 7900,
        price_currency: 'USD',
      };
    }

    it('CRITICAL the service refuses a sixth unpaid order, counting only pending orders of that account', async () => {
      if (!reachable) throw new Error('real PostgreSQL setup failed');
      const service = new CryptoOrdersService({ repo: repo() });
      const accountId = await account();
      const firsts = [];
      for (let i = 0; i < MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT; i += 1) {
        firsts.push(await service.create(orderArgs(accountId)));
      }

      await expect(service.create(orderArgs(accountId))).rejects.toMatchObject({ status: 409 });

      // A paid order is no longer waiting for payment, so it frees a place.
      await service.recordPaymentId({ order_id: firsts[0]!.order_id, payment_id: 'pay_cap_db' });
      await service.applyIpnStatus({
        order_id: firsts[0]!.order_id,
        payment_id: 'pay_cap_db',
        provider_status: 'finished',
      });
      await expect(service.create(orderArgs(accountId))).resolves.toMatchObject({
        status: 'pending',
      });
      // Another account is untouched by this one's orders.
      await expect(service.create(orderArgs(await account()))).resolves.toMatchObject({
        status: 'pending',
      });
    });

    it('CRITICAL a key already stored in the database is replayed at the limit, even by a server that has never seen it', async () => {
      if (!reachable) throw new Error('real PostgreSQL setup failed');
      const accountId = await account();
      const first = new CryptoOrdersService({ repo: repo() });
      const original = await first.createIdempotent({
        ...orderArgs(accountId),
        idempotency_key: 'cap-db-replay',
      });
      for (let i = 1; i < MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT; i += 1) {
        await first.create(orderArgs(accountId));
      }

      // A second instance (or the same one after a restart) has no in-process record of the key.
      const second = new CryptoOrdersService({ repo: repo() });
      const replay = await second.createIdempotent({
        ...orderArgs(accountId),
        idempotency_key: 'cap-db-replay',
      });

      expect(replay.replayed).toBe(true);
      expect(replay.order.order_id).toBe(original.order.order_id);
      await expect(
        second.createIdempotent({ ...orderArgs(accountId), idempotency_key: 'cap-db-new' }),
      ).rejects.toMatchObject({ status: 409 });
    });

    async function pendingInDatabase(accountId: string): Promise<number> {
      const [row] = await client!<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM crypto_orders
         WHERE account_id = ${accountId}::uuid AND status = 'pending'`;
      return row?.n ?? 0;
    }

    function outcomes(settled: ReadonlyArray<PromiseSettledResult<unknown>>): {
      created: number;
      refused: number;
      other: unknown[];
    } {
      let created = 0;
      let refused = 0;
      const other: unknown[] = [];
      for (const s of settled) {
        if (s.status === 'fulfilled') created += 1;
        else if ((s.reason as { status?: unknown }).status === 409) refused += 1;
        else other.push(s.reason);
      }
      return { created, refused, other };
    }

    it('CRITICAL thirty creates at once, each on its own server, leave exactly five pending orders', async () => {
      if (!reachable) throw new Error('real PostgreSQL setup failed');
      const accountId = await account();

      const settled = await Promise.allSettled(
        Array.from({ length: 30 }, () =>
          new CryptoOrdersService({ repo: repo() }).create(orderArgs(accountId)),
        ),
      );

      const { created, refused, other } = outcomes(settled);
      expect(other).toEqual([]);
      expect(created).toBe(MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT);
      expect(refused).toBe(30 - MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT);
      expect(await pendingInDatabase(accountId)).toBe(MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT);
    });

    it('CRITICAL thirty keyed creates at once, each on its own server, leave exactly five pending orders', async () => {
      if (!reachable) throw new Error('real PostgreSQL setup failed');
      const accountId = await account();

      const settled = await Promise.allSettled(
        Array.from({ length: 30 }, (_, i) =>
          new CryptoOrdersService({ repo: repo() }).createIdempotent({
            ...orderArgs(accountId),
            idempotency_key: `cap-db-burst-${String(i)}`,
          }),
        ),
      );

      const { created, refused, other } = outcomes(settled);
      expect(other).toEqual([]);
      expect(created).toBe(MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT);
      expect(refused).toBe(30 - MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT);
      expect(await pendingInDatabase(accountId)).toBe(MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT);
    });

    it('a key repeated at once on many servers at the limit is replayed by every one of them', async () => {
      if (!reachable) throw new Error('real PostgreSQL setup failed');
      const accountId = await account();
      const first = new CryptoOrdersService({ repo: repo() });
      const original = await first.createIdempotent({
        ...orderArgs(accountId),
        idempotency_key: 'cap-db-repeat',
      });
      for (let i = 1; i < MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT; i += 1) {
        await first.create(orderArgs(accountId));
      }

      const replays = await Promise.all(
        Array.from({ length: 10 }, () =>
          new CryptoOrdersService({ repo: repo() }).createIdempotent({
            ...orderArgs(accountId),
            idempotency_key: 'cap-db-repeat',
          }),
        ),
      );

      for (const r of replays) {
        expect(r.replayed).toBe(true);
        expect(r.order.order_id).toBe(original.order.order_id);
      }
      expect(await pendingInDatabase(accountId)).toBe(MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT);
    });

    it('CRITICAL cancelling one order and bursting again opens one order each time, not another burst', async () => {
      if (!reachable) throw new Error('real PostgreSQL setup failed');
      const accountId = await account();
      const first = new CryptoOrdersService({ repo: repo() });
      const firsts = [];
      for (let i = 0; i < MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT; i += 1) {
        firsts.push(await first.create(orderArgs(accountId)));
      }

      for (let round = 0; round < 3; round += 1) {
        const cancelled = await first.cancelOrder({
          order_id: firsts[round]!.order_id,
          account_id: accountId,
        });
        expect(cancelled?.ok).toBe('cancelled');
        const settled = await Promise.allSettled(
          Array.from({ length: 20 }, () =>
            new CryptoOrdersService({ repo: repo() }).create(orderArgs(accountId)),
          ),
        );
        const { created, refused, other } = outcomes(settled);
        expect(other).toEqual([]);
        expect(created, `round ${String(round)}`).toBe(1);
        expect(refused, `round ${String(round)}`).toBe(19);
      }

      expect(await pendingInDatabase(accountId)).toBe(MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT);
    });

    it('bursts on two accounts at once open five orders each: one account never holds back another', async () => {
      if (!reachable) throw new Error('real PostgreSQL setup failed');
      const [a, b] = [await account(), await account()];

      const settled = await Promise.allSettled(
        Array.from({ length: 24 }, (_, i) =>
          new CryptoOrdersService({ repo: repo() }).create(orderArgs(i % 2 === 0 ? a : b)),
        ),
      );

      expect(outcomes(settled).created).toBe(2 * MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT);
      expect(await pendingInDatabase(a)).toBe(MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT);
      expect(await pendingInDatabase(b)).toBe(MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT);
    });
  },
);
