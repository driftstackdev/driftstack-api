// Fastify app builder.
//
// Pure factory: takes its dependencies as arguments, returns a configured
// `FastifyInstance`. Tests build the app with in-memory adapters; production
// wires the same builder to Drizzle + ioredis.

import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { randomUUID } from 'node:crypto';
import type { Logger } from './logger.js';
import type { AccountAuthRepo } from '../services/auth.js';
import type { AuthCache } from '../services/auth-cache.js';
import type { AuthCoalescer } from '../services/auth-coalescer.js';
import type { NegativeAuthCache } from '../services/negative-auth-cache.js';
import type { RateLimitStore } from '../services/rate-limit.js';
import type { SessionsService } from '../services/sessions.js';
import type { ApiKeysService } from '../services/api-keys.js';
import type { UsageService } from '../services/usage.js';
import type { WebhooksService, WebhooksAdminService } from '../services/webhooks.js';
import type { AdminAuditService } from '../services/admin-audit.js';
import type { AccountsAdminService } from '../services/admin-accounts.js';
import type { AdminBillingService } from '../services/admin-billing.js';
import type { PricingService } from '../services/pricing.js';
import type { PlatformSecretsService } from '../services/platform-secrets.js';
import type { IncidentsService } from '../services/incidents.js';
import type { StatusSubscribersService } from '../services/status-subscribers.js';
import { registerStatusSubscribeRoutes } from '../routes/status-subscribe.js';
import { registerAdminStatusSubscribersRoutes } from '../routes/admin-status-subscribers.js';
import type { IncidentEventBus } from '../services/incident-event-bus.js';
import type { SlaReportingService } from '../services/sla-reporting.js';
import { registerStatusStreamRoutes } from '../routes/status-stream.js';
import type { TeamMembersService } from '../services/team-members.js';
import { registerTeamRoutes } from '../routes/team.js';
import type { RateLimitOverridesService } from '../services/rate-limit-overrides.js';
import type { LegalService } from '../services/legal.js';
import type { EmailPreferencesService } from '../services/email-preferences.js';
import { registerEmailPreferencesRoutes } from '../routes/email-preferences.js';
import type { AccountAuditService } from '../services/account-audit.js';
import type { AccountLifecycleService } from '../services/account-lifecycle.js';
import type { ScheduledJobsService } from '../services/scheduled-jobs.js';
import { registerAccountAuditRoutes } from '../routes/account-audit.js';
import { METRIC_NAMES, type MetricsRegistry } from '../services/metrics-registry.js';
import { registerMetricsRoutes } from '../routes/metrics.js';
import type { PairModeHeartbeatTracker } from '../services/agent-pair-mode-heartbeat.js';
import type { ValidationHarnessService } from '../services/validation-harness.js';
import { registerAdminValidationHarnessRoutes } from '../routes/admin-validation-harness.js';
import { registerAccountRateLimitsRoutes } from '../routes/account-rate-limits.js';
import type { AuthFlowsService } from '../services/auth-flows.js';
import type { CliAuthorizeService } from '../services/cli-authorize.js';
import type { StripeWebhooksService } from '../services/stripe-webhooks.js';
import type { ProfilesService } from '../services/profiles.js';
import type { ProfileSnapshotsService } from '../services/profile-snapshots.js';
import type { BillingService } from '../services/billing.js';
import type { SessionEgressService } from '../services/session-egress.js';
import type { AgentRuntime } from '../services/agent-runtime.js';
import type { AgentSessionsRepo } from '../services/agent-sessions.js';
import type { AgentTurnReceiptsRepo } from '../services/agent-turn-receipts.js';
import type { RecipesRepo } from '../services/recipes.js';
import type { InMemoryByokKeyCache } from '../services/byok-anthropic-key-cache.js';
import type { InMemoryExitIdentityCache } from '../services/exit-identity-cache.js';
import type { FleetNodeAuth } from '../services/fleet-node-auth.js';
import type { DrizzleFleetNodesRepo } from '../db/fleet-nodes-repo.js';
import { registerMacNodesRoutes } from '../routes/mac-nodes-register.js';
import { registerAgentSessionsLivekitTokenRoute } from '../routes/agent-sessions-livekit-token.js';
import { registerAgentSessionsTransportReportRoute } from '../routes/agent-sessions-transport-report.js';
import type { FleetNonceCache } from '../services/fleet-nonce-cache.js';
import type { FleetControlRegistry } from '../services/fleet-control-registry.js';
import type { SessionPageStateStore } from '../services/session-page-state-store.js';
import type { SessionLivenessStore } from '../services/session-liveness-store.js';
import type { SessionCapabilityReportStore } from '../services/session-capability-report-store.js';
import type { SessionRepo } from '../services/sessions.js';
import type { ProfilesRepo } from '../services/profiles.js';
import type { AccountProxiesRepo } from '../db/account-proxies-repo.js';
import type { AccountProxiesService } from '../services/account-proxies.js';
import type { ProxyConnectivityProbe } from '../services/proxy-connectivity-probe.js';
import { registerAccountMeRoutes } from '../routes/account-me.js';
import { registerAccountWebSessionsRoutes } from '../routes/account-web-sessions.js';
import { registerAccountMfaRoutes } from '../routes/account-mfa.js';
import {
  registerAccountByokAnthropicDisabledRoutes,
  registerAccountByokAnthropicRoutes,
} from '../routes/account-byok-anthropic.js';
import { registerAccountBundledLlmRoutes } from '../routes/account-bundled-llm.js';
import type { ApiKeysRepo } from '../services/api-keys.js';
import type { Driver } from '../drivers/types.js';
import type { R2 } from './r2.js';
import type { MfaService } from '../services/mfa.js';
import type { BYOKAnthropicService } from '../services/byok-anthropic.js';
import type { BundledLlmService } from '../services/bundled-llm.js';
import { BundledTurnConcurrencyLimiter } from '../services/bundled-turn-concurrency.js';
import type { AgentSessionEventBus } from '../services/agent-session-event-bus.js';
import type { NotificationEventBus } from '../services/notification-event-bus.js';
import { registerAccountNotificationsRoutes } from '../routes/account-notifications.js';
import { corsOriginMatchers } from './cors-allow.js';
import type { PairModeTakeoverLock } from '../services/agent-pair-mode-lock.js';
import authPlugin from '../middleware/auth.js';
import { registerDeviceKeyDenyGate } from '../middleware/device-key-deny.js';
import rateLimitPlugin from '../middleware/rate-limit.js';
import { ipRateLimit } from '../middleware/ip-rate-limit.js';
import requestIdPlugin from '../middleware/request-id.js';
import { registerErrorHandler } from '../middleware/error-handler.js';
import { registerSessionRoutes } from '../routes/sessions.js';
import { registerAdminRoutes } from '../routes/admin.js';
import { registerStatusRoutes } from '../routes/status.js';
import { registerArchetypeRoutes } from '../routes/archetypes.js';
import { registerEgressEchoRoutes } from '../routes/egress-echo.js';
import { registerOpenApiRoutes } from '../routes/openapi.js';
import { registerWebhookRoutes } from '../routes/webhooks.js';
import { registerAdminAccountsRoutes } from '../routes/admin-accounts.js';
import { registerAdminIncidentsRoutes } from '../routes/admin-incidents.js';
import { registerAdminWebhookRoutes } from '../routes/admin-webhooks.js';
import { registerAdminAuditLogRoutes } from '../routes/admin-audit-log.js';
import { registerAdminOverviewRoutes } from '../routes/admin-overview.js';
import { registerAdminBillingRoutes } from '../routes/admin-billing.js';
import { registerAdminOwnerRoutes } from '../routes/admin-owner.js';
import { registerAdminSessionsRoutes } from '../routes/admin-sessions.js';
import { registerAdminApiKeysRoutes } from '../routes/admin-api-keys.js';
import { registerAdminRateLimitOverridesRoutes } from '../routes/admin-rate-limit-overrides.js';
import { registerLegalRoutes } from '../routes/legal.js';
import { registerAuthRoutes } from '../routes/auth.js';
import { registerAuthCliRoutes } from '../routes/auth-cli.js';
import { registerStripeWebhookRoutes } from '../routes/webhooks-stripe.js';
import { registerNowpaymentsWebhookRoutes } from '../routes/webhooks-nowpayments.js';
import { registerOAuthClientRoutes } from '../routes/auth-oauth-client.js';
import { registerAccountOauthLinksRoutes } from '../routes/account-oauth-links.js';
import type { OAuthLinksRepo } from '../services/oauth-client.js';
import type { OAuthClientService } from '../services/oauth-client.js';
import { registerCryptoCheckoutRoutes } from '../routes/billing-crypto.js';
import { registerCryptoQuoteRoutes } from '../routes/billing-crypto-quote.js';
import { registerCustomerCryptoOrdersRoutes } from '../routes/billing-crypto-orders.js';
import { registerAdminCryptoOrdersRoutes } from '../routes/admin-crypto-orders.js';
import type { CryptoOrdersService } from '../services/crypto-orders.js';
import type { NowPaymentsApiClient } from './nowpayments-api.js';
import { registerOAuthRoutes } from '../routes/oauth.js';
import { OAuthService, type OAuthStore } from '../services/oauth.js';
import { registerAdminCostRoutes } from '../routes/admin-cost.js';
import { registerAdminUsageRoutes } from '../routes/admin-usage.js';
import { registerAccountCostRoutes } from '../routes/account-cost.js';
import type { CostMonitoringService } from '../services/cost-monitoring.js';
import { registerProfileRoutes } from '../routes/profiles.js';
import { registerProfileSnapshotsRoutes } from '../routes/profile-snapshots.js';
import { registerBillingDisabledRoutes, registerBillingRoutes } from '../routes/billing.js';
import {
  registerSessionProxyDisabledRoutes,
  registerSessionProxyRoutes,
} from '../routes/session-proxy.js';
import {
  registerAgentSessionsDisabledRoutes,
  registerAgentSessionsRoutes,
  type SessionDispatchConfig,
} from '../routes/agent-sessions.js';
import { registerRecipesDisabledRoutes, registerRecipesRoutes } from '../routes/recipes.js';
import {
  registerFleetEventsDisabledRoutes,
  registerFleetEventsRoutes,
} from '../routes/fleet-events.js';
import {
  registerAdminAtlasPriorityRoutes,
  registerInternalAtlasPriorityDisabledRoutes,
  registerInternalAtlasPriorityRoutes,
} from '../routes/internal-atlas-priority.js';
import type { DrizzleAtlasPriorityEventsRepo } from '../db/atlas-priority-events-repo.js';
import type { InternalFleetAuth } from './internal-fleet-auth.js';
import { registerAdminForceActionRoutes } from '../routes/admin-force-actions.js';
import {
  wireSentryErrorHandler,
  wireSentryRequestBreadcrumbs,
  type SentryClient,
} from './sentry.js';

export interface ReadinessCheck {
  /** Display name surfaced in the /ready response (e.g. "postgres", "redis", "r2"). */
  name: string;
  /** Async probe — throws or rejects on failure, resolves on success. */
  fn: () => Promise<unknown>;
  /** Per-check timeout in ms. Default 1500. */
  timeoutMs?: number;
}

async function runWithTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
  let to: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<T>([
      p,
      new Promise<T>((_, reject) => {
        to = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (to !== undefined) clearTimeout(to);
  }
}

/**
 * DoS hardening — default global IP-keyed rate limit applied app-wide
 * BEFORE auth. 600/min/IP is generous for any single legitimate client
 * (the SDK + dashboard make far fewer than 10 req/s sustained) while
 * capping an unauthenticated bogus-token / bogus-control-key flood from
 * one source IP long before it saturates the scrypt threadpool / DB
 * pool. Tune in prod via GLOBAL_IP_RATE_LIMIT_PER_MIN; set to 0 to
 * disable (maps to a null gate).
 */
export const GLOBAL_IP_RATE_LIMIT_DEFAULT = {
  capacity: 600,
  refillPerSecond: 600 / 60,
} as const;

export interface AppDeps {
  logger: Logger;
  authRepo: AccountAuthRepo;
  authCache: AuthCache | null;
  authCoalescer: AuthCoalescer | null;
  /**
   * DoS hardening — short-TTL negative auth cache. When provided, a flood
   * of the SAME bogus bearer token skips the prefix-lookup + scrypt
   * verify after the first rejection. Omitted → no negative caching.
   */
  negativeAuthCache?: NegativeAuthCache | null;
  rateLimitStore: RateLimitStore;
  /**
   * DoS hardening — global IP-keyed rate limit applied app-wide via an
   * onRequest hook that runs BEFORE the per-route auth preHandler, so an
   * unauthenticated bogus-bearer / bogus-control-key flood is throttled
   * before it reaches findApiKeyByPrefix + scrypt + AES-GCM. Reuses the
   * shared `rateLimitStore`. `null` disables the gate (default when
   * omitted is 600/min/IP — see GLOBAL_IP_RATE_LIMIT_DEFAULT). Tests
   * pass `null` to keep the pre-existing inject-based suites unaffected.
   */
  globalIpRateLimit?: { capacity: number; refillPerSecond: number } | null;
  sessionsService: SessionsService;
  apiKeysService: ApiKeysService;
  usageService: UsageService;
  webhooksService: WebhooksService;
  webhooksAdminService: WebhooksAdminService;
  adminAuditService: AdminAuditService;
  accountsAdminService: AccountsAdminService;
  adminBillingService: AdminBillingService;
  pricingService: PricingService;
  /** Platform-secrets service (secrets Phase A, migration 0074) — owner
   *  secrets-management; encrypted at rest under MFA_ENCRYPTION_KEY. */
  platformSecretsService: PlatformSecretsService;
  /** V-295a — incidents service. Optional during migration window;
   *  when omitted, /v1/admin/incidents/* + /v1/status/incidents are
   *  not registered. */
  incidentsService?: IncidentsService;
  /** V-295c3 — public-status email subscriber service. When omitted,
   *  /v1/status/subscribe/* is not registered. The status-page base
   *  URL used for confirm + unsubscribe links is owned by the service
   *  itself (passed at construction). */
  statusSubscribersService?: StatusSubscribersService;
  /** V-295e — in-process pub/sub bus for /v1/status/stream SSE. */
  incidentEventBus?: IncidentEventBus;
  /** V-295e — rolling 30d SLA reporter for /v1/status/sla. */
  slaReportingService?: SlaReportingService;
  /** V-298b/c — Team RBAC v1. When omitted, /v1/team/* routes are not
   *  registered. Auth path integration (member acts as owner per role)
   *  is V-298d; until then the routes function but the membership grants
   *  no implicit permissions on the owner's resources. */
  teamMembersService?: TeamMembersService;
  rateLimitOverridesService: RateLimitOverridesService;
  legalService: LegalService;
  /** V-204: customer email notification preferences. */
  emailPreferencesService: EmailPreferencesService;
  /** V-216: customer-facing audit log. */
  accountAuditService: AccountAuditService;
  /**
   * Arc 4 Wave 2.B sub-slice 8.18 (v2-#8) — Prometheus metrics registry.
   * Optional: when wired, the /metrics route exposes the rendered text
   * format + agent-sessions + bundled-llm routes emit counters into it.
   * Omit to skip both — /metrics returns 404 + counters are silently
   * dropped at the call site.
   */
  metricsRegistry?: MetricsRegistry;
  /**
   * Arc 4 Wave 2.B sub-slice 8.18 (v2-#8) — bearer token for /metrics
   * scrape auth. Required when metricsRegistry is wired (the registry
   * is exposed publicly + the token gates access).
   */
  metricsScrapeToken?: string;
  /**
   * Arc 4 Wave 2.B sub-slice 8.13d (v2-#8) — pair-mode heartbeat
   * tracker. Routes record customer activity here so the
   * PairModeHeartbeatSweep (also driven by bootstrap) can fire the
   * heartbeat-timeout transition on stale sessions.
   */
  pairModeHeartbeatTracker?: PairModeHeartbeatTracker;
  /** V-218: continuous validation harness. */
  validationHarnessService: ValidationHarnessService;
  /**
   * V-202c — central dispatcher for paired audit emit + email send
   * lifecycle events. Required for routes that don't already have a
   * direct audit/email path.
   */
  accountLifecycleService: AccountLifecycleService;
  /**
   * V-202d — generic time-shifted job dispatcher (`scheduled_jobs` table).
   * Optional — when omitted, the auth-token sweep and any other
   * cron-shaped work is silenced. Tests that don't exercise scheduled
   * jobs pass null/undefined.
   */
  scheduledJobsService?: ScheduledJobsService;
  /**
   * V-079: user-facing auth flows. Optional during the migration window —
   * when omitted, the /v1/auth/* routes are not registered. Once the
   * onboarding flow lands in production this becomes required.
   */
  authFlowsService?: AuthFlowsService;
  /**
   * V-266: browser-OAuth-style activation flow for the CLI / GUI client.
   * Optional — when omitted, the /v1/auth/cli-authorize/* routes are
   * not registered (legacy paste-key flow remains the only path).
   */
  cliAuthorizeService?: CliAuthorizeService;
  /**
   * V-080: inbound Stripe webhook handler. Optional — when both
   * `stripeWebhooksService` and `stripeWebhookSigningSecret` are
   * provided, POST /v1/webhooks/stripe is registered with raw-body
   * parsing + signature verification.
   */
  stripeWebhooksService?: StripeWebhooksService;
  /** Stripe webhook signing secret (whsec_...). Required if `stripeWebhooksService` is set. */
  stripeWebhookSigningSecret?: string;
  /**
   * V-666 — NowPayments IPN secret. When provided, POST
   * /v1/webhooks/nowpayments is registered with raw-body parsing +
   * HMAC-SHA512 signature verification. Until the merchant account
   * lands, this stays undefined and the route is not registered.
   */
  nowpaymentsIpnSecret?: string;
  /**
   * V-666.C — crypto-orders service. When provided, POST
   * /v1/billing/crypto-checkout is registered. The webhook route
   * also picks this up (V-666.B) so IPN updates land on the same
   * in-memory store.
   */
  cryptoOrdersService?: CryptoOrdersService;
  /**
   * V-666.D — NowPayments HTTP client. When provided alongside
   * `cryptoOrdersService`, the checkout route mints a real
   * pay_address; otherwise it returns the stub posture with
   * payment_address: null.
   */
  nowpaymentsApiClient?: NowPaymentsApiClient;
  /**
   * V-666.D — IPN callback URL (https://api.driftstack.dev/v1/webhooks/
   * nowpayments by default; overridable via NOWPAYMENTS_IPN_CALLBACK_URL).
   * Required when `nowpaymentsApiClient` is set.
   */
  nowpaymentsIpnCallbackUrl?: string;
  /**
   * OAuth provider authority. Production and real e2e pass the persistent
   * Drizzle store, registering /v1/oauth/* + /v1/admin/oauth/* and resolving
   * `oat_` bearers through the same instance. Omission remains a fail-closed
   * seam for isolated fixtures: provider routes are absent and central auth
   * rejects OAuth-shaped tokens.
   */
  oauthStore?: OAuthStore;
  /**
   * V-541.B — cost-monitoring service. When provided,
   * /v1/admin/cost/* routes register. Pre-launch posture: optional;
   * the service is internal-admin-only.
   */
  costMonitoringService?: CostMonitoringService;
  /** V-081: profile CRUD service. Optional during scaffolding window. */
  profilesService?: ProfilesService;
  /**
   * V-312 — profile snapshots service. Optional; routes register
   * only when this AND profilesService are both wired.
   */
  profileSnapshotsService?: ProfileSnapshotsService;
  /** V-082: billing service (Stripe checkout / portal). Optional. */
  billingService?: BillingService;
  /**
   * EG-API-1.2 — customer-configurable egress service per planning 133.
   * Optional. When wired, registers POST /v1/sessions/{id}/proxy etc.;
   * when omitted, those routes register as 503 FeatureUnavailable stubs
   * (same activation-gate posture as billing). Phase 1 SOCKS5 wires a
   * SOCKS5-only backend; Phase 2/3 extend to OpenVPN/WireGuard.
   */
  sessionEgressService?: SessionEgressService;
  /**
   * W615 — explicit override for the EG-API-1.4 session-create proxy
   * requirement (SESSION_PROXY_REQUIRED env via config). undefined →
   * inferred from sessionEgressService presence (the existing posture,
   * prod-unchanged). false → never required (self-hosted/testing,
   * founder verdict 2026-06-11). true → always required.
   */
  sessionProxyRequired?: boolean;
  /**
   * AI-D — AgentRuntime composing decomposer + executor + sessions repo
   * (per AI-COMPOSE slice). Optional. When wired, registers
   * /v1/agent-sessions/* routes; when omitted, those routes return 503
   * FeatureUnavailable. Founder reviews + flips on once the LLM key
   * path (BYOK vs bundled — Tier-3) is decided.
   */
  agentRuntime?: AgentRuntime;
  /**
   * Paired with `agentRuntime` — the same repo the runtime reads/writes
   * is reused by the route layer for cross-account auth checks +
   * create/close paths. When agentRuntime is wired this MUST also be set.
   */
  agentSessionsRepo?: AgentSessionsRepo;
  /** Durable account-scoped receipts for at-most-once agent message turns. */
  agentTurnReceiptsRepo?: AgentTurnReceiptsRepo;
  /**
   * Q.1.c — in-memory per-session plaintext BYOK key cache.
   * Wired alongside `agentRuntime`. Route layer stashes decrypted
   * customer stored-keys on session-create (when byokAnthropicService
   * is wired) and reads from the cache on each message-turn for
   * the resolve-without-decrypt fast path. Absence = no caching;
   * route still works via header > deployment-fallback path.
   */
  byokKeyCache?: InMemoryByokKeyCache;
  /**
   * #128 — in-memory bridge carrying the create-time proxy probe's observed
   * exit identity to the dispatch-time exit_identity emission (box new-tab IP
   * panel). Wired unconditionally in bootstrap; absence just omits the block.
   */
  exitIdentityCache?: InMemoryExitIdentityCache;
  /**
   * Q.1 — which decomposer impl bootstrap wired. The route layer
   * uses this to decide whether to enforce the
   * ByokAnthropicRequired 502 — Claude needs a key per request;
   * deterministic ignores keys entirely so the gate is silent.
   * Defaults to 'deterministic' (matches the safe-default branch
   * of selectAgentDecomposer when neither key path is configured).
   */
  agentDecomposerKind?: 'claude' | 'deterministic';
  /**
   * Q.1.d — optional deployment-side Anthropic API key. Used ONLY
   * when the message-turn's resolved key is undefined AND
   * `agentDecomposerAllowFallback` is true. Default prod posture is
   * undefined (force BYOK per Tier-3 verdict 2026-05-16).
   */
  agentDecomposerFallbackKey?: string;
  /**
   * Q.1.d — staging-only opt-in that lets the deployment fallback
   * serve unconfigured customers. PROD must keep this `false`.
   * Default is false (matches prod intent).
   */
  agentDecomposerAllowFallback?: boolean;
  /**
   * Founder safeguard (2026-06-24) — per-account CONCURRENT in-flight upload
   * cap (bytes) for POST /v1/agent-sessions/:id/files. Sourced from
   * config.agentUploadMaxAccountInFlightBytes (env
   * AGENT_UPLOAD_MAX_ACCOUNT_INFLIGHT_BYTES; default 512 MB). Omit → the route
   * uses its 512 MB default.
   */
  agentUploadMaxAccountInFlightBytes?: number;
  /**
   * Hardening (2026-06-24, LOW defense-in-depth) — per-account cap on CONCURRENT
   * in-flight control-relay requests (count) for the cookies/set, history,
   * downloads-list + downloads-content routes (which carry only the `global`
   * RATE limiter). Omit → the route's default of 16. Test-injectable so unit
   * tests can trip it with a cap of 1–2.
   */
  agentRelayMaxAccountInFlight?: number;
  /**
   * Hardening (2026-06-24, LOW defense-in-depth) — per-account cap on the COUNT
   * of CONCURRENT in-flight uploads for POST /v1/agent-sessions/:id/files,
   * alongside the byte cap. Omit → the route's default of 4. Test-injectable.
   */
  agentUploadMaxAccountInFlightCount?: number;
  /**
   * Arc 1 sub-slice 6.3 (v2-#6) — bundled-LLM settings reader.
   * When wired (bootstrap-side requires the deploymentFallbackKey
   * to be set; otherwise the bundled-LLM leg has nothing to consume),
   * customers with `bundled_llm_consent === true` get the fallback
   * key when BYOK absent/expired. Q4=A LOCKED 2026-05-18: BYOK still
   * wins. Soft-cap enforcement against the monthly cap lands as
   * sub-slice 6.5.
   */
  bundledLlmService?: BundledLlmService;
  /**
   * Billing-integrity hardening — per-account ceiling on CONCURRENT
   * bundled-LLM turns (bounds the soft-cap read-then-act TOCTOU overshoot).
   * Default 3 (see BundledTurnConcurrencyLimiter). Tune via
   * BUNDLED_TURN_MAX_CONCURRENCY. Only consulted when bundledLlmService is
   * wired.
   */
  bundledTurnMaxConcurrency?: number;
  /**
   * Billing-integrity hardening — inject a pre-built bundled-turn limiter
   * instead of constructing one from `bundledTurnMaxConcurrency`. Tests
   * pass this so they can pre-occupy slots + assert the route 429s when
   * full. Wins over `bundledTurnMaxConcurrency` when both are set.
   */
  bundledTurnConcurrency?: BundledTurnConcurrencyLimiter;
  /**
   * Arc 2 sub-slice 8.3 (v2-#8) — pub/sub bus for the SSE transcript
   * stream. AgentRuntime publishes every transcript append; the SSE
   * route subscribes per-sessionId and forwards to the client.
   */
  agentSessionEventBus?: AgentSessionEventBus;
  /**
   * 2026-05-20 — per-account notification SSE bus surfaced at
   * GET /v1/account/me/notifications. When omitted, the route is not
   * registered (opt-in deploy-side wire). Publishers (cost-alert
   * dispatcher today; incident / audit / session.errored later)
   * publish via the bus; the route subscribes per-accountId and
   * forwards every NotificationEvent as an SSE frame.
   */
  notificationEventBus?: NotificationEventBus;
  /**
   * Arc 2 sub-slice 8.4 (v2-#8) — base64-encoded AES-256 key for the
   * gui_control_key auto-mint. Shares MFA_ENCRYPTION_KEY by convention.
   * Omit to skip the route registration.
   */
  guiControlKeyEncryptionKey?: string;
  /**
   * Arc 2 sub-slice 8.8 (v2-#8) — pair-mode takeover lock. Wired
   * conditionally so prod can flip the feature with one env-var.
   */
  pairModeLock?: PairModeTakeoverLock;
  /**
   * AI-B4 — write-only recipe library (orchestrator handoff #3 Q.5).
   * POST /v1/recipes snapshots a finished agent_session's
   * intent_log + transcript. When omitted, /v1/recipes registers
   * as 503 FeatureUnavailable per the activation-gate pattern.
   * Routes the gate ALSO requires `agentSessionsRepo` for the
   * source-session cross-account auth check.
   */
  recipesRepo?: RecipesRepo;
  /**
   * V-820 — fleet-node JWT verifier (foundation slice 95353f2a +
   * nonce-cache integration f2a6c603). Optional. When wired,
   * registers `/v1/fleet/events` WebSocket route (pending the SQL
   * migration; see docs/internal/fleet-nodes-sql-migration-design.md
   * for the Tier-2 founder review proposal). Until then leave
   * undefined.
   */
  fleetNodeAuth?: FleetNodeAuth;
  /**
   * V-820 — JWT replay-defence nonce cache (commit 1b97a5e0). Paired
   * with `fleetNodeAuth`; production injects the Redis-backed impl
   * + the `FleetNodeAuthImpl` constructor receives this here. When
   * omitted, JWT verification still works but loses replay defence.
   */
  fleetNonceCache?: FleetNonceCache;
  /**
   * V-820 — nodeId→connection registry for the /v1/fleet/events WS route. One
   * shared instance per app; the route registers each verified node connection
   * here so the (gated) dispatch path can look up the owning node's socket.
   * Required (with fleetNodeAuth + fleetNonceCache) to take the live WS route off
   * the 503 stub.
   */
  fleetControlRegistry?: FleetControlRegistry;
  /**
   * Latest-pageState-per-agent-session store (W650/A3-W1254). Present alongside
   * the registry when the fleet control plane is enabled; the registry's
   * onPageState consumer writes it + GET /v1/agent-sessions/:id/page-state reads
   * it (the GUI loading-bar/error-overlay source for the agent/simulator view).
   */
  sessionPageStateStore?: SessionPageStateStore;
  /**
   * Latest-worker-liveness-per-agent-session store (A2 W2679 re-base). Present
   * alongside the registry when the fleet control plane is enabled; the
   * registry's onHeartbeat consumer feeds it Heartbeat.activeSessionStates +
   * the agent-sessions `liveness` read-shape field reads it (so the GUI can tell
   * a genuinely-running session from a status='active' row whose worker
   * crashed/never-started). Absent in prod (no fleet CP) → the field is
   * "unknown" (the client trusts the binding; never treated as dead).
   */
  sessionLivenessStore?: SessionLivenessStore;
  /** Latest ownership-gated harness capability/stream/egress state for the
   * installed agent-session GUI. Present with the fleet control plane. */
  sessionCapabilityReportStore?: SessionCapabilityReportStore;
  /**
   * Local fleet-demo session-dispatch config. Present only when the fleet
   * control plane is enabled (bootstrap assembles it alongside the registry);
   * when wired, agent-session create dispatches a sessionAssign to the
   * connected harness node so the new session browses + publishes. Absent in
   * prod → dispatch is a no-op.
   */
  sessionDispatch?: SessionDispatchConfig;
  /**
   * LK.2 — POST /v1/mac-nodes/register depends on a Drizzle-backed
   * fleet_nodes repo (so the LiveKit credentials can persist) plus
   * the encryption key for the AES-256-GCM envelope. Registers only
   * when both are wired. Encryption key is MFA_ENCRYPTION_KEY (the
   * shared host-resident key).
   */
  drizzleFleetNodesRepo?: DrizzleFleetNodesRepo;
  livekitSecretEncryptionKey?: string;
  /**
   * Wave 29-400 §8.5 — atlas-priority observability surface. The repo
   * is always Drizzle-backed (constructed in bootstrap.ts); the
   * activation gate is `internalFleetAuth.isEnabled()` driven by the
   * DRIFTSTACK_FLEET_INTERNAL_TOKEN env var. When the auth is enabled
   * the 4 internal routes register; otherwise the disabled variant
   * 503s on every path.
   */
  atlasPriorityEventsRepo?: DrizzleAtlasPriorityEventsRepo;
  internalFleetAuth?: InternalFleetAuth;
  /**
   * V-100: admin force-action route deps. Routes register only when
   * all four are provided (sessionRepo / apiKeysRepo / driver / audit
   * are all needed for the destroy/revoke handlers).
   *
   * V-237: `sessionRepo` + `profilesRepo` also power
   * `GET /v1/account/me` (customer self-profile with concurrent +
   * profile usage/cap). Route registers only when both are present.
   */
  sessionRepo?: SessionRepo;
  apiKeysRepo?: ApiKeysRepo;
  driver?: Driver;
  /** V-237: profiles repo — feeds /v1/account/me profile counts. */
  profilesRepo?: ProfilesRepo;
  /** ARC A: per-account customer proxies repo — powers /v1/account/me/proxies. */
  accountProxiesRepo?: AccountProxiesRepo | null;
  /** ARC A: proxies service — validates proxy_id on agent-session create +
   *  resolves it (owner-scoped unwrap + SSRF re-guard) into the dispatch. */
  accountProxiesService?: AccountProxiesService;
  /** Founder directive #63: CP-side live proxy connectivity probe — gates a
   *  proxied agent-session launch on a real egress round-trip BEFORE dispatch.
   *  Wired in bootstrap; tests inject a stub-dial instance. */
  proxyConnectivityProbe?: ProxyConnectivityProbe;
  /** Founder directive #63: master switch for the pre-launch probe (ON by default
   *  in bootstrap via DRIFTSTACK_PROXY_PRELAUNCH_PROBE; set 0 to disable). */
  proxyPrelaunchProbeEnabled?: boolean;
  /** ARC A slice 4b: injectable TCP-reachability probe for the proxy test
   *  endpoint (tests inject a deterministic stub; prod uses the default). */
  proxyTcpProbe?: (host: string, port: number, timeoutMs: number) => Promise<void>;
  /** ARC A: decoded PROFILE_MASTER_KEY — wraps proxy passwords under the account
   *  TMK. Null → proxy passwords can't be stored (create/update with a password
   *  → 503). */
  profileMasterKey?: Buffer | null;
  /**
   * V-352b — public R2 bucket client used by avatar upload + the
   * presigned-GET URL surfaced on /v1/account/me. When omitted, the
   * avatar upload endpoint returns 503 FeatureUnavailable and the
   * read endpoint returns `avatar_url: null`. Tests usually omit it;
   * production wires the same client used by V-295c2 status snapshots.
   */
  r2Public?: R2 | null;
  /**
   * Private R2 client (the sealed-profile-blob bucket). Threaded to the
   * agent-session dispatch so a profile-backed session's SessionAssign carries
   * the restore + save-back URLs (buildAssignProfileBlock). Distinct from
   * r2Public (public-asset bucket / presigned GUI reads).
   */
  r2?: R2 | null;
  /**
   * V-353b — MFA service. When omitted, /v1/account/mfa/* routes are
   * not registered. Tests that don't exercise MFA pass null. The
   * service holds the AES-256-GCM env-key encryption + TOTP verifier;
   * persistence is via DrizzleMfaRepo (or the in-memory fixture).
   */
  mfaService?: MfaService;
  /**
   * 2026-05-19 — lowercased email allowlist for staff bump on the
   * web-session auth path. Accounts in this set get
   * `driftstack_internal_admin` appended to the synthetic api-key
   * scope set. Sourced from DRIFTSTACK_STAFF_EMAILS env var at
   * bootstrap (comma-separated; whitespace + case normalized).
   * Empty / undefined → no bump.
   */
  staffEmails?: ReadonlySet<string>;
  /**
   * 2026-06-04 — lowercased email of the project OWNER (master) account.
   * The owner passes the `requireOwner` guard that gates the high-power
   * admin surfaces (pricing, secrets, project config). Sourced from
   * DRIFTSTACK_OWNER_EMAIL at bootstrap (defaults to the founder account)
   * and also unioned into `staffEmails` so the owner is always admin.
   * Undefined → `requireOwner` fails closed (no owner configured = no
   * owner access).
   */
  ownerEmail?: string | null;
  /**
   * AI-CHAT BYOK Anthropic — per-customer key storage service.
   * Activation-gate: present when MFA_ENCRYPTION_KEY env var is
   * configured (the BYOK store reuses the MFA encryption key per
   * Q1 verdict 2026-05-17). When absent, the 4
   * `/v1/account/me/byok-anthropic-key*` routes return 503 +
   * FeatureUnavailable via `registerAccountByokAnthropicDisabledRoutes`.
   */
  byokAnthropicService?: BYOKAnthropicService;
  /**
   * Readiness checks executed by `/ready`. Each runs with the
   * supplied (or default 1500ms) timeout; aggregate result drives
   * the HTTP status (200 all-ok, 503 any-fail). Empty array =
   * /ready always returns 200 (process-up semantics only).
   */
  readinessChecks?: ReadinessCheck[];
  /** When true, register a permissive CORS policy. Production locks this down. */
  permissiveCors?: boolean;
  /**
   * Fastify `trustProxy` (from `config.trustProxy` ← `TRUST_PROXY` env). Drives
   * `req.ip` / `X-Forwarded-For` resolution. Prod = `1` (Cloudflare→nginx→
   * Fastify; nginx appends the real client, ufw blocks :7780 so nginx is the
   * only peer). Omitted/undefined → false (dev/test: req.ip = socket peer).
   * Without this, `req.ip` is the loopback peer behind nginx → per-IP rate
   * limiting collapses to one bucket + audit IPs record 127.0.0.1.
   */
  trustProxy?: boolean | number | string;
  /**
   * V-278.B follow-up — explicit allow-list of origins for production
   * CORS. Set via env `CORS_ALLOWED_ORIGINS=https://app.driftstack.dev,https://staging.driftstack.dev`.
   * When set + `permissiveCors=false`, the app accepts requests from
   * exactly these origins (in addition to the localhost regex pattern
   * for ad-hoc dev probing). Empty / undefined = localhost-only (dev).
   */
  corsAllowedOrigins?: string[];
  /**
   * V-278.C — the canonical customer dashboard origin (config.dashboardOrigin,
   * which prod REQUIRES to be a real non-localhost origin). Auto-added to the
   * strict CORS allow-list so flipping `permissiveCors=false` (the security
   * hardening) can never lock out the primary dashboard even if an operator
   * forgets to list it in CORS_ALLOWED_ORIGINS. No effect while permissiveCors
   * is true (origin:* echo). Harmless in dev (the localhost regex already
   * covers the localhost default).
   */
  dashboardOrigin?: string;
  /**
   * V-117: optional Sentry client. When provided, the app installs:
   *   - `wireSentryErrorHandler` (V-094) — onError hook captures
   *     exceptions with request context.
   *   - `wireSentryRequestBreadcrumbs` (V-116) — onRequest +
   *     onResponse hooks emit per-request breadcrumbs.
   * Both hooks are no-ops when `sentry.isInitialized` is false.
   * Tests routinely omit this — Sentry stays out of the test path.
   */
  sentry?: SentryClient;
  /**
   * V-337 — minimal driver-mode marker exposed on /version so the
   * GUI's Connectivity test + admin observability can show "this
   * server is running on the playwright dev driver / mock / webkit
   * fork". No customer-impactful info; settable via DRIVER env, so
   * disclosure is not a leak. Defaults to 'mock' when omitted.
   */
  driverName?: 'mock' | 'webkit' | 'playwright';
  /** V-337 — playwright browser channel, surfaced when driverName === 'playwright'. */
  playwrightBrowser?: 'webkit' | 'chromium' | 'firefox';
  /** #139 — true when AI Browser Automation executes for real over the fleet
   *  control plane (ControlPlaneAgentExecutor wired). Surfaced on /version as
   *  `agent_execution` so the GUI can drop the "actions are simulated" note.
   *  Independent of `driverName` (which is the local driver, not the fleet path). */
  agentExecutionLive?: boolean;
  /**
   * V-531.B — LiveKit access-token mint surface. When all three fields
   * are present (apiKey + apiSecret + wsUrl), POST /v1/sessions/:id/
   * livekit-token is registered. Partial config = unregistered route;
   * client gets a 404 and falls back to the HTTP polling plane.
   * Same wire-ready posture as V-487 NowPayments + V-665 Postmark.
   */
  livekit?: {
    apiKey: string;
    apiSecret: string;
    wsUrl: string;
  };
  /**
   * V-667.C — OAuth-CLIENT routes (/v1/auth/oauth-client/* + per-
   * provider /v1/auth/oauth/{provider}/callback). When the service is
   * provided AND the config has at least one fully-configured
   * provider + signingSecret + callbackUrlBase, the routes register.
   *
   * `dashboardOrigin` is consumed by the per-provider IDP-redirect
   * landing routes to 302 the browser back to the SPA callback page
   * (`${dashboardOrigin}/auth/oauth-client/callback`).
   */
  oauthClientService?: OAuthClientService;
  oauthClient?: {
    signingSecret: string;
    /** Base origin+prefix for per-provider callback URL derivation.
     *  Full URL passed to the IDP: `${callbackUrlBase}/${provider}/callback`. */
    callbackUrlBase: string;
    /** Dashboard origin for the post-IDP 302 redirect target. */
    dashboardOrigin: string;
    google?: { clientId: string; clientSecret: string };
    github?: { clientId: string; clientSecret: string };
  };
  /**
   * V-667.C-followup — drives the customer-facing
   * /v1/account/me/oauth-links read endpoint. Always paired with
   * oauthClientService in bootstrap; tests can wire just this repo
   * to register the read endpoint without the full OAuth-client
   * surface.
   */
  oauthLinksRepo?: OAuthLinksRepo;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({
    loggerInstance: deps.logger as unknown as FastifyBaseLogger,
    disableRequestLogging: false,
    // req.ip / X-Forwarded-For resolution. Default false (dev/test = socket
    // peer); prod injects deps.trustProxy=1 so req.ip is the real client behind
    // Cloudflare→nginx (per-IP rate-limit + audit-IP correctness).
    trustProxy: deps.trustProxy ?? false,
    genReqId: (req) => {
      const inbound = req.headers['x-request-id'];
      if (typeof inbound === 'string' && inbound.length > 0 && inbound.length <= 128) {
        return inbound;
      }
      return randomUUID();
    },
  });

  // V-664 — security headers. Helmet defaults are tuned for HTML
  // surfaces; for a JSON API some defaults are wrong (CORP same-origin
  // would block legitimate cross-origin SDK calls; CSP doesn't apply
  // to JSON responses). The config below makes the chosen policy
  // explicit so the security posture is reviewable.
  await app.register(helmet, {
    // No HTML to protect — CSP is a no-op for JSON-only responses.
    contentSecurityPolicy: false,
    // SDK consumers fetch from any origin; the CORS middleware below is
    // the boundary, not CORP. Setting CORP to cross-origin (rather than
    // helmet's default same-origin) avoids blocking SDK preflights at
    // the response layer.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    // Same logic for embedder policy — require-corp would force every
    // embedded resource to opt in, which is not how a JSON API is consumed.
    crossOriginEmbedderPolicy: false,
    // HSTS posture: 2 years, include subdomains, preload-eligible.
    // The deploy is already HTTPS-only via Cloudflare; HSTS preload
    // closes the gap on first-visit downgrade attacks.
    strictTransportSecurity: {
      maxAge: 63_072_000,
      includeSubDomains: true,
      preload: true,
    },
    // Defaults retained explicitly:
    // - X-Content-Type-Options: nosniff
    // - X-Frame-Options: SAMEORIGIN  (we ship no embeddable UI)
    // - Referrer-Policy: no-referrer
    // - X-DNS-Prefetch-Control: off
  });
  // V-664.B — CORS hardening. Pins methods, allowed headers, and
  // preflight cache window explicitly. Without these, defaults expand
  // the surface in ways that are easy to miss.
  //
  // `credentials: true` is required by the customer dashboard's
  // cookie-based session (Article-13 auth), NOT by the SDK (which
  // sends Authorization: Bearer ...). With credentials:true the spec
  // forbids origin:*, hence the explicit allow-list / regex in prod.
  await app.register(cors, {
    // W586 — the allow-list lives in lib/cors-allow.ts (corsOriginMatchers) as
    // the single source of truth, so the SSE routes (which hijack the reply
    // and bypass this plugin's onSend hook) reflect the SAME origins. The
    // matchers: localhost (any scheme/port) + the Tauri desktop webview
    // origins (tauri://localhost + https://tauri.localhost — without these the
    // GUI's cross-origin fetch fails preflight with a useless "Load failed") +
    // the canonical dashboard origin (V-278.C, always allowed so a strict-
    // posture flip can't lock out the primary surface) + CORS_ALLOWED_ORIGINS.
    origin: deps.permissiveCors === true ? true : corsOriginMatchers(deps),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'authorization',
      'content-type',
      'x-request-id',
      'stripe-signature',
      'x-nowpayments-sig',
      // 2026-05-22 — V-666.AO + v2-#19 — `Idempotency-Key` header is
      // sent by the customer-dashboard JS on crypto-checkout +
      // agent-session create. Without this allowance the browser
      // blocks the preflight + the POST never fires ("Failed to
      // fetch" in the UI). Founder reproduced it on /select-tier
      // → "Pay Personal with crypto" path.
      'idempotency-key',
      // 2026-05-17 — BYOK Anthropic key per-request override header
      // (Q.1.c verdict). The /v1/agent-sessions/:id/message route
      // accepts it as an override over the cached/bundled key.
      'x-byok-anthropic-api-key',
      // V-330 — team-scoped writes use this header to act-as the
      // team owner. Same browser preflight gap.
      'x-driftstack-account',
      // 2026-06-30 — the GUI authenticates per-session control calls
      // (GET /:id/cookies, GET /:id/downloads, /downloads/content, taps,
      // history) with the scoped `x-driftstack-gui-control-key` instead of
      // the API bearer (agent-session-control.ts). Without this allowance the
      // browser preflight (OPTIONS) fails → the GET never fires and the box is
      // never asked → founder saw "couldn't load cookies / couldn't reach the
      // device for downloads — retrying" (OPTIONS-only, no GET, in the journal).
      'x-driftstack-gui-control-key',
    ],
    exposedHeaders: [
      'x-request-id',
      // Crypto checkout replays are safe only when the cross-origin GUI can
      // distinguish the restored order from a freshly minted response.
      'idempotent-replayed',
      // W199 — full RateLimit-header set documented at /docs/rate-limits.
      'x-ratelimit-bucket',
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
      // W561 — IETF draft names (ratelimit-reset is relative delta-seconds).
      'ratelimit-limit',
      'ratelimit-remaining',
      'ratelimit-reset',
      'retry-after',
    ],
    // Cache preflight responses for 10 minutes — reduces CORS preflight
    // round-trips for the SDK + dashboard without delaying policy
    // changes excessively (deploy frequency is daily-ish; 10 min is
    // shorter than any expected policy-change ETA).
    maxAge: 600,
  });

  await app.register(requestIdPlugin);

  // V-117: install Sentry hooks BEFORE auth/rate-limit so breadcrumbs
  // capture every request — including ones that fail at the auth or
  // rate-limit gate.
  if (deps.sentry !== undefined) {
    wireSentryRequestBreadcrumbs(app, deps.sentry);
    wireSentryErrorHandler(app, deps.sentry);
  }

  // DoS hardening — GLOBAL IP-keyed rate limit, app-wide, in an onRequest
  // hook so it runs BEFORE any route's auth preHandler. The account-keyed
  // limiter (app.rateLimit) only fires AFTER auth succeeds — it never
  // gates a request that 401s, so an unauthenticated flood of bogus
  // bearer / control-key headers reaches findApiKeyByPrefix + scrypt +
  // AES-GCM ungated. This gate caps each source IP regardless of route or
  // auth outcome. It reuses the shared rate-limit store + the proven
  // ipRateLimit primitive (on a store error it degrades to a bounded
  // per-instance fallback rather than removing limiting, so a Redis blip
  // can't both 500 the API AND open the floodgates). Defaults to
  // 600/min/IP; pass null to disable (tests do, to keep their high-volume
  // inject loops unaffected).
  const globalIpGateCfg =
    deps.globalIpRateLimit === undefined ? GLOBAL_IP_RATE_LIMIT_DEFAULT : deps.globalIpRateLimit;
  if (globalIpGateCfg !== null) {
    const globalIpGate = ipRateLimit(
      deps.rateLimitStore,
      {
        bucketPrefix: 'global_ip',
        capacity: globalIpGateCfg.capacity,
        refillPerSecond: globalIpGateCfg.refillPerSecond,
      },
      deps.metricsRegistry,
    );
    app.addHook('onRequest', globalIpGate);
  }

  await app.register(authPlugin, {
    authRepo: deps.authRepo,
    authCache: deps.authCache,
    authCoalescer: deps.authCoalescer,
    // DoS hardening — negative auth cache: a repeated bogus token skips
    // the prefix-lookup + scrypt verify after the first rejection.
    negativeAuthCache: deps.negativeAuthCache ?? null,
    ...(deps.oauthStore !== undefined ? { oauthStore: deps.oauthStore } : {}),
    // V-353e — step-up gate consults MFA enrollment state; null when
    // MFA is disabled in this deploy (gate becomes a no-op).
    mfaService: deps.mfaService ?? null,
    // 2026-05-19 — staff-emails allowlist. Web-session auth bumps
    // these accounts with `driftstack_internal_admin` scope. Empty
    // set when undefined (default; no bump). See deps.staffEmails
    // sourcing at bootstrap time.
    ...(deps.staffEmails !== undefined ? { staffEmails: deps.staffEmails } : {}),
    // 2026-06-04 — project owner email for the requireOwner gate.
    ...(deps.ownerEmail != null ? { ownerEmail: deps.ownerEmail } : {}),
    ...(deps.metricsRegistry !== undefined ? { metrics: deps.metricsRegistry } : {}),
  });
  await app.register(rateLimitPlugin, {
    store: deps.rateLimitStore,
    ...(deps.metricsRegistry !== undefined ? { metrics: deps.metricsRegistry } : {}),
  });

  // C1 — device-key deny-gate. A global preHandler that bars a
  // cli-authorize device-provisioned key from the account-takeover /
  // persistence / exfil routes (mint/rotate/revoke keys, MFA, team,
  // Stripe billing, webhook writes, BYOK, web-session nuke). Registered
  // after the auth plugin so it can lazy-auth via app.requireAuth.
  registerDeviceKeyDenyGate(app);

  registerErrorHandler(app);

  // V-666.BS/BT/BW (broadened to ALL of /v1) — default Cache-Control:
  // no-store, private on every caller-private /v1 response. The header
  // started life on /v1/account/* (profile, audit log, costs, MFA, sessions,
  // rate-limit usage), then /v1/admin/* + /v1/billing/* — but that left other
  // equally caller-private families uncovered (/v1/sessions, /v1/profiles,
  // /v1/profile-snapshots, /v1/agent-sessions, /v1/api-keys, /v1/webhooks,
  // /v1/webhook-deliveries, /v1/team, /v1/usage, /v1/oauth, /v1/legal/required,
  // ...) whose GET payloads are caller-private and must not sit in a shared /
  // proxy / browser cache. So it's now the default for ALL of /v1, with two
  // deliberate carve-outs:
  //   1. /v1/status* — the PUBLIC status page (status / incidents / sla /
  //      stream): public + cacheable; those routes set their own
  //      `public, max-age=30`. Excluded by prefix.
  //   2. Never OVERRIDE a Cache-Control a route set itself. Preserves the
  //      public incident reads' `public, max-age=30` AND — critically — the SSE
  //      streams' `no-cache, no-transform` (no-transform stops proxies buffering
  //      the event stream; clobbering it to no-store would risk breaking SSE
  //      delivery — a latent bug the old unconditional /v1/account/* stamp had
  //      for the notifications stream).
  app.addHook('onSend', (req, reply, _payload, done) => {
    if (
      req.url.startsWith('/v1/') &&
      !req.url.startsWith('/v1/status') &&
      reply.getHeader('cache-control') === undefined
    ) {
      void reply.header('cache-control', 'no-store, private');
    }
    done();
  });

  // Arc 7 obs.15 — foundational HTTP request counter. Per-request
  // tick keyed by method × route-template × status_class. The route
  // template (e.g. `/v1/sessions/:id`) is what Fastify exposes as
  // routerPath / routeOptions.url; falling back to '__unrouted__'
  // when neither is available avoids leaking the raw URL (which
  // would carry account / session ids and blow up cardinality).
  if (deps.metricsRegistry !== undefined) {
    const registry = deps.metricsRegistry;
    app.addHook('onResponse', (req, reply, done) => {
      const method = req.method.toUpperCase();
      // Fastify v4 exposes the matched route template under
      // routeOptions.url; older code paths used routerPath. Prefer
      // routeOptions.url; fall back to routerPath; finally fall back
      // to the synthetic 'unrouted' bucket so 404s don't leak the
      // requested URL.
      const ro = (req as { routeOptions?: { url?: string } }).routeOptions;
      const route = ro?.url ?? (req as { routerPath?: string }).routerPath ?? '__unrouted__';
      const status = reply.statusCode;
      const statusClass =
        status >= 500
          ? '5xx'
          : status >= 400
            ? '4xx'
            : status >= 300
              ? '3xx'
              : status >= 200
                ? '2xx'
                : '1xx';
      try {
        registry.inc(METRIC_NAMES.httpRequestTotal, {
          method,
          route,
          status_class: statusClass,
        });
      } catch {
        // Swallow; metrics are best-effort. Never break a response.
      }
      done();
    });
  }

  // Direct /v1/sessions creation has no typed, owner-validated egress
  // transport. Default/inferred policy still follows backend presence, but a
  // true value now disables that direct surface instead of accepting a raw
  // proxy-shaped object that no service/driver consumes. Saved proxy_id egress
  // remains available through /v1/agent-sessions.
  const egressProxyRequired = deps.sessionProxyRequired ?? deps.sessionEgressService !== undefined;
  // Make the fail-closed posture explicit at boot: operators must not infer
  // that supplying an untyped raw proxy field re-enables these routes.
  if (egressProxyRequired) {
    app.log.warn(
      { component: 'egress-safeguard' },
      'Direct session creation is DISABLED: this deployment requires customer egress, but ' +
        'POST /v1/sessions and POST /v1/profiles/:id/launch have no typed consumed egress ' +
        'authority. Use POST /v1/agent-sessions with an owned saved proxy_id; do not send a ' +
        'raw proxy field.',
    );
  }

  registerSessionRoutes(app, {
    service: deps.sessionsService,
    authRepo: deps.authRepo,
    egressProxyRequired,
    // 2026-05-20 — antidetect-browser-style profile binding. Routes
    // need the profiles service to validate profile_id ownership +
    // bump last_used_at when a session is created against a profile.
    // Optional so test fixtures without profiles still register.
    ...(deps.profilesService !== undefined ? { profilesService: deps.profilesService } : {}),
  });
  registerAdminRoutes(app, {
    apiKeysService: deps.apiKeysService,
    usageService: deps.usageService,
    authRepo: deps.authRepo,
  });
  registerWebhookRoutes(app, { service: deps.webhooksService });
  registerAdminAccountsRoutes(app, {
    accountsAdmin: deps.accountsAdminService,
    usage: deps.usageService,
    rateLimitOverrides: deps.rateLimitOverridesService,
    audit: deps.adminAuditService,
    accountAudit: deps.accountAuditService,
  });
  if (deps.incidentsService !== undefined) {
    registerAdminIncidentsRoutes(app, {
      incidentsService: deps.incidentsService,
      audit: deps.adminAuditService,
      rateLimitStore: deps.rateLimitStore,
    });
  }
  if (deps.statusSubscribersService !== undefined) {
    registerStatusSubscribeRoutes(app, {
      service: deps.statusSubscribersService,
      rateLimitStore: deps.rateLimitStore,
    });
    registerAdminStatusSubscribersRoutes(app, {
      service: deps.statusSubscribersService,
      audit: deps.adminAuditService,
    });
  }
  if (deps.incidentEventBus !== undefined && deps.slaReportingService !== undefined) {
    registerStatusStreamRoutes(app, {
      bus: deps.incidentEventBus,
      sla: deps.slaReportingService,
      rateLimitStore: deps.rateLimitStore,
      cors: {
        permissiveCors: deps.permissiveCors,
        dashboardOrigin: deps.dashboardOrigin,
        corsAllowedOrigins: deps.corsAllowedOrigins,
      },
    });
  }
  if (deps.teamMembersService !== undefined) {
    registerTeamRoutes(app, { service: deps.teamMembersService });
  }
  registerAdminWebhookRoutes(app, {
    webhooksAdmin: deps.webhooksAdminService,
    audit: deps.adminAuditService,
  });
  registerAdminAuditLogRoutes(app, { audit: deps.adminAuditService });
  registerAdminOverviewRoutes(app, {
    accountsAdmin: deps.accountsAdminService,
    webhooksAdmin: deps.webhooksAdminService,
  });
  registerAdminBillingRoutes(app, { adminBilling: deps.adminBillingService });
  // Owner-only platform status — flags mirror the exact registration guards
  // used below so each reflects whether that feature's routes are live.
  registerAdminOwnerRoutes(app, {
    platformStatus: {
      billing: deps.billingService !== undefined,
      livekit: deps.livekit !== undefined,
      crypto: deps.cryptoOrdersService !== undefined,
      oauth_client: deps.oauthClientService !== undefined,
      sentry: deps.sentry !== undefined,
      permissive_cors: deps.permissiveCors === true,
    },
    pricing: deps.pricingService,
    audit: deps.adminAuditService,
    secrets: deps.platformSecretsService,
  });
  registerAdminSessionsRoutes(app, { sessionsService: deps.sessionsService });
  registerAdminApiKeysRoutes(app, { apiKeysService: deps.apiKeysService });
  registerAdminRateLimitOverridesRoutes(app, {
    rateLimitOverrides: deps.rateLimitOverridesService,
  });
  registerLegalRoutes(app, deps.legalService);
  registerEmailPreferencesRoutes(app, {
    emailPreferences: deps.emailPreferencesService,
    // 2026-05-20 — audit emit on toggle (closes the last 2026-05-19
    // audit-coverage gap).
    ...(deps.accountAuditService !== undefined ? { accountAudit: deps.accountAuditService } : {}),
  });
  registerAccountAuditRoutes(app, { accountAudit: deps.accountAuditService });
  registerAdminValidationHarnessRoutes(app, {
    harness: deps.validationHarnessService,
    audit: deps.adminAuditService,
  });
  registerAccountRateLimitsRoutes(app);
  // 2026-05-20 — GUI panel notification SSE stream. Registers only
  // when deps.notificationEventBus is wired (opt-in deploy-side).
  registerAccountNotificationsRoutes(
    app,
    deps.notificationEventBus !== undefined
      ? {
          notificationBus: deps.notificationEventBus,
          // W586 — SSE hijacks the reply; pass the same CORS allow-list config
          // the global plugin uses so the stream carries ACAO.
          cors: {
            permissiveCors: deps.permissiveCors,
            dashboardOrigin: deps.dashboardOrigin,
            corsAllowedOrigins: deps.corsAllowedOrigins,
          },
        }
      : {},
  );
  // V-237 — customer self-profile for tier-aware GUI enforcement.
  // Registers only when both repos are wired (production always; tests
  // when fixtures expose them).
  if (deps.sessionRepo !== undefined && deps.profilesRepo !== undefined) {
    registerAccountMeRoutes(app, {
      sessionRepo: deps.sessionRepo,
      profilesRepo: deps.profilesRepo,
      authRepo: deps.authRepo,
      authCache: deps.authCache,
      r2Public: deps.r2Public ?? null,
      mfaService: deps.mfaService ?? null,
      accountProxiesRepo: deps.accountProxiesRepo ?? null,
      profileMasterKey: deps.profileMasterKey ?? null,
      ...(deps.proxyTcpProbe !== undefined ? { proxyTcpProbe: deps.proxyTcpProbe } : {}),
      // Audit egress-config changes (proxy.created / proxy.deleted).
      ...(deps.accountAuditService !== undefined ? { accountAudit: deps.accountAuditService } : {}),
      // 2026-05-19 — OAuth-IDP avatar fallback for the avatar_url
      // response field. When the account has no R2-uploaded avatar
      // BUT has an OAuth link with a provider_avatar_url, return that
      // URL so Gmail/GitHub sign-ins show their IDP profile pic.
      ...(deps.oauthLinksRepo !== undefined ? { oauthLinksRepo: deps.oauthLinksRepo } : {}),
    });
  }
  // V-176 — public-facing status endpoint. Reuses the readinessChecks
  // already supplied to /ready; no additional wiring needed at deps
  // level. /v1/status has no auth (public status pages are public).
  registerStatusRoutes(app, {
    readinessChecks: deps.readinessChecks ?? [],
    ...(deps.incidentsService ? { incidentsService: deps.incidentsService } : {}),
  });

  // Public source of truth for customer-selectable device/iOS/Safari combinations.
  // Derived from api-types' canonical registry; no deployment-specific dependency.
  registerArchetypeRoutes(app);

  // Exit-IP echo for device-side proxy probes (proxy-probe-backend design,
  // build-order step 1). Unauthenticated by design + IP-rate-limited.
  registerEgressEchoRoutes(app, { rateLimitStore: deps.rateLimitStore });

  // Arc 4 Wave 2.B sub-slice 8.18 (v2-#8) — Prometheus /metrics scrape.
  // Registers only when the registry is wired (deps.metricsRegistry).
  // The route lives at /metrics (no /v1 prefix — scrape conventions
  // expect the well-known path). Bearer-token gated via
  // METRICS_SCRAPE_TOKEN env var; the token is forwarded through
  // deps.metricsScrapeToken at bootstrap.
  if (deps.metricsRegistry !== undefined) {
    registerMetricsRoutes(app, {
      registry: deps.metricsRegistry,
      scrapeToken: deps.metricsScrapeToken ?? null,
    });
  }
  if (deps.authFlowsService !== undefined) {
    registerAuthRoutes(app, {
      service: deps.authFlowsService,
      rateLimitStore: deps.rateLimitStore,
    });
    // V-355 — customer-facing web-session list + revoke. Lives next to
    // the auth flows since it shares the AuthFlowsService surface.
    registerAccountWebSessionsRoutes(app, {
      service: deps.authFlowsService,
      // Audit sign-in revocations (account.web_session_revoked).
      ...(deps.accountAuditService !== undefined ? { accountAudit: deps.accountAuditService } : {}),
    });
  }
  // V-353b — customer-facing MFA enrollment + verify + disable +
  // recovery codes. Independent of authFlowsService — the routes are
  // bearer-auth-gated like everything else, no /v1/auth/* dependency.
  if (deps.mfaService !== undefined) {
    registerAccountMfaRoutes(app, { service: deps.mfaService });
  }
  // AI-CHAT BYOK Anthropic — 6th activation-gate feature (after
  // billing / session-proxy / saved-proxies / agent-sessions /
  // fleet-events). Active when MFA_ENCRYPTION_KEY env is set (the
  // BYOK store reuses MFA's encryption key per Q1 verdict 2026-05-17).
  // Otherwise the disabled stubs surface 503 + FeatureUnavailable so
  // the dashboard sees a machine-readable "not yet enabled" signal.
  if (deps.byokAnthropicService !== undefined) {
    registerAccountByokAnthropicRoutes(app, {
      service: deps.byokAnthropicService,
      ...(deps.metricsRegistry !== undefined ? { metrics: deps.metricsRegistry } : {}),
      // 2026-05-20 — best-effort customer audit-log emission on
      // PUT/DELETE/POST-test of the BYOK key. Pre-launch blocker per
      // the 2026-05-19 audit-log-coverage audit.
      ...(deps.accountAuditService !== undefined ? { accountAudit: deps.accountAuditService } : {}),
    });
  } else {
    registerAccountByokAnthropicDisabledRoutes(app);
  }
  // Arc 1 sub-slice 6.6 (v2-#6) — bundled-LLM self-service routes.
  // No 503 stub: bundledLlmService is always wired by bootstrap;
  // a deploy missing the deployment fallback key still lets customers
  // PATCH their consent flag (the resolution-time gate handles
  // the no-fallback case).
  if (deps.bundledLlmService !== undefined) {
    registerAccountBundledLlmRoutes(app, {
      service: deps.bundledLlmService,
      // 2026-05-20 — audit emit on consent toggle (Tier 2 polish per
      // 2026-05-19 audit-coverage doc).
      ...(deps.accountAuditService !== undefined ? { accountAudit: deps.accountAuditService } : {}),
    });
  }
  if (deps.cliAuthorizeService !== undefined) {
    registerAuthCliRoutes(app, {
      cliAuthorizeService: deps.cliAuthorizeService,
      apiKeysService: deps.apiKeysService,
      rateLimitStore: deps.rateLimitStore,
    });
  }
  if (deps.stripeWebhooksService !== undefined && deps.stripeWebhookSigningSecret !== undefined) {
    registerStripeWebhookRoutes(app, {
      service: deps.stripeWebhooksService,
      signingSecret: deps.stripeWebhookSigningSecret,
      logger: deps.logger,
      ...(deps.metricsRegistry !== undefined ? { metrics: deps.metricsRegistry } : {}),
    });
  }
  if (deps.nowpaymentsIpnSecret !== undefined && deps.nowpaymentsIpnSecret.length > 0) {
    registerNowpaymentsWebhookRoutes(app, {
      ipnSecret: deps.nowpaymentsIpnSecret,
      logger: deps.logger,
      ...(deps.cryptoOrdersService !== undefined
        ? { ordersService: deps.cryptoOrdersService }
        : {}),
      ...(deps.metricsRegistry !== undefined ? { metrics: deps.metricsRegistry } : {}),
    });
  }
  // (W363) The legacy V-531.B POST /v1/sessions/:id/livekit-token route was
  // DELETED — it let the body pick role:'publisher' (canPublish:true), an
  // over-grant letting a customer publish to their own capture room. The
  // canonical subscriber-only POST /v1/agent-sessions/:id/livekit-token
  // (registered below) is the sole token-mint path.
  // V-667.C — OAuth-client routes. Gated on: service wired +
  // signingSecret + callbackUrlBase + at least one provider configured
  // + authFlowsService (2026-05-19 — needed to mint the web session
  // after a successful link-or-create; without it, the callback
  // returns no session token and the dashboard shows "Sign in to see
  // live account data" instead of the signed-in state).
  if (
    deps.oauthClientService !== undefined &&
    deps.oauthClient !== undefined &&
    deps.authFlowsService !== undefined &&
    (deps.oauthClient.google !== undefined || deps.oauthClient.github !== undefined)
  ) {
    const providers: Record<string, { clientId: string; clientSecret: string }> = {};
    if (deps.oauthClient.google) providers.google = deps.oauthClient.google;
    if (deps.oauthClient.github) providers.github = deps.oauthClient.github;
    registerOAuthClientRoutes(app, {
      service: deps.oauthClientService,
      providers: providers,
      callbackUrlBase: deps.oauthClient.callbackUrlBase,
      dashboardOrigin: deps.oauthClient.dashboardOrigin,
      signingSecret: deps.oauthClient.signingSecret,
      authFlows: deps.authFlowsService,
      // 2026-05-20 — required for IP-gate preHandlers on /start +
      // /callback + /confirm-merge. Same store the AUTH_IP_LIMITS
      // gates on auth.ts use.
      rateLimitStore: deps.rateLimitStore,
      logger: deps.logger,
    });
  }
  // V-667.C-followup — customer-facing list of linked IDPs. Gated
  // independently on oauthLinksRepo so tests can probe the read
  // surface without spinning the full OAuth-client flow.
  if (deps.oauthLinksRepo !== undefined) {
    registerAccountOauthLinksRoutes(app, { links: deps.oauthLinksRepo });
  }
  if (deps.cryptoOrdersService !== undefined) {
    registerCryptoCheckoutRoutes(app, {
      service: deps.cryptoOrdersService,
      pricing: deps.pricingService,
      ...(deps.nowpaymentsApiClient !== undefined && deps.nowpaymentsIpnCallbackUrl !== undefined
        ? {
            nowpayments: deps.nowpaymentsApiClient,
            nowpaymentsIpnCallbackUrl: deps.nowpaymentsIpnCallbackUrl,
          }
        : {}),
    });
    registerCustomerCryptoOrdersRoutes(app, { service: deps.cryptoOrdersService });
    registerAdminCryptoOrdersRoutes(app, {
      service: deps.cryptoOrdersService,
      audit: deps.adminAuditService,
    });
  }
  registerCryptoQuoteRoutes(app, { pricing: deps.pricingService });
  if (deps.oauthStore !== undefined) {
    registerOAuthRoutes(app, {
      service: new OAuthService(deps.oauthStore),
      rateLimitStore: deps.rateLimitStore,
      ...(deps.metricsRegistry !== undefined ? { metrics: deps.metricsRegistry } : {}),
    });
  }
  if (deps.costMonitoringService !== undefined) {
    registerAdminCostRoutes(app, { service: deps.costMonitoringService });
    registerAccountCostRoutes(app, { service: deps.costMonitoringService });
  }
  registerAdminUsageRoutes(app, {
    usageService: deps.usageService,
    accountsAdminService: deps.accountsAdminService,
  });
  if (deps.profilesService !== undefined) {
    registerProfileRoutes(app, {
      service: deps.profilesService,
      authRepo: deps.authRepo,
      // doc-150 §8 — out-of-session profile trim picks a healthy node + presigns R2.
      // Both optional: absent (stateless deploy / fleet off) → POST /:id/trim returns
      // a graceful `unavailable`, exactly like the cookies route.
      ...(deps.fleetControlRegistry !== undefined
        ? { fleetControlRegistry: deps.fleetControlRegistry }
        : {}),
      ...(deps.r2 ? { r2: deps.r2 } : {}),
      // #14 — agent-sessions repo for the trim's "profile bound to a live
      // session?" guard (countActiveForProfile). Absent → guard skipped.
      ...(deps.agentSessionsRepo !== undefined ? { agentSessions: deps.agentSessionsRepo } : {}),
    });
    // V-312 — profile snapshots routes share the profiles service +
    // auth repo. Registers only when profilesService is wired.
    if (deps.profileSnapshotsService !== undefined) {
      registerProfileSnapshotsRoutes(app, {
        service: deps.profileSnapshotsService,
        profilesService: deps.profilesService,
        authRepo: deps.authRepo,
      });
    }
  }
  if (deps.billingService !== undefined) {
    registerBillingRoutes(app, { service: deps.billingService });
  } else {
    // Wave 1119 / Slice 1119.2 — when Stripe env is missing, expose
    // 503 + FeatureUnavailable on /v1/billing/* instead of leaving
    // the routes unregistered (which 404s). See registerBilling-
    // DisabledRoutes for the full reason.
    registerBillingDisabledRoutes(app);
  }

  // EG-API-1.2 — customer-configurable egress route surface. Same
  // activation-gate posture as billing above: registered route returns
  // 503 FeatureUnavailable when no backend is wired so SDK clients and
  // the dashboard get a machine-readable "not yet shipped" signal.
  if (deps.sessionEgressService !== undefined) {
    registerSessionProxyRoutes(app, { service: deps.sessionEgressService });
  } else {
    registerSessionProxyDisabledRoutes(app);
  }

  // AI-D — /v1/agent-sessions/* route surface. Same activation gate
  // as EGRESS: register real routes when both runtime + repo are
  // wired in AppDeps; otherwise register 503 stubs so SDK + dashboard
  // see a machine-readable "not yet enabled" signal.
  if (deps.agentRuntime !== undefined && deps.agentSessionsRepo !== undefined) {
    registerAgentSessionsRoutes(app, {
      runtime: deps.agentRuntime,
      sessions: deps.agentSessionsRepo,
      ...(deps.agentTurnReceiptsRepo !== undefined
        ? { agentTurnReceipts: deps.agentTurnReceiptsRepo }
        : {}),
      // W650/A3-W1254 — agent-session pageState read (GUI loading-bar/overlay).
      // Present only when the fleet control plane wired the store.
      ...(deps.sessionPageStateStore !== undefined
        ? { sessionPageStateStore: deps.sessionPageStateStore }
        : {}),
      // A2 W2679 re-base — agent-session worker-liveness read (GUI re-bases
      // open-session liveness onto this). Present only when the fleet control
      // plane wired the store; absent → `liveness` defaults to "unknown".
      ...(deps.sessionLivenessStore !== undefined
        ? { sessionLivenessStore: deps.sessionLivenessStore }
        : {}),
      ...(deps.sessionCapabilityReportStore !== undefined
        ? { sessionCapabilityReportStore: deps.sessionCapabilityReportStore }
        : {}),
      ...(deps.byokAnthropicService !== undefined
        ? { byokService: deps.byokAnthropicService }
        : {}),
      ...(deps.byokKeyCache !== undefined ? { byokKeyCache: deps.byokKeyCache } : {}),
      ...(deps.exitIdentityCache !== undefined
        ? { exitIdentityCache: deps.exitIdentityCache }
        : {}),
      // Q.1 — decomposer kind drives whether the ByokAnthropicRequired
      // 502 fires. Default 'deterministic' matches the safe-default
      // branch of bootstrap's selectAgentDecomposer when neither key
      // path is wired.
      agentDecomposerKind: deps.agentDecomposerKind ?? 'deterministic',
      ...(deps.agentDecomposerFallbackKey !== undefined
        ? { deploymentFallbackKey: deps.agentDecomposerFallbackKey }
        : {}),
      ...(deps.agentDecomposerAllowFallback !== undefined
        ? {
            allowFallbackForUnconfiguredCustomers: deps.agentDecomposerAllowFallback,
          }
        : {}),
      // Founder safeguard (2026-06-24) — per-account in-flight upload cap. Config
      // always provides a value (512 MB default); pass it through when wired so
      // the route honours an operator-tuned ceiling.
      ...(deps.agentUploadMaxAccountInFlightBytes !== undefined
        ? { uploadMaxAccountInFlightBytes: deps.agentUploadMaxAccountInFlightBytes }
        : {}),
      // Hardening (2026-06-24) — per-account concurrent-relay COUNT cap + concurrent-
      // upload COUNT cap. Both default at the route layer; pass through only when
      // wired (config/tests) so the route honours an override.
      ...(deps.agentRelayMaxAccountInFlight !== undefined
        ? { relayMaxAccountInFlight: deps.agentRelayMaxAccountInFlight }
        : {}),
      ...(deps.agentUploadMaxAccountInFlightCount !== undefined
        ? { uploadMaxAccountInFlightCount: deps.agentUploadMaxAccountInFlightCount }
        : {}),
      // Arc 1 sub-slice 6.3 (v2-#6) — bundled-LLM consent gate. When
      // wired AND customer has consent=true AND BYOK path didn't
      // resolve, route falls through to the deployment fallback key.
      ...(deps.bundledLlmService !== undefined
        ? {
            bundledLlmService: deps.bundledLlmService,
            // Billing-integrity hardening — bound concurrent bundled-LLM
            // turns per account so the soft-cap's read-then-act TOCTOU race
            // can't overspend the cap unboundedly. Use an injected limiter
            // when provided (tests pre-occupy slots), else construct one
            // (pure in-process, no external deps) from the configured
            // ceiling (BUNDLED_TURN_MAX_CONCURRENCY; default 3).
            bundledTurnConcurrency:
              deps.bundledTurnConcurrency ??
              new BundledTurnConcurrencyLimiter(deps.bundledTurnMaxConcurrency ?? undefined),
          }
        : {}),
      // Arc 2 sub-slice 8.3 (v2-#8) — SSE transcript bus. When
      // wired, GET /v1/agent-sessions/:id/transcript registers as
      // an event stream.
      ...(deps.agentSessionEventBus !== undefined
        ? { transcriptEventBus: deps.agentSessionEventBus }
        : {}),
      // Arc 2 sub-slice 8.4 (v2-#8) — gui_control_key auto-mint. The
      // route registers only when an encryption key is wired (shared
      // MFA_ENCRYPTION_KEY per the BYOK / MFA pattern).
      ...(deps.guiControlKeyEncryptionKey !== undefined
        ? { guiControlKeyEncryptionKey: deps.guiControlKeyEncryptionKey }
        : {}),
      // Arc 2 sub-slice 8.8/8.9 (v2-#8) — pair-mode takeover/handback
      // routes register only when the lock is wired (prod gates on env).
      ...(deps.pairModeLock !== undefined ? { pairModeLock: deps.pairModeLock } : {}),
      // Arc 4 Wave 2.B sub-slice 8.17 (v2-#8) — Sentry breadcrumb sink.
      ...(deps.sentry !== undefined ? { sentry: deps.sentry } : {}),
      // Arc 4 Wave 2.B sub-slice 8.20 (v2-#8) — customer audit log.
      ...(deps.accountAuditService !== undefined ? { accountAudit: deps.accountAuditService } : {}),
      // Arc 4 Wave 2.B sub-slice 8.18 (v2-#8) — Prometheus metrics.
      ...(deps.metricsRegistry !== undefined ? { metrics: deps.metricsRegistry } : {}),
      // Arc 4 Wave 2.B sub-slice 8.13d (v2-#8) — pair-mode heartbeat
      // tracker. Routes call recordHeartbeat on takeover / forget on
      // handback so the sweep doesn't auto-handback an active session.
      ...(deps.pairModeHeartbeatTracker !== undefined
        ? { pairModeHeartbeatTracker: deps.pairModeHeartbeatTracker }
        : {}),
      // LK.4 — auto-mint LiveKit token on session-create. Both deps
      // must be present; absent either, the response just omits the
      // `livekit` field and clients fall back to LK.3 explicitly.
      ...(deps.drizzleFleetNodesRepo !== undefined
        ? { fleetNodesRepo: deps.drizzleFleetNodesRepo }
        : {}),
      ...(deps.livekitSecretEncryptionKey !== undefined
        ? { livekitSecretEncryptionKey: deps.livekitSecretEncryptionKey }
        : {}),
      // Fleet-CP session dispatch (local fleet-demo). When the registry +
      // dispatch config are wired (FLEET_CONTROL_PLANE_ENABLED), session-create
      // hands the new session to the connected harness node. No-op otherwise.
      ...(deps.fleetControlRegistry !== undefined
        ? { fleetControlRegistry: deps.fleetControlRegistry }
        : {}),
      ...(deps.sessionDispatch !== undefined ? { sessionDispatch: deps.sessionDispatch } : {}),
      // Profile-backed sessions (file 57): validate an owned profile_id on
      // create + ship its DEK in the dispatch. Wired unconditionally (the
      // validation runs even without the fleet CP).
      ...(deps.profilesService !== undefined ? { profilesService: deps.profilesService } : {}),
      // doc-150 item 6 — account-auth repo for the per-account storage-quota gate
      // on a profile-backed create (resolves the OWNER's tier for team-scoped
      // launches, mirroring /v1/sessions). Same repo /v1/sessions uses.
      authRepo: deps.authRepo,
      // ARC A: validate an owned proxy_id on create + resolve it (owner-scoped
      // unwrap + SSRF re-guard) into the dispatch's inlineProxyConfig.
      ...(deps.accountProxiesService !== undefined
        ? { accountProxiesService: deps.accountProxiesService }
        : {}),
      // Founder directive #63: TEST the proxy LIVE before creating the session +
      // dispatching a worker. When the probe is wired, a proxied create is gated
      // on a real egress round-trip; a failure blocks the launch with a 422 (no
      // dispatch). The flag (ON by default) lets a deployment disable it.
      ...(deps.proxyConnectivityProbe !== undefined
        ? { proxyConnectivityProbe: deps.proxyConnectivityProbe }
        : {}),
      ...(deps.proxyPrelaunchProbeEnabled !== undefined
        ? { proxyPrelaunchProbeEnabled: deps.proxyPrelaunchProbeEnabled }
        : {}),
      // Strict-FK: validate an owned driftstack_session_id on create (closes the
      // latent cross-account pointer gap). The driver SessionRepo is the same
      // one /v1/sessions uses.
      ...(deps.sessionRepo !== undefined ? { driverSessionsRepo: deps.sessionRepo } : {}),
      // Private R2 → profile-backed dispatch ships restore/save-back URLs.
      ...(deps.r2 ? { r2: deps.r2 } : {}),
    });
  } else {
    registerAgentSessionsDisabledRoutes(app);
  }

  // AI-B4 — /v1/recipes route surface. Activation gate requires BOTH
  // recipesRepo (to insert the recipe) AND agentSessionsRepo (to
  // load the source session for the cross-account auth check before
  // snapshotting its transcript). Without either, registers 503 stubs.
  if (deps.recipesRepo !== undefined && deps.agentSessionsRepo !== undefined) {
    registerRecipesRoutes(app, {
      recipes: deps.recipesRepo,
      agentSessions: deps.agentSessionsRepo,
    });
  } else {
    registerRecipesDisabledRoutes(app);
  }

  // V-820 — /v1/fleet/events fleet-node control-plane WebSocket. Activation
  // gate: when fleetNodeAuth + fleetNonceCache + fleetControlRegistry are all
  // wired, the live WS handler registers (verifies the Bearer JWT at upgrade +
  // routes frames through the registry's correlators). When any is omitted,
  // registerFleetEventsDisabledRoutes serves the 503 stub. (Bootstrap wires the
  // deps to take it live in prod — a separate slice; until then the stub runs.)
  if (
    deps.fleetNodeAuth !== undefined &&
    deps.fleetNonceCache !== undefined &&
    deps.fleetControlRegistry !== undefined
  ) {
    await registerFleetEventsRoutes(app, {
      auth: deps.fleetNodeAuth,
      nonceCache: deps.fleetNonceCache,
      registry: deps.fleetControlRegistry,
    });
  } else {
    registerFleetEventsDisabledRoutes(app);
  }

  // Wave 29-400 §8.5 — /v1/internal/atlas-priority/* observability
  // endpoints. Activation gate: BOTH the Drizzle-backed repo
  // (always wired in bootstrap.ts when DB is up) AND the InternalFleet
  // Auth being enabled (DRIFTSTACK_FLEET_INTERNAL_TOKEN env var set).
  // When the token is unset the disabled variant 503s on every path
  // even if the repo is wired — keeps secret-required surfaces dark
  // by default.
  if (
    deps.atlasPriorityEventsRepo !== undefined &&
    deps.internalFleetAuth !== undefined &&
    deps.internalFleetAuth.isEnabled()
  ) {
    registerInternalAtlasPriorityRoutes(app, {
      repo: deps.atlasPriorityEventsRepo,
      auth: deps.internalFleetAuth,
      rateLimitStore: deps.rateLimitStore,
    });
  } else {
    registerInternalAtlasPriorityDisabledRoutes(app);
  }
  // 2026-05-21 — admin-staff read mirror for the atlas-priority queue.
  // Independent of the internal-fleet-auth activation gate (admin auth
  // uses web session + driftstack_internal_admin scope). Gated only on
  // the repo being available — i.e. enabled wherever the underlying
  // Postgres table is wired.
  if (deps.atlasPriorityEventsRepo !== undefined) {
    registerAdminAtlasPriorityRoutes(app, {
      repo: deps.atlasPriorityEventsRepo,
    });
  }
  // LK.2 — Mac-side LiveKit credentials registration. Gated on both
  // the Drizzle repo (in-memory test fixtures skip it; prod wires
  // it via bootstrap.ts) AND the encryption key being present.
  if (deps.drizzleFleetNodesRepo !== undefined && deps.livekitSecretEncryptionKey !== undefined) {
    registerMacNodesRoutes(app, {
      repo: deps.drizzleFleetNodesRepo,
      encryptionKey: deps.livekitSecretEncryptionKey,
      adminAudit: deps.adminAuditService,
      ...(deps.metricsRegistry !== undefined ? { metrics: deps.metricsRegistry } : {}),
      // W628 — when the control plane is wired, GET /v1/mac-nodes reports
      // per-node live-connection state (the dispatch-critical field).
      ...(deps.fleetControlRegistry !== undefined
        ? { controlRegistry: deps.fleetControlRegistry }
        : {}),
    });
  }
  // LK.3 — per-Mac LiveKit JWT mint endpoint. Same gate as LK.2 plus
  // the agent-sessions repo (the route looks up the session before
  // minting a token for it).
  if (
    deps.drizzleFleetNodesRepo !== undefined &&
    deps.livekitSecretEncryptionKey !== undefined &&
    deps.agentSessionsRepo !== undefined
  ) {
    registerAgentSessionsLivekitTokenRoute(app, {
      fleetNodesRepo: deps.drizzleFleetNodesRepo,
      agentSessionsRepo: deps.agentSessionsRepo,
      encryptionKey: deps.livekitSecretEncryptionKey,
      // Reconnect re-mint via the per-session gui_control_key — the Simulator
      // app holds only that key (not the account API key). Wired when present.
      ...(deps.guiControlKeyEncryptionKey !== undefined
        ? { guiControlKeyEncryptionKey: deps.guiControlKeyEncryptionKey }
        : {}),
      ...(deps.metricsRegistry !== undefined ? { metrics: deps.metricsRegistry } : {}),
    });
  }
  // ICE.T — lightweight ICE/media-transport telemetry from the gui-client's
  // live LiveKit connection. Same dual auth as the token route (per-session
  // gui_control_key OR account Bearer), but the account path floors at
  // read:sessions (this is a read-stakes report). No DB — it structured-logs.
  if (deps.agentSessionsRepo !== undefined) {
    registerAgentSessionsTransportReportRoute(app, {
      agentSessionsRepo: deps.agentSessionsRepo,
      // Report via the per-session gui_control_key — the Simulator app holds
      // only that key (not the account API key). Wired when present.
      ...(deps.guiControlKeyEncryptionKey !== undefined
        ? { guiControlKeyEncryptionKey: deps.guiControlKeyEncryptionKey }
        : {}),
    });
  }
  if (
    deps.sessionRepo !== undefined &&
    deps.apiKeysRepo !== undefined &&
    deps.driver !== undefined
  ) {
    registerAdminForceActionRoutes(app, {
      sessionRepo: deps.sessionRepo,
      apiKeysRepo: deps.apiKeysRepo,
      driver: deps.driver,
      audit: deps.adminAuditService,
      authCache: deps.authCache,
    });
  }
  await registerOpenApiRoutes(app);

  // Health endpoint — public, no auth, no rate limit. Liveness only:
  // the process is up and accepting connections. Does not check DB,
  // Redis, or R2 — those checks live on /ready (readiness).
  app.get('/health', () => ({ ok: true }));
  app.get('/healthz', () => ({ ok: true }));

  // V-195 — public version endpoint for ops tooling. Reports server
  // version (from the deploy-owned APP_VERSION or npm in development),
  // git sha (from GIT_SHA env at deploy time, "unknown" otherwise), and
  // process start time.
  // Public + unauthenticated so deploy automation + uptime probes can
  // confirm "what's running where" without needing a key. Lives at
  // /version (not /v1/*) because it has no auth — /v1/* routes are
  // contractually authed per the OpenAPI security check.
  const startedAt = new Date().toISOString();
  const buildVersion = process.env.APP_VERSION ?? process.env.npm_package_version ?? 'unknown';
  const gitSha = process.env.GIT_SHA ?? 'unknown';
  app.get('/version', () => ({
    version: buildVersion,
    git_sha: gitSha,
    started_at: startedAt,
    node_version: process.version,
    // V-337 — surface driver mode so clients can show "this server is
    // running on the playwright dev driver / mock / webkit fork".
    // Useful for the GUI's Connectivity test + admin observability.
    // No customer-impactful info exposed; the driver name is already
    // settable via DRIVER env, so disclosing it is no leak.
    driver: deps.driverName ?? 'mock',
    ...(deps.driverName === 'playwright' && deps.playwrightBrowser !== undefined
      ? { playwright_browser: deps.playwrightBrowser }
      : {}),
    // #139 — AI Browser Automation execution mode. 'live' = decomposed steps run
    // for real on a fleet device (ControlPlaneAgentExecutor); 'simulated' = the
    // StubAgentExecutor (dev/demo). The GUI uses this to drop the stale
    // "actions are simulated" disclaimer — the `driver` field alone is misleading
    // (it's 'mock' in prod even though automation is live via the fleet path).
    agent_execution: deps.agentExecutionLive ? 'live' : 'simulated',
  }));

  // Readiness endpoint — public, no auth, no rate limit. Returns 200
  // only when the dependencies the server needs to serve traffic are
  // reachable. Designed for orchestrator readiness probes (the
  // Hetzner deploy reads this; Cloudflare in front of the host reads
  // /health). Production wires `readinessChecks` for postgres + redis
  // + R2; tests typically pass none and /ready returns 200 with an
  // empty checks array.
  app.get('/ready', async (_request, reply) => {
    const checks = deps.readinessChecks ?? [];
    const results = await Promise.all(
      checks.map(async (c) => {
        const start = Date.now();
        try {
          await runWithTimeout(c.fn(), c.timeoutMs ?? 1500);
          return { name: c.name, ok: true, latency_ms: Date.now() - start };
        } catch (err) {
          // Log the raw error server-side for ops, but do NOT echo it in the
          // public (no-auth) /ready response: a dependency connection error
          // can carry internal host:port / topology (CWE-200 info-disclosure).
          // The check name + ok:false already tell an operator which
          // dependency is down; the detail lives in the server logs.
          const message = err instanceof Error ? err.message : 'unknown';
          reply.log.warn(
            { component: 'readiness', check: c.name, err: message },
            'readiness check failed',
          );
          return { name: c.name, ok: false, latency_ms: Date.now() - start };
        }
      }),
    );
    const allReady = results.every((c) => c.ok);
    return reply.code(allReady ? 200 : 503).send({
      ready: allReady,
      checks: results,
    });
  });

  // Whoami — quick smoke test for auth.
  app.get('/v1/whoami', { preHandler: [app.requireAuth, app.rateLimit('global')] }, (request) => {
    const ctx = request.account;
    if (!ctx) {
      // requireAuth either resolves with a context or throws — this branch
      // is unreachable in practice but keeps the type narrow.
      throw new Error('account context missing after requireAuth');
    }
    return {
      account_id: `acc_${ctx.account.id}`,
      api_key_id: `key_${ctx.apiKey.id}`,
      tier: ctx.account.tier,
      scopes: ctx.apiKey.scopes,
    };
  });

  return app;
}
