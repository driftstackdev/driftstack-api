// AI-D — /v1/agent-sessions/* routes. Exposes the AgentRuntime
// (AI-COMPOSE composition slice, commit 09487cc6) over HTTP so the
// dashboard chat UI + SDK consumers can drive multi-turn agent
// sessions:
//
//   POST   /v1/agent-sessions            — create a new agent session
//   GET    /v1/agent-sessions/{id}       — read agent session state
//   POST   /v1/agent-sessions/{id}/message — run one decompose→execute turn
//   DELETE /v1/agent-sessions/{id}       — close the agent session
//
// Activation gate matches the rest of Wave 1119 — when `agentRuntime`
// is undefined in AppDeps, `registerAgentSessionsDisabledRoutes`
// surfaces 503 FeatureUnavailable on every endpoint so SDK + dashboard
// see a machine-readable "not yet enabled" signal instead of bare 404.
//
// Default-tier token budgets are intentionally hardcoded here for the
// v0 launch — tier-derived caps land in B3 (separate slice). Founder
// reviews this constant before flipping the gate on.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AgentModelSchema,
  SendInputEventRequestSchema,
  type AgentModel,
} from '@driftstack/api-types';
import type { AgentRuntime } from '../services/agent-runtime.js';
import type { DecomposeUsage } from '../services/agent-decomposer.js';
import type { AgentSessionRecord, AgentSessionsRepo } from '../services/agent-sessions.js';
import type { ProfilesService } from '../services/profiles.js';
import type { BYOKAnthropicService } from '../services/byok-anthropic.js';
import type { InMemoryByokKeyCache } from '../services/byok-anthropic-key-cache.js';
import type { BundledLlmService } from '../services/bundled-llm.js';
import type { AgentSessionEventBus } from '../services/agent-session-event-bus.js';
import {
  applyPairModeTransition,
  initialPairModeState,
  PairModeStateInvalidTransitionError,
  type PairModeState,
} from '../services/agent-pair-mode-state.js';
import type { PairModeTakeoverLock } from '../services/agent-pair-mode-lock.js';
import type { SentryClient } from '../lib/sentry.js';
import type { AccountAuditService } from '../services/account-audit.js';
import type { MetricsRegistry } from '../services/metrics-registry.js';
import { METRIC_NAMES } from '../services/metrics-registry.js';
import type { PairModeHeartbeatTracker } from '../services/agent-pair-mode-heartbeat.js';
import type { DrizzleFleetNodesRepo } from '../db/fleet-nodes-repo.js';
import { mintLivekitToken } from '../lib/livekit-token.js';
import { decryptLivekitSecret } from '../lib/livekit-secret-encryption.js';
import { serializeSessionAssign, serializeSessionEnd } from '../services/harness-control-codec.js';
import type { FleetControlRegistry } from '../services/fleet-control-registry.js';
import type { SocksProxyConfig } from '@driftstack/api-types';
import {
  decryptGuiControlKey,
  encryptGuiControlKey,
  generateGuiControlKey,
} from '../lib/gui-control-key-encryption.js';
import {
  BundledLlmBudgetExhaustedError,
  BundledLlmConsentRequiredError,
  ByokAnthropicRequiredError,
  ConflictError,
  FeatureUnavailableError,
  NotFoundError,
  PairModeConflictError,
  PairModeStateInvalidTransitionRouteError,
  ValidationError,
} from '../lib/errors.js';
import { readIdempotencyKey } from '../lib/idempotency-key.js';
import { isUniqueViolation } from '../lib/pg-error.js';
import { readClientIp } from '../lib/client-ip.js';

const DEFAULT_TOKEN_BUDGET = 100_000;

const CreateAgentSessionRequestSchema = z.object({
  // Canonical `ses_<36-char-uuid>` = 40 chars. Cap at 100 (slice 116
  // pattern) — generous headroom, blocks multi-KB strings that would
  // bloat the 404/400 problem+json body if validation lets them in.
  driftstack_session_id: z.string().min(1).max(100).optional(),
  // Default is 100_000 (DEFAULT_TOKEN_BUDGET). Cap at 10M (100× the
  // default) so a customer can request a generous budget for long
  // sessions but can't trigger pathological accounting math with an
  // implausibly large value like 10^15.
  token_budget: z.number().int().positive().max(10_000_000).optional(),
  // Arc 2 sub-slice 8.5 (v2-#8) — operational mode at create-time.
  mode: z.enum(['manual', 'ai', 'pair']).optional(),
  // 6.c / #15 — Claude 4.x model the AI agent runs (defaults to
  // DEFAULT_AGENT_MODEL server-side when omitted).
  model: AgentModelSchema.optional(),
});

const RunTurnRequestSchema = z.object({
  user_message: z.string().min(1).max(8000),
});

// Slice 3 (Wave 29-NNN ARC 3) — POST /v1/agent-sessions/:id/mode body.
const SetModeRequestSchema = z.object({
  mode: z.enum(['manual', 'ai', 'pair']),
});

function requireCtx(request: FastifyRequest): NonNullable<FastifyRequest['account']> {
  if (!request.account) throw new Error('account context missing after requireAuth');
  return request.account;
}

interface PublicAgentSession {
  id: string;
  account_id: string;
  driftstack_session_id: string | null;
  status: string;
  closed_reason: string | null;
  token_budget_total: number;
  token_budget_remaining: number;
  transcript_length: number;
  // v2-#19 — wall-clock close timestamp; distinct from updated_at
  // which moves on every transcript append. NULL while active.
  closed_at: string | null;
  // v2-#35 — team-RBAC attribution. NULL when the auth context is
  // account-scoped (no specific team-member id resolvable). Today
  // always NULL for password / OAuth account-scoped sessions until
  // V-298 team-membership auth lands; surfaced on the read shape now
  // so the dashboard's "started by alice@" UI can wire against a
  // stable field.
  created_by_user_id: string | null;
  // Arc 2 sub-slice 8.5 (v2-#8) — operational mode.
  mode: 'manual' | 'ai' | 'pair';
  // 6.c / #15 — the Claude 4.x model the AI agent runs for this session.
  model: AgentModel;
  // Slice 3 (Wave 29-NNN ARC 3) — pair-mode state machine
  // discriminator. NULL when mode != 'pair'; populated with the
  // initialPairModeState() shape on transition INTO pair mode; the
  // takeover/handback routes evolve it through the state machine
  // defined in services/agent-pair-mode-state.ts.
  pair_mode_state: { kind: string; [k: string]: unknown } | null;
  created_at: string;
  updated_at: string;
  // LK.4 — auto-populated on session-create when a Mac with LiveKit
  // credentials is available. Optional so older SDKs ignore it and
  // pre-LK-Mac deployments skip the field entirely.
  livekit?: PublicLivekitInfo;
}

/** LK.4 — LiveKit join info auto-populated on session-create + the
 *  /livekit-token endpoint's response shape. Wire-identical so SDK
 *  consumers can reuse the same type for both surfaces. */
export interface PublicLivekitInfo {
  ws_url: string;
  room: string;
  token: string;
  participant_identity: string;
  expires_at: string;
}

function publicAgentSession(
  rec: AgentSessionRecord,
  livekit?: PublicLivekitInfo,
): PublicAgentSession {
  const base: PublicAgentSession = {
    id: rec.id,
    account_id: rec.accountId,
    driftstack_session_id: rec.driftstackSessionId,
    status: rec.status,
    closed_reason: rec.closedReason,
    token_budget_total: rec.tokenBudgetTotal,
    token_budget_remaining: rec.tokenBudgetRemaining,
    transcript_length: rec.transcript.length,
    closed_at: rec.closedAt !== null ? rec.closedAt.toISOString() : null,
    created_by_user_id: rec.createdByUserId,
    mode: rec.mode,
    model: rec.model,
    pair_mode_state:
      rec.pairModeState !== null &&
      typeof rec.pairModeState === 'object' &&
      'kind' in (rec.pairModeState as Record<string, unknown>)
        ? (rec.pairModeState as { kind: string; [k: string]: unknown })
        : null,
    created_at: rec.createdAt.toISOString(),
    updated_at: rec.updatedAt.toISOString(),
  };
  return livekit !== undefined ? { ...base, livekit } : base;
}

export interface AgentSessionsRoutesDeps {
  runtime: AgentRuntime;
  sessions: AgentSessionsRepo;
  /** Q.1.c — optional. When wired, the route decrypts the
   *  customer's stored BYOK key on session-create and caches the
   *  plaintext for the session lifetime. Absent when MFA_ENCRYPTION_KEY
   *  isn't set (BYOK-per-customer-storage gate). */
  byokService?: BYOKAnthropicService;
  /** Q.1.c — required when byokService is wired. The in-memory
   *  cache that holds plaintexts for the session lifetime. */
  byokKeyCache?: InMemoryByokKeyCache;
  /** Q.1 — which decomposer impl bootstrap wired. Defaults to
   *  'deterministic'. The ByokAnthropicRequired 502 only fires
   *  when this is 'claude' (deterministic ignores keys entirely
   *  so the gate would be a false alarm). */
  agentDecomposerKind?: 'claude' | 'deterministic';
  /** Q.1.d — deployment fallback Anthropic key. Used only when:
   *  (a) the request has no x-byok-anthropic-api-key header
   *  (b) the session has no cached stored key
   *  (c) `allowFallbackForUnconfiguredCustomers` is true.
   *  Default is undefined (prod posture per Tier-3 verdict). */
  deploymentFallbackKey?: string;
  /** Q.1.d — staging-only opt-in. When false (the prod default),
   *  unconfigured customers get 502 ByokAnthropicRequired instead
   *  of silently consuming the deployment fallback. */
  allowFallbackForUnconfiguredCustomers?: boolean;
  /**
   * Arc 1 sub-slice 6.3 (v2-#6) — bundled-LLM settings lookup.
   * When wired AND the customer has `bundled_llm_consent === true`,
   * the resolution chain falls through to the deployment fallback
   * key (Q4=A: BYOK still wins; bundled-LLM is the no-BYOK fallback).
   * Omit to keep the v2-#21 / Q.1.d posture unchanged.
   */
  bundledLlmService?: BundledLlmService;
  /**
   * Arc 2 sub-slice 8.3 (v2-#8) — SSE transcript bus. When wired,
   * GET /v1/agent-sessions/:id/transcript registers as an SSE stream;
   * AgentRuntime publishes every transcript-append. Omit to skip
   * registration (route just won't exist).
   */
  transcriptEventBus?: AgentSessionEventBus;
  /** Heartbeat interval for the SSE stream (ms). Defaults to 30s. */
  transcriptHeartbeatMs?: number;
  /**
   * Arc 2 sub-slice 8.4 (v2-#8) — base64-encoded AES-256 encryption
   * key for the gui_control_key plaintext. Shares MFA_ENCRYPTION_KEY
   * by convention (sub-slice 8.4 mints + persists; route surface
   * decrypts at fetch). Omit to skip the gui_control_key route
   * registration.
   */
  guiControlKeyEncryptionKey?: string;
  /**
   * Arc 2 sub-slice 8.4 (v2-#8) — TTL of the auto-minted
   * gui_control_key. Q2=C verdict locked 24h. Test-injectable so
   * unit tests can pin a tighter window.
   */
  guiControlKeyTtlMs?: number;
  /**
   * Arc 2 sub-slice 8.8 (v2-#8) — Redis SET-NX-EX takeover lock.
   * Required for the POST /:id/takeover + /:id/handback routes;
   * omitting it skips route registration entirely.
   */
  pairModeLock?: PairModeTakeoverLock;
  /**
   * Arc 4 Wave 2.B sub-slice 8.17 (v2-#8) — Sentry breadcrumb sink.
   * When wired, every pair-mode transition logs a breadcrumb tagged
   * with mode + session_id + transition + actor so an exception
   * caught later in the request carries the state-machine context.
   * Omit to skip the instrumentation (route still functional).
   */
  sentry?: SentryClient;
  /**
   * Arc 4 Wave 2.B sub-slice 8.20 (v2-#8) — customer audit log emitter.
   * When wired, takeover + handback transitions land
   * `agent_session.pair_mode.takeover|handback` rows on the customer
   * audit log so the customer can review the full state-machine
   * history. Best-effort: audit failures don't break the transition.
   */
  accountAudit?: AccountAuditService;
  /**
   * Arc 4 Wave 2.B sub-slice 8.18 (v2-#8) — Prometheus metrics registry.
   * Increments `driftstack_pair_mode_transition_total{from,to}` on every
   * successful state-machine transition. Omit to skip counter emission
   * (route still functional; metrics surface just doesn't reflect the
   * transition).
   */
  metrics?: MetricsRegistry;
  /**
   * Arc 4 Wave 2.B sub-slice 8.13d (v2-#8) — pair-mode heartbeat
   * tracker. When wired, takeover + handback handlers call
   * `recordHeartbeat({sessionId, at})` so the sweep service (running
   * every 5s) doesn't auto-handback active sessions back to
   * ai-driving. Omit to skip the recording (sweep then treats every
   * pair-mode session as never-heartbeated → no transitions fire).
   */
  pairModeHeartbeatTracker?: PairModeHeartbeatTracker;
  /**
   * LK.4 — when wired together, the session-create handler auto-
   * mints a LiveKit token + populates the `livekit` field on the 201
   * response (and on the idempotency-replay path). When omitted,
   * the field is absent — clients fall back to calling
   * POST /v1/agent-sessions/:id/livekit-token (LK.3) explicitly.
   *
   * Both must be wired together: the repo holds the per-Mac api_key
   * + encrypted secret, and the encryption key decrypts the secret.
   */
  fleetNodesRepo?: DrizzleFleetNodesRepo;
  livekitSecretEncryptionKey?: string;
  /**
   * Fleet control-plane connection registry. When wired together with
   * `sessionDispatch` (and the fleet repo + encryption key above), a
   * session-create dispatches a `sessionAssign` to the connected fleet
   * node so the harness spawns + captures + publishes that session. Only
   * present when FLEET_CONTROL_PLANE_ENABLED (bootstrap constructs the
   * registry behind that flag) — absent in prod → dispatch is a no-op.
   */
  fleetControlRegistry?: FleetControlRegistry;
  /**
   * Local fleet-demo dispatch config: the archetype / behavior profile /
   * landing URL / SOCKS5 proxy the dispatched session browses with. Wired
   * (with the registry) only on the local demo stack. Absent → no dispatch.
   */
  sessionDispatch?: SessionDispatchConfig;
}

/** Config for the session-create → harness `sessionAssign` dispatch (see
 *  AgentSessionsRoutesDeps.sessionDispatch). */
export interface SessionDispatchConfig {
  archetype: string;
  behaviorProfile: string;
  initialUrl: string;
  proxy: SocksProxyConfig;
}

/**
 * Dispatch a `sessionAssign` to the LiveKit-owning fleet node on
 * session-create, so the harness spawns the browser + captures + publishes.
 *
 * No-op (returns early) unless the full local fleet-demo wiring is present
 * (registry + sessionDispatch + fleet repo + encryption key) — so this is
 * inert in production (FLEET_CONTROL_PLANE_ENABLED off → no registry). Best-
 * effort: any failure is logged, never thrown, so a dispatch problem can't
 * break session-create.
 *
 * v0 semantics (A3 W298 contract): dispatch-on-create only if the node is
 * connected NOW; if not, log + skip (no queue). LIVE re-delivery is idempotent
 * harness-side; TERMINAL re-delivery re-provisions — so this never replays.
 *
 * The assign's `livekit.token` is a PUBLISHER token (canPublish:true) for the
 * harness — distinct from the SUBSCRIBER token `maybeMintLivekit` gives the
 * customer's viewer.
 */
export async function dispatchSessionAssignOnCreate(args: {
  sessionId: string;
  fleetControlRegistry: FleetControlRegistry | undefined;
  fleetNodesRepo: DrizzleFleetNodesRepo | undefined;
  livekitSecretEncryptionKey: string | undefined;
  sessionDispatch: SessionDispatchConfig | undefined;
  logger?: { info: (obj: unknown, msg: string) => void; warn: (obj: unknown, msg: string) => void };
  // Profile-backed sessions (file 57). When all three are present and the
  // profile has a DEK, the assign carries a `profile` block so the harness
  // restores/persists the per-profile encrypted store. Absent → stateless
  // (today's path). The route threads these from the create body's profile_id.
  accountId?: string;
  profileId?: string;
  profilesService?: ProfilesService;
}): Promise<void> {
  const {
    sessionId,
    fleetControlRegistry,
    fleetNodesRepo,
    livekitSecretEncryptionKey,
    sessionDispatch,
    logger,
    accountId,
    profileId,
    profilesService,
  } = args;
  if (
    fleetControlRegistry === undefined ||
    fleetNodesRepo === undefined ||
    livekitSecretEncryptionKey === undefined ||
    sessionDispatch === undefined
  ) {
    return;
  }
  try {
    const mac = await fleetNodesRepo.findAnyWithLivekit();
    if (mac === null || mac.livekit === null) return;
    const conn = fleetControlRegistry.get(mac.id);
    if (conn === undefined) {
      logger?.info(
        { component: 'fleet-session-dispatch', sessionId, nodeId: mac.id },
        'fleet node not connected; session created but sessionAssign not dispatched',
      );
      return;
    }
    const apiSecret = decryptLivekitSecret(
      mac.livekit.apiSecretCiphertextBase64,
      livekitSecretEncryptionKey,
    );
    const nowMs = Date.now();
    const ttlSeconds = 6 * 60 * 60;
    const token = mintLivekitToken({
      apiKey: mac.livekit.apiKey,
      apiSecret,
      identity: `harness-${mac.id}`,
      ttlSeconds,
      nowMs,
      video: { room: sessionId, roomJoin: true, canPublish: true, canSubscribe: true },
    });
    // Profile-backed (file 57): when a profile is attached + has a DEK, ship
    // the per-profile DEK so the harness can open/seal the encrypted store.
    // Fresh profiles ship the DEK only (no sealedBlob); the sealed-blob restore
    // (presigned sealed_blob_url) is a follow-up. getProfileDek is null when the
    // master key is unset or the profile has no DEK → stateless assign.
    let profile: { profileId: string; dek: string } | undefined;
    if (profileId !== undefined && accountId !== undefined && profilesService !== undefined) {
      const dek = await profilesService.getProfileDek({ profileId, accountId });
      if (dek !== null) {
        profile = { profileId, dek: dek.toString('base64') };
      }
    }
    const assign = serializeSessionAssign({
      sessionId,
      archetype: sessionDispatch.archetype,
      behaviorProfile: sessionDispatch.behaviorProfile,
      initialUrl: sessionDispatch.initialUrl,
      inlineProxyConfig: sessionDispatch.proxy,
      livekit: {
        room: sessionId,
        token,
        wsUrl: mac.livekit.wsUrl,
        expiresAt: new Date(nowMs + ttlSeconds * 1000).toISOString(),
      },
      ...(profile !== undefined ? { profile } : {}),
    });
    conn.sendSessionAssign(assign);
    logger?.info(
      { component: 'fleet-session-dispatch', sessionId, nodeId: mac.id },
      'dispatched sessionAssign to fleet node',
    );
  } catch (err) {
    logger?.warn(
      {
        component: 'fleet-session-dispatch',
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      },
      'sessionAssign dispatch failed (session create unaffected)',
    );
  }
}

/**
 * Best-effort `sessionEnd` dispatch when an agent-session closes — tells the
 * harness to tear the session down (fork + proxy + capture) and free its
 * concurrency slot (A3 W420 sessionEnd teardown site). Without it, a closed
 * session leaks a harness slot until the harness's own idle sweep reclaims it
 * (maxConcurrent is small, so leaked slots → at_capacity refusals).
 *
 * Mirrors dispatchSessionAssignOnCreate: no-op unless the fleet control plane is
 * wired (inert in prod), best-effort (never throws — close must not fail on a
 * dispatch hiccup), at-most-once. v0 routes to findAnyWithLivekit (the same
 * single-node assumption the create-side dispatch uses); the harness ignores a
 * sessionEnd for a session it doesn't hold, so a stray send is a harmless no-op.
 * A session→node map (multi-node) is a later enhancement.
 */
export async function dispatchSessionEndOnClose(args: {
  sessionId: string;
  fleetControlRegistry: FleetControlRegistry | undefined;
  fleetNodesRepo: DrizzleFleetNodesRepo | undefined;
  logger?: { info: (obj: unknown, msg: string) => void; warn: (obj: unknown, msg: string) => void };
}): Promise<void> {
  const { sessionId, fleetControlRegistry, fleetNodesRepo, logger } = args;
  if (fleetControlRegistry === undefined || fleetNodesRepo === undefined) return;
  try {
    const mac = await fleetNodesRepo.findAnyWithLivekit();
    if (mac === null) return;
    const conn = fleetControlRegistry.get(mac.id);
    if (conn === undefined) return; // node not connected → nothing to tear down server-side
    conn.sendSessionEnd(serializeSessionEnd(sessionId));
    logger?.info(
      { component: 'fleet-session-dispatch', sessionId, nodeId: mac.id },
      'dispatched sessionEnd to fleet node',
    );
  } catch (err) {
    logger?.warn(
      {
        component: 'fleet-session-dispatch',
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      },
      'sessionEnd dispatch failed (session close unaffected)',
    );
  }
}

export function registerAgentSessionsRoutes(
  app: FastifyInstance,
  deps: AgentSessionsRoutesDeps,
): void {
  const {
    runtime,
    sessions,
    byokService,
    byokKeyCache,
    agentDecomposerKind = 'deterministic',
    deploymentFallbackKey,
    allowFallbackForUnconfiguredCustomers,
    bundledLlmService,
    transcriptEventBus,
    transcriptHeartbeatMs = 30_000,
    guiControlKeyEncryptionKey,
    guiControlKeyTtlMs = 24 * 60 * 60 * 1000,
    pairModeLock,
    sentry,
    accountAudit,
    metrics,
    pairModeHeartbeatTracker,
    fleetNodesRepo,
    livekitSecretEncryptionKey,
    fleetControlRegistry,
    sessionDispatch,
  } = deps;

  /** LK.4 — auto-mint a LiveKit token for the just-created (or
   *  replayed) agent session. Returns undefined when:
   *   - the fleet repo or encryption key isn't wired
   *   - no Mac has registered LiveKit credentials yet
   *   - the Mac's secret can't be decrypted (key-rotation drift)
   *  In every "undefined" case the session-create response simply
   *  omits the `livekit` field — clients fall back to calling
   *  LK.3 (POST /v1/agent-sessions/:id/livekit-token) explicitly.
   *  Best-effort: never fails the session-create call. */
  async function maybeMintLivekit(
    sessionId: string,
    accountId: string,
  ): Promise<PublicLivekitInfo | undefined> {
    if (fleetNodesRepo === undefined || livekitSecretEncryptionKey === undefined) {
      return undefined;
    }
    try {
      const mac = await fleetNodesRepo.findAnyWithLivekit();
      if (mac === null || mac.livekit === null) return undefined;
      const apiSecret = decryptLivekitSecret(
        mac.livekit.apiSecretCiphertextBase64,
        livekitSecretEncryptionKey,
      );
      const ttlSeconds = 24 * 60 * 60;
      const nowMs = Date.now();
      const token = mintLivekitToken({
        apiKey: mac.livekit.apiKey,
        apiSecret,
        identity: `customer-${accountId}`,
        ttlSeconds,
        nowMs,
        video: {
          room: sessionId,
          roomJoin: true,
          canPublish: false,
          canSubscribe: true,
        },
      });
      return {
        ws_url: mac.livekit.wsUrl,
        room: sessionId,
        token,
        participant_identity: `customer-${accountId}`,
        expires_at: new Date(nowMs + ttlSeconds * 1000).toISOString(),
      };
    } catch {
      // Best-effort: any failure (decrypt error, repo error) drops
      // to undefined so the session-create response still ships.
      return undefined;
    }
  }

  app.post(
    '/v1/agent-sessions',
    { preHandler: [app.requireAuth, app.requireScope('write'), app.rateLimit('global')] },
    async (req, reply) => {
      const ctx = requireCtx(req);
      const parsed = CreateAgentSessionRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      // v2-#19 — Stripe-pattern idempotency. Header name is lowercase
      // per Fastify's normalised headers map; the dashboard / SDK send
      // it as `Idempotency-Key` and the wire-level toLowerCase happens
      // before this handler sees it. Shared parser at
      // lib/idempotency-key.ts enforces the same no-whitespace +
      // max-255 + ASCII-only contract as V-666.AO billing-crypto,
      // per the customer docs at /docs/idempotency-keys.
      const idempotency = readIdempotencyKey(req);
      if (idempotency.kind === 'invalid') {
        throw new ValidationError({
          formErrors: ['Idempotency-Key must be ≤255 ASCII characters, no whitespace.'],
          fieldErrors: {},
        });
      }
      const idempotencyKey = idempotency.kind === 'valid' ? idempotency.key : null;
      if (idempotencyKey !== null) {
        const existing = await sessions.findByIdempotencyKey(ctx.account.id, idempotencyKey);
        if (existing !== null) {
          // Replay the prior 201 response. We re-attach the cached
          // BYOK key plaintext too: if the original session-create
          // hydrated the cache, the cache lives in memory and may
          // have evicted (single-replica today; survives a request
          // but not a redeploy). A second hydration here is cheap
          // (one AES-GCM unwrap) and keeps the replay behaviour
          // observably-identical to the first call.
          if (byokService !== undefined && byokKeyCache !== undefined) {
            // v2-#21 — pass `now` so a stored key older than the TTL
            // resolves to null + the resolution chain falls through to
            // header / fallback / 502.
            const stored = await byokService.getPlaintext({
              accountId: ctx.account.id,
              now: new Date(),
            });
            if (stored !== null) byokKeyCache.set(existing.id, stored);
          }
          const livekit = await maybeMintLivekit(existing.id, ctx.account.id);
          return reply.code(201).send(publicAgentSession(existing, livekit));
        }
      }
      let created: AgentSessionRecord;
      try {
        created = await sessions.create({
          accountId: ctx.account.id,
          tokenBudgetTotal: parsed.data.token_budget ?? DEFAULT_TOKEN_BUDGET,
          ...(parsed.data.driftstack_session_id !== undefined
            ? { driftstackSessionId: parsed.data.driftstack_session_id }
            : {}),
          ...(idempotencyKey !== null ? { idempotencyKey } : {}),
          // Arc 2 sub-slice 8.5 (v2-#8) — forward mode when supplied;
          // otherwise repo applies the default ('ai').
          ...(parsed.data.mode !== undefined ? { mode: parsed.data.mode } : {}),
          // 6.c / #15 — forward the picked model when supplied; otherwise
          // repo applies the default ('claude-opus-4-7').
          ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
        });
      } catch (err) {
        // v2-#19 — concurrent same-key idempotency race: the
        // findByIdempotencyKey pre-check above can't see a row a sibling
        // in-flight POST hasn't committed yet, so both reach create(); the
        // partial unique index (agent_sessions_idempotency_key_unique) lets
        // exactly one win and raises 23505 on the loser. Replay the winner's
        // 201 instead of surfacing a 500 — matches the Stripe idempotency
        // contract + the pre-check replay path above. Any other error
        // re-throws untouched. (code-only 23505 — any unique index on the
        // insert is the idempotency-key race; isUniqueViolation reads top
        // level on drizzle 0.38, err.cause on 0.45.)
        if (idempotencyKey !== null && isUniqueViolation(err)) {
          const winner = await sessions.findByIdempotencyKey(ctx.account.id, idempotencyKey);
          if (winner !== null) {
            if (byokService !== undefined && byokKeyCache !== undefined) {
              const stored = await byokService.getPlaintext({
                accountId: ctx.account.id,
                now: new Date(),
              });
              if (stored !== null) byokKeyCache.set(winner.id, stored);
            }
            const livekit = await maybeMintLivekit(winner.id, ctx.account.id);
            return reply.code(201).send(publicAgentSession(winner, livekit));
          }
        }
        throw err;
      }
      // Q.1.c — decrypt the customer's stored BYOK key ONCE at
      // session-create and stash plaintext in the per-session cache.
      // Bounds AES-GCM unwrap to one operation per session.
      // v2-#21 — pass `now` so the TTL gate fires for stored keys
      // older than maxKeyAgeMs (90d default).
      if (byokService !== undefined && byokKeyCache !== undefined) {
        const stored = await byokService.getPlaintext({
          accountId: ctx.account.id,
          now: new Date(),
        });
        if (stored !== null) {
          byokKeyCache.set(created.id, stored);
        }
      }
      const livekit = await maybeMintLivekit(created.id, ctx.account.id);
      // Fleet-CP session dispatch — hand the new session to a connected
      // harness node (local fleet-demo). No-op in prod (no registry); best-
      // effort (never throws) so it can't break session-create.
      await dispatchSessionAssignOnCreate({
        sessionId: created.id,
        fleetControlRegistry,
        fleetNodesRepo,
        livekitSecretEncryptionKey,
        sessionDispatch,
        logger: req.log,
      });
      // Slice 6 follow-up 2026-05-20 — agent-session create audit. Best-
      // effort emit; audit failures don't break the create. Distinct
      // action from session.created (which audits the underlying driver
      // session at the regular /v1/sessions surface).
      try {
        await accountAudit?.record({
          accountId: ctx.account.id,
          actorType: 'customer',
          action: 'agent_session.created',
          targetResourceId: `agent_session_${created.id}`,
          payload: { agent_session_id: created.id, initial_mode: created.mode },
          ipAddress: readClientIp(req),
        });
      } catch {
        /* swallow */
      }
      return reply.code(201).send(publicAgentSession(created, livekit));
    },
  );

  // 2026-05-22 — list customer's agent sessions, newest first. Used
  // by the dashboard's /agent-sessions page to render a history.
  // Returns the public envelope (no transcript inline; the detail
  // route serves that). Hard-capped at 100 results per call; the
  // dashboard pages locally if a customer has more than that.
  app.get(
    '/v1/agent-sessions',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const all = await sessions.listByAccount(ctx.account.id);
      // Sort newest-first by createdAt for the dashboard's "recent
      // sessions" rendering. The repo doesn't guarantee order.
      const sorted = [...all].sort((a, b) => {
        const aT = a.createdAt instanceof Date ? a.createdAt.getTime() : 0;
        const bT = b.createdAt instanceof Date ? b.createdAt.getTime() : 0;
        return bT - aT;
      });
      return {
        data: sorted.slice(0, 100).map((rec) => publicAgentSession(rec)),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/agent-sessions/:id',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const rec = await sessions.get(req.params.id);
      if (rec === null || rec.accountId !== ctx.account.id) {
        throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
      }
      return publicAgentSession(rec);
    },
  );

  // Arc 2 sub-slice 8.3 (v2-#8) — SSE transcript stream. Registers
  // only when the event bus is wired (the live-stream functionality
  // is opt-in deploy-side). Last-Event-ID resumes from a prior
  // disconnect: client sends the last `index` it saw; server replays
  // every entry with index > last-id, then live-streams new appends.
  if (transcriptEventBus !== undefined) {
    app.get<{ Params: { id: string }; Querystring: { ds_token?: string } }>(
      '/v1/agent-sessions/:id/transcript',
      // SSE: EventSource can't set an Authorization header, so this
      // route also accepts the bearer token via `?ds_token=` (documented
      // contract — apps/docs api/agent-sessions). requireAuthEventSource
      // reads the query fallback; the header still wins when present.
      { preHandler: [app.requireAuthEventSource, app.rateLimit('global')] },
      async (req, reply) => {
        const ctx = requireCtx(req);
        const session = await sessions.get(req.params.id);
        if (session === null || session.accountId !== ctx.account.id) {
          throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
        }
        const lastEventIdHeader = req.headers['last-event-id'];
        const lastEventId =
          typeof lastEventIdHeader === 'string' && lastEventIdHeader.length > 0
            ? Number.parseInt(lastEventIdHeader, 10)
            : -1;
        const resumeFrom = Number.isFinite(lastEventId) ? lastEventId : -1;

        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        reply.raw.write(': stream open\n\n');

        // Replay every transcript entry past the resume point. The
        // client's Last-Event-ID is exclusive (replay strictly after).
        for (let i = resumeFrom + 1; i < session.transcript.length; i += 1) {
          const entry = session.transcript[i];
          if (entry === undefined) continue;
          reply.raw.write(`id: ${i.toString()}\n`);
          reply.raw.write('event: transcript.entry\n');
          reply.raw.write(`data: ${JSON.stringify({ index: i, entry })}\n\n`);
        }

        const liveSent = new Set<number>();
        const unsubscribe = transcriptEventBus.subscribe(req.params.id, (event) => {
          if (event.index <= resumeFrom) return;
          if (liveSent.has(event.index)) return;
          // Skip indices the replay loop already wrote (avoid dupes
          // on the connect-then-publish race; both write the same
          // {index, entry} payload so a downstream dedupe IS safe,
          // but we elide here to keep the stream tight).
          if (event.index < session.transcript.length) return;
          liveSent.add(event.index);
          reply.raw.write(`id: ${event.index.toString()}\n`);
          reply.raw.write('event: transcript.entry\n');
          reply.raw.write(
            `data: ${JSON.stringify({ index: event.index, entry: event.entry })}\n\n`,
          );
        });
        const heartbeat = setInterval(() => {
          reply.raw.write(`: heartbeat ${new Date().toISOString()}\n\n`);
        }, transcriptHeartbeatMs);
        heartbeat.unref();

        const cleanup = (): void => {
          clearInterval(heartbeat);
          unsubscribe();
          reply.raw.end();
        };
        req.raw.on('close', cleanup);
        req.raw.on('error', cleanup);
        reply.hijack();
      },
    );
  }

  // Arc 2 sub-slice 8.4 (v2-#8) — gui_control_key auto-mint endpoint.
  // First call: mint plaintext, AES-GCM encrypt, persist ciphertext +
  // 24h-TTL expiry. Subsequent calls within the TTL: decrypt + echo
  // the same plaintext back so the gui-client can reconnect without
  // a full session-reissue. Past TTL: mint fresh (the old plaintext
  // is unrecoverable — purposeful, since the customer should treat
  // it as a single-session token).
  if (guiControlKeyEncryptionKey !== undefined) {
    app.get<{ Params: { id: string } }>(
      '/v1/agent-sessions/:id/gui-control-key',
      { preHandler: [app.requireAuth, app.rateLimit('global')] },
      async (req) => {
        const ctx = requireCtx(req);
        const rec = await sessions.get(req.params.id);
        if (rec === null || rec.accountId !== ctx.account.id) {
          throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
        }
        const now = new Date();
        // Mint when no key exists OR the existing one has expired.
        const expired =
          rec.guiControlKeyExpiresAt === null ||
          rec.guiControlKeyExpiresAt.getTime() <= now.getTime();
        if (expired || rec.guiControlKeyCiphertext === null) {
          const plaintext = generateGuiControlKey();
          const ciphertext = encryptGuiControlKey(plaintext, guiControlKeyEncryptionKey);
          const expiresAt = new Date(now.getTime() + guiControlKeyTtlMs);
          await sessions.setGuiControlKey({
            id: req.params.id,
            ciphertext,
            expiresAt,
          });
          return {
            gui_control_key: plaintext,
            expires_at: expiresAt.toISOString(),
            minted: true as const,
          };
        }
        // Live key: decrypt + echo. The dashboard treats every call
        // as idempotent within the TTL.
        const plaintext = decryptGuiControlKey(
          rec.guiControlKeyCiphertext,
          guiControlKeyEncryptionKey,
        );
        return {
          gui_control_key: plaintext as string,
          expires_at: rec.guiControlKeyExpiresAt!.toISOString(),
          minted: false as const,
        };
      },
    );
  }

  // Slice 4 (Wave 29-NNN ARC 3) — POST /v1/agent-sessions/:id/input-event.
  // Customer-dashboard ManualControlOverlay raw screen-coord forwarder.
  // Wire shape: { event: <LK.6 InputEvent discriminated union> } per
  // packages/api-types/src/agent-input-event.ts.
  //
  // Server-side dispatch is harness-gated: until Agent 1's Swift
  // harness end-to-end lands (Tier-3 verdict 2026-05-19 Option A;
  // 6-9 weeks post §10/§11+EG-WK), no transport exists to forward
  // events to the harness. Route returns 503 FeatureUnavailable in
  // that pre-harness window. The route layer still validates auth +
  // mode + status so the dashboard's wire-error UX path is exercised
  // end-to-end before harness work lands.
  //
  // Pair-mode interaction: an input-event arriving in mode='pair'
  // while pair_mode_state.kind === 'ai-driving' is a takeover
  // trigger — the route fires the same `takeover-request` (OR
  // `takeover-request-queued` if decompose in flight) transition the
  // POST /:id/takeover route uses, so the state machine drives one
  // path. AI-only mode rejects with a typed 409.
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/v1/agent-sessions/:id/input-event',
    {
      preHandler: [
        app.requireAuth,
        app.requireScope('write'),
        // Dedicated bucket — separate from the generic 'global' so
        // a customer's 120Hz input stream doesn't burn through their
        // generic-API quota. Tier-derived burst when B3 ships; today
        // every account shares the static cap defined in
        // TIER_RATE_LIMIT_DEFAULTS.
        app.rateLimit('agent_sessions:input_event'),
      ],
    },
    async (req, reply) => {
      const ctx = requireCtx(req);
      const parsed = SendInputEventRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      const rec = await sessions.get(req.params.id);
      if (rec === null || rec.accountId !== ctx.account.id) {
        throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
      }
      if (rec.status !== 'active') {
        throw new ConflictError(
          `AgentSession ${req.params.id} is ${rec.status}; input-event requires an active session.`,
        );
      }
      if (rec.mode === 'ai') {
        throw new ConflictError(
          `AgentSession ${req.params.id} is in mode='ai'; input-event requires mode='manual' or 'pair'.`,
        );
      }

      // Slice 5 (Wave 29-NNN ARC 3) — pair-mode takeover-trigger
      // wire. The first input-event in a pair-mode session whose
      // pair_mode_state.kind === 'ai-driving' fires the
      // takeover-request transition (same path the explicit POST
      // /:id/takeover route uses). Subsequent input-events in
      // human-driving forward to the harness; pending / queued
      // transition states reject with 409 (mid-transition, retry
      // after the state settles).
      if (rec.mode === 'pair') {
        const currentState = (rec.pairModeState as PairModeState | null) ?? initialPairModeState();
        if (currentState.kind === 'ai-driving') {
          // Takeover-trigger path. Requires client_id so the
          // pair-mode lock can scope contention to one tab.
          if (!parsed.data.client_id) {
            throw new ValidationError({
              formErrors: [],
              fieldErrors: {
                client_id: [
                  'client_id is required when the first input-event in pair mode fires the takeover-request transition',
                ],
              },
            });
          }
          if (pairModeLock === undefined) {
            throw new FeatureUnavailableError(
              'Pair-mode takeover-via-input-event requires the Redis pair-mode lock to be wired on this deployment.',
            );
          }
          const lockResult = await pairModeLock.tryAcquire({
            sessionId: req.params.id,
            clientId: parsed.data.client_id,
          });
          if (!lockResult.acquired) {
            throw new PairModeConflictError(lockResult.winnerClientId);
          }
          try {
            const nextState = applyPairModeTransition(currentState, {
              kind: 'takeover-request',
              clientId: parsed.data.client_id,
              at: new Date().toISOString(),
            });
            await sessions.setPairModeState(req.params.id, nextState);
            sentry?.addBreadcrumb({
              category: 'agent-session.pair-mode',
              message: `input-event → takeover-request → ${nextState.kind}`,
              data: {
                session_id: req.params.id,
                account_id: ctx.account.id,
                event_type: parsed.data.event.type,
                from: currentState.kind,
                to: nextState.kind,
                actor: parsed.data.client_id,
              },
            });
            try {
              await accountAudit?.record({
                accountId: ctx.account.id,
                actorType: 'customer',
                action: 'agent_session.pair_mode.takeover',
                targetResourceId: `agent_session_${req.params.id}`,
                payload: {
                  from: currentState.kind,
                  to: nextState.kind,
                  client_id: parsed.data.client_id,
                  triggered_by: 'input_event',
                  event_type: parsed.data.event.type,
                },
                ipAddress: readClientIp(req),
              });
            } catch {
              /* swallow */
            }
            try {
              metrics?.inc(METRIC_NAMES.pairModeTransitionTotal, {
                from: currentState.kind,
                to: nextState.kind,
              });
            } catch {
              /* swallow */
            }
            return reply.code(200).send({
              kind: 'pair-mode-takeover-fired' as const,
              pair_mode_state: nextState,
            });
          } catch (err) {
            if (err instanceof PairModeStateInvalidTransitionError) {
              throw new PairModeStateInvalidTransitionRouteError({
                from: err.from,
                transition: err.transition,
              });
            }
            throw err;
          }
        }
        // Pending / queued mid-transition states reject — a click
        // landing during takeover-pending or handback-queued is
        // ambiguous; the dashboard polls pair_mode_state to know
        // when the transition has settled.
        if (
          currentState.kind === 'takeover-pending' ||
          currentState.kind === 'takeover-queued' ||
          currentState.kind === 'handback-pending' ||
          currentState.kind === 'handback-queued'
        ) {
          throw new ConflictError(
            `AgentSession ${req.params.id} pair-mode state is ${currentState.kind}; wait for the transition to settle before forwarding input-events.`,
          );
        }
        // currentState.kind === 'human-driving' falls through to
        // the harness-forward path below.
      }

      // Manual mode OR pair-mode + human-driving: forward to the
      // harness. Pre-harness: no transport exists; return 503 with
      // FeatureUnavailable. Once Agent 1's Swift harness end-to-end
      // lands, the dispatcher publishes the event via LiveKit
      // DataChannel + returns { kind: 'forwarded', duration_ms }.
      throw new FeatureUnavailableError(
        'Live input forwarding requires a Mac fleet node with harness end-to-end ' +
          'enabled. Pre-launch this endpoint forwards mode=manual + pair-mode-after-takeover ' +
          'events to a stub; full activation lands with the v1.0 harness Swift work. ' +
          'See https://docs.driftstack.dev/api/agent-sessions/ for the full agent-session surface.',
      );
    },
  );

  // Slice 3 (Wave 29-NNN ARC 3) — POST /v1/agent-sessions/:id/mode.
  // Top-level mode setter for the AI-chat / manual / pair toggle on
  // the per-session workbench page. Atomic dual-column write of
  // `mode` + `pair_mode_state` via sessions.setMode:
  //   - target 'pair' → pair_mode_state = initialPairModeState()
  //   - target 'manual' / 'ai' → pair_mode_state = null
  // Idempotent: a no-op mode transition returns the existing row.
  // Closed sessions reject with ConflictError. Concurrent /mode calls
  // serialize at the row-level UPDATE; last writer wins (route layer
  // doesn't hold the Redis pair-mode lock here — the takeover/handback
  // routes are the ones that fight over WITHIN-pair state).
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/v1/agent-sessions/:id/mode',
    { preHandler: [app.requireAuth, app.requireScope('write'), app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const parsed = SetModeRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      const rec = await sessions.get(req.params.id);
      if (rec === null || rec.accountId !== ctx.account.id) {
        throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
      }
      if (rec.status !== 'active') {
        throw new ConflictError(
          `AgentSession ${req.params.id} is ${rec.status}; mode can only be changed on active sessions.`,
        );
      }
      const target = parsed.data.mode;
      if (rec.mode === target) {
        // Idempotent — no-op return preserves pair_mode_state when
        // the session is already in pair mode mid-takeover.
        return publicAgentSession(rec);
      }
      const nextPairModeState: PairModeState | null =
        target === 'pair' ? initialPairModeState() : null;
      const updated = await sessions.setMode(req.params.id, target, nextPairModeState);
      // Slice 6 follow-up 2026-05-20 — customer audit log entry. The
      // mode change is a meaningful state transition (especially
      // ai → manual / pair → ai for incident investigation). Best-effort:
      // audit failures don't break the mode change. Matches the v2-#8
      // takeover/handback audit pattern at sub-slice 8.20.
      try {
        await accountAudit?.record({
          accountId: ctx.account.id,
          actorType: 'customer',
          action: 'agent_session.mode.changed',
          targetResourceId: `agent_session_${req.params.id}`,
          payload: { from: rec.mode, to: target },
          ipAddress: readClientIp(req),
        });
      } catch {
        /* swallow */
      }
      return publicAgentSession(updated);
    },
  );

  // Arc 2 sub-slice 8.9 (v2-#8) — pair-mode takeover + handback.
  // Both routes require the pair-mode lock AND mode='pair' on the
  // session; otherwise they 409. Takeover composes the lock (sub-
  // slice 8.8) + the state machine (sub-slice 8.7). The lock guards
  // the takeover-request transition specifically; subsequent
  // transitions are serialised by the per-row UPDATE in
  // setPairModeState.
  if (pairModeLock !== undefined) {
    // client_id is a customer-chosen opaque tag identifying which
    // browser tab / window initiated the takeover. UUID-shape is
    // typical; 128 cap matches OAuth client_id cap in oauth.ts.
    const TakeoverBodySchema = z.object({ client_id: z.string().min(1).max(128) });
    app.post<{ Params: { id: string } }>(
      '/v1/agent-sessions/:id/takeover',
      { preHandler: [app.requireAuth, app.requireScope('write'), app.rateLimit('global')] },
      async (req, reply) => {
        const ctx = requireCtx(req);
        const parsed = TakeoverBodySchema.safeParse(req.body);
        if (!parsed.success) throw new ValidationError(parsed.error.flatten());
        const rec = await sessions.get(req.params.id);
        if (rec === null || rec.accountId !== ctx.account.id) {
          throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
        }
        if (rec.mode !== 'pair') {
          throw new ConflictError(
            `AgentSession is in mode='${rec.mode}'; takeover requires mode='pair'.`,
          );
        }
        const lockResult = await pairModeLock.tryAcquire({
          sessionId: req.params.id,
          clientId: parsed.data.client_id,
        });
        if (!lockResult.acquired) {
          throw new PairModeConflictError(lockResult.winnerClientId);
        }
        try {
          const currentState =
            (rec.pairModeState as PairModeState | null) ?? initialPairModeState();
          const nextState = applyPairModeTransition(currentState, {
            kind: 'takeover-request',
            clientId: parsed.data.client_id,
            at: new Date().toISOString(),
          });
          await sessions.setPairModeState(req.params.id, nextState);
          // Arc 4 Wave 2.B sub-slice 8.17 (v2-#8) — Sentry breadcrumb.
          // Attaches state-machine context so any later exception in
          // this request carries the transition trail.
          sentry?.addBreadcrumb({
            category: 'agent-session.pair-mode',
            message: `takeover-request → ${nextState.kind}`,
            data: {
              session_id: req.params.id,
              account_id: ctx.account.id,
              mode: rec.mode,
              from: currentState.kind,
              to: nextState.kind,
              actor: parsed.data.client_id,
            },
          });
          // Arc 4 Wave 2.B sub-slice 8.20 (v2-#8) — customer audit log
          // entry. Best-effort emit; audit failures don't break the
          // transition (matches the v2-#5 Q.1.f decompose-audit pattern).
          try {
            await accountAudit?.record({
              accountId: ctx.account.id,
              actorType: 'customer',
              action: 'agent_session.pair_mode.takeover',
              targetResourceId: `agent_session_${req.params.id}`,
              payload: {
                from: currentState.kind,
                to: nextState.kind,
                client_id: parsed.data.client_id,
              },
              ipAddress: readClientIp(req),
            });
          } catch {
            /* swallow */
          }
          // Arc 4 Wave 2.B sub-slice 8.18 (v2-#8) — Prometheus counter.
          // Best-effort: a registry inc never throws under normal
          // operation (counters validated at registration), but wrap
          // anyway so a stray bug doesn't break the transition.
          try {
            metrics?.inc(METRIC_NAMES.pairModeTransitionTotal, {
              from: currentState.kind,
              to: nextState.kind,
            });
          } catch {
            /* swallow */
          }
          // Arc 4 Wave 2.B sub-slice 8.13d (v2-#8) — record a fresh
          // heartbeat so the 5s sweep doesn't immediately auto-
          // handback a takeover the customer just acquired. The
          // tracker is in-memory; recordHeartbeat doesn't throw.
          pairModeHeartbeatTracker?.recordHeartbeat({
            sessionId: req.params.id,
            at: new Date(),
          });
          return reply.code(200).send({ pair_mode_state: nextState });
        } catch (err) {
          if (err instanceof PairModeStateInvalidTransitionError) {
            throw new PairModeStateInvalidTransitionRouteError({
              from: err.from,
              transition: err.transition,
            });
          }
          throw err;
        } finally {
          await pairModeLock.release({
            sessionId: req.params.id,
            clientId: parsed.data.client_id,
          });
        }
      },
    );

    app.post<{ Params: { id: string } }>(
      '/v1/agent-sessions/:id/handback',
      { preHandler: [app.requireAuth, app.requireScope('write'), app.rateLimit('global')] },
      async (req, reply) => {
        const ctx = requireCtx(req);
        const rec = await sessions.get(req.params.id);
        if (rec === null || rec.accountId !== ctx.account.id) {
          throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
        }
        if (rec.mode !== 'pair') {
          throw new ConflictError(
            `AgentSession is in mode='${rec.mode}'; handback requires mode='pair'.`,
          );
        }
        try {
          const currentState =
            (rec.pairModeState as PairModeState | null) ?? initialPairModeState();
          const nextState = applyPairModeTransition(currentState, {
            kind: 'handback-request',
            at: new Date().toISOString(),
          });
          await sessions.setPairModeState(req.params.id, nextState);
          // Arc 4 Wave 2.B sub-slice 8.17 (v2-#8) — Sentry breadcrumb.
          sentry?.addBreadcrumb({
            category: 'agent-session.pair-mode',
            message: `handback-request → ${nextState.kind}`,
            data: {
              session_id: req.params.id,
              account_id: ctx.account.id,
              mode: rec.mode,
              from: currentState.kind,
              to: nextState.kind,
            },
          });
          try {
            await accountAudit?.record({
              accountId: ctx.account.id,
              actorType: 'customer',
              action: 'agent_session.pair_mode.handback',
              targetResourceId: `agent_session_${req.params.id}`,
              payload: { from: currentState.kind, to: nextState.kind },
              ipAddress: readClientIp(req),
            });
          } catch {
            /* swallow */
          }
          // Arc 4 Wave 2.B sub-slice 8.18 (v2-#8) — Prometheus counter.
          try {
            metrics?.inc(METRIC_NAMES.pairModeTransitionTotal, {
              from: currentState.kind,
              to: nextState.kind,
            });
          } catch {
            /* swallow */
          }
          // Arc 4 Wave 2.B sub-slice 8.13d (v2-#8) — record a fresh
          // heartbeat. Handback transitions still represent active
          // customer attention (they're explicitly returning control,
          // not abandoning the session), so the sweep should not
          // immediately fire timeout on a session that was just
          // handed back. The state-machine post-handback (ai-driving)
          // is a no-op for the sweep anyway, but we forget the entry
          // here to keep the in-memory map bounded.
          pairModeHeartbeatTracker?.forget(req.params.id);
          return reply.code(200).send({ pair_mode_state: nextState });
        } catch (err) {
          if (err instanceof PairModeStateInvalidTransitionError) {
            throw new PairModeStateInvalidTransitionRouteError({
              from: err.from,
              transition: err.transition,
            });
          }
          throw err;
        }
      },
    );
  }

  app.post<{ Params: { id: string } }>(
    '/v1/agent-sessions/:id/message',
    // v2-#13 — dedicated bucket for AI chat turns (separate from
    // 'global' so a customer hammering chat doesn't burn through
    // their generic API quota). Bucket capacity scales per tier;
    // see TIER_RATE_LIMIT_DEFAULTS in @driftstack/api-types.
    {
      preHandler: [
        app.requireAuth,
        app.requireScope('write'),
        app.rateLimit('agent_sessions:message'),
      ],
    },
    async (req) => {
      const ctx = requireCtx(req);
      const parsed = RunTurnRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      // Cross-account guard before runtime.runTurn — the runtime
      // throws on unknown ids, but we want 403/404 distinction over
      // "not found" generic.
      const pre = await sessions.get(req.params.id);
      if (pre === null || pre.accountId !== ctx.account.id) {
        throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
      }
      // Q.1.c + Q.1.d — BYOK Anthropic key resolution chain (founder
      // verdicts 2026-05-17 layering onto BYOK Tier-3 LOCKED 2026-05-16
      // — customer brings their own Anthropic key). Priority order:
      //
      //   1. Per-request header (`x-byok-anthropic-api-key`) — the
      //      customer's explicit per-turn override. Header wins even
      //      when a stored key is cached (matches the Stripe / Mailgun
      //      "header overrides default" UX).
      //   2. Session-cached stored key — decrypted once on session
      //      create from `accounts.byok_anthropic_api_key_ciphertext`.
      //      Hit on the cache means the customer has set their key via
      //      PUT /v1/account/me/byok-anthropic-key.
      //   3. Deployment fallback key — Q.1.d HARD-502 in prod
      //      (`allowFallbackForUnconfiguredCustomers === false`); only
      //      consumed on staging where the flag is opted in for demo
      //      flows without BYOK setup.
      //
      // Arc 1 sub-slice 6.3 (v2-#6) extends the resolution chain with
      // a bundled-LLM leg AFTER cached BYOK but BEFORE the staging-only
      // fallback gate. Per founder verdict Q4=A, BYOK ALWAYS wins —
      // bundled-LLM only resolves when both header AND cached are absent
      // AND the customer ticked `bundled_llm_consent`. Soft-cap
      // enforcement against the monthly cap lands as sub-slice 6.5.
      //
      // If nothing resolves AND fallback is gated, throw
      // ByokAnthropicRequiredError so the customer sees the
      // problem-type that points them at PUT /byok-anthropic-key.
      // NEVER logged; the key plaintext is held in-memory only.
      // Normalise empty-string to undefined. A request with the
      // header present but empty (e.g. `x-byok-anthropic-api-key:`)
      // would otherwise:
      //   1. Skip the bundled-LLM fallback (`headerByokKey === ""` is
      //      not `=== undefined`, so the fallback branch is skipped).
      //   2. Pass `""` downstream to Anthropic, which 401s with a
      //      cryptic "invalid API key" error far from the cause.
      //   3. Mark the cost-tracking row as keySource='header' even
      //      though no real header value was provided.
      // Treating empty as absent is the only safe interpretation.
      const rawHeaderByokKey = req.headers['x-byok-anthropic-api-key'];
      const headerByokKey =
        typeof rawHeaderByokKey === 'string' && rawHeaderByokKey.length > 0
          ? rawHeaderByokKey
          : undefined;
      const cachedByokKey = byokKeyCache?.get(req.params.id);
      let bundledLlmKey: string | undefined;
      let bundledLlmConsentMissing = false;
      if (
        headerByokKey === undefined &&
        cachedByokKey === undefined &&
        bundledLlmService !== undefined &&
        deploymentFallbackKey !== undefined
      ) {
        const settings = await bundledLlmService.findSettings(ctx.account.id);
        if (settings !== null && !settings.consent) {
          // Arc 1 sub-slice 6.8 (v2-#6) — flag for the post-resolution
          // gate. Deployment HAS bundled-LLM, customer just hasn't
          // ticked consent yet. The route surfaces a typed 402 below
          // so the dashboard can render a precise CTA.
          bundledLlmConsentMissing = true;
          // Arc 4 Wave 2.B sub-slice 8.19 (v2-#8) — error counter.
          try {
            metrics?.inc(METRIC_NAMES.bundledLlmErrorTotal, { kind: 'consent_missing' });
          } catch {
            /* swallow */
          }
        }
        if (settings !== null && settings.consent) {
          // Arc 1 sub-slice 6.5 (v2-#6) — soft-cap pre-turn check.
          // Sum bundled-LLM spend in the current calendar month and
          // refuse the turn when it has reached the cap. The customer
          // recovers by raising the cap (PATCH /v1/account/me/bundled-llm-settings),
          // supplying a BYOK key (per-request header or stored), or
          // waiting for next calendar month.
          const now = new Date();
          const spent = await bundledLlmService.sumMonthlySpendCents({
            accountId: ctx.account.id,
            now,
          });
          if (spent >= settings.monthlyCapUsdCents) {
            // Arc 4 Wave 2.B sub-slice 8.19 (v2-#8) — error counter.
            try {
              metrics?.inc(METRIC_NAMES.bundledLlmErrorTotal, { kind: 'budget_exhausted' });
            } catch {
              /* swallow */
            }
            throw new BundledLlmBudgetExhaustedError({
              spentCents: spent,
              capCents: settings.monthlyCapUsdCents,
            });
          }
          bundledLlmKey = deploymentFallbackKey;
          // Arc 4 Wave 2.B sub-slice 8.19 (v2-#8) — request counter
          // fires when the bundled-LLM leg actually resolves a key
          // (consent + under cap). Distinct from the error counters
          // above so a single dashboard panel can ratio
          // ok / consent_missing / budget_exhausted.
          try {
            metrics?.inc(METRIC_NAMES.bundledLlmRequestTotal, { outcome: 'ok' });
          } catch {
            /* swallow */
          }
        }
      }
      const resolvedByokKey =
        headerByokKey ??
        cachedByokKey ??
        bundledLlmKey ??
        (allowFallbackForUnconfiguredCustomers === true ? deploymentFallbackKey : undefined);
      // Arc 1 sub-slice 6.4 (v2-#6) — derive the resolution leg so
      // AgentRuntime can write the right record_type. Order mirrors
      // the chain above; 'none' for the prod-default 502 path.
      const keySource: 'header' | 'cached' | 'bundled' | 'fallback' | 'none' =
        headerByokKey !== undefined
          ? 'header'
          : cachedByokKey !== undefined
            ? 'cached'
            : bundledLlmKey !== undefined
              ? 'bundled'
              : resolvedByokKey !== undefined
                ? 'fallback'
                : 'none';
      // Q.1 — the ByokAnthropicRequired 502 only fires when the
      // deployment is wired for Claude. Deterministic ignores keys
      // entirely (the decomposer never reads byokAnthropicApiKey)
      // so gating would surface a false alarm to customers whose
      // turn would have succeeded with a deterministic plan output.
      if (resolvedByokKey === undefined && agentDecomposerKind === 'claude') {
        // Arc 1 sub-slice 6.8 (v2-#6) — surface the typed consent-
        // required error when bundled-LLM is wired but the customer
        // hasn't opted in. Without this branch the customer would get
        // the generic ByokAnthropicRequired 502, which doesn't hint at
        // the simpler dashboard fix (flip consent).
        if (bundledLlmConsentMissing) {
          throw new BundledLlmConsentRequiredError();
        }
        throw new ByokAnthropicRequiredError(
          'No Anthropic API key configured for this account. ' +
            'PUT /v1/account/me/byok-anthropic-key to set a stored key, ' +
            'or supply x-byok-anthropic-api-key on the request header.',
        );
      }
      const result = await runtime.runTurn({
        agentSessionId: req.params.id,
        userMessage: parsed.data.user_message,
        ...(resolvedByokKey !== undefined ? { byokApiKey: resolvedByokKey } : {}),
        keySource,
      });
      if (result.kind === 'session-closed') {
        throw new ConflictError(
          `Agent session is ${result.session.status} (${result.reason}). Start a new agent session.`,
        );
      }
      // Q.1.c — if this turn closed the session (e.g. the runtime's
      // budget-exhausted close via closeWithReason), drop the cached BYOK
      // plaintext now. The runtime layer has no handle on this route-owned
      // cache, so without this the decrypted key would linger in process
      // memory until restart (the customer DELETE route is the only other
      // clear path). delete() is idempotent.
      if (result.session.status === 'closed') {
        byokKeyCache?.delete(req.params.id);
      }
      // Arc 2 sub-slice 8.6 (v2-#8) — manual-mode pass-through. No
      // decompose/executor ran; transcript carries one extra operator
      // entry. SDK consumers branch on kind:'logged-manual' to render
      // the human-driven log line distinctly from AI turns.
      if (result.kind === 'logged-manual') {
        return {
          kind: result.kind,
          session: publicAgentSession(result.session),
        };
      }
      // 2026-05-22 — V-666.AI cost telemetry per turn. The decomposer
      // already attaches a `usage` block (input/output tokens + cost
      // cents + model id) for Claude-backed runs; deterministic
      // decomposers leave it undefined. Surface the block on every
      // response shape so the customer-dashboard chat UI can render
      // a per-turn "$0.0023 · 145 tokens" badge. Undefined-safe: the
      // SDK + UI render '—' when usage is absent.
      function publicUsage(u: DecomposeUsage | undefined):
        | {
            decomposer_kind: 'claude' | 'deterministic';
            anthropic_input_tokens?: number;
            anthropic_output_tokens?: number;
            cost_usd_cents?: number;
            model?: string;
          }
        | undefined {
        if (!u) return undefined;
        return {
          decomposer_kind: u.decomposerKind,
          ...(u.anthropicInputTokens !== undefined
            ? { anthropic_input_tokens: u.anthropicInputTokens }
            : {}),
          ...(u.anthropicOutputTokens !== undefined
            ? { anthropic_output_tokens: u.anthropicOutputTokens }
            : {}),
          ...(u.costUsdCents !== undefined ? { cost_usd_cents: u.costUsdCents } : {}),
          ...(u.model !== undefined ? { model: u.model } : {}),
        };
      }

      if (result.kind === 'plan-executed') {
        // Narrow the decomposer to the plan variant — TS can't infer
        // it across the runTurn discriminant without a manual branch.
        const plan = result.decomposer;
        if (plan.kind !== 'plan') {
          throw new Error('runtime invariant: plan-executed without plan decomposer');
        }
        const usage = publicUsage(plan.usage);
        return {
          kind: result.kind,
          session: publicAgentSession(result.session),
          intents: plan.intents,
          results: result.executor.results,
          ok: result.executor.ok,
          ...(usage !== undefined ? { usage } : {}),
        };
      }
      if (result.kind === 'clarify') {
        const usage = publicUsage(result.decomposer.usage);
        return {
          kind: result.kind,
          session: publicAgentSession(result.session),
          clarifying_question: result.decomposer.clarifyingQuestion,
          ...(usage !== undefined ? { usage } : {}),
        };
      }
      // refuse
      const usage = publicUsage(result.decomposer.usage);
      return {
        kind: result.kind,
        session: publicAgentSession(result.session),
        refuse_reason: result.decomposer.refuseReason,
        ...(usage !== undefined ? { usage } : {}),
      };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/agent-sessions/:id',
    { preHandler: [app.requireAuth, app.requireScope('write'), app.rateLimit('global')] },
    async (req, reply) => {
      const ctx = requireCtx(req);
      const pre = await sessions.get(req.params.id);
      if (pre === null || pre.accountId !== ctx.account.id) {
        throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
      }
      await sessions.closeWithReason(req.params.id, 'customer-closed');
      // Free the harness slot for a profile/fleet-backed session: tell the node
      // to tear the session down. Best-effort + gated (inert when the fleet
      // control plane isn't wired); never blocks the close.
      await dispatchSessionEndOnClose({
        sessionId: req.params.id,
        fleetControlRegistry,
        fleetNodesRepo,
        logger: req.log,
      });
      // Q.1.c — clear the cached plaintext on customer close. The
      // delete is idempotent so concurrent budget-exhausted close
      // from the runtime is safe.
      byokKeyCache?.delete(req.params.id);
      // Slice 6 follow-up 2026-05-20 — agent-session destroy audit.
      // Best-effort emit. Reason 'customer-closed' captured at the
      // route-level (runtime-driven closures use their own audit
      // pathway at the budget/timeout sweepers).
      try {
        await accountAudit?.record({
          accountId: ctx.account.id,
          actorType: 'customer',
          action: 'agent_session.destroyed',
          targetResourceId: `agent_session_${req.params.id}`,
          payload: { agent_session_id: req.params.id, reason: 'customer-closed' },
          ipAddress: readClientIp(req),
        });
      } catch {
        /* swallow */
      }
      return reply.code(204).send();
    },
  );
}

// Disabled stubs — registered when agentRuntime is undefined in
// AppDeps. Same activation-gate pattern as billing / session-egress /
// saved-proxies. Surfaces 503 FeatureUnavailable on every method so
// SDK + dashboard get a machine-readable signal vs 404.
//
// The `detail` text is customer-facing — it lands in the problem+json
// body the SDK surfaces verbatim. Two self-serve options are surfaced
// here so a customer hitting this 503 from the SDK has the same
// recovery path the dashboard's feature-unavailable banner shows
// (apps/customer-dashboard/src/pages/agent-sessions.astro lines 35-53):
// BYOK Anthropic key OR opt-in to the deployment's bundled-LLM budget.
export function registerAgentSessionsDisabledRoutes(app: FastifyInstance): void {
  const detail =
    'AI chat agent is not yet enabled on this deployment. Two self-serve ' +
    'options activate this surface: bring your own Anthropic key ' +
    '(https://docs.driftstack.dev/api/byok-anthropic/), or opt into the ' +
    "deployment's bundled-LLM budget " +
    '(https://docs.driftstack.dev/api/bundled-llm/).';
  const stub = (): never => {
    throw new FeatureUnavailableError(detail);
  };
  app.post('/v1/agent-sessions', stub);
  // The list endpoint is gated too — the dashboard's "recent sessions"
  // call must surface the documented 503 activation message, not a bare
  // 404 (same rationale as the takeover/handback/mode stubs below).
  app.get('/v1/agent-sessions', stub);
  app.get('/v1/agent-sessions/:id', stub);
  app.post('/v1/agent-sessions/:id/message', stub);
  app.delete('/v1/agent-sessions/:id', stub);
  // Arc 2 sub-slice 8.9 (v2-#8) — pair-mode routes must also return
  // 503 FeatureUnavailable when the activation gate is off. Without
  // these the SDK + dashboard get a generic 404 + can't render the
  // "feature not enabled" message; the customer sees a confusing
  // "endpoint missing" error instead of the documented activation
  // state.
  app.post('/v1/agent-sessions/:id/takeover', stub);
  app.post('/v1/agent-sessions/:id/handback', stub);
  // Slice 3 (Wave 29-NNN ARC 3) — POST /:id/mode also gated.
  app.post('/v1/agent-sessions/:id/mode', stub);
  // Slice 4 (Wave 29-NNN ARC 3) — POST /:id/input-event also gated.
  app.post('/v1/agent-sessions/:id/input-event', stub);
}
