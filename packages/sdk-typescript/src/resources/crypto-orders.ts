// CryptoOrdersResource — typed methods for /v1/billing/crypto-* (V-666).
//
// Customer-facing only; admin endpoints are not exposed in the public
// SDK (use the OpenAPI spec at /openapi.json directly). Crypto
// payments are non-refundable.

import type {
  CancelCryptoOrderResponse,
  CreateCryptoCheckoutRequest,
  CreateCryptoCheckoutResponse,
  CryptoOrderEnvelope,
  CryptoOrderReceipt,
  CryptoQuoteRequest,
  CryptoQuoteResponse,
  ListCryptoOrdersQuery,
  ListCryptoOrdersResponse,
  UpdateCryptoOrderNoteRequest,
} from '@driftstack/api-types';
import type { HttpClient } from '../http.js';
import { iteratePaginated } from '../pagination.js';

export interface CreateCryptoCheckoutOptions {
  /** V-666.AO — idempotency key. The SDK passes it as the Idempotency-Key header. */
  idempotencyKey?: string;
}

/**
 * V-666.BR — list options. Sourced from @driftstack/api-types so the
 * status union stays in lockstep with the server-side enum.
 */
export type ListCryptoOrdersOptions = ListCryptoOrdersQuery;

export class CryptoOrdersResource {
  constructor(private readonly http: HttpClient) {}

  // Requires read:billing (broad read/account_owner also satisfy it).
  /** V-666.H — preview the authoritative fiat price without minting an order. */
  quote(body: CryptoQuoteRequest): Promise<CryptoQuoteResponse> {
    return this.http.request<CryptoQuoteResponse>({
      method: 'POST',
      path: '/v1/billing/crypto-checkout/quote',
      body,
    });
  }

  /** V-666.C — mint a new crypto order. Send an `idempotencyKey` to dedupe retries. */
  createCheckout(
    body: CreateCryptoCheckoutRequest,
    opts: CreateCryptoCheckoutOptions = {},
  ): Promise<CreateCryptoCheckoutResponse> {
    return this.http.request<CreateCryptoCheckoutResponse>({
      method: 'POST',
      path: '/v1/billing/crypto-checkout',
      body,
      ...(opts.idempotencyKey !== undefined
        ? { headers: { 'idempotency-key': opts.idempotencyKey } }
        : {}),
    });
  }

  /**
   * V-666.G — list the caller account's crypto orders (newest first).
   * V-666.BR — pass `status` to narrow the list to a single status.
   * V-666.BU — pass `cursor` from a prior page's `next_cursor` to
   *           iterate. Loop until the response's `next_cursor` is null.
   */
  list(opts: ListCryptoOrdersOptions = {}): Promise<ListCryptoOrdersResponse> {
    const query: Record<string, string | number | undefined> = {};
    if (opts.status !== undefined) query.status = opts.status;
    if (opts.limit !== undefined) query.limit = opts.limit;
    if (opts.cursor !== undefined) query.cursor = opts.cursor;
    if (opts.created_after !== undefined) query.created_after = opts.created_after;
    if (opts.created_before !== undefined) query.created_before = opts.created_before;
    return this.http.request<ListCryptoOrdersResponse>({
      method: 'GET',
      path: '/v1/billing/crypto-orders',
      ...(Object.keys(query).length > 0 ? { query } : {}),
    });
  }

  /**
   * V-666.BU — async generator that walks every page until the
   * server stops emitting a next_cursor. Yields the envelope of
   * each order one at a time so consumers can break early.
   *
   * Accepts the same options as `list()` minus `cursor` (the
   * iterator manages cursors internally).
   */
  listAll(
    opts: Omit<ListCryptoOrdersOptions, 'cursor'> = {},
  ): AsyncGenerator<CryptoOrderEnvelope, void, void> {
    // Delegate to the shared paginator so this endpoint gets the same
    // non-advancing-cursor guard as every other list (a server/proxy/cache
    // bug that re-emits the same cursor would otherwise spin forever).
    // The crypto envelope keys its rows off `orders` (not the standard
    // `data`), so adapt the page shape in the fetch closure.
    return iteratePaginated<CryptoOrderEnvelope>((cursor) =>
      this.list({
        ...opts,
        ...(cursor !== null ? { cursor } : {}),
      }).then((page) => ({
        data: page.orders,
        next_cursor: page.next_cursor ?? null,
      })),
    );
  }

  /**
   * V-666.BU — cross-SDK naming alias for {@link listAll}. The Python
   * (`iterate`) + Go (`Iterate`) SDKs name the crypto-order cursor walker
   * `iterate`, matching every other paginated resource; TS keeps the
   * historical `listAll` name and exposes `iterate` as a thin synonym so the
   * three SDKs share a vocabulary. Identical semantics + signature — pick
   * either.
   */
  iterate(
    opts: Omit<ListCryptoOrdersOptions, 'cursor'> = {},
  ): AsyncGenerator<CryptoOrderEnvelope, void, void> {
    return this.listAll(opts);
  }

  /** V-666.G — read a single order envelope. */
  get(orderId: string): Promise<CryptoOrderEnvelope> {
    return this.http.request<CryptoOrderEnvelope>({
      method: 'GET',
      path: `/v1/billing/crypto-orders/${encodeURIComponent(orderId)}`,
    });
  }

  /** V-666.Q — update the customer-facing free-text note. */
  updateNote(orderId: string, body: UpdateCryptoOrderNoteRequest): Promise<CryptoOrderEnvelope> {
    return this.http.request<CryptoOrderEnvelope>({
      method: 'PATCH',
      path: `/v1/billing/crypto-orders/${encodeURIComponent(orderId)}`,
      body,
    });
  }

  /** V-666.J — abandon a pending order (self-service). */
  cancel(orderId: string): Promise<CancelCryptoOrderResponse> {
    return this.http.request<CancelCryptoOrderResponse>({
      method: 'POST',
      path: `/v1/billing/crypto-orders/${encodeURIComponent(orderId)}/cancel`,
    });
  }

  /** V-666.M — fetch the JSON receipt. */
  receipt(orderId: string): Promise<CryptoOrderReceipt> {
    return this.http.request<CryptoOrderReceipt>({
      method: 'GET',
      path: `/v1/billing/crypto-orders/${encodeURIComponent(orderId)}/receipt`,
    });
  }
}
