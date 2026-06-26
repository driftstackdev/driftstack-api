// Billing-integrity — crypto IPN amount reconciliation (#8) + payment_id
// binding (#9).
//
// #8: an order is only flipped to 'paid' when the IPN's actually_paid is
// >= price_amount (within a small tolerance). An under-payment ('finished'
// but short) routes to 'partial', never 'paid', so support never sees a
// short-pay as a fully-paid record.
//
// #9: the NowPayments payment_id is bound to the order at createPayment
// (recordPaymentId). applyIpnStatus rejects + alarms when an IPN's
// payment_id doesn't match the stored one (guards the admin apply-ipn
// path where an operator supplies the payment_id by hand).

import { describe, expect, it, vi } from 'vitest';
import { CryptoOrdersService, InMemoryCryptoOrdersRepo } from '../../src/services/crypto-orders.js';

async function seed(opts?: {
  paidNotifier?: { notifyOrderPaid: ReturnType<typeof vi.fn> };
  logger?: { error: ReturnType<typeof vi.fn> };
}): Promise<{ svc: CryptoOrdersService; repo: InMemoryCryptoOrdersRepo }> {
  const repo = new InMemoryCryptoOrdersRepo();
  let now = 1_000;
  const svc = new CryptoOrdersService({
    repo,
    nowFn: () => (now += 1),
    ...(opts?.paidNotifier ? { paidEmailNotifier: opts.paidNotifier } : {}),
    ...(opts?.logger ? { logger: opts.logger } : {}),
  });
  await svc.create({
    order_id: 'ord_t',
    account_id: 'acc_a',
    product: 'api_starter_monthly',
    // price_amount in the IPN is fiat units (e.g. 99.0 USD); the order's
    // price_cents is 9900.
    price_cents: 9900,
    price_currency: 'USD',
  });
  return { svc, repo };
}

describe('crypto IPN amount reconciliation (#8)', () => {
  it('flips to PAID when actually_paid >= price_amount', async () => {
    const { svc } = await seed();
    const updated = await svc.applyIpnStatus({
      order_id: 'ord_t',
      payment_id: 'np_p',
      provider_status: 'finished',
      actually_paid: 99.0,
      price_amount: 99.0,
      pay_currency: 'btc',
    });
    expect(updated?.status).toBe('paid');
  });

  it('routes a SHORT-PAY (finished but actually_paid < price_amount) to PARTIAL, never paid', async () => {
    const paidNotifier = { notifyOrderPaid: vi.fn(() => Promise.resolve()) };
    const { svc } = await seed({ paidNotifier });
    const updated = await svc.applyIpnStatus({
      order_id: 'ord_t',
      payment_id: 'np_p',
      provider_status: 'finished',
      actually_paid: 50.0, // well under 99.0
      price_amount: 99.0,
      pay_currency: 'btc',
    });
    expect(updated?.status).toBe('partial');
    // The paid receipt/webhook side-effect must NOT fire for a short-pay.
    expect(paidNotifier.notifyOrderPaid).not.toHaveBeenCalled();
  });

  it('tolerates a tiny under-payment within the rounding tolerance (still paid)', async () => {
    const { svc } = await seed();
    // 99.0 * (1 - 0.005) = 98.505 — within the 1% tolerance.
    const updated = await svc.applyIpnStatus({
      order_id: 'ord_t',
      payment_id: 'np_p',
      provider_status: 'finished',
      actually_paid: 98.51,
      price_amount: 99.0,
    });
    expect(updated?.status).toBe('paid');
  });

  it('persists the reconciliation amounts on the transition event for support', async () => {
    const { svc } = await seed();
    const updated = await svc.applyIpnStatus({
      order_id: 'ord_t',
      payment_id: 'np_p',
      provider_status: 'partially_paid',
      actually_paid: 40.0,
      price_amount: 99.0,
      pay_currency: 'btc',
    });
    const partialEvent = updated?.events.find((e) => e.status === 'partial');
    expect(partialEvent?.actually_paid).toBe(40.0);
    expect(partialEvent?.price_amount).toBe(99.0);
    expect(partialEvent?.pay_currency).toBe('btc');
  });

  it('preserves the prior status-only behaviour when amounts are omitted (admin replay / legacy)', async () => {
    const { svc } = await seed();
    const updated = await svc.applyIpnStatus({
      order_id: 'ord_t',
      payment_id: 'np_p',
      provider_status: 'finished',
    });
    expect(updated?.status).toBe('paid');
  });
});

describe('crypto IPN payment_id binding (#9)', () => {
  it('recordPaymentId binds the minted payment_id to the order', async () => {
    const { svc, repo } = await seed();
    await svc.recordPaymentId({ order_id: 'ord_t', payment_id: 'np_minted_1' });
    const order = await repo.getById('ord_t');
    expect(order?.payment_id).toBe('np_minted_1');
  });

  it('recordPaymentId does NOT overwrite an already-bound payment_id', async () => {
    const { svc, repo } = await seed();
    await svc.recordPaymentId({ order_id: 'ord_t', payment_id: 'np_first' });
    await svc.recordPaymentId({ order_id: 'ord_t', payment_id: 'np_second' });
    expect((await repo.getById('ord_t'))?.payment_id).toBe('np_first');
  });

  it('applyIpnStatus REJECTS + alarms when the IPN payment_id does not match the bound one', async () => {
    const logger = { error: vi.fn() };
    const { svc, repo } = await seed({ logger });
    await svc.recordPaymentId({ order_id: 'ord_t', payment_id: 'np_correct' });

    const result = await svc.applyIpnStatus({
      order_id: 'ord_t',
      payment_id: 'np_WRONG',
      provider_status: 'finished',
      actually_paid: 99.0,
      price_amount: 99.0,
    });
    // The order is returned unchanged (still pending) — the mismatched IPN did
    // NOT drive it to paid.
    expect(result?.status).toBe('pending');
    expect((await repo.getById('ord_t'))?.status).toBe('pending');
    // The integrity alarm fired.
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]?.[1]).toMatch(/payment_id does not match/);
  });

  it('applyIpnStatus accepts an IPN whose payment_id matches the bound one', async () => {
    const { svc } = await seed();
    await svc.recordPaymentId({ order_id: 'ord_t', payment_id: 'np_correct' });
    const result = await svc.applyIpnStatus({
      order_id: 'ord_t',
      payment_id: 'np_correct',
      provider_status: 'finished',
      actually_paid: 99.0,
      price_amount: 99.0,
    });
    expect(result?.status).toBe('paid');
  });

  it('applyIpnStatus binds the payment_id on first IPN when the order had none (no recordPaymentId pre-step)', async () => {
    const { svc } = await seed();
    const result = await svc.applyIpnStatus({
      order_id: 'ord_t',
      payment_id: 'np_from_ipn',
      provider_status: 'confirming',
    });
    expect(result?.payment_id).toBe('np_from_ipn');
  });
});

describe('crypto-checkout DB-backed idempotency (#7)', () => {
  it('insertWithIdempotencyKey dedupes a duplicate scoped key (returns the existing order as a replay)', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const base = {
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'USD',
      payment_id: null,
      status: 'pending' as const,
      customer_note: null,
      internal_note: null,
      events: [{ status: 'pending' as const, at: 1, source: 'create' as const }],
      created_at: 1,
      updated_at: 1,
    };
    const first = await repo.insertWithIdempotencyKey({ ...base, order_id: 'ord_a' }, 'acc:key1');
    expect(first.replayed).toBe(false);
    // A SECOND insert with the SAME scoped key (e.g. a retry on another
    // instance that minted a different order_id) is deduped to the FIRST order.
    const second = await repo.insertWithIdempotencyKey({ ...base, order_id: 'ord_b' }, 'acc:key1');
    expect(second.replayed).toBe(true);
    expect(second.order.order_id).toBe('ord_a');
    // Only ONE order exists.
    expect(await repo.getById('ord_b')).toBeNull();
  });

  it('createIdempotent surfaces a cross-instance/persistent duplicate as a replay', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    let now = 1_000;
    const svc = new CryptoOrdersService({ repo, nowFn: () => (now += 1) });
    const r1 = await svc.createIdempotent({
      idempotency_key: 'kx',
      order_id: 'ord_1',
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'USD',
    });
    expect(r1.replayed).toBe(false);
    // Simulate a retry that reaches a fresh process (clear the in-memory cache
    // by constructing a NEW service over the SAME repo) — the DB-backed key
    // still dedupes it.
    const svc2 = new CryptoOrdersService({ repo, nowFn: () => (now += 1) });
    const r2 = await svc2.createIdempotent({
      idempotency_key: 'kx',
      order_id: 'ord_2',
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'USD',
    });
    expect(r2.replayed).toBe(true);
    expect(r2.order.order_id).toBe('ord_1');
  });
});
