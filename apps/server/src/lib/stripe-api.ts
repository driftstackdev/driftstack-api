// Minimal Stripe API HTTP client (V-088).
//
// We deliberately do NOT depend on the `stripe` npm package. Reasons:
//
//   1. Same reasoning as V-080's hand-rolled signature verification:
//      we touch a small surface area of Stripe's API (Customers,
//      Checkout Sessions, Billing Portal Sessions). The official SDK
//      is hundreds of types + dozens of resource-method paths we'll
//      never call; for a small touched surface, a fetch wrapper +
//      typed-result narrowing is cleaner.
//
//   2. Keeps the dependency graph slim. Every additional npm package
//      adds supply-chain risk (the Stripe SDK is well-maintained, but
//      its transitive dep tree is non-trivial).
//
//   3. The integration shape stays test-friendly: BillingProvider is
//      an interface with an in-memory test implementation; the real
//      Stripe-backed implementation is one of many possible providers.
//
// Stripe's API uses application/x-www-form-urlencoded for request
// bodies, BasicAuth for the secret key, and returns JSON. Errors come
// back as `{ error: { type, message, code, ... } }` with a 4xx/5xx.
//
// This client covers the minimum endpoints V-082 needs:
//
//   - POST /v1/customers
//   - GET  /v1/customers (search by email)
//   - POST /v1/checkout/sessions  (subscription mode)
//   - POST /v1/checkout/sessions  (payment mode for trial-pack)
//   - POST /v1/billing_portal/sessions
//
// New endpoint touches land here as one method per Stripe resource.

import type { Logger } from './logger.js';
import { readBoundedResponseBody, ResponseBodyLimitError } from './bounded-response-body.js';

export interface StripeApiClientConfig {
  /** Stripe secret key (sk_live_... or sk_test_...). */
  secretKey: string;
  /** Stripe API version pinned at deploy time. Default '2024-12-18.acacia'. */
  apiVersion?: string;
  /** Per-request timeout in ms. Default 10000. */
  timeoutMs?: number;
  /** Override base URL for tests. Default 'https://api.stripe.com'. */
  baseUrl?: string;
  /** Test seam: substitute fetch implementation. */
  fetchImpl?: typeof fetch;
  logger: Logger;
}

export interface StripeApiError extends Error {
  /** HTTP status code. */
  status: number;
  /** Stripe error object as returned. */
  stripeError: {
    type: string;
    code?: string;
    message?: string;
    param?: string;
    decline_code?: string;
    [key: string]: unknown;
  };
}

const DEFAULT_API_VERSION = '2024-12-18.acacia';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_BASE_URL = 'https://api.stripe.com';
const MAX_STRIPE_RESPONSE_BODY_BYTES = 256 * 1024;

function parseStripeError(parsed: unknown): StripeApiError['stripeError'] {
  if (typeof parsed !== 'object' || parsed === null) return { type: 'unknown_error' };
  const candidate = (parsed as { error?: unknown }).error;
  if (typeof candidate !== 'object' || candidate === null) return { type: 'unknown_error' };
  const fields = candidate as Record<string, unknown>;
  return {
    type: typeof fields.type === 'string' && fields.type.length > 0 ? fields.type : 'unknown_error',
    ...(typeof fields.code === 'string' ? { code: fields.code } : {}),
    ...(typeof fields.param === 'string' ? { param: fields.param } : {}),
    ...(typeof fields.decline_code === 'string' ? { decline_code: fields.decline_code } : {}),
  };
}

export class StripeApiClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: StripeApiClientConfig) {
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  // ── Customers ─────────────────────────────────────────────────────────

  async createCustomer(args: {
    email: string;
    name?: string | null;
    metadata?: Record<string, string>;
    /**
     * Optional Stripe Idempotency-Key. When set, Stripe returns the SAME
     * Customer for a repeated key (retained ~24h) instead of creating a new
     * one — so a retry (e.g. after the create succeeded but a downstream
     * DB-write failed) or two parallel calls can never mint a duplicate.
     * Callers key it by the logical operation (e.g. the account id).
     */
    idempotencyKey?: string;
  }): Promise<{ id: string; email: string }> {
    const body: Record<string, string> = { email: args.email };
    if (args.name !== undefined && args.name !== null) body.name = args.name;
    if (args.metadata !== undefined) {
      for (const [k, v] of Object.entries(args.metadata)) {
        body[`metadata[${k}]`] = v;
      }
    }
    const result = await this.post<{ id: string; email: string }>(
      '/v1/customers',
      body,
      args.idempotencyKey,
    );
    return result;
  }

  // ── Checkout Sessions ─────────────────────────────────────────────────

  /**
   * Create a Checkout Session in `subscription` mode for a recurring price.
   * `clientReferenceId` is the local account UUID — surfaced back to us in
   * the `checkout.session.completed` webhook event for correlation.
   */
  async createSubscriptionCheckoutSession(args: {
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    clientReferenceId: string;
    /** Optional metadata round-tripped onto the resulting subscription. */
    metadata?: Record<string, string>;
    /** Safe-retry key supplied by the caller and forwarded to Stripe unchanged. */
    idempotencyKey?: string;
  }): Promise<{ id: string; url: string }> {
    const body: Record<string, string> = {
      mode: 'subscription',
      customer: args.customerId,
      'line_items[0][price]': args.priceId,
      'line_items[0][quantity]': '1',
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      client_reference_id: args.clientReferenceId,
      // BTW reverse-charge handling (per ADR-002): Stripe Tax must be
      // enabled for the account; the line below tells Stripe Checkout
      // to compute tax automatically. Safe to leave on for live + test
      // accounts; if Stripe Tax isn't enabled the Checkout init still
      // succeeds — Stripe just doesn't compute tax.
      'automatic_tax[enabled]': 'true',
    };
    if (args.metadata !== undefined) {
      for (const [k, v] of Object.entries(args.metadata)) {
        body[`subscription_data[metadata][${k}]`] = v;
      }
    }
    return this.post<{ id: string; url: string }>(
      '/v1/checkout/sessions',
      body,
      args.idempotencyKey,
    );
  }

  /**
   * Create a Checkout Session in `payment` mode for a one-time price
   * (the trial pack per ADR-003). Same correlation pattern via
   * `client_reference_id`.
   */
  async createOneTimeCheckoutSession(args: {
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    clientReferenceId: string;
    metadata?: Record<string, string>;
  }): Promise<{ id: string; url: string }> {
    const body: Record<string, string> = {
      mode: 'payment',
      customer: args.customerId,
      'line_items[0][price]': args.priceId,
      'line_items[0][quantity]': '1',
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      client_reference_id: args.clientReferenceId,
    };
    if (args.metadata !== undefined) {
      for (const [k, v] of Object.entries(args.metadata)) {
        body[`payment_intent_data[metadata][${k}]`] = v;
      }
    }
    return this.post<{ id: string; url: string }>('/v1/checkout/sessions', body);
  }

  // ── Billing Portal ────────────────────────────────────────────────────

  async createBillingPortalSession(args: {
    customerId: string;
    returnUrl: string;
  }): Promise<{ id: string; url: string }> {
    const body: Record<string, string> = {
      customer: args.customerId,
      return_url: args.returnUrl,
    };
    return this.post<{ id: string; url: string }>('/v1/billing_portal/sessions', body);
  }

  // ── Internal request plumbing ─────────────────────────────────────────

  private async post<T>(
    path: string,
    body: Record<string, string>,
    idempotencyKey?: string,
  ): Promise<T> {
    const url = `${this.config.baseUrl ?? DEFAULT_BASE_URL}${path}`;
    const formBody = new URLSearchParams(body).toString();
    const auth = `Basic ${Buffer.from(`${this.config.secretKey}:`).toString('base64')}`;

    const ac = new AbortController();
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    // The timer is cleared in `finally` AFTER the response body is read — the
    // abort signal must stay armed through the bounded body read, not just the
    // header-receiving `fetch()`. Otherwise a server that sends headers then
    // stalls the body holds this worker for up to undici's 300s body-timeout
    // (30× the intended deadline) instead of `timeoutMs`. (Bug-class shared by
    // the other hand-rolled fetch clients — see the audit memo.)
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: auth,
          'Stripe-Version': this.config.apiVersion ?? DEFAULT_API_VERSION,
          'Content-Type': 'application/x-www-form-urlencoded',
          // Stripe dedupes POSTs carrying the same Idempotency-Key (~24h),
          // returning the original result — the safe-retry / no-duplicate seam.
          ...(idempotencyKey !== undefined ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: formBody,
        signal: ac.signal,
      });

      let text: string;
      try {
        text = await readBoundedResponseBody(res, MAX_STRIPE_RESPONSE_BODY_BYTES);
      } catch (err) {
        if (!(err instanceof ResponseBodyLimitError)) throw err;
        const stripeError = {
          type: 'malformed_response',
          message: `Stripe response exceeded ${MAX_STRIPE_RESPONSE_BODY_BYTES.toString()}-byte limit`,
        };
        const apiError: StripeApiError = Object.assign(new Error(stripeError.message), {
          status: res.status,
          stripeError,
        });
        apiError.name = 'StripeApiError';
        throw apiError;
      }
      let parsed: unknown;
      try {
        parsed = text.length === 0 ? {} : JSON.parse(text);
      } catch {
        const err: StripeApiError = Object.assign(new Error('Stripe response was not JSON'), {
          status: res.status,
          stripeError: { type: 'malformed_response', message: 'Stripe response was not JSON' },
        });
        err.name = 'StripeApiError';
        throw err;
      }

      if (!res.ok) {
        // Retain only the provider's documented classification fields. The
        // free-form upstream message/body must not be copied into an Error:
        // the global 5xx handler logs escaping errors with their full stack.
        const stripeError = parseStripeError(parsed);
        this.config.logger.warn(
          {
            component: 'stripe-api',
            path,
            status: res.status,
            stripeErrorType: stripeError.type,
            stripeErrorCode: stripeError.code,
          },
          'Stripe API error',
        );
        const err: StripeApiError = Object.assign(
          new Error(
            `Stripe ${path} failed: ${stripeError.type}${stripeError.code !== undefined ? ` (${stripeError.code})` : ''}`,
          ),
          { status: res.status, stripeError },
        );
        err.name = 'StripeApiError';
        throw err;
      }

      return parsed as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
