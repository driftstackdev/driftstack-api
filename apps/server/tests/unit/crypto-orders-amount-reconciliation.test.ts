// Billing-integrity — crypto IPN amount reconciliation (#1) + payment_id
// binding (#9).
//
// #1: an order is only flipped to 'paid' when the IPN's CRYPTO-denominated
// actually_paid is >= the CRYPTO-denominated amount owed (pay_amount, within a
// small tolerance) — BOTH in pay_currency (e.g. BTC). A full crypto payment of
// the quoted pay_amount unlocks; an under-payment ('finished' but short) routes
// to 'partial', never 'paid'. We never compare against the FIAT price_amount
// (incomparable units — that left every full crypto payment stuck 'partial').
// price_amount is persisted on the audit event for support reference only.
//
// MUTATION-PROVED 2026-08-16 against services/crypto-orders.ts, whole node
// project, tsc exit 0. Making the short-payment branch unreachable — so an
// under-payment is never short and flips the order to 'paid' — reds only 3, and
// the spread is the point:
//
//   unit/crypto-orders-amount-reconciliation (this file)   1 red
//   integration/crypto-order-paid-tier-activation          1 red
//   unit/services-crypto-orders-content-parity             1 red
//
// One behavioural unit arm, one end-to-end arm, one source-text pin. Delete this
// file and the check survives on the integration arm alone, with a pin that
// would go green again the moment someone rewrites the comparison rather than
// removes it. That is thin for the gate deciding whether an under-payment buys a
// tier, and it is thin because the interesting cases are arithmetic —
// unit-mismatch, tolerance edges, zero and missing amounts — which an
// end-to-end test is a poor place to enumerate. Add arithmetic cases HERE.
//
// V-743: a settled payment that lands on an order the expiry sweep already
// flipped to 'failed' (or that the customer cancelled) is deliberately NOT
// applied — but it now raises an integrity alarm, because the money is real and
// nothing else in the system records that it went nowhere.
//
// #9: the NowPayments payment_id is bound to the order at createPayment
// (recordPaymentId). applyIpnStatus rejects + alarms when an IPN's
// payment_id doesn't match the stored one (guards the admin apply-ipn
// path where an operator supplies the payment_id by hand).

import { describe, expect, it, vi } from 'vitest';
import {
  CryptoOrdersService,
  InMemoryCryptoOrdersRepo,
  type CryptoOrderPaidEmailNotifier,
} from '../../src/services/crypto-orders.js';

// A realistic $99 order quoted as 0.0015 BTC. price_amount in the IPN is FIAT
// (99.0 USD); pay_amount + actually_paid are CRYPTO (BTC) — incomparable units.
const ORDER_PRICE_AMOUNT_FIAT = 99.0;
const ORDER_PAY_AMOUNT_BTC = 0.0015;

async function seed(opts?: {
  paidNotifier?: CryptoOrderPaidEmailNotifier;
  logger?: { error: (obj: Record<string, unknown>, msg: string) => void };
  /** Bind the crypto-denominated quote (payment_id + pay_amount + pay_currency)
   *  on the order, mirroring the billing-crypto createPayment recordPaymentId
   *  call. Default false (the #9 tests bind their own payment_id). */
  bindQuote?: boolean;
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
    // price_cents is the fiat price (9900 = $99.00); the IPN's price_amount
    // mirrors it in major units (99.0 USD).
    price_cents: 9900,
    price_currency: 'USD',
  });
  if (opts?.bindQuote === true) {
    // recordPaymentId binds payment_id + the crypto-denominated quote at
    // createPayment time, exactly as the billing-crypto route does.
    await svc.recordPaymentId({
      order_id: 'ord_t',
      payment_id: 'np_p',
      pay_amount: ORDER_PAY_AMOUNT_BTC,
      pay_currency: 'btc',
    });
  }
  return { svc, repo };
}

describe('crypto IPN amount reconciliation (#1, crypto-denominated)', () => {
  it('flips to PAID when the full crypto pay_amount is received (0.0015 BTC paid for a $99 order)', async () => {
    const { svc } = await seed();
    const updated = await svc.applyIpnStatus({
      order_id: 'ord_t',
      payment_id: 'np_p',
      provider_status: 'finished',
      // actually_paid is in BTC (pay_currency), matching pay_amount.
      actually_paid: ORDER_PAY_AMOUNT_BTC,
      pay_amount: ORDER_PAY_AMOUNT_BTC,
      price_amount: ORDER_PRICE_AMOUNT_FIAT,
      pay_currency: 'btc',
    });
    expect(updated?.status).toBe('paid');
  });

  it('routes a HALF-PAY (finished but actually_paid < pay_amount) to PARTIAL, never paid', async () => {
    const paidNotifier: CryptoOrderPaidEmailNotifier = {
      notifyOrderPaid: vi.fn(() => Promise.resolve()),
    };
    const { svc } = await seed({ paidNotifier });
    const updated = await svc.applyIpnStatus({
      order_id: 'ord_t',
      payment_id: 'np_p',
      provider_status: 'finished',
      actually_paid: ORDER_PAY_AMOUNT_BTC / 2, // half the owed BTC
      pay_amount: ORDER_PAY_AMOUNT_BTC,
      price_amount: ORDER_PRICE_AMOUNT_FIAT,
      pay_currency: 'btc',
    });
    expect(updated?.status).toBe('partial');
    // The paid receipt/webhook side-effect must NOT fire for a short-pay.
    expect(paidNotifier.notifyOrderPaid).not.toHaveBeenCalled();
  });

  it('reconciles against the order-bound pay_amount when the IPN omits it', async () => {
    const { svc } = await seed({ bindQuote: true });
    // No pay_amount on the IPN — falls back to the quote bound at createPayment.
    const updated = await svc.applyIpnStatus({
      order_id: 'ord_t',
      payment_id: 'np_p',
      provider_status: 'finished',
      actually_paid: ORDER_PAY_AMOUNT_BTC,
      price_amount: ORDER_PRICE_AMOUNT_FIAT,
      pay_currency: 'btc',
    });
    expect(updated?.status).toBe('paid');
  });

  it('tolerates a tiny under-payment within the rounding tolerance (still paid)', async () => {
    const { svc } = await seed();
    // 0.0015 * (1 - 0.005) = 0.0014925 — within the 1% tolerance.
    const updated = await svc.applyIpnStatus({
      order_id: 'ord_t',
      payment_id: 'np_p',
      provider_status: 'finished',
      actually_paid: ORDER_PAY_AMOUNT_BTC * 0.995,
      pay_amount: ORDER_PAY_AMOUNT_BTC,
      pay_currency: 'btc',
    });
    expect(updated?.status).toBe('paid');
  });

  it('does NOT compare crypto actually_paid against the fiat price_amount (the unit bug)', async () => {
    // The regression: actually_paid=0.0015 BTC vs price_amount=99.0 USD would
    // (under the old code) look like a massive short-pay → 'partial'. With the
    // fix it reconciles BTC-vs-BTC and unlocks.
    const { svc } = await seed();
    const updated = await svc.applyIpnStatus({
      order_id: 'ord_t',
      payment_id: 'np_p',
      provider_status: 'finished',
      actually_paid: ORDER_PAY_AMOUNT_BTC,
      pay_amount: ORDER_PAY_AMOUNT_BTC,
      price_amount: ORDER_PRICE_AMOUNT_FIAT, // fiat — must be ignored for reconciliation
      pay_currency: 'btc',
    });
    expect(updated?.status).toBe('paid');
  });

  it('routes a pay_currency MISMATCH to partial + raises an integrity alarm (never unlocks)', async () => {
    const logger = { error: vi.fn() };
    const paidNotifier: CryptoOrderPaidEmailNotifier = {
      notifyOrderPaid: vi.fn(() => Promise.resolve()),
    };
    const { svc } = await seed({ logger, paidNotifier, bindQuote: true });
    const updated = await svc.applyIpnStatus({
      order_id: 'ord_t',
      payment_id: 'np_p',
      provider_status: 'finished',
      // Enough ETH to look "paid" by magnitude, but the order is quoted in BTC.
      actually_paid: ORDER_PAY_AMOUNT_BTC,
      pay_amount: ORDER_PAY_AMOUNT_BTC,
      pay_currency: 'eth', // ≠ the order's bound 'btc'
    });
    expect(updated?.status).toBe('partial');
    expect(paidNotifier.notifyOrderPaid).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]?.[1]).toMatch(/pay_currency does not match/);
  });

  it('persists the reconciliation amounts (crypto + fiat audit ref) on the transition event for support', async () => {
    const { svc } = await seed();
    const updated = await svc.applyIpnStatus({
      order_id: 'ord_t',
      payment_id: 'np_p',
      provider_status: 'partially_paid',
      actually_paid: ORDER_PAY_AMOUNT_BTC / 3,
      pay_amount: ORDER_PAY_AMOUNT_BTC,
      price_amount: ORDER_PRICE_AMOUNT_FIAT,
      pay_currency: 'btc',
    });
    const partialEvent = updated?.events.find((e) => e.status === 'partial');
    expect(partialEvent?.actually_paid).toBe(ORDER_PAY_AMOUNT_BTC / 3);
    expect(partialEvent?.pay_amount).toBe(ORDER_PAY_AMOUNT_BTC);
    // price_amount is kept on the event as a FIAT audit reference only.
    expect(partialEvent?.price_amount).toBe(ORDER_PRICE_AMOUNT_FIAT);
    expect(partialEvent?.pay_currency).toBe('btc');
  });

  it('preserves the prior status-only behaviour when amounts are omitted (admin replay / legacy)', async () => {
    const { svc } = await seed({ bindQuote: false });
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
      pay_amount: null,
      pay_currency: null,
      status: 'pending' as const,
      customer_note: null,
      internal_note: null,
      events: [{ status: 'pending' as const, at: 1, source: 'create' as const }],
      created_at: 1,
      updated_at: 1,
    };
    const first = await repo.insertWithIdempotencyKey(
      { ...base, order_id: 'ord_a' },
      'acc:key1',
      'fp-a',
    );
    expect(first.replayed).toBe(false);
    // A SECOND insert with the SAME scoped key (e.g. a retry on another
    // instance that minted a different order_id) is deduped to the FIRST order.
    const second = await repo.insertWithIdempotencyKey(
      { ...base, order_id: 'ord_b' },
      'acc:key1',
      'fp-a',
    );
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

// V-743 — a SETTLED payment that lands on an order the expiry sweep already
// flipped to 'failed'. The refusal to apply it is deliberate (isTerminalForward:
// "a late IPN payment cannot revive an abandoned order"), and these tests pin
// that money semantic unchanged. What they add is the ALARM: without it the
// customer's funds settle on-chain and nothing anywhere asks a human to refund
// or grant, because events are appended only on an actual status change.
describe('settled payment dropped on a terminal order (V-743)', () => {
  it('alarms when a settled IPN lands on an order the sweep already expired', async () => {
    const logger = { error: vi.fn() };
    const { svc, repo } = await seed({ logger, bindQuote: true });
    // The real-world path: the sweep expires the pending order first.
    const expired = await svc.expireOrder({ order_id: 'ord_t', olderThanMs: 0 });
    expect(expired?.status).toBe('failed');

    const result = await svc.applyIpnStatus({
      order_id: 'ord_t',
      payment_id: 'np_p',
      provider_status: 'finished',
      actually_paid: ORDER_PAY_AMOUNT_BTC,
      pay_amount: ORDER_PAY_AMOUNT_BTC,
      price_amount: ORDER_PRICE_AMOUNT_FIAT,
      pay_currency: 'btc',
    });

    // Money semantics UNCHANGED: the dead order is not revived. applyIpnStatus
    // returns the order UNCHANGED (so the route acks and NowPayments stops
    // retrying) — 'failed' here is the pre-IPN status, not a new write.
    expect(result?.status).toBe('failed');
    expect((await repo.getById('ord_t'))?.status).toBe('failed');

    // ...but it is no longer silent, and the alarm carries what a human needs to
    // act (which account, how much actually arrived, what it was owed).
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [obj, msg] = logger.error.mock.calls[0] ?? [];
    expect(msg).toMatch(/refund or grant manually/);
    expect(obj).toMatchObject({
      event: 'ipn_settled_payment_dropped_on_terminal_order',
      order_id: 'ord_t',
      account_id: 'acc_a',
      order_status: 'failed',
      actually_paid: ORDER_PAY_AMOUNT_BTC,
      price_cents: 9900,
    });
  });

  it('does NOT alarm on a duplicate IPN for an order that already paid legitimately', async () => {
    const logger = { error: vi.fn() };
    const { svc } = await seed({ logger, bindQuote: true });
    const args = {
      order_id: 'ord_t',
      payment_id: 'np_p',
      provider_status: 'finished',
      actually_paid: ORDER_PAY_AMOUNT_BTC,
      pay_amount: ORDER_PAY_AMOUNT_BTC,
      price_amount: ORDER_PRICE_AMOUNT_FIAT,
      pay_currency: 'btc',
    };
    expect((await svc.applyIpnStatus(args))?.status).toBe('paid');
    // NowPayments retries; the second delivery is a benign idempotent touch, not
    // dropped money. Alarming here would train support to ignore the alarm.
    expect((await svc.applyIpnStatus(args))?.status).toBe('paid');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('ALSO alarms when a settled IPN lands on a customer-cancelled order', async () => {
    const logger = { error: vi.fn() };
    const { svc, repo } = await seed({ logger, bindQuote: true });
    // V-666.J names 'cancelled' alongside 'failed' as terminal, so this is the
    // second way real money lands on a dead order.
    const cancelled = await svc.cancelOrder({ order_id: 'ord_t', account_id: 'acc_a' });
    expect(cancelled?.ok).toBe('cancelled');

    const result = await svc.applyIpnStatus({
      order_id: 'ord_t',
      payment_id: 'np_p',
      provider_status: 'finished',
      actually_paid: ORDER_PAY_AMOUNT_BTC,
      pay_amount: ORDER_PAY_AMOUNT_BTC,
      price_amount: ORDER_PRICE_AMOUNT_FIAT,
      pay_currency: 'btc',
    });
    expect(result?.status).toBe('cancelled');
    expect((await repo.getById('ord_t'))?.status).toBe('cancelled');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]?.[0]).toMatchObject({
      event: 'ipn_settled_payment_dropped_on_terminal_order',
      order_status: 'cancelled',
    });
  });

  // The negative direction. This one is mutation-load-bearing: it reaches the
  // SAME non-forward return as the alarm above (a terminal order + a status that
  // is not a forward move), so hard-coding the flag to `true` reds it. An
  // over-eager alarm is a real cost here — it would page support for a stray
  // provider retry and train them to ignore the one that matters.
  it('does NOT alarm when a non-settled IPN lands on an already-paid order', async () => {
    const logger = { error: vi.fn() };
    const { svc } = await seed({ logger, bindQuote: true });
    const paidArgs = {
      order_id: 'ord_t',
      payment_id: 'np_p',
      provider_status: 'finished',
      actually_paid: ORDER_PAY_AMOUNT_BTC,
      pay_amount: ORDER_PAY_AMOUNT_BTC,
      price_amount: ORDER_PRICE_AMOUNT_FIAT,
      pay_currency: 'btc',
    };
    expect((await svc.applyIpnStatus(paidArgs))?.status).toBe('paid');

    // A stray 'expired' arrives after settlement (maps to 'failed'): terminal
    // 'paid' refuses it, so it takes the drop path — but no money went missing.
    const result = await svc.applyIpnStatus({
      ...paidArgs,
      provider_status: 'expired',
      actually_paid: 0,
    });
    expect(result?.status).toBe('paid');
    expect(logger.error).not.toHaveBeenCalled();
  });
});
