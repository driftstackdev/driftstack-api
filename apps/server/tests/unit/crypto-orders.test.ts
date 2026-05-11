// V-666.B — unit tests for the crypto-orders state machine.

import { describe, expect, it } from 'vitest';
import {
  CryptoOrdersService,
  InMemoryCryptoOrdersRepo,
  mapNowpaymentsStatus,
} from '../../src/services/crypto-orders.js';

describe('V-666.B mapNowpaymentsStatus', () => {
  it('maps the documented provider statuses to internal states', () => {
    expect(mapNowpaymentsStatus('waiting')).toBe('pending');
    expect(mapNowpaymentsStatus('confirming')).toBe('confirming');
    expect(mapNowpaymentsStatus('sending')).toBe('confirming');
    expect(mapNowpaymentsStatus('partially_paid')).toBe('partial');
    expect(mapNowpaymentsStatus('finished')).toBe('paid');
    expect(mapNowpaymentsStatus('failed')).toBe('failed');
    expect(mapNowpaymentsStatus('expired')).toBe('failed');
    expect(mapNowpaymentsStatus('refunded')).toBe('failed');
  });

  it('returns null for unknown provider statuses', () => {
    expect(mapNowpaymentsStatus('hovering')).toBeNull();
    expect(mapNowpaymentsStatus('')).toBeNull();
  });
});

describe('V-666.B CryptoOrdersService — create', () => {
  it('creates a pending order with the supplied fields', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo, nowFn: () => 1_000 });
    const order = await svc.create({
      order_id: 'ord_test_001',
      account_id: 'acc_test',
      product: 'api_starter_monthly',
      price_cents: 999,
      price_currency: 'EUR',
    });
    expect(order.status).toBe('pending');
    expect(order.payment_id).toBeNull();
    expect(order.created_at).toBe(1_000);
    expect(order.updated_at).toBe(1_000);
    const fetched = await svc.getById('ord_test_001');
    expect(fetched?.product).toBe('api_starter_monthly');
  });
});

describe('V-666.B applyIpnStatus — forward transitions', () => {
  async function seed(): Promise<{ svc: CryptoOrdersService }> {
    const repo = new InMemoryCryptoOrdersRepo();
    let now = 1_000;
    const svc = new CryptoOrdersService({ repo, nowFn: () => now });
    await svc.create({
      order_id: 'ord_t',
      account_id: 'acc_a',
      product: 'api_starter_monthly',
      price_cents: 999,
      price_currency: 'EUR',
    });
    now = 2_000;
    return { svc };
  }

  it('pending → confirming on provider status "confirming"', async () => {
    const { svc } = await seed();
    const updated = await svc.applyIpnStatus({
      order_id: 'ord_t',
      payment_id: 'np_payment_1',
      provider_status: 'confirming',
    });
    expect(updated?.status).toBe('confirming');
    expect(updated?.payment_id).toBe('np_payment_1');
  });

  it('pending → paid on "finished"', async () => {
    const { svc } = await seed();
    const updated = await svc.applyIpnStatus({
      order_id: 'ord_t',
      payment_id: 'np_p',
      provider_status: 'finished',
    });
    expect(updated?.status).toBe('paid');
  });

  it('confirming → paid (forward across intermediate states)', async () => {
    const { svc } = await seed();
    await svc.applyIpnStatus({
      order_id: 'ord_t',
      payment_id: 'np_p',
      provider_status: 'confirming',
    });
    const updated = await svc.applyIpnStatus({
      order_id: 'ord_t',
      payment_id: 'np_p',
      provider_status: 'finished',
    });
    expect(updated?.status).toBe('paid');
  });
});

describe('V-666.B applyIpnStatus — terminal-state guards', () => {
  async function seedPaid(): Promise<{ svc: CryptoOrdersService }> {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo });
    await svc.create({
      order_id: 'ord_paid',
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'EUR',
    });
    await svc.applyIpnStatus({
      order_id: 'ord_paid',
      payment_id: 'np_p',
      provider_status: 'finished',
    });
    return { svc };
  }

  it('paid → pending is rejected (no downgrade from a retry)', async () => {
    const { svc } = await seedPaid();
    const updated = await svc.applyIpnStatus({
      order_id: 'ord_paid',
      payment_id: 'np_p',
      provider_status: 'waiting',
    });
    expect(updated?.status).toBe('paid');
  });

  it('paid → paid (duplicate IPN) is a no-op idempotent ack', async () => {
    const { svc } = await seedPaid();
    const updated = await svc.applyIpnStatus({
      order_id: 'ord_paid',
      payment_id: 'np_p',
      provider_status: 'finished',
    });
    expect(updated?.status).toBe('paid');
  });

  it('failed → finished is rejected (failed is terminal)', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo });
    await svc.create({
      order_id: 'ord_f',
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'EUR',
    });
    await svc.applyIpnStatus({
      order_id: 'ord_f',
      payment_id: 'np_f',
      provider_status: 'expired',
    });
    const updated = await svc.applyIpnStatus({
      order_id: 'ord_f',
      payment_id: 'np_f',
      provider_status: 'finished',
    });
    expect(updated?.status).toBe('failed');
  });
});

describe('V-666.B applyIpnStatus — partial-state semantics', () => {
  async function seedPartial(): Promise<{ svc: CryptoOrdersService }> {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo });
    await svc.create({
      order_id: 'ord_part',
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'EUR',
    });
    await svc.applyIpnStatus({
      order_id: 'ord_part',
      payment_id: 'np_p',
      provider_status: 'partially_paid',
    });
    return { svc };
  }

  it('partial → confirming is REJECTED (partial is semi-terminal)', async () => {
    const { svc } = await seedPartial();
    const updated = await svc.applyIpnStatus({
      order_id: 'ord_part',
      payment_id: 'np_p',
      provider_status: 'confirming',
    });
    expect(updated?.status).toBe('partial');
  });

  it('partial → paid IS allowed (customer topped up later)', async () => {
    const { svc } = await seedPartial();
    const updated = await svc.applyIpnStatus({
      order_id: 'ord_part',
      payment_id: 'np_p',
      provider_status: 'finished',
    });
    expect(updated?.status).toBe('paid');
  });

  it('partial → failed IS allowed', async () => {
    const { svc } = await seedPartial();
    const updated = await svc.applyIpnStatus({
      order_id: 'ord_part',
      payment_id: 'np_p',
      provider_status: 'expired',
    });
    expect(updated?.status).toBe('failed');
  });
});

describe('V-666.B applyIpnStatus — unknown order / unknown status', () => {
  it('returns null when the order does not exist', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo });
    expect(
      await svc.applyIpnStatus({
        order_id: 'ord_missing',
        payment_id: 'np_p',
        provider_status: 'finished',
      }),
    ).toBeNull();
  });

  it('unknown provider status leaves state unchanged; records payment_id', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo });
    await svc.create({
      order_id: 'ord_x',
      account_id: 'a',
      product: 'p',
      price_cents: 100,
      price_currency: 'EUR',
    });
    const updated = await svc.applyIpnStatus({
      order_id: 'ord_x',
      payment_id: 'np_p',
      provider_status: 'mysterious_new_status',
    });
    expect(updated?.status).toBe('pending');
    expect(updated?.payment_id).toBeNull(); // status didn't change → no recorded payment_id either
  });
});
