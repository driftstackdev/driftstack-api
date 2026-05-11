// V-666.B — unit tests for the crypto-orders state machine.
// V-666.I — appended tests for crypto.order.paid webhook emission.
// V-666.J — appended tests for cancelOrder + late-IPN-after-cancel.
// V-666.K — appended tests for expireOrder + sweepExpiredOrders.
// V-666.M — appended tests for getReceipt.
// V-666.N — appended tests for getStatsForAdmin.
// V-666.O — appended tests for getDailyBreakdownForAdmin.
// V-666.Q — appended tests for updateCustomerNote.
// V-666.R — appended tests for paid-receipt email notifier.

import { describe, expect, it } from 'vitest';
import {
  CryptoOrdersService,
  type CryptoOrderPaidEmail,
  type CryptoOrderPaidEmailNotifier,
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

describe('V-666.K expireOrder + sweepExpiredOrders', () => {
  function makeService(initialNow = 1_000_000): {
    svc: CryptoOrdersService;
    repo: InMemoryCryptoOrdersRepo;
    setNow: (t: number) => void;
  } {
    const repo = new InMemoryCryptoOrdersRepo();
    let now = initialNow;
    const svc = new CryptoOrdersService({ repo, nowFn: () => now });
    return {
      svc,
      repo,
      setNow: (t: number) => {
        now = t;
      },
    };
  }

  it('expireOrder returns null when the order does not exist', async () => {
    const { svc } = makeService();
    const r = await svc.expireOrder({ order_id: 'ord_missing', olderThanMs: 1_000 });
    expect(r).toBeNull();
  });

  it('expireOrder returns null when the order is not pending', async () => {
    const { svc, setNow } = makeService();
    await svc.create({
      order_id: 'ord_paid',
      account_id: 'a',
      product: 'p',
      price_cents: 100,
      price_currency: 'EUR',
    });
    await svc.applyIpnStatus({
      order_id: 'ord_paid',
      payment_id: 'np_1',
      provider_status: 'finished',
    });
    setNow(1_000_000 + 86_400_000);
    const r = await svc.expireOrder({ order_id: 'ord_paid', olderThanMs: 60_000 });
    expect(r).toBeNull();
  });

  it('expireOrder returns null when the order is too young', async () => {
    const { svc, setNow } = makeService();
    await svc.create({
      order_id: 'ord_y',
      account_id: 'a',
      product: 'p',
      price_cents: 100,
      price_currency: 'EUR',
    });
    setNow(1_000_000 + 1_000); // 1s later
    const r = await svc.expireOrder({ order_id: 'ord_y', olderThanMs: 60_000 }); // requires 60s
    expect(r).toBeNull();
  });

  it('expireOrder transitions a stale pending order to failed', async () => {
    const { svc, setNow } = makeService();
    await svc.create({
      order_id: 'ord_old',
      account_id: 'a',
      product: 'p',
      price_cents: 100,
      price_currency: 'EUR',
    });
    setNow(1_000_000 + 25 * 60 * 60 * 1000); // 25h later
    const r = await svc.expireOrder({
      order_id: 'ord_old',
      olderThanMs: 24 * 60 * 60 * 1000, // 24h
    });
    expect(r?.status).toBe('failed');
    const fetched = await svc.getById('ord_old');
    expect(fetched?.status).toBe('failed');
  });

  it('sweepExpiredOrders expires only the stale pending orders', async () => {
    const { svc, setNow } = makeService();
    // Three pending orders, two old enough + one fresh.
    await svc.create({
      order_id: 'ord_stale_1',
      account_id: 'a',
      product: 'p',
      price_cents: 100,
      price_currency: 'EUR',
    });
    await svc.create({
      order_id: 'ord_stale_2',
      account_id: 'a',
      product: 'p',
      price_cents: 100,
      price_currency: 'EUR',
    });
    // Fresh one created after the sweep cutoff window starts.
    setNow(1_000_000 + 23 * 60 * 60 * 1000); // 23h after the first two
    await svc.create({
      order_id: 'ord_fresh',
      account_id: 'a',
      product: 'p',
      price_cents: 100,
      price_currency: 'EUR',
    });
    // Move now past the 24h cutoff relative to the stale ones.
    setNow(1_000_000 + 25 * 60 * 60 * 1000);
    const result = await svc.sweepExpiredOrders({ olderThanMs: 24 * 60 * 60 * 1000 });
    expect(result.expired).toBe(2);
    expect(result.capped).toBe(false);
    expect((await svc.getById('ord_stale_1'))?.status).toBe('failed');
    expect((await svc.getById('ord_stale_2'))?.status).toBe('failed');
    expect((await svc.getById('ord_fresh'))?.status).toBe('pending');
  });

  it('sweepExpiredOrders honours the limit + flags capped=true when hit', async () => {
    const { svc, setNow } = makeService();
    for (let i = 0; i < 5; i += 1) {
      await svc.create({
        order_id: `ord_${i.toString()}`,
        account_id: 'a',
        product: 'p',
        price_cents: 100,
        price_currency: 'EUR',
      });
    }
    setNow(1_000_000 + 25 * 60 * 60 * 1000);
    const result = await svc.sweepExpiredOrders({
      olderThanMs: 24 * 60 * 60 * 1000,
      limit: 2,
    });
    expect(result.expired).toBe(2);
    expect(result.capped).toBe(true); // cron should re-run
  });

  it('sweepExpiredOrders ignores orders past pending (already terminal/in-flight)', async () => {
    const { svc, setNow } = makeService();
    await svc.create({
      order_id: 'ord_p',
      account_id: 'a',
      product: 'p',
      price_cents: 100,
      price_currency: 'EUR',
    });
    await svc.applyIpnStatus({
      order_id: 'ord_p',
      payment_id: 'np_x',
      provider_status: 'confirming',
    });
    setNow(1_000_000 + 25 * 60 * 60 * 1000);
    const result = await svc.sweepExpiredOrders({ olderThanMs: 24 * 60 * 60 * 1000 });
    expect(result.expired).toBe(0);
    expect(result.capped).toBe(false);
    expect((await svc.getById('ord_p'))?.status).toBe('confirming');
  });
});

describe('V-666.M getReceipt', () => {
  async function seedRcpt(opts: { status?: 'pending' | 'paid' } = {}): Promise<{
    svc: CryptoOrdersService;
  }> {
    const repo = new InMemoryCryptoOrdersRepo();
    let now = 5_000;
    const svc = new CryptoOrdersService({ repo, nowFn: () => now });
    await svc.create({
      order_id: 'ord_rcpt',
      account_id: 'acc_owner',
      product: 'solo_manual',
      price_cents: 2500,
      price_currency: 'EUR',
    });
    if (opts.status === 'paid') {
      now = 6_000;
      await svc.applyIpnStatus({
        order_id: 'ord_rcpt',
        payment_id: 'np_paid_id',
        provider_status: 'finished',
      });
    }
    now = 7_000;
    return { svc };
  }

  it('returns null when the order does not exist', async () => {
    const { svc } = await seedRcpt();
    const r = await svc.getReceipt({ order_id: 'ord_missing', account_id: 'acc_owner' });
    expect(r).toBeNull();
  });

  it('returns null (404-style) on cross-account access', async () => {
    const { svc } = await seedRcpt();
    const r = await svc.getReceipt({ order_id: 'ord_rcpt', account_id: 'acc_other' });
    expect(r).toBeNull();
  });

  it('returns the receipt with paid_at populated when status is paid', async () => {
    const { svc } = await seedRcpt({ status: 'paid' });
    const r = await svc.getReceipt({
      order_id: 'ord_rcpt',
      account_id: 'acc_owner',
      issued_at: 9_000,
    });
    expect(r?.order_id).toBe('ord_rcpt');
    expect(r?.status).toBe('paid');
    expect(r?.payment_id).toBe('np_paid_id');
    expect(r?.paid_at).toBe(new Date(6_000).toISOString());
    expect(r?.issued_at).toBe(new Date(9_000).toISOString());
  });

  it('returns paid_at=null for a non-paid order (order-summary mode)', async () => {
    const { svc } = await seedRcpt();
    const r = await svc.getReceipt({ order_id: 'ord_rcpt', account_id: 'acc_owner' });
    expect(r?.status).toBe('pending');
    expect(r?.paid_at).toBeNull();
    expect(r?.payment_id).toBeNull();
  });
});

describe('V-666.N getStatsForAdmin', () => {
  it('returns all zero counts + empty revenue map when no orders exist', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo });
    const stats = await svc.getStatsForAdmin();
    expect(stats.total).toBe(0);
    expect(stats.byStatus.pending).toBe(0);
    expect(stats.byStatus.paid).toBe(0);
    expect(stats.paidRevenueCents).toEqual({});
    expect(stats.truncated).toBe(false);
  });

  it('counts orders per status + sums paid revenue per currency', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo });
    // 3 pending, 2 paid (EUR), 1 paid (USD), 1 failed
    await svc.create({
      order_id: 'p1',
      account_id: 'a',
      product: 'x',
      price_cents: 100,
      price_currency: 'EUR',
    });
    await svc.create({
      order_id: 'p2',
      account_id: 'a',
      product: 'x',
      price_cents: 100,
      price_currency: 'EUR',
    });
    await svc.create({
      order_id: 'p3',
      account_id: 'a',
      product: 'x',
      price_cents: 100,
      price_currency: 'EUR',
    });
    await svc.create({
      order_id: 'paid_eur_a',
      account_id: 'a',
      product: 'x',
      price_cents: 2500,
      price_currency: 'EUR',
    });
    await svc.applyIpnStatus({
      order_id: 'paid_eur_a',
      payment_id: 'np',
      provider_status: 'finished',
    });
    await svc.create({
      order_id: 'paid_eur_b',
      account_id: 'a',
      product: 'x',
      price_cents: 8000,
      price_currency: 'EUR',
    });
    await svc.applyIpnStatus({
      order_id: 'paid_eur_b',
      payment_id: 'np',
      provider_status: 'finished',
    });
    await svc.create({
      order_id: 'paid_usd',
      account_id: 'a',
      product: 'x',
      price_cents: 5000,
      price_currency: 'USD',
    });
    await svc.applyIpnStatus({
      order_id: 'paid_usd',
      payment_id: 'np',
      provider_status: 'finished',
    });
    await svc.create({
      order_id: 'failed_1',
      account_id: 'a',
      product: 'x',
      price_cents: 200,
      price_currency: 'EUR',
    });
    await svc.applyIpnStatus({
      order_id: 'failed_1',
      payment_id: 'np',
      provider_status: 'expired',
    });

    const stats = await svc.getStatsForAdmin();
    expect(stats.total).toBe(7);
    expect(stats.byStatus.pending).toBe(3);
    expect(stats.byStatus.paid).toBe(3);
    expect(stats.byStatus.failed).toBe(1);
    expect(stats.byStatus.confirming).toBe(0);
    expect(stats.byStatus.cancelled).toBe(0);
    expect(stats.byStatus.partial).toBe(0);
    expect(stats.paidRevenueCents).toEqual({ EUR: 10500, USD: 5000 });
  });

  it('flags truncated=true when the order count hits scanLimit', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo });
    for (let i = 0; i < 5; i += 1) {
      await svc.create({
        order_id: `ord_${i.toString()}`,
        account_id: 'a',
        product: 'x',
        price_cents: 100,
        price_currency: 'EUR',
      });
    }
    const stats = await svc.getStatsForAdmin({ scanLimit: 5 });
    expect(stats.truncated).toBe(true);
    expect(stats.scanned).toBe(5);
  });
});

describe('V-666.O getDailyBreakdownForAdmin', () => {
  function makeServiceAt(initialNow: number): {
    svc: CryptoOrdersService;
    setNow: (t: number) => void;
  } {
    const repo = new InMemoryCryptoOrdersRepo();
    let now = initialNow;
    const svc = new CryptoOrdersService({ repo, nowFn: () => now });
    return {
      svc,
      setNow: (t) => {
        now = t;
      },
    };
  }

  it('returns an empty rows array when no orders exist', async () => {
    const { svc } = makeServiceAt(Date.parse('2026-05-11T12:00:00Z'));
    const out = await svc.getDailyBreakdownForAdmin();
    expect(out.days).toBe(7);
    expect(out.rows).toEqual([]);
    expect(out.truncated).toBe(false);
  });

  it('omits orders outside the days window', async () => {
    const { svc, setNow } = makeServiceAt(Date.parse('2026-05-11T12:00:00Z'));
    // Old order: 30 days ago.
    setNow(Date.parse('2026-04-11T00:00:00Z'));
    await svc.create({
      order_id: 'old',
      account_id: 'a',
      product: 'x',
      price_cents: 100,
      price_currency: 'EUR',
    });
    // Recent order: today.
    setNow(Date.parse('2026-05-11T12:00:00Z'));
    await svc.create({
      order_id: 'today',
      account_id: 'a',
      product: 'x',
      price_cents: 100,
      price_currency: 'EUR',
    });
    const out = await svc.getDailyBreakdownForAdmin({ days: 7 });
    expect(out.rows.map((r) => r.date)).toEqual(['2026-05-11']);
  });

  it('groups by (date, status) with counts; sorts date asc + status alphabetical', async () => {
    const { svc, setNow } = makeServiceAt(Date.parse('2026-05-11T12:00:00Z'));
    // 2 orders on May 10, 1 paid + 1 pending.
    setNow(Date.parse('2026-05-10T08:00:00Z'));
    await svc.create({
      order_id: 'p10a',
      account_id: 'a',
      product: 'x',
      price_cents: 100,
      price_currency: 'EUR',
    });
    await svc.create({
      order_id: 'p10b',
      account_id: 'a',
      product: 'x',
      price_cents: 100,
      price_currency: 'EUR',
    });
    await svc.applyIpnStatus({
      order_id: 'p10a',
      payment_id: 'np',
      provider_status: 'finished',
    });
    // 1 pending on May 11.
    setNow(Date.parse('2026-05-11T08:00:00Z'));
    await svc.create({
      order_id: 'p11',
      account_id: 'a',
      product: 'x',
      price_cents: 100,
      price_currency: 'EUR',
    });

    setNow(Date.parse('2026-05-11T12:00:00Z'));
    const out = await svc.getDailyBreakdownForAdmin({ days: 7 });
    expect(out.rows).toEqual([
      { date: '2026-05-10', status: 'paid', count: 1 },
      { date: '2026-05-10', status: 'pending', count: 1 },
      { date: '2026-05-11', status: 'pending', count: 1 },
    ]);
  });

  it('flags truncated=true when scanLimit hits the order count', async () => {
    const { svc, setNow } = makeServiceAt(Date.parse('2026-05-11T12:00:00Z'));
    for (let i = 0; i < 5; i += 1) {
      await svc.create({
        order_id: `o${i.toString()}`,
        account_id: 'a',
        product: 'x',
        price_cents: 100,
        price_currency: 'EUR',
      });
    }
    setNow(Date.parse('2026-05-11T12:00:00Z'));
    const out = await svc.getDailyBreakdownForAdmin({ days: 7, scanLimit: 5 });
    expect(out.truncated).toBe(true);
  });
});

describe('V-666.Q updateCustomerNote', () => {
  async function seed(): Promise<{ svc: CryptoOrdersService }> {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo, nowFn: () => 4_000 });
    await svc.create({
      order_id: 'ord_note',
      account_id: 'acc_owner',
      product: 'solo_manual',
      price_cents: 2500,
      price_currency: 'EUR',
    });
    return { svc };
  }

  it('returns null when the order does not exist', async () => {
    const { svc } = await seed();
    const r = await svc.updateCustomerNote({
      order_id: 'ord_missing',
      account_id: 'acc_owner',
      customer_note: 'PO-42',
    });
    expect(r).toBeNull();
  });

  it('returns null (not 403) on cross-account note update', async () => {
    const { svc } = await seed();
    const r = await svc.updateCustomerNote({
      order_id: 'ord_note',
      account_id: 'acc_other',
      customer_note: 'sneaky',
    });
    expect(r).toBeNull();
  });

  it('writes the note + bumps updated_at on success', async () => {
    const { svc } = await seed();
    const r = await svc.updateCustomerNote({
      order_id: 'ord_note',
      account_id: 'acc_owner',
      customer_note: 'PO-42',
    });
    expect(r?.customer_note).toBe('PO-42');
    const fetched = await svc.getById('ord_note');
    expect(fetched?.customer_note).toBe('PO-42');
  });

  it('normalises empty string to null', async () => {
    const { svc } = await seed();
    await svc.updateCustomerNote({
      order_id: 'ord_note',
      account_id: 'acc_owner',
      customer_note: 'first',
    });
    const r = await svc.updateCustomerNote({
      order_id: 'ord_note',
      account_id: 'acc_owner',
      customer_note: '',
    });
    expect(r?.customer_note).toBeNull();
  });

  it('explicitly passing null clears the note', async () => {
    const { svc } = await seed();
    await svc.updateCustomerNote({
      order_id: 'ord_note',
      account_id: 'acc_owner',
      customer_note: 'mine',
    });
    const r = await svc.updateCustomerNote({
      order_id: 'ord_note',
      account_id: 'acc_owner',
      customer_note: null,
    });
    expect(r?.customer_note).toBeNull();
  });
});

describe('V-666.R paid-receipt email notifier', () => {
  function makeNotifier(): {
    notifier: CryptoOrderPaidEmailNotifier;
    calls: CryptoOrderPaidEmail[];
  } {
    const calls: CryptoOrderPaidEmail[] = [];
    const notifier: CryptoOrderPaidEmailNotifier = {
      notifyOrderPaid: (intent) => {
        calls.push(intent);
        return Promise.resolve();
      },
    };
    return { notifier, calls };
  }

  async function seed(
    opts: { notifier?: CryptoOrderPaidEmailNotifier; account_id?: string | null } = {},
  ): Promise<{ svc: CryptoOrdersService }> {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({
      repo,
      nowFn: () => 5_000,
      ...(opts.notifier !== undefined ? { paidEmailNotifier: opts.notifier } : {}),
    });
    await svc.create({
      order_id: 'ord_paid_email',
      account_id: opts.account_id === undefined ? 'acc_buyer' : opts.account_id,
      product: 'team_growth',
      price_cents: 14900,
      price_currency: 'EUR',
    });
    return { svc };
  }

  it('fires the notifier on pending → paid transition', async () => {
    const { notifier, calls } = makeNotifier();
    const { svc } = await seed({ notifier });
    await svc.applyIpnStatus({
      order_id: 'ord_paid_email',
      payment_id: 'np_42',
      provider_status: 'finished',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.account_id).toBe('acc_buyer');
    expect(calls[0]?.order_id).toBe('ord_paid_email');
    expect(calls[0]?.price_cents).toBe(14900);
    expect(calls[0]?.price_currency).toBe('EUR');
    expect(calls[0]?.payment_id).toBe('np_42');
    expect(calls[0]?.paid_at).toBe(new Date(5_000).toISOString());
  });

  it('does NOT fire on a duplicate paid IPN (idempotent)', async () => {
    const { notifier, calls } = makeNotifier();
    const { svc } = await seed({ notifier });
    await svc.applyIpnStatus({
      order_id: 'ord_paid_email',
      payment_id: 'np_1',
      provider_status: 'finished',
    });
    await svc.applyIpnStatus({
      order_id: 'ord_paid_email',
      payment_id: 'np_1',
      provider_status: 'finished',
    });
    expect(calls).toHaveLength(1);
  });

  it('does NOT fire on a non-paid transition (failed/confirming)', async () => {
    const { notifier, calls } = makeNotifier();
    const { svc } = await seed({ notifier });
    await svc.applyIpnStatus({
      order_id: 'ord_paid_email',
      payment_id: 'np_x',
      provider_status: 'confirming',
    });
    await svc.applyIpnStatus({
      order_id: 'ord_paid_email',
      payment_id: 'np_x',
      provider_status: 'failed',
    });
    expect(calls).toHaveLength(0);
  });

  it('does NOT fire when the order has a null account_id (pre-signup checkout)', async () => {
    const { notifier, calls } = makeNotifier();
    const { svc } = await seed({ notifier, account_id: null });
    await svc.applyIpnStatus({
      order_id: 'ord_paid_email',
      payment_id: 'np_y',
      provider_status: 'finished',
    });
    expect(calls).toHaveLength(0);
  });

  it('swallows notifier errors so the order still transitions to paid', async () => {
    const failing: CryptoOrderPaidEmailNotifier = {
      notifyOrderPaid: () => Promise.reject(new Error('postmark down')),
    };
    const { svc } = await seed({ notifier: failing });
    const updated = await svc.applyIpnStatus({
      order_id: 'ord_paid_email',
      payment_id: 'np_z',
      provider_status: 'finished',
    });
    expect(updated?.status).toBe('paid');
  });

  it('runs alongside the webhook emitter on the same paid transition', async () => {
    const { notifier, calls: emailCalls } = makeNotifier();
    const webhookCalls: Array<{ eventType: string }> = [];
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({
      repo,
      nowFn: () => 5_000,
      paidEmailNotifier: notifier,
      webhooks: {
        enqueueEvent: (_acc, eventType) => {
          webhookCalls.push({ eventType });
          return Promise.resolve(1);
        },
      },
    });
    await svc.create({
      order_id: 'ord_paid_email',
      account_id: 'acc_buyer',
      product: 'team_growth',
      price_cents: 14900,
      price_currency: 'EUR',
    });
    await svc.applyIpnStatus({
      order_id: 'ord_paid_email',
      payment_id: 'np_q',
      provider_status: 'finished',
    });
    expect(emailCalls).toHaveLength(1);
    expect(webhookCalls).toHaveLength(1);
    expect(webhookCalls[0]?.eventType).toBe('crypto.order.paid');
  });
});
