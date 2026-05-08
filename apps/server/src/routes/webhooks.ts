// Webhook subscription routes — POST/GET/DELETE /v1/webhooks
// + GET /v1/webhooks/:id/deliveries.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { CreateWebhookRequestSchema, ListDeliveriesQuerySchema } from '@driftstack/api-types';
import { BadRequestError } from '../lib/errors.js';
import type {
  WebhookDeliveryRow,
  WebhookEndpointRow,
  WebhooksService,
} from '../services/webhooks.js';
import { resolveEffectiveAccount } from '../services/auth.js';

const EFFECTIVE_ACCOUNT_HEADER = 'x-driftstack-account';

function readEffectiveAccountHeader(request: FastifyRequest): string | undefined {
  const raw = request.headers[EFFECTIVE_ACCOUNT_HEADER];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

const PUBLIC_ID_RE = /^[a-z]{3}_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function uuidFromPrefixedId(value: string, expectedPrefix: string): string {
  const match = PUBLIC_ID_RE.exec(value);
  if (!match || !match[1] || !value.startsWith(`${expectedPrefix}_`)) {
    throw new BadRequestError(`Invalid id format. Expected "${expectedPrefix}_<uuid>".`);
  }
  return match[1];
}

function publicEndpoint(
  row: WebhookEndpointRow,
  counts: { delivered: number; failed: number; dlq: number } = {
    delivered: 0,
    failed: 0,
    dlq: 0,
  },
): Record<string, unknown> {
  return {
    id: `whk_${row.id}`,
    url: row.url,
    secret_prefix: row.secretPrefix,
    events: row.events,
    description: row.description,
    active: row.active,
    consecutive_failures: row.consecutiveFailures,
    last_success_at: row.lastSuccessAt ? row.lastSuccessAt.toISOString() : null,
    last_failure_at: row.lastFailureAt ? row.lastFailureAt.toISOString() : null,
    disabled_at: row.disabledAt ? row.disabledAt.toISOString() : null,
    /** V-185 — aggregate per-endpoint delivery counts. */
    delivery_counts: counts,
    created_at: row.createdAt.toISOString(),
  };
}

function publicDelivery(row: WebhookDeliveryRow): Record<string, unknown> {
  return {
    id: `wdl_${row.id}`,
    webhook_id: `whk_${row.webhookId}`,
    event_id: row.eventId,
    event_type: row.eventType,
    status: row.status,
    attempts: row.attempts,
    next_attempt_at: row.nextAttemptAt.toISOString(),
    last_response_status: row.lastResponseStatus,
    last_response_excerpt: row.lastResponseExcerpt,
    last_error: row.lastError,
    delivered_at: row.deliveredAt ? row.deliveredAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
  };
}

export interface WebhookRoutesOptions {
  service: WebhooksService;
}

export function registerWebhookRoutes(app: FastifyInstance, opts: WebhookRoutesOptions): void {
  const { service } = opts;

  app.post(
    '/v1/webhooks',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const body = CreateWebhookRequestSchema.parse(request.body ?? {});
      const created = await service.create(ctx, {
        url: body.url,
        events: body.events,
        description: body.description ?? null,
      });
      return reply.code(201).send({
        ...publicEndpoint(created.row),
        secret: created.plaintextSecret,
      });
    },
  );

  // V-330f — read endpoints + per-endpoint counts, scoped to the
  // OWNER when X-Driftstack-Account is set. Read-only; both roles
  // allowed. POST/DELETE on webhooks remain self-only until the
  // V-326e write-side cycle picks them up (admin-only per Q1).
  app.get(
    '/v1/webhooks',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));
      const rowsWithCounts = await service.listWithCounts(
        ctx,
        effective.kind === 'team' ? { effectiveAccountId: effective.accountId } : {},
      );
      return { data: rowsWithCounts.map((r) => publicEndpoint(r.endpoint, r.counts)) };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/webhooks/:id',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));
      const id = uuidFromPrefixedId(request.params.id, 'whk');
      const row = await service.get(
        ctx,
        id,
        effective.kind === 'team' ? { effectiveAccountId: effective.accountId } : {},
      );
      return publicEndpoint(row);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/webhooks/:id',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const id = uuidFromPrefixedId(request.params.id, 'whk');
      await service.delete(ctx, id);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/webhooks/:id/deliveries',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const id = uuidFromPrefixedId(request.params.id, 'whk');
      const query = ListDeliveriesQuerySchema.parse(request.query ?? {});
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));
      const page = await service.listDeliveries(ctx, id, {
        limit: query.limit,
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(effective.kind === 'team' ? { effectiveAccountId: effective.accountId } : {}),
      });
      return {
        data: page.items.map(publicDelivery),
        has_more: page.nextCursor !== null,
        next_cursor: page.nextCursor,
      };
    },
  );

  // V-307 — customer self-service replay. Different from the admin
  // /v1/admin/webhook-deliveries/:id/replay (which can replay any
  // account's delivery): this one is account-scoped and 404s if the
  // delivery isn't owned by the calling account.
  app.post<{ Params: { deliveryId: string } }>(
    '/v1/webhook-deliveries/:deliveryId/replay',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const deliveryId = uuidFromPrefixedId(request.params.deliveryId, 'wdl');
      const updated = await service.replayDeliveryAsCustomer(ctx, deliveryId);
      return reply.code(200).send(publicDelivery(updated));
    },
  );
}
