// Minimal NowPayments HTTP client (V-666).
//
// Same posture as the Stripe client (stripe-api.ts): no SDK dep, just
// fetch + typed result narrowing. Covers the two endpoints
// CryptoOrdersService needs to mint a real payment address:
//
//   - POST /v1/payment        — create a payment (returns the pay
//                                address, pay currency, payment_id).
//   - GET  /v1/payment/:id    — re-fetch payment status (admin retry /
//                                IPN replay support).
//
// Auth: `x-api-key: <NOWPAYMENTS_API_KEY>` header on every request.
// IPN signing uses a separate secret (`NOWPAYMENTS_IPN_SECRET`); see
// lib/nowpayments-signing.ts.
//
// Errors land as plain Error objects with the upstream message
// embedded. The 502 "NowPayments returned 4xx/5xx" translation lives
// in the route layer.

import type { Logger } from './logger.js';

export interface NowPaymentsApiClientConfig {
  /** NowPayments API key (live env). */
  apiKey: string;
  /** Per-request timeout in ms. Default 10000. */
  timeoutMs?: number;
  /** Override base URL for tests. Default 'https://api.nowpayments.io'. */
  baseUrl?: string;
  /** Test seam: substitute fetch implementation. */
  fetchImpl?: typeof fetch;
  logger: Logger;
}

export interface CreatePaymentArgs {
  /** Amount denominated in `price_currency`. */
  priceAmount: number;
  /** ISO fiat currency code; e.g. 'usd' / 'eur'. NowPayments accepts lowercase. */
  priceCurrency: string;
  /** Order id we minted; surfaces back as `order_id` on IPN callbacks. */
  orderId: string;
  /** Human description (optional). NowPayments shows this on their checkout page. */
  orderDescription?: string;
  /** Webhook callback URL — NowPayments POSTs IPN notifications here. */
  ipnCallbackUrl: string;
  /**
   * Optional pay-currency lock (e.g. 'btc' / 'eth' / 'usdttrc20'). When
   * omitted, NowPayments picks based on customer's choice on their UI.
   * The route layer leaves this unset by default — let the customer pick.
   */
  payCurrency?: string;
}

export interface CreatePaymentResult {
  /** NowPayments-assigned payment id (string of digits or alphanumeric). */
  paymentId: string;
  /** Address the customer sends crypto to. */
  payAddress: string;
  /** Currency the customer must pay in (e.g. 'btc'). */
  payCurrency: string;
  /** Exact amount the customer must send (in payCurrency). */
  payAmount: number;
  /** Echo of the priceAmount we sent. */
  priceAmount: number;
  /** Echo of the priceCurrency we sent. */
  priceCurrency: string;
  /** Initial status — usually 'waiting'. */
  paymentStatus: string;
}

export class NowPaymentsApiClient {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;

  constructor(opts: NowPaymentsApiClientConfig) {
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 10000;
    this.baseUrl = opts.baseUrl ?? 'https://api.nowpayments.io';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.logger = opts.logger;
  }

  async createPayment(args: CreatePaymentArgs): Promise<CreatePaymentResult> {
    const payload: Record<string, unknown> = {
      price_amount: args.priceAmount,
      price_currency: args.priceCurrency.toLowerCase(),
      order_id: args.orderId,
      ipn_callback_url: args.ipnCallbackUrl,
    };
    if (args.orderDescription !== undefined) payload.order_description = args.orderDescription;
    if (args.payCurrency !== undefined) payload.pay_currency = args.payCurrency.toLowerCase();

    const res = await this.requestJson<{
      payment_id: string | number;
      pay_address: string;
      pay_currency: string;
      pay_amount: number;
      price_amount: number;
      price_currency: string;
      payment_status: string;
    }>('POST', '/v1/payment', payload);

    return {
      paymentId: String(res.payment_id),
      payAddress: res.pay_address,
      payCurrency: res.pay_currency,
      payAmount: res.pay_amount,
      priceAmount: res.price_amount,
      priceCurrency: res.price_currency,
      paymentStatus: res.payment_status,
    };
  }

  async getPayment(paymentId: string): Promise<{ paymentStatus: string }> {
    const res = await this.requestJson<{ payment_status: string }>(
      'GET',
      `/v1/payment/${encodeURIComponent(paymentId)}`,
    );
    return { paymentStatus: res.payment_status };
  }

  private async requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    this.logger.debug({ method, path, component: 'nowpayments' }, 'nowpayments request');
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          'x-api-key': this.apiKey,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
      if (!res.ok) {
        let detail = '';
        try {
          const text = await res.text();
          detail = text.slice(0, 500);
        } catch {
          /* ignore */
        }
        const err = new Error(
          `NowPayments ${method} ${path} returned ${res.status.toString()}: ${detail}`,
        );
        (err as Error & { status?: number }).status = res.status;
        throw err;
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
