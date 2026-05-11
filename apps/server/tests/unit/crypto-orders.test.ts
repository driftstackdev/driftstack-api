// V-666.B — unit tests for the crypto-orders state machine.
// V-666.I — appended tests for crypto.order.paid webhook emission.
// V-666.J — appended tests for cancelOrder + late-IPN-after-cancel.

import { describe, expect, it } from 'vitest';
import {
  CryptoOrdersService,
  type CryptoOrderWebhookEmitter,
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

describe('V-666.I crypto.order.paid webhook emission', () => {
  function makeEmitter(): {
    emitter: CryptoOrderWebhookEmitter;
    calls: Array<{ accountId: string; eventType: string; data: Record<string, unknown> }>;
  } {
    const calls: Array<{ accountId: string; eventType: string; data: Record<string, unknown> }> =
      [];
    const emitter: CryptoOrderWebhookEmitter = {
      enqueueEvent: (accountId, eventType, data) => {
        calls.push({ accountId, eventType, data });
        return Promise.resolve(1);
      },
    };
    return { emitter, calls };
  }

  async function seed(
    opts: {
      emitter?: CryptoOrderWebhookEmitter;
      account_id?: string | null;
    } = {},
  ): Promise<{ svc: CryptoOrdersService }> {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({
      repo,
      nowFn: () => 2_000,
      ...(opts.emitter !== undefined ? { webhooks: opts.emitter } : {}),
    });
    await svc.create({
      order_id: 'ord_pay',
      account_id: opts.account_id === undefined ? 'acc_buyer' : opts.account_id,
      product: 'team_growth',
      price_cents: 14900,
      price_currency: 'EUR',
    });
    return { svc };
  }

  it('fires crypto.order.paid when transitioning pending → paid', async () => {
    const { emitter, calls } = makeEmitter();
    const { svc } = await seed({ emitter });
    await svc.applyIpnStatus({
      order_id: 'ord_pay',
      payment_id: 'np_42',
      provider_status: 'finished',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.eventType).toBe('crypto.order.paid');
    expect(calls[0]?.accountId).toBe('acc_buyer');
    expect(calls[0]?.data.order_id).toBe('ord_pay');
    expect(calls[0]?.data.product).toBe('team_growth');
    expect(calls[0]?.data.price_cents).toBe(14900);
    expect(calls[0]?.data.payment_id).toBe('np_42');
  });

  it('fires crypto.order.paid when transitioning confirming → paid', async () => {
    const { emitter, calls } = makeEmitter();
    const { svc } = await seed({ emitter });
    await svc.applyIpnStatus({
      order_id: 'ord_pay',
      payment_id: 'np_step',
      provider_status: 'confirming',
    });
    expect(calls).toHaveLength(0);
    await svc.applyIpnStatus({
      order_id: 'ord_pay',
      payment_id: 'np_step',
      provider_status: 'finished',
    });
    expect(calls).toHaveLength(1);
  });

  it('does NOT re-fire on a duplicate paid IPN (idempotent)', async () => {
    const { emitter, calls } = makeEmitter();
    const { svc } = await seed({ emitter });
    await svc.applyIpnStatus({
      order_id: 'ord_pay',
      payment_id: 'np_1',
      provider_status: 'finished',
    });
    await svc.applyIpnStatus({
      order_id: 'ord_pay',
      payment_id: 'np_1',
      provider_status: 'finished',
    });
    expect(calls).toHaveLength(1);
  });

  it('does NOT fire when transitioning to failed (not a paid event)', async () => {
    const { emitter, calls } = makeEmitter();
    const { svc } = await seed({ emitter });
    await svc.applyIpnStatus({
      order_id: 'ord_pay',
      payment_id: 'np_x',
      provider_status: 'failed',
    });
    expect(calls).toHaveLength(0);
  });

  it('does NOT fire when the order has a null account_id (pre-signup checkout)', async () => {
    const { emitter, calls } = makeEmitter();
    const { svc } = await seed({ emitter, account_id: null });
    await svc.applyIpnStatus({
      order_id: 'ord_pay',
      payment_id: 'np_y',
      provider_status: 'finished',
    });
    expect(calls).toHaveLength(0);
  });

  it('swallows emitter errors so the order stays paid', async () => {
    const failing: CryptoOrderWebhookEmitter = {
      enqueueEvent: () => Promise.reject(new Error('boom')),
    };
    const { svc } = await seed({ emitter: failing });
    const updated = await svc.applyIpnStatus({
      order_id: 'ord_pay',
      payment_id: 'np_z',
      provider_status: 'finished',
    });
    expect(updated?.status).toBe('paid');
  });

  it('does not throw when no emitter is wired', async () => {
    const { svc } = await seed();
    const updated = await svc.applyIpnStatus({
      order_id: 'ord_pay',
      payment_id: 'np_silent',
      provider_status: 'finished',
    });
    expect(updated?.status).toBe('paid');
  });
});

describe('V-666.J cancelOrder', () => {
  async function seedCxl(
    opts: {
      status?: 'pending' | 'confirming' | 'paid' | 'failed' | 'partial';
      account_id?: string | null;
    } = {},
  ): Promise<{ svc: CryptoOrdersService }> {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo, nowFn: () => 3_000 });
    await svc.create({
      order_id: 'ord_cxl',
      account_id: opts.account_id === undefined ? 'acc_owner' : opts.account_id,
      product: 'solo_manual',
      price_cents: 2500,
      price_currency: 'EUR',
    });
    if (opts.status !== undefined && opts.status !== 'pending') {
      const providerByStatus: Record<string, string> = {
        confirming: 'confirming',
        paid: 'finished',
        failed: 'expired',
        partial: 'partially_paid',
      };
      await svc.applyIpnStatus({
        order_id: 'ord_cxl',
        payment_id: 'np_seed',
        provider_status: providerByStatus[opts.status] ?? 'waiting',
      });
    }
    return { svc };
  }

  it('returns null when the order does not exist', async () => {
    const { svc } = await seedCxl();
    const r = await svc.cancelOrder({ order_id: 'ord_missing', account_id: 'acc_owner' });
    expect(r).toBeNull();
  });

  it('returns null (not 403) for cross-account cancel', async () => {
    const { svc } = await seedCxl();
    const r = await svc.cancelOrder({ order_id: 'ord_cxl', account_id: 'acc_other' });
    expect(r).toBeNull();
  });

  it('cancels a pending order + flips status to cancelled', async () => {
    const { svc } = await seedCxl();
    const r = await svc.cancelOrder({ order_id: 'ord_cxl', account_id: 'acc_owner' });
    expect(r?.ok).toBe('cancelled');
    if (r?.ok === 'cancelled') {
      expect(r.order.status).toBe('cancelled');
    }
    const fetched = await svc.getById('ord_cxl');
    expect(fetched?.status).toBe('cancelled');
  });

  it('returns not_cancellable with the order status when already confirming', async () => {
    const { svc } = await seedCxl({ status: 'confirming' });
    const r = await svc.cancelOrder({ order_id: 'ord_cxl', account_id: 'acc_owner' });
    expect(r?.ok).toBe('not_cancellable');
    if (r?.ok === 'not_cancellable') {
      expect(r.reason).toBe('confirming');
    }
  });

  it('returns not_cancellable when already paid', async () => {
    const { svc } = await seedCxl({ status: 'paid' });
    const r = await svc.cancelOrder({ order_id: 'ord_cxl', account_id: 'acc_owner' });
    expect(r?.ok).toBe('not_cancellable');
  });

  it('a late-arriving IPN payment does NOT revive a cancelled order (terminal)', async () => {
    const { svc } = await seedCxl();
    await svc.cancelOrder({ order_id: 'ord_cxl', account_id: 'acc_owner' });
    const after = await svc.applyIpnStatus({
      order_id: 'ord_cxl',
      payment_id: 'np_late',
      provider_status: 'finished',
    });
    // Status stays cancelled; payment_id is recorded so support can
    // reconcile the on-chain funds.
    expect(after?.status).toBe('cancelled');
    expect(after?.payment_id).toBe('np_late');
  });
});
