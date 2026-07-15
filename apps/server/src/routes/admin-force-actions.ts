// V-100: admin force-actions on customer resources.
//
//   POST /v1/admin/sessions/:id/destroy   — force-destroy a customer session
//   POST /v1/admin/api-keys/:id/revoke    — force-revoke a customer API key
//
// These bypass the usual ownership check (admin scope only). Both
// write an admin_audit_log row before responding (D-025: audit-write
// before response is not best-effort).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AdminAuditService, AdminAuditAction } from '../services/admin-audit.js';
import { destroyDriverSessionWithTimeout, type SessionRepo } from '../services/sessions.js';
import type { ApiKeysRepo } from '../services/api-keys.js';
import type { Driver } from '../drivers/types.js';
import type { AuthCache } from '../services/auth-cache.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import { requireScope } from '../lib/errors-helpers.js';
import { readClientIp } from '../lib/client-ip.js';

const PUBLIC_ID_RE = /^[a-z]{3}_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function uuidFromPrefixedId(value: string, expectedPrefix: string): string {
  const match = PUBLIC_ID_RE.exec(value);
  if (!match || !match[1] || !value.startsWith(`${expectedPrefix}_`)) {
    throw new BadRequestError(`Invalid id format. Expected "${expectedPrefix}_<uuid>".`);
  }
  return match[1];
}

const ForceActionBodySchema = z
  .object({
    reason: z.string().min(1).max(500).optional(),
  })
  .optional();

type DeferredAuditValue<T> = T | (() => T);

function resolveAuditValue<T>(value: DeferredAuditValue<T>): T {
  return typeof value === 'function' ? (value as () => T)() : value;
}

export interface AdminForceActionsRoutesOptions {
  sessionRepo: SessionRepo;
  apiKeysRepo: ApiKeysRepo;
  driver: Driver;
  audit: AdminAuditService;
  authCache: AuthCache | null;
}

export function registerAdminForceActionRoutes(
  app: FastifyInstance,
  opts: AdminForceActionsRoutesOptions,
): void {
  const { sessionRepo, apiKeysRepo, driver, audit, authCache } = opts;

  /**
   * Wrap a force-action with audit-on-success + audit-on-error per D-025.
   */
  async function withAudit<T>(
    request: FastifyRequest,
    action: AdminAuditAction,
    args: {
      targetAccountId: DeferredAuditValue<string | null>;
      targetResourceId: string;
      inputPayload: DeferredAuditValue<Record<string, unknown>>;
      perform: () => Promise<T>;
    },
  ): Promise<T> {
    const ctx = request.account;
    if (!ctx) throw new Error('account context missing after requireAuth');
    try {
      const result = await args.perform();
      await audit.record({
        adminAccountId: ctx.account.id,
        adminKeyId: ctx.apiKey.id,
        action,
        targetAccountId: resolveAuditValue(args.targetAccountId),
        targetResourceId: args.targetResourceId,
        inputPayload: resolveAuditValue(args.inputPayload),
        result: 'success',
        ipAddress: readClientIp(request),
      });
      return result;
    } catch (err) {
      const normalizedCode =
        err instanceof Error && err.name ? err.name.toLowerCase().replace(/error$/, '') : 'unknown';
      const code = normalizedCode || 'unknown';
      await audit.record({
        adminAccountId: ctx.account.id,
        adminKeyId: ctx.apiKey.id,
        action,
        targetAccountId: resolveAuditValue(args.targetAccountId),
        targetResourceId: args.targetResourceId,
        inputPayload: resolveAuditValue(args.inputPayload),
        result: `error: ${code}`,
        ipAddress: readClientIp(request),
      });
      throw err;
    }
  }

  // ── POST /v1/admin/sessions/:id/destroy ───────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/v1/admin/sessions/:id/destroy',
    { preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      requireScope(ctx, 'driftstack_internal_admin');

      const sessionId = uuidFromPrefixedId(request.params.id, 'ses');
      const parsed = ForceActionBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) throw new BadRequestError('Invalid body.');
      const reason = parsed.data?.reason;

      const inputPayload = reason !== undefined ? { reason } : {};
      let targetAccountId: string | null = null;
      let resolvedInputPayload: Record<string, unknown> = inputPayload;
      const outcome = await withAudit(request, 'session.destroyed_by_admin', {
        targetAccountId: () => targetAccountId,
        targetResourceId: sessionId,
        inputPayload: () => resolvedInputPayload,
        perform: async () => {
          const result = await sessionRepo.destroySessionSerialized(
            {
              id: sessionId,
              accountId: null,
              destroyedAt: new Date(),
              event: {
                type: 'destroyed',
                payload: {
                  force: true,
                  by_admin: true,
                  ...(reason !== undefined ? { reason } : {}),
                },
                durationMs: null,
              },
            },
            (session) =>
              destroyDriverSessionWithTimeout(() => driver.destroy(session.driverSessionId)),
          );
          if (result.kind === 'not_found') {
            throw new NotFoundError(`Session "${sessionId}" not found.`);
          }
          targetAccountId = result.session.accountId;
          if (result.kind === 'already_terminal') {
            resolvedInputPayload = { ...inputPayload, idempotent: true };
            return result;
          }
          if (result.kind === 'driver_error') throw result.error;
          return result;
        },
      });
      return {
        id: `ses_${outcome.session.id}`,
        status: 'destroyed',
        destroyed_at: outcome.session.destroyedAt?.toISOString() ?? null,
      };
    },
  );

  // ── POST /v1/admin/api-keys/:id/revoke ────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/v1/admin/api-keys/:id/revoke',
    { preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      requireScope(ctx, 'driftstack_internal_admin');

      const keyId = uuidFromPrefixedId(request.params.id, 'key');
      const parsed = ForceActionBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) throw new BadRequestError('Invalid body.');
      const reason = parsed.data?.reason;

      const inputPayload = reason !== undefined ? { reason } : {};
      let targetAccountId: string | null = null;
      let resolvedInputPayload: Record<string, unknown> = inputPayload;
      const outcome = await withAudit(request, 'api_key.revoked_by_admin', {
        targetAccountId: () => targetAccountId,
        targetResourceId: keyId,
        inputPayload: () => resolvedInputPayload,
        perform: async () => {
          const result = await apiKeysRepo.revokeApiKeyAtomic({
            id: keyId,
            accountId: null,
            revokedAt: new Date(),
          });
          if (result.kind === 'not_found') {
            throw new NotFoundError(`API key "${keyId}" not found.`);
          }
          const key = result.key;
          targetAccountId = key.accountId;
          if (key.revokedAt === null) {
            throw new Error('revokeApiKeyAtomic returned a revoked row without revokedAt');
          }
          if (result.kind === 'already_revoked') {
            resolvedInputPayload = { ...inputPayload, idempotent: true };
            return result;
          }
          // Invalidate any cached AccountContext entries for this key
          // so the next auth read sees the revocation immediately
          // (D-020 cache invalidation pattern).
          if (authCache !== null) {
            try {
              await authCache.invalidateKey(key.id);
            } catch {
              /* cache failure non-fatal */
            }
          }
          return result;
        },
      });
      const persistedRevokedAt = outcome.key.revokedAt;
      if (persistedRevokedAt === null) {
        throw new Error('audited API-key revoke returned no persisted timestamp');
      }
      return {
        id: `key_${outcome.key.id}`,
        revoked_at: persistedRevokedAt.toISOString(),
      };
    },
  );
}
