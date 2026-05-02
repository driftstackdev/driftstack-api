// Webhook subscription routes — POST/GET/DELETE /v1/webhooks
// + GET /v1/webhooks/:id/deliveries.

import type { FastifyInstance } from 'fastify';
import { CreateWebhookRequestSchema, ListDeliveriesQuerySchema } from '@driftstack/api-types';
import { BadRequestError } from '../lib/errors.js';
import type {
  WebhookDeliveryRow,
  WebhookEndpointRow,
  WebhooksService,
} from '../services/webhooks.js';

const PUBLIC_ID_RE = /^[a-z]{3}_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function uuidFromPrefixedId(value: string, expectedPrefix: string): string {
  const match = PUBLIC_ID_RE.exec(value);
  if (!match || !match[1] || !value.startsWith(`${expectedPrefix}_`)) {
    throw new BadRequestError(`Invalid id format. Expected "${expectedPrefix}_<uuid>".`);
  }
  return match[1];
}

function publicEndpoint(row: WebhookEndpointRow): Record<string, unknown> {
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

  app.get(
    '/v1/webhooks',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const rows = await service.list(ctx);
      return { data: rows.map(publicEndpoint) };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/webhooks/:id',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const id = uuidFromPrefixedId(request.params.id, 'whk');
      const row = await service.get(ctx, id);
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
      const page = await service.listDeliveries(ctx, id, {
        limit: query.limit,
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
      });
      return {
        data: page.items.map(publicDelivery),
        has_more: page.nextCursor !== null,
        next_cursor: page.nextCursor,
      };
    },
  );
}
