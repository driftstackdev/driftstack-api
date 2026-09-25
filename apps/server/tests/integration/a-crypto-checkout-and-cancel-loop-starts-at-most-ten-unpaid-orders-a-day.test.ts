// A crypto checkout-and-cancel loop starts at most ten unpaid orders a day
// (security sweep 2026-09-24, finding #18, second pass).
//
// The first fix capped the orders an account holds OPEN (pending) at five. A
// cancel frees a place at once, so a loop of checkout → cancel stayed under that
// cap for ever: thirty cycles minted thirty NowPayments payments and wrote thirty
// order rows. An account may now also START at most
// MAX_UNPAID_CRYPTO_ORDERS_STARTED_PER_DAY orders in a trailing 24 hours that it
// has not paid for (pending, cancelled or failed). One more is refused with the
// same 409 problem shape, before any Idempotency-Key is stored, any row is written
// or any payment is minted. A paid order never counts, and repeating the key of an
// order already started replays it and is never refused.
//
// Route arms run on the test app with the NowPayments client doubled; service
// arms move the clock; the Drizzle arms run on a private schema of the test
// database, several connections at once.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Database } from '../../src/db/client.js';
import { DrizzleCryptoOrdersRepo } from '../../src/db/crypto-orders-repo.js';
import type { CreatePaymentResult, NowPaymentsApiClient } from '../../src/lib/nowpayments-api.js';
import {
  CryptoOrdersService,
  InMemoryCryptoOrdersRepo,
  MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT,
  MAX_UNPAID_CRYPTO_ORDERS_STARTED_PER_DAY,
} from '../../src/services/crypto-orders.js';
import {
  buildTestApp,
  seedAdditionalAccount,
  type TestAppFixture,
} from './_helpers/build-test-app.js';

const BUDGET = MAX_UNPAID_CRYPTO_ORDERS_STARTED_PER_DAY;
const DAY_MS = 24 * 60 * 60 * 1000;

function nowpaymentsDouble(): {
  client: NowPaymentsApiClient;
  createPayment: ReturnType<typeof vi.fn>;
} {
  let n = 0;
  const createPayment = vi.fn((): Promise<CreatePaymentResult> => {
    n += 1;
    return Promise.resolve({
      paymentId: `pay_loop_${String(n)}`,
      payAddress: `0xLOOPADDRESS${String(n)}`,
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
): Promise<{ status: number; body: Record<string, unknown>; replayed: boolean }> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/billing/crypto-checkout',
    headers: {
      authorization: `Bearer ${opts.bearer ?? fx.plaintext}`,
      ...(opts.idempotencyKey !== undefined ? { 'idempotency-key': opts.idempotencyKey } : {}),
    },
    payload: { product: 'solo_manual', price_cents: 7900, price_currency: 'USD' },
  });
  return {
    status: res.statusCode,
    body: res.json<Record<string, unknown>>(),
    replayed: res.headers['idempotent-replayed'] === '1',
  };
}

async function cancel(fx: TestAppFixture, orderId: unknown, bearer = fx.plaintext): Promise<void> {
  const res = await fx.app.inject({
    method: 'POST',
    url: `/v1/billing/crypto-orders/${String(orderId)}/cancel`,
    headers: { authorization: `Bearer ${bearer}` },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function rowsOf(fx: TestAppFixture, accountId = fx.accountId): Promise<number> {
  return (await fx.cryptoOrdersRepo.listAll({ accountId, limit: 1000 })).length;
}

/** Checkout then cancel, `cycles` times; returns the status of every checkout. */
async function loop(fx: TestAppFixture, cycles: number, bearer = fx.plaintext): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < cycles; i += 1) {
    const r = await checkout(fx, { bearer });
    statuses.push(r.status);
    if (r.status === 201) await cancel(fx, r.body.order_id, bearer);
  }
  return statuses;
}

describe('a crypto checkout-and-cancel loop starts at most ten unpaid orders a day', () => {
  let fx: TestAppFixture | undefined;

  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('the budget is ten unpaid orders a day, twice the open-order limit', () => {
    expect(BUDGET).toBe(10);
    expect(BUDGET).toBe(2 * MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT);
  });

  it('CRITICAL thirty checkout-then-cancel cycles mint ten payments and write ten orders, not thirty', async () => {
    const { client, createPayment } = nowpaymentsDouble();
    fx = await buildTestApp({ nowpaymentsClient: client });

    const statuses = await loop(fx, 30);

    expect(statuses.filter((s) => s === 201)).toHaveLength(BUDGET);
    expect(statuses.filter((s) => s === 409)).toHaveLength(30 - BUDGET);
    expect(createPayment, 'every cycle minted a provider payment').toHaveBeenCalledTimes(BUDGET);
    expect(await rowsOf(fx), 'every cycle wrote an order row').toBe(BUDGET);
  });

  it('CRITICAL the refusal is the same 409 problem shape, naming the daily budget', async () => {
    const { client } = nowpaymentsDouble();
    fx = await buildTestApp({ nowpaymentsClient: client });
    await loop(fx, BUDGET);

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { product: 'solo_manual', price_cents: 7900, price_currency: 'USD' },
    });

    expect(res.statusCode).toBe(409);
    expect(String(res.headers['content-type'])).toContain('application/problem+json');
    const body = res.json<Record<string, unknown>>();
    expect(body.status).toBe(409);
    expect(body.resource).toBe('crypto_order');
    expect(body.limit).toBe(BUDGET);
    expect(String(body.detail)).toMatch(/10 crypto orders/);
    expect(String(body.detail)).toMatch(/24 hours/);
  });

  it('CRITICAL a refused keyed checkout stores no key, writes no order and mints nothing', async () => {
    const { client, createPayment } = nowpaymentsDouble();
    fx = await buildTestApp({ nowpaymentsClient: client });
    await loop(fx, BUDGET);

    const first = await checkout(fx, { idempotencyKey: 'loop-refused' });
    const again = await checkout(fx, { idempotencyKey: 'loop-refused' });

    expect(first.status).toBe(409);
    expect(again.status, 'the refused key was stored and replayed').toBe(409);
    expect(again.replayed).toBe(false);
    expect(createPayment).toHaveBeenCalledTimes(BUDGET);
    expect(await rowsOf(fx)).toBe(BUDGET);
  });

  it('CRITICAL repeating the Idempotency-Key of an order started before the budget ran out replays it', async () => {
    const { client, createPayment } = nowpaymentsDouble();
    fx = await buildTestApp({ nowpaymentsClient: client });
    const original = await checkout(fx, { idempotencyKey: 'loop-kept' });
    expect(original.status).toBe(201);
    await loop(fx, BUDGET - 1);
    expect((await checkout(fx)).status, 'the budget should be spent here').toBe(409);

    const replay = await checkout(fx, { idempotencyKey: 'loop-kept' });

    expect(replay.status).toBe(201);
    expect(replay.replayed).toBe(true);
    expect(replay.body.order_id).toBe(original.body.order_id);
    expect(createPayment).toHaveBeenCalledTimes(BUDGET);
  });

  it('control: one account at its daily budget does not limit another', async () => {
    const { client } = nowpaymentsDouble();
    fx = await buildTestApp({ nowpaymentsClient: client });
    await loop(fx, BUDGET);
    const other = await seedAdditionalAccount(fx);

    expect((await checkout(fx, { bearer: other.plaintext })).status).toBe(201);
  });
});

describe('the daily budget on the service (clock moved)', () => {
  function service(): {
    svc: CryptoOrdersService;
    repo: InMemoryCryptoOrdersRepo;
    at: (ms: number) => void;
  } {
    const repo = new InMemoryCryptoOrdersRepo();
    let now = 1_800_000_000_000;
    const svc = new CryptoOrdersService({ repo, nowFn: () => now });
    return { svc, repo, at: (ms) => (now = 1_800_000_000_000 + ms) };
  }

  let seq = 0;
  function orderArgs(accountId: string): {
    order_id: string;
    account_id: string;
    product: string;
    price_cents: number;
    price_currency: string;
  } {
    seq += 1;
    return {
      order_id: `ord_budget_${String(seq)}`,
      account_id: accountId,
      product: 'solo_manual',
      price_cents: 7900,
      price_currency: 'USD',
    };
  }

  it('CRITICAL the budget frees only as the orders started age past 24 hours', async () => {
    const { svc, at } = service();
    for (let i = 0; i < BUDGET; i += 1) {
      const o = await svc.create(orderArgs('acc_age'));
      await svc.cancelOrder({ order_id: o.order_id, account_id: 'acc_age' });
    }

    at(DAY_MS - 1);
    await expect(svc.create(orderArgs('acc_age'))).rejects.toMatchObject({ status: 409 });
    at(DAY_MS + 1);
    await expect(svc.create(orderArgs('acc_age'))).resolves.toMatchObject({ status: 'pending' });
  });

  it('CRITICAL orders whose payment failed or expired count against the budget', async () => {
    const { svc } = service();
    for (let i = 0; i < BUDGET; i += 1) {
      const o = await svc.create(orderArgs('acc_failed'));
      await svc.recordPaymentId({ order_id: o.order_id, payment_id: `pay_f_${String(i)}` });
      await svc.applyIpnStatus({
        order_id: o.order_id,
        payment_id: `pay_f_${String(i)}`,
        provider_status: i % 2 === 0 ? 'expired' : 'failed',
      });
    }

    await expect(svc.create(orderArgs('acc_failed'))).rejects.toMatchObject({ status: 409 });
  });

  it('control: paid orders never count, so a customer who pays can keep buying', async () => {
    const { svc } = service();
    for (let i = 0; i < 3 * BUDGET; i += 1) {
      const o = await svc.create(orderArgs('acc_paid'));
      await svc.recordPaymentId({ order_id: o.order_id, payment_id: `pay_p_${String(i)}` });
      await svc.applyIpnStatus({
        order_id: o.order_id,
        payment_id: `pay_p_${String(i)}`,
        provider_status: 'finished',
      });
    }

    await expect(svc.create(orderArgs('acc_paid'))).resolves.toMatchObject({ status: 'pending' });
  });

  it('once the budget is spent, cancelling an open order frees nothing and paying one frees a place', async () => {
    const { svc } = service();
    const open: string[] = [];
    for (let i = 0; i < BUDGET; i += 1) {
      const o = await svc.create(orderArgs('acc_pay_frees'));
      if (i < BUDGET - MAX_OPEN_CRYPTO_ORDERS_PER_ACCOUNT) {
        await svc.cancelOrder({ order_id: o.order_id, account_id: 'acc_pay_frees' });
      } else {
        open.push(o.order_id);
      }
    }
    await expect(svc.create(orderArgs('acc_pay_frees'))).rejects.toMatchObject({
      status: 409,
      extensions: { limit: BUDGET },
    });

    await svc.cancelOrder({ order_id: open[0]!, account_id: 'acc_pay_frees' });
    await expect(
      svc.create(orderArgs('acc_pay_frees')),
      'a cancelled order stopped counting against the daily budget',
    ).rejects.toMatchObject({ status: 409, extensions: { limit: BUDGET } });

    await svc.recordPaymentId({ order_id: open[1]!, payment_id: 'pay_frees_1' });
    await svc.applyIpnStatus({
      order_id: open[1]!,
      payment_id: 'pay_frees_1',
      provider_status: 'finished',
    });
    await expect(
      svc.create(orderArgs('acc_pay_frees')),
      'paying an open order did not free a place in the daily budget',
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('CRITICAL a refused keyed create stores nothing: the same key a day later starts a new order', async () => {
    const { svc, repo, at } = service();
    for (let i = 0; i < BUDGET; i += 1) {
      const o = await svc.create(orderArgs('acc_key'));
      await svc.cancelOrder({ order_id: o.order_id, account_id: 'acc_key' });
    }
    await expect(
      svc.createIdempotent({ ...orderArgs('acc_key'), idempotency_key: 'k-refused' }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await repo.listAll({ accountId: 'acc_key', limit: 100 })).length).toBe(BUDGET);

    at(DAY_MS + 1);
    const later = await svc.createIdempotent({
      ...orderArgs('acc_key'),
      idempotency_key: 'k-refused',
    });

    expect(later.replayed, 'the refused request left its key behind').toBe(false);
  });
});

// ── the same budget against Postgres ────────────────────────────────────────

const DB_URL =
  process.env.DATABASE_URL ?? 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const TEST_SCHEMA = `cx_order_budget_${randomUUID().replaceAll('-', '')}`;

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
  'the daily budget on the Drizzle repo (real Postgres)',
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
      await client!`INSERT INTO accounts (id, email) VALUES (${id}, ${`budget-${id}@example.test`})`;
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

    async function rowsInDatabase(accountId: string): Promise<number> {
      const [row] = await client!<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM crypto_orders WHERE account_id = ${accountId}::uuid`;
      return row?.n ?? 0;
    }

    async function cycle(svc: CryptoOrdersService, accountId: string, n: number): Promise<number> {
      let created = 0;
      for (let i = 0; i < n; i += 1) {
        try {
          const o = await svc.create(orderArgs(accountId));
          created += 1;
          await svc.cancelOrder({ order_id: o.order_id, account_id: accountId });
        } catch (err) {
          if ((err as { status?: unknown }).status !== 409) throw err;
        }
      }
      return created;
    }

    it('CRITICAL thirty create-then-cancel cycles write ten orders', async () => {
      if (!reachable) throw new Error('real PostgreSQL setup failed');
      const accountId = await account();

      const created = await cycle(new CryptoOrdersService({ repo: repo() }), accountId, 30);

      expect(created).toBe(BUDGET);
      expect(await rowsInDatabase(accountId)).toBe(BUDGET);
    });

    it('CRITICAL a burst on many servers once the budget is nearly spent admits only what is left', async () => {
      if (!reachable) throw new Error('real PostgreSQL setup failed');
      const accountId = await account();
      await cycle(new CryptoOrdersService({ repo: repo() }), accountId, BUDGET - 2);

      const settled = await Promise.allSettled(
        Array.from({ length: 20 }, () =>
          new CryptoOrdersService({ repo: repo() }).create(orderArgs(accountId)),
        ),
      );

      const created = settled.filter((s) => s.status === 'fulfilled').length;
      const refused = settled.filter(
        (s) => s.status === 'rejected' && (s.reason as { status?: unknown }).status === 409,
      ).length;
      expect(created).toBe(2);
      expect(refused).toBe(18);
      expect(await rowsInDatabase(accountId)).toBe(BUDGET);
    });

    it('CRITICAL at the budget a stored key replays on a server that never saw it, and a new key is refused and stored nowhere', async () => {
      if (!reachable) throw new Error('real PostgreSQL setup failed');
      const accountId = await account();
      const first = new CryptoOrdersService({ repo: repo() });
      const original = await first.createIdempotent({
        ...orderArgs(accountId),
        idempotency_key: 'budget-db-kept',
      });
      await cycle(first, accountId, BUDGET - 1);

      const second = new CryptoOrdersService({ repo: repo() });
      const replay = await second.createIdempotent({
        ...orderArgs(accountId),
        idempotency_key: 'budget-db-kept',
      });
      await expect(
        second.createIdempotent({ ...orderArgs(accountId), idempotency_key: 'budget-db-new' }),
      ).rejects.toMatchObject({ status: 409 });

      expect(replay.replayed).toBe(true);
      expect(replay.order.order_id).toBe(original.order.order_id);
      const [stored] = await client!<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM crypto_orders
         WHERE idempotency_key = ${`${accountId}:budget-db-new`}`;
      expect(stored?.n, 'the refused key was stored').toBe(0);
      expect(await rowsInDatabase(accountId)).toBe(BUDGET);
    });

    it('control: a paid order in the database does not count against the budget', async () => {
      if (!reachable) throw new Error('real PostgreSQL setup failed');
      const accountId = await account();
      const svc = new CryptoOrdersService({ repo: repo() });
      const paid = await svc.create(orderArgs(accountId));
      await svc.recordPaymentId({ order_id: paid.order_id, payment_id: 'pay_budget_db' });
      await svc.applyIpnStatus({
        order_id: paid.order_id,
        payment_id: 'pay_budget_db',
        provider_status: 'finished',
      });

      expect(await cycle(svc, accountId, 30)).toBe(BUDGET);
      expect(await rowsInDatabase(accountId)).toBe(BUDGET + 1);
    });
  },
);
