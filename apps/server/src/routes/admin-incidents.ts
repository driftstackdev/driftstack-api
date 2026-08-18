// V-295a — admin-only incident management endpoints.
//
//   POST   /v1/admin/incidents                  — create new incident
//   PUT    /v1/admin/incidents/:id              — idempotent create/replay
//   GET    /v1/admin/incidents                  — list (scope=all by default)
//   GET    /v1/admin/incidents/:id              — detail (incident + updates)
//   POST   /v1/admin/incidents/:id/updates      — append timeline update
//   POST   /v1/admin/incidents/:id/resolve      — mark resolved with final update
//
// Plus two public surfaces (V-295a + V-545.A) at /v1/status/incidents
// for the status site to consume:
//
//   GET    /v1/status/incidents                 — all-time open + bounded resolved history
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
import type {
  IncidentListCursor,
  IncidentRow,
  IncidentUpdateRow,
  IncidentsService,
} from '../services/incidents.js';
import { BadRequestError, ValidationError } from '../lib/errors.js';
import { readClientIp } from '../lib/client-ip.js';
import { AUTH_IP_LIMITS, ipRateLimit } from '../middleware/ip-rate-limit.js';
import type { RateLimitStore } from '../services/rate-limit.js';

// `[a-z]+` rather than `[a-z]{3}`: this file MINTS `incu_<uuid>` for incident
// updates, a four-letter prefix the exactly-three form cannot parse. Nothing
// parses an `incu_` id back today, so this was latent rather than broken — but
// the first route to accept one would have 400d on an id the API itself issued.
// Widening the character class cannot loosen WHICH prefix is accepted: that is
// enforced by `value.startsWith(`${expectedPrefix}_`)` in uuidFromPrefixedId
// below. Same reason profile-snapshots.ts carries the flexible form for `psnap`.
const PUBLIC_ID_RE = /^[a-z]+_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function uuidFromPrefixedId(value: string, expectedPrefix: string): string {
  const match = PUBLIC_ID_RE.exec(value);
  if (!match || !match[1] || !value.startsWith(`${expectedPrefix}_`)) {
    throw new BadRequestError(`Invalid id format. Expected "${expectedPrefix}_<uuid>".`);
  }
  return match[1];
}

function encodeIncidentCursor(cursor: IncidentListCursor): string {
  return Buffer.from(
    JSON.stringify({ started_at: cursor.startedAt.toISOString(), id: cursor.id }),
    'utf8',
  ).toString('base64url');
}

function decodeIncidentCursor(value: string): IncidentListCursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded))
      throw new Error();
    const row = decoded as Record<string, unknown>;
    if (
      Object.keys(row).sort().join(',') !== 'id,started_at' ||
      typeof row.started_at !== 'string' ||
      typeof row.id !== 'string' ||
      !UUID_RE.test(row.id)
    ) {
      throw new Error();
    }
    const startedAt = new Date(row.started_at);
    if (!Number.isFinite(startedAt.getTime()) || startedAt.toISOString() !== row.started_at) {
      throw new Error();
    }
    return { startedAt, id: row.id };
  } catch {
    throw new BadRequestError('Invalid incident cursor.');
  }
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
    // string for mutations whose target id is known up front (the :id
    // routes); a thunk for create, whose real `inc_<uuid>` only exists
    // after perform() runs — resolved at record time so the audit row
    // stores the real id (not a placeholder) per the file-header contract.
    targetResourceId: string | (() => string),
    inputPayload: Record<string, unknown>,
    perform: () => Promise<void>,
    shouldRecordSuccess: () => boolean = () => true,
  ): Promise<void> {
    const ctx = request.account;
    if (!ctx) throw new Error('account context missing after requireAuth');
    const resolveTargetResourceId = (): string =>
      typeof targetResourceId === 'function' ? targetResourceId() : targetResourceId;
    try {
      await perform();
      if (shouldRecordSuccess()) {
        await audit.record({
          adminAccountId: ctx.account.id,
          adminKeyId: ctx.apiKey.id,
          action,
          targetAccountId: null,
          targetResourceId: resolveTargetResourceId(),
          inputPayload,
          result: 'success',
          ipAddress: readClientIp(request),
        });
      }
    } catch (err) {
      const code =
        err instanceof Error && err.name ? err.name.toLowerCase().replace(/error$/, '') : 'unknown';
      await audit.record({
        adminAccountId: ctx.account.id,
        adminKeyId: ctx.apiKey.id,
        action,
        targetAccountId: null,
        targetResourceId: resolveTargetResourceId(),
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
      // The real `inc_<uuid>` only exists after create() runs, so the audit
      // targetResourceId is resolved lazily: the real id on success, and
      // `inc_pending` only if create() throws before an incident exists.
      await withAudit(
        request,
        'incident.created',
        () => (result ? `inc_${result.incident.id}` : 'inc_pending'),
        parsed.data,
        async () => {
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
        },
      );
      if (!result) throw new Error('incident creation produced no result');
      const created = result as { incident: IncidentRow; update: IncidentUpdateRow };
      return reply.code(201).send({
        incident: publicIncident(created.incident),
        updates: [publicIncidentUpdate(created.update)],
      });
    },
  );

  // Idempotent operator create. The client owns one preallocated incident id
  // for the lifetime of the form attempt; retries reuse it across timeouts,
  // processes and deploys instead of title-matching a bounded list.
  app.put<{ Params: { id: string } }>(
    '/v1/admin/incidents/:id',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const id = uuidFromPrefixedId(request.params.id, 'inc');
      const parsed = CreateIncidentRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      if (parsed.data.started_at === undefined) {
        throw new BadRequestError('started_at is required for idempotent incident creation.');
      }
      let result: Awaited<ReturnType<IncidentsService['createWithId']>> | null = null;
      await withAudit(
        request,
        'incident.created',
        `inc_${id}`,
        parsed.data,
        async () => {
          result = await incidentsService.createWithId(id, {
            title: parsed.data.title,
            description: parsed.data.description,
            severity: parsed.data.severity,
            status: parsed.data.status,
            affectedComponents: parsed.data.affected_components ?? [],
            public: parsed.data.public ?? true,
            startedAt: new Date(parsed.data.started_at!),
            createdByAdminId: ctx.account.id,
            createdByAdminKeyId: ctx.apiKey.id,
          });
        },
        () => result?.outcome === 'created',
      );
      if (!result) throw new Error('idempotent incident creation produced no result');
      const written = result as Awaited<ReturnType<IncidentsService['createWithId']>>;
      return reply.code(written.outcome === 'created' ? 201 : 200).send({
        outcome: written.outcome,
        incident: publicIncident(written.incident),
        updates: [publicIncidentUpdate(written.update)],
      });
    },
  );

  app.get(
    '/v1/admin/incidents',
    { preHandler: [app.requireScope('driftstack_internal_admin')] },
    async (request) => {
      const parsed = ListIncidentsQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      if (parsed.data.window !== undefined) {
        throw new BadRequestError('window is only supported by the public incident feed.');
      }
      const scope = parsed.data.scope ?? 'all';
      const state = parsed.data.state ?? 'all';
      const page = await incidentsService.listPage({
        scope,
        since: parsed.data.since ? new Date(parsed.data.since) : undefined,
        state,
        cursor: parsed.data.cursor ? decodeIncidentCursor(parsed.data.cursor) : undefined,
        limit: parsed.data.limit,
      });
      return {
        data: page.rows.map(publicIncident),
        total: page.total,
        open_count: page.openCount,
        has_more: page.nextCursor !== null,
        next_cursor: page.nextCursor ? encodeIncidentCursor(page.nextCursor) : null,
      };
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

  // 2026-05-22 — admin reopen. Same body shape as resolve (just a
  // `message` field explaining why); rejects via 409 if the incident
  // isn't already resolved. Audit-action 'incident.reopened' added
  // in migration 0063.
  app.post<{ Params: { id: string } }>(
    '/v1/admin/incidents/:id/reopen',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const id = uuidFromPrefixedId(request.params.id, 'inc');
      const parsed = ResolveIncidentRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());

      // Reject reopen when incident isn't resolved — avoids accidental
      // status churn (e.g. operator clicking the wrong button on an
      // active incident).
      const current = await incidentsService.get(id);
      if (current.incident.status !== 'resolved') {
        throw new ValidationError({
          formErrors: [
            `Incident is in status '${current.incident.status}'; only resolved incidents can be reopened.`,
          ],
          fieldErrors: {},
        });
      }

      let result: { incident: IncidentRow; update: IncidentUpdateRow } | null = null;
      await withAudit(request, 'incident.reopened', `inc_${id}`, parsed.data, async () => {
        result = await incidentsService.reopen({
          incidentId: id,
          message: parsed.data.message,
          postedByAdminId: ctx.account.id,
          postedByAdminKeyId: ctx.apiKey.id,
        });
      });
      if (!result) throw new Error('incident reopen produced no result');
      const reopened = result as { incident: IncidentRow; update: IncidentUpdateRow };
      return reply.code(200).send({
        incident: publicIncident(reopened.incident),
        update: publicIncidentUpdate(reopened.update),
      });
    },
  );

  // ── PUBLIC GET /v1/status/incidents ────────────────────────────────────
  // The status page consumes this; no auth required, only public=true rows
  // surfaced. Open incidents are all-time; resolved history defaults to 30d.
  app.get(
    '/v1/status/incidents',
    { preHandler: statusIncidentsListGate },
    async (request, reply) => {
      const parsed = ListIncidentsQuerySchema.safeParse({
        ...(request.query ?? {}),
        scope: 'public',
      });
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      if (parsed.data.cursor !== undefined || parsed.data.state !== undefined) {
        throw new BadRequestError('state and cursor are not supported by the public status feed.');
      }
      const since =
        parsed.data.since !== undefined
          ? new Date(parsed.data.since)
          : new Date(Date.now() - (parsed.data.window === '90d' ? 90 : 30) * 24 * 60 * 60 * 1000);
      const feed = await incidentsService.publicFeed({
        since,
        limit: parsed.data.limit ?? 50,
      });
      // Cache-Control: public, max-age=30 — matches /v1/status + the
      // detail route. Status site polls every 30s for live updates;
      // CDN coalesces concurrent viewers onto one origin call.
      reply.header('cache-control', 'public, max-age=30');
      return {
        data: feed.rows.map(publicIncident),
        total: feed.total,
        open_count: feed.openCount,
        open_outage_count: feed.openOutageCount,
        truncated: feed.truncated,
      };
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
