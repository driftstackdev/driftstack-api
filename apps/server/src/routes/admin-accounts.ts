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
  AddSupportNoteRequestSchema,
  ChangeTierRequestSchema,
  ClearQuotaOverrideQuerySchema,
  DeleteAccountRequestSchema,
  RecordRefundRequestSchema,
  SetQuotaOverrideRequestSchema,
  SuspendAccountRequestSchema,
  UnsuspendAccountRequestSchema,
} from '@driftstack/api-types';

const ListAdminAccountsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  // Slice 147 — defensive cap matching slice 117 convention; see
  // admin-api-keys.ts for the same shape + rationale (512 covers
  // any base64url-encoded {ts, uuid} pagination token).
  cursor: z.string().min(1).max(512).optional(),
  status: AccountStatusSchema.optional(),
  tier: AccountTierSchema.optional(),
  email_contains: z.string().min(1).max(254).optional(),
});
import type { AccountsAdminService } from '../services/admin-accounts.js';
import type { AccountAuditService } from '../services/account-audit.js';
import type { AdminAuditService, AdminAuditAction } from '../services/admin-audit.js';
import type { AccountRow } from '../services/auth.js';
import type {
  RateLimitOverrideRecord,
  RateLimitOverridesService,
} from '../services/rate-limit-overrides.js';
import type { UsageService, UsageSummary } from '../services/usage.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import { readClientIp } from '../lib/client-ip.js';

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

export interface AdminAccountsRoutesOptions {
  accountsAdmin: AccountsAdminService;
  usage: UsageService;
  rateLimitOverrides: RateLimitOverridesService;
  audit: AdminAuditService;
  /**
   * V-281 — customer-audit recorder. Used by the new
   * `audit-note` + `record-refund` endpoints to write a customer-
   * visible audit row in addition to the admin-audit row. Optional
   * during the migration window — when omitted, the new endpoints
   * are not registered.
   */
  accountAudit?: AccountAuditService;
}

export function registerAdminAccountsRoutes(
  app: FastifyInstance,
  opts: AdminAccountsRoutesOptions,
): void {
  const { accountsAdmin, usage, rateLimitOverrides, audit, accountAudit } = opts;

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
        ipAddress: readClientIp(request),
      });
      return updated;
    } catch (err) {
      const code =
        err instanceof Error && err.name ? err.name.toLowerCase().replace(/error$/, '') : 'unknown';
      await audit.record({
        adminAccountId: ctx.account.id,
        adminKeyId: ctx.apiKey.id,
        action,
        // V-1585 — `admin_audit_log.target_account_id` is a foreign key to
        // `accounts`. On this path the action has already failed, and when it
        // failed BECAUSE the account does not exist, writing the id here violates
        // that constraint. The constraint error then replaces the thrown
        // NotFound, so an admin acting on an absent account saw a 500 where the
        // route had correctly produced a 404. The id moves to
        // `target_resource_id`, which is plain text and carries no key, so the
        // attempt stays attributable — a failed staff action is exactly the row
        // worth keeping.
        ...(err instanceof NotFoundError
          ? { targetAccountId: null, targetResourceId: targetAccountId }
          : { targetAccountId }),
        inputPayload,
        result: `error: ${code}`,
        ipAddress: readClientIp(request),
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

  // ── POST /v1/admin/accounts/:id/delete ─────────────────────────────────
  // GDPR Article 17 — admin-triggered account termination. Sets
  // status='deleted' + best-effort reclaims sessions/web-sessions/API-keys/
  // webhooks (AccountsAdminService.deleteAccount). Same shape as
  // suspend/unsuspend above; the BYOK Anthropic key purge happens later via
  // the account-deletion-purge-sweeper (30-day retention per privacy-
  // policy.md §3.5/§9), not synchronously here.
  app.post<{ Params: { id: string } }>(
    '/v1/admin/accounts/:id/delete',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const accountId = uuidFromPrefixedId(request.params.id, 'acc');
      const body = DeleteAccountRequestSchema.parse(request.body ?? {});

      const updated = await withAudit(
        request,
        'account.deleted',
        accountId,
        { ...(body.reason ? { reason: body.reason } : {}) },
        () => accountsAdmin.deleteAccount(ctx, accountId),
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

  // ── V-281 — POST /v1/admin/accounts/:id/audit-note ─────────────────────
  // Records a free-form admin support note on the customer's audit log.
  // Audit-only — no side effect on account state. Both surfaces (the
  // admin_audit_log via withAudit, and the customer-visible
  // account_audit log via accountAudit.record) are written so the note
  // is visible on the per-customer audit slice + the admin audit table.
  if (accountAudit !== undefined) {
    app.post<{ Params: { id: string } }>(
      '/v1/admin/accounts/:id/audit-note',
      {
        preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
      },
      async (request, reply) => {
        const ctx = request.account;
        if (!ctx) throw new Error('account context missing after requireAuth');
        const accountId = uuidFromPrefixedId(request.params.id, 'acc');
        const body = AddSupportNoteRequestSchema.parse(request.body ?? {});

        // Confirm target exists.
        await accountsAdmin.getAccount(ctx, accountId);

        await withAudit(request, 'audit_note.added', accountId, { note: body.note }, async () => {
          await accountAudit.record({
            accountId,
            actorType: 'staff',
            actorAccountId: ctx.account.id,
            actorKeyId: ctx.apiKey.id,
            action: 'admin.support_note',
            targetResourceId: null,
            payload: { note: body.note },
            ipAddress: readClientIp(request),
          });
          return await accountsAdmin.getAccount(ctx, accountId);
        });

        return reply.code(201).send({ ok: true as const });
      },
    );

    // ── V-281 — POST /v1/admin/accounts/:id/refund-record ─────────────────
    // Records that the operator manually refunded a Stripe charge via
    // the Stripe dashboard. Audit-only — does NOT call Stripe. Money
    // movement is always operator-driven via Stripe per the V-280
    // launch-day runbook + the founder's tier-3 boundary on direct
    // financial actions.
    app.post<{ Params: { id: string } }>(
      '/v1/admin/accounts/:id/refund-record',
      {
        preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
      },
      async (request, reply) => {
        const ctx = request.account;
        if (!ctx) throw new Error('account context missing after requireAuth');
        const accountId = uuidFromPrefixedId(request.params.id, 'acc');
        const body = RecordRefundRequestSchema.parse(request.body ?? {});

        await accountsAdmin.getAccount(ctx, accountId);

        const payload = {
          external_reference: body.external_reference,
          amount_cents: body.amount_cents,
          currency: body.currency ?? 'USD',
          reason: body.reason,
        };
        await withAudit(request, 'refund.recorded', accountId, payload, async () => {
          await accountAudit.record({
            accountId,
            actorType: 'staff',
            actorAccountId: ctx.account.id,
            actorKeyId: ctx.apiKey.id,
            action: 'admin.refund_recorded',
            targetResourceId: body.external_reference,
            payload,
            ipAddress: readClientIp(request),
          });
          return await accountsAdmin.getAccount(ctx, accountId);
        });

        return reply.code(201).send({ ok: true as const });
      },
    );
  }

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
        ipAddress: readClientIp(request),
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
        ipAddress: readClientIp(request),
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
        ipAddress: readClientIp(request),
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
        ipAddress: readClientIp(request),
      });
      throw err;
    }
  }
}
