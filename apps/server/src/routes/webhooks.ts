// Webhook subscription routes — POST/GET/DELETE /v1/webhooks
// + GET /v1/webhooks/:id/deliveries.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  CreateWebhookRequestSchema,
  ListDeliveriesQuerySchema,
  UpdateWebhookRequestSchema,
} from '@driftstack/api-types';
import { BadRequestError, ForbiddenError } from '../lib/errors.js';
import type {
  WebhookDeliveryRow,
  WebhookEndpointRow,
  WebhooksService,
} from '../services/webhooks.js';
import { resolveEffectiveAccount } from '../services/auth.js';
import { readEffectiveAccountHeader } from '../lib/effective-account-header.js';
import { unsafeWebhookTargetReason } from '../lib/webhook-target-guard.js';

/**
 * V-326e5 — admin-only gate for webhook write operations on team
 * owners. Returns the effective accountId (string) when team write
 * should proceed, or undefined when self-scoped. Throws ForbiddenError
 * on member-role team requests.
 */
function effectiveAccountIdForWrite(
  request: FastifyRequest,
  ctx: NonNullable<FastifyRequest['account']>,
): string | undefined {
  const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));
  if (effective.kind !== 'team') return undefined;
  if (effective.role !== 'admin') {
    throw new ForbiddenError('Webhook writes on a team owner require admin role on that team.');
  }
  return effective.accountId;
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
  // V-359 — surface the rotation grace state when active. The previous
  // secret's first-12-chars are non-sensitive (same shape as the
  // current secret_prefix display); the grace expiry lets the
  // dashboard show "rotation ends in <X>" so customers know how much
  // longer dual-signing is in effect. Both null when no rotation in
  // flight.
  const rotationActive =
    row.secretPrev !== null &&
    row.secretPrevExpiresAt !== null &&
    row.secretPrevExpiresAt.getTime() > Date.now();
  return {
    id: `whk_${row.id}`,
    url: row.url,
    secret_prefix: row.secretPrefix,
    prev_secret_prefix:
      rotationActive && row.secretPrev !== null ? row.secretPrev.slice(0, 12) : null,
    rotation_grace_expires_at:
      rotationActive && row.secretPrevExpiresAt !== null
        ? row.secretPrevExpiresAt.toISOString()
        : null,
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

  // V-326e5 — admin-only when targeting a team owner.
  app.post(
    '/v1/webhooks',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const body = CreateWebhookRequestSchema.parse(request.body ?? {});
      // SSRF guard — reject a webhook URL pointed at a private/loopback/
      // reserved address or localhost (the delivery worker runs on our infra).
      const unsafe = unsafeWebhookTargetReason(body.url);
      if (unsafe !== null) throw new BadRequestError(unsafe);
      const eff = effectiveAccountIdForWrite(request, ctx);
      const created = await service.create(
        ctx,
        {
          url: body.url,
          events: body.events,
          description: body.description ?? null,
        },
        eff !== undefined ? { effectiveAccountId: eff } : {},
      );
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

  // V-326e5 — admin-only when targeting a team owner.
  app.delete<{ Params: { id: string } }>(
    '/v1/webhooks/:id',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const id = uuidFromPrefixedId(request.params.id, 'whk');
      const eff = effectiveAccountIdForWrite(request, ctx);
      await service.delete(ctx, id, eff !== undefined ? { effectiveAccountId: eff } : {});
      return reply.code(204).send();
    },
  );

  // V-351 — partial update. Mirror of POST + DELETE for the
  // V-326e5 admin-only-on-team gate. Disabled endpoints cannot be
  // updated (the repo enforces; this returns 409).
  app.patch<{ Params: { id: string } }>(
    '/v1/webhooks/:id',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const id = uuidFromPrefixedId(request.params.id, 'whk');
      const parsed = UpdateWebhookRequestSchema.safeParse(request.body);
      if (!parsed.success)
        throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid body.');
      // SSRF guard on a changed URL (partial update; url is optional).
      if (parsed.data.url !== undefined) {
        const unsafe = unsafeWebhookTargetReason(parsed.data.url);
        if (unsafe !== null) throw new BadRequestError(unsafe);
      }
      const eff = effectiveAccountIdForWrite(request, ctx);
      const row = await service.update(
        ctx,
        id,
        parsed.data,
        eff !== undefined ? { effectiveAccountId: eff } : {},
      );
      return publicEndpoint(row);
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
      // S32 2026-07-07 honoured team act-as here, but replay RE-FIRES the
      // delivery — a write — so it takes the same admin-only-on-team gate as
      // create/update/delete/rotate (effectiveAccountIdForWrite throws for a
      // member role), NOT the read-only act-as of listDeliveries. Without it a
      // non-admin team member could replay the owner's deliveries. (Fable
      // audit-2 2026-07-08, C5.)
      const eff = effectiveAccountIdForWrite(request, ctx);
      const updated = await service.replayDeliveryAsCustomer(ctx, deliveryId, {
        ...(eff !== undefined ? { effectiveAccountId: eff } : {}),
      });
      return reply.code(200).send(publicDelivery(updated));
    },
  );

  // V-359 — rotate the signing secret with a 24h grace. New plaintext
  // returned ONCE; worker dual-signs every outbound delivery with both
  // the new + old secret while `secret_prev_expires_at > now`.
  // Admin-only on team-scoped requests (same gate as create / update /
  // delete / send-test).
  app.post<{ Params: { id: string } }>(
    '/v1/webhooks/:id/rotate-secret',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const id = uuidFromPrefixedId(request.params.id, 'whk');
      const eff = effectiveAccountIdForWrite(request, ctx);
      const result = await service.rotateSecret(
        ctx,
        id,
        eff !== undefined ? { effectiveAccountId: eff } : {},
      );
      return reply.code(200).send({
        id: `whk_${result.row.id}`,
        secret: result.plaintextSecret,
        secret_prefix: result.row.secretPrefix,
        prev_secret_prefix: result.row.secretPrev ? result.row.secretPrev.slice(0, 12) : '',
        grace_expires_at: result.row.secretPrevExpiresAt
          ? result.row.secretPrevExpiresAt.toISOString()
          : new Date().toISOString(),
      });
    },
  );

  // V-356 — send a synthetic test.ping event to the endpoint,
  // bypassing subscription. Lets the customer verify their handler
  // before relying on it for real events. Admin-only when targeting
  // a team owner (same gate as create / update / delete).
  app.post<{ Params: { id: string } }>(
    '/v1/webhooks/:id/test',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const id = uuidFromPrefixedId(request.params.id, 'whk');
      const eff = effectiveAccountIdForWrite(request, ctx);
      const result = await service.sendTestEvent(
        ctx,
        id,
        eff !== undefined ? { effectiveAccountId: eff } : {},
      );
      return reply.code(202).send({
        delivery_id: `wdl_${result.deliveryId}`,
        event_id: result.eventId,
        event_type: 'test.ping',
      });
    },
  );
}
