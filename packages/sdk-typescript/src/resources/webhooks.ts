// WebhooksResource — typed methods for /v1/webhooks.

import type {
  CreateWebhookRequest,
  CreateWebhookResponse,
  ListDeliveriesQueryInput,
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookEndpoint,
} from '@driftstack/api-types';
import type { HttpClient } from '../http.js';
import { iteratePaginated } from '../pagination.js';

export interface WebhookEndpointList {
  data: WebhookEndpoint[];
}

export interface WebhookDeliveryListPage {
  data: WebhookDelivery[];
  has_more: boolean;
  next_cursor: string | null;
}

export class WebhooksResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Create a webhook subscription. Plaintext signing secret is returned
   * once; store it now — it cannot be retrieved later. Requires the
   * `admin` scope on the calling key.
   */
  create(body: CreateWebhookRequest): Promise<CreateWebhookResponse> {
    return this.http.request<CreateWebhookResponse>({
      method: 'POST',
      path: '/v1/webhooks',
      body,
    });
  }

  /** List webhook endpoints for the calling account. Plaintext is never returned. */
  list(): Promise<WebhookEndpointList> {
    return this.http.request<WebhookEndpointList>({
      method: 'GET',
      path: '/v1/webhooks',
    });
  }

  /** Get a single webhook endpoint. */
  get(id: string): Promise<WebhookEndpoint> {
    return this.http.request<WebhookEndpoint>({
      method: 'GET',
      path: `/v1/webhooks/${encodeURIComponent(id)}`,
    });
  }

  /** Disable (soft-delete) a webhook endpoint. Idempotent. */
  delete(id: string): Promise<void> {
    return this.http.request<void>({
      method: 'DELETE',
      path: `/v1/webhooks/${encodeURIComponent(id)}`,
    });
  }

  /** Paginated delivery log for a webhook endpoint. Filter by status (e.g. `'dlq'`). */
  listDeliveries(
    id: string,
    query: ListDeliveriesQueryInput & { status?: WebhookDeliveryStatus } = {},
  ): Promise<WebhookDeliveryListPage> {
    return this.http.request<WebhookDeliveryListPage>({
      method: 'GET',
      path: `/v1/webhooks/${encodeURIComponent(id)}/deliveries`,
      query: {
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
      },
    });
  }

  /**
   * Lazily iterate every delivery for a webhook endpoint, walking cursor
   * pages automatically. Filter by status to walk just one bucket
   * (e.g. `{ status: 'dlq' }` to enumerate the DLQ for replay tooling).
   */
  iterateDeliveries(
    id: string,
    opts: { limit?: number; status?: WebhookDeliveryStatus } = {},
  ): AsyncGenerator<WebhookDelivery, void, void> {
    return iteratePaginated<WebhookDelivery>((cursor) =>
      this.listDeliveries(id, {
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts.status !== undefined ? { status: opts.status } : {}),
        ...(cursor !== null ? { cursor } : {}),
      }),
    );
  }

  /**
   * V-307 — replay a webhook delivery. Resets the delivery to pending +
   * the worker re-fires it. Account-scoped: the delivery must belong to
   * an endpoint the calling account owns. Useful when the customer's
   * downstream had a brief outage and wants to re-fire the failed deliveries.
   */
  replayDelivery(deliveryId: string): Promise<WebhookDelivery> {
    return this.http.request<WebhookDelivery>({
      method: 'POST',
      path: `/v1/webhook-deliveries/${encodeURIComponent(deliveryId)}/replay`,
      body: {},
    });
  }
}
