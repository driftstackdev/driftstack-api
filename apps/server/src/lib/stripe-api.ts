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
//   - POST /v1/billing_portal/sessions
//
// and three read-only ones, for recording which billing periods were paid for:
//
//   - GET  /v1/invoices/:id
//   - GET  /v1/invoices            (paid invoices since a date, one page)
//   - GET  /v1/subscriptions/:id
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
/**
 * Stripe pause_collection behavior used when an account is suspended. 'void' means the
 * customer is not billed for the suspended period at all — see
 * setSubscriptionPauseCollection for why that, and not 'keep_as_draft'.
 */
const PAUSE_COLLECTION_BEHAVIOR = 'void';

const DEFAULT_BASE_URL = 'https://api.stripe.com';
const MAX_STRIPE_RESPONSE_BODY_BYTES = 256 * 1024;
/**
 * A page of invoices is many objects, each carrying its lines, so the single-
 * object cap above would refuse an ordinary page. Still a hard bound: a page
 * larger than this fails loudly rather than being read.
 */
const MAX_STRIPE_LIST_RESPONSE_BODY_BYTES = 4 * 1024 * 1024;
/** Stripe's own ceiling on `limit` for a list call. */
const MAX_STRIPE_LIST_PAGE_SIZE = 100;

function malformedResponse(status: number, message: string): StripeApiError {
  const err: StripeApiError = Object.assign(new Error(message), {
    status,
    stripeError: { type: 'malformed_response', message },
  });
  err.name = 'StripeApiError';
  return err;
}

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
      // enabled for the account. Automatic tax also requires a customer
      // tax location; newly-created Driftstack customers have no stored
      // address, so Checkout must collect and save the billing address.
      // Omitting customer_update[address] makes Stripe reject the session
      // before the hosted page can open.
      'automatic_tax[enabled]': 'true',
      'customer_update[address]': 'auto',
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

  /**
   * V-758 — set or clear `pause_collection` on a subscription, used by the account
   * suspension lifecycle to honour the AUP's "billing pauses" promise.
   *
   * `behavior: 'void'` is deliberate and is the load-bearing product choice here: it
   * VOIDS invoices for the paused period rather than deferring them. `keep_as_draft`
   * would bill the customer retroactively on resume, which is the opposite of what
   * "billing pauses" tells a suspended customer, and they cannot use the service during
   * the window (every authenticated request 403s). If the business prefers deferral,
   * changing this one constant is the whole change.
   *
   * Passing `pause: false` sends `pause_collection=""`, which is how the Stripe form API
   * expresses clearing the field. Both directions are idempotent — re-pausing an already
   * paused sub and clearing an unpaused one are both no-ops server-side.
   */
  async setSubscriptionPauseCollection(args: {
    subscriptionId: string;
    pause: boolean;
  }): Promise<{ id: string }> {
    const body: Record<string, string> = args.pause
      ? { 'pause_collection[behavior]': PAUSE_COLLECTION_BEHAVIOR }
      : { pause_collection: '' };
    return this.post<{ id: string }>(
      `/v1/subscriptions/${encodeURIComponent(args.subscriptionId)}`,
      body,
    );
  }

  /**
   * Cancel a subscription NOW, used when staff terminate an account (the
   * account's access ends, so its billing must too — ToS 14.5). `prorate` turns
   * the unused part of the period into a credit on the Stripe customer and
   * `invoice_now` settles it on a final invoice at once; nothing is refunded
   * automatically — staff decide that (the caller alerts them). Stripe reads a
   * DELETE's parameters from the query string. Cancelling an already cancelled
   * subscription is refused by Stripe with a 4xx, which the caller records.
   *
   * Security sweep #11 — `prorate: false` for a subscription whose current period
   * was never paid (past_due): prorating it credits "unused time" of a period the
   * customer did not pay for. It then sends `prorate=false&invoice_now=false`, so
   * nothing is credited and no final invoice is raised; the open invoice is left
   * as Stripe holds it. Both callers pass it for a past_due subscription: the
   * replaced-subscription cancel and, since 2026-09-24, account termination.
   * Omitted, it is `true`.
   */
  async cancelSubscription(args: {
    subscriptionId: string;
    prorate?: boolean;
  }): Promise<{ id: string }> {
    const prorate = args.prorate ?? true;
    return this.sendForm<{ id: string }>(
      'DELETE',
      `/v1/subscriptions/${encodeURIComponent(args.subscriptionId)}?${new URLSearchParams({
        invoice_now: prorate ? 'true' : 'false',
        prorate: prorate ? 'true' : 'false',
      }).toString()}`,
      {},
    );
  }

  // ── Invoices + subscriptions (read-only) ──────────────────────────────

  /**
   * One invoice, as Stripe holds it now. Returned as an open object: the caller
   * reads the few fields it needs and treats anything absent as absent. The
   * answer must BE the invoice that was asked for, or it is refused — a record
   * keyed on one invoice id must never be filled from another's body.
   */
  async getInvoice(invoiceId: string): Promise<Record<string, unknown>> {
    const path = `/v1/invoices/${encodeURIComponent(invoiceId)}`;
    const invoice = await this.get<Record<string, unknown>>(path, {});
    if (invoice.id !== invoiceId) {
      throw malformedResponse(200, 'Stripe returned a different invoice than the one requested');
    }
    return invoice;
  }

  /**
   * S17 — one charge, as Stripe holds it now, read for the invoice it paid
   * when a refund or dispute event does not say. The same refusal as
   * `getInvoice`: the answer must be the charge asked for.
   */
  async getCharge(chargeId: string): Promise<Record<string, unknown>> {
    const path = `/v1/charges/${encodeURIComponent(chargeId)}`;
    const charge = await this.get<Record<string, unknown>>(path, {});
    if (charge.id !== chargeId) {
      throw malformedResponse(200, 'Stripe returned a different charge than the one requested');
    }
    return charge;
  }

  /**
   * One page of invoices in one status, created at or after `createdGte`, newest
   * first (Stripe's list order). `startingAfter` is the id of the last invoice of
   * the previous page; `hasMore` says whether another page follows.
   */
  async listInvoices(args: {
    status: 'paid';
    createdGte: Date;
    limit: number;
    startingAfter?: string;
  }): Promise<{ data: Array<Record<string, unknown>>; hasMore: boolean }> {
    const limit = Math.min(Math.max(1, Math.trunc(args.limit)), MAX_STRIPE_LIST_PAGE_SIZE);
    const query: Record<string, string> = {
      status: args.status,
      'created[gte]': Math.floor(args.createdGte.getTime() / 1000).toString(),
      limit: limit.toString(),
    };
    if (args.startingAfter !== undefined) query.starting_after = args.startingAfter;
    const page = await this.get<{ data?: unknown; has_more?: unknown }>(
      '/v1/invoices',
      query,
      MAX_STRIPE_LIST_RESPONSE_BODY_BYTES,
    );
    if (!Array.isArray(page.data) || typeof page.has_more !== 'boolean') {
      throw malformedResponse(200, 'Stripe invoice list was not a list');
    }
    const data = page.data.filter(
      (row): row is Record<string, unknown> => typeof row === 'object' && row !== null,
    );
    if (data.length !== page.data.length) {
      throw malformedResponse(200, 'Stripe invoice list held a non-object entry');
    }
    return { data, hasMore: page.has_more };
  }

  /** One subscription, as Stripe holds it now. Same identity rule as getInvoice. */
  async getSubscription(subscriptionId: string): Promise<Record<string, unknown>> {
    const path = `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`;
    const subscription = await this.get<Record<string, unknown>>(path, {});
    if (subscription.id !== subscriptionId) {
      throw malformedResponse(
        200,
        'Stripe returned a different subscription than the one requested',
      );
    }
    return subscription;
  }

  // ── Internal request plumbing ─────────────────────────────────────────

  /**
   * A read. Same authentication, version pin, redirect refusal and timeout as
   * `post()`; the parameters ride in the query string and there is no body.
   */
  private async get<T>(
    path: string,
    query: Record<string, string>,
    maxBodyBytes: number = MAX_STRIPE_RESPONSE_BODY_BYTES,
  ): Promise<T> {
    const search = new URLSearchParams(query).toString();
    const url = `${this.config.baseUrl ?? DEFAULT_BASE_URL}${path}${search.length > 0 ? `?${search}` : ''}`;
    const auth = `Basic ${Buffer.from(`${this.config.secretKey}:`).toString('base64')}`;

    const ac = new AbortController();
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    // As in post(): the timer is cleared only after the body is read.
    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: auth,
          'Stripe-Version': this.config.apiVersion ?? DEFAULT_API_VERSION,
        },
        redirect: 'error',
        signal: ac.signal,
      });
      return await this.readResponse<T>(res, path, maxBodyBytes);
    } finally {
      clearTimeout(timer);
    }
  }

  private async post<T>(
    path: string,
    body: Record<string, string>,
    idempotencyKey?: string,
  ): Promise<T> {
    return this.sendForm<T>('POST', path, body, idempotencyKey);
  }

  /** A form-encoded write (`post()`, and `cancelSubscription`'s DELETE). */
  private async sendForm<T>(
    method: 'POST' | 'DELETE',
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
        method,
        headers: {
          Authorization: auth,
          'Stripe-Version': this.config.apiVersion ?? DEFAULT_API_VERSION,
          'Content-Type': 'application/x-www-form-urlencoded',
          // Stripe dedupes POSTs carrying the same Idempotency-Key (~24h),
          // returning the original result — the safe-retry / no-duplicate seam.
          ...(idempotencyKey !== undefined ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: formBody,
        redirect: 'error',
        signal: ac.signal,
      });

      return await this.readResponse<T>(res, path, MAX_STRIPE_RESPONSE_BODY_BYTES);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Read, bound, parse and classify one response. Shared by `post()` and
   * `get()`, so a read is held to the same size cap and the same error
   * normalisation as a write.
   */
  private async readResponse<T>(res: Response, path: string, maxBodyBytes: number): Promise<T> {
    let text: string;
    try {
      text = await readBoundedResponseBody(res, maxBodyBytes);
    } catch (err) {
      if (!(err instanceof ResponseBodyLimitError)) throw err;
      const stripeError = {
        type: 'malformed_response',
        message: `Stripe response exceeded ${maxBodyBytes.toString()}-byte limit`,
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
  }
}
