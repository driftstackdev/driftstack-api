// Admin-only account routes — /v1/admin/accounts/:id/{tier,suspend,unsuspend}.
//
// Each endpoint:
//   1. Validates input (Zod).
//   2. Calls the AccountsAdminService — which checks the admin scope,
//      mutates state, and invalidates the auth cache.
//   3. Writes an admin_audit_log row BEFORE returning. Audit failure
//      fails the request (D-025: audit-write-before-response is not
//      best-effort).
//
// The audit row records the input the admin sent, the action taken,
// and the result (success or error code). On NotFound we still write
// an audit row before re-throwing so the attempt is visible.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AccountStatusSchema,
  AccountTierSchema,
  ChangeTierRequestSchema,
  ClearQuotaOverrideQuerySchema,
  SetQuotaOverrideRequestSchema,
  SuspendAccountRequestSchema,
  UnsuspendAccountRequestSchema,
} from '@driftstack/api-types';

const ListAdminAccountsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
  status: AccountStatusSchema.optional(),
  tier: AccountTierSchema.optional(),
  email_contains: z.string().min(1).max(254).optional(),
});
import type { AccountsAdminService } from '../services/admin-accounts.js';
import type { AdminAuditService, AdminAuditAction } from '../services/admin-audit.js';
import type { AccountRow } from '../services/auth.js';
import type {
  RateLimitOverrideRecord,
  RateLimitOverridesService,
} from '../services/rate-limit-overrides.js';
import type { UsageService, UsageSummary } from '../services/usage.js';
import { BadRequestError } from '../lib/errors.js';

const PUBLIC_ID_RE = /^[a-z]{3}_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function uuidFromPrefixedId(value: string, expectedPrefix: string): string {
  const match = PUBLIC_ID_RE.exec(value);
  if (!match || !match[1] || !value.startsWith(`${expectedPrefix}_`)) {
    throw new BadRequestError(`Invalid id format. Expected "${expectedPrefix}_<uuid>".`);
  }
  return match[1];
}

function publicAccount(row: AccountRow): Record<string, unknown> {
  return {
    id: `acc_${row.id}`,
    email: row.email,
    name: row.name,
    tier: row.tier,
    status: row.status,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function publicQuotaOverride(r: RateLimitOverrideRecord): Record<string, unknown> {
  return {
    account_id: `acc_${r.accountId}`,
    bucket_key: r.bucketKey,
    capacity: r.capacity,
    refill_per_second: r.refillPerSecond,
    reason: r.reason,
    expires_at: r.expiresAt.toISOString(),
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

function publicUsage(s: UsageSummary, accountId: string): Record<string, unknown> {
  return {
    account_id: `acc_${accountId}`,
    period_start: s.periodStart.toISOString(),
    period_end: s.periodEnd.toISOString(),
    tier: s.tier,
    totals: s.totals,
    quotas: s.quotas,
  };
}

function clientIp(request: FastifyRequest): string | null {
  const xff = request.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    // First entry is the original client.
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.ip ?? null;
}

export interface AdminAccountsRoutesOptions {
  accountsAdmin: AccountsAdminService;
  usage: UsageService;
  rateLimitOverrides: RateLimitOverridesService;
  audit: AdminAuditService;
}

export function registerAdminAccountsRoutes(
  app: FastifyInstance,
  opts: AdminAccountsRoutesOptions,
): void {
  const { accountsAdmin, usage, rateLimitOverrides, audit } = opts;

  // Helper that wraps a mutation with audit-on-success + audit-on-error.
  // The route logic stays focused on the action; the wrapper enforces
  // D-025's "audit before response" contract.
  async function withAudit(
    request: FastifyRequest,
    action: AdminAuditAction,
    targetAccountId: string,
    inputPayload: Record<string, unknown>,
    perform: () => Promise<AccountRow>,
  ): Promise<AccountRow> {
    const ctx = request.account;
    if (!ctx) throw new Error('account context missing after requireAuth');
    try {
      const updated = await perform();
      await audit.record({
        adminAccountId: ctx.account.id,
        adminKeyId: ctx.apiKey.id,
        action,
        targetAccountId,
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
        targetAccountId,
        inputPayload,
        result: `error: ${code}`,
        ipAddress: clientIp(request),
      });
      throw err;
    }
  }

  // ── POST /v1/admin/accounts/:id/tier ────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/v1/admin/accounts/:id/tier',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const accountId = uuidFromPrefixedId(request.params.id, 'acc');
      const body = ChangeTierRequestSchema.parse(request.body ?? {});

      const updated = await withAudit(
        request,
        'account.tier_changed',
        accountId,
        { tier: body.tier, ...(body.reason ? { reason: body.reason } : {}) },
        () => accountsAdmin.changeTier(ctx, accountId, body.tier),
      );
      return publicAccount(updated);
    },
  );

  // ── POST /v1/admin/accounts/:id/suspend ────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/v1/admin/accounts/:id/suspend',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const accountId = uuidFromPrefixedId(request.params.id, 'acc');
      const body = SuspendAccountRequestSchema.parse(request.body ?? {});

      const updated = await withAudit(
        request,
        'account.suspended',
        accountId,
        { ...(body.reason ? { reason: body.reason } : {}) },
        () => accountsAdmin.suspend(ctx, accountId),
      );
      return publicAccount(updated);
    },
  );

  // ── POST /v1/admin/accounts/:id/unsuspend ──────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/v1/admin/accounts/:id/unsuspend',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const accountId = uuidFromPrefixedId(request.params.id, 'acc');
      const body = UnsuspendAccountRequestSchema.parse(request.body ?? {});

      const updated = await withAudit(
        request,
        'account.unsuspended',
        accountId,
        { ...(body.reason ? { reason: body.reason } : {}) },
        () => accountsAdmin.unsuspend(ctx, accountId),
      );
      return publicAccount(updated);
    },
  );

  // ── GET /v1/admin/accounts ──────────────────────────────────────────────
  // List accounts with optional filters: status, tier, email substring.
  // Cursor pagination via `acc_<uuid>` cursor token. Admin scope only.
  app.get(
    '/v1/admin/accounts',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');

      const parsed = ListAdminAccountsQuerySchema.safeParse(request.query);
      if (!parsed.success) throw new BadRequestError('Invalid query parameters.');

      const cursorUuid =
        parsed.data.cursor !== undefined
          ? uuidFromPrefixedId(parsed.data.cursor, 'acc')
          : undefined;

      const page = await accountsAdmin.list(ctx, {
        limit: parsed.data.limit,
        ...(cursorUuid !== undefined ? { cursor: cursorUuid } : {}),
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        ...(parsed.data.tier !== undefined ? { tier: parsed.data.tier } : {}),
        ...(parsed.data.email_contains !== undefined
          ? { emailContains: parsed.data.email_contains }
          : {}),
      });

      return {
        data: page.data.map(publicAccount),
        has_more: page.hasMore,
        next_cursor: page.nextCursor !== null ? `acc_${page.nextCursor}` : null,
      };
    },
  );

  // ── GET /v1/admin/accounts/:id ──────────────────────────────────────────
  // Single-account detail view. Admin scope only; 404 if account doesn't exist.
  app.get<{ Params: { id: string } }>(
    '/v1/admin/accounts/:id',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const accountId = uuidFromPrefixedId(request.params.id, 'acc');
      const target = await accountsAdmin.getAccount(ctx, accountId);
      return publicAccount(target);
    },
  );

  // ── GET /v1/admin/accounts/:id/usage ────────────────────────────────────
  // Period + record_type facets only. "by endpoint" facet deferred per
  // D-025: requires usage_records.endpoint column (doesn't exist) AND
  // production paths that write usage_records (don't exist — see V-014
  // / V-015 amendment for the recordUsage workstream gap).
  app.get<{ Params: { id: string } }>(
    '/v1/admin/accounts/:id/usage',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const accountId = uuidFromPrefixedId(request.params.id, 'acc');
      // getAccount enforces admin scope + 404s on unknown.
      const target = await accountsAdmin.getAccount(ctx, accountId);
      const summary = await usage.summaryFor(target.id, target.tier);
      return publicUsage(summary, target.id);
    },
  );

  // ── POST /v1/admin/accounts/:id/quota-override ─────────────────────────
  // Set or replace a per-account, per-bucket rate-limit override with a
  // duration (seconds). Override is loaded into AccountContext at auth
  // time and consulted by rateLimitConsume; D-020 cache invalidation
  // makes the change effective on the next auth read.
  app.post<{ Params: { id: string } }>(
    '/v1/admin/accounts/:id/quota-override',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const accountId = uuidFromPrefixedId(request.params.id, 'acc');
      const body = SetQuotaOverrideRequestSchema.parse(request.body ?? {});

      // Confirm target exists before recording. (RateLimitOverridesService
      // would write fine without the existence check, but a clean 404
      // on unknown account matches the rest of the admin surface.)
      await accountsAdmin.getAccount(ctx, accountId);

      const expiresAt = new Date(Date.now() + body.duration_seconds * 1000);

      const inputPayload: Record<string, unknown> = {
        bucket_key: body.bucket_key,
        capacity: body.capacity,
        refill_per_second: body.refill_per_second,
        duration_seconds: body.duration_seconds,
        ...(body.reason ? { reason: body.reason } : {}),
      };

      const record = await withAuditOverride(
        request,
        'rate_limit_override.set',
        accountId,
        body.bucket_key,
        inputPayload,
        () =>
          rateLimitOverrides.set(ctx, {
            accountId,
            bucketKey: body.bucket_key,
            capacity: body.capacity,
            refillPerSecond: body.refill_per_second,
            expiresAt,
            ...(body.reason ? { reason: body.reason } : {}),
          }),
      );
      return publicQuotaOverride(record);
    },
  );

  // ── DELETE /v1/admin/accounts/:id/quota-override ───────────────────────
  app.delete<{ Params: { id: string } }>(
    '/v1/admin/accounts/:id/quota-override',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const accountId = uuidFromPrefixedId(request.params.id, 'acc');
      const query = ClearQuotaOverrideQuerySchema.parse(request.query ?? {});

      await withAuditOverrideClear(request, accountId, query.bucket_key, () =>
        rateLimitOverrides.clear(ctx, accountId, query.bucket_key),
      );
      return reply.code(204).send();
    },
  );

  // ─── helpers for override-specific audit shape ──────────────────────────

  async function withAuditOverride(
    request: FastifyRequest,
    action: AdminAuditAction,
    targetAccountId: string,
    bucketKey: string,
    inputPayload: Record<string, unknown>,
    perform: () => Promise<RateLimitOverrideRecord>,
  ): Promise<RateLimitOverrideRecord> {
    const ctx = request.account;
    if (!ctx) throw new Error('account context missing after requireAuth');
    try {
      const record = await perform();
      await audit.record({
        adminAccountId: ctx.account.id,
        adminKeyId: ctx.apiKey.id,
        action,
        targetAccountId,
        targetResourceId: bucketKey,
        inputPayload,
        result: 'success',
        ipAddress: clientIp(request),
      });
      return record;
    } catch (err) {
      const code =
        err instanceof Error && err.name ? err.name.toLowerCase().replace(/error$/, '') : 'unknown';
      await audit.record({
        adminAccountId: ctx.account.id,
        adminKeyId: ctx.apiKey.id,
        action,
        targetAccountId,
        targetResourceId: bucketKey,
        inputPayload,
        result: `error: ${code}`,
        ipAddress: clientIp(request),
      });
      throw err;
    }
  }

  async function withAuditOverrideClear(
    request: FastifyRequest,
    targetAccountId: string,
    bucketKey: string,
    perform: () => Promise<void>,
  ): Promise<void> {
    const ctx = request.account;
    if (!ctx) throw new Error('account context missing after requireAuth');
    try {
      await perform();
      await audit.record({
        adminAccountId: ctx.account.id,
        adminKeyId: ctx.apiKey.id,
        action: 'rate_limit_override.cleared',
        targetAccountId,
        targetResourceId: bucketKey,
        inputPayload: { bucket_key: bucketKey },
        result: 'success',
        ipAddress: clientIp(request),
      });
    } catch (err) {
      const code =
        err instanceof Error && err.name ? err.name.toLowerCase().replace(/error$/, '') : 'unknown';
      await audit.record({
        adminAccountId: ctx.account.id,
        adminKeyId: ctx.apiKey.id,
        action: 'rate_limit_override.cleared',
        targetAccountId,
        targetResourceId: bucketKey,
        inputPayload: { bucket_key: bucketKey },
        result: `error: ${code}`,
        ipAddress: clientIp(request),
      });
      throw err;
    }
  }
}
