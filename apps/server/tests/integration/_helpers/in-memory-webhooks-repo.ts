// In-memory WebhooksRepo for integration tests.

import { randomUUID } from 'node:crypto';
import type {
  EndpointDeliveryCounts,
  ListDeliveriesPage,
  NewWebhookDeliveryInput,
  NewWebhookEndpointInput,
  WebhookDeliveryRow,
  WebhookDeliveryStatus,
  WebhookEndpointRow,
  WebhookEventType,
  WebhooksRepo,
} from '../../../src/services/webhooks.js';

export class InMemoryWebhooksRepo implements WebhooksRepo {
  private readonly endpoints = new Map<string, WebhookEndpointRow>();
  private readonly deliveries = new Map<string, WebhookDeliveryRow>();

  insertEndpoint(input: NewWebhookEndpointInput): Promise<WebhookEndpointRow> {
    const now = new Date();
    const row: WebhookEndpointRow = {
      id: randomUUID(),
      accountId: input.accountId,
      url: input.url,
      secret: input.secret,
      secretPrefix: input.secretPrefix,
      events: input.events,
      description: input.description,
      active: true,
      consecutiveFailures: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      disabledAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.endpoints.set(row.id, row);
    return Promise.resolve(row);
  }

  listEndpoints(accountId: string): Promise<WebhookEndpointRow[]> {
    const rows = Array.from(this.endpoints.values())
      .filter((r) => r.accountId === accountId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return Promise.resolve(rows);
  }

  deliveryCountsByEndpoint(accountId: string): Promise<Map<string, EndpointDeliveryCounts>> {
    const result = new Map<string, EndpointDeliveryCounts>();
    for (const d of this.deliveries.values()) {
      const ep = this.endpoints.get(d.webhookId);
      if (!ep || ep.accountId !== accountId) continue;
      const existing = result.get(d.webhookId) ?? { delivered: 0, failed: 0, dlq: 0 };
      if (d.status === 'delivered') existing.delivered += 1;
      else if (d.status === 'failed') existing.failed += 1;
      else if (d.status === 'dlq') existing.dlq += 1;
      result.set(d.webhookId, existing);
    }
    return Promise.resolve(result);
  }

  findEndpoint(id: string, accountId: string): Promise<WebhookEndpointRow | null> {
    const r = this.endpoints.get(id);
    if (!r || r.accountId !== accountId) return Promise.resolve(null);
    return Promise.resolve(r);
  }

  findEndpointById(id: string): Promise<WebhookEndpointRow | null> {
    return Promise.resolve(this.endpoints.get(id) ?? null);
  }

  countActiveEndpoints(accountId: string): Promise<number> {
    let n = 0;
    for (const r of this.endpoints.values()) {
      if (r.accountId === accountId && r.active) n += 1;
    }
    return Promise.resolve(n);
  }

  disableEndpoint(id: string, at: Date): Promise<void> {
    const r = this.endpoints.get(id);
    if (r) {
      this.endpoints.set(id, { ...r, active: false, disabledAt: at, updatedAt: at });
    }
    return Promise.resolve();
  }

  enqueueDelivery(input: NewWebhookDeliveryInput): Promise<void> {
    const now = new Date();
    const row: WebhookDeliveryRow = {
      id: randomUUID(),
      webhookId: input.webhookId,
      eventId: input.eventId,
      eventType: input.eventType,
      payload: input.payload,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: input.nextAttemptAt ?? now,
      lastResponseStatus: null,
      lastResponseExcerpt: null,
      lastError: null,
      deliveredAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.deliveries.set(row.id, row);
    return Promise.resolve();
  }

  listEndpointsSubscribedTo(
    accountId: string,
    eventType: WebhookEventType,
  ): Promise<WebhookEndpointRow[]> {
    const rows = Array.from(this.endpoints.values()).filter(
      (r) => r.accountId === accountId && r.active && r.events.includes(eventType),
    );
    return Promise.resolve(rows);
  }

  claim(opts: { batchSize: number; now: Date }): Promise<WebhookDeliveryRow[]> {
    const eligible = Array.from(this.deliveries.values())
      .filter((r) => r.status === 'pending' && r.nextAttemptAt.getTime() <= opts.now.getTime())
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      .slice(0, opts.batchSize);
    for (const r of eligible) {
      this.deliveries.set(r.id, { ...r, status: 'in_flight', updatedAt: opts.now });
    }
    return Promise.resolve(eligible.map((r) => ({ ...r, status: 'in_flight' as const })));
  }

  recordDelivered(deliveryId: string, opts: { responseStatus: number; at: Date }): Promise<void> {
    const row = this.deliveries.get(deliveryId);
    if (!row) return Promise.resolve();
    this.deliveries.set(deliveryId, {
      ...row,
      status: 'delivered',
      lastResponseStatus: opts.responseStatus,
      deliveredAt: opts.at,
      updatedAt: opts.at,
    });
    const ep = this.endpoints.get(row.webhookId);
    if (ep) {
      this.endpoints.set(ep.id, {
        ...ep,
        consecutiveFailures: 0,
        lastSuccessAt: opts.at,
        updatedAt: opts.at,
      });
    }
    return Promise.resolve();
  }

  recordRetry(
    deliveryId: string,
    opts: {
      responseStatus: number | null;
      responseExcerpt: string | null;
      lastError: string | null;
      attempts: number;
      nextAttemptAt: Date;
    },
  ): Promise<void> {
    const row = this.deliveries.get(deliveryId);
    if (!row) return Promise.resolve();
    this.deliveries.set(deliveryId, {
      ...row,
      status: 'pending',
      attempts: opts.attempts,
      nextAttemptAt: opts.nextAttemptAt,
      lastResponseStatus: opts.responseStatus,
      lastResponseExcerpt: opts.responseExcerpt,
      lastError: opts.lastError,
      updatedAt: new Date(),
    });
    const ep = this.endpoints.get(row.webhookId);
    if (ep) {
      this.endpoints.set(ep.id, {
        ...ep,
        consecutiveFailures: ep.consecutiveFailures + 1,
        lastFailureAt: new Date(),
        updatedAt: new Date(),
      });
    }
    return Promise.resolve();
  }

  recordDlq(
    deliveryId: string,
    opts: { responseStatus: number | null; lastError: string | null; at: Date },
  ): Promise<void> {
    const row = this.deliveries.get(deliveryId);
    if (!row) return Promise.resolve();
    this.deliveries.set(deliveryId, {
      ...row,
      status: 'dlq',
      lastResponseStatus: opts.responseStatus,
      lastError: opts.lastError,
      updatedAt: opts.at,
    });
    const ep = this.endpoints.get(row.webhookId);
    if (ep) {
      this.endpoints.set(ep.id, {
        ...ep,
        consecutiveFailures: ep.consecutiveFailures + 1,
        lastFailureAt: opts.at,
        updatedAt: opts.at,
      });
    }
    return Promise.resolve();
  }

  findDeliveryById(deliveryId: string): Promise<WebhookDeliveryRow | null> {
    return Promise.resolve(this.deliveries.get(deliveryId) ?? null);
  }

  listDlqDeliveries(opts: { limit: number; cursor?: string }): Promise<ListDeliveriesPage> {
    const cursorDate = opts.cursor ? new Date(opts.cursor) : null;
    const all = Array.from(this.deliveries.values())
      .filter((r) => r.status === 'dlq')
      .filter((r) => (cursorDate ? r.createdAt < cursorDate : true))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const items = all.slice(0, opts.limit);
    const last = items[items.length - 1];
    const hasMore = all.length > opts.limit;
    return Promise.resolve({
      items,
      nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
    });
  }

  resetDeliveryToPending(deliveryId: string, at: Date): Promise<WebhookDeliveryRow | null> {
    const row = this.deliveries.get(deliveryId);
    if (!row) return Promise.resolve(null);
    const updated: WebhookDeliveryRow = {
      ...row,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: at,
      lastResponseStatus: null,
      lastResponseExcerpt: null,
      lastError: null,
      deliveredAt: null,
      updatedAt: at,
    };
    this.deliveries.set(deliveryId, updated);
    return Promise.resolve(updated);
  }

  listDeliveriesForEndpoint(
    endpointId: string,
    accountId: string,
    opts: { limit: number; cursor?: string; status?: WebhookDeliveryStatus },
  ): Promise<ListDeliveriesPage> {
    const ep = this.endpoints.get(endpointId);
    if (!ep || ep.accountId !== accountId) {
      return Promise.resolve({ items: [], nextCursor: null });
    }
    const cursorDate = opts.cursor ? new Date(opts.cursor) : null;
    const all = Array.from(this.deliveries.values())
      .filter((r) => r.webhookId === endpointId)
      .filter((r) => (cursorDate ? r.createdAt < cursorDate : true))
      .filter((r) => (opts.status ? r.status === opts.status : true))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const items = all.slice(0, opts.limit);
    const last = items[items.length - 1];
    const hasMore = all.length > opts.limit;
    return Promise.resolve({
      items,
      nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
    });
  }

  /** Test helper: read all delivery rows. */
  getAllDeliveries(): WebhookDeliveryRow[] {
    return Array.from(this.deliveries.values());
  }
}
