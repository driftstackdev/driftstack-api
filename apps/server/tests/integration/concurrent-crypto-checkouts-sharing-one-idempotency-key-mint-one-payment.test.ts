// Concurrent crypto checkouts that share one Idempotency-Key mint one payment
// (security sweep 2026-09-24, finding #18, residual).
//
// The open-order limit and the daily budget bound ORDERS. They did not bound the
// PAYMENTS minted with NowPayments. Every checkout that repeats a new
// Idempotency-Key while its first request is still minting comes back as a replay
// of an order that is pending with no payment bound yet, and the route let such a
// replay mint. A probe of twenty concurrent same-key checkouts, then a cancel, over
// twelve keys minted 200 payments for 10 orders.
//
// Now a mint is claimed before NowPayments is called:
//   · in one server, concurrent requests for one order wait for its one mint and
//     answer with the payment it bound;
//   · across servers, the claim is written on the order row, so a request that
//     finds a fresh claim answers without minting. Only a claim older than the
//     NowPayments timeout plus a margin (its holder died) with no payment bound is
//     minted again, by exactly one request;
//   · an account may also mint at most as many payments a day for orders it does
//     not pay for as it may start such orders, refused with the same 409.
//
// Route arms run on the test app, and on two bare servers that share one order
// store, with the NowPayments client doubled. The Drizzle arms run the same
// against a private schema of the test database.

import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Database } from '../../src/db/client.js';
import { DrizzleCryptoOrdersRepo } from '../../src/db/crypto-orders-repo.js';
import {
  NOWPAYMENTS_REQUEST_TIMEOUT_MS,
  type CreatePaymentArgs,
  type CreatePaymentResult,
  type NowPaymentsApiClient,
} from '../../src/lib/nowpayments-api.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { registerCryptoCheckoutRoutes } from '../../src/routes/billing-crypto.js';
import {
  CryptoOrdersService,
  InMemoryCryptoOrdersRepo,
  MAX_PAYMENT_MINTS_PER_DAY,
  MAX_UNPAID_CRYPTO_ORDERS_STARTED_PER_DAY,
  PAYMENT_MINT_CLAIM_STALE_AFTER_MS,
  type CryptoOrdersRepo,
} from '../../src/services/crypto-orders.js';
import type { PricingService } from '../../src/services/pricing.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const BUDGET = MAX_UNPAID_CRYPTO_ORDERS_STARTED_PER_DAY;
const STALE = PAYMENT_MINT_CLAIM_STALE_AFTER_MS;
const BURST = 20;
const PAYLOAD = { product: 'solo_manual', price_cents: 7900, price_currency: 'USD' } as const;

interface Checkout {
  status: number;
  body: Record<string, unknown>;
  replayed: boolean;
}

/**
 * A NowPayments double whose createPayment takes `delayMs`, as the real one takes a
 * network round trip. Each mint gets its own id and address; getPayment answers for
 * any id it minted as still waiting for payment.
 */
function slowNowpayments(delayMs = 30): {
  client: NowPaymentsApiClient;
  createPayment: ReturnType<typeof vi.fn>;
  getPayment: ReturnType<typeof vi.fn>;
  mintedFor: () => string[];
} {
  let n = 0;
  const minted: string[] = [];
  const createPayment = vi.fn((args: CreatePaymentArgs): Promise<CreatePaymentResult> => {
    n += 1;
    const seq = n;
    minted.push(args.orderId);
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          paymentId: `pay_burst_${String(seq)}`,
          payAddress: `0xBURST${String(seq)}`,
          payCurrency: 'btc',
          payAmount: 0.0012,
          priceAmount: 79,
          priceCurrency: 'usd',
          paymentStatus: 'waiting',
        });
      }, delayMs);
    });
  });
  const getPayment = vi.fn((paymentId: string) =>
    Promise.resolve({
      paymentStatus: 'waiting',
      payAddress: `0xBURST${paymentId.replace('pay_burst_', '')}`,
      payCurrency: 'btc',
      payAmount: 0.0012,
    }),
  );
  return {
    client: { createPayment, getPayment } as unknown as NowPaymentsApiClient,
    createPayment,
    getPayment,
    mintedFor: () => [...minted],
  };
}

async function checkout(fx: TestAppFixture, idempotencyKey?: string): Promise<Checkout> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/billing/crypto-checkout',
    headers: {
      authorization: `Bearer ${fx.plaintext}`,
      ...(idempotencyKey !== undefined ? { 'idempotency-key': idempotencyKey } : {}),
    },
    payload: PAYLOAD,
  });
  return {
    status: res.statusCode,
    body: res.json<Record<string, unknown>>(),
    replayed: res.headers['idempotent-replayed'] === '1',
  };
}

async function cancel(fx: TestAppFixture, orderId: unknown): Promise<void> {
  const res = await fx.app.inject({
    method: 'POST',
    url: `/v1/billing/crypto-orders/${String(orderId)}/cancel`,
    headers: { authorization: `Bearer ${fx.plaintext}` },
  });
  expect(res.statusCode, res.body).toBe(200);
}

function burst<T>(n: number, fn: (i: number) => Promise<T>): Promise<T[]> {
  return Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
}

function addresses(results: readonly Checkout[]): Set<unknown> {
  return new Set(results.map((r) => r.body.payment_address));
}

/**
 * One server: its own CryptoOrdersService (its own idempotency cache) and its own
 * checkout route (its own in-process mint map), over an order store that several
 * such servers may share.
 */
async function bareServer(opts: {
  repo: CryptoOrdersRepo;
  nowpayments: NowPaymentsApiClient;
  accountId: string;
  nowFn?: () => number;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.decorate('requireAuth', (req: FastifyRequest) => {
    (req as { account: unknown }).account = { account: { id: opts.accountId }, teams: [] };
    return Promise.resolve();
  });
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());
  registerCryptoCheckoutRoutes(app, {
    service: new CryptoOrdersService({
      repo: opts.repo,
      ...(opts.nowFn !== undefined ? { nowFn: opts.nowFn } : {}),
    }),
    pricing: {
      listEffective: () => Promise.resolve([{ tier: 'solo_manual', monthlyCents: 7900 }]),
    } as unknown as PricingService,
    nowpayments: opts.nowpayments,
    nowpaymentsIpnCallbackUrl: 'https://test.driftstack.dev/v1/webhooks/nowpayments',
  });
  await app.ready();
  return app;
}

async function post(app: FastifyInstance, idempotencyKey: string): Promise<Checkout> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/billing/crypto-checkout',
    headers: { 'idempotency-key': idempotencyKey },
    payload: PAYLOAD,
  });
  return {
    status: res.statusCode,
    body: res.json<Record<string, unknown>>(),
    replayed: res.headers['idempotent-replayed'] === '1',
  };
}

describe('concurrent crypto checkouts sharing one Idempotency-Key mint one payment', () => {
  let fx: TestAppFixture | undefined;
  const servers: FastifyInstance[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fx?.cleanup();
    fx = undefined;
    for (const s of servers.splice(0)) await s.close();
  });

  it('a claim is stale only after the NowPayments timeout and a margin; the mint budget is the order budget', () => {
    expect(STALE).toBeGreaterThan(NOWPAYMENTS_REQUEST_TIMEOUT_MS);
    expect(STALE - NOWPAYMENTS_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(MAX_PAYMENT_MINTS_PER_DAY).toBe(BUDGET);
  });

  it('CRITICAL twenty concurrent checkouts on each of twelve keys, each then cancelled, mint one payment per order', async () => {
    const np = slowNowpayments(30);
    fx = await buildTestApp({ nowpaymentsClient: np.client });
    const orders = new Set<unknown>();

    for (let k = 0; k < 12; k += 1) {
      const results = await burst(BURST, () => checkout(fx!, `burst-${String(k)}`));
      const created = results.filter((r) => r.status === 201);
      const ids = new Set(created.map((r) => r.body.order_id));
      expect(ids.size, 'one key started more than one order').toBeLessThanOrEqual(1);
      if (created.length > 0) {
        expect(
          addresses(created),
          'a request answered with an address other than the bound one',
        ).toEqual(new Set([created[0]!.body.payment_address]));
        expect(created[0]!.body.provider).toBe('nowpayments');
      }
      for (const id of ids) {
        orders.add(id);
        await cancel(fx, id);
      }
    }

    expect(orders.size).toBe(BUDGET);
    expect(np.createPayment, 'each same-key request minted its own payment').toHaveBeenCalledTimes(
      orders.size,
    );
    expect(new Set(np.mintedFor()).size, 'an order was minted twice').toBe(np.mintedFor().length);
  });

  it('CRITICAL twenty concurrent checkouts on one key mint once, and every one answers with that payment', async () => {
    const np = slowNowpayments(30);
    fx = await buildTestApp({ nowpaymentsClient: np.client });

    const results = await burst(BURST, () => checkout(fx!, 'one-key'));

    expect(results.map((r) => r.status)).toEqual(Array.from({ length: BURST }, () => 201));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(np.createPayment).toHaveBeenCalledTimes(1);
    expect(addresses(results)).toEqual(new Set(['0xBURST1']));
  });

  it('CRITICAL after a mint whose payment was not bound, a retry storm mints nothing until the claim is stale, then exactly once', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const t0 = Date.now();
    const np = slowNowpayments(5);
    fx = await buildTestApp({ nowpaymentsClient: np.client });
    vi.spyOn(fx.cryptoOrdersService, 'recordPaymentId').mockRejectedValueOnce(
      new Error('database write lost'),
    );

    const first = await checkout(fx, 'k-unbound');
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ provider: 'stub', payment_address: null });
    expect(np.createPayment).toHaveBeenCalledTimes(1);

    const fresh = await burst(BURST, () => checkout(fx!, 'k-unbound'));
    vi.setSystemTime(t0 + STALE - 1);
    const almost = await burst(BURST, () => checkout(fx!, 'k-unbound'));

    expect(
      np.createPayment,
      'a retry minted while the first mint was still claimed',
    ).toHaveBeenCalledTimes(1);
    for (const r of [...fresh, ...almost]) {
      expect(r.status).toBe(201);
      expect(r.replayed).toBe(true);
      expect(r.body).toMatchObject({ provider: 'stub', payment_address: null, status: 'pending' });
    }

    vi.setSystemTime(t0 + STALE + 1);
    const stale = await burst(BURST, () => checkout(fx!, 'k-unbound'));

    expect(np.createPayment, 'a stale claim was minted again more than once').toHaveBeenCalledTimes(
      2,
    );
    expect(addresses(stale), 'the orphaned first mint was exposed').toEqual(new Set(['0xBURST2']));

    const later = await checkout(fx, 'k-unbound');
    expect(later.body.payment_address).toBe('0xBURST2');
    expect(np.createPayment).toHaveBeenCalledTimes(2);
  });

  it('CRITICAL an account mints at most its daily budget of payments for orders it does not pay, refused with the same 409 before NowPayments is called', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const np = slowNowpayments(1);
    fx = await buildTestApp({ nowpaymentsClient: np.client });
    // Every bind fails, so the one order keeps asking to be minted again.
    vi.spyOn(fx.cryptoOrdersService, 'recordPaymentId').mockRejectedValue(
      new Error('database write lost'),
    );

    const statuses: number[] = [];
    for (let i = 0; i < MAX_PAYMENT_MINTS_PER_DAY + 3; i += 1) {
      statuses.push((await checkout(fx, 'k-remint')).status);
      vi.setSystemTime(Date.now() + STALE + 1);
    }

    expect(np.createPayment, 'mints were not bounded per account per day').toHaveBeenCalledTimes(
      MAX_PAYMENT_MINTS_PER_DAY,
    );
    expect(statuses.slice(0, MAX_PAYMENT_MINTS_PER_DAY)).toEqual(
      Array.from({ length: MAX_PAYMENT_MINTS_PER_DAY }, () => 201),
    );
    expect(statuses.slice(MAX_PAYMENT_MINTS_PER_DAY)).toEqual([409, 409, 409]);

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: PAYLOAD,
    });
    expect(res.statusCode, 'a new order was started with the mint budget spent').toBe(409);
    const body = res.json<Record<string, unknown>>();
    expect(body.resource).toBe('crypto_order');
    expect(body.limit).toBe(MAX_PAYMENT_MINTS_PER_DAY);
    expect(body.field).toBe('payment_id');
    expect(String(body.detail)).toMatch(
      /10 crypto payments have been created in the last 24 hours/,
    );
    expect(np.createPayment).toHaveBeenCalledTimes(MAX_PAYMENT_MINTS_PER_DAY);
    expect(await fx.cryptoOrdersRepo.listAll({ accountId: fx.accountId })).toHaveLength(1);
  });

  it('control: one checkout per key still mints once per order and shows each its own payment', async () => {
    const np = slowNowpayments(5);
    fx = await buildTestApp({ nowpaymentsClient: np.client });

    const results = await burst(5, (i) => checkout(fx!, `single-${String(i)}`));

    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.body.order_id)).size).toBe(5);
    expect(addresses(results).size).toBe(5);
    expect(np.createPayment).toHaveBeenCalledTimes(5);
    expect(new Set(np.mintedFor()).size).toBe(5);
  });

  it('control: checkouts without a key each start and mint their own order', async () => {
    const np = slowNowpayments(5);
    fx = await buildTestApp({ nowpaymentsClient: np.client });

    const results = await burst(3, () => checkout(fx!));

    expect(new Set(results.map((r) => r.body.order_id)).size).toBe(3);
    expect(np.createPayment).toHaveBeenCalledTimes(3);
  });

  it('CRITICAL two servers sharing one order store mint one payment for concurrent same-key checkouts', async () => {
    const np = slowNowpayments(30);
    const repo = new InMemoryCryptoOrdersRepo();
    const accountId = randomUUID();
    const a = await bareServer({ repo, nowpayments: np.client, accountId });
    const b = await bareServer({ repo, nowpayments: np.client, accountId });
    servers.push(a, b);

    const results = await burst(BURST, (i) => post(i % 2 === 0 ? a : b, 'two-servers'));

    expect(results.map((r) => r.status)).toEqual(Array.from({ length: BURST }, () => 201));
    expect(new Set(results.map((r) => r.body.order_id)).size).toBe(1);
    expect(np.createPayment, 'each server minted its own payment').toHaveBeenCalledTimes(1);
    // A server that found the other's claim answers without an address, never another one.
    expect([...addresses(results)].filter((x) => x !== null)).toEqual(['0xBURST1']);

    const [onA, onB] = [await post(a, 'two-servers'), await post(b, 'two-servers')];
    expect(onA.body.payment_address).toBe('0xBURST1');
    expect(onB.body.payment_address).toBe('0xBURST1');
    expect(np.createPayment).toHaveBeenCalledTimes(1);
  });

  it('CRITICAL when a stale claim is minted again while the first mint is still running, both answer with the payment bound first', async () => {
    let now = 1_800_000_000_000;
    const nowFn = (): number => now;
    const release: Array<() => void> = [];
    let call = 0;
    const createPayment = vi.fn((): Promise<CreatePaymentResult> => {
      call += 1;
      const n = call;
      return new Promise((resolve) => {
        release.push(() => {
          resolve({
            paymentId: n === 1 ? 'pay_A' : 'pay_B',
            payAddress: n === 1 ? '0xADDR_A' : '0xADDR_B',
            payCurrency: 'btc',
            payAmount: 0.0012,
            priceAmount: 79,
            priceCurrency: 'usd',
            paymentStatus: 'waiting',
          });
        });
      });
    });
    const getPayment = vi.fn((id: string) =>
      Promise.resolve({
        paymentStatus: 'waiting',
        payAddress: id === 'pay_A' ? '0xADDR_A' : '0xADDR_B',
        payCurrency: 'btc',
        payAmount: 0.0012,
      }),
    );
    const nowpayments = { createPayment, getPayment } as unknown as NowPaymentsApiClient;
    const repo = new InMemoryCryptoOrdersRepo();
    const accountId = randomUUID();
    const a = await bareServer({ repo, nowpayments, accountId, nowFn });
    const b = await bareServer({ repo, nowpayments, accountId, nowFn });
    servers.push(a, b);

    const pA = post(a, 'stale-overlap');
    await vi.waitFor(() => expect(release).toHaveLength(1));
    now += STALE + 1;
    const pB = post(b, 'stale-overlap');
    await vi.waitFor(() => expect(release).toHaveLength(2));

    release[0]!();
    const resA = await pA;
    release[1]!();
    const resB = await pB;

    expect(resB.body.order_id).toBe(resA.body.order_id);
    expect(resA.body.payment_address).toBe('0xADDR_A');
    // The re-mint lost the bind: it must show the bound payment, never its orphan.
    expect(resB.body.payment_address).toBe('0xADDR_A');
    expect(getPayment).toHaveBeenCalledWith('pay_A');
  });
});

describe('the payment mint claim on the service (clock moved)', () => {
  /** Servers (services) sharing one in-memory order store and one clock. */
  function service(): { svc: () => CryptoOrdersService; at: (ms: number) => void } {
    const repo = new InMemoryCryptoOrdersRepo();
    let now = 1_800_000_000_000;
    return {
      svc: () => new CryptoOrdersService({ repo, nowFn: () => now }),
      at: (ms) => (now = 1_800_000_000_000 + ms),
    };
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
      order_id: `ord_claim_${String(seq)}`,
      account_id: accountId,
      product: 'solo_manual',
      price_cents: 7900,
      price_currency: 'USD',
    };
  }

  it('CRITICAL one claim per order until it is stale, and none once a payment is bound', async () => {
    const { svc, at } = service();
    const s = svc();
    const o = await s.create(orderArgs('acc_claim'));

    const claims = await burst(BURST, () => svc().claimPaymentMint({ order_id: o.order_id }));
    expect(claims.filter((c) => c?.kind === 'claimed')).toHaveLength(1);
    expect(claims.filter((c) => c?.kind === 'in_progress')).toHaveLength(BURST - 1);

    at(STALE);
    expect((await s.claimPaymentMint({ order_id: o.order_id }))?.kind).toBe('in_progress');
    at(STALE + 1);
    const again = await burst(BURST, () => svc().claimPaymentMint({ order_id: o.order_id }));
    expect(again.filter((c) => c?.kind === 'claimed')).toHaveLength(1);

    await s.recordPaymentId({ order_id: o.order_id, payment_id: 'pay_bound' });
    at(10 * STALE);
    const bound = await s.claimPaymentMint({ order_id: o.order_id });
    expect(bound?.kind).toBe('bound');
    expect(bound?.order.payment_id).toBe('pay_bound');
  });

  it('an order that is no longer pending is never claimed', async () => {
    const { svc } = service();
    const s = svc();
    const o = await s.create(orderArgs('acc_cancelled'));
    await s.cancelOrder({ order_id: o.order_id, account_id: 'acc_cancelled' });

    expect((await s.claimPaymentMint({ order_id: o.order_id }))?.kind).toBe('not_pending');
    expect(await s.claimPaymentMint({ order_id: 'ord_missing' })).toBeNull();
  });

  it('CRITICAL the mint budget refuses the next claim with the order limits 409, frees as claims age past 24 hours, and never counts a paid order', async () => {
    const { svc, at } = service();
    const s = svc();
    const o = await s.create(orderArgs('acc_mints'));
    for (let i = 0; i < MAX_PAYMENT_MINTS_PER_DAY; i += 1) {
      at(i * (STALE + 1));
      expect((await s.claimPaymentMint({ order_id: o.order_id }))?.kind).toBe('claimed');
    }
    at(MAX_PAYMENT_MINTS_PER_DAY * (STALE + 1));
    await expect(s.claimPaymentMint({ order_id: o.order_id })).rejects.toMatchObject({
      status: 409,
      extensions: { limit: MAX_PAYMENT_MINTS_PER_DAY },
    });
    await expect(s.create(orderArgs('acc_mints'))).rejects.toMatchObject({ status: 409 });

    at(24 * 60 * 60 * 1000 + MAX_PAYMENT_MINTS_PER_DAY * (STALE + 1));
    expect((await s.claimPaymentMint({ order_id: o.order_id }))?.kind).toBe('claimed');

    const { svc: svc2, at: at2 } = service();
    const p = svc2();
    for (let i = 0; i < 3 * MAX_PAYMENT_MINTS_PER_DAY; i += 1) {
      at2(i * (STALE + 1));
      const paid = await p.create(orderArgs('acc_pays'));
      expect((await p.claimPaymentMint({ order_id: paid.order_id }))?.kind).toBe('claimed');
      await p.recordPaymentId({ order_id: paid.order_id, payment_id: `pay_paid_${String(i)}` });
      await p.applyIpnStatus({
        order_id: paid.order_id,
        payment_id: `pay_paid_${String(i)}`,
        provider_status: 'finished',
      });
    }
    const next = await p.create(orderArgs('acc_pays'));
    expect((await p.claimPaymentMint({ order_id: next.order_id }))?.kind).toBe('claimed');
  });
});

// ── the same claim against Postgres ─────────────────────────────────────────

const DB_URL =
  process.env.DATABASE_URL ?? 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const TEST_SCHEMA = `cx_mint_claim_${randomUUID().replaceAll('-', '')}`;

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
  await admin.unsafe(
    `CREATE TABLE "${TEST_SCHEMA}"."crypto_orders" (LIKE public."crypto_orders" INCLUDING ALL)`,
  );
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
  'the payment mint claim on the Drizzle repo (real Postgres)',
  () => {
    const servers: FastifyInstance[] = [];
    afterEach(async () => {
      for (const s of servers.splice(0)) await s.close();
    });

    function repo(): DrizzleCryptoOrdersRepo {
      if (client === null) throw new Error('real PostgreSQL setup failed');
      return new DrizzleCryptoOrdersRepo({
        client,
        db: drizzle(client),
        close: async () => {},
      } as unknown as Database);
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

    it('CRITICAL two servers sharing the database mint one payment for concurrent same-key checkouts', async () => {
      if (!reachable) throw new Error('real PostgreSQL setup failed');
      const np = slowNowpayments(30);
      const accountId = randomUUID();
      const a = await bareServer({ repo: repo(), nowpayments: np.client, accountId });
      const b = await bareServer({ repo: repo(), nowpayments: np.client, accountId });
      servers.push(a, b);

      const results = await burst(BURST, (i) => post(i % 2 === 0 ? a : b, 'db-two-servers'));

      expect(results.map((r) => r.status)).toEqual(Array.from({ length: BURST }, () => 201));
      expect(new Set(results.map((r) => r.body.order_id)).size).toBe(1);
      expect(np.createPayment, 'each server minted its own payment').toHaveBeenCalledTimes(1);
      expect([...addresses(results)].filter((x) => x !== null)).toEqual(['0xBURST1']);
      const [row] = await client!<Array<{ payment_id: string | null; payment_mints: number }>>`
        SELECT payment_id, payment_mints FROM crypto_orders WHERE account_id = ${accountId}::uuid`;
      expect(row).toEqual({ payment_id: 'pay_burst_1', payment_mints: 1 });
    });

    it('CRITICAL twenty servers claiming one order at once admit one, and one again once the claim is stale', async () => {
      if (!reachable) throw new Error('real PostgreSQL setup failed');
      let now = Date.now();
      const svc = (): CryptoOrdersService =>
        new CryptoOrdersService({ repo: repo(), nowFn: () => now });
      const o = await svc().create(orderArgs(randomUUID()));

      const first = await burst(BURST, () => svc().claimPaymentMint({ order_id: o.order_id }));
      now += STALE - 1;
      const fresh = await burst(BURST, () => svc().claimPaymentMint({ order_id: o.order_id }));
      now += 2;
      const stale = await burst(BURST, () => svc().claimPaymentMint({ order_id: o.order_id }));

      expect(first.filter((c) => c?.kind === 'claimed')).toHaveLength(1);
      expect(fresh.filter((c) => c?.kind === 'claimed')).toHaveLength(0);
      expect(stale.filter((c) => c?.kind === 'claimed')).toHaveLength(1);

      await svc().recordPaymentId({ order_id: o.order_id, payment_id: 'pay_db_bound' });
      now += 10 * STALE;
      expect((await svc().claimPaymentMint({ order_id: o.order_id }))?.kind).toBe('bound');
    });

    it('CRITICAL the mint budget spans the account across servers and is refused with the order limits 409', async () => {
      if (!reachable) throw new Error('real PostgreSQL setup failed');
      let now = Date.now();
      const svc = (): CryptoOrdersService =>
        new CryptoOrdersService({ repo: repo(), nowFn: () => now });
      const accountId = randomUUID();
      const orders = await Promise.all([
        svc().create(orderArgs(accountId)),
        svc().create(orderArgs(accountId)),
      ]);
      for (let i = 0; i < MAX_PAYMENT_MINTS_PER_DAY - 2; i += 1) {
        expect((await svc().claimPaymentMint({ order_id: orders[0].order_id }))?.kind).toBe(
          'claimed',
        );
        now += STALE + 1;
      }

      // Two mints are left; twenty servers ask for them on both orders at once.
      const settled = await Promise.allSettled(
        Array.from({ length: BURST }, (_, i) =>
          svc().claimPaymentMint({ order_id: orders[i % 2]!.order_id }),
        ),
      );
      const claimed = settled.filter(
        (s) => s.status === 'fulfilled' && s.value?.kind === 'claimed',
      );
      expect(claimed).toHaveLength(2);

      now += STALE + 1;
      await expect(svc().claimPaymentMint({ order_id: orders[1].order_id })).rejects.toMatchObject({
        status: 409,
        extensions: { limit: MAX_PAYMENT_MINTS_PER_DAY },
      });
      await expect(svc().create(orderArgs(accountId))).rejects.toMatchObject({ status: 409 });
      const [row] = await client!<Array<{ n: number }>>`
        SELECT coalesce(sum(payment_mints), 0)::int AS n FROM crypto_orders
         WHERE account_id = ${accountId}::uuid`;
      expect(row?.n).toBe(MAX_PAYMENT_MINTS_PER_DAY);
    });
  },
);
