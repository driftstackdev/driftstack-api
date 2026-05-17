// Drizzle-backed implementation of WebhooksRepo.

import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
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
} from '../services/webhooks.js';
import type { Database } from './client.js';
import { webhookDeliveries, webhookEndpoints } from './schema.js';

export class DrizzleWebhooksRepo implements WebhooksRepo {
  constructor(private readonly database: Database) {}

  async insertEndpoint(input: NewWebhookEndpointInput): Promise<WebhookEndpointRow> {
    const [row] = await this.database.db
      .insert(webhookEndpoints)
      .values({
        accountId: input.accountId,
        url: input.url,
        secret: input.secret,
        secretPrefix: input.secretPrefix,
        events: input.events,
        description: input.description,
      })
      .returning();
    if (!row) throw new Error('insertEndpoint returned no row');
    return toEndpointRow(row);
  }

  async listEndpoints(accountId: string): Promise<WebhookEndpointRow[]> {
    const rows = await this.database.db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.accountId, accountId))
      .orderBy(desc(webhookEndpoints.createdAt));
    return rows.map(toEndpointRow);
  }

  async deliveryCountsByEndpoint(accountId: string): Promise<Map<string, EndpointDeliveryCounts>> {
    // GROUP BY endpoint_id + status — one row per (endpoint, status)
    // tuple. Only counts statuses we care about for the dashboard
    // surface; pending / in_flight aren't aggregated here.
    const rows = await this.database.db
      .select({
        webhookId: webhookDeliveries.webhookId,
        status: webhookDeliveries.status,
        cnt: sql<number>`count(*)::int`,
      })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookDeliveries.webhookId, webhookEndpoints.id))
      .where(eq(webhookEndpoints.accountId, accountId))
      .groupBy(webhookDeliveries.webhookId, webhookDeliveries.status);

    const result = new Map<string, EndpointDeliveryCounts>();
    for (const r of rows) {
      const existing = result.get(r.webhookId) ?? { delivered: 0, failed: 0, dlq: 0 };
      if (r.status === 'delivered') existing.delivered = r.cnt;
      else if (r.status === 'failed') existing.failed = r.cnt;
      else if (r.status === 'dlq') existing.dlq = r.cnt;
      result.set(r.webhookId, existing);
    }
    return result;
  }

  async findEndpoint(id: string, accountId: string): Promise<WebhookEndpointRow | null> {
    const [row] = await this.database.db
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.accountId, accountId)))
      .limit(1);
    return row ? toEndpointRow(row) : null;
  }

  async findEndpointById(id: string): Promise<WebhookEndpointRow | null> {
    const [row] = await this.database.db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, id))
      .limit(1);
    return row ? toEndpointRow(row) : null;
  }

  async countActiveEndpoints(accountId: string): Promise<number> {
    const [row] = await this.database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.accountId, accountId), eq(webhookEndpoints.active, true)));
    return row?.count ?? 0;
  }

  async disableEndpoint(id: string, at: Date): Promise<void> {
    await this.database.db
      .update(webhookEndpoints)
      .set({ active: false, disabledAt: at, updatedAt: new Date() })
      .where(eq(webhookEndpoints.id, id));
  }

  async updateEndpoint(input: {
    id: string;
    accountId: string;
    url?: string;
    events?: WebhookEventType[];
    description?: string | null;
    active?: boolean;
  }): Promise<WebhookEndpointRow | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (input.url !== undefined) set.url = input.url;
    if (input.events !== undefined) set.events = input.events;
    if (input.description !== undefined) set.description = input.description;
    if (input.active !== undefined) set.active = input.active;
    // Account-scoped + not-disabled — disabled rows are tombstones.
    const [row] = await this.database.db
      .update(webhookEndpoints)
      .set(set)
      .where(
        and(
          eq(webhookEndpoints.id, input.id),
          eq(webhookEndpoints.accountId, input.accountId),
          isNull(webhookEndpoints.disabledAt),
        ),
      )
      .returning();
    return row ? toEndpointRow(row) : null;
  }

  async rotateSecret(input: {
    id: string;
    accountId: string;
    newSecret: string;
    newPrefix: string;
    graceExpiresAt: Date;
    now: Date;
  }): Promise<WebhookEndpointRow | null> {
    // Single UPDATE: copy current secret/prefix INTO the prev slot,
    // overwrite current with the new pair, set the grace expiry.
    // No SELECT-then-UPDATE race — Postgres reads the row's current
    // values at UPDATE time.
    const [row] = await this.database.db
      .update(webhookEndpoints)
      .set({
        secret: input.newSecret,
        secretPrefix: input.newPrefix,
        secretPrev: sql`${webhookEndpoints.secret}`,
        secretPrevExpiresAt: input.graceExpiresAt,
        // v2-#10 — new secret is fresh; reset the rotation clock so
        // the 90d nag starts over from this rotation. Also clear the
        // reminder dedupe column so the next rotation cycle can fire
        // reminders without being blocked by a stale send.
        secretCreatedAt: input.now,
        lastReminderSentAt: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(webhookEndpoints.id, input.id),
          eq(webhookEndpoints.accountId, input.accountId),
          isNull(webhookEndpoints.disabledAt),
        ),
      )
      .returning();
    return row ? toEndpointRow(row) : null;
  }

  async enqueueDelivery(input: NewWebhookDeliveryInput): Promise<void> {
    await this.database.db.insert(webhookDeliveries).values({
      webhookId: input.webhookId,
      eventId: input.eventId,
      eventType: input.eventType,
      payload: input.payload,
      ...(input.nextAttemptAt !== undefined ? { nextAttemptAt: input.nextAttemptAt } : {}),
    });
  }

  async listEndpointsSubscribedTo(
    accountId: string,
    eventType: WebhookEventType,
  ): Promise<WebhookEndpointRow[]> {
    const rows = await this.database.db
      .select()
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.accountId, accountId),
          eq(webhookEndpoints.active, true),
          // events @> ARRAY[<eventType>] — every endpoint whose events array
          // contains the eventType.
          sql`${webhookEndpoints.events} @> ARRAY[${eventType}]::webhook_event_type[]`,
        ),
      );
    return rows.map(toEndpointRow);
  }

  async claim(opts: { batchSize: number; now: Date }): Promise<WebhookDeliveryRow[]> {
    // Atomic claim: SELECT ... FOR UPDATE SKIP LOCKED → UPDATE status = in_flight
    // → RETURNING. ISO-string the timestamp because postgres-js's
    // tagged-template binder rejects raw Date in this position.
    const nowIso = opts.now.toISOString();
    const rows = await this.database.client<Record<string, unknown>[]>`
      WITH claimed AS (
        SELECT id FROM webhook_deliveries
        WHERE status = 'pending' AND next_attempt_at <= ${nowIso}::timestamptz
        ORDER BY next_attempt_at ASC
        LIMIT ${opts.batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE webhook_deliveries
      SET status = 'in_flight', updated_at = NOW()
      WHERE id IN (SELECT id FROM claimed)
      RETURNING *
    `;
    return rows.map(rawToDeliveryRow);
  }

  async recordDelivered(
    deliveryId: string,
    opts: { responseStatus: number; at: Date },
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(webhookDeliveries)
        .set({
          status: 'delivered',
          lastResponseStatus: opts.responseStatus,
          deliveredAt: opts.at,
          updatedAt: new Date(),
        })
        .where(eq(webhookDeliveries.id, deliveryId))
        .returning({ webhookId: webhookDeliveries.webhookId });
      if (!updated) return;
      await tx
        .update(webhookEndpoints)
        .set({
          consecutiveFailures: 0,
          lastSuccessAt: opts.at,
          updatedAt: new Date(),
        })
        .where(eq(webhookEndpoints.id, updated.webhookId));
    });
  }

  async recordRetry(
    deliveryId: string,
    opts: {
      responseStatus: number | null;
      responseExcerpt: string | null;
      lastError: string | null;
      attempts: number;
      nextAttemptAt: Date;
    },
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(webhookDeliveries)
        .set({
          status: 'pending',
          attempts: opts.attempts,
          nextAttemptAt: opts.nextAttemptAt,
          lastResponseStatus: opts.responseStatus,
          lastResponseExcerpt: opts.responseExcerpt,
          lastError: opts.lastError,
          updatedAt: new Date(),
        })
        .where(eq(webhookDeliveries.id, deliveryId))
        .returning({ webhookId: webhookDeliveries.webhookId });
      if (!updated) return;
      await tx
        .update(webhookEndpoints)
        .set({
          consecutiveFailures: sql`${webhookEndpoints.consecutiveFailures} + 1`,
          lastFailureAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(webhookEndpoints.id, updated.webhookId));
    });
  }

  async recordDlq(
    deliveryId: string,
    opts: { responseStatus: number | null; lastError: string | null; at: Date },
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(webhookDeliveries)
        .set({
          status: 'dlq',
          lastResponseStatus: opts.responseStatus,
          lastError: opts.lastError,
          updatedAt: opts.at,
        })
        .where(eq(webhookDeliveries.id, deliveryId))
        .returning({ webhookId: webhookDeliveries.webhookId });
      if (!updated) return;
      await tx
        .update(webhookEndpoints)
        .set({
          consecutiveFailures: sql`${webhookEndpoints.consecutiveFailures} + 1`,
          lastFailureAt: opts.at,
          updatedAt: new Date(),
        })
        .where(eq(webhookEndpoints.id, updated.webhookId));
    });
  }

  async findDeliveryById(deliveryId: string): Promise<WebhookDeliveryRow | null> {
    const [row] = await this.database.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId))
      .limit(1);
    return row ? toDeliveryRow(row) : null;
  }

  async listDlqDeliveries(opts: {
    limit: number;
    cursor?: string;
    endpointId?: string;
  }): Promise<ListDeliveriesPage> {
    const cursorDate = opts.cursor ? new Date(opts.cursor) : null;
    const filters = [eq(webhookDeliveries.status, 'dlq' as WebhookDeliveryStatus)];
    if (cursorDate) filters.push(lt(webhookDeliveries.createdAt, cursorDate));
    // V-512 — drill-down filter; uuid scoped to a single endpoint
    // (column is `webhook_id` at the schema level).
    if (opts.endpointId) filters.push(eq(webhookDeliveries.webhookId, opts.endpointId));

    const rows = await this.database.db
      .select()
      .from(webhookDeliveries)
      .where(and(...filters))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(opts.limit + 1);

    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;
    const last = items[items.length - 1];
    return {
      items: items.map(toDeliveryRow),
      nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
    };
  }

  async countDlqDeliveries(): Promise<number> {
    const [row] = await this.database.db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.status, 'dlq' as WebhookDeliveryStatus));
    return row?.cnt ?? 0;
  }

  async resetDeliveryToPending(deliveryId: string, at: Date): Promise<WebhookDeliveryRow | null> {
    const [row] = await this.database.db
      .update(webhookDeliveries)
      .set({
        status: 'pending',
        attempts: 0,
        nextAttemptAt: at,
        lastResponseStatus: null,
        lastResponseExcerpt: null,
        lastError: null,
        deliveredAt: null,
        updatedAt: at,
      })
      .where(eq(webhookDeliveries.id, deliveryId))
      .returning();
    return row ? toDeliveryRow(row) : null;
  }

  async listDeliveriesForEndpoint(
    endpointId: string,
    accountId: string,
    opts: { limit: number; cursor?: string; status?: WebhookDeliveryStatus },
  ): Promise<ListDeliveriesPage> {
    // Verify ownership before listing.
    const owned = await this.findEndpoint(endpointId, accountId);
    if (!owned) return { items: [], nextCursor: null };

    const cursorDate = opts.cursor ? new Date(opts.cursor) : null;
    const filters = [eq(webhookDeliveries.webhookId, endpointId)];
    if (cursorDate) filters.push(lt(webhookDeliveries.createdAt, cursorDate));
    if (opts.status) filters.push(eq(webhookDeliveries.status, opts.status));

    const rows = await this.database.db
      .select()
      .from(webhookDeliveries)
      .where(and(...filters))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(opts.limit + 1);

    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;
    const last = items[items.length - 1];
    return {
      items: items.map(toDeliveryRow),
      nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
    };
  }
}

// ───────────────────────────────────────────────────────────────────────────

function toEndpointRow(r: typeof webhookEndpoints.$inferSelect): WebhookEndpointRow {
  return {
    id: r.id,
    accountId: r.accountId,
    url: r.url,
    secret: r.secret,
    secretPrefix: r.secretPrefix,
    secretPrev: r.secretPrev,
    secretPrevExpiresAt: r.secretPrevExpiresAt,
    secretCreatedAt: r.secretCreatedAt,
    lastReminderSentAt: r.lastReminderSentAt,
    events: r.events,
    description: r.description,
    active: r.active,
    consecutiveFailures: r.consecutiveFailures,
    lastSuccessAt: r.lastSuccessAt,
    lastFailureAt: r.lastFailureAt,
    disabledAt: r.disabledAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toDeliveryRow(r: typeof webhookDeliveries.$inferSelect): WebhookDeliveryRow {
  return {
    id: r.id,
    webhookId: r.webhookId,
    eventId: r.eventId,
    eventType: r.eventType,
    payload: r.payload ?? {},
    status: r.status,
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt,
    lastResponseStatus: r.lastResponseStatus,
    lastResponseExcerpt: r.lastResponseExcerpt,
    lastError: r.lastError,
    deliveredAt: r.deliveredAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** Raw postgres-js rows returned from the CTE come as snake_case strings. */
function rawToDeliveryRow(r: Record<string, unknown>): WebhookDeliveryRow {
  return {
    id: r.id as string,
    webhookId: r.webhook_id as string,
    eventId: r.event_id as string,
    eventType: r.event_type as WebhookEventType,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    status: r.status as WebhookDeliveryStatus,
    attempts: Number(r.attempts),
    nextAttemptAt: new Date(r.next_attempt_at as string),
    lastResponseStatus:
      r.last_response_status === null || r.last_response_status === undefined
        ? null
        : Number(r.last_response_status),
    lastResponseExcerpt: (r.last_response_excerpt as string | null) ?? null,
    lastError: (r.last_error as string | null) ?? null,
    deliveredAt: r.delivered_at ? new Date(r.delivered_at as string) : null,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}
