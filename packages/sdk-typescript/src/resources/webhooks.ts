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
}
