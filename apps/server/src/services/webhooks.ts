// Webhooks service — manages subscriptions and the event-emission /
// delivery-row-enqueue paths. The actual HTTP delivery happens in the
// WebhookDeliveryWorker (apps/server/src/services/webhook-worker.ts).
//
// All methods take an AccountContext and enforce account-scoped ownership.
// `enqueueEvent` is called from inside other services (sessions, api-keys,
// usage) when an event-worthy thing happens; it fans out one delivery row
// per subscribed endpoint.

import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { requireScope as throwIfMissingScope } from '../lib/errors-helpers.js';
import { generateWebhookSecret, webhookSecretPrefix } from '../lib/webhook-signing.js';
import type { AccountContext } from './auth.js';
import type { AccountAuditService } from './account-audit.js';

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export type WebhookEventType =
  | 'session.completed'
  | 'session.failed'
  | 'quota.warning_80pct'
  | 'quota.exceeded'
  | 'api_key.revoked';

export type WebhookDeliveryStatus = 'pending' | 'in_flight' | 'delivered' | 'failed' | 'dlq';

export interface WebhookEndpointRow {
  id: string;
  accountId: string;
  url: string;
  secret: string; // plaintext (D-023)
  secretPrefix: string;
  events: WebhookEventType[];
  description: string | null;
  active: boolean;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookDeliveryRow {
  id: string;
  webhookId: string;
  eventId: string;
  eventType: WebhookEventType;
  payload: Record<string, unknown>;
  status: WebhookDeliveryStatus;
  attempts: number;
  nextAttemptAt: Date;
  lastResponseStatus: number | null;
  lastResponseExcerpt: string | null;
  lastError: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewWebhookEndpointInput {
  accountId: string;
  url: string;
  secret: string;
  secretPrefix: string;
  events: WebhookEventType[];
  description: string | null;
}

export interface NewWebhookDeliveryInput {
  webhookId: string;
  eventId: string;
  eventType: WebhookEventType;
  payload: Record<string, unknown>;
  /** Optional: when first attempt should run. Default = now. */
  nextAttemptAt?: Date;
}

export interface ListDeliveriesPage {
  items: WebhookDeliveryRow[];
  nextCursor: string | null;
}

// ───────────────────────────────────────────────────────────────────────────
// Repo interface
// ───────────────────────────────────────────────────────────────────────────

/** V-185 — aggregate counts per endpoint. delivered + failed + dlq. */
export interface EndpointDeliveryCounts {
  delivered: number;
  failed: number;
  dlq: number;
}

export interface WebhooksRepo {
  // Management
  insertEndpoint(input: NewWebhookEndpointInput): Promise<WebhookEndpointRow>;
  listEndpoints(accountId: string): Promise<WebhookEndpointRow[]>;
  findEndpoint(id: string, accountId: string): Promise<WebhookEndpointRow | null>;
  countActiveEndpoints(accountId: string): Promise<number>;
  /** Soft-delete: set disabled_at + active=false. */
  disableEndpoint(id: string, at: Date): Promise<void>;

  /**
   * V-185 — aggregate per-endpoint delivery counts (delivered, failed,
   * dlq) for an account. One GROUP BY query in Drizzle; iterates the
   * in-memory map in tests. Returns a Map keyed by endpoint id (uuid,
   * NOT prefixed). Endpoints with zero deliveries return zeros.
   */
  deliveryCountsByEndpoint(accountId: string): Promise<Map<string, EndpointDeliveryCounts>>;

  // Event emission
  enqueueDelivery(input: NewWebhookDeliveryInput): Promise<void>;
  listEndpointsSubscribedTo(
    accountId: string,
    eventType: WebhookEventType,
  ): Promise<WebhookEndpointRow[]>;

  // Worker
  /** Atomic claim using SELECT...FOR UPDATE SKIP LOCKED. */
  claim(opts: { batchSize: number; now: Date }): Promise<WebhookDeliveryRow[]>;
  /** Look up an endpoint by id without account-scope (worker-only). */
  findEndpointById(id: string): Promise<WebhookEndpointRow | null>;
  recordDelivered(deliveryId: string, opts: { responseStatus: number; at: Date }): Promise<void>;
  recordRetry(
    deliveryId: string,
    opts: {
      responseStatus: number | null;
      responseExcerpt: string | null;
      lastError: string | null;
      attempts: number;
      nextAttemptAt: Date;
    },
  ): Promise<void>;
  recordDlq(
    deliveryId: string,
    opts: { responseStatus: number | null; lastError: string | null; at: Date },
  ): Promise<void>;

  listDeliveriesForEndpoint(
    endpointId: string,
    accountId: string,
    opts: { limit: number; cursor?: string; status?: WebhookDeliveryStatus },
  ): Promise<ListDeliveriesPage>;

  // Admin / operational tooling
  /** Look up a delivery by id WITHOUT account-scope. Admin-only callers. */
  findDeliveryById(deliveryId: string): Promise<WebhookDeliveryRow | null>;
  /** List dlq deliveries across all accounts, paginated by createdAt DESC. */
  listDlqDeliveries(opts: { limit: number; cursor?: string }): Promise<ListDeliveriesPage>;
  /** Total count of deliveries currently in DLQ across all accounts. */
  countDlqDeliveries(): Promise<number>;
  /**
   * Reset a delivery to status='pending' so the worker picks it up.
   * Resets attempts to 0 and nextAttemptAt to `at`. Returns the updated
   * row, or null if the delivery doesn't exist.
   */
  resetDeliveryToPending(deliveryId: string, at: Date): Promise<WebhookDeliveryRow | null>;
}

// ───────────────────────────────────────────────────────────────────────────
// Service
// ───────────────────────────────────────────────────────────────────────────

const MAX_ENDPOINTS_PER_ACCOUNT = 10;

export interface CreateWebhookInput {
  url: string;
  events: WebhookEventType[];
  description: string | null;
}

export interface CreatedWebhookEndpoint {
  row: WebhookEndpointRow;
  /** Plaintext signing secret. Returned ONCE; never retrievable later. */
  plaintextSecret: string;
}

export class WebhooksService {
  constructor(
    private readonly repo: WebhooksRepo,
    /**
     * V-225 — optional customer-facing audit log. When wired, emits
     * webhook_endpoint.created / webhook_endpoint.deleted entries.
     * Best-effort; failures never break the CRUD path.
     */
    private readonly accountAudit: AccountAuditService | null = null,
  ) {}

  private async emitAuditBestEffort(
    ctx: AccountContext,
    action: 'webhook_endpoint.created' | 'webhook_endpoint.deleted',
    targetResourceId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (this.accountAudit === null) return;
    try {
      await this.accountAudit.record({
        accountId: ctx.account.id,
        actorType: 'customer',
        actorAccountId: ctx.account.id,
        actorKeyId: ctx.apiKey.id,
        action,
        targetResourceId,
        payload,
      });
    } catch {
      /* best-effort — audit failures don't break the CRUD path */
    }
  }

  async create(ctx: AccountContext, input: CreateWebhookInput): Promise<CreatedWebhookEndpoint> {
    throwIfMissingScope(ctx, 'admin');

    const url = parseHttpsUrl(input.url);
    if (input.events.length === 0) {
      throw new ConflictError('events must contain at least one event type.');
    }

    const active = await this.repo.countActiveEndpoints(ctx.account.id);
    if (active >= MAX_ENDPOINTS_PER_ACCOUNT) {
      throw new ConflictError(
        `Account already has ${active.toString()} active webhook endpoints; limit is ${MAX_ENDPOINTS_PER_ACCOUNT.toString()}.`,
      );
    }

    const plaintextSecret = generateWebhookSecret();
    const secretPrefix = webhookSecretPrefix(plaintextSecret);

    const row = await this.repo.insertEndpoint({
      accountId: ctx.account.id,
      url,
      secret: plaintextSecret,
      secretPrefix,
      events: input.events,
      description: input.description,
    });

    await this.emitAuditBestEffort(ctx, 'webhook_endpoint.created', `webhook_endpoint_${row.id}`, {
      url: url.toString(),
      events: input.events,
    });

    return { row, plaintextSecret };
  }

  list(ctx: AccountContext): Promise<WebhookEndpointRow[]> {
    return this.repo.listEndpoints(ctx.account.id);
  }

  /**
   * V-185 — list endpoints + per-endpoint aggregate delivery counts
   * (delivered / failed / dlq). Customer dashboard /webhooks page
   * consumes this via /v1/webhooks; no separate endpoint needed.
   */
  async listWithCounts(
    ctx: AccountContext,
    opts: { effectiveAccountId?: string } = {},
  ): Promise<Array<{ endpoint: WebhookEndpointRow; counts: EndpointDeliveryCounts }>> {
    // V-330f — when effectiveAccountId is set, lists the OWNER's
    // endpoints. Read-only; both 'member' and 'admin' roles allowed.
    const accountId = opts.effectiveAccountId ?? ctx.account.id;
    const [endpoints, countsMap] = await Promise.all([
      this.repo.listEndpoints(accountId),
      this.repo.deliveryCountsByEndpoint(accountId),
    ]);
    return endpoints.map((endpoint) => ({
      endpoint,
      counts: countsMap.get(endpoint.id) ?? { delivered: 0, failed: 0, dlq: 0 },
    }));
  }

  async get(
    ctx: AccountContext,
    id: string,
    opts: { effectiveAccountId?: string } = {},
  ): Promise<WebhookEndpointRow> {
    const accountId = opts.effectiveAccountId ?? ctx.account.id;
    const row = await this.repo.findEndpoint(id, accountId);
    if (!row) throw new NotFoundError(`Webhook endpoint "${id}" not found.`);
    return row;
  }

  async delete(ctx: AccountContext, id: string): Promise<void> {
    throwIfMissingScope(ctx, 'admin');
    const row = await this.repo.findEndpoint(id, ctx.account.id);
    if (!row) throw new NotFoundError(`Webhook endpoint "${id}" not found.`);
    if (row.disabledAt !== null) return; // idempotent — no audit emit on no-op
    await this.repo.disableEndpoint(id, new Date());
    await this.emitAuditBestEffort(ctx, 'webhook_endpoint.deleted', `webhook_endpoint_${id}`, {
      url: row.url,
    });
  }

  listDeliveries(
    ctx: AccountContext,
    endpointId: string,
    opts: {
      limit: number;
      cursor?: string;
      status?: WebhookDeliveryStatus;
      effectiveAccountId?: string;
    },
  ): Promise<ListDeliveriesPage> {
    const accountId = opts.effectiveAccountId ?? ctx.account.id;
    return this.repo.listDeliveriesForEndpoint(endpointId, accountId, opts);
  }

  /**
   * V-307 — customer self-service replay. Looks up the delivery, then
   * the owning endpoint (must be the calling account's), then resets
   * the delivery to pending so the worker re-fires it. Audit emitted
   * via accountAudit.
   *
   * Differs from the admin replayDelivery (line ~351) in that:
   *   - account_owner scope (not admin)
   *   - account-scoped lookup (404s if delivery or endpoint isn't owned)
   *   - emits webhook_delivery.replayed customer audit (not admin audit).
   */
  async replayDeliveryAsCustomer(
    ctx: AccountContext,
    deliveryId: string,
  ): Promise<WebhookDeliveryRow> {
    throwIfMissingScope(ctx, 'account_owner');
    const delivery = await this.repo.findDeliveryById(deliveryId);
    if (!delivery) {
      throw new NotFoundError(`Webhook delivery "${deliveryId}" not found.`);
    }
    // Account-scope check: the owning endpoint must belong to the caller.
    const endpoint = await this.repo.findEndpoint(delivery.webhookId, ctx.account.id);
    if (!endpoint) {
      throw new NotFoundError(`Webhook delivery "${deliveryId}" not found.`);
    }
    const updated = await this.repo.resetDeliveryToPending(deliveryId, new Date());
    if (!updated) throw new NotFoundError(`Webhook delivery "${deliveryId}" not found.`);

    // V-216 — record customer audit entry. Best-effort.
    if (this.accountAudit) {
      try {
        await this.accountAudit.record({
          accountId: ctx.account.id,
          actorType: 'customer',
          actorAccountId: ctx.account.id,
          actorKeyId: ctx.apiKey.id,
          action: 'webhook_delivery.replayed',
          targetResourceId: `wdl_${deliveryId}`,
          payload: {
            endpoint_id: `whk_${delivery.webhookId}`,
            event_type: delivery.eventType,
          },
        });
      } catch {
        /* swallow */
      }
    }
    return updated;
  }

  /**
   * Fan out a single event into per-endpoint delivery rows. Returns the
   * number of deliveries enqueued (zero if no endpoint subscribes to the
   * event type — useful for caller-side logging).
   */
  async enqueueEvent(
    accountId: string,
    eventType: WebhookEventType,
    data: Record<string, unknown>,
  ): Promise<number> {
    const endpoints = await this.repo.listEndpointsSubscribedTo(accountId, eventType);
    if (endpoints.length === 0) return 0;

    const eventId = randomUUID();
    const createdAt = new Date().toISOString();
    const payload = { id: eventId, type: eventType, created_at: createdAt, data };

    for (const ep of endpoints) {
      // Skip endpoints that are disabled even if listEndpointsSubscribedTo
      // returned them (defence in depth).
      if (!ep.active || ep.disabledAt !== null) continue;
      await this.repo.enqueueDelivery({
        webhookId: ep.id,
        eventId,
        eventType,
        payload,
      });
    }

    return endpoints.length;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Admin / operational tooling service. Admin-only callers; bypasses
// account-scoping (an admin can replay any account's delivery and list
// the cross-account DLQ). Audit logging is the route's responsibility.
// ───────────────────────────────────────────────────────────────────────────

export class WebhooksAdminService {
  constructor(private readonly repo: WebhooksRepo) {}

  async getDelivery(ctx: AccountContext, deliveryId: string): Promise<WebhookDeliveryRow> {
    throwIfMissingScope(ctx, 'admin');
    const row = await this.repo.findDeliveryById(deliveryId);
    if (!row) throw new NotFoundError(`Webhook delivery "${deliveryId}" not found.`);
    return row;
  }

  /**
   * Replay any delivery (regardless of current status) — sets it back
   * to 'pending' with attempts=0 and nextAttemptAt=now. Used for
   * /webhook-deliveries/:id/replay.
   */
  async replayDelivery(ctx: AccountContext, deliveryId: string): Promise<WebhookDeliveryRow> {
    throwIfMissingScope(ctx, 'admin');
    const updated = await this.repo.resetDeliveryToPending(deliveryId, new Date());
    if (!updated) throw new NotFoundError(`Webhook delivery "${deliveryId}" not found.`);
    return updated;
  }

  /**
   * Requeue a DLQ delivery. Same DB op as replayDelivery, but rejects
   * if the target isn't currently in DLQ — the audit-log distinction
   * matters even though the underlying mutation is identical.
   */
  async requeueFromDlq(ctx: AccountContext, deliveryId: string): Promise<WebhookDeliveryRow> {
    throwIfMissingScope(ctx, 'admin');
    const current = await this.repo.findDeliveryById(deliveryId);
    if (!current) throw new NotFoundError(`Webhook delivery "${deliveryId}" not found.`);
    if (current.status !== 'dlq') {
      throw new ConflictError(
        `Webhook delivery "${deliveryId}" is not in DLQ (status=${current.status}). Use /webhook-deliveries/:id/replay to re-fire deliveries that aren't in DLQ.`,
      );
    }
    const updated = await this.repo.resetDeliveryToPending(deliveryId, new Date());
    // updated is guaranteed non-null because we just found the row above —
    // but the type narrows here, so guard explicitly for the noUncheckedIndexedAccess
    // family of strict checks.
    if (!updated)
      throw new NotFoundError(`Webhook delivery "${deliveryId}" disappeared mid-requeue.`);
    return updated;
  }

  listDlq(
    ctx: AccountContext,
    opts: { limit: number; cursor?: string },
  ): Promise<ListDeliveriesPage> {
    throwIfMissingScope(ctx, 'admin');
    return this.repo.listDlqDeliveries(opts);
  }

  countDlq(ctx: AccountContext): Promise<number> {
    throwIfMissingScope(ctx, 'admin');
    return this.repo.countDlqDeliveries();
  }
}

// ───────────────────────────────────────────────────────────────────────────

function parseHttpsUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConflictError(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== 'https:') {
    throw new ConflictError('Webhook URL must use https:// — http:// is rejected for security.');
  }
  return url.toString();
}
