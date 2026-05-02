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

export interface WebhooksRepo {
  // Management
  insertEndpoint(input: NewWebhookEndpointInput): Promise<WebhookEndpointRow>;
  listEndpoints(accountId: string): Promise<WebhookEndpointRow[]>;
  findEndpoint(id: string, accountId: string): Promise<WebhookEndpointRow | null>;
  countActiveEndpoints(accountId: string): Promise<number>;
  /** Soft-delete: set disabled_at + active=false. */
  disableEndpoint(id: string, at: Date): Promise<void>;

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
  constructor(private readonly repo: WebhooksRepo) {}

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

    return { row, plaintextSecret };
  }

  list(ctx: AccountContext): Promise<WebhookEndpointRow[]> {
    return this.repo.listEndpoints(ctx.account.id);
  }

  async get(ctx: AccountContext, id: string): Promise<WebhookEndpointRow> {
    const row = await this.repo.findEndpoint(id, ctx.account.id);
    if (!row) throw new NotFoundError(`Webhook endpoint "${id}" not found.`);
    return row;
  }

  async delete(ctx: AccountContext, id: string): Promise<void> {
    throwIfMissingScope(ctx, 'admin');
    const row = await this.repo.findEndpoint(id, ctx.account.id);
    if (!row) throw new NotFoundError(`Webhook endpoint "${id}" not found.`);
    if (row.disabledAt !== null) return; // idempotent
    await this.repo.disableEndpoint(id, new Date());
  }

  listDeliveries(
    ctx: AccountContext,
    endpointId: string,
    opts: { limit: number; cursor?: string; status?: WebhookDeliveryStatus },
  ): Promise<ListDeliveriesPage> {
    return this.repo.listDeliveriesForEndpoint(endpointId, ctx.account.id, opts);
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
