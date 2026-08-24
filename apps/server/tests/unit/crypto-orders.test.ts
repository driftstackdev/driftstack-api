// V-666.B — unit tests for the crypto-orders state machine.
// V-666.I — appended tests for crypto.order.paid webhook emission.
// V-666.J — appended tests for cancelOrder + late-IPN-after-cancel.
// V-666.K — appended tests for expireOrder + sweepExpiredOrders.
// V-666.M — appended tests for getReceipt.
// V-666.N — appended tests for getStatsForAdmin.
// V-666.O — appended tests for getDailyBreakdownForAdmin.
// V-666.Q — appended tests for updateCustomerNote.
// V-666.R — appended tests for paid-receipt email notifier.
// V-666.T — appended tests for listForAdmin status + search filters.
// V-666.W — appended tests for getStatsForAdmin avgTimeToPaidMs metric.
// V-666.AA — appended tests for admin setInternalNote.
// V-666.AC — appended tests for getPendingAgeHistogram.
// V-666.AE — appended tests for getStatsForAdmin per-product revenue.
// V-666.AM — appended tests for listForAdminPage cursor pagination.
// V-666.AN — appended tests for crypto.order.failed webhook emission.
//            Existing V-666.I "does NOT fire when transitioning to failed"
//            test was tightened to assert no crypto.order.paid (the AN
//            event does intentionally fire on that path).
// V-666.AO — appended tests for createIdempotent (Idempotency-Key replay).
// V-666.AP — appended tests for getIdempotencyMetrics counters.
// V-666.AR — appended tests for body-fingerprint mismatch tracking.
// V-666.AS — appended tests for listForAdminPage payment_id filter.
// V-666.AT — appended tests for the append-only event log.

import { describe, expect, it } from 'vitest';
import {
  CryptoOrdersService,
  type CryptoOrderPaidEmail,
  type CryptoOrderPaidEmailNotifier,
  type CryptoOrderWebhookEmitter,
  type CryptoOrdersRepo,
  InMemoryCryptoOrdersRepo,
  encodeCursor,
  decodeCursor,
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

describe('applyIpnStatus — paid side-effects fire EXACTLY once across re-delivery (audit #3, withOrderLock)', () => {
  it('the paid webhook + receipt email fire only on the winning transition, not on a re-delivered paid IPN', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const paidWebhooks: string[] = [];
    const emails: string[] = [];
    const svc = new CryptoOrdersService({
      repo,
      nowFn: () => 5_000,
      webhooks: {
        enqueueEvent: (accountId, eventType) => {
          if (eventType === 'crypto.order.paid') paidWebhooks.push(accountId);
          return Promise.resolve(0);
        },
      },
      paidEmailNotifier: {
        notifyOrderPaid: (intent) => {
          emails.push(intent.order_id);
          return Promise.resolve();
        },
      },
    });
    await svc.create({
      order_id: 'ord_fire',
      account_id: 'acc_x',
      product: 'p',
      price_cents: 100,
      price_currency: 'EUR',
    });
    // First 'finished' IPN → transition to paid → fires once.
    await svc.applyIpnStatus({
      order_id: 'ord_fire',
      payment_id: 'np',
      provider_status: 'finished',
    });
    // Re-delivered 'finished' IPN (already paid in the LOCKED row) → must NOT re-fire.
    await svc.applyIpnStatus({
      order_id: 'ord_fire',
      payment_id: 'np',
      provider_status: 'finished',
    });
    expect(paidWebhooks).toEqual(['acc_x']); // exactly one webhook
    expect(emails).toEqual(['ord_fire']); // exactly one receipt email
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

  it('does NOT fire crypto.order.paid when transitioning to failed', async () => {
    const { emitter, calls } = makeEmitter();
    const { svc } = await seed({ emitter });
    await svc.applyIpnStatus({
      order_id: 'ord_pay',
      payment_id: 'np_x',
      provider_status: 'failed',
    });
    expect(calls.filter((c) => c.eventType === 'crypto.order.paid')).toHaveLength(0);
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

  it('sweepExpiredOrders drains the OLDEST stale orders even when newer orders crowd the scan window', async () => {
    // Regression: the sweep used to scan listAll (newest-first) then
    // filter in memory. Once newer (still-fresh) orders outnumber the
    // per-tick limit, a newest-first scan never reaches the genuinely
    // stale OLD orders, so they were never swept at scale. The sweep
    // must select oldest-first among eligible (pending + past-cutoff)
    // rows.
    const { svc, setNow } = makeService();
    setNow(1_000_000);
    // Three genuinely stale orders created first (oldest).
    for (let i = 0; i < 3; i += 1) {
      await svc.create({
        order_id: `ord_old_${i.toString()}`,
        account_id: 'a',
        product: 'p',
        price_cents: 100,
        price_currency: 'EUR',
      });
    }
    // A burst of newer pending orders created 23h later — still fresh
    // at sweep time, and enough of them to fill a small scan window.
    setNow(1_000_000 + 23 * 60 * 60 * 1000);
    for (let i = 0; i < 5; i += 1) {
      await svc.create({
        order_id: `ord_fresh_${i.toString()}`,
        account_id: 'a',
        product: 'p',
        price_cents: 100,
        price_currency: 'EUR',
      });
    }
    // 25h after the old ones: the 3 old orders are past the 24h cutoff;
    // the 5 fresh ones (2h old) are not.
    setNow(1_000_000 + 25 * 60 * 60 * 1000);
    const result = await svc.sweepExpiredOrders({
      olderThanMs: 24 * 60 * 60 * 1000,
      // Limit smaller than the fresh burst: a newest-first scan of this
      // many rows would return only fresh orders and sweep nothing.
      limit: 3,
    });
    expect(result.expired).toBe(3);
    expect(result.capped).toBe(true); // full batch — cron re-runs
    for (let i = 0; i < 3; i += 1) {
      expect((await svc.getById(`ord_old_${i.toString()}`))?.status).toBe('failed');
    }
    for (let i = 0; i < 5; i += 1) {
      expect((await svc.getById(`ord_fresh_${i.toString()}`))?.status).toBe('pending');
    }
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

  it('paid_at comes from the paid event, not updated_at — a post-payment note edit must not move it (audit fix)', async () => {
    const { svc } = await seedRcpt({ status: 'paid' }); // paid transition at now=6_000
    // An ops note edit AFTER payment bumps the order's updated_at (seedRcpt left now=7_000)…
    await svc.setInternalNote({ order_id: 'ord_rcpt', internal_note: 'reviewed by ops' });
    const r = await svc.getReceipt({
      order_id: 'ord_rcpt',
      account_id: 'acc_owner',
      issued_at: 9_000,
    });
    // …but the customer receipt's paid_at stays the real paid moment (6_000),
    // sourced from the append-only event log, not the bumped updated_at.
    expect(r?.paid_at).toBe(new Date(6_000).toISOString());
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

  // V-666.W — avg time-to-paid metric tests appended to the same suite.
  it('returns avgTimeToPaidMs=null + paidSample=0 when no paid orders exist', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo });
    await svc.create({
      order_id: 'p_only',
      account_id: 'a',
      product: 'x',
      price_cents: 100,
      price_currency: 'EUR',
    });
    const stats = await svc.getStatsForAdmin();
    expect(stats.avgTimeToPaidMs).toBeNull();
    expect(stats.paidSample).toBe(0);
  });

  it('computes avgTimeToPaidMs = mean(updated_at - created_at) across paid orders', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    let now = 1_000_000;
    const svc = new CryptoOrdersService({ repo, nowFn: () => now });
    // Order A: created at t=1_000_000, paid at t=1_000_000 + 60s.
    await svc.create({
      order_id: 'pa',
      account_id: 'a',
      product: 'x',
      price_cents: 100,
      price_currency: 'EUR',
    });
    now = 1_060_000;
    await svc.applyIpnStatus({ order_id: 'pa', payment_id: 'np', provider_status: 'finished' });
    // Order B: created at t=2_000_000, paid at t=2_000_000 + 180s.
    now = 2_000_000;
    await svc.create({
      order_id: 'pb',
      account_id: 'a',
      product: 'x',
      price_cents: 100,
      price_currency: 'EUR',
    });
    now = 2_180_000;
    await svc.applyIpnStatus({ order_id: 'pb', payment_id: 'np', provider_status: 'finished' });
    const stats = await svc.getStatsForAdmin();
    expect(stats.paidSample).toBe(2);
    // Mean of 60_000 + 180_000 = 120_000ms
    expect(stats.avgTimeToPaidMs).toBe(120_000);
  });

  it('ignores non-paid orders when computing avgTimeToPaidMs', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    let now = 1_000;
    const svc = new CryptoOrdersService({ repo, nowFn: () => now });
    // A paid order with 30s time-to-pay.
    await svc.create({
      order_id: 'p_paid',
      account_id: 'a',
      product: 'x',
      price_cents: 100,
      price_currency: 'EUR',
    });
    now = 31_000;
    await svc.applyIpnStatus({
      order_id: 'p_paid',
      payment_id: 'np',
      provider_status: 'finished',
    });
    // A failed order that took much longer — should NOT affect the mean.
    now = 50_000;
    await svc.create({
      order_id: 'p_failed',
      account_id: 'a',
      product: 'x',
      price_cents: 100,
      price_currency: 'EUR',
    });
    now = 999_000;
    await svc.applyIpnStatus({
      order_id: 'p_failed',
      payment_id: 'np',
      provider_status: 'expired',
    });
    const stats = await svc.getStatsForAdmin();
    expect(stats.paidSample).toBe(1);
    expect(stats.avgTimeToPaidMs).toBe(30_000);
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

  it('aligns the window to UTC date boundaries — oldest in-window date is a full day; the day before the window is excluded even though within days*24h', async () => {
    const now = Date.parse('2026-05-11T12:00:00Z');
    const { svc, setNow } = makeServiceAt(now);
    // days=7, now=05-11T12:00 → window = the 7 UTC dates [05-05 .. 05-11].
    // Order on 05-05 at 01:00 — early morning of the OLDEST in-window
    // date. Must be counted, proving the oldest day is a full day (a
    // rolling now-7*24h=05-04T12:00 cutoff would include it too, but the
    // point is it stays in under date-alignment).
    setNow(Date.parse('2026-05-05T01:00:00Z'));
    await svc.create({
      order_id: 'edge-in',
      account_id: 'a',
      product: 'x',
      price_cents: 100,
      price_currency: 'EUR',
    });
    // Order on 05-04 at 18:00 — its UTC date (05-04) is OUTSIDE the
    // 7-date window, yet it falls within a rolling now-7*24h window
    // (cutoff 05-04T12:00). Date-alignment must exclude it (the old
    // rolling filter wrongly surfaced a partial '2026-05-04' bucket).
    setNow(Date.parse('2026-05-04T18:00:00Z'));
    await svc.create({
      order_id: 'edge-out',
      account_id: 'a',
      product: 'x',
      price_cents: 100,
      price_currency: 'EUR',
    });
    setNow(now);
    const out = await svc.getDailyBreakdownForAdmin({ days: 7 });
    const dates = out.rows.map((r) => r.date);
    expect(dates).toContain('2026-05-05');
    expect(dates).not.toContain('2026-05-04');
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

describe('V-666.T listForAdmin — status + search filters', () => {
  async function seedMany(): Promise<CryptoOrdersService> {
    const repo = new InMemoryCryptoOrdersRepo();
    let t = 1_000;
    const svc = new CryptoOrdersService({ repo, nowFn: () => t });
    await svc.create({
      order_id: 'ord_alpha',
      account_id: 'acc_one',
      product: 'solo_manual',
      price_cents: 2500,
      price_currency: 'EUR',
    });
    t = 2_000;
    await svc.create({
      order_id: 'ord_beta',
      account_id: 'acc_two',
      product: 'team_growth',
      price_cents: 14900,
      price_currency: 'EUR',
    });
    t = 3_000;
    await svc.create({
      order_id: 'ord_gamma',
      account_id: 'acc_one',
      product: 'team_growth',
      price_cents: 14900,
      price_currency: 'EUR',
    });
    // mark one paid
    t = 4_000;
    await svc.applyIpnStatus({
      order_id: 'ord_beta',
      payment_id: 'np_b',
      provider_status: 'finished',
    });
    // mark one cancelled
    t = 5_000;
    await svc.cancelOrder({ order_id: 'ord_alpha', account_id: 'acc_one' });
    // attach a note to ord_gamma
    t = 6_000;
    await svc.updateCustomerNote({
      order_id: 'ord_gamma',
      account_id: 'acc_one',
      customer_note: 'PO-12345 quarterly renewal',
    });
    return svc;
  }

  it('returns all orders newest-first when no filters supplied', async () => {
    const svc = await seedMany();
    const list = await svc.listForAdmin();
    expect(list.map((o) => o.order_id)).toEqual(['ord_gamma', 'ord_beta', 'ord_alpha']);
  });

  it('filters by status=paid', async () => {
    const svc = await seedMany();
    const list = await svc.listForAdmin({ status: 'paid' });
    expect(list.map((o) => o.order_id)).toEqual(['ord_beta']);
  });

  it('filters by status=cancelled', async () => {
    const svc = await seedMany();
    const list = await svc.listForAdmin({ status: 'cancelled' });
    expect(list.map((o) => o.order_id)).toEqual(['ord_alpha']);
  });

  it('searches order_id substring (case-insensitive)', async () => {
    const svc = await seedMany();
    const list = await svc.listForAdmin({ search: 'GAMMA' });
    expect(list.map((o) => o.order_id)).toEqual(['ord_gamma']);
  });

  it('searches product substring', async () => {
    const svc = await seedMany();
    const list = await svc.listForAdmin({ search: 'team_growth' });
    expect(list.map((o) => o.order_id).sort()).toEqual(['ord_beta', 'ord_gamma']);
  });

  it('searches customer_note substring', async () => {
    const svc = await seedMany();
    const list = await svc.listForAdmin({ search: 'po-12345' });
    expect(list.map((o) => o.order_id)).toEqual(['ord_gamma']);
  });

  it('combines status + search (AND)', async () => {
    const svc = await seedMany();
    const list = await svc.listForAdmin({ status: 'paid', search: 'team_growth' });
    expect(list.map((o) => o.order_id)).toEqual(['ord_beta']);
    const empty = await svc.listForAdmin({ status: 'paid', search: 'solo_manual' });
    expect(empty).toEqual([]);
  });

  it('honours accountId + filters together', async () => {
    const svc = await seedMany();
    const list = await svc.listForAdmin({ accountId: 'acc_one', status: 'cancelled' });
    expect(list.map((o) => o.order_id)).toEqual(['ord_alpha']);
  });

  it('applies limit AFTER filtering (returns up to N matching rows)', async () => {
    const svc = await seedMany();
    const list = await svc.listForAdmin({ search: 'team_growth', limit: 1 });
    expect(list).toHaveLength(1);
    expect(list[0]?.order_id).toBe('ord_gamma'); // newest-first
  });

  it('treats empty search string as no filter', async () => {
    const svc = await seedMany();
    const list = await svc.listForAdmin({ search: '   ' });
    expect(list).toHaveLength(3);
  });

  it('V-666.BX createdAfter is inclusive of >=', async () => {
    // Seed orders at t=1000, t=2000, t=3000. createdAfter:2000 keeps
    // ord_beta + ord_gamma; createdAfter:2001 keeps only ord_gamma.
    const svc = await seedMany();
    const incList = await svc.listForAdmin({ createdAfter: 2_000 });
    expect(incList.map((o) => o.order_id).sort()).toEqual(['ord_beta', 'ord_gamma']);
    const excList = await svc.listForAdmin({ createdAfter: 2_001 });
    expect(excList.map((o) => o.order_id)).toEqual(['ord_gamma']);
  });

  it('V-666.BX createdBefore is exclusive of <', async () => {
    const svc = await seedMany();
    const list = await svc.listForAdmin({ createdBefore: 2_000 });
    expect(list.map((o) => o.order_id)).toEqual(['ord_alpha']);
  });

  it('V-666.BX createdAfter + createdBefore compose into a window', async () => {
    const svc = await seedMany();
    const list = await svc.listForAdmin({ createdAfter: 1_500, createdBefore: 2_500 });
    expect(list.map((o) => o.order_id)).toEqual(['ord_beta']);
  });

  it('V-666.BX date-range composes with status filter', async () => {
    const svc = await seedMany();
    const list = await svc.listForAdmin({
      status: 'cancelled',
      createdAfter: 0,
      createdBefore: 5_000,
    });
    expect(list.map((o) => o.order_id)).toEqual(['ord_alpha']);
  });
});

describe('V-666.AA setInternalNote', () => {
  async function seed(now: number = 1_000): Promise<{
    svc: CryptoOrdersService;
    setNow: (t: number) => void;
  }> {
    const repo = new InMemoryCryptoOrdersRepo();
    let n = now;
    const svc = new CryptoOrdersService({ repo, nowFn: () => n });
    await svc.create({
      order_id: 'ord_note',
      account_id: 'acc',
      product: 'team_growth',
      price_cents: 14900,
      price_currency: 'EUR',
    });
    return {
      svc,
      setNow: (t) => {
        n = t;
      },
    };
  }

  it('returns null when the order does not exist', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo });
    const r = await svc.setInternalNote({
      order_id: 'ord_missing',
      internal_note: 'hi',
    });
    expect(r).toBeNull();
  });

  it('writes the note + bumps updated_at on first set', async () => {
    const { svc, setNow } = await seed();
    setNow(50_000);
    const r = await svc.setInternalNote({
      order_id: 'ord_note',
      internal_note: 'VIP customer, manual outreach',
    });
    expect(r?.internal_note).toBe('VIP customer, manual outreach');
    expect(r?.updated_at).toBe(50_000);
  });

  it('overwrites the note on subsequent writes', async () => {
    const { svc } = await seed();
    await svc.setInternalNote({
      order_id: 'ord_note',
      internal_note: 'first take',
    });
    const r = await svc.setInternalNote({
      order_id: 'ord_note',
      internal_note: 'amended take',
    });
    expect(r?.internal_note).toBe('amended take');
  });

  it('empty string normalises to null', async () => {
    const { svc } = await seed();
    await svc.setInternalNote({
      order_id: 'ord_note',
      internal_note: 'something',
    });
    const r = await svc.setInternalNote({
      order_id: 'ord_note',
      internal_note: '',
    });
    expect(r?.internal_note).toBeNull();
  });

  it('explicit null clears the note', async () => {
    const { svc } = await seed();
    await svc.setInternalNote({
      order_id: 'ord_note',
      internal_note: 'something',
    });
    const r = await svc.setInternalNote({
      order_id: 'ord_note',
      internal_note: null,
    });
    expect(r?.internal_note).toBeNull();
  });

  it('does not change the order status (works in any state)', async () => {
    const { svc } = await seed();
    await svc.applyIpnStatus({
      order_id: 'ord_note',
      payment_id: 'np',
      provider_status: 'finished',
    });
    const r = await svc.setInternalNote({
      order_id: 'ord_note',
      internal_note: 'paid, watch for chargeback',
    });
    expect(r?.status).toBe('paid');
    expect(r?.internal_note).toBe('paid, watch for chargeback');
  });

  it('preserves customer_note (separate field from internal_note)', async () => {
    const { svc } = await seed();
    await svc.updateCustomerNote({
      order_id: 'ord_note',
      account_id: 'acc',
      customer_note: 'PO-9999',
    });
    const r = await svc.setInternalNote({
      order_id: 'ord_note',
      internal_note: 'support note',
    });
    expect(r?.customer_note).toBe('PO-9999');
    expect(r?.internal_note).toBe('support note');
  });
});

describe('V-666.AC getPendingAgeHistogram', () => {
  const NOW = 100_000_000_000;
  const HOUR = 60 * 60 * 1_000;

  async function seedAtAges(
    ages: Array<{ id: string; ageMs: number; currency?: string }>,
  ): Promise<CryptoOrdersService> {
    const repo = new InMemoryCryptoOrdersRepo();
    let now = NOW;
    const svc = new CryptoOrdersService({ repo, nowFn: () => now });
    for (const { id, ageMs, currency } of ages) {
      now = NOW - ageMs;
      await svc.create({
        order_id: id,
        account_id: 'acc',
        product: 'team_growth',
        price_cents: 14900,
        price_currency: currency ?? 'EUR',
      });
    }
    now = NOW;
    return svc;
  }

  it('returns all-zero buckets when no pending orders exist', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo, nowFn: () => NOW });
    const histo = await svc.getPendingAgeHistogram();
    expect(histo.total).toBe(0);
    expect(histo.buckets).toEqual({
      under_1h: 0,
      h1_to_6h: 0,
      h6_to_24h: 0,
      over_24h: 0,
    });
    expect(histo.pendingValueCents).toEqual({});
  });

  it('buckets pending orders correctly by age', async () => {
    const svc = await seedAtAges([
      { id: 'fresh', ageMs: 30 * 60_000 }, // 30m → under_1h
      { id: 'fresh2', ageMs: 45 * 60_000 }, // 45m → under_1h
      { id: 'mid', ageMs: 3 * HOUR }, // 3h → h1_to_6h
      { id: 'old', ageMs: 12 * HOUR }, // 12h → h6_to_24h
      { id: 'stale', ageMs: 36 * HOUR }, // 36h → over_24h
      { id: 'ancient', ageMs: 72 * HOUR }, // 72h → over_24h
    ]);
    const histo = await svc.getPendingAgeHistogram();
    expect(histo.buckets).toEqual({
      under_1h: 2,
      h1_to_6h: 1,
      h6_to_24h: 1,
      over_24h: 2,
    });
    expect(histo.total).toBe(6);
  });

  it('only counts pending orders (ignores paid / failed / cancelled)', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    let now = NOW;
    const svc = new CryptoOrdersService({ repo, nowFn: () => now });
    now = NOW - 30 * 60_000;
    await svc.create({
      order_id: 'p_pending',
      account_id: 'acc',
      product: 'x',
      price_cents: 100,
      price_currency: 'EUR',
    });
    now = NOW - 30 * 60_000;
    await svc.create({
      order_id: 'p_paid',
      account_id: 'acc',
      product: 'x',
      price_cents: 200,
      price_currency: 'EUR',
    });
    await svc.applyIpnStatus({
      order_id: 'p_paid',
      payment_id: 'np',
      provider_status: 'finished',
    });
    now = NOW;
    const histo = await svc.getPendingAgeHistogram();
    expect(histo.total).toBe(1);
    expect(histo.buckets.under_1h).toBe(1);
    expect(histo.pendingValueCents).toEqual({ EUR: 100 });
  });

  it('aggregates pending value by currency', async () => {
    const svc = await seedAtAges([
      { id: 'eur_a', ageMs: 30 * 60_000, currency: 'EUR' },
      { id: 'eur_b', ageMs: 2 * HOUR, currency: 'EUR' },
      { id: 'usd_a', ageMs: 4 * HOUR, currency: 'USD' },
    ]);
    const histo = await svc.getPendingAgeHistogram();
    expect(histo.pendingValueCents).toEqual({ EUR: 14900 * 2, USD: 14900 });
  });

  it('flags truncated=true when the scan hits scanLimit', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    let now = NOW - 30 * 60_000;
    const svc = new CryptoOrdersService({ repo, nowFn: () => now });
    for (let i = 0; i < 3; i += 1) {
      await svc.create({
        order_id: `p_${i.toString()}`,
        account_id: 'acc',
        product: 'x',
        price_cents: 100,
        price_currency: 'EUR',
      });
    }
    now = NOW;
    const histo = await svc.getPendingAgeHistogram({ scanLimit: 3 });
    expect(histo.truncated).toBe(true);
    expect(histo.scanned).toBe(3);
  });

  it('counts OLD pending orders even when newer terminal orders would crowd a newest-first scan window', async () => {
    // Regression: getPendingAgeHistogram used to scan listAll (newest-
    // first, all statuses). A backlog of newer paid/failed orders pushed
    // the old pending orders out of the scanLimit window, so the
    // over_24h bucket — the sweep-candidate count operators rely on —
    // read zero. It must scan pending-only, oldest-first.
    const repo = new InMemoryCryptoOrdersRepo();
    let now = NOW;
    const svc = new CryptoOrdersService({ repo, nowFn: () => now });
    // Two genuinely stale pending orders, created first (>24h ago).
    for (let i = 0; i < 2; i += 1) {
      now = NOW - 48 * HOUR;
      await svc.create({
        order_id: `old_pending_${i.toString()}`,
        account_id: 'acc',
        product: 'x',
        price_cents: 100,
        price_currency: 'EUR',
      });
    }
    // A burst of NEWER orders that resolve to paid — these would fill a
    // newest-first scan window and hide the old pending ones.
    for (let i = 0; i < 5; i += 1) {
      now = NOW - 10 * 60_000;
      await svc.create({
        order_id: `new_paid_${i.toString()}`,
        account_id: 'acc',
        product: 'x',
        price_cents: 100,
        price_currency: 'EUR',
      });
      await svc.applyIpnStatus({
        order_id: `new_paid_${i.toString()}`,
        payment_id: `np_${i.toString()}`,
        provider_status: 'finished',
      });
    }
    now = NOW;
    // Scan window smaller than the newer-paid burst: a newest-first scan
    // would see only paid orders and report over_24h = 0.
    const histo = await svc.getPendingAgeHistogram({ scanLimit: 3 });
    expect(histo.buckets.over_24h).toBe(2);
    expect(histo.total).toBe(2);
    expect(histo.pendingValueCents).toEqual({ EUR: 200 });
  });

  it('uses < 1h boundary exclusively (an exactly-1h-old order goes to h1_to_6h)', async () => {
    const svc = await seedAtAges([{ id: 'edge', ageMs: HOUR }]);
    const histo = await svc.getPendingAgeHistogram();
    expect(histo.buckets.under_1h).toBe(0);
    expect(histo.buckets.h1_to_6h).toBe(1);
  });

  it('uses < 24h boundary exclusively (an exactly-24h-old order goes to over_24h)', async () => {
    const svc = await seedAtAges([{ id: 'edge24', ageMs: 24 * HOUR }]);
    const histo = await svc.getPendingAgeHistogram();
    expect(histo.buckets.h6_to_24h).toBe(0);
    expect(histo.buckets.over_24h).toBe(1);
  });
});

describe('V-666.AE getStatsForAdmin — per-product revenue', () => {
  async function seedPaid(
    rows: Array<{
      order_id: string;
      product: string;
      price_cents: number;
      price_currency?: string;
      status?: 'paid' | 'pending' | 'failed';
    }>,
  ): Promise<CryptoOrdersService> {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo });
    for (const r of rows) {
      await svc.create({
        order_id: r.order_id,
        account_id: 'acc',
        product: r.product,
        price_cents: r.price_cents,
        price_currency: r.price_currency ?? 'EUR',
      });
      if ((r.status ?? 'paid') === 'paid') {
        await svc.applyIpnStatus({
          order_id: r.order_id,
          payment_id: 'np',
          provider_status: 'finished',
        });
      } else if (r.status === 'failed') {
        await svc.applyIpnStatus({
          order_id: r.order_id,
          payment_id: 'np',
          provider_status: 'failed',
        });
      }
    }
    return svc;
  }

  it('returns empty maps when no paid orders exist', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo });
    await svc.create({
      order_id: 'ord_p',
      account_id: 'acc',
      product: 'team_growth',
      price_cents: 14900,
      price_currency: 'EUR',
    });
    const stats = await svc.getStatsForAdmin();
    expect(stats.paidRevenueByProduct).toEqual({});
    expect(stats.paidCountByProduct).toEqual({});
  });

  it('aggregates revenue + count keyed by product (single product)', async () => {
    const svc = await seedPaid([
      { order_id: 'a', product: 'team_growth', price_cents: 14900 },
      { order_id: 'b', product: 'team_growth', price_cents: 14900 },
      { order_id: 'c', product: 'team_growth', price_cents: 14900 },
    ]);
    const stats = await svc.getStatsForAdmin();
    expect(stats.paidRevenueByProduct).toEqual({ team_growth: { EUR: 14900 * 3 } });
    expect(stats.paidCountByProduct).toEqual({ team_growth: 3 });
  });

  it('breaks down by product across multiple products + currencies', async () => {
    const svc = await seedPaid([
      { order_id: 'tg_eur', product: 'team_growth', price_cents: 14900, price_currency: 'EUR' },
      { order_id: 'tg_usd', product: 'team_growth', price_cents: 16000, price_currency: 'USD' },
      { order_id: 'api1', product: 'api_starter', price_cents: 5000, price_currency: 'EUR' },
      { order_id: 'api2', product: 'api_starter', price_cents: 5000, price_currency: 'EUR' },
      { order_id: 'solo', product: 'solo_manual', price_cents: 2500, price_currency: 'EUR' },
    ]);
    const stats = await svc.getStatsForAdmin();
    expect(stats.paidRevenueByProduct).toEqual({
      team_growth: { EUR: 14900, USD: 16000 },
      api_starter: { EUR: 10000 },
      solo_manual: { EUR: 2500 },
    });
    expect(stats.paidCountByProduct).toEqual({
      team_growth: 2,
      api_starter: 2,
      solo_manual: 1,
    });
  });

  it('ignores non-paid orders (pending + failed do not contribute)', async () => {
    const svc = await seedPaid([
      { order_id: 'paid', product: 'team_growth', price_cents: 14900, status: 'paid' },
      { order_id: 'pending', product: 'team_growth', price_cents: 14900, status: 'pending' },
      { order_id: 'failed', product: 'api_starter', price_cents: 5000, status: 'failed' },
    ]);
    const stats = await svc.getStatsForAdmin();
    expect(stats.paidRevenueByProduct).toEqual({ team_growth: { EUR: 14900 } });
    expect(stats.paidCountByProduct).toEqual({ team_growth: 1 });
  });
});

describe('V-666.AM listForAdminPage — cursor pagination', () => {
  async function seedOrders(count: number): Promise<CryptoOrdersService> {
    const repo = new InMemoryCryptoOrdersRepo();
    let now = 1_000;
    const svc = new CryptoOrdersService({ repo, nowFn: () => now });
    for (let i = 0; i < count; i += 1) {
      // Pad so created_at is monotonic + unique across the seed.
      now = 1_000 + i;
      await svc.create({
        order_id: `ord_${i.toString().padStart(3, '0')}`,
        account_id: 'acc',
        product: 'team_growth',
        price_cents: 14900,
        price_currency: 'EUR',
      });
    }
    return svc;
  }

  it('returns nextCursor when more rows exist', async () => {
    const svc = await seedOrders(20);
    const page = await svc.listForAdminPage({ limit: 5 });
    expect(page.orders).toHaveLength(5);
    expect(page.nextCursor).not.toBeNull();
    // Sort is created_at DESC + id ASC tiebreaker; with monotonic
    // timestamps, the newest 5 are ord_019..ord_015.
    expect(page.orders.map((o) => o.order_id)).toEqual([
      'ord_019',
      'ord_018',
      'ord_017',
      'ord_016',
      'ord_015',
    ]);
  });

  it('nextCursor is null on the final page', async () => {
    const svc = await seedOrders(3);
    const page = await svc.listForAdminPage({ limit: 5 });
    expect(page.orders).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });

  it('round-trips through cursor to fetch the next page exactly once', async () => {
    const svc = await seedOrders(12);
    // Seed = ord_000..ord_011. Sort newest first → ord_011 first.
    const p1 = await svc.listForAdminPage({ limit: 5 });
    expect(p1.orders.map((o) => o.order_id)).toEqual([
      'ord_011',
      'ord_010',
      'ord_009',
      'ord_008',
      'ord_007',
    ]);
    expect(p1.nextCursor).not.toBeNull();
    if (p1.nextCursor === null) return;
    const p2 = await svc.listForAdminPage({ limit: 5, cursor: p1.nextCursor });
    expect(p2.orders.map((o) => o.order_id)).toEqual([
      'ord_006',
      'ord_005',
      'ord_004',
      'ord_003',
      'ord_002',
    ]);
    expect(p2.nextCursor).not.toBeNull();
    if (p2.nextCursor === null) return;
    const p3 = await svc.listForAdminPage({ limit: 5, cursor: p2.nextCursor });
    expect(p3.orders.map((o) => o.order_id)).toEqual(['ord_001', 'ord_000']);
    expect(p3.nextCursor).toBeNull();
  });

  it('respects status filter across pages', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    let now = 1_000;
    const svc = new CryptoOrdersService({ repo, nowFn: () => now });
    for (let i = 0; i < 10; i += 1) {
      now = 1_000 + i;
      await svc.create({
        order_id: `ord_${i.toString()}`,
        account_id: 'acc',
        product: 'team_growth',
        price_cents: 14900,
        price_currency: 'EUR',
      });
      if (i % 2 === 0) {
        await svc.applyIpnStatus({
          order_id: `ord_${i.toString()}`,
          payment_id: 'np',
          provider_status: 'finished',
        });
      }
    }
    const p1 = await svc.listForAdminPage({ status: 'paid', limit: 3 });
    expect(p1.orders.map((o) => o.order_id)).toEqual(['ord_8', 'ord_6', 'ord_4']);
    expect(p1.nextCursor).not.toBeNull();
  });

  it('returns empty page + null cursor on a malformed cursor', async () => {
    const svc = await seedOrders(5);
    const page = await svc.listForAdminPage({ cursor: 'not-a-real-cursor' });
    expect(page.orders).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('returns empty page when the cursor anchor is past the scan window', async () => {
    const svc = await seedOrders(5);
    // Construct a cursor pointing at a row that doesn't exist.
    const fakeCursor = encodeCursor({ ts: 99_999_999, id: 'ord_missing' });
    const page = await svc.listForAdminPage({ cursor: fakeCursor });
    expect(page.orders).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('listForAdmin (legacy) still returns just the first-page orders', async () => {
    const svc = await seedOrders(7);
    const rows = await svc.listForAdmin({ limit: 3 });
    expect(rows.map((o) => o.order_id)).toEqual(['ord_006', 'ord_005', 'ord_004']);
  });
});

describe('V-666.AN crypto.order.failed webhook emission', () => {
  function makeMockEmitter(): {
    emitter: CryptoOrderWebhookEmitter;
    calls: Array<{
      accountId: string;
      eventType: string;
      data: Record<string, unknown>;
    }>;
  } {
    const calls: Array<{
      accountId: string;
      eventType: string;
      data: Record<string, unknown>;
    }> = [];
    const emitter: CryptoOrderWebhookEmitter = {
      // eslint-disable-next-line @typescript-eslint/require-await
      enqueueEvent: async (accountId, eventType, data) => {
        calls.push({ accountId, eventType, data });
        return 1;
      },
    };
    return { emitter, calls };
  }

  it('fires when the IPN transitions pending → failed', async () => {
    const { emitter, calls } = makeMockEmitter();
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo, webhooks: emitter, nowFn: () => 5_000 });
    await svc.create({
      order_id: 'ord_f',
      account_id: 'acc',
      product: 'team_growth',
      price_cents: 14900,
      price_currency: 'EUR',
    });
    await svc.applyIpnStatus({
      order_id: 'ord_f',
      payment_id: 'np_x',
      provider_status: 'expired',
    });
    const failedCall = calls.find((c) => c.eventType === 'crypto.order.failed');
    expect(failedCall).toBeDefined();
    if (!failedCall) return;
    expect(failedCall.accountId).toBe('acc');
    expect(failedCall.data).toMatchObject({
      order_id: 'ord_f',
      product: 'team_growth',
      price_cents: 14900,
      price_currency: 'EUR',
      reason: 'ipn',
      payment_id: 'np_x',
    });
  });

  it('does NOT fire when applyIpnStatus is called on an already-failed order', async () => {
    const { emitter, calls } = makeMockEmitter();
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo, webhooks: emitter });
    await svc.create({
      order_id: 'ord_f',
      account_id: 'acc',
      product: 'team_growth',
      price_cents: 14900,
      price_currency: 'EUR',
    });
    await svc.applyIpnStatus({
      order_id: 'ord_f',
      payment_id: 'np',
      provider_status: 'expired',
    });
    const baselineFailed = calls.filter((c) => c.eventType === 'crypto.order.failed').length;
    // A re-deliver of the same IPN is a no-op + must not re-emit.
    await svc.applyIpnStatus({
      order_id: 'ord_f',
      payment_id: 'np',
      provider_status: 'expired',
    });
    const afterFailed = calls.filter((c) => c.eventType === 'crypto.order.failed').length;
    expect(afterFailed).toBe(baselineFailed);
  });

  it('fires reason:expired on expireOrder', async () => {
    const { emitter, calls } = makeMockEmitter();
    const repo = new InMemoryCryptoOrdersRepo();
    let now = 1_000;
    const svc = new CryptoOrdersService({ repo, webhooks: emitter, nowFn: () => now });
    await svc.create({
      order_id: 'ord_exp',
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'EUR',
    });
    now = 10_000_000;
    const expired = await svc.expireOrder({ order_id: 'ord_exp', olderThanMs: 60_000 });
    expect(expired?.status).toBe('failed');
    const call = calls.find((c) => c.eventType === 'crypto.order.failed');
    expect(call?.data).toMatchObject({ reason: 'expired', order_id: 'ord_exp' });
  });

  it('fires reason:swept once per swept order', async () => {
    const { emitter, calls } = makeMockEmitter();
    const repo = new InMemoryCryptoOrdersRepo();
    let now = 1_000;
    const svc = new CryptoOrdersService({ repo, webhooks: emitter, nowFn: () => now });
    for (let i = 0; i < 3; i += 1) {
      await svc.create({
        order_id: `ord_sw_${i.toString()}`,
        account_id: 'acc',
        product: 'p',
        price_cents: 100,
        price_currency: 'EUR',
      });
    }
    now = 10_000_000;
    const result = await svc.sweepExpiredOrders({ olderThanMs: 60_000 });
    expect(result.expired).toBe(3);
    const failed = calls.filter((c) => c.eventType === 'crypto.order.failed');
    expect(failed).toHaveLength(3);
    for (const c of failed) {
      expect(c.data).toMatchObject({ reason: 'swept' });
    }
  });

  it('does not emit when account_id is null', async () => {
    const { emitter, calls } = makeMockEmitter();
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo, webhooks: emitter });
    await svc.create({
      order_id: 'ord_anon',
      account_id: null,
      product: 'p',
      price_cents: 100,
      price_currency: 'EUR',
    });
    await svc.applyIpnStatus({
      order_id: 'ord_anon',
      payment_id: 'np',
      provider_status: 'failed',
    });
    expect(calls.filter((c) => c.eventType === 'crypto.order.failed')).toHaveLength(0);
  });

  it('does not emit when no webhooks emitter is wired', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo });
    await svc.create({
      order_id: 'ord_no_e',
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'EUR',
    });
    const r = await svc.applyIpnStatus({
      order_id: 'ord_no_e',
      payment_id: 'np',
      provider_status: 'expired',
    });
    expect(r?.status).toBe('failed');
  });

  it('swallows emitter errors — return value is unaffected', async () => {
    const failingEmitter: CryptoOrderWebhookEmitter = {
      // eslint-disable-next-line @typescript-eslint/require-await
      enqueueEvent: async () => {
        throw new Error('boom');
      },
    };
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo, webhooks: failingEmitter });
    await svc.create({
      order_id: 'ord_fail',
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'EUR',
    });
    const r = await svc.applyIpnStatus({
      order_id: 'ord_fail',
      payment_id: 'np',
      provider_status: 'expired',
    });
    expect(r?.status).toBe('failed');
  });
});

describe('V-666.AO createIdempotent', () => {
  function makeSvc(nowFn?: () => number): {
    svc: CryptoOrdersService;
    repo: InMemoryCryptoOrdersRepo;
  } {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo, nowFn });
    return { svc, repo };
  }

  it('mints a fresh order on first call', async () => {
    const { svc } = makeSvc();
    const r = await svc.createIdempotent({
      idempotency_key: 'k1',
      order_id: 'ord_a',
      account_id: 'acc',
      product: 'team_growth',
      price_cents: 4900,
      price_currency: 'USD',
    });
    expect(r.replayed).toBe(false);
    expect(r.order.order_id).toBe('ord_a');
    expect(r.order.status).toBe('pending');
  });

  it('replays the original order on a second call with the same key', async () => {
    const { svc } = makeSvc();
    const first = await svc.createIdempotent({
      idempotency_key: 'k1',
      order_id: 'ord_a',
      account_id: 'acc',
      product: 'team_growth',
      price_cents: 4900,
      price_currency: 'USD',
    });
    const second = await svc.createIdempotent({
      idempotency_key: 'k1',
      order_id: 'ord_b', // ignored — replay should return ord_a
      account_id: 'acc',
      product: 'team_growth',
      price_cents: 4900,
      price_currency: 'USD',
    });
    expect(second.replayed).toBe(true);
    expect(second.order.order_id).toBe(first.order.order_id);
    expect(second.order.created_at).toBe(first.order.created_at);
  });

  it('coalesces CONCURRENT same-key creates into a single order (single-flight)', async () => {
    // The double-click case: two simultaneous POSTs with the same key must
    // create exactly ONE order, not race into two. Both calls run up to their
    // first await before either resolves; the second must observe the first's
    // in-flight create and replay it (without the single-flight guard both
    // would miss the cache and both create — firstWrites would be 2).
    const { svc } = makeSvc();
    const args = {
      idempotency_key: 'k-concurrent',
      account_id: 'acc',
      product: 'team_growth',
      price_cents: 4900,
      price_currency: 'USD',
    };
    const [r1, r2] = await Promise.all([
      svc.createIdempotent({ ...args, order_id: 'ord_a' }),
      svc.createIdempotent({ ...args, order_id: 'ord_b' }),
    ]);
    // Exactly one fresh write; the other replayed; both reference one order.
    expect([r1.replayed, r2.replayed].sort()).toEqual([false, true]);
    expect(r1.order.order_id).toBe(r2.order.order_id);
    expect(svc.getIdempotencyMetrics().firstWrites).toBe(1);
  });

  it('scopes keys per account — same key from a different account mints a new order', async () => {
    const { svc } = makeSvc();
    const r1 = await svc.createIdempotent({
      idempotency_key: 'shared',
      order_id: 'ord_a',
      account_id: 'acc_one',
      product: 'p',
      price_cents: 100,
      price_currency: 'USD',
    });
    const r2 = await svc.createIdempotent({
      idempotency_key: 'shared',
      order_id: 'ord_b',
      account_id: 'acc_two',
      product: 'p',
      price_cents: 100,
      price_currency: 'USD',
    });
    expect(r1.replayed).toBe(false);
    expect(r2.replayed).toBe(false);
    expect(r2.order.order_id).not.toBe(r1.order.order_id);
  });

  it('scopes anonymous (account_id null) callers under a shared _anon bucket', async () => {
    const { svc } = makeSvc();
    const r1 = await svc.createIdempotent({
      idempotency_key: 'anon-key',
      order_id: 'ord_a',
      account_id: null,
      product: 'p',
      price_cents: 100,
      price_currency: 'USD',
    });
    const r2 = await svc.createIdempotent({
      idempotency_key: 'anon-key',
      order_id: 'ord_b',
      account_id: null,
      product: 'p',
      price_cents: 100,
      price_currency: 'USD',
    });
    expect(r2.replayed).toBe(true);
    expect(r2.order.order_id).toBe(r1.order.order_id);
  });

  it('after the 24h in-memory cache window the DB UNIQUE constraint still dedupes the SAME key (#7 cross-instance/persistent dedup is stronger than the old TTL window)', async () => {
    // Billing-integrity (#7): the in-memory cache is pruned after 24h (it's
    // only a same-process fast-path now), but the DB-backed
    // insertWithIdempotencyKey is the source of truth — so the SAME key still
    // replays the ORIGINAL order, never minting a second one. This is the
    // stronger guarantee the DB UNIQUE index buys (a key maps to one order,
    // forever + across instances), replacing the old bounded-TTL replay window.
    let now = 1_700_000_000_000;
    const { svc } = makeSvc(() => now);
    const r1 = await svc.createIdempotent({
      idempotency_key: 'k1',
      order_id: 'ord_a',
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'USD',
    });
    // Jump forward 24h + 1ms so the in-memory record is past its cache TTL.
    now += 24 * 60 * 60 * 1000 + 1;
    const r2 = await svc.createIdempotent({
      idempotency_key: 'k1',
      order_id: 'ord_b', // a fresh order_id is minted by the route, but the key dedupes
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'USD',
    });
    // The DB constraint deduped it → the ORIGINAL order is replayed, not a new one.
    expect(r2.replayed).toBe(true);
    expect(r2.order.order_id).toBe(r1.order.order_id);
  });

  it('keeps the key within the 24h window — replay still hits', async () => {
    let now = 1_700_000_000_000;
    const { svc } = makeSvc(() => now);
    const r1 = await svc.createIdempotent({
      idempotency_key: 'k1',
      order_id: 'ord_a',
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'USD',
    });
    // 23h59m later — still inside the window.
    now += 23 * 60 * 60 * 1000 + 59 * 60 * 1000;
    const r2 = await svc.createIdempotent({
      idempotency_key: 'k1',
      order_id: 'ord_b',
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'USD',
    });
    expect(r2.replayed).toBe(true);
    expect(r2.order.order_id).toBe(r1.order.order_id);
  });

  it('treats a key whose cached order no longer exists in the repo as fresh', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo });
    await svc.createIdempotent({
      idempotency_key: 'k1',
      order_id: 'ord_a',
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'USD',
    });
    // Manually evict the row from the repo (simulating a hypothetical
    // future GC pass). The next call should not return null/undefined;
    // it should mint a new order under the same key.
    (repo as unknown as { orders: Map<string, unknown> }).orders.delete('ord_a');
    const r2 = await svc.createIdempotent({
      idempotency_key: 'k1',
      order_id: 'ord_b',
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'USD',
    });
    expect(r2.replayed).toBe(false);
    expect(r2.order.order_id).toBe('ord_b');
  });
});

describe('V-666.AP getIdempotencyMetrics', () => {
  it('starts at zero', () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo });
    expect(svc.getIdempotencyMetrics()).toEqual({ replays: 0, firstWrites: 0, bodyMismatches: 0 });
  });

  it('increments firstWrites on a fresh key', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo });
    await svc.createIdempotent({
      idempotency_key: 'k1',
      order_id: 'ord_a',
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'USD',
    });
    expect(svc.getIdempotencyMetrics()).toEqual({ replays: 0, firstWrites: 1, bodyMismatches: 0 });
  });

  it('increments replays on a duplicate key', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo });
    await svc.createIdempotent({
      idempotency_key: 'k1',
      order_id: 'ord_a',
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'USD',
    });
    await svc.createIdempotent({
      idempotency_key: 'k1',
      order_id: 'ord_b',
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'USD',
    });
    expect(svc.getIdempotencyMetrics()).toEqual({ replays: 1, firstWrites: 1, bodyMismatches: 0 });
  });

  it('does not increment on plain create()', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo });
    await svc.create({
      order_id: 'ord_a',
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'USD',
    });
    expect(svc.getIdempotencyMetrics()).toEqual({ replays: 0, firstWrites: 0, bodyMismatches: 0 });
  });
});

describe('V-666.AR createIdempotent body-fingerprint check', () => {
  it('returns bodyFingerprintMismatch: false on the first write', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo });
    const r = await svc.createIdempotent({
      idempotency_key: 'k1',
      order_id: 'ord_a',
      account_id: 'acc',
      product: 'team_growth',
      price_cents: 4900,
      price_currency: 'USD',
    });
    expect(r.bodyFingerprintMismatch).toBe(false);
  });

  it('returns bodyFingerprintMismatch: false on a replay with identical body', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo });
    const args = {
      idempotency_key: 'k1',
      account_id: 'acc',
      product: 'team_growth',
      price_cents: 4900,
      price_currency: 'USD',
    };
    await svc.createIdempotent({ ...args, order_id: 'ord_a' });
    const r = await svc.createIdempotent({ ...args, order_id: 'ord_b' });
    expect(r.replayed).toBe(true);
    expect(r.bodyFingerprintMismatch).toBe(false);
  });

  it('returns bodyFingerprintMismatch: true when the price changes', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo });
    await svc.createIdempotent({
      idempotency_key: 'k1',
      order_id: 'ord_a',
      account_id: 'acc',
      product: 'team_growth',
      price_cents: 4900,
      price_currency: 'USD',
    });
    const r = await svc.createIdempotent({
      idempotency_key: 'k1',
      order_id: 'ord_b',
      account_id: 'acc',
      product: 'team_growth',
      price_cents: 9900, // distinct intent — different price
      price_currency: 'USD',
    });
    expect(r.replayed).toBe(true);
    expect(r.bodyFingerprintMismatch).toBe(true);
    // Contract is still replay: we return the original order.
    expect(r.order.price_cents).toBe(4900);
    expect(svc.getIdempotencyMetrics().bodyMismatches).toBe(1);
  });

  it('returns bodyFingerprintMismatch: true when the product changes', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo });
    await svc.createIdempotent({
      idempotency_key: 'k1',
      order_id: 'ord_a',
      account_id: 'acc',
      product: 'team_growth',
      price_cents: 4900,
      price_currency: 'USD',
    });
    const r = await svc.createIdempotent({
      idempotency_key: 'k1',
      order_id: 'ord_b',
      account_id: 'acc',
      product: 'team_scale',
      price_cents: 4900,
      price_currency: 'USD',
    });
    expect(r.bodyFingerprintMismatch).toBe(true);
  });
});

describe('V-666.AS listForAdminPage payment_id filter', () => {
  async function seedRows(svc: CryptoOrdersService): Promise<void> {
    await svc.create({
      order_id: 'ord_a',
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'USD',
    });
    await svc.create({
      order_id: 'ord_b',
      account_id: 'acc',
      product: 'p',
      price_cents: 200,
      price_currency: 'USD',
    });
    await svc.applyIpnStatus({
      order_id: 'ord_a',
      payment_id: 'np_aaa',
      provider_status: 'finished',
    });
    await svc.applyIpnStatus({
      order_id: 'ord_b',
      payment_id: 'np_bbb',
      provider_status: 'finished',
    });
  }

  it('exact-match returns only the row with the matching payment_id', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo });
    await seedRows(svc);
    const page = await svc.listForAdminPage({ paymentId: 'np_aaa' });
    expect(page.orders.map((o) => o.order_id)).toEqual(['ord_a']);
  });

  it('non-matching payment_id returns empty', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo });
    await seedRows(svc);
    const page = await svc.listForAdminPage({ paymentId: 'np_does_not_exist' });
    expect(page.orders).toHaveLength(0);
  });

  it('skips orders whose payment_id is still null', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo });
    await svc.create({
      order_id: 'ord_pending',
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'USD',
    });
    const page = await svc.listForAdminPage({ paymentId: 'np_aaa' });
    expect(page.orders).toHaveLength(0);
  });

  it('combines with status filter (AND semantics)', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo });
    await seedRows(svc);
    // np_aaa is paid; status:pending filter should return nothing.
    const page = await svc.listForAdminPage({ paymentId: 'np_aaa', status: 'pending' });
    expect(page.orders).toHaveLength(0);
  });

  it('trims whitespace + ignores empty string', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const svc = new CryptoOrdersService({ repo });
    await seedRows(svc);
    const trimmed = await svc.listForAdminPage({ paymentId: '  np_aaa  ' });
    expect(trimmed.orders.map((o) => o.order_id)).toEqual(['ord_a']);
    const empty = await svc.listForAdminPage({ paymentId: '' });
    // Empty string is a no-op; both rows come back.
    expect(empty.orders.map((o) => o.order_id).sort()).toEqual(['ord_a', 'ord_b']);
  });
});

describe('V-666.AT order event log', () => {
  function svc(): { svc: CryptoOrdersService; repo: InMemoryCryptoOrdersRepo } {
    const repo = new InMemoryCryptoOrdersRepo();
    return { svc: new CryptoOrdersService({ repo }), repo };
  }

  it('create() seeds a single pending event', async () => {
    const { svc: s } = svc();
    const order = await s.create({
      order_id: 'ord_a',
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'USD',
    });
    expect(order.events).toHaveLength(1);
    expect(order.events[0]).toMatchObject({ status: 'pending', source: 'create' });
  });

  it('applyIpnStatus appends an ipn event on a real transition', async () => {
    const { svc: s } = svc();
    await s.create({
      order_id: 'ord_a',
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'USD',
    });
    const updated = await s.applyIpnStatus({
      order_id: 'ord_a',
      payment_id: 'np_1',
      provider_status: 'finished',
    });
    expect(updated?.events.map((e) => e.status)).toEqual(['pending', 'paid']);
    expect(updated?.events[1]?.source).toBe('ipn');
  });

  it('applyIpnStatus does NOT append an event on a same-state refresh', async () => {
    const { svc: s } = svc();
    await s.create({
      order_id: 'ord_a',
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'USD',
    });
    await s.applyIpnStatus({
      order_id: 'ord_a',
      payment_id: 'np_1',
      provider_status: 'finished',
    });
    const updated = await s.applyIpnStatus({
      order_id: 'ord_a',
      payment_id: 'np_1',
      provider_status: 'finished',
    });
    expect(updated?.events.map((e) => e.status)).toEqual(['pending', 'paid']);
  });

  it('cancelOrder appends a cancel event', async () => {
    const { svc: s } = svc();
    await s.create({
      order_id: 'ord_a',
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'USD',
    });
    const r = await s.cancelOrder({ order_id: 'ord_a', account_id: 'acc' });
    if (r === null || r.ok !== 'cancelled') throw new Error('expected cancellation');
    expect(r.order.events.map((e) => ({ status: e.status, source: e.source }))).toEqual([
      { status: 'pending', source: 'create' },
      { status: 'cancelled', source: 'cancel' },
    ]);
  });

  it('expireOrder appends an expired event', async () => {
    let now = 1_700_000_000_000;
    const repo = new InMemoryCryptoOrdersRepo();
    const s = new CryptoOrdersService({ repo, nowFn: () => now });
    await s.create({
      order_id: 'ord_a',
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'USD',
    });
    now += 60 * 60 * 1000 + 1; // past 1h cutoff
    const updated = await s.expireOrder({ order_id: 'ord_a', olderThanMs: 60 * 60 * 1000 });
    expect(updated?.events.map((e) => e.source)).toEqual(['create', 'expired']);
  });

  it('sweepExpiredOrders appends a swept event per-row', async () => {
    let now = 1_700_000_000_000;
    const repo = new InMemoryCryptoOrdersRepo();
    const s = new CryptoOrdersService({ repo, nowFn: () => now });
    await s.create({
      order_id: 'ord_a',
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'USD',
    });
    await s.create({
      order_id: 'ord_b',
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'USD',
    });
    now += 25 * 60 * 60 * 1000; // > 24h
    await s.sweepExpiredOrders({ olderThanMs: 24 * 60 * 60 * 1000 });
    const a = await s.getById('ord_a');
    const b = await s.getById('ord_b');
    expect(a?.events.map((e) => e.source)).toEqual(['create', 'swept']);
    expect(b?.events.map((e) => e.source)).toEqual(['create', 'swept']);
  });

  it('getOrderEvents returns null for unknown order ids', async () => {
    const { svc: s } = svc();
    expect(await s.getOrderEvents('ord_nope')).toBeNull();
  });

  it('getOrderEvents returns the full append-only timeline', async () => {
    const { svc: s } = svc();
    await s.create({
      order_id: 'ord_a',
      account_id: 'acc',
      product: 'p',
      price_cents: 100,
      price_currency: 'USD',
    });
    await s.applyIpnStatus({
      order_id: 'ord_a',
      payment_id: 'np_1',
      provider_status: 'finished',
    });
    const events = await s.getOrderEvents('ord_a');
    expect(events?.map((e) => `${e.source}:${e.status}`)).toEqual(['create:pending', 'ipn:paid']);
  });
});

describe('C3 — refund/failure IPN after paid auto-claws-back the tier (non-stranding)', () => {
  it('logs the WARN note, invokes the tier clawback, leaves the order paid, and does not re-fire failed side-effects', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const warns: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const failedWebhooks: string[] = [];
    const clawbackCalls: Array<{ account_id: string; order_id: string; at: Date }> = [];
    const revokeTierForRefundedOrder = (args: {
      account_id: string;
      order_id: string;
      at: Date;
    }) => {
      clawbackCalls.push(args);
      return Promise.resolve({ revoked: true });
    };
    const svc = new CryptoOrdersService({
      repo,
      nowFn: () => 9_000,
      logger: {
        warn: (obj, msg) => warns.push({ obj, msg }),
        error: () => undefined,
      },
      tierActivator: {
        activateTierForPaidOrder: () => Promise.resolve(),
        revokeTierForRefundedOrder,
      },
      webhooks: {
        enqueueEvent: (accountId, eventType) => {
          if (eventType === 'crypto.order.failed') failedWebhooks.push(accountId);
          return Promise.resolve(0);
        },
      },
    });
    await svc.create({
      order_id: 'ord_refund',
      account_id: 'acc_r',
      product: 'solo_manual',
      price_cents: 7900,
      price_currency: 'USD',
    });
    // Drive to paid.
    await svc.applyIpnStatus({
      order_id: 'ord_refund',
      payment_id: 'np1',
      provider_status: 'finished',
    });
    // A refund IPN for the SAME payment arrives after paid.
    const after = await svc.applyIpnStatus({
      order_id: 'ord_refund',
      payment_id: 'np1',
      provider_status: 'refunded',
    });

    // The order stays paid (terminal-forward) but the tier is auto-clawed-back.
    expect(after?.status).toBe('paid');
    // The ops visibility note fired (now a WARN, not an error).
    const note = warns.find((e) => e.obj.event === 'ipn_refund_after_paid');
    expect(note, 'ipn_refund_after_paid note must fire').toBeDefined();
    expect(note?.obj.order_id).toBe('ord_refund');
    expect(note?.obj.account_id).toBe('acc_r');
    expect(note?.obj.provider_status).toBe('refunded');
    // The clawback was invoked with the account + order + refund moment.
    expect(clawbackCalls).toHaveLength(1);
    expect(clawbackCalls[0]?.account_id).toBe('acc_r');
    expect(clawbackCalls[0]?.order_id).toBe('ord_refund');
    expect(clawbackCalls[0]?.at.getTime()).toBe(9_000);
    // No failed side-effects re-fire (paid is terminal-forward).
    expect(failedWebhooks).toEqual([]);
  });

  it('a clawback failure is swallowed (IPN still acks) and logs the integrity alarm', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const errors: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const svc = new CryptoOrdersService({
      repo,
      nowFn: () => 9_000,
      logger: {
        warn: () => undefined,
        error: (obj, msg) => errors.push({ obj, msg }),
      },
      tierActivator: {
        activateTierForPaidOrder: () => Promise.resolve(),
        revokeTierForRefundedOrder: () => Promise.reject(new Error('db down')),
      },
    });
    await svc.create({
      order_id: 'ord_refund_fail',
      account_id: 'acc_rf',
      product: 'solo_manual',
      price_cents: 7900,
      price_currency: 'USD',
    });
    await svc.applyIpnStatus({
      order_id: 'ord_refund_fail',
      payment_id: 'npf',
      provider_status: 'finished',
    });
    // The clawback rejects, but the IPN still resolves (200 ack) with the order paid.
    const after = await svc.applyIpnStatus({
      order_id: 'ord_refund_fail',
      payment_id: 'npf',
      provider_status: 'refunded',
    });
    expect(after?.status).toBe('paid');
    const alarm = errors.find((e) => e.obj.event === 'crypto_refund_tier_clawback_failed');
    expect(alarm, 'clawback-failed integrity alarm must fire').toBeDefined();
    expect(alarm?.obj.order_id).toBe('ord_refund_fail');
    expect(alarm?.obj.account_id).toBe('acc_rf');
  });

  it('a refund on a PENDING order still transitions normally to failed (no note, no clawback)', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    const warns: Array<{ obj: Record<string, unknown> }> = [];
    const clawbackCalls: unknown[] = [];
    const svc = new CryptoOrdersService({
      repo,
      nowFn: () => 9_000,
      logger: {
        warn: (obj) => warns.push({ obj }),
        error: () => undefined,
      },
      tierActivator: {
        activateTierForPaidOrder: () => Promise.resolve(),
        revokeTierForRefundedOrder: (args) => {
          clawbackCalls.push(args);
          return Promise.resolve({ revoked: false });
        },
      },
    });
    await svc.create({
      order_id: 'ord_pending_refund',
      account_id: 'acc_p',
      product: 'solo_manual',
      price_cents: 7900,
      price_currency: 'USD',
    });
    const after = await svc.applyIpnStatus({
      order_id: 'ord_pending_refund',
      payment_id: 'np2',
      provider_status: 'refunded',
    });
    expect(after?.status).toBe('failed');
    // Not an after-paid refund → no visibility note and no clawback attempt.
    expect(warns.find((e) => e.obj.event === 'ipn_refund_after_paid')).toBeUndefined();
    expect(clawbackCalls).toHaveLength(0);
  });
});

// V-725 — the body-fingerprint check on the path that actually serves most
// replays in production.
//
// Every V-666.AR test above reuses ONE service instance, so every replay is
// answered by the in-process cache, where the fingerprint has always been
// available. The DATABASE replay path had no fingerprint to compare and
// returned `bodyFingerprintMismatch: false` unconditionally — not a cautious
// default but a false statement, since nothing had been compared.
//
// That path is not an edge case: the cache is empty after every restart and
// every deploy, so within the 24h idempotency window every replay is served
// from the repo. The ops warn log that is this contract's only mitigation for
// accidental key reuse was therefore dark exactly where it was needed. A fresh
// service over a shared repo reproduces a restart precisely.
describe('V-725 createIdempotent body fingerprint across a restart (repo-served replay)', () => {
  const ARGS = {
    idempotency_key: 'k-restart',
    account_id: 'acc',
    product: 'team_growth',
    price_cents: 4900,
    price_currency: 'USD',
  };

  it('detects a changed body on a replay served by the repo, not the cache', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    await new CryptoOrdersService({ repo }).createIdempotent({ ...ARGS, order_id: 'ord_a' });

    // Restart: a brand-new service, empty cache, same durable repo.
    const afterRestart = new CryptoOrdersService({ repo });
    const r = await afterRestart.createIdempotent({
      ...ARGS,
      order_id: 'ord_b',
      price_cents: 9900, // different intent, same key
    });

    expect(r.replayed).toBe(true);
    expect(r.bodyFingerprintMismatch).toBe(true);
    expect(afterRestart.getIdempotencyMetrics().bodyMismatches).toBe(1);
    // Contract is unchanged: still a replay of the ORIGINAL order.
    expect(r.order.order_id).toBe('ord_a');
    expect(r.order.price_cents).toBe(4900);
  });

  it('does not cry mismatch for an identical body across a restart', async () => {
    const repo = new InMemoryCryptoOrdersRepo();
    await new CryptoOrdersService({ repo }).createIdempotent({ ...ARGS, order_id: 'ord_a' });

    const afterRestart = new CryptoOrdersService({ repo });
    const r = await afterRestart.createIdempotent({ ...ARGS, order_id: 'ord_b' });

    expect(r.replayed).toBe(true);
    expect(r.bodyFingerprintMismatch).toBe(false);
    expect(afterRestart.getIdempotencyMetrics().bodyMismatches).toBe(0);
  });

  it('treats a row with no recorded fingerprint as unknown, never as a match', async () => {
    // Rows written before migration 0110 have a NULL fingerprint. Unknown is
    // not a proven mismatch, so the order still replays without a warning — but
    // the service must reach that answer from the NULL, not by assuming.
    const existing = {
      order_id: 'ord_legacy',
      account_id: 'acc',
      product: 'team_growth',
      price_cents: 4900,
      price_currency: 'USD',
      payment_id: null,
      pay_amount: null,
      pay_currency: null,
      status: 'pending' as const,
      customer_note: null,
      internal_note: null,
      events: [],
      created_at: 1,
      updated_at: 1,
    };
    const repo: CryptoOrdersRepo = {
      upsert: () => Promise.resolve(),
      getById: (id: string) => Promise.resolve(id === 'ord_legacy' ? existing : null),
      insertWithIdempotencyKey: () =>
        Promise.resolve({ order: existing, replayed: true, storedFingerprint: null }),
      withOrderLock: () => Promise.resolve(null),
      listExpiredPending: () => Promise.resolve([]),
      listByAccount: () => Promise.resolve([]),
    } as unknown as CryptoOrdersRepo;

    const svc = new CryptoOrdersService({ repo });
    const r = await svc.createIdempotent({ ...ARGS, order_id: 'ord_new', price_cents: 9900 });

    expect(r.replayed).toBe(true);
    expect(r.bodyFingerprintMismatch).toBe(false);
    expect(svc.getIdempotencyMetrics().bodyMismatches).toBe(0);
  });
});

// V-1406 — `decodeCursor` had no behavioural test at all. It is exported, its doc says
// production treats cursors as opaque strings, and `services-crypto-orders-content-parity`
// pins the phrase "decodeCursor null on malformed" as SOURCE TEXT — but nothing ever called
// it with anything malformed. Coverage agreed: BOTH of its refusal arms, the shape check and
// the field-type check, had never been taken, and the file imported `encodeCursor` only.
//
// The cursor arrives as an admin `?cursor=` parameter, so its bytes are chosen by the caller.
// `Buffer.from(token, 'base64url')` does not reject bad input, so `JSON.parse` sees whatever
// decodes, and the field-type check is what stands between that and a returned object whose
// `ts` is a string or `undefined`.
//
// Scope, stated honestly: at the SERVICE level this is not a customer-visible bug today.
// `listForAdminPage` turns a null cursor into an empty page, and a malformed-but-returned
// cursor would fail the anchor lookup and produce the same empty page. What is pinned here is
// the exported function's own contract, which until now existed only as a regex over its source.
describe('V-666.AM decodeCursor — the malformed inputs its contract names', () => {
  it('CONTROL a cursor produced by encodeCursor round-trips, so the arms below are not satisfied by a decoder that returns null for everything', () => {
    const decoded = decodeCursor(encodeCursor({ ts: 1_715_000_000_000, id: 'ord_abc123' }));
    expect(decoded).toEqual({ ts: 1_715_000_000_000, id: 'ord_abc123' });
  });

  const decode = (json: string): unknown =>
    decodeCursor(Buffer.from(json, 'utf8').toString('base64url'));

  it.each([
    ['an array carrying the right values positionally', '[1715000000000,"ord_abc123"]'],
    ['ts as a string', '{"ts":"1715000000000","id":"ord_abc123"}'],
    ['ts as null', '{"ts":null,"id":"ord_abc123"}'],
    ['no id at all', '{"ts":1715000000000}'],
    ['id as a number', '{"ts":1715000000000,"id":42}'],
  ])(
    'CRITICAL a cursor object with %s decodes to null. This is the FIELD-TYPE check specifically: the payload is an object, so it clears the shape check above and nothing else refuses it — without this line the decoder hands back a value typed CryptoOrderCursor whose ts or id is undefined or the wrong type, which is exactly what that type says cannot happen.',
    (_label, json) => {
      expect(decode(json)).toBeNull();
    },
  );

  it.each([
    ['a JSON number', '4242'],
    ['a JSON string', '"ord_abc123"'],
    ['a JSON boolean', 'true'],
  ])(
    'CRITICAL a cursor whose payload is %s decodes to null. Attribution here is to the PAIR, not one line: the shape check answers it first, and with that line gone the field-type check answers instead — both must be absent for a primitive to escape. The arm asserts the outcome the contract names rather than crediting either check.',
    (_label, json) => {
      expect(decode(json)).toBeNull();
    },
  );

  it('CRITICAL a token that is not base64url-decodable JSON also yields null rather than throwing, since the value comes straight off the query string', () => {
    expect(decodeCursor('not-a-cursor')).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });
});
