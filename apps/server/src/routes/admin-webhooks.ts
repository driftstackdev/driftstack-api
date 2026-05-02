// Admin-only webhook ops routes — replay, requeue, get-by-id, DLQ list.
// All require admin scope. Each mutating endpoint records an audit row
// before returning (D-025 audit-write-before-response contract).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ListDlqQuerySchema, type ListDlqQueryInput } from '@driftstack/api-types';
import type {
  WebhookDeliveryRow,
  WebhookEventType,
  WebhookDeliveryStatus,
  WebhooksAdminService,
} from '../services/webhooks.js';
import type { AdminAuditAction, AdminAuditService } from '../services/admin-audit.js';
import { BadRequestError } from '../lib/errors.js';

const PUBLIC_ID_RE = /^[a-z]{3}_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function uuidFromPrefixedId(value: string, expectedPrefix: string): string {
  const match = PUBLIC_ID_RE.exec(value);
  if (!match || !match[1] || !value.startsWith(`${expectedPrefix}_`)) {
    throw new BadRequestError(`Invalid id format. Expected "${expectedPrefix}_<uuid>".`);
  }
  return match[1];
}

function publicDelivery(row: WebhookDeliveryRow): Record<string, unknown> {
  return {
    id: `wdl_${row.id}`,
    webhook_id: `whk_${row.webhookId}`,
    event_id: row.eventId,
    event_type: row.eventType satisfies WebhookEventType,
    status: row.status satisfies WebhookDeliveryStatus,
    attempts: row.attempts,
    next_attempt_at: row.nextAttemptAt.toISOString(),
    last_response_status: row.lastResponseStatus,
    last_response_excerpt: row.lastResponseExcerpt,
    last_error: row.lastError,
    delivered_at: row.deliveredAt ? row.deliveredAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
  };
}

function clientIp(request: FastifyRequest): string | null {
  const xff = request.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.ip;
}

export interface AdminWebhooksRoutesOptions {
  webhooksAdmin: WebhooksAdminService;
  audit: AdminAuditService;
}

export function registerAdminWebhookRoutes(
  app: FastifyInstance,
  opts: AdminWebhooksRoutesOptions,
): void {
  const { webhooksAdmin, audit } = opts;

  // Wrap a mutation in audit-on-success / audit-on-error. The
  // targetResourceId is the public-prefixed delivery id (the audit row
  // captures what the admin sees, not the raw uuid).
  async function withAudit(
    request: FastifyRequest,
    action: AdminAuditAction,
    targetResourceId: string,
    inputPayload: Record<string, unknown>,
    perform: () => Promise<WebhookDeliveryRow>,
  ): Promise<WebhookDeliveryRow> {
    const ctx = request.account;
    if (!ctx) throw new Error('account context missing after requireAuth');
    try {
      const updated = await perform();
      await audit.record({
        adminAccountId: ctx.account.id,
        adminKeyId: ctx.apiKey.id,
        action,
        targetResourceId,
        inputPayload,
        result: 'success',
        ipAddress: clientIp(request),
      });
      return updated;
    } catch (err) {
      const code =
        err instanceof Error && err.name ? err.name.toLowerCase().replace(/error$/, '') : 'unknown';
      await audit.record({
        adminAccountId: ctx.account.id,
        adminKeyId: ctx.apiKey.id,
        action,
        targetResourceId,
        inputPayload,
        result: `error: ${code}`,
        ipAddress: clientIp(request),
      });
      throw err;
    }
  }

  // ── GET /v1/admin/webhook-deliveries/:id ───────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/v1/admin/webhook-deliveries/:id',
    {
      preHandler: [app.requireAuth, app.rateLimit('global')],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const id = uuidFromPrefixedId(request.params.id, 'wdl');
      const row = await webhooksAdmin.getDelivery(ctx, id);
      return publicDelivery(row);
    },
  );

  // ── POST /v1/admin/webhook-deliveries/:id/replay ──────────────────────
  app.post<{ Params: { id: string } }>(
    '/v1/admin/webhook-deliveries/:id/replay',
    {
      preHandler: [app.requireAuth, app.rateLimit('global')],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const id = uuidFromPrefixedId(request.params.id, 'wdl');
      const updated = await withAudit(
        request,
        'webhook_delivery.replayed',
        request.params.id,
        {},
        () => webhooksAdmin.replayDelivery(ctx, id),
      );
      return publicDelivery(updated);
    },
  );

  // ── GET /v1/admin/webhook-dlq ──────────────────────────────────────────
  app.get(
    '/v1/admin/webhook-dlq',
    {
      preHandler: [app.requireAuth, app.rateLimit('global')],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const rawQuery = (request.query ?? {}) as ListDlqQueryInput;
      const query = ListDlqQuerySchema.parse(rawQuery);
      const page = await webhooksAdmin.listDlq(ctx, {
        limit: query.limit,
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      });
      return {
        data: page.items.map(publicDelivery),
        next_cursor: page.nextCursor,
      };
    },
  );

  // ── POST /v1/admin/webhook-dlq/:id/requeue ─────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/v1/admin/webhook-dlq/:id/requeue',
    {
      preHandler: [app.requireAuth, app.rateLimit('global')],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const id = uuidFromPrefixedId(request.params.id, 'wdl');
      const updated = await withAudit(
        request,
        'webhook_delivery.requeued',
        request.params.id,
        {},
        () => webhooksAdmin.requeueFromDlq(ctx, id),
      );
      return publicDelivery(updated);
    },
  );
}
