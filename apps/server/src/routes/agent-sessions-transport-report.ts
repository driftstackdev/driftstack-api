// ICE.T — POST /v1/agent-sessions/:id/transport-report
//
// Lightweight, fire-and-forget ICE/media-transport telemetry from the
// gui-client's live LiveKit connection back to the control plane. The
// gui-client already computes these diagnostics locally
// (lib/livekit-connection-stats.ts::parseConnectionStats — udp/tcp,
// relayed, RTT, loss, jitter, decode fps, freezes). This route lets it
// POST them so we can PROVE the transport type across the fleet + all
// agent-sessions and MEASURE a TURN-relay before/after WITHOUT touching
// the stream.
//
// Deliberately minimal:
//   - No DB table, no migration. The report is STRUCTURED-LOGGED (one
//     `ice-transport-telemetry` line per report) and picked up from the
//     log pipeline — the founder's before/after is a log query, not a
//     schema. It is low-stakes, high-cardinality telemetry; persisting it
//     would cost a table + retention for data we only aggregate ad-hoc.
//   - Returns 204 (accepted, nothing to return).
//   - Best-effort by contract: the client swallows every error, so a
//     failure here NEVER affects the stream.
//
// Auth mirrors the sibling livekit-token route's dual path
// (controlKeyOrAccountAuth): a per-session gui_control_key (the Simulator
// app holds only this) OR an account Bearer. This is a read-stakes report
// (it reveals nothing and mutates nothing), so the account path only needs
// requireScope('read:sessions') — NOT the write scope the token mint
// needs; the control-key path bypasses scope entirely (it is already a
// per-session credential validated against THIS session).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AgentSessionsRepo } from '../services/agent-sessions.js';
import { callerCanAccessAgentSession } from './agent-sessions.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { GUI_CONTROL_KEY_HEADER, validateGuiControlKey } from '../lib/agent-session-control-key.js';
import { knownRequestKeys, reportUnknownRequestFields } from '../lib/unknown-request-fields.js';
import { consumeEffectiveOwnerRateLimit } from '../middleware/rate-limit.js';

const AGENT_SESSION_ID_RE = /^agt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Body schema for a single transport report. Every numeric field is bounded
 * (a hostile/buggy client can't log a nonsensical value) and
 * `.strict()`-stripped of unknown keys. `transport`/`relayed`/`rtt_ms`/
 * `packet_loss_recent_pct` are REQUIRED-but-nullable (the client sends null
 * when it hasn't resolved them yet); the softer per-frame figures
 * (jitter/fps/freezes) are optional so an older client that omits them still
 * validates. Mirrors the ConnectionStats shape the gui-client parses.
 */
export const transportReportBodySchema = z
  .object({
    transport: z.enum(['udp', 'tcp']).nullable(),
    relayed: z.boolean().nullable(),
    rtt_ms: z.number().int().nonnegative().max(60000).nullable(),
    packet_loss_recent_pct: z.number().min(0).max(100).nullable(),
    jitter_ms: z.number().nonnegative().max(60000).nullable().optional(),
    decode_fps: z.number().nonnegative().max(1000).nullable().optional(),
    freeze_count: z.number().nonnegative().nullable().optional(),
  })
  .strict();

export type TransportReportBody = z.infer<typeof transportReportBodySchema>;

export interface RegisterAgentSessionsTransportReportRouteDeps {
  agentSessionsRepo: AgentSessionsRepo;
  /**
   * MFA_ENCRYPTION_KEY (base64) used to decrypt the per-session
   * gui_control_key. When wired, the Simulator app — which holds ONLY the
   * per-session control key, not the account API key — can post reports via
   * that key (mirrors `controlKeyOrAccountAuth` on the livekit-token route).
   * Absent → control-key auth is disabled and only the account path is
   * accepted.
   */
  guiControlKeyEncryptionKey?: string;
  /** Now-provider (test-injectable). Defaults to `() => Date.now()`. */
  nowMs?: () => number;
}

export function registerAgentSessionsTransportReportRoute(
  app: FastifyInstance,
  deps: RegisterAgentSessionsTransportReportRouteDeps,
): void {
  const { agentSessionsRepo } = deps;
  const guiControlKeyEncryptionKey = deps.guiControlKeyEncryptionKey;
  const nowMs = deps.nowMs ?? (() => Date.now());

  // Auth path (b): a valid per-session gui_control_key authorizes a report for
  // THIS `:id` session. The Simulator app holds only this key (never the
  // account API key). When the control key validates, requireAuth/requireScope
  // are SKIPPED (the key is already a per-session credential bound to this one
  // session) and the owning account is stashed for rate-limiting. Mirrors
  // controlKeyOrAccountAuth in routes/agent-sessions-livekit-token.ts, except
  // the account path floors at read:sessions (this is a read-stakes report,
  // not the write-equivalent token mint).
  const controlKeyOrAccountAuth = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const headerRaw = req.headers[GUI_CONTROL_KEY_HEADER];
    const header = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
    if (header !== undefined && header.length > 0) {
      // A control key was presented; validateGuiControlKey throws a hard 401 on
      // any failure (never falls through to the account path).
      const sessionId = (req.params as { id?: string }).id ?? '';
      const session = await agentSessionsRepo.get(sessionId);
      const result = validateGuiControlKey({
        headerRaw,
        session,
        encryptionKey: guiControlKeyEncryptionKey,
        nowMs,
      });
      if (result.authorized) {
        req.guiControlKeyAuthorized = true;
        // rateLimit() keys off request.account (absent here); charge the owner.
        req.guiControlKeyRateLimitAccountId = result.ownerAccountId;
        return;
      }
    }
    // No control key → normal account auth chain. read:sessions is the floor:
    // the report reveals nothing and mutates nothing, so it does NOT need the
    // write scope the token mint requires.
    await app.requireAuth(req, reply);
    await app.requireScope('read:sessions')(req, reply);
  };

  app.post<{ Params: { id: string } }>(
    '/v1/agent-sessions/:id/transport-report',
    {
      preHandler: [controlKeyOrAccountAuth, app.rateLimit('global')],
    },
    async (req, reply) => {
      const sessionId = req.params.id;
      const controlKeyAuthorized = req.guiControlKeyAuthorized === true;
      const ctx = req.account;
      if (!controlKeyAuthorized && !ctx) {
        throw new Error('account context missing after requireAuth');
      }

      // Cheap shape-check — junk ids fail before the db hit (anti-enumeration,
      // same posture as the livekit-token route).
      if (!AGENT_SESSION_ID_RE.test(sessionId)) {
        throw new NotFoundError(`Agent session "${sessionId}" not found.`);
      }

      // Validate + strip the body BEFORE the (already-cheap) session lookup so a
      // malformed report is a 400 regardless of session existence.
      const parsed = transportReportBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      // V-947 — report the keys zod stripped. Gate verified by reading this
      // route's own registration, not inferred: a pattern-based split misread
      // two of these in V-946.
      reportUnknownRequestFields({
        body: req.body ?? {},
        knownKeys: knownRequestKeys(transportReportBodySchema),
        reply,
        logger: req.log,
        route: 'POST /v1/agent-sessions/:id/transport-report',
      });

      const session = await agentSessionsRepo.get(sessionId);
      if (session === null) {
        throw new NotFoundError(`Agent session "${sessionId}" not found.`);
      }
      // Account path: 404 for a caller who can't reach this session
      // (anti-enumeration; same posture as the livekit-token route). Access =
      // self OR a TEAM ADMIN of the owning account. Control-key path: the key
      // was already decrypt-matched against THIS session in the preHandler, so
      // it is authorized for this one session and skips the ownership check.
      if (!controlKeyAuthorized && (!ctx || !callerCanAccessAgentSession(ctx, session.accountId))) {
        throw new NotFoundError(`Agent session "${sessionId}" not found.`);
      }
      await consumeEffectiveOwnerRateLimit(app, req, reply, session.accountId, 'global');

      const body = parsed.data;
      // STRUCTURED-LOG the report (no DB). The `ice-transport-telemetry`
      // component tag is the log-query anchor for the founder's before/after +
      // fleet-wide transport-type proof. Nullable/optional fields are logged as
      // whatever the client sent (null / undefined) — the pipeline treats a
      // missing field as "not reported this tick".
      req.log.info(
        {
          component: 'ice-transport-telemetry',
          session_id: sessionId,
          account_id: session.accountId,
          transport: body.transport,
          relayed: body.relayed,
          rtt_ms: body.rtt_ms,
          packet_loss_recent_pct: body.packet_loss_recent_pct,
          jitter_ms: body.jitter_ms ?? null,
          decode_fps: body.decode_fps ?? null,
          freeze_count: body.freeze_count ?? null,
        },
        'agent-session transport report',
      );

      return reply.code(204).send();
    },
  );
}
