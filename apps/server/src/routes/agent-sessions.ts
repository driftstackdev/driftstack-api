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

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AgentModelSchema,
  ConsequentialActionCategorySchema,
  SendInputEventRequestSchema,
  ResumeSessionRequestSchema,
  PaginationQuerySchema,
  type AgentModel,
  type AccountTier,
  type ApiKeyScope,
} from '@driftstack/api-types';
import type { AgentRuntime } from '../services/agent-runtime.js';
import { consequentialSignature } from '../services/agent-executor.js';
import type { DecomposeUsage } from '../services/agent-decomposer.js';
import {
  publicAgentIntent,
  publicIntentResult,
  publicTranscriptEntry,
} from '../services/agent-public-redaction.js';
import type { AgentSessionRecord, AgentSessionsRepo } from '../services/agent-sessions.js';
import {
  hashAgentTurnRequest,
  type AgentTurnReceiptsRepo,
} from '../services/agent-turn-receipts.js';
import type { ProfilesService } from '../services/profiles.js';
import type { AccountAuthRepo } from '../services/auth.js';
import type { AccountProxiesService } from '../services/account-proxies.js';
import { UnsafeProxyHostError } from '../services/account-proxies.js';
import type {
  ProxyConnectivityProbe,
  ProbeProxyDescriptor,
} from '../services/proxy-connectivity-probe.js';
import type { SessionRepo } from '../services/sessions.js';
import { buildAssignProfileBlock } from '../services/profile-store.js';
import type { R2 } from '../lib/r2.js';
import { parseProfileId } from '../lib/profile-id.js';
import { parseSessionId } from '../lib/session-id.js';
import type { BYOKAnthropicService } from '../services/byok-anthropic.js';
import type { InMemoryByokKeyCache } from '../services/byok-anthropic-key-cache.js';
import type { InMemoryExitIdentityCache } from '../services/exit-identity-cache.js';
import type { BundledLlmService } from '../services/bundled-llm.js';
import type { BundledTurnConcurrencyLimiter } from '../services/bundled-turn-concurrency.js';
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
import type { DrizzleFleetNodesRepo, FleetNodeDetail } from '../db/fleet-nodes-repo.js';
import { mintLivekitToken, resolveSessionPublisherNode } from '../lib/livekit-token.js';
import { decryptLivekitSecret } from '../lib/livekit-secret-encryption.js';
import {
  serializeSessionAssign,
  serializeSessionEnd,
  serializeResumeSession,
} from '../services/harness-control-codec.js';
import type {
  FleetControlRegistry,
  FleetControlConnection,
} from '../services/fleet-control-registry.js';
import { CookieSchema } from '../schemas/harness-control-protocol.js';
import {
  resolvePageStateMaxAgeSeconds,
  type SessionPageStateStore,
} from '../services/session-page-state-store.js';
import type {
  SessionLivenessStore,
  SessionLivenessState,
} from '../services/session-liveness-store.js';
import type {
  SessionCapabilityReport,
  SessionCapabilityReportStore,
} from '../services/session-capability-report-store.js';
import type { SocksProxyConfig, InlineVpnProxyWire } from '@driftstack/api-types';
import {
  decryptGuiControlKey,
  encryptGuiControlKey,
  generateGuiControlKey,
} from '../lib/gui-control-key-encryption.js';
import { validateGuiControlKey } from '../lib/agent-session-control-key.js';
import {
  BundledLlmBudgetExhaustedError,
  BundledLlmConsentRequiredError,
  BadRequestError,
  ByokAnthropicRequiredError,
  ConflictError,
  ConcurrencyLimitError,
  FeatureUnavailableError,
  ForbiddenError,
  NotFoundError,
  PairModeConflictError,
  PairModeStateInvalidTransitionRouteError,
  ProxyValidationFailedError,
  RateLimitedError,
  ValidationError,
  ApiError,
  InternalError,
} from '../lib/errors.js';
// S42 2026-07-07 (founder-approved) — V-485 aiAgent tier gate (create path).
import { requireTierFeature } from '../lib/errors-helpers.js';
import { resolveEffectiveAccount, type EffectiveAccount } from '../services/auth.js';
import { readEffectiveAccountHeader } from '../lib/effective-account-header.js';
import { readIdempotencyKey } from '../lib/idempotency-key.js';
import { isUniqueViolation } from '../lib/pg-error.js';
import { readClientIp } from '../lib/client-ip.js';
import { customerSafeNodeDiagnostic } from '../services/scrub-node-diagnostics.js';

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

// http(s)-only guard for the customer-supplied initial_url. Mirrors the
// navigate.url / SessionAssign.initialUrl scheme guard in
// schemas/harness-control-protocol.ts (which is file-local / not exported) —
// kept as a small local copy to avoid exporting a schema-internal helper.
// serializeSessionAssign re-validates initialUrl at the wire as a backstop.
function isInitialUrlHttpOrHttps(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

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
  // "Launch anyway" override — when the GUI's local proxy probe flagged the proxy
  // unreachable/auth-failed and the customer explicitly accepted the risk, the
  // client sends skip_proxy_probe:true and the server SKIPS the pre-launch live
  // probe gate for THIS launch (the dispatch path's own resolve + SSRF re-guard
  // still apply as defense-in-depth). Booleans only; absent → probe runs as normal.
  skip_proxy_probe: z.boolean().optional(),
  // Customer-settable start URL — the URL the remote browser opens on launch.
  // When supplied, overrides the operator-default sessionDispatch.initialUrl.
  // http(s)-only (file:/javascript:/data: rejected here → 400 at the route, not a
  // silent dispatch drop); 2048-char cap blocks pathological payloads. Omit →
  // operator default (today https://driftstack.dev).
  initial_url: z
    .string()
    .min(1)
    .max(2048)
    .refine(isInitialUrlHttpOrHttps, {
      message:
        'initial_url must be an absolute http(s) URL; file:, javascript:, data:, etc. are rejected',
    })
    .optional(),
  // Per-session geolocation OVERRIDE (A3-approved contract 2026-07-01,
  // doc-146→07/47). By default the device's navigator.geolocation auto-derives
  // from the proxy-exit IP (geo-coherent, no field needed) — this explicitly
  // overrides that derive with fixed coordinates for the session's lifetime.
  // `accuracy` is meters (omit → device default 35.0). Deliberately NOT
  // validated against the proxy exit country: a customer may know their
  // proxy's true location better than IP geolocation does; clients surface a
  // soft coherence warning instead. Bounds mirror the SessionAssign wire schema.
  geolocation: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      accuracy: z.number().positive().max(100_000).optional(),
    })
    .strict()
    .optional(),
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
  /** Latest validated harness capability/health state. Omitted until a report
   * arrives (or when the fleet control plane is disabled). */
  capability_report?: SessionCapabilityReport;
  /** Latest authenticated harness failure. Durable so the producer's
   * post-terminal errorEvent remains available after close/restart. */
  error_event: {
    timestamp: string;
    code: string;
    severity: 'info' | 'warn' | 'error' | 'fatal';
    summary: string;
    detail: string | null;
    customer_actionable: boolean;
    retryable: boolean;
  } | null;
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
  capabilityReportStore?: SessionCapabilityReportStore,
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
    error_event:
      rec.lastErrorEvent === null
        ? null
        : {
            timestamp: rec.lastErrorEvent.timestamp,
            code: rec.lastErrorEvent.code,
            severity: rec.lastErrorEvent.severity,
            summary: rec.lastErrorEvent.summary,
            detail: rec.lastErrorEvent.detail,
            customer_actionable: rec.lastErrorEvent.customerActionable,
            retryable: rec.lastErrorEvent.retryable,
          },
  };
  if (livekit !== undefined) base.livekit = livekit;
  // Omit-when-unknown (field absent) so older SDKs + the prod no-fleet-CP path
  // are byte-identical; only set it when the store reported a live state.
  if (liveness !== undefined) base.liveness = liveness;
  if (rec.status !== 'closed') {
    const capabilityReport = capabilityReportStore?.get(rec.id) ?? null;
    if (capabilityReport !== null) base.capability_report = capabilityReport;
  }
  return base;
}

export interface AgentSessionsRoutesDeps {
  runtime: AgentRuntime;
  sessions: AgentSessionsRepo;
  /** Durable at-most-once receipts for POST /:id/message. Headerless calls
   *  retain compatibility; a supplied Idempotency-Key fails closed when this
   *  dependency is unavailable instead of promising a dedupe that cannot hold. */
  agentTurnReceipts?: AgentTurnReceiptsRepo;
  /** Q.1.c — optional. When wired, the route decrypts the
   *  customer's stored BYOK key on session-create and caches the
   *  plaintext for the session lifetime. Absent when MFA_ENCRYPTION_KEY
   *  isn't set (BYOK-per-customer-storage gate). */
  byokService?: BYOKAnthropicService;
  /** Q.1.c — required when byokService is wired. The in-memory
   *  cache that holds plaintexts for the session lifetime. */
  byokKeyCache?: InMemoryByokKeyCache;
  /** #128 — in-memory bridge from the create-time proxy probe's observed exit
   *  identity to the dispatch-time exit_identity emission (box new-tab IP panel).
   *  Optional: absent → dispatch omits exit_identity (today's behaviour). */
  exitIdentityCache?: InMemoryExitIdentityCache;
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
   * Billing-integrity hardening — per-account concurrent bundled-LLM-turn
   * limiter. The soft-cap gate is read-then-act with the cost row written
   * only after the turn completes, so N concurrent turns can all pass the
   * gate and overspend the cap (a TOCTOU race). When wired, this bounds N
   * to `limit` in-flight bundled turns per account (a 429 past that),
   * capping the overshoot. Omit to keep the unbounded (pre-fix) behaviour.
   */
  bundledTurnConcurrency?: BundledTurnConcurrencyLimiter;
  /**
   * Arc 2 sub-slice 8.3 (v2-#8) — SSE transcript bus. When wired,
   * GET /v1/agent-sessions/:id/transcript registers as an SSE stream;
   * AgentRuntime publishes every transcript-append. Omit to skip
   * registration (route just won't exist).
   */
  transcriptEventBus?: AgentSessionEventBus;
  /** Heartbeat interval for the SSE stream (ms). Defaults to 30s. */
  transcriptHeartbeatMs?: number;
  /** Heartbeat interval for the long-running POST /message SSE representation.
   *  Defaults to 15s (comfortably below SDK/edge idle deadlines). Test-injectable. */
  agentMessageHeartbeatMs?: number;
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
  /** Latest ownership-gated capabilityReport per agent session. */
  sessionCapabilityReportStore?: SessionCapabilityReportStore;
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
   * doc-150 item 6 — account-auth repo, used to resolve the OWNER's tier for the
   * per-account storage-quota gate on a profile-backed create. Mirrors how
   * routes/sessions.ts obtains the owner tier: self-scoped uses the caller's own
   * tier (ctx.account.tier), team-scoped (X-Driftstack-Account) looks the owner
   * account up here. Wired alongside `profilesService`; when absent (or no
   * profile_id on the create) the gate is skipped — a no-profile launch never
   * grows persisted state, so it's never gated (parity with /v1/sessions).
   */
  authRepo?: AccountAuthRepo;
  /**
   * ARC A — per-account customer proxies service. When wired + a create carries
   * a `proxy_id`, the route validates ownership and the dispatch resolves it
   * (owner-scoped unwrap + SSRF re-guard) into the inlineProxyConfig. Absent →
   * proxy_id is rejected as unsupported (no service to validate against).
   */
  accountProxiesService?: AccountProxiesService;
  /**
   * Founder directive #63 — CP-side LIVE proxy connectivity probe. When wired
   * (+ proxyPrelaunchProbeEnabled), a create carrying a `proxy_id` is gated on a
   * real egress round-trip THROUGH the resolved proxy BEFORE the session row is
   * created and the worker dispatched: a failed live test BLOCKS the launch with
   * a clean 422 (ProxyValidationFailed), zero session, zero spin-up. Absent → the
   * gate is skipped (the proxy is still resolved + SSRF-guarded at dispatch as
   * today). VPN schemes (openvpn/wireguard) tunnel at the box, not via a
   * CP-dialable protocol, so the probe is skipped for them — A3's W2931 box-
   * reported failure is their forward-compatible surface (same 422 problem-type).
   */
  proxyConnectivityProbe?: ProxyConnectivityProbe;
  /**
   * Founder directive #63 — master switch for the pre-launch probe. ON by default
   * in bootstrap (the founder's ask: gate EVERY proxied launch live). Exposed so a
   * deployment can disable it via DRIFTSTACK_PROXY_PRELAUNCH_PROBE=0 if the probe
   * ever false-negatives a working proxy. When false, the gate is a no-op even
   * with the probe wired.
   */
  proxyPrelaunchProbeEnabled?: boolean;
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
  /**
   * Founder safeguard (2026-06-24) — per-ACCOUNT cap (bytes) on CONCURRENT
   * in-flight upload volume for POST /:id/files, independent of the 64 MiB
   * per-file cap. Sourced from config (AGENT_UPLOAD_MAX_ACCOUNT_INFLIGHT_BYTES;
   * prod default 512 MB). Test-injectable so unit tests can trip the cap with
   * tiny payloads instead of holding ~512 MB of buffers. Default 512 * 1024 *
   * 1024 when omitted (the prod posture, unchanged).
   */
  uploadMaxAccountInFlightBytes?: number;
  /**
   * Hardening (2026-06-24, LOW defense-in-depth) — per-ACCOUNT cap on CONCURRENT
   * in-flight RELAY requests (count) across the control-relay routes that only
   * carry the `global` RATE limiter today (POST /:id/cookies/set, POST
   * /:id/history, GET /:id/downloads, GET /:id/downloads/content). The rate
   * limiter bounds requests/window, NOT how many can be awaiting a 10–30s relay
   * at once — one account could burst dozens of concurrent handlers, each pinning
   * a correlator slot + an HTTP connection for the relay timeout. This count cap
   * sheds the (N+1)-th with a discriminated busy outcome (no relay). Reserved
   * before the await, released in the relay's finally (any outcome). Test-
   * injectable so unit tests trip it with a cap of 1–2. Default 16 when omitted.
   */
  relayMaxAccountInFlight?: number;
  /**
   * Hardening (2026-06-24, LOW defense-in-depth) — per-ACCOUNT cap on CONCURRENT
   * in-flight UPLOAD requests (COUNT) for POST /:id/files, alongside the existing
   * BYTE cap (uploadMaxAccountInFlightBytes). The byte cap bounds total volume;
   * this bounds the number of simultaneous upload relays so a flood of small
   * uploads can't pin many correlator slots at once. Reserved/released in the same
   * finally as the byte reservation. Test-injectable. Default 4 when omitted.
   */
  uploadMaxAccountInFlightCount?: number;
  /**
   * Security-audit hardening (2026-06-30, MEDIUM) — a persisted, per-SESSION
   * LIFETIME cap on total upload volume for POST /:id/files, independent of
   * the CONCURRENT in-flight byte/count caps above. Those caps are released
   * in the relay's `finally` the instant EACH upload settles, so a caller that
   * uploads strictly one-at-a-time (never crossing the concurrent ceiling) can
   * push unbounded total volume through a single session — bounded only by the
   * generic 'global' rate limiter (as low as 1 req/s on free tier, still ~225
   * GB/hour at the 64 MiB per-file cap). Since multiple customers' sessions
   * share one box's disk, this is a real cross-tenant disk-exhaustion vector.
   * Incremented ONLY on a successful relay (status:'ok'); NEVER released — a
   * true lifetime total for the session, distinct from the (concurrent,
   * released-on-settle) account caps above. Tracked in-memory per-instance
   * (prod = single node; a multi-instance deploy would move this to a
   * persisted store, mirroring the in-flight caps' own caveat). Test-
   * injectable via deps.sessionUploadMaxLifetimeBytes. Default 2 GiB when
   * omitted.
   */
  sessionUploadMaxLifetimeBytes?: number;
  /**
   * Sibling of sessionUploadMaxLifetimeBytes — a per-SESSION LIFETIME cap on
   * the NUMBER of files uploaded, alongside the byte cap (guards a flood of
   * many small files even while under the byte ceiling). Incremented only on
   * a successful relay, never released. Test-injectable via
   * deps.sessionUploadMaxLifetimeCount. Default 500 when omitted.
   */
  sessionUploadMaxLifetimeCount?: number;
}

/** Config for the session-create → harness `sessionAssign` dispatch (see
 *  AgentSessionsRoutesDeps.sessionDispatch). */
export interface SessionDispatchConfig {
  archetype: string;
  behaviorProfile: string;
  initialUrl: string;
  proxy: SocksProxyConfig;
}

/** Idle-timeout for MANUAL (GUI) sessions (A3 W2813 idleTimeoutSeconds knob). A manual
 *  session is interactively WATCHED — the operator may read/watch without touching for a
 *  while — so the box's ~300s default reaps it under the user. 30 min balances that UX
 *  against holding a fleet slot for a truly-abandoned tab. ai/pair sessions keep the box
 *  default (they stay active via API intents). Value is a sensible default; A3 can tune. */
export const MANUAL_SESSION_IDLE_TIMEOUT_SECONDS = 1800;

/** Max wall-clock lifetime for MANUAL (GUI) sessions. The harness default is
 *  ~1800s (30 min) for EVERY session (harness-control-protocol: omit → max 1800s),
 *  which hard-kills an interactively-watched sim mid-use after half an hour with no
 *  explanation — the GUI only learns via a generic disconnect. A manual session is a
 *  human at the controls, so it gets a far more generous 4h cap; the idle timeout
 *  (above) still reaps a genuinely-abandoned tab well before this. ai/pair (API-driven)
 *  sessions keep the box default — they're bounded by token budget + the orphan reaper,
 *  not a human's attention span. 14400s = 4h is a sensible default; A3 can tune. */
export const MANUAL_SESSION_MAX_DURATION_SECONDS = 14400;

/**
 * Connectivity-aware dispatch-node selection (multi-box region fix). Returns the
 * region-nearest LiveKit node whose control-WSS is ACTUALLY connected right now,
 * plus its live connection, so the publisher dispatch + the viewer token (minted
 * separately off the persisted node_id) both bind to the SAME live box.
 *
 * `findNearestWithLivekit` alone returns only the SINGLE top candidate — in a
 * >=2-box region, if that one box's control-WSS is offline while a sibling box is
 * online, committing to it black-screens the session even though a healthy box
 * could serve. So we walk the region-nearest LiveKit candidates and pick the
 * first one present in the registry. When NONE are connected we return the top
 * candidate with `conn: undefined` so the caller can fail honestly (close the
 * never-dispatched row) — same signal the old single-node check produced.
 *
 * Degrades gracefully: if the repo doesn't implement `listWithLivekitNearest`
 * (older stubs / the InMemory variant), falls back to the single
 * `findNearestWithLivekit` candidate — identical to the prior behaviour.
 */
async function resolveLiveDispatchNode(
  fleetNodesRepo: DrizzleFleetNodesRepo,
  registry: FleetControlRegistry,
  accountRegion: string | null | undefined,
): Promise<{ mac: FleetNodeDetail | null; conn: FleetControlConnection | undefined }> {
  // The registry is keyed by the authed node_id (the JWT iss), NOT the
  // fleet_nodes uuid PK (migration 0085 / Path C) — resolve by nodeId, falling
  // back to the uuid for any legacy uuid-keyed node.
  //
  // Degrade gracefully when the repo predates listWithLivekitNearest (older test
  // stubs / the InMemory variant): the runtime check guards the call so a stub
  // typed `as DrizzleFleetNodesRepo` without the method falls to the single-node
  // path below — identical to the prior behaviour.
  if (typeof fleetNodesRepo.listWithLivekitNearest === 'function') {
    const candidates = await fleetNodesRepo.listWithLivekitNearest(accountRegion);
    let firstWithLivekit: FleetNodeDetail | null = null;
    for (const candidate of candidates) {
      if (candidate.livekit === null) continue;
      if (firstWithLivekit === null) firstWithLivekit = candidate;
      const conn = registry.get(candidate.nodeId ?? candidate.id);
      if (conn !== undefined) return { mac: candidate, conn };
    }
    // No live candidate — return the top one so the caller fails honestly.
    return { mac: firstWithLivekit, conn: undefined };
  }
  // Fallback: single-candidate selection (no candidate list available).
  const mac = await fleetNodesRepo.findNearestWithLivekit(accountRegion);
  if (mac === null || mac.livekit === null) return { mac, conn: undefined };
  return { mac, conn: registry.get(mac.nodeId ?? mac.id) };
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
 * Node selection is connectivity-aware (multi-box region fix): it picks the
 * region-nearest LiveKit node whose control-WSS is actually connected. When NO
 * LiveKit box has a live control-WSS at create time, the session can never get a
 * publisher, so the row is CLOSED honestly (reason='dispatch_no_live_node') —
 * the GUI sees status='closed' instead of a permanently stuck "No frame yet", and
 * the never-dispatched row stops counting against the per-account active cap (it
 * no longer leaks until the 12h reaper). LIVE re-delivery is idempotent
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
  // #128 — the create-time proxy probe stashes the observed exit identity here
  // keyed by (accountId, proxyId); this dispatch reads it back to emit the
  // exit_identity block (box new-tab IP panel). A miss omits the optional block.
  exitIdentityCache?: InMemoryExitIdentityCache;
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
  // Customer-supplied start URL from the create body. Overrides
  // sessionDispatch.initialUrl when present; falls back to the operator default
  // when absent. Already http(s)-validated at the route; serializeSessionAssign
  // re-validates at the wire.
  initialUrl?: string;
  // Per-session idle-timeout override (A3 W2813 knob). The route sets a generous
  // value for manual (GUI) sessions so a sim the operator is WATCHING but not
  // touching is not idle_timeout-reaped at the box default (~300s); absent → the
  // box default (correct for ai/pair API-driven sessions, which stay active).
  idleTimeoutSeconds?: number;
  // Per-session max-duration override. The route sets a generous value for manual
  // (GUI) sessions so an interactively-watched sim isn't hard-killed at the box
  // ~1800s default mid-use; absent → the box default (correct for ai/pair sessions,
  // bounded by token budget + the orphan reaper instead of a wall clock).
  maxDurationSeconds?: number;
  // Explicit geolocation override from the create body (A3-approved contract
  // 2026-07-01). Absent → the harness keeps its proxy-exit auto-derive (the
  // exit-coherent default); present → the fork's location provider serves
  // exactly these coordinates for the session's lifetime. Already
  // bounds-validated at the route; serializeSessionAssign re-validates at the wire.
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
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
    exitIdentityCache,
    agentSessions,
    accountRegion,
    initialUrl,
    idleTimeoutSeconds,
    maxDurationSeconds,
    geolocation,
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
    // Connectivity-aware node selection (multi-box region fix). `findNearestWithLivekit`
    // returns only the SINGLE region-nearest LiveKit node; if THAT box's control-WSS is
    // offline while a sibling box in the region is online, the old code black-screened
    // even though a healthy box could serve. So iterate the region-nearest LiveKit
    // candidates and pick the FIRST that is ALSO present in the control-WSS registry, and
    // bind BOTH the viewer token (minted by maybeMintLivekit off the persisted node_id
    // below) AND this publisher dispatch to that SAME live box. Falls back to the single
    // findNearestWithLivekit candidate when the candidate-list method isn't wired (older
    // repo stubs) — same behaviour as before for the common single-box case.
    const { mac, conn } = await resolveLiveDispatchNode(
      fleetNodesRepo,
      fleetControlRegistry,
      accountRegion,
    );
    if (mac === null || mac.livekit === null) return;
    if (conn === undefined) {
      // Founder bug ("opened a session and nothing happened, browser not
      // started"): NO LiveKit box in the region has a live control-WSS at create
      // time (the registry has none of the candidates), so the session minted a
      // viewer token but no publisher could be dispatched → the GUI would sit on
      // "No frame yet" forever and the status='active' row would count against the
      // per-account cap until the 12h reaper. FAIL HONESTLY: close the
      // never-dispatched row with a terminal reason (mirrors the egress-unresolved
      // path) so (a) it stops counting active immediately and (b) the GUI sees
      // status='closed' instead of a permanently stuck stream. A momentary WSS flap
      // → the founder simply relaunches; a closed honest row beats a silently-stuck one.
      logger?.info(
        { component: 'fleet-session-dispatch', sessionId, nodeId: mac.nodeId ?? mac.id },
        'no live fleet node at create; closing never-dispatched session (dispatch_no_live_node)',
      );
      await closeUnresolvedEgressSession(agentSessions, sessionId, logger, 'dispatch_no_live_node');
      return;
    }
    const apiSecret = decryptLivekitSecret(
      mac.livekit.apiSecretCiphertextBase64,
      livekitSecretEncryptionKey,
      { nodeId: mac.id, apiKey: mac.livekit.apiKey, wsUrl: mac.livekit.wsUrl },
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
      let dek: Awaited<ReturnType<typeof profilesService.getProfileDek>> = null;
      try {
        dek = await profilesService.getProfileDek({ profileId, accountId });
      } catch (err) {
        // A corrupted / rotated-but-not-rewrapped profile DEK blob (GCM auth fail)
        // must NOT abort the dispatch (which would strand the session active-but-
        // never-dispatched — a phantom concurrency slot until the 12h reaper, and
        // the GUI spinning on "No frame yet"). Degrade to a DEK-less, stateless
        // dispatch: the session still runs, it just can't open/seal the encrypted
        // profile store this run. Mirrors the R2 url-mint degrade just below;
        // distinct from the outer best-effort catch, which drops the dispatch.
        logger?.warn(
          { component: 'agent-session-dispatch', sessionId, profileId, err },
          'profile DEK unwrap failed; dispatching DEK-less (stateless this run)',
        );
      }
      if (dek !== null) {
        const dekBase64 = dek.toString('base64');
        if (r2 !== undefined) {
          try {
            // The save-back PUT URL is used at session TEARDOWN, not now — so it
            // must stay valid for the whole session lifetime. The default 1h TTL
            // would expire mid-session (manual sessions run up to
            // MANUAL_SESSION_MAX_DURATION_SECONDS = 4h), 403-ing the final save-back
            // and SILENTLY losing the profile's saved state. Mint it to cover the
            // max session + a teardown margin (clamped to the 7-day SigV4 ceiling
            // inside buildAssignProfileBlock).
            profile = await buildAssignProfileBlock(r2, profileId, dekBase64, {
              urlTtlSeconds: MANUAL_SESSION_MAX_DURATION_SECONDS + 1800,
            });
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
      if (resolved === null) {
        // FAIL CLOSED: the customer explicitly requested their OWN proxy but it can't be
        // resolved (not found / non-dispatchable scheme / decrypt fail). Do NOT silently fall
        // back to the operator-default egress — that would run the customer's session through
        // shared egress they never chose (an egress-identity leak). Skip the dispatch instead.
        // (An unsafe-host proxy already throws UnsafeProxyHostError → the outer catch closes it.)
        logger?.warn(
          { component: 'fleet-session-dispatch', sessionId, proxyId },
          'requested proxy_id unresolvable; failing closed (no operator-default egress fallback)',
        );
        // #16 — close the row with a terminal reason so this never-dispatched session
        // stops counting against MAX_ACTIVE_AGENT_SESSIONS_PER_ACCOUNT (otherwise each
        // failed launch/retry leaks a phantom 'active' slot until the wall-clock reaper).
        await closeUnresolvedEgressSession(agentSessions, sessionId, logger);
        return;
      }
      inlineProxyConfig = resolved;
    }
    // #128 — emit the exit_identity block (box new-tab IP panel) when the create-time
    // proxy probe observed one for THIS (accountId, proxyId). Keyed by proxy, so a
    // miss (probe found no identity / cache cold after a restart / operator-default
    // egress with no proxyId) just omits the optional block — the box keeps today's
    // behaviour. quic_ok is derived from the RESOLVED egress: a VPN wire tunnels all
    // IP incl. UDP → QUIC works; a socks5 proxy needs UDP ASSOCIATE actually verified
    // through it (#46 udp_capable), not merely requested (udp_associate is a wish).
    const cachedExit =
      accountId !== undefined && proxyId !== undefined && exitIdentityCache !== undefined
        ? exitIdentityCache.get(accountId, proxyId)
        : undefined;
    const exitIdentity =
      cachedExit !== undefined
        ? {
            ip: cachedExit.identity.ip,
            country: cachedExit.identity.country,
            region: cachedExit.identity.region,
            city: cachedExit.identity.city,
            timezone: cachedExit.identity.timezone,
            quicOk:
              'type' in inlineProxyConfig &&
              (inlineProxyConfig.type === 'openvpn' || inlineProxyConfig.type === 'wireguard')
                ? true
                : (inlineProxyConfig as { udp_capable?: boolean | null }).udp_capable === true,
            probedAt: cachedExit.probedAt,
          }
        : undefined;
    const assign = serializeSessionAssign({
      sessionId,
      archetype: profileArchetype ?? sessionDispatch.archetype,
      behaviorProfile: sessionDispatch.behaviorProfile,
      // Customer-supplied initial_url wins; falls back to the operator-config
      // default when the create body omitted it.
      initialUrl: initialUrl ?? sessionDispatch.initialUrl,
      inlineProxyConfig,
      livekit: {
        room: sessionId,
        token,
        wsUrl: mac.livekit.wsUrl,
        expiresAt: new Date(nowMs + ttlSeconds * 1000).toISOString(),
      },
      ...(profile !== undefined ? { profile } : {}),
      ...(idleTimeoutSeconds !== undefined ? { idleTimeoutSeconds } : {}),
      ...(maxDurationSeconds !== undefined ? { maxDurationSeconds } : {}),
      ...(geolocation !== undefined ? { geolocation } : {}),
      ...(exitIdentity !== undefined ? { exitIdentity } : {}),
    });
    const dispatchedNodeId = mac.nodeId ?? mac.id;
    // Worker-disconnect fix (2026-06-19) — persist session→node so the disconnect
    // reaper can close THIS node's active sessions when it drops. The registry key
    // is what the reaper sees on unregister, so we store the SAME value the dispatch
    // resolved the connection by.
    //
    // Persist BEFORE sending the assign (review w7eu5sw7n). If the assign went first,
    // the row is status='active' with node_id=NULL until this DB write commits — and
    // a NULL owner cannot safely accept any fleet-origin terminal/state frame. The
    // exact-owner guards now fail closed there, but a swallowed write failure would
    // still strand it active+NULL forever (a phantom concurrency slot the disconnect
    // reaper cannot attribute), so assignment remains strictly after persistence.
    // So: persist first; if the write fails or the row was deleted mid-dispatch, do
    // NOT send the assign — leave the session unowned (no node holds it) for the 12h
    // orphan_reap backstop, never owned-but-NULL. setNodeId returns null when the id
    // lost a race with DELETE (session gone → nothing to dispatch).
    if (agentSessions !== undefined) {
      let persisted: Awaited<ReturnType<typeof agentSessions.setNodeId>>;
      try {
        persisted = await agentSessions.setNodeId(sessionId, dispatchedNodeId);
      } catch (err) {
        logger?.warn(
          {
            component: 'fleet-session-dispatch',
            sessionId,
            nodeId: dispatchedNodeId,
            err: err instanceof Error ? err.message : String(err),
          },
          'persisting session node_id failed; skipping dispatch (avoids owned-but-NULL window; orphan_reap backstop holds)',
        );
        return;
      }
      if (persisted === null) {
        logger?.warn(
          { component: 'fleet-session-dispatch', sessionId },
          'session row absent at node_id persist (deleted mid-dispatch); skipping assign',
        );
        return;
      }
    }
    conn.sendSessionAssign(assign);
    logger?.info(
      {
        component: 'fleet-session-dispatch',
        sessionId,
        nodeId: dispatchedNodeId,
        // Observability for the per-session archetype the box is told to provision
        // (profile-bound archetype, or the static operator default for stateless
        // runs). Lets us confirm the CP sent the right fingerprint vs what the box
        // actually rendered, without re-deriving from the DB.
        archetype: profileArchetype ?? sessionDispatch.archetype,
        archetypeSource: profileArchetype !== undefined ? 'profile' : 'static-default',
      },
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
    // #16 — an UnsafeProxyHostError is a fail-closed egress decision (the SSRF
    // re-guard rejected the customer's proxy host); the session was never
    // dispatched and never will be, so close the row's phantom 'active' slot
    // exactly like the resolved===null branch. Other dispatch errors (transient
    // R2/registry hiccups) are NOT closed here — they may be retryable and the
    // wall-clock orphan reaper is the correct backstop for a genuinely stuck row.
    if (err instanceof UnsafeProxyHostError) {
      await closeUnresolvedEgressSession(agentSessions, sessionId, logger);
    }
  }
}

/**
 * #16 — close a never-dispatched session so the phantom 'active' row stops
 * counting against the per-account active-session cap. Used for two terminal,
 * never-will-dispatch cases: `egress_unresolved` (unresolvable/undispatchable
 * proxy or an SSRF-rejected host) and `dispatch_no_live_node` (the owning box's
 * control-WSS was disconnected at create time, so no publisher was ever sent).
 * Best-effort + no-op when the repo isn't wired (the fail-closed path still
 * returns); the wall-clock orphan reaper remains the backstop. Idempotent —
 * closeWithReason keeps the first close's timestamp.
 */
async function closeUnresolvedEgressSession(
  agentSessions: AgentSessionsRepo | undefined,
  sessionId: string,
  logger?: { info: (obj: unknown, msg: string) => void; warn: (obj: unknown, msg: string) => void },
  reason: 'egress_unresolved' | 'dispatch_no_live_node' | 'create_failed' = 'egress_unresolved',
): Promise<void> {
  if (agentSessions === undefined) return;
  try {
    await agentSessions.closeWithReason(sessionId, reason);
  } catch (closeErr) {
    logger?.warn(
      {
        component: 'fleet-session-dispatch',
        sessionId,
        reason,
        err: closeErr instanceof Error ? closeErr.message : String(closeErr),
      },
      'failed to close never-dispatched session; orphan reaper will backstop',
    );
  }
}

/**
 * Founder directive #63 — FAIL-CLOSED pre-launch proxy gate. Runs at session
 * CREATE, after ownership + scheme validation, BEFORE the session row is created
 * and the worker dispatched. Resolves the (already-owned) proxy_id to its
 * decrypted host/port/credentials, then live-probes it: CONNECT THROUGH the proxy
 * + a real egress round-trip. On failure it THROWS ProxyValidationFailedError
 * (422) so the route blocks the launch with a clean, specific reason — zero
 * session row, zero simulator spin-up. On pass it returns and the create proceeds.
 *
 * No-op (returns) when the probe isn't wired or the flag is off (then the dispatch
 * path's own resolve + SSRF re-guard remain the only egress check, as before).
 *
 * VPN schemes (openvpn/wireguard) are NOT CP-dialable proxies — they tunnel at the
 * box — so resolveForDispatch returns the FLAT VPN wire (with a `type` field) and
 * we SKIP the live probe for them. Their forward-compatible failure surface is
 * A3's W2931 (post-dispatch, box-reported), which raises the SAME 422 problem-type
 * + `reason` enum once the box reports an egress failure. socks5 is the only
 * scheme this gate live-tests pre-launch today (http was already rejected above).
 *
 * resolveForDispatch can throw UnsafeProxyHostError (SSRF re-guard) — that
 * propagates as the route's existing fail-closed (the outer handler maps it), so a
 * private-host proxy never even reaches the live probe.
 */
export async function runProxyPrelaunchGate(args: {
  probe: ProxyConnectivityProbe | undefined;
  enabled: boolean;
  accountProxiesService: AccountProxiesService;
  proxyId: string;
  accountId: string;
  logger?: { info: (obj: unknown, msg: string) => void; warn: (obj: unknown, msg: string) => void };
  /** #128 — cache the probe's observed exit identity (keyed by accountId+proxyId) so
   *  the dispatch build can emit the exit_identity block for the box new-tab IP panel. */
  exitIdentityCache?: InMemoryExitIdentityCache;
}): Promise<void> {
  const { probe, enabled, accountProxiesService, proxyId, accountId, logger, exitIdentityCache } =
    args;
  if (probe === undefined || !enabled) return;

  // Resolve to the decrypted dispatch config (owner-scoped + SSRF re-guard).
  // Null = unresolvable (decrypt fail / non-dispatchable scheme). The dispatch
  // path fails closed on null too (closes the never-dispatched row), but by then
  // the route has already returned 201 and the GUI has opened the simulator window
  // → it just spins forever ("launched but nothing opened"). Since the gate is
  // active here, BLOCK at create with a clean 422 instead, so the founder gets an
  // honest, specific error before any window opens. `unreachable` is the closest
  // reason (the proxy can't be used right now); the detail spells it out.
  const resolved = await accountProxiesService.resolveForDispatch({ proxyId, accountId });
  if (resolved === null) {
    logger?.warn(
      { component: 'proxy-prelaunch-probe', proxyId },
      'proxy unresolvable at pre-launch gate (decrypt/config) — blocking launch (no dispatch)',
    );
    throw new ProxyValidationFailedError({
      reason: 'unreachable',
      detail:
        'This proxy can’t be used right now (its stored configuration could not be read). Re-add it and try again.',
    });
  }

  // VPN wire carries a `type` discriminator (openvpn|wireguard) — not a
  // CP-dialable socks5/http proxy. Skip the live probe (box-side W2931 covers it).
  if ('type' in resolved) return;

  const descriptor: ProbeProxyDescriptor = {
    protocol: 'socks5',
    host: resolved.host,
    port: resolved.port,
    ...(resolved.username !== undefined ? { username: resolved.username } : {}),
    ...(resolved.password !== undefined ? { password: resolved.password } : {}),
  };

  let result = await probe.probe(descriptor);
  // Single retry on a TRANSIENT failure only. Rotating residential exits (e.g.
  // NodeMaven, with many A-records) can momentarily route the dial to a dead exit
  // IP → a `unreachable` timeout, while a second attempt lands on a live exit and
  // streams fine. We do NOT retry `auth_failed` (wrong creds — a retry can't help
  // and just doubles latency) or `egress_blocked` (the proxy tunneled but the
  // target refused — not a transient connect issue). This narrows the residual
  // false-block window A3 flagged (W2949) without weakening the gate's intent.
  if (!result.ok && result.reason === 'unreachable') {
    logger?.info(
      { component: 'proxy-prelaunch-probe', proxyId, host: descriptor.host, reason: result.reason },
      'pre-launch proxy probe transient-unreachable; retrying once',
    );
    result = await probe.probe(descriptor);
  }
  if (!result.ok) {
    // Log the host (NOT credentials) for ops triage; the customer gets the typed
    // reason + a human one-liner (ProxyValidationFailedError fills detail).
    logger?.warn(
      {
        component: 'proxy-prelaunch-probe',
        proxyId,
        host: descriptor.host,
        port: descriptor.port,
        reason: result.reason,
      },
      'pre-launch proxy probe FAILED; blocking launch (no dispatch)',
    );
    throw new ProxyValidationFailedError({
      reason: result.reason ?? 'unreachable',
    });
  }
  // #128 — the probe observed the exit identity the world sees THROUGH this proxy
  // (present only on a clean 200 echo-body tail; absent otherwise). Stash it keyed
  // by (accountId, proxyId) so the later dispatch build can emit exit_identity for
  // the box new-tab IP panel. Best-effort + peek-only upstream: it can never have
  // affected the pass/fail verdict, and a miss just omits the optional block.
  if (result.exitIdentity !== undefined) {
    exitIdentityCache?.set(accountId, proxyId, result.exitIdentity);
  }
  logger?.info(
    { component: 'proxy-prelaunch-probe', proxyId, host: descriptor.host },
    'pre-launch proxy probe passed',
  );
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
  /** The session's persisted owning node (agent_sessions.node_id, migration 0086). When
   *  set, sessionEnd targets THAT node — region-aware multi-node dispatch can place a
   *  session on a node that is NOT the latest-registered, so the region-blind
   *  findAnyWithLivekit() fallback would send the teardown to the wrong node and leak the
   *  owner's concurrency slot (orphan billed til the 12h reap). NULL = legacy/never-
   *  dispatched row → fall back to findAnyWithLivekit. */
  nodeId?: string | null;
  fleetControlRegistry: FleetControlRegistry | undefined;
  fleetNodesRepo: DrizzleFleetNodesRepo | undefined;
  logger?: { info: (obj: unknown, msg: string) => void; warn: (obj: unknown, msg: string) => void };
}): Promise<void> {
  const { sessionId, nodeId, fleetControlRegistry, fleetNodesRepo, logger } = args;
  if (fleetControlRegistry === undefined || fleetNodesRepo === undefined) return;
  try {
    // Target the OWNING node when known (migration 0086); else fall back to the region-
    // blind latest-registered node (legacy rows only).
    let targetNodeId: string | null = nodeId ?? null;
    if (targetNodeId === null) {
      const mac = await fleetNodesRepo.findAnyWithLivekit();
      if (mac === null) return;
      // The registry is keyed by the authed node_id (the JWT iss), NOT the fleet_nodes
      // uuid PK (migration 0085 / Path C). Fall back to the uuid for a legacy uuid-keyed node.
      targetNodeId = mac.nodeId ?? mac.id;
    }
    const conn = fleetControlRegistry.get(targetNodeId);
    if (conn === undefined) {
      // Node not connected (control-WSS down/flapping, A3 W2859) — the sessionEnd
      // can't land now. QUEUE it so register() re-dispatches on the node's next
      // reconnect; otherwise the box keeps the browser running (orphan + cost). The
      // robust fix for the founder's "End-session doesn't tear down" symptom,
      // independent of the -1011 WSS root cause.
      fleetControlRegistry.recordPendingTeardown(targetNodeId, sessionId);
      logger?.info(
        { component: 'fleet-session-dispatch', sessionId, nodeId: targetNodeId },
        'node offline — queued sessionEnd for re-dispatch on reconnect',
      );
      return;
    }
    conn.sendSessionEnd(serializeSessionEnd(sessionId));
    logger?.info(
      { component: 'fleet-session-dispatch', sessionId, nodeId: targetNodeId },
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
  /** Persisted owning node (agent_sessions.node_id) — target it so a resume reaches the
   *  node actually running the session, not the region-blind latest-registered one (same
   *  multi-node correctness fix as dispatchSessionEndOnClose). NULL → findAnyWithLivekit. */
  nodeId?: string | null;
  fleetControlRegistry: FleetControlRegistry | undefined;
  fleetNodesRepo: DrizzleFleetNodesRepo | undefined;
  logger?: {
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
  };
}): Promise<void> {
  const { sessionId, challengeId, nodeId, fleetControlRegistry, fleetNodesRepo, logger } = args;
  if (fleetControlRegistry === undefined || fleetNodesRepo === undefined) return;
  try {
    // Target the OWNING node when known (migration 0086); else the region-blind
    // latest-registered node (legacy rows only).
    let targetNodeId: string | null = nodeId ?? null;
    if (targetNodeId === null) {
      const mac = await fleetNodesRepo.findAnyWithLivekit();
      if (mac === null) return;
      // Registry is keyed by the authed node_id (JWT iss), not the uuid PK (migration 0085).
      targetNodeId = mac.nodeId ?? mac.id;
    }
    const conn = fleetControlRegistry.get(targetNodeId);
    if (conn === undefined) return; // node not connected → nothing to resume server-side
    conn.sendResumeSession(
      serializeResumeSession({
        sessionId,
        ...(challengeId !== undefined ? { challengeId } : {}),
      }),
    );
    logger?.info(
      { component: 'fleet-session-dispatch', sessionId, nodeId: targetNodeId, challengeId },
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
    agentTurnReceipts,
    byokService,
    byokKeyCache,
    exitIdentityCache,
    agentDecomposerKind = 'deterministic',
    deploymentFallbackKey,
    allowFallbackForUnconfiguredCustomers,
    bundledLlmService,
    bundledTurnConcurrency,
    transcriptEventBus,
    transcriptHeartbeatMs = 30_000,
    agentMessageHeartbeatMs = 15_000,
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
    sessionCapabilityReportStore,
    sessionDispatch,
    profilesService,
    authRepo,
    accountProxiesService,
    proxyConnectivityProbe,
    proxyPrelaunchProbeEnabled = true,
    driverSessionsRepo,
    r2,
    uploadMaxAccountInFlightBytes = 512 * 1024 * 1024,
    relayMaxAccountInFlight = 16,
    uploadMaxAccountInFlightCount = 4,
    sessionUploadMaxLifetimeBytes = 2 * 1024 * 1024 * 1024,
    sessionUploadMaxLifetimeCount = 500,
  } = deps;

  /**
   * doc-150 item 6 — resolve the OWNER's tier for the storage-quota gate, mirroring
   * routes/sessions.ts: self-scoped uses the caller's own tier; team-scoped (an
   * admin acting under X-Driftstack-Account) looks the owner account up via authRepo,
   * since the stored profiles + their quota belong to the owner. A missing owner (or
   * no authRepo wired) is a Forbidden — we can't safely meter an account we can't read.
   */
  async function resolveOwnerTier(
    ctx: NonNullable<FastifyRequest['account']>,
    effective: EffectiveAccount,
  ): Promise<AccountTier> {
    if (effective.kind !== 'team') {
      return ctx.account.tier;
    }
    if (authRepo === undefined) {
      throw new ForbiddenError('Owner account tier is unavailable.');
    }
    const owner = await authRepo.getAccount(effective.accountId);
    if (!owner) {
      throw new ForbiddenError('Owner account no longer exists.');
    }
    return owner.tier;
  }

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
    sessionNodeId?: string | null,
  ): Promise<PublicLivekitInfo | undefined> {
    if (fleetNodesRepo === undefined || livekitSecretEncryptionKey === undefined) {
      return undefined;
    }
    try {
      // CONSISTENT WITH THE PUBLISHER DISPATCH: the SFU is co-located on the box,
      // so the viewer MUST connect to the SAME node the harness publishes to. When
      // the session is already bound (node_id set — reconnect/race-winner paths),
      // resolve THAT Mac so a >=2-LiveKit-box region can't hand the viewer the
      // wrong box's token. A fresh create (node_id still NULL until dispatch) falls
      // back to findNearestWithLivekit(region) — same as the publisher dispatch, so
      // they agree. No logger here: the create-time NULL fallback is expected, not
      // noteworthy (the re-mint route logs the meaningful bound-node-gone case).
      const mac = await resolveSessionPublisherNode(fleetNodesRepo, sessionNodeId, region);
      if (mac === null || mac.livekit === null) return undefined;
      const apiSecret = decryptLivekitSecret(
        mac.livekit.apiSecretCiphertextBase64,
        livekitSecretEncryptionKey,
        { nodeId: mac.id, apiKey: mac.livekit.apiKey, wsUrl: mac.livekit.wsUrl },
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
    } catch (err) {
      // Best-effort: any failure (decrypt error, repo error) drops to undefined
      // so the session-create response still ships. The expected create-time
      // "no bound node yet" case returns early above WITHOUT throwing, so a throw
      // here is a REAL fault — log it (a silent catch here hid a fatal uuid-cast
      // in the bound-node lookup for days, which killed the floating simulator on
      // every dispatched session). Not fatal to the response; surface it.

      console.error(
        `[livekit-mint] failed to mint LiveKit token for session ${sessionId} (node_id=${sessionNodeId ?? 'null'})`,
        err,
      );
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
   * The ciphertext's authenticated context binds it to ONE account and
   * session ID, so moving session A's stored blob onto session B still
   * fails before plaintext comparison. Equal-length-buffer +
   * timingSafeEqual avoids a length/early-return side channel.
   */
  async function validateControlKey(
    req: FastifyRequest,
    sessionId: string,
  ): Promise<{ authorized: false } | { authorized: true; ownerAccountId: string }> {
    // Only hit the DB when a header is actually present (the no-header case
    // falls straight through to the account path — avoids a needless get()).
    const headerRaw = req.headers[GUI_CONTROL_KEY_HEADER];
    const header = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
    if (header === undefined || header.length === 0) {
      return { authorized: false };
    }
    const rec = await sessions.get(sessionId);
    // Shared validator (lib/agent-session-control-key.ts) — single source of
    // truth, also used by the livekit-token re-mint route.
    return validateGuiControlKey({
      headerRaw,
      session: rec,
      encryptionKey: guiControlKeyEncryptionKey,
    });
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
    // #122 — widened from `'read' | 'write'` to the full scope union so the
    // read GET routes can pass the granular `read:sessions` floor (mirroring
    // the driver-session read routes in routes/sessions.ts) while the write
    // control routes keep `'write'`. The control-key branch (b) is unaffected
    // — a valid per-session gui_control_key bypasses requireScope entirely, so
    // the GUI/Simulator's per-session channel keeps working regardless.
    requiredScope: ApiKeyScope,
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

  /**
   * Persist a pair-mode transition without overwriting a newer state or a
   * concurrent `/mode` change. The repository compare-and-set includes the
   * active+pair predicates in the same UPDATE as the expected JSON state.
   *
   * When a takeover lost specifically to another tab, preserve the existing
   * typed winner response so the caller can identify the controller. Other
   * state/mode/status races fail closed with a refresh-and-retry conflict.
   */
  async function commitPairModeTransition(args: {
    sessionId: string;
    expectedPersistedState: unknown;
    nextState: PairModeState;
    takeoverClientId?: string;
  }): Promise<void> {
    const updated = await sessions.compareAndSetPairModeState(
      args.sessionId,
      args.expectedPersistedState,
      args.nextState,
    );
    if (updated !== null) return;

    const latest = await sessions.get(args.sessionId);
    if (latest === null) {
      throw new NotFoundError(`AgentSession ${args.sessionId} not found.`);
    }
    const latestState = (latest.pairModeState as PairModeState | null) ?? initialPairModeState();
    if (
      args.takeoverClientId !== undefined &&
      (latestState.kind === 'takeover-pending' || latestState.kind === 'takeover-queued') &&
      latestState.requestedByClientId !== args.takeoverClientId
    ) {
      throw new PairModeConflictError(latestState.requestedByClientId);
    }
    throw new ConflictError(
      `AgentSession ${args.sessionId} pair-mode state changed concurrently; refresh before retrying.`,
    );
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
        // doc-150 item 6 — the HARD storage-quota gate that used to sit HERE moved
        // to AFTER the idempotency replay (#79), beside the proxy probe + active-
        // session cap, so a RETRIED create replays the cached 201 instead of newly
        // 409-ing on quota. Ownership validation (above) stays here — a foreign/
        // unknown profile_id is a clean 404 regardless of idempotency.
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
        // #15 — reject an undispatchable scheme at CREATE with a clear 400 instead
        // of letting the create 201 + then silently fail-closed at dispatch (which
        // left the GUI spinning 30s into a misleading "the proxy may be down"). Only
        // socks5/openvpn/wireguard resolve to an inline egress (account-proxies
        // resolveForDispatch); http has no dispatch slot yet. Surfacing it here (the
        // server is authoritative) gives the customer an instant, honest message.
        if (owned.scheme === 'http') {
          throw new BadRequestError(
            'HTTP proxies cannot drive a browser session yet — use a SOCKS5, OpenVPN, or WireGuard proxy.',
          );
        }
        // NOTE: the LIVE pre-launch probe is deliberately NOT run here. It runs
        // AFTER the idempotency replay short-circuit below, so a retry of an
        // already-succeeded create replays the cached 201 instead of re-probing
        // (idempotency must always replay success — re-probing could return a
        // fresh 422 for a session that already launched). See the gate call after
        // the idempotency block.
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
            //
            // Degrade-not-fail: a corrupted / rotated-but-not-rewrapped BYOK blob
            // (GCM auth failure) must NOT 500 the replay. Without the catch the
            // throw escapes the route → the create 500s on every retry AND leaks a
            // concurrency slot (the row already exists), locking the account out.
            // Match the socks5/DEK fail-closed degrade: log + skip the pre-warm —
            // the session replays fine, the AI just resolves its key lazily from
            // header / fallback at first use.
            try {
              const stored = await byokService.getPlaintext({
                accountId: ownerAccountId,
                now: new Date(),
              });
              if (stored !== null) byokKeyCache.set(existing.id, stored);
            } catch (err) {
              req.log.warn(
                { component: 'agent-session-create', sessionId: existing.id, err },
                'BYOK key hydration failed on idempotency replay; degrading to no cached key',
              );
            }
          }
          const livekit = await maybeMintLivekit(
            existing.id,
            ownerAccountId,
            ctx.account.region,
            existing.nodeId,
          );
          return reply
            .code(201)
            .send(
              publicAgentSession(
                existing,
                livekit,
                sessionLivenessStore,
                sessionCapabilityReportStore,
              ),
            );
        }
      }

      // S42 2026-07-07 (founder-approved) — V-485 aiAgent tier gate; the first
      // requireTierFeature call site. LLM-driven modes ('ai' — also the repo
      // default when mode is omitted — and 'pair') require the aiAgent feature
      // on the OWNER's tier, so free/solo_manual get the 403 tier error instead
      // of a session. mode:'manual' stays ungated: the GUI profile-launch path
      // creates manual sessions and manual driving IS the free/personal product.
      // Sits with the other create-time gates AFTER the idempotency replay
      // (replaying an already-succeeded 201 must never newly 403). Self-scoped
      // reads the tier already loaded on ctx (no extra lookup); team-scoped
      // resolves the owner tier via authRepo like the storage-quota gate below.
      if ((parsed.data.mode ?? 'ai') !== 'manual') {
        requireTierFeature(await resolveOwnerTier(ctx, effective), 'aiAgent');
      }

      // Founder directive #63 — TEST THE PROXY LIVE before we create a session row
      // or spin a worker. Placed AFTER the idempotency replay short-circuit above
      // (a retry of an already-succeeded create returns the cached 201 WITHOUT
      // re-probing — idempotency must always replay success, and re-probing could
      // return a fresh 422 for a session that already launched), and only on a
      // genuinely NEW create. We resolve the proxy (owner-scoped decrypt + SSRF
      // re-guard), then CONNECT THROUGH it to a neutral target + do a real egress
      // round-trip. A failed live test BLOCKS the launch with a clean 422 here —
      // BEFORE sessions.create + dispatchSessionAssignOnCreate — so a dead/
      // misconfigured proxy never dispatches a session that dead-ends at the box
      // (zero session row, zero simulator spin-up). The dispatch path keeps its own
      // resolve + SSRF re-guard as defense-in-depth; this gate is the pre-flight the
      // founder asked for.
      //
      // skip_proxy_probe:true is the GUI's "Launch anyway" override — the customer
      // saw the local probe flag the proxy and explicitly accepted the risk, so we
      // honor it and skip the gate for this launch (the dispatch re-guard still
      // applies). Only meaningful when a proxy_id was supplied.
      //
      // The `accountProxiesService !== undefined` check is structurally redundant
      // (proxyId is only ever set inside the proxy_id block, which already threw a
      // 404 when the service was unwired) — it's here so TypeScript narrows the
      // optional dep across the idempotency block this gate now sits after.
      if (
        proxyId !== undefined &&
        accountProxiesService !== undefined &&
        parsed.data.skip_proxy_probe !== true
      ) {
        await runProxyPrelaunchGate({
          probe: proxyConnectivityProbe,
          enabled: proxyPrelaunchProbeEnabled,
          accountProxiesService,
          proxyId,
          accountId: ownerAccountId,
          logger: req.log,
          // #128 — SET the observed exit identity here (keyed by owner+proxy) for
          // the later dispatch build to emit as exit_identity (new-tab IP panel).
          exitIdentityCache,
        });
      }

      // doc-150 item 6 — HARD per-account storage-quota gate (#79: relocated here from
      // the profile-validation block above, to sit AFTER the idempotency replay like
      // the proxy probe + active-session cap). A retry of an already-succeeded create
      // replays the cached 201 WITHOUT re-gating — idempotency must always replay
      // success; a profile-backed create that already launched must not newly 409 on
      // quota when re-sent. Only a genuinely NEW profile-backed create reaches here;
      // the dispatch mints the R2 sealed-blob save-back URL → bumps size_bytes, so we
      // refuse (409 storage_quota_exceeded) when the OWNER's aggregate size_bytes has
      // hit the tier hard cap. Owner-scoped (self = caller tier, team = owner's tier
      // via authRepo; enterprise soft-only — in the helper). The profilesService check
      // is structurally redundant (profileBareId is only set after the unwired 404
      // above) — it is for TS narrowing across the idempotency block.
      if (profileBareId !== undefined && profilesService !== undefined) {
        const ownerTier = await resolveOwnerTier(ctx, effective);
        await profilesService.assertWithinStorageQuotaForLaunch({
          accountId: ownerAccountId,
          tier: ownerTier,
        });
      }

      // #8 — per-account active-session cap. Placed AFTER the idempotency replay above
      // (a retry of an existing session already returned 201), so only a genuinely NEW
      // create is gated — bounds unbounded row creation + one account monopolising fleet
      // slots. Conservative fixed v1 ceiling; tier-derivation is a follow-up.
      //
      // Atomicity (audit #8 TOCTOU): the cap is enforced INSIDE
      // createIfUnderActiveCap — it counts active + inserts under a per-account
      // advisory xact lock, so N concurrent creates can't all read a stale count
      // and overshoot the cap. A null return means "already at/over the cap" →
      // the same 429 ConcurrencyLimitError shape as before.
      const MAX_ACTIVE_AGENT_SESSIONS_PER_ACCOUNT = 100;
      let created: AgentSessionRecord;
      try {
        const maybeCreated = await sessions.createIfUnderActiveCap(
          {
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
            // #14 (migration 0089) — record the profile this session runs so the
            // out-of-session trim can refuse a trim against a profile bound to a
            // live session (avoids a two-writer R2 lost-update on the sealed blob).
            ...(profileBareId !== undefined ? { profileId: profileBareId } : {}),
          },
          MAX_ACTIVE_AGENT_SESSIONS_PER_ACCOUNT,
        );
        if (maybeCreated === null) {
          throw new ConcurrencyLimitError(
            MAX_ACTIVE_AGENT_SESSIONS_PER_ACCOUNT,
            MAX_ACTIVE_AGENT_SESSIONS_PER_ACCOUNT,
          );
        }
        created = maybeCreated;
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
              // Degrade-not-fail (see the idempotency-replay path above): a
              // corrupted BYOK blob must not turn the unique-violation replay
              // into a 500 + leaked slot.
              try {
                const stored = await byokService.getPlaintext({
                  accountId: ownerAccountId,
                  now: new Date(),
                });
                if (stored !== null) byokKeyCache.set(winner.id, stored);
              } catch (err) {
                req.log.warn(
                  { component: 'agent-session-create', sessionId: winner.id, err },
                  'BYOK key hydration failed on idempotency-race replay; degrading to no cached key',
                );
              }
            }
            const livekit = await maybeMintLivekit(
              winner.id,
              ownerAccountId,
              ctx.account.region,
              winner.nodeId,
            );
            return reply
              .code(201)
              .send(
                publicAgentSession(
                  winner,
                  livekit,
                  sessionLivenessStore,
                  sessionCapabilityReportStore,
                ),
              );
          }
        }
        throw err;
      }
      // #3 — the concurrency slot is the just-created ACTIVE row. Everything from
      // here to the 201 response runs AFTER the slot is acquired; if any of it
      // throws (e.g. the post-dispatch sessions.get re-read hits a DB blip) the
      // row would stay 'active' forever — a phantom slot that counts against the
      // per-account cap until the 12h wall-clock reaper, so new launches get
      // refused / the GUI spins on "launching". Back the post-acquire window with
      // a try/catch that CLOSES the row (releases the slot) on any unexpected
      // throw before re-raising — mirroring the decrypt-fail-closed release path
      // (closeUnresolvedEgressSession) + the sessions-service dispatch-failure
      // release. The expected best-effort paths below (BYOK hydrate, dispatch,
      // livekit mint, audit) already swallow their own errors; this guards the
      // bare awaits + any future addition.
      try {
        // Q.1.c — decrypt the customer's stored BYOK key ONCE at
        // session-create and stash plaintext in the per-session cache.
        // Bounds AES-GCM unwrap to one operation per session.
        // v2-#21 — pass `now` so the TTL gate fires for stored keys
        // older than maxKeyAgeMs (90d default).
        if (byokService !== undefined && byokKeyCache !== undefined) {
          // Degrade-not-fail: a corrupted / rotated-but-not-rewrapped BYOK blob (GCM
          // auth failure) must NOT abort the create here — the row already committed,
          // so an uncaught throw 500s the response AND leaks the concurrency slot
          // (the row counts against the cap but the caller got no session id), which
          // locks the account out as corrupted keys keep failing every retry. Match
          // the socks5/DEK fail-closed degrade: log + skip the pre-warm. The session
          // still creates; the AI just resolves its key lazily (header / fallback)
          // on first use instead of from this cache.
          try {
            const stored = await byokService.getPlaintext({
              accountId: ownerAccountId,
              now: new Date(),
            });
            if (stored !== null) {
              byokKeyCache.set(created.id, stored);
            }
          } catch (err) {
            req.log.warn(
              { component: 'agent-session-create', sessionId: created.id, err },
              'BYOK key hydration failed at session create; degrading to no cached key',
            );
          }
        }
        // Fleet-CP session dispatch — hand the new session to a connected
        // harness node (local fleet-demo). No-op in prod (no registry); best-
        // effort (never throws) so it can't break session-create. Runs BEFORE the
        // viewer-token mint so the publisher dispatch picks the live box, persists
        // its node_id, and the viewer token below binds to that SAME box (multi-box
        // region fix — otherwise the token could point at the region-nearest box
        // while the publisher landed on an online sibling → black screen).
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
          // #128 — GET the exit identity the gate stashed above (same owner+proxy key)
          // and emit it as exit_identity for the box new-tab IP panel.
          ...(exitIdentityCache !== undefined ? { exitIdentityCache } : {}),
          ...(r2 !== undefined ? { r2 } : {}),
          // Worker-disconnect fix (2026-06-19) — persist session→node so the
          // disconnect reaper can free this node's slot if the node drops.
          agentSessions: sessions,
          // Region-aware dispatch (2026-06-21) — the viewer's home region so the
          // session routes to the nearest livekit node (EU box for EU customers);
          // falls back to any node when the home region has none.
          accountRegion: ctx.account.region,
          // Customer start URL from the create body — overrides the operator
          // default; omitted when absent so the fallback applies. The harness opens
          // this URL on session launch (inert until the box honors initialUrl).
          ...(parsed.data.initial_url !== undefined ? { initialUrl: parsed.data.initial_url } : {}),
          // Explicit geolocation override from the create body (A3-approved
          // contract 2026-07-01) — omitted when absent so the harness keeps its
          // exit-coherent proxy-IP auto-derive.
          ...(parsed.data.geolocation !== undefined
            ? { geolocation: parsed.data.geolocation }
            : {}),
          // Manual (GUI) sessions are interactively WATCHED — give them a generous idle
          // timeout AND a generous max-duration so a sim the operator watches without
          // touching isn't reaped at the box ~300s idle default, nor hard-killed at the
          // box ~1800s wall-clock default mid-use (A3 W2813 knob). ai/pair stay on the box
          // defaults (API-driven; bounded by token budget + the orphan reaper).
          ...(created.mode === 'manual'
            ? {
                idleTimeoutSeconds: MANUAL_SESSION_IDLE_TIMEOUT_SECONDS,
                maxDurationSeconds: MANUAL_SESSION_MAX_DURATION_SECONDS,
              }
            : {}),
        });
        // Viewer (subscriber) token — minted AFTER the dispatch so it binds to the
        // node the publisher actually landed on (the dispatch persists node_id to
        // the live box it picked). Re-read the row to pick up that persisted
        // node_id; fall back to `created` (node_id still NULL → region-nearest, same
        // as before) when the re-read misses or the dispatch wiring is inert (prod —
        // node_id stays NULL and maybeMintLivekit no-ops anyway). A dispatch that
        // honestly closed the row (no live node) re-reads a closed row; the viewer
        // token is then harmless (the GUI sees status='closed' and never joins).
        const dispatched = (await sessions.get(created.id)) ?? created;
        const livekit = await maybeMintLivekit(
          created.id,
          ownerAccountId,
          ctx.account.region,
          dispatched.nodeId,
        );
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
        return reply
          .code(201)
          .send(
            publicAgentSession(
              dispatched,
              livekit,
              sessionLivenessStore,
              sessionCapabilityReportStore,
            ),
          );
      } catch (err) {
        // #3 — release the phantom 'active' slot: the row was created (slot
        // acquired) but the create couldn't be completed, so close it so it stops
        // counting against the per-account cap. Best-effort + idempotent
        // (closeWithReason keeps the first close's timestamp); a close failure
        // must not mask the original error — the 12h reaper remains the backstop.
        await closeUnresolvedEgressSession(sessions, created.id, req.log, 'create_failed');
        throw err;
      }
    },
  );

  // 2026-05-22 — list customer's agent sessions, newest first. Used
  // by the dashboard's /agent-sessions page to render a history.
  // Returns the public envelope (no transcript inline; the detail
  // route serves that). Cursor-paginated on (created_at, id) desc —
  // the standard `{ data, has_more, next_cursor }` envelope shared by
  // /v1/sessions et al., so a busy account can page its full AI-session
  // history (was hard-capped at 100 with no cursor — older sessions
  // were unreachable via the API/SDK entirely).
  // #122 — read:sessions floor. Mirrors the driver-session list route
  // (GET /v1/sessions, gated read:sessions in SessionsService.list()) +
  // the single-agent-session reads above: agent-session listing is a
  // pure read of session data, so it takes the same granular read floor.
  // This route has no per-session gui_control_key path (it isn't
  // :id-scoped), so it uses the plain account-auth chain. Broad `read` /
  // `account_owner` bearers satisfy the granular scope (V-481), so the
  // dashboard /agent-sessions page + existing broad keys are unaffected.
  // Team-workspace parity: create and every :id route already authorize an
  // owner-scoped agent session for an admin membership. Resolve the collection
  // through the same X-Driftstack-Account context so that admin can also find
  // those sessions in history. Agent sessions contain transcripts + live
  // control state, so retain the established admin-only boundary here rather
  // than widening collection reads to ordinary read-only team members.
  app.get(
    '/v1/agent-sessions',
    { preHandler: [app.requireAuth, app.requireScope('read:sessions'), app.rateLimit('global')] },
    async (req) => {
      const ctx = requireCtx(req);
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(req));
      if (effective.kind === 'team' && effective.role !== 'admin') {
        throw new ForbiddenError(
          'Reading agent sessions on a team owner requires admin role on that team.',
        );
      }
      const query = PaginationQuerySchema.parse(req.query ?? {});
      const page = await sessions.listPageByAccount(effective.accountId, {
        limit: query.limit,
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      });
      return {
        data: page.items.map((rec) =>
          publicAgentSession(rec, undefined, sessionLivenessStore, sessionCapabilityReportStore),
        ),
        has_more: page.nextCursor !== null,
        next_cursor: page.nextCursor,
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/agent-sessions/:id',
    // Control-auth path (b): a valid per-session gui_control_key reads
    // ONLY this `:id` session (the route is already `/:id`-scoped). The
    // read:sessions is the floor for the account path here (#122 —
    // granular; broad `read` / `account_owner` still satisfy it).
    { preHandler: [controlKeyOrAccountAuth('read:sessions'), app.rateLimit('global')] },
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
      return publicAgentSession(rec, undefined, sessionLivenessStore, sessionCapabilityReportStore);
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
    // live URL never appeared). read:sessions is the floor for the account path.
    { preHandler: [controlKeyOrAccountAuth('read:sessions'), app.rateLimit('global')] },
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
      // Audit 2026-07-01 (MEDIUM) — a session that ended via a path OTHER than
      // the customer DELETE (worker-disconnect grace / 12h orphan backstop —
      // see those services' own comments) may never have had its cached
      // pageState evicted, so without this check a dead session's LAST
      // reported state (possibly 'stalled', the exact frozen-renderer signal
      // this feature exists to detect) would be served indefinitely. `status`
      // is the one field EVERY termination path (DELETE / terminal-close /
      // worker-disconnect / orphan-sweep) already flips atomically, making it
      // the authoritative, single chokepoint — cheaper and more robust than
      // relying on each closer to remember to evict this store. 'paused' (a
      // bot-challenge auto-pause) is NOT terminal, so it still reads through.
      if (rec.status === 'closed') {
        return { page_state: null };
      }
      // Age-bounded read: independent defense-in-depth on top of the `status`
      // check above (which is the one that actually closes the async
      // store-repopulation race in session-page-state-relay.ts — a
      // re-populated entry gets a FRESH receivedAt, so the age bound alone
      // would NOT catch it; the next poll's `rec.status === 'closed'` does).
      // This bound instead covers a still-'active'/'paused' row whose cached
      // entry is implausibly old for some OTHER reason (a dropped final frame
      // the store was never told about, a future closer that forgets to
      // flip `status` promptly, …) — mirrors the store's own documented
      // tolerance ("at worst the overlay shows nothing until the next
      // navigate"), so clearing a stale-but-technically-active entry is safe.
      const maxAgeMs = resolvePageStateMaxAgeSeconds() * 1000;
      return { page_state: sessionPageStateStore?.getFresh(req.params.id, maxAgeMs) ?? null };
    },
  );

  // Founder #48 — live cookie-jar view for the simulator drawer. PULLs the
  // running session's full cookie jar (incl. httpOnly) over the node's live
  // control WSS via the connection's CookiesRequestCorrelator (cookiesRequest →
  // cookiesResult, A2 W2816 / A3 W2817). Returns a DISCRIMINATED body (200 in
  // every case) — mirroring GET /:id/page-state's "null when not wired" style —
  // so the GUI Cookies panel renders without treating expected-inert states as
  // HTTP errors (avoids Sentry noise while A3's harness `getAllCookies`
  // WD-extension is pending; until it lands, a wired+live request resolves
  // `timeout`, which the drawer shows as "pending data source").
  //   status:'ok'          → cookies: Cookie[]   (the live jar)
  //   status:'unavailable' → cookies: null       (not wired / not live / node offline)
  //   status:'timeout'     → cookies: null       (node didn't reply — A3 handler pending)
  //   status:'error'       → cookies: null        (node reported a failure OR the account
  //                                                is at its concurrent-relay cap; reason set)
  // Security-audit hardening (2026-06-30): now carries the SAME per-account
  // concurrent-relay cap (reserveRelaySlot) as the sibling relay routes below.
  app.get<{ Params: { id: string } }>(
    '/v1/agent-sessions/:id/cookies',
    // Same control-auth path as GET /:id/page-state: the SEPARATE Simulator app
    // has only a per-session gui_control_key, not an account Bearer key.
    // read:sessions is the floor for the account path.
    { preHandler: [controlKeyOrAccountAuth('read:sessions'), app.rateLimit('global')] },
    async (req) => {
      const rec = await sessions.get(req.params.id);
      if (rec === null) {
        throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
      }
      // Account path: enforce ownership. Control-key path: already decrypt-matched
      // against THIS `:id` session in the preHandler (same as GET /:id).
      if (req.guiControlKeyAuthorized !== true) {
        const ctx = requireCtx(req);
        if (!callerCanAccessAgentSession(ctx, rec.accountId)) {
          throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
        }
      }
      // Control plane not wired (stateless deploy / no fleet registry).
      if (fleetControlRegistry === undefined) {
        return {
          cookies: null,
          status: 'unavailable' as const,
          reason: 'fleet control plane not enabled',
        };
      }
      // Cookies are read LIVE from the running session's jar — a closed or
      // never-dispatched session has none to read.
      if (rec.status !== 'active' || rec.nodeId === null || rec.nodeId === undefined) {
        return {
          cookies: null,
          status: 'unavailable' as const,
          reason: 'session is not live on a node',
        };
      }
      // The registry is keyed by the authed node_id (the JWT iss) — the same id
      // persisted to agent_sessions.node_id on dispatch — so resolve directly.
      const conn = fleetControlRegistry.get(rec.nodeId);
      if (conn === undefined) {
        return {
          cookies: null,
          status: 'unavailable' as const,
          reason: 'session node is not connected',
        };
      }
      // Security-audit hardening (2026-06-30, MEDIUM) — this route has the exact
      // same live-WSS-round-trip-with-10s-hang shape as the four sibling relay
      // routes below (cookies/set, history, downloads list, downloads content),
      // which already carry this per-account CONCURRENT-relay cap; without it an
      // account could burst up to its rate-limit bucket's full capacity of
      // concurrent cookie-GET requests, each pinning a correlator entry + open
      // connection + live WSS frame for up to 10s. Reserve before the await,
      // release in the finally (any outcome) — mirroring the sibling routes.
      const releaseRelay = reserveRelaySlot(rec.accountId);
      if (releaseRelay === null) {
        return { cookies: null, status: 'error' as const, reason: RELAY_BUSY_REASON };
      }
      try {
        const outcome = await conn.requestCookies(randomUUID(), rec.id);
        if (outcome.status === 'ok') {
          return { cookies: outcome.cookies, status: 'ok' as const };
        }
        if (outcome.status === 'error') {
          return {
            cookies: null,
            status: 'error' as const,
            reason: customerSafeNodeDiagnostic(outcome.message),
          };
        }
        return { cookies: null, status: 'timeout' as const };
      } finally {
        releaseRelay();
      }
    },
  );

  // Hardening (2026-06-24, LOW defense-in-depth; widened 2026-06-30 to a 5th
  // route) — per-ACCOUNT cap on the number of CONCURRENT in-flight control-relay
  // requests. GET /:id/cookies ABOVE + the four relay routes below (cookies/set,
  // history, downloads list, downloads content) carry only the `global` RATE
  // limiter, which bounds requests/window but NOT how many handlers can
  // simultaneously be awaiting a 10–30s relay — so one account could burst
  // dozens of concurrent handlers, each pinning a correlator slot + an HTTP
  // connection for the whole relay timeout. This shared per-account COUNT limiter
  // sheds the (cap+1)-th request with a discriminated busy outcome BEFORE relaying.
  // Reserve on accept (reserveRelaySlot), release in the route's finally regardless
  // of outcome. In-memory per-instance (prod = single node; a multi-instance deploy
  // would move this to Redis), mirroring the upload byte cap above. Default 16,
  // test-injectable via deps.relayMaxAccountInFlight so a unit test trips it at 1–2.
  // (reserveRelaySlot is a hoisted function declaration, so GET /:id/cookies above
  // — textually earlier in this file — can already call it; both are defined
  // before any request handler actually runs.)
  const RELAY_MAX_ACCOUNT_INFLIGHT = relayMaxAccountInFlight;
  const accountRelayInFlight = new Map<string, number>();
  /** Reserve one concurrent-relay slot for `acct`. Returns a `release()` (decrement;
   *  delete at 0) when under the cap, or `null` when the account is already at the
   *  cap (caller returns its route-specific busy outcome WITHOUT relaying). */
  function reserveRelaySlot(acct: string): (() => void) | null {
    const inFlight = accountRelayInFlight.get(acct) ?? 0;
    if (inFlight >= RELAY_MAX_ACCOUNT_INFLIGHT) return null;
    accountRelayInFlight.set(acct, inFlight + 1);
    return () => {
      const cur = accountRelayInFlight.get(acct) ?? 1;
      const next = cur - 1;
      if (next <= 0) accountRelayInFlight.delete(acct);
      else accountRelayInFlight.set(acct, next);
    };
  }
  // The discriminated reason the five routes surface when the account is at its
  // concurrent-relay cap (shared so the GUI/clients see one consistent message).
  const RELAY_BUSY_REASON = 'too many concurrent requests for this account — retry shortly';

  // A download fetch is qualitatively larger than the other relays above: one
  // contract-valid 64 MiB file arrives as ~85.3 MiB of base64 JSON, then exists
  // simultaneously as raw WebSocket bytes, a UTF-8 string, parsed data, and an
  // HTTP response. The shared count cap of 16 bounds correlator/handler count but
  // would still admit gigabyte-scale retained memory for one authenticated
  // account. Keep only ONE large fetch in flight per account. Lightweight list,
  // cookie, and history relays remain independently usable while it runs.
  //
  // This is intentionally in-memory like accountRelayInFlight: production is a
  // single API process today. A multi-instance deployment must move both guards
  // to the same shared reservation store.
  const accountDownloadFetchInFlight = new Set<string>();
  function reserveDownloadFetchSlot(acct: string): (() => void) | null {
    if (accountDownloadFetchInFlight.has(acct)) return null;
    accountDownloadFetchInFlight.add(acct);
    return () => accountDownloadFetchInFlight.delete(acct);
  }
  const DOWNLOAD_FETCH_BUSY_REASON =
    'another file download is already in progress for this account — retry when it finishes';

  // Cookie-IMPORT — the WRITE-twin of GET /:id/cookies. Relays a customer's exported
  // jar (the EXACT CookieSchema shape the read/Export emits — a cookies.json
  // round-trips 1:1) into the running session's cookie store over the node's live
  // control WSS (setCookies → setCookiesResult). Returns a DISCRIMINATED 200 body in
  // every relay case (ok / unavailable / timeout / error), mirroring the upload route,
  // so the GUI renders expected-inert states without HTTP-error noise. Malformed body
  // (not an array of cookies) is a 422. Ships gated-inert until A3's harness setCookies
  // WD-extension lands: until then a live node never replies → status:'timeout', which
  // the GUI surfaces — and a not-live/offline session → status:'unavailable'.
  //   status:'ok'          → write applied
  //   status:'unavailable' → not wired / not live / node offline
  //   status:'timeout'     → node didn't reply (A3 handler pending)
  //   status:'error'       → node reported a failure (reason set)
  // Fastify defaults to a 1 MiB JSON body. A legit token-heavy jar (up to the schema's
  // .max(2000) cookies with ~KB session-token values) can exceed that and 413 BEFORE the
  // handler/Zod run — breaking the discriminated-200/clean-422 contract + making .max(2000)
  // unreachable. Raise to the schema's worst case (mirrors the sibling upload route).
  const SET_COOKIES_MAX_BODY_BYTES = 8 * 1024 * 1024;
  const SetCookiesBodySchema = z.object({
    // The customer's exported jar — same CookieSchema the read/Export emits, so a
    // round-tripped cookies.json validates with no divergent shape. A bounded count
    // keeps one request from flooding the box (a real jar is well under this).
    cookies: z.array(CookieSchema).min(1).max(2000),
  });
  app.post<{ Params: { id: string } }>(
    '/v1/agent-sessions/:id/cookies/set',
    // Import is a WRITE (it mutates the session's cookie store). Same control-auth
    // path as the upload route: the separate Simulator app holds only a per-session
    // gui_control_key, not an account Bearer.
    {
      preHandler: [controlKeyOrAccountAuth('write'), app.rateLimit('global')],
      bodyLimit: SET_COOKIES_MAX_BODY_BYTES,
    },
    async (req) => {
      const rec = await sessions.get(req.params.id);
      if (rec === null) {
        throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
      }
      // Account path: enforce ownership. Control-key path: already decrypt-matched
      // against THIS `:id` in the preHandler (same as POST /:id/files).
      if (req.guiControlKeyAuthorized !== true) {
        const ctx = requireCtx(req);
        if (!callerCanAccessAgentSession(ctx, rec.accountId)) {
          throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
        }
      }
      const parsed = SetCookiesBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      // Control plane not wired (stateless deploy / no fleet registry).
      if (fleetControlRegistry === undefined) {
        return {
          status: 'unavailable' as const,
          reason: 'fleet control plane not enabled',
        };
      }
      // The write targets the LIVE session's cookie store — a closed or
      // never-dispatched session has none.
      if (rec.status !== 'active' || rec.nodeId === null || rec.nodeId === undefined) {
        return {
          status: 'unavailable' as const,
          reason: 'session is not live on a node',
        };
      }
      const conn = fleetControlRegistry.get(rec.nodeId);
      if (conn === undefined) {
        return {
          status: 'unavailable' as const,
          reason: 'session node is not connected',
        };
      }
      // Hardening: shed the request (discriminated error, no relay) when this
      // account already has RELAY_MAX_ACCOUNT_INFLIGHT relays awaiting; otherwise
      // reserve a slot and release it in the finally (any outcome).
      const releaseRelay = reserveRelaySlot(rec.accountId);
      if (releaseRelay === null) {
        return { status: 'error' as const, reason: RELAY_BUSY_REASON };
      }
      try {
        const outcome = await conn.setCookies(randomUUID(), rec.id, parsed.data.cookies);
        if (outcome.status === 'ok') {
          return { status: 'ok' as const };
        }
        if (outcome.status === 'error') {
          return {
            status: 'error' as const,
            reason: customerSafeNodeDiagnostic(outcome.message),
          };
        }
        return { status: 'timeout' as const };
      } finally {
        releaseRelay();
      }
    },
  );

  // Sim browser back/forward (A3 W2870). Steps the running session's WebKit
  // back-forward list one entry in `direction` over the node's live control WSS
  // (navigateHistory → navigateHistoryResult). Returns a DISCRIMINATED 200 body in
  // every relay case (ok / unavailable / timeout / error), mirroring the cookies-import
  // route, so the GUI's back/forward buttons render expected-inert states without
  // HTTP-error noise. Malformed body (direction not 'back'|'forward') is a 422. Ships
  // gated-inert until A3's harness navigateHistory WD-extension lands: until then a live
  // node never replies → status:'timeout', which the GUI surfaces — and a not-live /
  // offline session → status:'unavailable'.
  //   status:'ok'          → step applied
  //   status:'unavailable' → not wired / not live / node offline
  //   status:'timeout'     → node didn't reply (A3 handler pending)
  //   status:'error'       → node reported a failure (reason set)
  const NavigateHistoryBodySchema = z.object({
    // The only two history steps; the closed enum mirrors the wire schema.
    direction: z.enum(['back', 'forward']),
    // Optional (multi-tab): which tab's back-forward list to step. Omitted →
    // the session's current tab (today's only behavior, unchanged). Gated-inert
    // like navigateHistory itself until A3's harness reads it.
    tabId: z.string().optional(),
  });
  app.post<{ Params: { id: string } }>(
    '/v1/agent-sessions/:id/history',
    // A history step drives the LIVE session (state-changing). Same control-auth path
    // as the cookies-import route: the separate Simulator app holds only a per-session
    // gui_control_key, not an account Bearer.
    {
      preHandler: [controlKeyOrAccountAuth('write'), app.rateLimit('global')],
    },
    async (req) => {
      const rec = await sessions.get(req.params.id);
      if (rec === null) {
        throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
      }
      // Account path: enforce ownership. Control-key path: already decrypt-matched
      // against THIS `:id` in the preHandler (same as POST /:id/cookies/set).
      if (req.guiControlKeyAuthorized !== true) {
        const ctx = requireCtx(req);
        if (!callerCanAccessAgentSession(ctx, rec.accountId)) {
          throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
        }
      }
      const parsed = NavigateHistoryBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      // Control plane not wired (stateless deploy / no fleet registry).
      if (fleetControlRegistry === undefined) {
        return {
          status: 'unavailable' as const,
          reason: 'fleet control plane not enabled',
        };
      }
      // The step targets the LIVE session — a closed or never-dispatched session
      // has no back-forward list to drive.
      if (rec.status !== 'active' || rec.nodeId === null || rec.nodeId === undefined) {
        return {
          status: 'unavailable' as const,
          reason: 'session is not live on a node',
        };
      }
      const conn = fleetControlRegistry.get(rec.nodeId);
      if (conn === undefined) {
        return {
          status: 'unavailable' as const,
          reason: 'session node is not connected',
        };
      }
      // Hardening: per-account concurrent-relay cap (reserve before the await,
      // release in the finally; shed with a discriminated error when at the cap).
      const releaseRelay = reserveRelaySlot(rec.accountId);
      if (releaseRelay === null) {
        return { status: 'error' as const, reason: RELAY_BUSY_REASON };
      }
      try {
        const outcome = await conn.navigateHistory(
          randomUUID(),
          rec.id,
          parsed.data.direction,
          undefined,
          parsed.data.tabId,
        );
        if (outcome.status === 'ok') {
          return { status: 'ok' as const };
        }
        if (outcome.status === 'error') {
          return {
            status: 'error' as const,
            reason: customerSafeNodeDiagnostic(outcome.message),
          };
        }
        return { status: 'timeout' as const };
      } finally {
        releaseRelay();
      }
    },
  );

  // File-control upload (A3 W2851 / founder "control files"). Relays the customer's
  // file bytes (base64) into the running session's isolated 0o700 upload jail over
  // the node's live control WSS (uploadFile → uploadResult), returning an OPAQUE
  // handle {id,name,mime,size} the GUI uses to drive a page's <input type=file> —
  // the harness maps id→jailed path internally; a worker disk path is NEVER exposed.
  // Mirrors POST semantics of the cookies pull: same control-auth + ownership, a
  // DISCRIMINATED 200 body in every relay case (ok / unavailable / timeout / error)
  // so the GUI renders expected-inert states without HTTP-error noise. Client-side
  // validation failures (malformed body / empty / >64 MiB) are 400s.
  const UPLOAD_MAX_FILE_BYTES = 64 * 1024 * 1024; // harness cap (W2851)
  // 64 MiB raw → ~85.4 MiB base64; allow that + the JSON envelope with margin.
  // Beyond this Fastify 413s before the handler; the handler is the authoritative
  // 64-MiB-decoded enforcer.
  const UPLOAD_MAX_BODY_BYTES = 96 * 1024 * 1024;
  // Founder safeguard (2026-06-24): per-ACCOUNT cap on CONCURRENT in-flight upload
  // volume (512 MB default), independent of the 64 MiB per-file cap — so one account
  // can't flood the box/jail with many large simultaneous uploads. Tracked in-memory
  // per-instance (prod = single node; a multi-instance deploy would move this to
  // Redis). Reserved on accept, released in the relay's finally (any outcome). The
  // threshold is config-sourced (AGENT_UPLOAD_MAX_ACCOUNT_INFLIGHT_BYTES; default
  // 512 MB) + test-injectable via deps.uploadMaxAccountInFlightBytes.
  // The byte reservation is taken on the ENCODED (base64) length BEFORE decoding, so
  // the cap is consulted before a large copy is materialised (hardening 2026-06-24).
  const UPLOAD_MAX_ACCOUNT_INFLIGHT_BYTES = uploadMaxAccountInFlightBytes;
  const accountUploadInFlightBytes = new Map<string, number>();
  // Hardening (2026-06-24, LOW defense-in-depth): per-ACCOUNT cap on the NUMBER of
  // CONCURRENT in-flight uploads, alongside the byte cap — so a flood of small
  // uploads can't pin many correlator slots at once even while well under 512 MB.
  // Reserved/released in the SAME finally as the byte reservation. Default 4,
  // test-injectable via deps.uploadMaxAccountInFlightCount.
  const UPLOAD_MAX_ACCOUNT_INFLIGHT_COUNT = uploadMaxAccountInFlightCount;
  const accountUploadInFlightCount = new Map<string, number>();
  // Security-audit hardening (2026-06-30, MEDIUM) — persisted per-SESSION
  // LIFETIME cap, distinct from the per-account CONCURRENT caps above (those
  // release the instant each individual upload settles, so a strictly-
  // sequential caller — one upload at a time, never crossing the concurrent
  // ceiling — could otherwise push unbounded total volume through a single
  // session). Keyed by SESSION id (rec.id), not account id: this is a
  // per-session-lifetime ceiling, independent of the cross-session per-account
  // profile-storage quota (doc-150 item 6 / profile-storage-quota.ts). Only
  // ever incremented (never released) on a successful relay, so it reflects
  // the session's true lifetime upload total.
  const SESSION_UPLOAD_MAX_LIFETIME_BYTES = sessionUploadMaxLifetimeBytes;
  const sessionUploadLifetimeBytes = new Map<string, number>();
  const SESSION_UPLOAD_MAX_LIFETIME_COUNT = sessionUploadMaxLifetimeCount;
  const sessionUploadLifetimeCount = new Map<string, number>();
  // Bound (review follow-up, 2026-07-01): unlike the concurrent-cap maps above
  // (released per-request) and sessionPageStateStore/SessionLivenessStore
  // (both LRU-capped + evicted on close), these two lifetime counters are
  // deleted on close ONLY along the customer-DELETE path (below) — a session
  // reaped by worker-disconnect / the 12h orphan sweep leaves its entry
  // orphaned forever (those bulk closers only get a row count back, same
  // known gap as the page-state store's own comment). Without a cap this pair
  // of maps grows without bound for the life of the process. Oldest-evicted
  // (insertion order, same pattern as the sibling stores) once either map
  // would exceed this; both maps always share the same key set (always
  // written together below), so evicting by one's iteration order keeps them
  // in sync. A false-cleared counter only ever WIDENS a session's remaining
  // lifetime allowance — never a security regression, just a soft best-effort
  // cap like the account-level concurrent maps already are.
  const SESSION_UPLOAD_LIFETIME_MAX_TRACKED_SESSIONS = 20_000;
  const UploadFileBodySchema = z.object({
    name: z.string().min(1).max(255),
    mime: z.string().min(1).max(255),
    dataB64: z.string().min(1),
  });
  app.post<{ Params: { id: string } }>(
    '/v1/agent-sessions/:id/files',
    // Upload is a WRITE (it mutates the session's upload jail). Same control-auth
    // path as the cookies pull: the separate Simulator app holds only a per-session
    // gui_control_key, not an account Bearer.
    {
      preHandler: [controlKeyOrAccountAuth('write'), app.rateLimit('global')],
      bodyLimit: UPLOAD_MAX_BODY_BYTES,
    },
    async (req) => {
      const rec = await sessions.get(req.params.id);
      if (rec === null) {
        throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
      }
      // Account path: enforce ownership. Control-key path: already decrypt-matched
      // against THIS `:id` in the preHandler (same as GET /:id/cookies).
      if (req.guiControlKeyAuthorized !== true) {
        const ctx = requireCtx(req);
        if (!callerCanAccessAgentSession(ctx, rec.accountId)) {
          throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
        }
      }
      const parsed = UploadFileBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.flatten());
      // Founder safeguard + hardening: reject when this upload would push the
      // account past its CONCURRENT in-flight upload BYTE cap (512 MB) OR its
      // concurrent-upload COUNT cap — a discriminated error so the GUI shows the
      // reason, not an HTTP-error. The cap is consulted on the ENCODED (base64)
      // length (parsed.data.dataB64.length) BEFORE the Buffer.from decode below, so
      // a large decoded copy is never materialised for an upload that's already over
      // the ceiling. Reserve here; release BOTH counters in the finally regardless of
      // outcome (the discriminated unavailable/empty/relay returns all run inside the
      // try so the reservation is always freed). Reserving before the fleet/decode
      // checks keeps the empty-file 400 winning over the unavailable states (the
      // existing contract), since both run inside the try with the empty check first.
      const acct = rec.accountId;
      const reserveBytes = parsed.data.dataB64.length;
      const inFlightBytes = accountUploadInFlightBytes.get(acct) ?? 0;
      const inFlightCount = accountUploadInFlightCount.get(acct) ?? 0;
      if (inFlightBytes + reserveBytes > UPLOAD_MAX_ACCOUNT_INFLIGHT_BYTES) {
        return {
          handle: null,
          status: 'error' as const,
          reason:
            'account upload limit reached: at most 512 MB of uploads in flight at once — wait for in-progress uploads to finish',
        };
      }
      if (inFlightCount + 1 > UPLOAD_MAX_ACCOUNT_INFLIGHT_COUNT) {
        return {
          handle: null,
          status: 'error' as const,
          reason:
            'account upload limit reached: too many concurrent uploads in flight — wait for in-progress uploads to finish',
        };
      }
      // Security-audit hardening (2026-06-30, MEDIUM): the CONCURRENT caps above
      // bound in-flight volume at any instant, but release the instant each
      // upload settles — so a caller issuing uploads ONE AT A TIME never trips
      // them no matter how much total volume it pushes through this session.
      // This SEPARATE, never-released, per-SESSION lifetime cap closes that gap.
      // Checked before reserving the concurrent-cap maps above so a
      // lifetime-rejected request never touches (or needs to release) them.
      const lifetimeBytes = sessionUploadLifetimeBytes.get(rec.id) ?? 0;
      const lifetimeCount = sessionUploadLifetimeCount.get(rec.id) ?? 0;
      if (lifetimeBytes + reserveBytes > SESSION_UPLOAD_MAX_LIFETIME_BYTES) {
        return {
          handle: null,
          status: 'error' as const,
          reason:
            'session upload limit reached: at most 2 GiB of total uploads per session — start a new session to upload more',
        };
      }
      if (lifetimeCount + 1 > SESSION_UPLOAD_MAX_LIFETIME_COUNT) {
        return {
          handle: null,
          status: 'error' as const,
          reason: 'session upload limit reached: too many files uploaded in this session',
        };
      }
      accountUploadInFlightBytes.set(acct, inFlightBytes + reserveBytes);
      accountUploadInFlightCount.set(acct, inFlightCount + 1);
      try {
        // Decode to validate base64 + enforce the 64 MiB cap on the DECODED size
        // (a client error → 400, NOT a discriminated relay status). Buffer.from is
        // lenient (tolerates whitespace-wrapped base64); re-encoding to clean base64
        // for the wire guarantees the harness's strict decoder accepts it. The empty
        // + too-large 400s are checked FIRST (before the unavailable states) so a
        // malformed client payload always 400s, never masquerades as an inert relay
        // status — and the in-flight reservation above is already freed by the finally.
        const bytes = Buffer.from(parsed.data.dataB64, 'base64');
        if (bytes.length === 0) {
          throw new BadRequestError('Uploaded file is empty (dataB64 decoded to 0 bytes).');
        }
        if (bytes.length > UPLOAD_MAX_FILE_BYTES) {
          throw new BadRequestError('Uploaded file is too large. Max 64 MiB.');
        }
        // Control plane not wired (stateless deploy / no fleet registry).
        if (fleetControlRegistry === undefined) {
          return {
            handle: null,
            status: 'unavailable' as const,
            reason: 'fleet control plane not enabled',
          };
        }
        // The upload targets the LIVE session's jail — a closed or never-dispatched
        // session has none.
        if (rec.status !== 'active' || rec.nodeId === null || rec.nodeId === undefined) {
          return {
            handle: null,
            status: 'unavailable' as const,
            reason: 'session is not live on a node',
          };
        }
        const conn = fleetControlRegistry.get(rec.nodeId);
        if (conn === undefined) {
          return {
            handle: null,
            status: 'unavailable' as const,
            reason: 'session node is not connected',
          };
        }
        const outcome = await conn.requestUpload(
          randomUUID(),
          rec.id,
          parsed.data.name,
          parsed.data.mime,
          bytes.toString('base64'),
        );
        if (outcome.status === 'ok') {
          // Security-audit hardening (2026-06-30, MEDIUM): only a SUCCESSFUL
          // relay counts against the session's lifetime total — an error/
          // timeout wrote nothing to the jail, so it must not consume the cap.
          // NEVER released (unlike the concurrent-cap maps in the finally
          // below): this is a true running total for the session's lifetime.
          sessionUploadLifetimeBytes.set(rec.id, lifetimeBytes + reserveBytes);
          sessionUploadLifetimeCount.set(rec.id, lifetimeCount + 1);
          if (sessionUploadLifetimeBytes.size > SESSION_UPLOAD_LIFETIME_MAX_TRACKED_SESSIONS) {
            const oldest = sessionUploadLifetimeBytes.keys().next().value;
            if (oldest !== undefined) {
              sessionUploadLifetimeBytes.delete(oldest);
              sessionUploadLifetimeCount.delete(oldest);
            }
          }
          return { handle: outcome.handle, status: 'ok' as const };
        }
        if (outcome.status === 'error') {
          return {
            handle: null,
            status: 'error' as const,
            reason: customerSafeNodeDiagnostic(outcome.message),
          };
        }
        return { handle: null, status: 'timeout' as const };
      } finally {
        const curBytes = accountUploadInFlightBytes.get(acct) ?? reserveBytes;
        const nextBytes = curBytes - reserveBytes;
        if (nextBytes <= 0) accountUploadInFlightBytes.delete(acct);
        else accountUploadInFlightBytes.set(acct, nextBytes);
        const curCount = accountUploadInFlightCount.get(acct) ?? 1;
        const nextCount = curCount - 1;
        if (nextCount <= 0) accountUploadInFlightCount.delete(acct);
        else accountUploadInFlightCount.set(acct, nextCount);
      }
    },
  );

  // File-control download LIST (A3 W2856 / founder "control files"). Lists the files
  // a page wrote into the session's isolated 0o700 download jail (never ~/Downloads).
  // Read-scope; SAME control-auth + ownership + discriminated-200 shape as GET
  // /:id/cookies. `files: []` (status ok) = "no downloads yet" (jail empty until the
  // fork download-delegate populates it). Names are bare basenames, never paths.
  app.get<{ Params: { id: string } }>(
    '/v1/agent-sessions/:id/downloads',
    { preHandler: [controlKeyOrAccountAuth('read:sessions'), app.rateLimit('global')] },
    async (req) => {
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
      if (fleetControlRegistry === undefined) {
        return {
          files: null,
          status: 'unavailable' as const,
          reason: 'fleet control plane not enabled',
        };
      }
      if (rec.status !== 'active' || rec.nodeId === null || rec.nodeId === undefined) {
        return {
          files: null,
          status: 'unavailable' as const,
          reason: 'session is not live on a node',
        };
      }
      const conn = fleetControlRegistry.get(rec.nodeId);
      if (conn === undefined) {
        return {
          files: null,
          status: 'unavailable' as const,
          reason: 'session node is not connected',
        };
      }
      // Hardening: per-account concurrent-relay cap (reserve before the await,
      // release in the finally; shed with a discriminated error when at the cap).
      const releaseRelay = reserveRelaySlot(rec.accountId);
      if (releaseRelay === null) {
        return { files: null, status: 'error' as const, reason: RELAY_BUSY_REASON };
      }
      try {
        const outcome = await conn.requestDownloadList(randomUUID(), rec.id);
        if (outcome.status === 'list') {
          return { files: outcome.files, status: 'ok' as const };
        }
        if (outcome.status === 'error') {
          return {
            files: null,
            status: 'error' as const,
            reason: customerSafeNodeDiagnostic(outcome.message),
          };
        }
        if (outcome.status === 'data') {
          // A fetch reply for a list request — never expected; treat as a failure.
          return {
            files: null,
            status: 'error' as const,
            reason: 'unexpected data frame for list request',
          };
        }
        return { files: null, status: 'timeout' as const };
      } finally {
        releaseRelay();
      }
    },
  );

  // File-control download FETCH (A3 W2856). The compatibility default is the
  // original discriminated JSON/base64 envelope. Desktop callers opt into
  // `format=binary` so the 64 MiB contract does not expand into an ~85 MiB JSON
  // string and then duplicate itself through JSON.parse + atob in the WebView.
  // Expected relay failures remain small discriminated JSON in either mode.
  const DownloadFetchQuerySchema = z.object({
    name: z.string().min(1).max(255),
    format: z.enum(['json', 'binary']).optional().default('json'),
  });
  app.get<{
    Params: { id: string };
    Querystring: { name?: string; format?: 'json' | 'binary' };
  }>(
    '/v1/agent-sessions/:id/downloads/content',
    { preHandler: [controlKeyOrAccountAuth('read:sessions'), app.rateLimit('global')] },
    async (req, reply) => {
      const q = DownloadFetchQuerySchema.safeParse(req.query ?? {});
      if (!q.success) throw new ValidationError(q.error.flatten());
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
      if (fleetControlRegistry === undefined) {
        return {
          file: null,
          status: 'unavailable' as const,
          reason: 'fleet control plane not enabled',
        };
      }
      if (rec.status !== 'active' || rec.nodeId === null || rec.nodeId === undefined) {
        return {
          file: null,
          status: 'unavailable' as const,
          reason: 'session is not live on a node',
        };
      }
      const conn = fleetControlRegistry.get(rec.nodeId);
      if (conn === undefined) {
        return {
          file: null,
          status: 'unavailable' as const,
          reason: 'session node is not connected',
        };
      }
      // Hardening: per-account concurrent-relay cap (reserve before the await,
      // release in the finally; shed with a discriminated error when at the cap).
      const releaseRelay = reserveRelaySlot(rec.accountId);
      if (releaseRelay === null) {
        return { file: null, status: 'error' as const, reason: RELAY_BUSY_REASON };
      }
      const releaseDownloadFetch = reserveDownloadFetchSlot(rec.accountId);
      if (releaseDownloadFetch === null) {
        releaseRelay();
        return { file: null, status: 'error' as const, reason: DOWNLOAD_FETCH_BUSY_REASON };
      }
      try {
        const outcome = await conn.requestDownloadFetch(randomUUID(), rec.id, q.data.name);
        if (outcome.status === 'data') {
          if (q.data.format === 'binary') {
            // The node frame schema already proves canonical base64 and the 64 MiB
            // decoded ceiling. Keep the media type fixed: node-provided MIME text is
            // metadata, not a trusted response-header value, and JSON files must not
            // be confused with the small discriminated JSON error envelope.
            return reply
              .header('cache-control', 'private, no-store')
              .type('application/octet-stream')
              .send(Buffer.from(outcome.dataB64, 'base64'));
          }
          return {
            file: {
              name: outcome.name,
              mime: outcome.mime ?? 'application/octet-stream',
              dataB64: outcome.dataB64,
            },
            status: 'ok' as const,
          };
        }
        if (outcome.status === 'error') {
          return {
            file: null,
            status: 'error' as const,
            reason: customerSafeNodeDiagnostic(outcome.message),
          };
        }
        if (outcome.status === 'list') {
          return {
            file: null,
            status: 'error' as const,
            reason: 'unexpected list frame for fetch request',
          };
        }
        return { file: null, status: 'timeout' as const };
      } finally {
        releaseDownloadFetch();
        releaseRelay();
      }
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
      {
        preHandler: [
          app.requireAuthEventSource,
          app.requireScope('read:sessions'),
          app.rateLimit('global'),
        ],
      },
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
          reply.raw.write(
            `data: ${JSON.stringify({ index: i, entry: publicTranscriptEntry(entry) })}\n\n`,
          );
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
            `data: ${JSON.stringify({ index: event.index, entry: publicTranscriptEntry(event.entry) })}\n\n`,
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
        // Mint when no key exists, the existing one has expired, or it is a
        // legacy/corrupt/context-mismatched blob. Only this account-authenticated
        // route may recover a key; control-key authorization always fails closed.
        const expired =
          rec.guiControlKeyExpiresAt === null ||
          rec.guiControlKeyExpiresAt.getTime() <= now.getTime();
        let plaintext: string | null = null;
        if (!expired && rec.guiControlKeyCiphertext !== null) {
          try {
            plaintext = decryptGuiControlKey(
              rec.guiControlKeyCiphertext,
              guiControlKeyEncryptionKey,
              { accountId: rec.accountId, sessionId: rec.id },
            );
          } catch {
            // Legacy v1, corruption, encryption-key rotation, and ciphertext
            // relocation all take the same authenticated recovery path below.
          }
        }
        if (plaintext === null) {
          const plaintext = generateGuiControlKey();
          const ciphertext = encryptGuiControlKey(plaintext, guiControlKeyEncryptionKey, {
            accountId: rec.accountId,
            sessionId: rec.id,
          });
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
        // Live v2 key: echo. The dashboard treats every call as idempotent
        // within the TTL.
        return {
          gui_control_key: plaintext,
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
            await commitPairModeTransition({
              sessionId: req.params.id,
              expectedPersistedState: rec.pairModeState,
              nextState,
              takeoverClientId: parsed.data.client_id,
            });
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
            // Record a fresh heartbeat so the 5s sweep can see this session and
            // auto-revert a stalled takeover — IDENTICAL to the explicit POST
            // /:id/takeover route (line ~3300). Without it the input-event
            // takeover enters takeover-pending but is NEVER registered with the
            // heartbeat tracker, so the sweep's findStaleSessions can't see it
            // and never fires heartbeat-timeout → the session is stranded in
            // takeover-pending forever (every later input-event 409s on the
            // pending guard below). The tracker is in-memory; recordHeartbeat
            // doesn't throw.
            pairModeHeartbeatTracker?.recordHeartbeat({
              sessionId: req.params.id,
              at: new Date(),
            });
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
          } finally {
            // Release the pair-mode lock as soon as the takeover-request
            // transition completes (or fails) — mirrors the explicit /:id/takeover
            // route's finally (line ~3313). Without this the input-event takeover
            // path leaked the lock for the full 30s SET-NX-EX TTL on BOTH the
            // success and error paths, needlessly blocking a legitimate contending
            // client for up to 30s.
            await pairModeLock.release({
              sessionId: req.params.id,
              clientId: parsed.data.client_id,
            });
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
        if (currentState.kind === 'human-driving') {
          if (!parsed.data.client_id) {
            throw new ValidationError({
              formErrors: [],
              fieldErrors: {
                client_id: [
                  'client_id is required for pair-mode input and must match the client that owns human-driving',
                ],
              },
            });
          }
          if (parsed.data.client_id !== currentState.clientId) {
            throw new PairModeConflictError(currentState.clientId);
          }
          pairModeHeartbeatTracker?.recordHeartbeat({
            sessionId: req.params.id,
            at: new Date(),
          });
          // HTTP ping is the API/control-plane liveness signal, distinct from
          // the LiveKit RTT ping that terminates at the Mac harness. It refreshes
          // pair ownership without depending on the (optional) input dispatcher.
          if (parsed.data.event.type === 'ping') {
            return reply.code(200).send({ kind: 'forwarded' as const, duration_ms: 0 });
          }
        }
        // Exact controlling client in human-driving falls through to the
        // harness-forward path below. Sibling tabs cannot inject input.
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
        return publicAgentSession(
          rec,
          undefined,
          sessionLivenessStore,
          sessionCapabilityReportStore,
        );
      }
      // S42 follow-up 2026-07-07 — the /mode flip is the OTHER ordering of
      // the create-edge aiAgent gate: without this, a free/personal account
      // creates a mode:'manual' session (open on every tier) and flips it
      // LLM-driven here, bypassing the tier matrix entirely. Same rule as
      // create: entering 'ai'/'pair' requires aiAgent on the tier of the
      // account the session runs and bills against (rec.accountId — covers
      // both the account-auth and gui_control_key auth paths; a control key
      // proves session access, never tier). Manual-ward flips stay open on
      // every tier: handing back to a human must never be tier-refused,
      // even after a mid-session downgrade.
      if (target !== 'manual') {
        if (req.guiControlKeyAuthorized !== true && requireCtx(req).account.id === rec.accountId) {
          requireTierFeature(requireCtx(req).account.tier, 'aiAgent');
        } else {
          if (authRepo === undefined) {
            throw new ForbiddenError('Owner account tier is unavailable.');
          }
          const owner = await authRepo.getAccount(rec.accountId);
          if (!owner) {
            throw new ForbiddenError('Owner account no longer exists.');
          }
          requireTierFeature(owner.tier, 'aiAgent');
        }
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
      return publicAgentSession(
        updated,
        undefined,
        sessionLivenessStore,
        sessionCapabilityReportStore,
      );
    },
  );

  // Arc 2 sub-slice 8.9 (v2-#8) — pair-mode takeover + handback.
  // Both routes require the pair-mode lock AND mode='pair' on the
  // session; otherwise they 409. Takeover composes the lock (sub-
  // slice 8.8) + the state machine (sub-slice 8.7). The lock guards
  // the takeover-request transition specifically; subsequent
  // transitions use a conditional per-row UPDATE so a lock handoff or
  // concurrent mode/state winner cannot be overwritten by a stale request.
  if (pairModeLock !== undefined) {
    // client_id is a customer-chosen opaque tag identifying which
    // browser tab / window initiated the takeover. UUID-shape is
    // typical; 128 cap matches OAuth client_id cap in oauth.ts.
    const TakeoverBodySchema = z.object({ client_id: z.string().min(1).max(128) });
    const HandbackBodySchema = z.object({
      client_id: z.string().min(1).max(128).optional(),
    });
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
          await commitPairModeTransition({
            sessionId: req.params.id,
            expectedPersistedState: rec.pairModeState,
            nextState,
            takeoverClientId: parsed.data.client_id,
          });
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
        const parsed = HandbackBodySchema.safeParse(req.body ?? {});
        if (!parsed.success) throw new ValidationError(parsed.error.flatten());
        if (req.guiControlKeyAuthorized === true && parsed.data.client_id === undefined) {
          throw new ValidationError({
            formErrors: [],
            fieldErrors: {
              client_id: [
                'client_id is required for GUI handback and must match the client that owns human-driving',
              ],
            },
          });
        }
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
          // The per-session GUI control key can legitimately be shared by a main
          // window and a detached simulator. It authorizes the session, not the
          // winning window, so preserve controller ownership with client_id.
          // Account-authenticated SDK callers retain their explicit administrative
          // handback capability by omitting client_id (backward compatible).
          if (
            currentState.kind === 'human-driving' &&
            parsed.data.client_id !== undefined &&
            parsed.data.client_id !== currentState.clientId
          ) {
            throw new PairModeConflictError(currentState.clientId);
          }
          const nextState = applyPairModeTransition(currentState, {
            kind: 'handback-request',
            at: new Date().toISOString(),
          });
          await commitPairModeTransition({
            sessionId: req.params.id,
            expectedPersistedState: rec.pairModeState,
            nextState,
          });
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
              payload: {
                from: currentState.kind,
                to: nextState.kind,
                ...(parsed.data.client_id !== undefined
                  ? { client_id: parsed.data.client_id }
                  : {}),
              },
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

  const executeAgentMessage = async (req: FastifyRequest<{ Params: { id: string } }>) => {
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
    // Billing-integrity hardening — set true when this turn reserved a
    // bundled-LLM concurrency slot, so the finally below releases EXACTLY
    // one slot on every exit path (the turn throwing, a downstream 502,
    // or a normal return).
    let bundledSlotAcquired = false;
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
        // Billing-integrity hardening — reserve a per-account concurrency
        // slot BEFORE handing out the bundled key. The soft-cap gate above
        // is read-then-act (the cost row lands only after the turn), so
        // without this bound N concurrent turns all read the same
        // pre-increment spend, all pass, and all overspend the cap. The
        // limiter caps in-flight bundled turns per account; over the
        // ceiling we 429 (retry once an in-flight turn finishes) so the
        // overshoot past the cap is bounded by `limit`, not unbounded.
        if (bundledTurnConcurrency !== undefined) {
          if (!bundledTurnConcurrency.tryAcquire(turnAccountId)) {
            try {
              metrics?.inc(METRIC_NAMES.bundledLlmErrorTotal, {
                kind: 'concurrency_limit',
              });
            } catch {
              /* swallow */
            }
            throw new ConcurrencyLimitError(
              bundledTurnConcurrency.current(turnAccountId),
              bundledTurnConcurrency.limit,
            );
          }
          bundledSlotAcquired = true;
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
    // Billing-integrity hardening — the try/finally guarantees the
    // bundled-LLM concurrency slot reserved above is released on EVERY
    // exit path from here on (the turn throwing, a downstream 502, or a
    // normal return), so a thrown turn can't leak a slot.
    try {
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
      if (result.kind === 'turn-in-progress') {
        throw new ConflictError(
          'Another turn is already running for this agent session. Retry after it completes.',
        );
      }
      if (result.kind === 'account-turn-limit') {
        throw new RateLimitedError(
          1,
          `This account already has ${result.current.toString()} AI turns running; the current limit is ${result.limit.toString()}. Retry after one finishes.`,
        );
      }
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
          session: publicAgentSession(
            result.session,
            undefined,
            sessionLivenessStore,
            sessionCapabilityReportStore,
          ),
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
          session: publicAgentSession(
            result.session,
            undefined,
            sessionLivenessStore,
            sessionCapabilityReportStore,
          ),
          intents: plan.intents.map(publicAgentIntent),
          results: result.executor.results.map(publicIntentResult),
          ok: result.executor.ok,
          ...(usage !== undefined ? { usage } : {}),
        };
      }
      if (result.kind === 'clarify') {
        const usage = publicUsage(result.decomposer.usage);
        return {
          kind: result.kind,
          session: publicAgentSession(
            result.session,
            undefined,
            sessionLivenessStore,
            sessionCapabilityReportStore,
          ),
          clarifying_question: result.decomposer.clarifyingQuestion,
          ...(usage !== undefined ? { usage } : {}),
        };
      }
      // refuse
      const usage = publicUsage(result.decomposer.usage);
      return {
        kind: result.kind,
        session: publicAgentSession(
          result.session,
          undefined,
          sessionLivenessStore,
          sessionCapabilityReportStore,
        ),
        refuse_reason: result.decomposer.refuseReason,
        ...(usage !== undefined ? { usage } : {}),
      };
    } finally {
      // Release the bundled-LLM concurrency slot (if reserved). ALWAYS
      // runs — on a thrown turn, a downstream 502, or a normal return —
      // so a slot can never leak.
      if (bundledSlotAcquired && bundledTurnConcurrency !== undefined) {
        bundledTurnConcurrency.release(turnAccountId);
      }
    }
  };

  interface AgentMessageTerminal {
    status: number;
    body: unknown;
    error?: unknown;
  }

  const handleAgentMessage = async (
    req: FastifyRequest<{ Params: { id: string } }>,
  ): Promise<AgentMessageTerminal> => {
    // Authenticate ownership and validate the exact canonical body before
    // reserving a key. Invalid/foreign requests must not poison the account's
    // durable idempotency namespace.
    const parsed = RunTurnRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());
    const pre = await sessions.get(req.params.id);
    if (pre === null) throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
    if (req.guiControlKeyAuthorized !== true) {
      const ctx = requireCtx(req);
      if (!callerCanAccessAgentSession(ctx, pre.accountId)) {
        throw new NotFoundError(`AgentSession ${req.params.id} not found.`);
      }
    }

    const idempotency = readIdempotencyKey(req);
    if (idempotency.kind === 'invalid') {
      throw new ValidationError({
        formErrors: ['Idempotency-Key must be ≤255 ASCII characters, no whitespace.'],
        fieldErrors: {},
      });
    }
    if (idempotency.kind === 'absent') {
      return { status: 200, body: await executeAgentMessage(req) };
    }
    if (agentTurnReceipts === undefined) {
      throw new FeatureUnavailableError(
        'Agent-turn idempotency storage is unavailable. Do not retry this browser task without the same key; contact support.',
      );
    }

    const rawHeaderByokKey = req.headers['x-byok-anthropic-api-key'];
    const explicitByokApiKey =
      typeof rawHeaderByokKey === 'string' && rawHeaderByokKey.length > 0
        ? rawHeaderByokKey
        : undefined;
    const requestHash = hashAgentTurnRequest({
      agentSessionId: req.params.id,
      userMessage: parsed.data.user_message,
      ...(parsed.data.approve_consequential_actions !== undefined
        ? { approveConsequentialActions: parsed.data.approve_consequential_actions }
        : {}),
      ...(explicitByokApiKey !== undefined ? { explicitByokApiKey } : {}),
    });
    const receiptArgs = {
      accountId: pre.accountId,
      agentSessionId: req.params.id,
      idempotencyKey: idempotency.key,
      requestHash,
    };
    const reservation = await agentTurnReceipts.reserve(receiptArgs);
    if (reservation.kind === 'mismatch') {
      throw new ConflictError(
        'This Idempotency-Key was already used for a different agent turn or session.',
        { idempotency_status: 'mismatch' },
      );
    }
    if (reservation.kind === 'in-progress') {
      throw new ConflictError(
        'The original agent turn is still running or its terminal outcome is unknown. Do not submit the browser task again; inspect the durable transcript before choosing a new Idempotency-Key.',
        { idempotency_status: 'in_progress' },
      );
    }
    if (reservation.kind === 'replay') {
      return reservation.terminal;
    }

    try {
      const body = await executeAgentMessage(req);
      const terminal = { status: 200, body };
      await agentTurnReceipts.complete({ ...receiptArgs, terminal });
      return terminal;
    } catch (error) {
      // Persist typed failures too. If browser work finished and a later
      // database/debit step failed, retrying must replay the same terminal
      // problem rather than guessing that the action is safe to repeat.
      const apiError =
        error instanceof ApiError
          ? error
          : new InternalError('An unexpected error occurred.', error);
      const terminal = { status: apiError.status, body: apiError.toProblem(req.id) };
      await agentTurnReceipts.complete({ ...receiptArgs, terminal });
      return { ...terminal, error };
    }
  };

  const reportAgentMessageError = (
    req: FastifyRequest,
    error: unknown,
    status: number,
    body: unknown,
  ): void => {
    if (status >= 500)
      req.log.error({ err: error, problem: body }, 'agent message request failed: 5xx');
    else req.log.warn({ err: error, problem: body }, 'agent message request rejected: 4xx');
    sentry?.captureException(error, {
      request_id: req.id,
      method: req.method,
      route: '/v1/agent-sessions/:id/message',
    });
  };

  const applyAgentMessageRetryAfter = (
    reply: FastifyReply,
    status: number,
    body: unknown,
  ): void => {
    if (status !== 429 && status !== 503) return;
    if (typeof body !== 'object' || body === null) return;
    const retryAfter = (body as Record<string, unknown>)['retry_after_seconds'];
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) {
      reply.header('retry-after', Math.ceil(retryAfter).toString());
    }
  };

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
    async (req, reply) => {
      const accept = req.headers.accept ?? '';
      if (
        !accept
          .toLowerCase()
          .split(',')
          .some((value) => value.trim().split(';', 1)[0]?.trim() === 'text/event-stream')
      ) {
        const terminal = await handleAgentMessage(req);
        if (terminal.error !== undefined) {
          reportAgentMessageError(req, terminal.error, terminal.status, terminal.body);
        }
        if (terminal.status >= 400) {
          applyAgentMessageRetryAfter(reply, terminal.status, terminal.body);
          return reply
            .code(terminal.status)
            .header('content-type', 'application/problem+json; charset=utf-8')
            .send(terminal.body);
        }
        return reply.code(terminal.status).send(terminal.body);
      }

      // Long AI turns legitimately outlive both the SDK's generic 30-second
      // request default and Cloudflare's headerless-origin read deadline. Send
      // an SSE representation on explicit negotiation: headers open immediately,
      // comments keep every hop alive, then ONE terminal response event carries
      // the same JSON result or RFC 7807 problem the compatibility path returns.
      // The underlying turn deliberately continues after a viewer disconnects:
      // abandoning it halfway would leave already-dispatched browser actions,
      // transcript, token debit, and cost recording in an ambiguous state.
      const responseHeaders: Record<string, string | number | string[]> = {};
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (name !== 'content-length' && value !== undefined) responseHeaders[name] = value;
      }
      reply.raw.writeHead(200, {
        ...responseHeaders,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-store, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      reply.raw.write(': stream open\n\n');

      let viewerClosed = false;
      const stopWriting = (): void => {
        viewerClosed = true;
      };
      reply.raw.once('close', stopWriting);
      reply.raw.once('error', stopWriting);
      const heartbeat = setInterval(() => {
        if (viewerClosed) return;
        // A stalled viewer is not allowed to turn tiny heartbeats into an
        // unbounded socket buffer. End only its representation; the turn keeps
        // running and remains observable through the durable transcript.
        if (reply.raw.writableLength > 64 * 1024) {
          viewerClosed = true;
          reply.raw.end();
          return;
        }
        reply.raw.write(`: heartbeat ${new Date().toISOString()}\n\n`);
      }, agentMessageHeartbeatMs);
      heartbeat.unref();
      reply.hijack();

      let status = 200;
      let body: unknown;
      try {
        const terminal = await handleAgentMessage(req);
        status = terminal.status;
        body = terminal.body;
        if (terminal.error !== undefined) {
          reportAgentMessageError(req, terminal.error, status, body);
        }
      } catch (err) {
        const apiError =
          err instanceof ApiError ? err : new InternalError('An unexpected error occurred.', err);
        status = apiError.status;
        body = apiError.toProblem(req.id);
        // Hijacked replies bypass Fastify's normal error handler/onError hook,
        // so preserve its observability without exposing internals on the wire.
        reportAgentMessageError(req, err, status, body);
      } finally {
        clearInterval(heartbeat);
        reply.raw.off('close', stopWriting);
        reply.raw.off('error', stopWriting);
      }

      if (!viewerClosed) {
        const terminal = JSON.stringify({ status, body });
        reply.raw.end(`event: response\ndata: ${terminal}\n\n`);
      }
      return reply;
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
      // Idempotent DELETE: if the session is ALREADY closed (by the customer
      // earlier, a reaper, or a worker terminal-close), return 204 WITHOUT
      // re-closing. closeWithReason is not status-anchored, so re-closing would
      // clobber the real closedReason (e.g. 'worker-disconnected' → 'customer-closed',
      // losing the teardown cause), emit a DUPLICATE agent_session.destroyed audit,
      // and re-dispatch a redundant sessionEnd to an already-dead node
      // (audit w93vi1teq #1). A 'paused' session is still closeable — only an
      // already-'closed' row short-circuits.
      if (pre.status === 'closed') {
        return reply.code(204).send();
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
        nodeId: pre.nodeId,
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
      sessionCapabilityReportStore?.delete(req.params.id);
      // Review follow-up 2026-07-01 — same rationale: precisely evict this
      // session's lifetime upload counters on the customer-close path (the
      // one path with a cheap known session id), rather than relying solely
      // on the best-effort size cap above.
      sessionUploadLifetimeBytes.delete(req.params.id);
      sessionUploadLifetimeCount.delete(req.params.id);
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
        nodeId: rec.nodeId,
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
// body the SDK surfaces verbatim. Current activation options are surfaced
// here so a customer hitting this 503 from the SDK has the same
// recovery path the dashboard's feature-unavailable banner shows
// (apps/customer-dashboard/src/pages/agent-sessions.astro lines 35-53):
// BYOK Anthropic key OR opt-in to the deployment's bundled-LLM budget.
export function registerAgentSessionsDisabledRoutes(app: FastifyInstance): void {
  const detail =
    'AI chat is unavailable on this deployment. To activate it, bring your own Anthropic key ' +
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
  // Founder #48 — the cookies read is gated too (machine-readable 503, not a bare
  // 404) so the GUI Cookies panel surfaces the documented activation state.
  app.get('/v1/agent-sessions/:id/cookies', stub);
  // Cookie-import — the cookies WRITE (import) is gated too (machine-readable 503,
  // not a bare 404) so the GUI Cookies panel's Import surfaces the documented state.
  app.post('/v1/agent-sessions/:id/cookies/set', stub);
  // Sim back/forward (A3 W2870) — the history step is gated too (machine-readable 503,
  // not a bare 404) so the GUI's back/forward buttons surface the documented state.
  app.post('/v1/agent-sessions/:id/history', stub);
  // File-control (A3 W2851) — the upload write is gated too (machine-readable 503)
  // so the GUI file picker surfaces the documented activation state.
  app.post('/v1/agent-sessions/:id/files', stub);
  // File-control download (A3 W2856) — list + fetch gated too (machine-readable 503)
  // so the GUI download bar surfaces the documented activation state.
  app.get('/v1/agent-sessions/:id/downloads', stub);
  app.get('/v1/agent-sessions/:id/downloads/content', stub);
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
