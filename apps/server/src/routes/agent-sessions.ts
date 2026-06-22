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

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AgentModelSchema,
  ConsequentialActionCategorySchema,
  SendInputEventRequestSchema,
  ResumeSessionRequestSchema,
  type AgentModel,
} from '@driftstack/api-types';
import type { AgentRuntime } from '../services/agent-runtime.js';
import { consequentialSignature } from '../services/agent-executor.js';
import type { DecomposeUsage } from '../services/agent-decomposer.js';
import type { AgentSessionRecord, AgentSessionsRepo } from '../services/agent-sessions.js';
import type { ProfilesService } from '../services/profiles.js';
import type { AccountProxiesService } from '../services/account-proxies.js';
import type { SessionRepo } from '../services/sessions.js';
import { buildAssignProfileBlock } from '../services/profile-store.js';
import type { R2 } from '../lib/r2.js';
import { parseProfileId } from '../lib/profile-id.js';
import { parseSessionId } from '../lib/session-id.js';
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
import {
  serializeSessionAssign,
  serializeSessionEnd,
  serializeResumeSession,
} from '../services/harness-control-codec.js';
import type { FleetControlRegistry } from '../services/fleet-control-registry.js';
import type { SessionPageStateStore } from '../services/session-page-state-store.js';
import type {
  SessionLivenessStore,
  SessionLivenessState,
} from '../services/session-liveness-store.js';
import type { SocksProxyConfig, InlineVpnProxyWire } from '@driftstack/api-types';
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
  ForbiddenError,
  NotFoundError,
  PairModeConflictError,
  PairModeStateInvalidTransitionRouteError,
  UnauthorizedError,
  ValidationError,
} from '../lib/errors.js';
import { resolveEffectiveAccount } from '../services/auth.js';
import { readEffectiveAccountHeader } from '../lib/effective-account-header.js';
import { readIdempotencyKey } from '../lib/idempotency-key.js';
import { isUniqueViolation } from '../lib/pg-error.js';
import { readClientIp } from '../lib/client-ip.js';

// gui_control_key control-auth (separate-simulator-app support). The
// stand-alone "Driftstack Simulator" macOS app can't read the main
// app's keychain, so it can't present an account API key. Instead it
// presents the per-session gui_control_key (auto-minted, AES-GCM at
// rest, 24h TTL) in the `x-driftstack-gui-control-key` header. The
// controlKeyAuthPreHandler below validates it against the SPECIFIC
// `:id` session BEFORE the normal requireAuth/requireScope chain and,
// on a match, marks the request control-authorized so the handler
// skips the account-ownership check for THAT session only. It grants
// NO account-wide access — only that one session's control/read. The
// header value is a secret; it is added to the logger + Sentry
// redaction lists.
const GUI_CONTROL_KEY_HEADER = 'x-driftstack-gui-control-key';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Set to `true` by {@link controlKeyOrAccountAuth} ONLY when a
     * valid (decrypt-matched, unexpired) gui_control_key for this
     * request's `:id` session was presented. When true, the route
     * handler skips the account-ownership check for that one session
     * (the key is cryptographically bound to it). Never grants any
     * cross-session or account-wide access. Defaults to `false`.
     */
    guiControlKeyAuthorized?: boolean;
    /**
     * The session's OWNING account id, stashed on the control-key
     * auth path (where `request.account` is absent). The rate-limit
     * middleware charges this account's bucket (at the conservative
     * `free`-tier floor) so a per-session control key can't bypass
     * rate limiting. Unset on the normal account path (rate-limit
     * uses `request.account` there). Never used for authorization.
     */
    guiControlKeyRateLimitAccountId?: string;
  }
}

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
  // Profile-backed sessions (file 57): attach a saved profile so the harness
  // restores/persists its encrypted store. Accepts the canonical `prof_<uuid>`
  // id the API returns OR a bare uuid (parseProfileId normalizes + 400s on bad);
  // validated to be an owned profile before dispatch; its DEK rides the
  // SessionAssign.profile block.
  profile_id: z.string().optional(),
  // ARC A — per-session customer proxy. When supplied, the dispatched session
  // browses through this account proxy instead of the operator default.
  // Validated to be an owned proxy before dispatch; a cross-account/unknown id
  // returns 404 (never confirm another account's proxy exists). Bare uuid (the
  // id the proxies API returns). Optional → operator-default egress (unchanged).
  proxy_id: z.string().uuid().optional(),
});

const RunTurnRequestSchema = z.object({
  user_message: z.string().min(1).max(8000),
  // W443/W445 — consequential actions the customer approves for this turn. The
  // client echoes back the {category, matched_text} from a prior
  // confirmation_required result; the route maps them to signatures so the
  // executor dispatches the (re-planned) action instead of halting again.
  approve_consequential_actions: z
    .array(
      z
        .object({
          category: ConsequentialActionCategorySchema,
          matched_text: z.string().min(1).max(200),
        })
        .strict(),
    )
    .max(20)
    .optional(),
});

// Slice 3 (Wave 29-NNN ARC 3) — POST /v1/agent-sessions/:id/mode body.
const SetModeRequestSchema = z.object({
  mode: z.enum(['manual', 'ai', 'pair']),
});

function requireCtx(request: FastifyRequest): NonNullable<FastifyRequest['account']> {
  if (!request.account) throw new Error('account context missing after requireAuth');
  return request.account;
}

/**
 * True when the caller (account context `ctx`) may act on an agent session owned
 * by `ownerAccountId`: they ARE that account (self), OR are an ADMIN team-member
 * of it. `ctx.teams` is resolved server-side by requireAuth from the DB, so the
 * X-Driftstack-Account header (which the GUI/SDK/dashboard send for workspace
 * switching) can't forge membership. This lets a team admin read/control/delete
 * the sessions they launched on the team owner — mirroring the create handler's
 * team-RBAC (resolveEffectiveAccount, which gates launch to admins). Non-admin
 * members + unrelated accounts get false → the route's existing 404 (audit
 * wxzlp9yiz #4: a team admin who launched on an owner was locked out of every
 * session-scoped route because they all compared against ctx.account.id only).
 * Purely additive: self is the unchanged fast path; nothing widens for non-admins.
 */
export function callerCanAccessAgentSession(
  ctx: NonNullable<FastifyRequest['account']>,
  ownerAccountId: string,
): boolean {
  if (ownerAccountId === ctx.account.id) return true;
  const membership = ctx.teams.find((t) => t.ownerAccountId === ownerAccountId);
  return membership !== undefined && membership.role === 'admin';
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
  // A2 W2679 — worker-reported per-session liveness, re-based onto
  // Heartbeat.activeSessionStates (NOT the server `status` lifecycle,
  // which stays 'active' until DELETE/sweep even if the worker crashed).
  // `state` is the latest worker state; `fresh` is whether the owning
  // node's beat is recent enough to trust (staleness guard). OMITTED
  // (field absent) when the liveness store isn't wired (prod has no fleet
  // control plane) OR no beat has reported this session yet — meaning
  // "unknown → trust the binding", NEVER "dead". `state: null` is the
  // explicit "store wired, session seen, but worker reports no live
  // state" signal. Optional so older SDKs ignore it.
  liveness?: { state: SessionLivenessState | null; fresh: boolean };
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

/**
 * A2 W2679 — compute the optional `liveness` field for a session from the
 * worker-liveness store. Returns undefined (= "unknown, trust the binding")
 * when the store isn't wired (prod has no fleet control plane) OR no beat has
 * reported this session yet — NEVER a "dead" default. When the session IS in
 * the store, surface the worker state + whether the owning node's beat is fresh
 * (a stale entry returns state with fresh:false so the GUI can de-trust it).
 */
function sessionLiveness(
  rec: AgentSessionRecord,
  store?: SessionLivenessStore,
): PublicAgentSession['liveness'] {
  if (store === undefined) return undefined;
  const entry = store.get(rec.id);
  if (entry === null) return undefined;
  return { state: entry.state, fresh: store.isFresh(entry) };
}

function publicAgentSession(
  rec: AgentSessionRecord,
  livekit?: PublicLivekitInfo,
  livenessStore?: SessionLivenessStore,
): PublicAgentSession {
  const liveness = sessionLiveness(rec, livenessStore);
  const base: PublicAgentSession = {
    id: rec.id,
    account_id: rec.accountId,
    // Strict-FK: stored as a bare uuid; return the canonical ses_<uuid> form so
    // input + output use the same prefixed contract.
    driftstack_session_id:
      rec.driftstackSessionId !== null ? `ses_${rec.driftstackSessionId}` : null,
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
  if (livekit !== undefined) base.livekit = livekit;
  // Omit-when-unknown (field absent) so older SDKs + the prod no-fleet-CP path
  // are byte-identical; only set it when the store reported a live state.
  if (liveness !== undefined) base.liveness = liveness;
  return base;
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
   * W650/A3-W1254 — latest-pageState-per-agent-session store. When wired (with
   * the registry, behind FLEET_CONTROL_PLANE_ENABLED), GET /v1/agent-sessions/
   * :id/page-state serves the stored pageState; absent → the route returns null.
   */
  sessionPageStateStore?: SessionPageStateStore;
  /**
   * A2 W2679 — latest-worker-liveness-per-agent-session store. When wired (with
   * the registry, behind FLEET_CONTROL_PLANE_ENABLED), the agent-session read
   * shape's `liveness` field is populated from it; absent → the field is omitted
   * (= "unknown, trust the binding"; prod has no fleet control plane).
   */
  sessionLivenessStore?: SessionLivenessStore;
  /**
   * Local fleet-demo dispatch config: the archetype / behavior profile /
   * landing URL / SOCKS5 proxy the dispatched session browses with. Wired
   * (with the registry) only on the local demo stack. Absent → no dispatch.
   */
  sessionDispatch?: SessionDispatchConfig;
  /**
   * Profile-backed sessions (file 57). When wired + a create carries an owned
   * `profile_id`, the route validates ownership and the dispatch ships the
   * profile's DEK in SessionAssign.profile. Absent → profile_id is rejected as
   * unsupported (no profiles service to validate against).
   */
  profilesService?: ProfilesService;
  /**
   * ARC A — per-account customer proxies service. When wired + a create carries
   * a `proxy_id`, the route validates ownership and the dispatch resolves it
   * (owner-scoped unwrap + SSRF re-guard) into the inlineProxyConfig. Absent →
   * proxy_id is rejected as unsupported (no service to validate against).
   */
  accountProxiesService?: AccountProxiesService;
  /**
   * Strict-FK (2026-06-16) — driver SessionsRepo. When wired + a create carries
   * `driftstack_session_id`, the route validates the referenced session is owned
   * by the same (owner) account before storing the uuid, closing the latent
   * cross-account pointer gap. Absent → driftstack_session_id is rejected
   * (no repo to validate against), since the column is now a strict FK.
   */
  driverSessionsRepo?: SessionRepo;
  /**
   * Private R2 (sealed-profile-blob bucket). When wired alongside a profile-
   * backed create, the dispatch builds the full profile block via
   * buildAssignProfileBlock (restore GET when a blob exists + save-back PUT).
   * Absent → the dispatch falls back to a DEK-only block (no restore/persist).
   */
  r2?: R2;
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
  /** Private R2 — when present, the profile block carries restore/save-back URLs. */
  r2?: R2;
  // ARC A — per-session customer proxy. When a validated proxy_id rode the
  // create, the dispatch resolves it (owner-scoped unwrap + SSRF re-guard) and
  // injects it as the inlineProxyConfig instead of the operator default.
  proxyId?: string;
  accountProxiesService?: AccountProxiesService;
  // Worker-disconnect fix (2026-06-19, migration 0086) — when wired, the
  // dispatch persists session→node (agent_sessions.node_id) so the
  // worker-disconnect reaper can close THIS node's active sessions if the node
  // drops. The dispatch's `sessionId` IS the agent-session id (created.id).
  agentSessions?: AgentSessionsRepo;
  // Region-aware dispatch (2026-06-21) — the viewer's home region (`us|eu|apac`,
  // from the authed account). Selects the nearest livekit node so a multi-region
  // fleet (e.g. an EU box for EU customers) actually routes by proximity; falls
  // back to any node when the home region has none (single-region fleet / outage
  // → a far box still beats no box). Absent/null → region-blind any-node (today).
  accountRegion?: string | null;
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
    r2,
    proxyId,
    accountProxiesService,
    agentSessions,
    accountRegion,
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
    // Region-aware: prefer a livekit node in the viewer's home region, fall back
    // to any (single-region fleet → same as before). See findNearestWithLivekit.
    const mac = await fleetNodesRepo.findNearestWithLivekit(accountRegion);
    if (mac === null || mac.livekit === null) return;
    // The registry is keyed by the authed node_id (the JWT iss), NOT the
    // fleet_nodes uuid PK — so resolve the live connection by nodeId (migration
    // 0085 / Path C). Fall back to the uuid for any legacy uuid-keyed node.
    const conn = fleetControlRegistry.get(mac.nodeId ?? mac.id);
    if (conn === undefined) {
      logger?.info(
        { component: 'fleet-session-dispatch', sessionId, nodeId: mac.nodeId ?? mac.id },
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
    // Profile-backed (file 57): when a profile is attached + has a DEK, ship the
    // per-profile DEK so the harness can open/seal the encrypted store. With R2
    // wired, buildAssignProfileBlock adds the restore URL (presigned GET, ONLY
    // when a sealed blob already exists — fail-closed per A3) + the save-back PUT
    // URL. Without R2 → DEK-only (fresh, no restore/persist). getProfileDek is
    // null when the master key is unset or the profile has no DEK → stateless.
    let profile:
      | { profileId: string; dek: string; sealedBlobUrl?: string; sealedBlobPutUrl?: string }
      | undefined;
    // Fingerprint-correctness (2026-06-19) — a bound profile carries its OWN
    // archetype (chosen by the customer); the static sessionDispatch.archetype is
    // an operator-config default for stateless (no-profile) runs. The harness uses
    // the assign's archetype verbatim (A3 bus W2688), so resolving the profile's
    // archetype here is the whole fix — otherwise every profile-backed session
    // provisions the WRONG fingerprint. NULL stays undefined → static fallback.
    let profileArchetype: string | undefined;
    if (profileId !== undefined && accountId !== undefined && profilesService !== undefined) {
      try {
        const record = await profilesService.get({ id: profileId, accountId });
        profileArchetype = record.archetype;
      } catch (err) {
        // A profile-fetch failure must NOT abort the dispatch (which would leave
        // the session created-but-never-dispatched). Degrade to the static
        // archetype — the same best-effort pattern as the R2 url-mint block below.
        logger?.warn(
          { component: 'agent-session-dispatch', sessionId, profileId, err },
          'profile archetype lookup failed; dispatching with static archetype',
        );
      }
      const dek = await profilesService.getProfileDek({ profileId, accountId });
      if (dek !== null) {
        const dekBase64 = dek.toString('base64');
        if (r2 !== undefined) {
          try {
            profile = await buildAssignProfileBlock(r2, profileId, dekBase64);
          } catch (err) {
            // An R2 hiccup minting the restore/save-back URLs must NOT abort the
            // whole dispatch (which would leave the session created-but-never-
            // dispatched). Degrade to a DEK-only (stateless) assign so the
            // session still runs; it just won't restore/persist profile state
            // this run. Distinct from the outer best-effort catch, which would
            // drop the dispatch entirely.
            logger?.warn(
              { component: 'agent-session-dispatch', sessionId, profileId, err },
              'profile R2 url-mint failed; dispatching DEK-only (stateless this run)',
            );
            profile = { profileId, dek: dekBase64 };
          }
        } else {
          profile = { profileId, dek: dekBase64 };
        }
      }
    }
    // ARC A — when the create carried a validated proxy_id, dispatch through the
    // customer's proxy (owner-scoped unwrap + SSRF re-guard) instead of the
    // operator default. resolveForDispatch throws UnsafeProxyHostError on an
    // internal-reachable host → caught by the outer best-effort wrapper, which
    // skips the dispatch (fail-closed: never run through an unsafe proxy).
    // socks5 operator default OR the customer's resolved socks5/VPN config (the
    // latter is the FLAT VPN wire for openvpn/wireguard — A3 W2163).
    let inlineProxyConfig: SocksProxyConfig | InlineVpnProxyWire = sessionDispatch.proxy;
    if (proxyId !== undefined && accountId !== undefined && accountProxiesService !== undefined) {
      const resolved = await accountProxiesService.resolveForDispatch({ proxyId, accountId });
      if (resolved !== null) inlineProxyConfig = resolved;
    }
    const assign = serializeSessionAssign({
      sessionId,
      archetype: profileArchetype ?? sessionDispatch.archetype,
      behaviorProfile: sessionDispatch.behaviorProfile,
      initialUrl: sessionDispatch.initialUrl,
      inlineProxyConfig,
      livekit: {
        room: sessionId,
        token,
        wsUrl: mac.livekit.wsUrl,
        expiresAt: new Date(nowMs + ttlSeconds * 1000).toISOString(),
      },
      ...(profile !== undefined ? { profile } : {}),
    });
    conn.sendSessionAssign(assign);
    const dispatchedNodeId = mac.nodeId ?? mac.id;
    // Worker-disconnect fix (2026-06-19) — persist session→node so the
    // disconnect reaper can close THIS node's active sessions when it drops.
    // The registry key is what the reaper sees on unregister, so we store the
    // SAME value the dispatch resolved the connection by. Best-effort: a write
    // failure must not break the dispatch (the 12h orphan_reap is still the
    // backstop), so swallow + log. setNodeId returns null for an id that lost a
    // race with DELETE — harmless, nothing to reap then.
    if (agentSessions !== undefined) {
      try {
        await agentSessions.setNodeId(sessionId, dispatchedNodeId);
      } catch (err) {
        logger?.warn(
          {
            component: 'fleet-session-dispatch',
            sessionId,
            nodeId: dispatchedNodeId,
            err: err instanceof Error ? err.message : String(err),
          },
          'persisting session node_id failed (dispatch unaffected; 12h orphan_reap backstop holds)',
        );
      }
    }
    logger?.info(
      { component: 'fleet-session-dispatch', sessionId, nodeId: dispatchedNodeId },
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
    // The registry is keyed by the authed node_id (the JWT iss), NOT the
    // fleet_nodes uuid PK — so resolve the live connection by nodeId (migration
    // 0085 / Path C). Fall back to the uuid for any legacy uuid-keyed node.
    const conn = fleetControlRegistry.get(mac.nodeId ?? mac.id);
    if (conn === undefined) return; // node not connected → nothing to tear down server-side
    conn.sendSessionEnd(serializeSessionEnd(sessionId));
    logger?.info(
      { component: 'fleet-session-dispatch', sessionId, nodeId: mac.nodeId ?? mac.id },
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

/**
 * W393 — best-effort `resumeSession` dispatch when the customer resumes a
 * challenge-paused session. Same gating/best-effort contract as
 * dispatchSessionEndOnClose: inert unless the fleet control plane is wired,
 * never throws (a dispatch hiccup must not 500 the route). v0 single-node via
 * findAnyWithLivekit; the harness validates challengeId against the active
 * challenge and ignores a resume for a session it doesn't hold (harmless no-op).
 */
export async function dispatchResumeSession(args: {
  sessionId: string;
  challengeId?: string;
  fleetControlRegistry: FleetControlRegistry | undefined;
  fleetNodesRepo: DrizzleFleetNodesRepo | undefined;
  logger?: {
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
  };
}): Promise<void> {
  const { sessionId, challengeId, fleetControlRegistry, fleetNodesRepo, logger } = args;
  if (fleetControlRegistry === undefined || fleetNodesRepo === undefined) return;
  try {
    const mac = await fleetNodesRepo.findAnyWithLivekit();
    if (mac === null) return;
    // The registry is keyed by the authed node_id (the JWT iss), NOT the
    // fleet_nodes uuid PK — so resolve the live connection by nodeId (migration
    // 0085 / Path C). Fall back to the uuid for any legacy uuid-keyed node.
    const conn = fleetControlRegistry.get(mac.nodeId ?? mac.id);
    if (conn === undefined) return; // node not connected → nothing to resume server-side
    conn.sendResumeSession(
      serializeResumeSession({
        sessionId,
        ...(challengeId !== undefined ? { challengeId } : {}),
      }),
    );
    logger?.info(
      { component: 'fleet-session-dispatch', sessionId, nodeId: mac.id, challengeId },
      'dispatched resumeSession to fleet node',
    );
  } catch (err) {
    logger?.warn(
      {
        component: 'fleet-session-dispatch',
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      },
      'resumeSession dispatch failed',
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
    sessionPageStateStore,
    sessionLivenessStore,
    sessionDispatch,
    profilesService,
    accountProxiesService,
    driverSessionsRepo,
    r2,
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
    region: string | null,
  ): Promise<PublicLivekitInfo | undefined> {
    if (fleetNodesRepo === undefined || livekitSecretEncryptionKey === undefined) {
      return undefined;
    }
    try {
      // Region-aware + CONSISTENT WITH THE PUBLISHER DISPATCH: the SFU is
      // co-located on the box, so the viewer MUST connect to the same node the
      // harness publishes to. dispatchSessionAssignOnCreate uses
      // findNearestWithLivekit(region); the viewer token must resolve the same
      // node or (with a multi-region fleet) it'd join a different box's SFU and
      // see no track. Same region → same node (or same fallback). Single box →
      // findNearest falls back to findAny, so today's behavior is unchanged.
      const mac = await fleetNodesRepo.findNearestWithLivekit(region);
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
          // Subscriber for TRACKS, but publishes DATA: the simulator's
          // input-capture sends InputEvents over the DataChannel to the Mac.
          // Explicit canPublishData:true (not LiveKit's default); canPublish
          // stays false (no customer-injected video track).
          canPublish: false,
          canSubscribe: true,
          canPublishData: true,
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

  /**
   * Validate the gui_control_key header against the `:id` session.
   * Returns `true` ONLY when the header is present AND decrypts to a
   * value byte-equal to the header (TIMING-SAFE compare) AND the
   * stored key has not expired. Returns `false` when no header is
   * present (the caller should fall through to account auth). Throws
   * UnauthorizedError (401) when a header IS present but does NOT
   * validate — a present-but-wrong/expired key must NOT silently fall
   * through to the account path.
   *
   * The key is cryptographically bound to ONE session's stored
   * ciphertext, so a key minted for session A can never validate
   * against session B: B's ciphertext decrypts to B's plaintext, which
   * never equals A's header. Equal-length-buffer + timingSafeEqual
   * avoids a length/early-return side channel.
   */
  async function validateControlKey(
    req: FastifyRequest,
    sessionId: string,
  ): Promise<{ authorized: false } | { authorized: true; ownerAccountId: string }> {
    const headerRaw = req.headers[GUI_CONTROL_KEY_HEADER];
    const header = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
    if (header === undefined || header.length === 0) {
      // No control key offered → account-auth path decides.
      return { authorized: false };
    }
    // A control key was presented; from here every failure is a hard
    // 401 (never a fallthrough to account data).
    if (guiControlKeyEncryptionKey === undefined) {
      // Control-key auth isn't enabled on this deployment.
      throw new UnauthorizedError('gui_control_key auth is not enabled on this deployment.');
    }
    const rec = await sessions.get(sessionId);
    if (
      rec === null ||
      rec.guiControlKeyCiphertext === null ||
      rec.guiControlKeyExpiresAt === null ||
      rec.guiControlKeyExpiresAt.getTime() <= Date.now()
    ) {
      // Unknown session, never-minted key, or expired → reject. Never
      // confirm whether the session exists for another account.
      throw new UnauthorizedError('gui_control_key is missing, expired, or invalid.');
    }
    let expected: string;
    try {
      expected = decryptGuiControlKey(rec.guiControlKeyCiphertext, guiControlKeyEncryptionKey);
    } catch {
      // Ciphertext that won't decrypt (key rotation / corruption) is
      // treated as no valid key — reject, don't 500.
      throw new UnauthorizedError('gui_control_key is missing, expired, or invalid.');
    }
    const presented = Buffer.from(header, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    // timingSafeEqual requires equal-length buffers; the length check
    // short-circuits before the constant-time compare. The plaintext
    // format is fixed-length (`gck_` + 32 base32 chars), so a correct
    // key always matches length; differing lengths are always wrong.
    if (presented.length !== expectedBuf.length || !timingSafeEqual(presented, expectedBuf)) {
      throw new UnauthorizedError('gui_control_key is missing, expired, or invalid.');
    }
    return { authorized: true, ownerAccountId: rec.accountId };
  }

  /**
   * preHandler factory for the session-scoped CONTROL endpoints
   * (mode read/set, input-event, takeover, handback). Authorizes via
   * EITHER (a) the normal account path (requireAuth + requireScope)
   * OR (b) a valid per-session gui_control_key. When the control key
   * validates, requireAuth/requireScope are SKIPPED and the request is
   * marked `guiControlKeyAuthorized` so the handler skips the
   * account-ownership check for THAT session only. `rateLimit` is kept
   * on every route's preHandler chain (not here).
   */
  function controlKeyOrAccountAuth(
    requiredScope: 'read' | 'write',
  ): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const sessionId = (req.params as { id?: string }).id ?? '';
      // validateControlKey throws 401 on a present-but-invalid key, so
      // a control-key caller can never silently fall through to the
      // account path with attacker-controlled input.
      const result = await validateControlKey(req, sessionId);
      if (result.authorized) {
        req.guiControlKeyAuthorized = true;
        // The rate-limit middleware that follows in the preHandler
        // chain keys off `request.account`, which is absent here.
        // Stash the owning account so it charges that account's
        // bucket (conservative `free`-tier floor) instead of 401ing.
        req.guiControlKeyRateLimitAccountId = result.ownerAccountId;
        return;
      }
      // No control key → normal account auth chain.
      await app.requireAuth(req, reply);
      await app.requireScope(requiredScope)(req, reply);
    };
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
      // Team RBAC (2026-06-16) — mirrors the proven driver pattern in
      // sessions.ts (V-326e3): an ADMIN team member may launch the team
      // owner's profile. The entire create then scopes to the OWNER's account
      // (profile validation, per-profile DEK, session ownership, idempotency,
      // BYOK key, LiveKit identity) so the run counts against the owner and
      // reads the owner's encrypted store — exactly as if the owner created it.
      // Non-admin members are refused (read-only on a team workspace). Self
      // (no X-Driftstack-Account header) resolves ownerAccountId = ctx.account.id,
      // so the existing self-scoped behaviour is unchanged.
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(req));
      if (effective.kind === 'team' && effective.role !== 'admin') {
        throw new ForbiddenError(
          'Launching an agent session on a team owner requires admin role on that team.',
        );
      }
      const ownerAccountId = effective.accountId;
      // Profile-backed (file 57): a supplied profile_id MUST reference an owned
      // profile — validate before create/dispatch so an unknown/foreign id is a
      // clean 404, not a silent best-effort skip in the dispatch. (404 also when
      // profiles aren't wired; the customer can't distinguish, which is fine.)
      // parseProfileId accepts the canonical prof_<uuid> OR a bare uuid (400 on
      // bad) and yields the bare uuid used internally (DEK lookup + R2 keys).
      let profileBareId: string | undefined;
      if (parsed.data.profile_id !== undefined) {
        profileBareId = parseProfileId(parsed.data.profile_id);
        if (profilesService === undefined) {
          throw new NotFoundError(`Profile ${parsed.data.profile_id} not found.`);
        }
        await profilesService.get({ id: profileBareId, accountId: ownerAccountId });
      }

      // ARC A — a supplied proxy_id MUST reference an owned proxy; validate
      // before dispatch so an unknown/foreign id is a clean 404 (never confirm
      // another account's proxy exists), owner-scoped exactly like profile_id.
      let proxyId: string | undefined;
      if (parsed.data.proxy_id !== undefined) {
        proxyId = parsed.data.proxy_id;
        if (accountProxiesService === undefined) {
          throw new NotFoundError(`Proxy ${proxyId} not found.`);
        }
        const owned = await accountProxiesService.findOwned(proxyId, ownerAccountId);
        if (owned === null) {
          throw new NotFoundError(`Proxy ${proxyId} not found.`);
        }
      }

      // Strict-FK (2026-06-16) — normalize the optional driftstack_session_id
      // (ses_<uuid> | <uuid>) to the bare uuid + verify the referenced session
      // is owned by the (owner) account before storing. The column is now a FK;
      // a dangling or cross-account pointer must be rejected, not persisted.
      let driftstackSessionUuid: string | undefined;
      if (parsed.data.driftstack_session_id !== undefined) {
        driftstackSessionUuid = parseSessionId(parsed.data.driftstack_session_id);
        if (driverSessionsRepo === undefined) {
          throw new NotFoundError(`Session ${parsed.data.driftstack_session_id} not found.`);
        }
        const ref = await driverSessionsRepo.findSession(driftstackSessionUuid, ownerAccountId);
        if (ref === null) {
          // 404 (not 403) — never confirm another account's session exists.
          throw new NotFoundError(`Session ${parsed.data.driftstack_session_id} not found.`);
        }
      }

      const idempotencyKey = idempotency.kind === 'valid' ? idempotency.key : null;
      if (idempotencyKey !== null) {
        const existing = await sessions.findByIdempotencyKey(ownerAccountId, idempotencyKey);
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
              accountId: ownerAccountId,
              now: new Date(),
            });
            if (stored !== null) byokKeyCache.set(existing.id, stored);
          }
          const livekit = await maybeMintLivekit(existing.id, ownerAccountId, ctx.account.region);
          return reply.code(201).send(publicAgentSession(existing, livekit, sessionLivenessStore));
        }
      }
      let created: AgentSessionRecord;
      try {
        created = await sessions.create({
          accountId: ownerAccountId,
          tokenBudgetTotal: parsed.data.token_budget ?? DEFAULT_TOKEN_BUDGET,
          ...(driftstackSessionUuid !== undefined
            ? { driftstackSessionId: driftstackSessionUuid }
            : {}),
          ...(idempotencyKey !== null ? { idempotencyKey } : {}),
          // Arc 2 sub-slice 8.5 (v2-#8) — forward mode when supplied;
          // otherwise repo applies the default ('ai').
          ...(parsed.data.mode !== undefined ? { mode: parsed.data.mode } : {}),
          // 6.c / #15 — forward the picked model when supplied; otherwise
          // repo applies the default ('claude-opus-4-8').
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
          const winner = await sessions.findByIdempotencyKey(ownerAccountId, idempotencyKey);
          if (winner !== null) {
            if (byokService !== undefined && byokKeyCache !== undefined) {
              const stored = await byokService.getPlaintext({
                accountId: ownerAccountId,
                now: new Date(),
              });
              if (stored !== null) byokKeyCache.set(winner.id, stored);
            }
            const livekit = await maybeMintLivekit(winner.id, ownerAccountId, ctx.account.region);
            return reply.code(201).send(publicAgentSession(winner, livekit, sessionLivenessStore));
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
          accountId: ownerAccountId,
          now: new Date(),
        });
        if (stored !== null) {
          byokKeyCache.set(created.id, stored);
        }
      }
      const livekit = await maybeMintLivekit(created.id, ownerAccountId, ctx.account.region);
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
        // Profile-backed (file 57): thread the validated profile_id so the
        // dispatch ships its DEK in SessionAssign.profile. Owner-scoped so an
        // admin team-launch ships the OWNER's profile DEK (the profile + its
        // encrypted store live under the owner's account).
        accountId: ownerAccountId,
        ...(profileBareId !== undefined ? { profileId: profileBareId } : {}),
        profilesService,
        // ARC A — thread the validated proxy_id + service so the dispatch
        // resolves the customer proxy (owner-scoped) into the inlineProxyConfig.
        ...(proxyId !== undefined ? { proxyId } : {}),
        ...(accountProxiesService !== undefined ? { accountProxiesService } : {}),
        ...(r2 !== undefined ? { r2 } : {}),
        // Worker-disconnect fix (2026-06-19) — persist session→node so the
        // disconnect reaper can free this node's slot if the node drops.
        agentSessions: sessions,
        // Region-aware dispatch (2026-06-21) — the viewer's home region so the
        // session routes to the nearest livekit node (EU box for EU customers);
        // falls back to any node when the home region has none.
        accountRegion: ctx.account.region,
      });
      // Slice 6 follow-up 2026-05-20 — agent-session create audit. Best-
      // effort emit; audit failures don't break the create. Distinct
      // action from session.created (which audits the underlying driver
      // session at the regular /v1/sessions surface).
      try {
        await accountAudit?.record({
          // Owner-scoped: the session lives under the owner's account, so the
          // create lands in the OWNER's audit log (an admin team-launch shows
          // up where the session actually is).
          accountId: ownerAccountId,
          actorType: 'customer',
          action: 'agent_session.created',
          targetResourceId: `agent_session_${created.id}`,
          payload: { agent_session_id: created.id, initial_mode: created.mode },
          ipAddress: readClientIp(req),
        });
      } catch {
        /* swallow */
      }
      return reply.code(201).send(publicAgentSession(created, livekit, sessionLivenessStore));
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
        data: sorted
          .slice(0, 100)
          .map((rec) => publicAgentSession(rec, undefined, sessionLivenessStore)),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/agent-sessions/:id',
    // Control-auth path (b): a valid per-session gui_control_key reads
    // ONLY this `:id` session (the route is already `/:id`-scoped). The
    // 'read' scope is the floor for the account path here.
    { preHandler: [controlKeyOrAccountAuth('read'), app.rateLimit('global')] },
    async (req) => {
      const rec = await sessions.get(req.params.id);
      if (rec === null) {
        throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
      }
      // Account path: enforce ownership. Control-key path: the key was
      // already decrypt-matched against THIS session in the preHandler,
      // so it is authorized for this one session and skips the
      // account-ownership check (it never sees any other session).
      if (req.guiControlKeyAuthorized !== true) {
        const ctx = requireCtx(req);
        if (!callerCanAccessAgentSession(ctx, rec.accountId)) {
          throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
        }
      }
      return publicAgentSession(rec, undefined, sessionLivenessStore);
    },
  );

  // W650/A3-W1254 — page-state for the AGENT/simulator view. The harness emits
  // HarnessOutbound.pageState (loading→loaded|errored) keyed by the AGENT
  // session id on every agent-initiated navigate; this serves the latest so the
  // GUI loading-bar/error-overlay can poll the agent session it drives. (The
  // existing GET /v1/sessions/:id/state.page_state is the DRIVER session, a
  // different type the harness never emits pageState for.) Same owned-check as
  // GET /:id; returns null when the store isn't wired (no fleet control plane)
  // or nothing has been reported yet.
  app.get<{ Params: { id: string } }>(
    '/v1/agent-sessions/:id/page-state',
    // Control-auth path (b): the SEPARATE Simulator app has no account Bearer key,
    // only a per-session gui_control_key — so this MUST accept it like GET /:id
    // (was app.requireAuth → every poll from the standalone Simulator 401'd → the
    // live URL never appeared). 'read' is the floor for the account path.
    { preHandler: [controlKeyOrAccountAuth('read'), app.rateLimit('global')] },
    async (req) => {
      const rec = await sessions.get(req.params.id);
      if (rec === null) {
        throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
      }
      // Account path: enforce ownership. Control-key path: the key was already
      // decrypt-matched against THIS `:id` session in the preHandler, so it skips
      // the account-ownership check (same as GET /:id).
      if (req.guiControlKeyAuthorized !== true) {
        const ctx = requireCtx(req);
        if (!callerCanAccessAgentSession(ctx, rec.accountId)) {
          throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
        }
      }
      return { page_state: sessionPageStateStore?.get(req.params.id) ?? null };
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
        if (session === null || !callerCanAccessAgentSession(ctx, session.accountId)) {
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
        // W383 — backpressure guard. A stalled client (TCP window full) would
        // otherwise let live transcript events buffer unboundedly in the socket
        // (reply.raw.writableLength grows without bound → server OOM). Past a
        // generous high-water mark we close the stream; the client's EventSource
        // auto-reconnects with Last-Event-ID and the replay loop above resumes
        // it, so no transcript entry is lost. A healthy client drains
        // immediately (writableLength ≈ 0) and never trips this.
        const MAX_SSE_BUFFER_BYTES = 4_000_000;
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
          if (reply.raw.writableLength > MAX_SSE_BUFFER_BYTES) cleanup();
        });
        const heartbeat = setInterval(() => {
          reply.raw.write(`: heartbeat ${new Date().toISOString()}\n\n`);
        }, transcriptHeartbeatMs);
        heartbeat.unref();

        let closed = false;
        const cleanup = (): void => {
          // Idempotent — invoked from the backpressure guard above AND the
          // close/error handlers below; double-end() / double-unsubscribe is
          // avoided so the paths can't race.
          if (closed) return;
          closed = true;
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
      // requireScope('write'): the returned gui_control_key is a CONTROL credential —
      // via the control-key path it authorizes mode/input/takeover/handback AND
      // DELETE (all of which skip requireScope on the control-key branch). Handing it
      // out is write-equivalent, so a read-only key must NOT be able to fetch it and
      // escalate to full write+destroy (audit wxzlp9yiz P1 auth-bypass).
      { preHandler: [app.requireAuth, app.requireScope('write'), app.rateLimit('global')] },
      async (req) => {
        const ctx = requireCtx(req);
        const rec = await sessions.get(req.params.id);
        if (rec === null || !callerCanAccessAgentSession(ctx, rec.accountId)) {
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
        // Control-auth path (b): the separate simulator app forwards
        // taps/keystrokes with the per-session gui_control_key. 'write'
        // is the account-path scope floor.
        controlKeyOrAccountAuth('write'),
        // Dedicated bucket — separate from the generic 'global' so
        // a customer's 120Hz input stream doesn't burn through their
        // generic-API quota. Tier-derived burst when B3 ships; today
        // every account shares the static cap defined in
        // TIER_RATE_LIMIT_DEFAULTS.
        app.rateLimit('agent_sessions:input_event'),
      ],
    },
    async (req, reply) => {
      const parsed = SendInputEventRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      const rec = await sessions.get(req.params.id);
      if (rec === null) {
        throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
      }
      if (req.guiControlKeyAuthorized !== true) {
        const ctx = requireCtx(req);
        if (!callerCanAccessAgentSession(ctx, rec.accountId)) {
          throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
        }
      }
      // Audit / breadcrumb attribution: the session's owning account.
      // Identical to ctx.account.id on the account path, and the only
      // meaningful account on the control-key path (which has no
      // request-account context).
      const auditAccountId = rec.accountId;
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
                account_id: auditAccountId,
                event_type: parsed.data.event.type,
                from: currentState.kind,
                to: nextState.kind,
                actor: parsed.data.client_id,
              },
            });
            try {
              await accountAudit?.record({
                accountId: auditAccountId,
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
    // Control-auth path (b): the separate simulator app's mode toggle
    // (ai / manual / pair) presents the per-session gui_control_key.
    { preHandler: [controlKeyOrAccountAuth('write'), app.rateLimit('global')] },
    async (req) => {
      const parsed = SetModeRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      const rec = await sessions.get(req.params.id);
      if (rec === null) {
        throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
      }
      if (req.guiControlKeyAuthorized !== true) {
        const ctx = requireCtx(req);
        if (!callerCanAccessAgentSession(ctx, rec.accountId)) {
          throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
        }
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
        return publicAgentSession(rec, undefined, sessionLivenessStore);
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
          accountId: rec.accountId,
          actorType: 'customer',
          action: 'agent_session.mode.changed',
          targetResourceId: `agent_session_${req.params.id}`,
          payload: { from: rec.mode, to: target },
          ipAddress: readClientIp(req),
        });
      } catch {
        /* swallow */
      }
      return publicAgentSession(updated, undefined, sessionLivenessStore);
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
      // Control-auth path (b): the separate simulator app's "grab
      // control" button presents the per-session gui_control_key.
      { preHandler: [controlKeyOrAccountAuth('write'), app.rateLimit('global')] },
      async (req, reply) => {
        const parsed = TakeoverBodySchema.safeParse(req.body);
        if (!parsed.success) throw new ValidationError(parsed.error.flatten());
        const rec = await sessions.get(req.params.id);
        if (rec === null) {
          throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
        }
        if (req.guiControlKeyAuthorized !== true) {
          const ctx = requireCtx(req);
          if (!callerCanAccessAgentSession(ctx, rec.accountId)) {
            throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
          }
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
              account_id: rec.accountId,
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
              accountId: rec.accountId,
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
      // Control-auth path (b): the separate simulator app's "return
      // control to agent" button presents the per-session gui_control_key.
      { preHandler: [controlKeyOrAccountAuth('write'), app.rateLimit('global')] },
      async (req, reply) => {
        const rec = await sessions.get(req.params.id);
        if (rec === null) {
          throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
        }
        if (req.guiControlKeyAuthorized !== true) {
          const ctx = requireCtx(req);
          if (!callerCanAccessAgentSession(ctx, rec.accountId)) {
            throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
          }
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
              account_id: rec.accountId,
              mode: rec.mode,
              from: currentState.kind,
              to: nextState.kind,
            },
          });
          try {
            await accountAudit?.record({
              accountId: rec.accountId,
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
        // Control-auth path (b): the separate simulator app's "tell the
        // agent" composer presents the per-session gui_control_key.
        // 'write' is the account-path scope floor.
        controlKeyOrAccountAuth('write'),
        app.rateLimit('agent_sessions:message'),
      ],
    },
    async (req) => {
      const parsed = RunTurnRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      // Cross-account guard before runtime.runTurn — the runtime
      // throws on unknown ids, but we want 403/404 distinction over
      // "not found" generic.
      const pre = await sessions.get(req.params.id);
      if (pre === null) {
        throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
      }
      if (req.guiControlKeyAuthorized !== true) {
        const ctx = requireCtx(req);
        if (!callerCanAccessAgentSession(ctx, pre.accountId)) {
          throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
        }
      }
      // Account attribution for the BYOK / bundled-LLM resolution chain
      // and cost telemetry: the session's owning account. Identical to
      // ctx.account.id on the account path, and the only meaningful
      // account on the control-key path (which has no request-account
      // context — validateControlKey resolves it from the session row).
      const turnAccountId = pre.accountId;
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
        const settings = await bundledLlmService.findSettings(turnAccountId);
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
            accountId: turnAccountId,
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
      // W443/W445 — map approved {category, matched_text} pairs to executor
      // signatures so a re-planned consequential action dispatches instead of
      // re-halting for confirmation.
      const approvedConsequentialActions =
        parsed.data.approve_consequential_actions !== undefined
          ? new Set(
              parsed.data.approve_consequential_actions.map((a) =>
                consequentialSignature(a.category, a.matched_text),
              ),
            )
          : undefined;
      const result = await runtime.runTurn({
        agentSessionId: req.params.id,
        userMessage: parsed.data.user_message,
        ...(resolvedByokKey !== undefined ? { byokApiKey: resolvedByokKey } : {}),
        ...(approvedConsequentialActions !== undefined ? { approvedConsequentialActions } : {}),
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
          session: publicAgentSession(result.session, undefined, sessionLivenessStore),
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
          session: publicAgentSession(result.session, undefined, sessionLivenessStore),
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
          session: publicAgentSession(result.session, undefined, sessionLivenessStore),
          clarifying_question: result.decomposer.clarifyingQuestion,
          ...(usage !== undefined ? { usage } : {}),
        };
      }
      // refuse
      const usage = publicUsage(result.decomposer.usage);
      return {
        kind: result.kind,
        session: publicAgentSession(result.session, undefined, sessionLivenessStore),
        refuse_reason: result.decomposer.refuseReason,
        ...(usage !== undefined ? { usage } : {}),
      };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/agent-sessions/:id',
    // Control-auth path (b): the separate simulator app's window-close
    // ends the session with the per-session gui_control_key. The key is
    // cryptographically bound to THIS :id (validateControlKey), so a
    // control-key caller can only ever DELETE the one session its key
    // is bound to — never another account's session. 'write' is the
    // account-path scope floor (destructive op).
    { preHandler: [controlKeyOrAccountAuth('write'), app.rateLimit('global')] },
    async (req, reply) => {
      const pre = await sessions.get(req.params.id);
      if (pre === null) {
        throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
      }
      if (req.guiControlKeyAuthorized !== true) {
        const ctx = requireCtx(req);
        if (!callerCanAccessAgentSession(ctx, pre.accountId)) {
          throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
        }
      }
      // Audit attribution: the session's owning account. Identical to
      // ctx.account.id on the account path, and the only meaningful
      // account on the control-key path (no request-account context).
      const auditAccountId = pre.accountId;
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
      // W650 — evict the agent session's latest pageState on close (same
      // per-session in-memory cleanup as byokKeyCache above). Bounded anyway
      // by the store's LRU cap, but freeing it here avoids a closed session's
      // stale loading-bar state lingering until pushout + fulfils the store's
      // documented on-session-end eviction. Idempotent + gated (no-op when the
      // fleet control plane / store isn't wired).
      sessionPageStateStore?.delete(req.params.id);
      // Slice 6 follow-up 2026-05-20 — agent-session destroy audit.
      // Best-effort emit. Reason 'customer-closed' captured at the
      // route-level (runtime-driven closures use their own audit
      // pathway at the budget/timeout sweepers).
      try {
        await accountAudit?.record({
          accountId: auditAccountId,
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

  // W393 — POST /v1/agent-sessions/:id/resume. Resume a session the harness
  // auto-paused on a detected bot-challenge, once the customer has resolved it
  // (e.g. in the live view). Best-effort dispatch to the node (inert unless the
  // fleet control plane is wired); challenge_id (optional) correlates to the
  // session.challenge_detected being responded to — the harness validates it
  // against the active challenge (stale → stays paused), absent → manual resume.
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/v1/agent-sessions/:id/resume',
    { preHandler: [app.requireAuth, app.requireScope('write'), app.rateLimit('global')] },
    async (req, reply) => {
      const ctx = requireCtx(req);
      const parsed = ResumeSessionRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      const rec = await sessions.get(req.params.id);
      if (rec === null || !callerCanAccessAgentSession(ctx, rec.accountId)) {
        throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
      }
      // A harness challenge-pause leaves the server status 'active' (the pause is
      // harness-internal); only a terminal session can't be resumed. Mirrors the
      // input-event route's active-session guard.
      if (rec.status !== 'active') {
        throw new ConflictError(
          `AgentSession ${req.params.id} is ${rec.status}; resume requires an active session.`,
        );
      }
      await dispatchResumeSession({
        sessionId: req.params.id,
        ...(parsed.data.challenge_id !== undefined
          ? { challengeId: parsed.data.challenge_id }
          : {}),
        fleetControlRegistry,
        fleetNodesRepo,
        logger: req.log,
      });
      return reply.code(202).send({ status: 'resume_requested', session_id: req.params.id });
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
  // W650/A3-W1254 — the page-state read is gated too (machine-readable 503, not
  // a bare 404) so the GUI overlay's poll surfaces the documented activation state.
  app.get('/v1/agent-sessions/:id/page-state', stub);
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
  // W393 — POST /:id/resume also gated (same activation message).
  app.post('/v1/agent-sessions/:id/resume', stub);
}
