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
// Errors land as plain Error objects with a fixed provider/status message.
// Upstream response text is never copied into the Error because the checkout
// route logs it on soft-failure. The route keeps its existing stub fallback.

import type { Logger } from './logger.js';
import { readBoundedResponseBody, ResponseBodyLimitError } from './bounded-response-body.js';

const MAX_NOWPAYMENTS_RESPONSE_BODY_BYTES = 256 * 1024;

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

interface RawCreatePaymentResponse {
  payment_id: string | number;
  pay_address: string;
  pay_currency: string;
  pay_amount: number;
  price_amount: number;
  price_currency: string;
  payment_status: string;
}

/**
 * Guards against a malformed/degraded 200 OK from NowPayments (partial body
 * during an upstream incident, a proxy truncating the response, or a future
 * API contract change). Without this, `String(res.payment_id)` on an
 * undefined/null field silently produces the literal string "undefined",
 * which then gets persisted as the order's payment_id — permanently
 * breaking IPN matching for the customer's real callback (see
 * CryptoOrdersService.applyIpnStatus's exact-match reject). Fail loud
 * instead of coercing a missing field into a plausible-looking value.
 */
function assertValidCreatePaymentResponse(res: unknown): asserts res is RawCreatePaymentResponse {
  const r = res as Partial<RawCreatePaymentResponse> | null | undefined;
  const missing: string[] = [];
  if (
    r == null ||
    (typeof r.payment_id !== 'string' && typeof r.payment_id !== 'number') ||
    r.payment_id === ''
  ) {
    missing.push('payment_id');
  }
  if (r != null && (typeof r.pay_address !== 'string' || r.pay_address === '')) {
    missing.push('pay_address');
  }
  if (r != null && (typeof r.pay_currency !== 'string' || r.pay_currency === '')) {
    missing.push('pay_currency');
  }
  if (r != null && typeof r.pay_amount !== 'number') {
    missing.push('pay_amount');
  }
  if (r != null && typeof r.price_amount !== 'number') {
    missing.push('price_amount');
  }
  if (r != null && typeof r.price_currency !== 'string') {
    missing.push('price_currency');
  }
  if (r != null && typeof r.payment_status !== 'string') {
    missing.push('payment_status');
  }
  if (missing.length > 0) {
    throw new Error(
      `NowPayments createPayment response missing/invalid field(s): ${missing.join(', ')}`,
    );
  }
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
    assertValidCreatePaymentResponse(res);

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

  async getPayment(paymentId: string): Promise<{
    paymentStatus: string;
    payAddress: string | null;
    payCurrency: string | null;
    payAmount: number | null;
  }> {
    // The NowPayments GET /payment/{id} response carries the ORIGINAL pay
    // address + crypto-denominated quote alongside the status, so an
    // idempotent-replay checkout can echo the EXISTING payment (bound to the
    // order's already-recorded payment_id) instead of minting a mismatched
    // second payment. Address/quote fields are optional (absent on some
    // pre-confirmation states) → null when missing.
    const res = await this.requestJson<{
      payment_status: string;
      pay_address?: string;
      pay_currency?: string;
      pay_amount?: number;
    }>('GET', `/v1/payment/${encodeURIComponent(paymentId)}`);
    return {
      paymentStatus: res.payment_status,
      payAddress: typeof res.pay_address === 'string' ? res.pay_address : null,
      payCurrency: typeof res.pay_currency === 'string' ? res.pay_currency : null,
      payAmount: typeof res.pay_amount === 'number' ? res.pay_amount : null,
    };
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
      let text: string;
      try {
        text = await readBoundedResponseBody(res, MAX_NOWPAYMENTS_RESPONSE_BODY_BYTES);
      } catch (err) {
        if (!(err instanceof ResponseBodyLimitError)) throw err;
        const bodyLimitError = new Error(
          `NowPayments ${method} ${path} response exceeded ${MAX_NOWPAYMENTS_RESPONSE_BODY_BYTES.toString()}-byte limit`,
        );
        (bodyLimitError as Error & { status?: number }).status = res.status;
        throw bodyLimitError;
      }
      if (!res.ok) {
        const err = new Error(`NowPayments ${method} ${path} returned ${res.status.toString()}`);
        (err as Error & { status?: number }).status = res.status;
        throw err;
      }
      try {
        return (text.length === 0 ? {} : JSON.parse(text)) as T;
      } catch {
        const err = new Error(`NowPayments ${method} ${path} response was not JSON`);
        (err as Error & { status?: number }).status = res.status;
        throw err;
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
