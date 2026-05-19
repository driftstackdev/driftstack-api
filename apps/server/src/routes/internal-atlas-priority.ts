// Wave 29-400 §8.2 — internal /v1/internal/atlas-priority/* endpoints.
//
// Auto-learn observability surface for the Mac fork's harvester +
// BS Automate workers + atlas-priority-append.py callbacks. NOT
// customer-facing — gated behind DRIFTSTACK_FLEET_INTERNAL_TOKEN
// bearer auth (see lib/internal-fleet-auth.ts). Backed by
// DrizzleAtlasPriorityEventsRepo (§8.1.b) against the atlas_priority
// _events table (§8.1).
//
// 4 routes:
//   POST /v1/internal/atlas-priority/probe-signature
//     — harvester reports a new probe signature; soft-dedup within
//       5 min on (opSeqSha, archetypeId).
//   POST /v1/internal/atlas-priority/event-status
//     — BS worker + atlas-append callback advance the lifecycle.
//   GET  /v1/internal/atlas-priority/queue
//     — admin panel + ops poll; filters status/customer_id/since/limit.
//   GET  /v1/internal/atlas-priority/event/:id
//     — single-event lookup + lifecycle timeline (computed at route).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DrizzleAtlasPriorityEventsRepo } from '../db/atlas-priority-events-repo.js';
import {
  EventNotFoundError,
  InvalidStateTransitionError,
  type InsertEmittedArgs,
} from '../db/atlas-priority-events-repo.js';
import type { InternalFleetAuth } from '../lib/internal-fleet-auth.js';
import { BadRequestError, FeatureUnavailableError, NotFoundError } from '../lib/errors.js';

export interface InternalAtlasPriorityRoutesDeps {
  repo: DrizzleAtlasPriorityEventsRepo;
  auth: InternalFleetAuth;
}

const STATUS_VALUES = [
  'emitted',
  'queued',
  'bs_in_flight',
  'bs_succeeded',
  'bs_failed',
  'atlas_appended',
  'atlas_failed',
] as const;
const statusEnum = z.enum(STATUS_VALUES);

const probeSignatureBodySchema = z.object({
  op_seq_sha: z.string().min(1),
  op_seq_bytes_b64: z.string().min(1),
  canvas_w: z.number().int().positive(),
  canvas_h: z.number().int().positive(),
  mime: z.string().min(1),
  archetype_id: z.string().min(1),
  last_fill_text: z.string().nullable().optional(),
  mac_len: z.number().int().nullable().optional(),
  session_id: z.string().min(1),
  customer_id: z.string().min(1),
  page_url: z.string().min(1),
});

const eventStatusBodySchema = z.object({
  event_id: z.string().uuid(),
  new_status: statusEnum,
  bs_session_id: z.string().min(1).optional(),
  error_reason: z.string().min(1).optional(),
  atlas_entry_hash: z.string().min(1).optional(),
  atlas_version: z.string().min(1).optional(),
});

const queueQuerySchema = z.object({
  status: statusEnum.optional(),
  customer_id: z.string().min(1).optional(),
  since: z
    .string()
    .datetime()
    .optional()
    .transform((s) => (s === undefined ? undefined : new Date(s))),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const eventDetailParamsSchema = z.object({
  id: z.string().uuid(),
});

export function registerInternalAtlasPriorityRoutes(
  app: FastifyInstance,
  deps: InternalAtlasPriorityRoutesDeps,
): void {
  // preHandler that enforces the bearer-token auth on every internal
  // route. Centralised here so adding routes later doesn't risk skipping
  // the check. Stays async because Fastify hangs the request when a
  // sync (req) => void preHandler returns without calling the `done`
  // callback — async signature triggers the Promise-resolution branch
  // of Fastify's hook lifecycle which doesn't need done().
  // eslint-disable-next-line @typescript-eslint/require-await
  const requireInternalAuth = async (req: FastifyRequest): Promise<void> => {
    deps.auth.validate(req);
  };

  app.post(
    '/v1/internal/atlas-priority/probe-signature',
    { preHandler: [requireInternalAuth] },
    async (req) => {
      const body = probeSignatureBodySchema.parse(req.body);
      const now = new Date();
      const args: InsertEmittedArgs = {
        opSeqSha: body.op_seq_sha,
        opSeqBytesB64: body.op_seq_bytes_b64,
        canvasW: body.canvas_w,
        canvasH: body.canvas_h,
        mime: body.mime,
        archetypeId: body.archetype_id,
        lastFillText: body.last_fill_text ?? null,
        macLen: body.mac_len ?? null,
        sessionId: body.session_id,
        customerId: body.customer_id,
        pageUrl: body.page_url,
        now,
      };
      const result = await deps.repo.insertEmittedWithDedup(args);
      return {
        event_id: result.eventId,
        status: result.status,
        deduped: result.deduped,
      };
    },
  );

  app.post(
    '/v1/internal/atlas-priority/event-status',
    { preHandler: [requireInternalAuth] },
    async (req) => {
      const body = eventStatusBodySchema.parse(req.body);
      try {
        const updated = await deps.repo.updateStatus({
          eventId: body.event_id,
          newStatus: body.new_status,
          bsAutomateSessionId: body.bs_session_id,
          bsErrorReason: body.error_reason,
          atlasEntryHash: body.atlas_entry_hash,
          atlasVersion: body.atlas_version,
          atlasErrorReason: body.error_reason,
          now: new Date(),
        });
        return {
          event_id: updated.id,
          status: updated.status,
        };
      } catch (err) {
        if (err instanceof InvalidStateTransitionError) {
          // Forward-only state machine — invalid edge is a bad request.
          throw new BadRequestError(err.message);
        }
        if (err instanceof EventNotFoundError) {
          throw new NotFoundError(err.message);
        }
        throw err;
      }
    },
  );

  app.get(
    '/v1/internal/atlas-priority/queue',
    { preHandler: [requireInternalAuth] },
    async (req) => {
      const q = queueQuerySchema.parse(req.query);
      const events = await deps.repo.listRecent({
        status: q.status,
        customerId: q.customer_id,
        since: q.since,
        limit: q.limit,
      });
      const stats = await deps.repo.getStats(new Date());
      return {
        events: events.map(serializeEvent),
        total_count: events.length,
        stats,
      };
    },
  );

  app.get(
    '/v1/internal/atlas-priority/event/:id',
    { preHandler: [requireInternalAuth] },
    async (req) => {
      const { id } = eventDetailParamsSchema.parse(req.params);
      const row = await deps.repo.findById(id);
      if (!row) {
        throw new NotFoundError(`atlas-priority-event ${id} not found`);
      }
      return {
        event: serializeEvent(row),
        timeline: lifecycleTimeline(row),
      };
    },
  );
}

/** Activation-gate disabled variant — registers the routes but every
 *  call returns 503 FeatureUnavailable. Mirrors the fleet-events
 *  disabled-routes pattern. */
export function registerInternalAtlasPriorityDisabledRoutes(app: FastifyInstance): void {
  const detail =
    'Atlas-priority observability endpoints are not yet enabled on this ' +
    'deployment. DRIFTSTACK_FLEET_INTERNAL_TOKEN env var unset.';
  const reject = (): never => {
    throw new FeatureUnavailableError(detail);
  };
  app.post('/v1/internal/atlas-priority/probe-signature', reject);
  app.post('/v1/internal/atlas-priority/event-status', reject);
  app.get('/v1/internal/atlas-priority/queue', reject);
  app.get('/v1/internal/atlas-priority/event/:id', reject);
}

function serializeEvent(row: {
  id: string;
  opSeqSha: string;
  archetypeId: string;
  sessionId: string;
  customerId: string;
  pageUrl: string;
  status: string;
  emittedAt: Date;
  bsAutomateSessionId: string | null;
  bsStartedAt: Date | null;
  bsCompletedAt: Date | null;
  bsErrorReason: string | null;
  atlasEntryHash: string | null;
  atlasVersion: string | null;
  atlasAppendedAt: Date | null;
  atlasErrorReason: string | null;
  updatedAt: Date;
}): Record<string, unknown> {
  return {
    id: row.id,
    op_seq_sha: row.opSeqSha,
    archetype_id: row.archetypeId,
    session_id: row.sessionId,
    customer_id: row.customerId,
    page_url: row.pageUrl,
    status: row.status,
    emitted_at: row.emittedAt.toISOString(),
    bs_automate_session_id: row.bsAutomateSessionId,
    bs_started_at: row.bsStartedAt?.toISOString() ?? null,
    bs_completed_at: row.bsCompletedAt?.toISOString() ?? null,
    bs_error_reason: row.bsErrorReason,
    atlas_entry_hash: row.atlasEntryHash,
    atlas_version: row.atlasVersion,
    atlas_appended_at: row.atlasAppendedAt?.toISOString() ?? null,
    atlas_error_reason: row.atlasErrorReason,
    updated_at: row.updatedAt.toISOString(),
    duration_emit_to_append_ms:
      row.atlasAppendedAt !== null ? row.atlasAppendedAt.getTime() - row.emittedAt.getTime() : null,
  };
}

function lifecycleTimeline(row: {
  emittedAt: Date;
  bsStartedAt: Date | null;
  bsCompletedAt: Date | null;
  atlasAppendedAt: Date | null;
  status: string;
}): Array<{ event: string; at: string }> {
  const timeline: Array<{ event: string; at: string }> = [
    { event: 'emitted', at: row.emittedAt.toISOString() },
  ];
  if (row.bsStartedAt) {
    timeline.push({ event: 'bs_in_flight', at: row.bsStartedAt.toISOString() });
  }
  if (row.bsCompletedAt) {
    timeline.push({
      event:
        row.status.startsWith('atlas_') || row.status === 'bs_succeeded'
          ? 'bs_succeeded'
          : 'bs_failed',
      at: row.bsCompletedAt.toISOString(),
    });
  }
  if (row.atlasAppendedAt) {
    timeline.push({
      event: row.status === 'atlas_appended' ? 'atlas_appended' : 'atlas_failed',
      at: row.atlasAppendedAt.toISOString(),
    });
  }
  return timeline;
}
