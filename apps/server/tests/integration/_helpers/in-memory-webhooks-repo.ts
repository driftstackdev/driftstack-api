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
      secretPrev: null,
      secretPrevExpiresAt: null,
      secretCreatedAt: now,
      lastReminderSentAt: null,
      // Arc 3 sub-slice 28.1 (v2-#28) — server-initiated force-rotation
      // columns. Always null on fresh insert; sub-slice 28.2's daily
      // sweep populates them.
      graceWindowEndsAt: null,
      forceRotatedAt: null,
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

  rotateSecret(input: {
    id: string;
    accountId: string;
    newSecret: string;
    newPrefix: string;
    graceExpiresAt: Date;
    now: Date;
  }): Promise<WebhookEndpointRow | null> {
    const r = this.endpoints.get(input.id);
    if (!r || r.accountId !== input.accountId || r.disabledAt !== null) {
      return Promise.resolve(null);
    }
    const updated: WebhookEndpointRow = {
      ...r,
      secret: input.newSecret,
      secretPrefix: input.newPrefix,
      secretPrev: r.secret,
      secretPrevExpiresAt: input.graceExpiresAt,
      secretCreatedAt: input.now,
      lastReminderSentAt: null,
      // Arc 3 sub-slice 28.7 (v2-#28) — reset force-rotation
      // bookkeeping so the 91-day clock restarts cleanly when the
      // customer rotates manually.
      forceRotatedAt: null,
      graceWindowEndsAt: null,
      updatedAt: input.now,
    };
    this.endpoints.set(input.id, updated);
    return Promise.resolve(updated);
  }

  findEndpointsNeedingForceRotation(args: {
    now: Date;
    thresholdDays: number;
    limit: number;
  }): Promise<ReadonlyArray<WebhookEndpointRow & { accountEmail: string | null }>> {
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const cutoff = new Date(args.now.getTime() - args.thresholdDays * MS_PER_DAY);
    const out: Array<WebhookEndpointRow & { accountEmail: string | null }> = [];
    for (const r of this.endpoints.values()) {
      if (r.disabledAt !== null) continue;
      if (r.forceRotatedAt !== null) continue;
      if (r.secretCreatedAt >= cutoff) continue;
      out.push({ ...r, accountEmail: null });
      if (out.length >= args.limit) break;
    }
    return Promise.resolve(out);
  }

  forceRotateSecret(input: {
    id: string;
    newSecret: string;
    newPrefix: string;
    graceWindowEndsAt: Date;
    now: Date;
  }): Promise<WebhookEndpointRow | null> {
    const r = this.endpoints.get(input.id);
    if (!r || r.disabledAt !== null) return Promise.resolve(null);
    const updated: WebhookEndpointRow = {
      ...r,
      secret: input.newSecret,
      secretPrefix: input.newPrefix,
      secretPrev: r.secret,
      secretPrevExpiresAt: input.graceWindowEndsAt,
      graceWindowEndsAt: input.graceWindowEndsAt,
      forceRotatedAt: input.now,
      secretCreatedAt: input.now,
      lastReminderSentAt: null,
      updatedAt: input.now,
    };
    this.endpoints.set(input.id, updated);
    return Promise.resolve(updated);
  }

  clearStaleSecretPrev(args: { now: Date }): Promise<{ cleared: number }> {
    let cleared = 0;
    for (const [id, r] of this.endpoints) {
      if (
        r.secretPrev !== null &&
        r.secretPrevExpiresAt !== null &&
        r.secretPrevExpiresAt.getTime() < args.now.getTime()
      ) {
        this.endpoints.set(id, {
          ...r,
          secretPrev: null,
          secretPrevExpiresAt: null,
        });
        cleared += 1;
      }
    }
    return Promise.resolve({ cleared });
  }

  updateEndpoint(input: {
    id: string;
    accountId: string;
    url?: string;
    events?: WebhookEventType[];
    description?: string | null;
    active?: boolean;
  }): Promise<WebhookEndpointRow | null> {
    const r = this.endpoints.get(input.id);
    if (!r || r.accountId !== input.accountId || r.disabledAt !== null) {
      return Promise.resolve(null);
    }
    const updated: WebhookEndpointRow = {
      ...r,
      url: input.url !== undefined ? input.url : r.url,
      events: input.events !== undefined ? input.events : r.events,
      description: input.description !== undefined ? input.description : r.description,
      active: input.active !== undefined ? input.active : r.active,
      updatedAt: new Date(),
    };
    this.endpoints.set(input.id, updated);
    return Promise.resolve(updated);
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

  listDlqDeliveries(opts: {
    limit: number;
    cursor?: string;
    endpointId?: string;
  }): Promise<ListDeliveriesPage> {
    // Mirror the Drizzle repo's malformed-cursor guard: an Invalid Date
    // (truthy) would otherwise silently match nothing here. Invalid → absent.
    const cursorParsed = opts.cursor ? new Date(opts.cursor) : null;
    const cursorDate =
      cursorParsed !== null && !Number.isNaN(cursorParsed.getTime()) ? cursorParsed : null;
    const all = Array.from(this.deliveries.values())
      .filter((r) => r.status === 'dlq')
      .filter((r) => (cursorDate ? r.createdAt < cursorDate : true))
      // V-512 — drill-down filter on endpoint id (the row's
      // webhookId is the foreign key into webhook_endpoints).
      .filter((r) => (opts.endpointId ? r.webhookId === opts.endpointId : true))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const items = all.slice(0, opts.limit);
    const last = items[items.length - 1];
    const hasMore = all.length > opts.limit;
    return Promise.resolve({
      items,
      nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
    });
  }

  countDlqDeliveries(): Promise<number> {
    let cnt = 0;
    for (const r of this.deliveries.values()) {
      if (r.status === 'dlq') cnt++;
    }
    return Promise.resolve(cnt);
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

  // 2026-05-22 — hard-delete a DLQ row. Mirrors the Drizzle repo's
  // status='dlq' precondition: matches by id AND status so a
  // concurrent state change can't accidentally drop an active
  // delivery in tests.
  deleteDelivery(deliveryId: string): Promise<boolean> {
    const row = this.deliveries.get(deliveryId);
    if (!row || row.status !== 'dlq') return Promise.resolve(false);
    this.deliveries.delete(deliveryId);
    return Promise.resolve(true);
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
    // Mirror the Drizzle repo's malformed-cursor guard: an Invalid Date
    // (truthy) would otherwise silently match nothing here. Invalid → absent.
    const cursorParsed = opts.cursor ? new Date(opts.cursor) : null;
    const cursorDate =
      cursorParsed !== null && !Number.isNaN(cursorParsed.getTime()) ? cursorParsed : null;
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
