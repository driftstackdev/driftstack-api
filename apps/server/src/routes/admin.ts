// Admin routes — API key management + usage view.

import type { FastifyInstance } from 'fastify';
import { CreateApiKeyRequestSchema, UsageSeriesQuerySchema } from '@driftstack/api-types';
import type { ApiKeyRow } from '../services/auth.js';
import type { ApiKeysService } from '../services/api-keys.js';
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

function publicApiKey(row: ApiKeyRow): Record<string, unknown> {
  return {
    id: `key_${row.id}`,
    name: row.name,
    key_prefix: row.keyPrefix,
    scopes: row.scopes,
    last_used_at: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    revoked_at: row.revokedAt ? row.revokedAt.toISOString() : null,
    expires_at: row.expiresAt ? row.expiresAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
  };
}

function publicUsage(s: UsageSummary): Record<string, unknown> {
  return {
    period_start: s.periodStart.toISOString(),
    period_end: s.periodEnd.toISOString(),
    tier: s.tier,
    totals: s.totals,
    quotas: s.quotas,
  };
}

export interface AdminRoutesOptions {
  apiKeysService: ApiKeysService;
  usageService: UsageService;
}

export function registerAdminRoutes(app: FastifyInstance, opts: AdminRoutesOptions): void {
  const { apiKeysService, usageService } = opts;

  // ── POST /v1/api-keys ──────────────────────────────────────────────────
  app.post(
    '/v1/api-keys',
    {
      preHandler: [app.requireAuth, app.rateLimit('global')],
    },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const body = CreateApiKeyRequestSchema.parse(request.body ?? {});
      const created = await apiKeysService.create(ctx, {
        name: body.name,
        scopes: body.scopes,
        expiresAt: body.expires_at ? new Date(body.expires_at) : null,
      });
      return reply.code(201).send({
        ...publicApiKey(created.row),
        plaintext: created.plaintext,
      });
    },
  );

  // ── GET /v1/api-keys ───────────────────────────────────────────────────
  app.get(
    '/v1/api-keys',
    {
      preHandler: [app.requireAuth, app.rateLimit('global')],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const keys = await apiKeysService.list(ctx);
      return { data: keys.map(publicApiKey) };
    },
  );

  // ── DELETE /v1/api-keys/:id ────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/v1/api-keys/:id',
    {
      preHandler: [app.requireAuth, app.rateLimit('global')],
    },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const id = uuidFromPrefixedId(request.params.id, 'key');
      await apiKeysService.revoke(ctx, id);
      return reply.code(204).send();
    },
  );

  // ── POST /v1/api-keys/:id/rotate ───────────────────────────────────────
  // V-296 — customer self-service rotation. Mints a fresh plaintext (shown
  // once); old key continues working for 24h grace period via
  // expires_at-driven auth gate. Optional `name` lets the caller rename
  // the new key (useful when rotating "production-2024" → "production-2025").
  app.post<{ Params: { id: string }; Body: { name?: string } }>(
    '/v1/api-keys/:id/rotate',
    {
      preHandler: [app.requireAuth, app.rateLimit('global')],
    },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const id = uuidFromPrefixedId(request.params.id, 'key');
      const body = request.body ?? {};
      const result = await apiKeysService.rotate(ctx, id, {
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
      });
      return reply.code(201).send({
        ...publicApiKey(result.newRow),
        plaintext: result.plaintext,
        rotated_from: `key_${result.oldKey.id}`,
        grace_period_ends_at: result.gracePeriodEndsAt.toISOString(),
      });
    },
  );

  // ── GET /v1/usage ──────────────────────────────────────────────────────
  app.get(
    '/v1/usage',
    {
      preHandler: [app.requireAuth, app.rateLimit('global')],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const summary = await usageService.currentPeriodSummary(ctx);
      return publicUsage(summary);
    },
  );

  // ── GET /v1/usage/series ──────────────────────────────────────────────
  // V-170 — daily-bucketed usage series for sparkline rendering.
  // Customer-dashboard /usage consumes this. Default 30 days, max 90.
  // Empty buckets today (usage_records writers not wired); the endpoint
  // returns the contract shape with zeros so the dashboard can render
  // empty-state correctly.
  app.get(
    '/v1/usage/series',
    {
      preHandler: [app.requireAuth, app.rateLimit('global')],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const query = UsageSeriesQuerySchema.parse(request.query ?? {});
      const series = await usageService.dailySeries(ctx, query.days ?? 30);
      return {
        from_date: series.fromDate,
        to_date: series.toDate,
        buckets: series.buckets,
      };
    },
  );
}
