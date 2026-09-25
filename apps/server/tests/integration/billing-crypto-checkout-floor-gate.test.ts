// V-666.SEC — crypto-checkout NowPayments floor gate. The existing
// billing-crypto-checkout suite runs without a NowPayments client wired
// (deps.nowpayments undefined), so its "stub" assertions never exercise
// the floor gate. This wires a mock client and pins the two branches of
//   `nowpayments !== undefined && ipnCallbackUrl !== undefined &&
//    serverPriceCents >= NOWPAYMENTS_MIN_USD_CENTS`
// : a below-floor product (trial_pack, $2.99) must short-circuit to the
// stub posture WITHOUT calling NowPayments (keeps trial-pack off crypto,
// avoids surfacing amount_too_low), and an above-floor product mints a
// real NowPayments payment.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import type { NowPaymentsApiClient, CreatePaymentResult } from '../../src/lib/nowpayments-api.js';
import { PAYMENT_MINT_CLAIM_STALE_AFTER_MS } from '../../src/services/crypto-orders.js';

function mockNowpayments(): {
  client: NowPaymentsApiClient;
  createPayment: ReturnType<typeof vi.fn>;
} {
  const createPayment = vi.fn(
    (): Promise<CreatePaymentResult> =>
      Promise.resolve({
        paymentId: 'pay_test_1',
        payAddress: '0xPAYADDRESS',
        payCurrency: 'btc',
        payAmount: 0.0012,
        priceAmount: 79,
        priceCurrency: 'usd',
        paymentStatus: 'waiting',
      }),
  );
  return { client: { createPayment } as unknown as NowPaymentsApiClient, createPayment };
}

describe('crypto checkout NowPayments floor gate (V-666.SEC)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    vi.useRealTimers();
    if (fx) await fx.cleanup();
  });

  // 2026-05-27 — the below-floor branch is no longer reachable via the
  // product catalog: trial_pack ($2.99, the only sub-$19.16 product) was
  // retired and every remaining paid tier is ≥ $79 (above the floor). The
  // defensive `amount < NOWPAYMENTS_MIN_USD_CENTS` short-circuit stays in
  // the route but has no product that triggers it, so its dedicated test
  // was removed. The above-floor path below remains the live behaviour.
  it('rejects acting-as checkout before pricing, order persistence, or provider side effects', async () => {
    const { client, createPayment } = mockNowpayments();
    fx = await buildTestApp({ nowpaymentsClient: client });
    const pricingRead = vi.spyOn(fx.pricingService, 'listEffective');
    const idempotentCreate = vi.spyOn(fx.cryptoOrdersService, 'createIdempotent');
    const plainCreate = vi.spyOn(fx.cryptoOrdersService, 'create');

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': 'acc_00000000-0000-4000-8000-000000000001',
        'idempotency-key': 'must-not-be-consumed',
      },
      payload: { product: 'solo_manual', price_cents: 7900, price_currency: 'USD' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ detail: string }>().detail).toMatch(/Self workspace/i);
    expect(pricingRead).not.toHaveBeenCalled();
    expect(idempotentCreate).not.toHaveBeenCalled();
    expect(plainCreate).not.toHaveBeenCalled();
    expect(createPayment).not.toHaveBeenCalled();
    expect(await fx.cryptoOrdersRepo.listAll()).toEqual([]);
  });

  it('above-floor product (solo_manual) → provider nowpayments, createPayment called once', async () => {
    const { client, createPayment } = mockNowpayments();
    fx = await buildTestApp({ nowpaymentsClient: client });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { product: 'solo_manual', price_cents: 7900, price_currency: 'USD' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ provider: string; payment_address: string | null }>();
    expect(body.provider).toBe('nowpayments');
    expect(body.payment_address).toBe('0xPAYADDRESS');
    expect(createPayment).toHaveBeenCalledTimes(1);
  });

  it('above-floor product but NowPayments createPayment throws → soft-fails to stub, order still persists (V-666.D)', async () => {
    const createPayment = vi.fn(
      (): Promise<CreatePaymentResult> => Promise.reject(new Error('nowpayments 502')),
    );
    const client = { createPayment } as unknown as NowPaymentsApiClient;
    fx = await buildTestApp({ nowpaymentsClient: client });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { product: 'solo_manual', price_cents: 7900, price_currency: 'USD' },
    });
    // The upstream failure must not break checkout: the local order is
    // created (customer-trackable order_id) and the response degrades to
    // the stub posture rather than 5xx-ing.
    expect(res.statusCode).toBe(201);
    expect(createPayment).toHaveBeenCalledTimes(1);
    const body = res.json<{ provider: string; payment_address: string | null; order_id: string }>();
    expect(body.provider).toBe('stub');
    expect(body.payment_address).toBeNull();
    expect(body.order_id).toMatch(/^ord_/);
  });

  it('never exposes a minted address until that exact payment id is durably bound', async () => {
    // Security sweep #18 (residual): the first mint's claim holds off every retry
    // until it is stale, so the clock is moved past it before the retry that mints B.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    let mint = 0;
    const createPayment = vi.fn((): Promise<CreatePaymentResult> => {
      mint += 1;
      return Promise.resolve({
        paymentId: `pay_bind_${mint}`,
        payAddress: `0xBIND${mint}`,
        payCurrency: 'btc',
        payAmount: 0.0012,
        priceAmount: 79,
        priceCurrency: 'usd',
        paymentStatus: 'waiting',
      });
    });
    const client = { createPayment } as unknown as NowPaymentsApiClient;
    fx = await buildTestApp({ nowpaymentsClient: client });
    vi.spyOn(fx.cryptoOrdersService, 'recordPaymentId').mockRejectedValueOnce(
      new Error('database write lost'),
    );
    const payload = { product: 'solo_manual', price_cents: 7900, price_currency: 'USD' };
    const headers = {
      authorization: `Bearer ${fx.plaintext}`,
      'idempotency-key': 'k-bind-before-expose',
    };

    const first = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers,
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(first.json<{ provider: string; payment_address: string | null }>()).toMatchObject({
      provider: 'stub',
      payment_address: null,
    });

    // The customer never received orphan A. A same-key retry while A's claim is
    // fresh mints nothing: A's server may still be binding it.
    const early = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers,
      payload,
    });
    expect(early.statusCode).toBe(201);
    expect(early.json<{ provider: string; payment_address: string | null }>()).toMatchObject({
      provider: 'stub',
      payment_address: null,
    });
    expect(createPayment).toHaveBeenCalledTimes(1);

    // Once A's claim is stale with nothing bound, a same-key retry may mint B, but
    // B becomes payable only after the original service method binds it.
    vi.setSystemTime(Date.now() + PAYMENT_MINT_CLAIM_STALE_AFTER_MS + 1);
    const replay = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers,
      payload,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('1');
    expect(replay.json<{ provider: string; payment_address: string | null }>()).toMatchObject({
      provider: 'nowpayments',
      payment_address: '0xBIND2',
    });
    expect(createPayment).toHaveBeenCalledTimes(2);
  });

  it('returns the authoritative status observed by payment binding instead of the stale create snapshot', async () => {
    const { client } = mockNowpayments();
    fx = await buildTestApp({ nowpaymentsClient: client });
    vi.spyOn(fx.cryptoOrdersService, 'recordPaymentId').mockImplementationOnce(async (args) => {
      const current = await fx.cryptoOrdersService.getById(args.order_id);
      if (current === null) throw new Error('test order missing');
      return {
        ...current,
        payment_id: args.payment_id,
        status: 'confirming',
      };
    });

    const response = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { product: 'solo_manual', price_cents: 7900, price_currency: 'USD' },
    });

    expect(response.statusCode).toBe(201);
    expect(
      response.json<{ status: string; provider: string; payment_address: string | null }>(),
    ).toMatchObject({
      status: 'confirming',
      provider: 'stub',
      payment_address: null,
    });
  });

  it('idempotency REPLAY does NOT re-mint a NowPayments payment; echoes the ORIGINAL address via getPayment (billing re-audit 2026-07-02)', async () => {
    const createPayment = vi.fn(
      (): Promise<CreatePaymentResult> =>
        Promise.resolve({
          paymentId: 'pay_orig',
          payAddress: '0xORIGADDR',
          payCurrency: 'btc',
          payAmount: 0.0012,
          priceAmount: 79,
          priceCurrency: 'usd',
          paymentStatus: 'waiting',
        }),
    );
    const getPayment = vi.fn(() =>
      Promise.resolve({
        paymentStatus: 'waiting',
        payAddress: '0xORIGADDR',
        payCurrency: 'btc',
        payAmount: 0.0012,
      }),
    );
    const client = { createPayment, getPayment } as unknown as NowPaymentsApiClient;
    fx = await buildTestApp({ nowpaymentsClient: client });
    const payload = { product: 'solo_manual', price_cents: 7900, price_currency: 'USD' };
    const headers = {
      authorization: `Bearer ${fx.plaintext}`,
      'idempotency-key': 'k-crypto-replay-1',
    };

    const first = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers,
      payload,
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<{
      order_id: string;
      provider: string;
      payment_address: string | null;
    }>();
    expect(firstBody.provider).toBe('nowpayments');
    expect(firstBody.payment_address).toBe('0xORIGADDR');
    expect(createPayment).toHaveBeenCalledTimes(1);

    // Retry with the SAME idempotency key (e.g. the first response was lost).
    const second = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers,
      payload,
    });
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('1');
    const secondBody = second.json<{
      order_id: string;
      provider: string;
      payment_address: string | null;
    }>();
    expect(secondBody.order_id).toBe(firstBody.order_id);
    // CRITICAL: the replay must NOT re-mint (a second payment would bind a new
    // payment_id the order never adopts → the customer pays a mismatched address
    // whose IPN is rejected → lost crypto). createPayment stays at ONE call; the
    // original address is echoed via getPayment(the order's bound payment_id).
    expect(createPayment).toHaveBeenCalledTimes(1);
    expect(getPayment).toHaveBeenCalledWith('pay_orig');
    expect(secondBody.provider).toBe('nowpayments');
    expect(secondBody.payment_address).toBe('0xORIGADDR');
  });

  it('C7 — a replay whose bound payment is no longer waiting (expired/dead) is NOT re-surfaced as payable', async () => {
    const createPayment = vi.fn(
      (): Promise<CreatePaymentResult> =>
        Promise.resolve({
          paymentId: 'pay_c7',
          payAddress: '0xLIVEADDR',
          payCurrency: 'btc',
          payAmount: 0.0012,
          priceAmount: 79,
          priceCurrency: 'usd',
          paymentStatus: 'waiting',
        }),
    );
    // By the time of the replay the bound payment has EXPIRED — its address
    // is dead. NowPayments reports it as such.
    const getPayment = vi.fn(() =>
      Promise.resolve({
        paymentStatus: 'expired',
        payAddress: '0xDEADADDR',
        payCurrency: 'btc',
        payAmount: 0.0012,
      }),
    );
    const client = { createPayment, getPayment } as unknown as NowPaymentsApiClient;
    fx = await buildTestApp({ nowpaymentsClient: client });
    const payload = { product: 'solo_manual', price_cents: 7900, price_currency: 'USD' };
    const headers = { authorization: `Bearer ${fx.plaintext}`, 'idempotency-key': 'k-c7-dead' };

    const first = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers,
      payload,
    });
    expect(first.json<{ payment_address: string | null }>().payment_address).toBe('0xLIVEADDR');

    const replay = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/crypto-checkout',
      headers,
      payload,
    });
    expect(replay.headers['idempotent-replayed']).toBe('1');
    const body = replay.json<{ provider: string; payment_address: string | null }>();
    // CRITICAL: the dead address must NOT be handed back — a customer paying
    // it would lose the crypto (the expired payment can never reconcile).
    expect(body.payment_address).toBeNull();
    expect(body.provider).toBe('stub');
    expect(createPayment).toHaveBeenCalledTimes(1); // never re-mints on replay
  });

  it.each([
    ['confirming', 'confirming'],
    ['partial', 'partially_paid'],
    ['paid', 'finished'],
    ['failed', 'failed'],
    ['cancelled', null],
  ] as const)(
    'a %s replay is non-minting and never exposes either the old or a newly orphaned address',
    async (expectedStatus, providerStatus) => {
      const paymentId = `pay_terminal_${expectedStatus}`;
      const createPayment = vi.fn(
        (): Promise<CreatePaymentResult> =>
          Promise.resolve({
            paymentId,
            payAddress: '0xTERMINAL_OLD_ADDRESS',
            payCurrency: 'btc',
            payAmount: 0.0012,
            priceAmount: 79,
            priceCurrency: 'usd',
            paymentStatus: 'waiting',
          }),
      );
      const getPayment = vi.fn(() =>
        Promise.resolve({
          paymentStatus: 'waiting',
          payAddress: '0xTERMINAL_OLD_ADDRESS',
          payCurrency: 'btc',
          payAmount: 0.0012,
        }),
      );
      const client = { createPayment, getPayment } as unknown as NowPaymentsApiClient;
      fx = await buildTestApp({ nowpaymentsClient: client });
      const headers = {
        authorization: `Bearer ${fx.plaintext}`,
        'idempotency-key': `terminal-replay-${expectedStatus}`,
      };
      const payload = { product: 'solo_manual', price_cents: 7900, price_currency: 'USD' };

      const first = await fx.app.inject({
        method: 'POST',
        url: '/v1/billing/crypto-checkout',
        headers,
        payload,
      });
      const firstBody = first.json<{ order_id: string; payment_address: string | null }>();
      expect(firstBody.payment_address).toBe('0xTERMINAL_OLD_ADDRESS');
      expect(createPayment).toHaveBeenCalledTimes(1);

      if (providerStatus === null) {
        const cancelled = await fx.cryptoOrdersService.cancelOrder({
          order_id: firstBody.order_id,
          account_id: fx.accountId,
        });
        expect(cancelled?.ok).toBe('cancelled');
      } else {
        const transitioned = await fx.cryptoOrdersService.applyIpnStatus({
          order_id: firstBody.order_id,
          payment_id: paymentId,
          provider_status: providerStatus,
        });
        expect(transitioned?.status).toBe(expectedStatus);
      }

      const replay = await fx.app.inject({
        method: 'POST',
        url: '/v1/billing/crypto-checkout',
        headers,
        payload,
      });
      expect(replay.statusCode).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('1');
      const replayBody = replay.json<{
        order_id: string;
        status: string;
        provider: string;
        payment_address: string | null;
        pay_currency: string | null;
        pay_amount: number | null;
      }>();
      expect(replayBody).toMatchObject({
        order_id: firstBody.order_id,
        status: expectedStatus,
        provider: 'stub',
        payment_address: null,
        pay_currency: null,
        pay_amount: null,
      });
      expect(createPayment).toHaveBeenCalledTimes(1);
      expect(getPayment).not.toHaveBeenCalled();
    },
  );

  it('CONCURRENT same-key checkouts never surface an orphaned mint — the second waits for the first mint and shows the BOUND payment (comprehensive audit 2026-07-02; security sweep #18 residual)', async () => {
    // Two overlapping checkouts on one Idempotency-Key both read
    // order.payment_id === null and reach the mint branch (the sequential replay
    // guard doesn't fire yet). They used to BOTH mint: whoever bound first won and
    // the loser's payment was orphaned (and had to be hidden, or the customer paid
    // an address whose IPN applyIpnStatus rejects). Now the second waits for the
    // first request's mint and answers with the payment it bound, so there is no
    // orphan. (A stale claim re-taken on another server while the first mint still
    // runs can still orphan one; that loser echoing the bound payment is pinned in
    // concurrent-crypto-checkouts-sharing-one-idempotency-key-mint-one-payment.)
    const release: Array<() => void> = [];
    let call = 0;
    const createPayment = vi.fn((): Promise<CreatePaymentResult> => {
      const n = ++call;
      return new Promise((resolve) => {
        release.push(() =>
          resolve({
            paymentId: n === 1 ? 'pay_A' : 'pay_B',
            payAddress: n === 1 ? '0xADDR_A' : '0xADDR_B',
            payCurrency: 'btc',
            payAmount: 0.0012,
            priceAmount: 79,
            priceCurrency: 'usd',
            paymentStatus: 'waiting',
          }),
        );
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
    const client = { createPayment, getPayment } as unknown as NowPaymentsApiClient;
    fx = await buildTestApp({ nowpaymentsClient: client });
    const payload = { product: 'solo_manual', price_cents: 7900, price_currency: 'USD' };
    const headers = {
      authorization: `Bearer ${fx.plaintext}`,
      'idempotency-key': 'k-crypto-concurrent-1',
    };
    const inject = (): Promise<{ statusCode: number; json: <T>() => T }> =>
      fx.app.inject({
        method: 'POST',
        url: '/v1/billing/crypto-checkout',
        headers,
        payload,
      });

    const pA = inject();
    // Request 1 has parked at createPayment: the concurrent window is open.
    await vi.waitFor(() => expect(release).toHaveLength(1));
    const pB = inject();

    // Request 2 reaches the mint while request 1's payment is unbound, and must
    // not call the provider: give it ample time to do so if it were going to.
    await new Promise((r) => setTimeout(r, 50));
    expect(createPayment, 'the second checkout minted its own payment').toHaveBeenCalledTimes(1);

    release[0]?.();
    const a = await pA;
    const b = await pB;

    const bodyA = a.json<{ order_id: string; payment_address: string | null }>();
    const bodyB = b.json<{ order_id: string; payment_address: string | null }>();
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(bodyB.order_id).toBe(bodyA.order_id); // same order (idempotent)
    expect(bodyA.payment_address).toBe('0xADDR_A');
    // The second MUST show the BOUND address (0xADDR_A), never an orphan.
    expect(bodyB.payment_address).toBe('0xADDR_A');
    expect(createPayment).toHaveBeenCalledTimes(1);
    expect(getPayment).not.toHaveBeenCalledWith('pay_B');
  });
});
