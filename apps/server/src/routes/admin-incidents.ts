// V-295a — admin-only incident management endpoints.
//
//   POST   /v1/admin/incidents                  — create new incident
//   GET    /v1/admin/incidents                  — list (scope=all by default)
//   GET    /v1/admin/incidents/:id              — detail (incident + updates)
//   POST   /v1/admin/incidents/:id/updates      — append timeline update
//   POST   /v1/admin/incidents/:id/resolve      — mark resolved with final update
//
// Plus two public surfaces (V-295a + V-545.A) at /v1/status/incidents
// for the status site to consume:
//
//   GET    /v1/status/incidents                 — list (public-only, 30d window)
//   GET    /v1/status/incidents/:id             — detail (incident + updates)
//
// Each mutation writes an admin_audit_log row in the same request
// (V-281 dual-write pattern). Audit row's targetResourceId stores
// `inc_<uuid>` for cross-account audit-log filtering.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AddIncidentUpdateRequestSchema,
  CreateIncidentRequestSchema,
  ListIncidentsQuerySchema,
  ResolveIncidentRequestSchema,
} from '@driftstack/api-types';
import type { Incident, IncidentUpdate } from '@driftstack/api-types';
import type { AdminAuditAction, AdminAuditService } from '../services/admin-audit.js';
import type { IncidentRow, IncidentUpdateRow, IncidentsService } from '../services/incidents.js';
import { BadRequestError, ValidationError } from '../lib/errors.js';
import { readClientIp } from '../lib/client-ip.js';
import { AUTH_IP_LIMITS, ipRateLimit } from '../middleware/ip-rate-limit.js';
import type { RateLimitStore } from '../services/rate-limit.js';

const PUBLIC_ID_RE = /^[a-z]{3}_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function uuidFromPrefixedId(value: string, expectedPrefix: string): string {
  const match = PUBLIC_ID_RE.exec(value);
  if (!match || !match[1] || !value.startsWith(`${expectedPrefix}_`)) {
    throw new BadRequestError(`Invalid id format. Expected "${expectedPrefix}_<uuid>".`);
  }
  return match[1];
}

function publicIncident(row: IncidentRow): Incident {
  return {
    id: `inc_${row.id}`,
    title: row.title,
    description: row.description,
    severity: row.severity,
    status: row.status,
    affected_components: [...row.affectedComponents],
    public: row.public,
    started_at: row.startedAt.toISOString(),
    resolved_at: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function publicIncidentUpdate(row: IncidentUpdateRow): IncidentUpdate {
  return {
    id: `incu_${row.id}`,
    incident_id: `inc_${row.incidentId}`,
    message: row.message,
    status: row.status,
    posted_at: row.postedAt.toISOString(),
  };
}

export interface AdminIncidentsRoutesOptions {
  incidentsService: IncidentsService;
  audit: AdminAuditService;
  /**
   * 2026-05-20 — token-bucket store powering the IP-keyed
   * defense-in-depth gates on the PUBLIC status-incident reads.
   * Same shared store as the auth-flow IP gates (V-251 pattern).
   */
  rateLimitStore: RateLimitStore;
}

export function registerAdminIncidentsRoutes(
  app: FastifyInstance,
  opts: AdminIncidentsRoutesOptions,
): void {
  const { incidentsService, audit, rateLimitStore } = opts;

  // 2026-05-20 — defense-in-depth IP gates on the two PUBLIC
  // status-incident reads. The CDN absorbs the primary load via
  // Cache-Control: public, max-age=30 (~2/min legit per IP);
  // these gates catch direct-API abuse that bypasses the CDN.
  const statusIncidentsListGate = ipRateLimit(rateLimitStore, {
    bucketPrefix: 'status_incidents_list',
    capacity: AUTH_IP_LIMITS.statusIncidentsList.capacity,
    refillPerSecond: AUTH_IP_LIMITS.statusIncidentsList.refillPerSecond,
  });
  const statusIncidentDetailGate = ipRateLimit(rateLimitStore, {
    bucketPrefix: 'status_incident_detail',
    capacity: AUTH_IP_LIMITS.statusIncidentDetail.capacity,
    refillPerSecond: AUTH_IP_LIMITS.statusIncidentDetail.refillPerSecond,
  });

  async function withAudit(
    request: FastifyRequest,
    action: AdminAuditAction,
    targetResourceId: string,
    inputPayload: Record<string, unknown>,
    perform: () => Promise<void>,
  ): Promise<void> {
    const ctx = request.account;
    if (!ctx) throw new Error('account context missing after requireAuth');
    try {
      await perform();
      await audit.record({
        adminAccountId: ctx.account.id,
        adminKeyId: ctx.apiKey.id,
        action,
        targetAccountId: null,
        targetResourceId,
        inputPayload,
        result: 'success',
        ipAddress: readClientIp(request),
      });
    } catch (err) {
      const code =
        err instanceof Error && err.name ? err.name.toLowerCase().replace(/error$/, '') : 'unknown';
      await audit.record({
        adminAccountId: ctx.account.id,
        adminKeyId: ctx.apiKey.id,
        action,
        targetAccountId: null,
        targetResourceId,
        inputPayload,
        result: `error: ${code}`,
        ipAddress: readClientIp(request),
      });
      throw err;
    }
  }

  app.post(
    '/v1/admin/incidents',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const parsed = CreateIncidentRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());

      let result: { incident: IncidentRow; update: IncidentUpdateRow } | null = null;
      const tempId = 'pending';
      await withAudit(request, 'incident.created', `inc_${tempId}`, parsed.data, async () => {
        result = await incidentsService.create({
          title: parsed.data.title,
          description: parsed.data.description,
          severity: parsed.data.severity,
          status: parsed.data.status,
          affectedComponents: parsed.data.affected_components ?? [],
          public: parsed.data.public ?? true,
          startedAt: parsed.data.started_at ? new Date(parsed.data.started_at) : new Date(),
          createdByAdminId: ctx.account.id,
          createdByAdminKeyId: ctx.apiKey.id,
        });
      });
      if (!result) throw new Error('incident creation produced no result');
      const created = result as { incident: IncidentRow; update: IncidentUpdateRow };
      return reply.code(201).send({
        incident: publicIncident(created.incident),
        updates: [publicIncidentUpdate(created.update)],
      });
    },
  );

  app.get(
    '/v1/admin/incidents',
    { preHandler: [app.requireScope('driftstack_internal_admin')] },
    async (request) => {
      const parsed = ListIncidentsQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      const rows = await incidentsService.list({
        scope: parsed.data.scope ?? 'all',
        since: parsed.data.since ? new Date(parsed.data.since) : undefined,
        limit: parsed.data.limit,
      });
      return { data: rows.map(publicIncident) };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/admin/incidents/:id',
    { preHandler: [app.requireScope('driftstack_internal_admin')] },
    async (request) => {
      const id = uuidFromPrefixedId(request.params.id, 'inc');
      const result = await incidentsService.get(id);
      return {
        incident: publicIncident(result.incident),
        updates: result.updates.map(publicIncidentUpdate),
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/admin/incidents/:id/updates',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const id = uuidFromPrefixedId(request.params.id, 'inc');
      const parsed = AddIncidentUpdateRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());

      let result: IncidentUpdateRow | null = null;
      await withAudit(request, 'incident.updated', `inc_${id}`, parsed.data, async () => {
        result = await incidentsService.addUpdate({
          incidentId: id,
          message: parsed.data.message,
          status: parsed.data.status,
          postedByAdminId: ctx.account.id,
          postedByAdminKeyId: ctx.apiKey.id,
        });
      });
      if (!result) throw new Error('incident update produced no result');
      return reply.code(201).send(publicIncidentUpdate(result));
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/admin/incidents/:id/resolve',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const id = uuidFromPrefixedId(request.params.id, 'inc');
      const parsed = ResolveIncidentRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());

      let result: { incident: IncidentRow; update: IncidentUpdateRow } | null = null;
      await withAudit(request, 'incident.resolved', `inc_${id}`, parsed.data, async () => {
        result = await incidentsService.resolve({
          incidentId: id,
          message: parsed.data.message,
          postedByAdminId: ctx.account.id,
          postedByAdminKeyId: ctx.apiKey.id,
        });
      });
      if (!result) throw new Error('incident resolution produced no result');
      const resolved = result as { incident: IncidentRow; update: IncidentUpdateRow };
      return reply.code(200).send({
        incident: publicIncident(resolved.incident),
        update: publicIncidentUpdate(resolved.update),
      });
    },
  );

  // ── PUBLIC GET /v1/status/incidents ────────────────────────────────────
  // The status page consumes this; no auth required, only public=true rows
  // surfaced. Limited to the last 30 days by default.
  app.get(
    '/v1/status/incidents',
    { preHandler: statusIncidentsListGate },
    async (request, reply) => {
      const parsed = ListIncidentsQuerySchema.safeParse({
        ...(request.query ?? {}),
        scope: 'public',
      });
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      const since =
        parsed.data.since !== undefined
          ? new Date(parsed.data.since)
          : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const rows = await incidentsService.list({
        scope: 'public',
        since,
        limit: parsed.data.limit ?? 50,
      });
      // Cache-Control: public, max-age=30 — matches /v1/status + the
      // detail route. Status site polls every 30s for live updates;
      // CDN coalesces concurrent viewers onto one origin call.
      reply.header('cache-control', 'public, max-age=30');
      return { data: rows.map(publicIncident) };
    },
  );

  // ── PUBLIC GET /v1/status/incidents/:id ────────────────────────────────
  // V-545.A — status-page incident-detail view. Returns the incident plus
  // the full update timeline so visitors can see what changed (investigation
  // posted → expanded scope → fixed). 404 when the incident is not public
  // or doesn't exist; the route deliberately returns the same shape for
  // both so admins probing the surface can't enumerate private incidents.
  //
  // Cache-Control: public, max-age=30 — matches /v1/status. The status
  // site polls every 30s for live updates; CDN coalesces concurrent
  // viewers onto one origin call.
  app.get<{ Params: { id: string } }>(
    '/v1/status/incidents/:id',
    { preHandler: statusIncidentDetailGate },
    async (request, reply) => {
      const id = uuidFromPrefixedId(request.params.id, 'inc');
      const result = await incidentsService.get(id, { publicOnly: true });
      reply.header('cache-control', 'public, max-age=30');
      return {
        incident: publicIncident(result.incident),
        updates: result.updates.map(publicIncidentUpdate),
      };
    },
  );
}
