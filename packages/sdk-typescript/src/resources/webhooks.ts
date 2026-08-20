// WebhooksResource — typed methods for /v1/webhooks.

import type {
  CreateWebhookRequest,
  CreateWebhookResponse,
  ListDeliveriesQueryInput,
  RotateWebhookSecretResponse,
  UpdateWebhookRequest,
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
   * `account_owner` scope on the calling key.
   */
  create(body: CreateWebhookRequest): Promise<CreateWebhookResponse> {
    return this.http.request<CreateWebhookResponse>({
      method: 'POST',
      path: '/v1/webhooks',
      body,
    });
  }

  /** List webhook endpoints for the EFFECTIVE account — your own, or the owner
   *  you are acting as via `X-Driftstack-Account`. Plaintext is never returned. */
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

  /**
   * V-351 — partial-update a webhook endpoint. At least one of `url`,
   * `events`, `description`, or `active` must be present. The
   * signing secret is NOT rotated by update; use `rotateSecret` for
   * that. Disabled endpoints cannot be updated (returns 409).
   * Requires the `account_owner` scope on the calling key.
   */
  update(id: string, body: UpdateWebhookRequest): Promise<WebhookEndpoint> {
    return this.http.request<WebhookEndpoint>({
      method: 'PATCH',
      path: `/v1/webhooks/${encodeURIComponent(id)}`,
      body,
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
   * the worker re-fires it. Scoped to the EFFECTIVE account: the delivery
   * must belong to an endpoint your own account owns, or one owned by the
   * account you are acting as via `X-Driftstack-Account` (replay re-fires,
   * so it takes the write gate — team act-as requires `admin`). Useful when the customer's
   * downstream had a brief outage and wants to re-fire the failed deliveries.
   */
  replayDelivery(deliveryId: string): Promise<WebhookDelivery> {
    return this.http.request<WebhookDelivery>({
      method: 'POST',
      path: `/v1/webhook-deliveries/${encodeURIComponent(deliveryId)}/replay`,
      body: {},
    });
  }

  /**
   * V-359 — rotate the webhook signing secret. The fresh plaintext is
   * returned ONCE. The previous secret stays active for 24h
   * (`grace_expires_at`) during which Driftstack dual-signs every
   * outbound delivery (both the new + old HMAC). Roll the new secret
   * across your verifier infra inside that window. Requires the
   * `account_owner` scope on the calling key.
   */
  rotateSecret(id: string): Promise<RotateWebhookSecretResponse> {
    return this.http.request<RotateWebhookSecretResponse>({
      method: 'POST',
      path: `/v1/webhooks/${encodeURIComponent(id)}/rotate-secret`,
      body: {},
    });
  }

  /**
   * V-356 — send a synthetic `test.ping` event to the endpoint.
   * Bypasses subscription (the endpoint receives it regardless of
   * which event types it's subscribed to), so customers can verify
   * their handler is reachable + signature-valid before depending on
   * it for real events. Returns 202 + the synthetic delivery id.
   * Requires the `account_owner` scope on the calling key.
   */
  sendTest(id: string): Promise<{
    delivery_id: string;
    event_id: string;
    event_type: 'test.ping';
  }> {
    return this.http.request<{
      delivery_id: string;
      event_id: string;
      event_type: 'test.ping';
    }>({
      method: 'POST',
      path: `/v1/webhooks/${encodeURIComponent(id)}/test`,
      body: {},
    });
  }
}
