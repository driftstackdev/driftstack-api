// V-295c3-tombstone — admin endpoints for status-page email subscribers.
//
//   GET  /v1/admin/status-subscribers              — paginated list
//   POST /v1/admin/status-subscribers/:id/force-unsubscribe
//
// Both gated by driftstack_internal_admin scope. force-unsubscribe
// writes admin_audit_log via the V-281 dual-write pattern.
//
// The 90d email-purge cron is wired separately (in bootstrap as a daily
// setInterval); it is not exposed as an HTTP endpoint.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AdminAuditService } from '../services/admin-audit.js';
import type { StatusSubscribersService } from '../services/status-subscribers.js';
import { ValidationError } from '../lib/errors.js';
import { readClientIp } from '../lib/client-ip.js';

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const PUBLIC_ID_RE = /^sub_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function uuidFromPrefixedId(value: string): string {
  const match = PUBLIC_ID_RE.exec(value);
  if (!match || !match[1]) {
    throw new ValidationError({
      formErrors: ['Invalid id format. Expected "sub_<uuid>".'],
      fieldErrors: {},
    });
  }
  return match[1];
}

export interface AdminStatusSubscribersRoutesOptions {
  service: StatusSubscribersService;
  audit: AdminAuditService;
}

export function registerAdminStatusSubscribersRoutes(
  app: FastifyInstance,
  opts: AdminStatusSubscribersRoutesOptions,
): void {
  const { service, audit } = opts;

  app.get(
    '/v1/admin/status-subscribers',
    { preHandler: [app.requireScope('driftstack_internal_admin')] },
    async (request) => {
      const parsed = ListQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      const rows = await service.listAll({
        ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
        ...(parsed.data.offset !== undefined ? { offset: parsed.data.offset } : {}),
      });
      return {
        data: rows.map((row) => ({
          id: `sub_${row.id}`,
          email: row.email,
          confirmed_at: row.confirmedAt ? row.confirmedAt.toISOString() : null,
          unsubscribed_at: row.unsubscribedAt ? row.unsubscribedAt.toISOString() : null,
          created_at: row.createdAt.toISOString(),
        })),
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/admin/status-subscribers/:id/force-unsubscribe',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const id = uuidFromPrefixedId(request.params.id);
      let result: { email: string | null } | null = null;
      try {
        result = await service.forceUnsubscribe(id, new Date());
        await audit.record({
          adminAccountId: ctx.account.id,
          adminKeyId: ctx.apiKey.id,
          action: 'status_subscriber.force_unsubscribed',
          targetAccountId: null,
          targetResourceId: `sub_${id}`,
          inputPayload: { email: result.email },
          result: 'success',
          ipAddress: readClientIp(request),
        });
      } catch (err) {
        const code =
          err instanceof Error && err.name
            ? err.name.toLowerCase().replace(/error$/, '')
            : 'unknown';
        await audit.record({
          adminAccountId: ctx.account.id,
          adminKeyId: ctx.apiKey.id,
          action: 'status_subscriber.force_unsubscribed',
          targetAccountId: null,
          targetResourceId: `sub_${id}`,
          inputPayload: {},
          result: `error: ${code}`,
          ipAddress: readClientIp(request),
        });
        throw err;
      }
      return reply.code(200).send({
        message: 'Subscriber force-unsubscribed.',
        email: result.email,
      });
    },
  );
}
