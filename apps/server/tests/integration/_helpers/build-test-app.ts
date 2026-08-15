// Builds a Fastify app instance configured for integration tests:
//   - silent logger (no log spam in test output)
//   - in-memory auth repo seeded with one Pro-tier account + one API key
//   - in-memory rate limiter
//   - permissive CORS
//
// Returns the app, plain-text key, and helpers for direct repo manipulation.

import { buildApp, type ReadinessCheck } from '../../../src/lib/app.js';
import { InMemoryOAuthStore } from '../../../src/services/oauth.js';
import type { NowPaymentsApiClient } from '../../../src/lib/nowpayments-api.js';
import type { R2 } from '../../../src/lib/r2.js';
import { createTestLogger } from '../../../src/lib/logger.js';
import { CostMonitoringService } from '../../../src/services/cost-monitoring.js';
import {
  CryptoOrdersService,
  InMemoryCryptoOrdersRepo,
} from '../../../src/services/crypto-orders.js';
import { CryptoTierActivationService } from '../../../src/services/crypto-tier-activation.js';
import type { UsageInputs } from '../../../src/lib/cost-estimator.js';
import { MemoryRateLimitStore } from '../../../src/lib/memory-rate-limit-store.js';
import { generateApiKey, hashApiKey, keyPrefixFromPlaintext } from '../../../src/lib/api-keys.js';
import { MockDriver } from '../../../src/drivers/mock.js';
import { AgentRuntime } from '../../../src/services/agent-runtime.js';
import { DeterministicAgentDecomposer } from '../../../src/services/agent-decomposer-deterministic.js';
import type { DecomposeUsage } from '../../../src/services/agent-decomposer.js';
import { StubAgentExecutor } from '../../../src/services/agent-executor.js';
import { InMemoryAgentSessionsRepo } from '../../../src/services/agent-sessions.js';
import { InMemoryAgentTurnReceiptsRepo } from '../../../src/services/agent-turn-receipts.js';
import { BundledLlmService, InMemoryBundledLlmRepo } from '../../../src/services/bundled-llm.js';
import { BundledTurnConcurrencyLimiter } from '../../../src/services/bundled-turn-concurrency.js';
import {
  BYOKAnthropicService,
  InMemoryBYOKAnthropicRepo,
} from '../../../src/services/byok-anthropic.js';
import { InMemoryByokKeyCache } from '../../../src/services/byok-anthropic-key-cache.js';
import { AgentSessionEventBus } from '../../../src/services/agent-session-event-bus.js';
import { InMemoryPairModeTakeoverLock } from '../../../src/services/agent-pair-mode-lock.js';
import { InMemoryPairModeHeartbeatTracker } from '../../../src/services/agent-pair-mode-heartbeat.js';
import { InMemoryRecipesRepo } from '../../../src/services/recipes.js';
import {
  FleetNodeAuthImpl,
  InMemoryFleetNodesRepo,
} from '../../../src/services/fleet-node-auth.js';
import { InMemoryFleetNonceCache } from '../../../src/services/fleet-nonce-cache.js';
import { FleetControlRegistry } from '../../../src/services/fleet-control-registry.js';
import { MetricsRegistry, METRIC_NAMES } from '../../../src/services/metrics-registry.js';
import { SessionsService } from '../../../src/services/sessions.js';
import { ApiKeysService } from '../../../src/services/api-keys.js';
import { UsageService } from '../../../src/services/usage.js';
import { WebhooksService, WebhooksAdminService } from '../../../src/services/webhooks.js';
import { AdminAuditService } from '../../../src/services/admin-audit.js';
import { AccountsAdminService } from '../../../src/services/admin-accounts.js';
import { AdminBillingService } from '../../../src/services/admin-billing.js';
import { PricingService } from '../../../src/services/pricing.js';
import { PlatformSecretsService } from '../../../src/services/platform-secrets.js';
import { InMemoryPricingRepo } from './in-memory-pricing-repo.js';
import { InMemoryPlatformSecretsRepo } from './in-memory-platform-secrets-repo.js';
import { IncidentsService, type IncidentRow } from '../../../src/services/incidents.js';
import { InMemoryIncidentsRepo } from './in-memory-incidents-repo.js';
import { InMemoryIncidentUpdateNotificationsRepo } from './in-memory-incident-update-notifications-repo.js';
import { InMemoryStatusSubscribersRepo } from './in-memory-status-subscribers-repo.js';
import { StatusSubscribersService } from '../../../src/services/status-subscribers.js';
import { IncidentNotificationsService } from '../../../src/services/incident-notifications.js';
import { IncidentBroadcastService } from '../../../src/services/incident-broadcast.js';
import { IncidentEventBus } from '../../../src/services/incident-event-bus.js';
import { NotificationEventBus } from '../../../src/services/notification-event-bus.js';
import { SlaReportingService } from '../../../src/services/sla-reporting.js';
import { InMemoryProbesRepo } from './in-memory-probes-repo.js';
import { TeamMembersService } from '../../../src/services/team-members.js';
import { InMemoryTeamMembersRepo } from './in-memory-team-members-repo.js';
import type { EmailService } from '../../../src/services/email.js';
import { RateLimitOverridesService } from '../../../src/services/rate-limit-overrides.js';
import { LegalService } from '../../../src/services/legal.js';
import { buildLegalCatalogFromContent } from '../../../src/services/legal-catalog.js';
import { EmailPreferencesService } from '../../../src/services/email-preferences.js';
import { InMemoryEmailPreferencesRepo } from './in-memory-email-preferences-repo.js';
import { OAuthClientServiceImpl } from '../../../src/services/oauth-client-service.js';
import {
  InMemoryOAuthLinksRepo,
  InMemoryOAuthPendingLinksRepo,
} from './in-memory-oauth-links-repo.js';
import { AccountAuditService } from '../../../src/services/account-audit.js';
import { InMemoryAccountAuditRepo } from './in-memory-account-audit-repo.js';
import { AccountLifecycleService } from '../../../src/services/account-lifecycle.js';
import { InMemoryAccountLifecycleRepo } from './in-memory-account-lifecycle-repo.js';
import { ScheduledJobsService } from '../../../src/services/scheduled-jobs.js';
import { InMemoryScheduledJobsRepo } from './in-memory-scheduled-jobs-repo.js';
import {
  ValidationHarnessService,
  type ValidationHarnessRecaptureBridge,
} from '../../../src/services/validation-harness.js';
import { InMemoryValidationSchedulesRepo } from './in-memory-validation-schedules-repo.js';
import { randomUUID as testRandomUUID } from 'node:crypto';
import { InMemoryAuthCache } from '../../../src/services/auth-cache.js';
import { AuthCoalescer } from '../../../src/services/auth-coalescer.js';
import { InMemoryAuthRepo } from './in-memory-auth-repo.js';
import { InMemorySessionsRepo } from './in-memory-sessions-repo.js';
import { InMemoryApiKeysRepo } from './in-memory-api-keys-repo.js';
import { InMemoryUsageRepo } from './in-memory-usage-repo.js';
import { InMemoryWebhooksRepo } from './in-memory-webhooks-repo.js';
import { InMemoryAdminAuditLogRepo } from './in-memory-admin-audit-repo.js';
import { InMemoryAccountsAdminRepo } from './in-memory-admin-accounts-repo.js';
import { InMemoryAdminBillingRepo } from './in-memory-admin-billing-repo.js';
import { InMemoryRateLimitOverridesRepo } from './in-memory-rate-limit-overrides-repo.js';
import { InMemoryLegalRepo } from './in-memory-legal-repo.js';
import { InMemoryAuthFlowsRepo } from './in-memory-auth-flows-repo.js';
import { InMemoryMfaRepo } from './in-memory-mfa-repo.js';
import { MfaService } from '../../../src/services/mfa.js';
import { InMemoryMfaChallengeStore } from '../../../src/services/mfa-challenge-store.js';
import { InMemoryStripeWebhooksRepo } from './in-memory-stripe-webhooks-repo.js';
import { InMemoryProfilesRepo } from './in-memory-profiles-repo.js';
import { InMemoryAccountProxiesRepo } from '../../../src/db/account-proxies-repo.js';
import { AccountProxiesService } from '../../../src/services/account-proxies.js';
import type { ProxyConnectivityProbe } from '../../../src/services/proxy-connectivity-probe.js';
import { InMemoryProfileSnapshotsRepo } from './in-memory-profile-snapshots-repo.js';
import { InMemoryBillingProvider, InMemoryBillingRepo } from './in-memory-billing.js';
import { BillingService } from '../../../src/services/billing.js';
import { AuthFlowsService } from '../../../src/services/auth-flows.js';
import {
  CliAuthorizeService,
  InMemoryCliAuthorizeStore,
} from '../../../src/services/cli-authorize.js';
import { StripeWebhooksService } from '../../../src/services/stripe-webhooks.js';
import { ProfilesService } from '../../../src/services/profiles.js';
import { ProfileSnapshotsService } from '../../../src/services/profile-snapshots.js';
import { createEmailService } from '../../../src/services/email.js';
import type { AccountTier, ApiKeyScope } from '@driftstack/api-types';

interface EmailSendRecord {
  template: string;
  to: string;
  vars: Record<string, unknown>;
}

function createRecordingEmailService(realService: EmailService): {
  service: EmailService;
  sends: EmailSendRecord[];
} {
  const sends: EmailSendRecord[] = [];
  const record = (template: string, args: { to: string } & Record<string, unknown>): void => {
    const { to, ...vars } = args;
    sends.push({ template, to, vars });
  };

  const service: EmailService = {
    isConfigured: realService.isConfigured,
    sendSignupVerification: async (args) => {
      record('signup-verification', args);
      await realService.sendSignupVerification(args);
    },
    sendPasswordReset: async (args) => {
      record('password-reset', args);
      await realService.sendPasswordReset(args);
    },
    sendBillingReceipt: async (args) => {
      record('billing-receipt', args);
      await realService.sendBillingReceipt(args);
    },
    sendBillingFailure: async (args) => {
      record('billing-failure', args);
      await realService.sendBillingFailure(args);
    },
    sendBillingRenewalReminder: async (args) => {
      record('billing-renewal-reminder', args);
      await realService.sendBillingRenewalReminder(args);
    },
    sendSignupWelcome: async (args) => {
      record('signup-welcome', args);
      await realService.sendSignupWelcome(args);
    },
    sendSessionFailedFirst: async (args) => {
      record('session-failed-first', args);
      await realService.sendSessionFailedFirst(args);
    },
    sendSessionSuccessFirst: async (args) => {
      record('session-success-first', args);
      await realService.sendSessionSuccessFirst(args);
    },
    sendTierChanged: async (args) => {
      record('tier-changed', args);
      await realService.sendTierChanged(args);
    },
    sendStatusSubscriptionConfirmation: async (args) => {
      record('status-subscription-confirmation', args);
      await realService.sendStatusSubscriptionConfirmation(args);
    },
    sendStatusSubscriptionWelcome: async (args) => {
      record('status-subscription-welcome', args);
      await realService.sendStatusSubscriptionWelcome(args);
    },
    sendStatusIncidentNotification: async (args) => {
      record(
        args.kind === 'created'
          ? 'status-incident-created'
          : args.kind === 'updated'
            ? 'status-incident-updated'
            : 'status-incident-resolved',
        args,
      );
      await realService.sendStatusIncidentNotification(args);
    },
    sendTeamInvite: async (args) => {
      record('team-invite', args);
      await realService.sendTeamInvite(args);
    },
    sendOauthPendingLinkVerification: async (args) => {
      record('oauth-pending-verification', args);
      await realService.sendOauthPendingLinkVerification(args);
    },
    sendWebhookSecretRotationReminder: async (args) => {
      record('webhook-secret-rotation-reminder', args);
      await realService.sendWebhookSecretRotationReminder(args);
    },
    sendWebhookSecretForceRotated: async (args) => {
      record('webhook-secret-force-rotated', args);
      await realService.sendWebhookSecretForceRotated(args);
    },
    sendWebhookSecretGraceExpiring: async (args) => {
      record('webhook-secret-grace-expiring', args);
      await realService.sendWebhookSecretGraceExpiring(args);
    },
    sendByokAnthropicKeyRotationReminder: async (args) => {
      record('byok-anthropic-key-rotation-reminder', args);
      await realService.sendByokAnthropicKeyRotationReminder(args);
    },
  };
  return { service, sends };
}

export interface TestAppOptions {
  /**
   * Readiness probes for `/ready`. Omitted ⇒ none, which is why the route
   * returns 200 with an empty checks array in almost every fixture — and why
   * its 503 path had no coverage at all until this seam existed.
   */
  readinessChecks?: ReadinessCheck[];
  tier?: AccountTier;
  /**
   * Tier given to accounts created by `POST /v1/auth/signup`, i.e. the
   * web-session identities — NOT the seeded API-key account above, which is
   * `tier`. Unset ⇒ `free`, matching production and every existing fixture.
   *
   * These are separate knobs because they are separate accounts, and the split
   * hides a whole class of route from coverage: a signup account is free-tier,
   * free-tier has `apiAccess: false`, so any route holding BOTH a web-session
   * requirement and a `requireTierFeature(tier, 'apiAccess')` gate could only
   * ever be reached at its tier refusal. `POST /v1/oauth/authorize/complete` is
   * exactly that shape, and consent is the entry point to the whole OAuth
   * provider surface — so everything downstream of a real authorization code
   * was unreachable too.
   */
  signupTier?: AccountTier;
  /**
   * Build as a deployment with `PROFILE_MASTER_KEY` absent. Unset ⇒ the fixed
   * test key, which is what every other fixture wants.
   *
   * bootstrap.ts logs that with the key unset "encrypted account proxies are
   * unreadable and credentialed writes fail closed". That promise is kept by two
   * refusals in `account-me.ts` — one for a proxy password, one for a VPN secret
   * — and neither had ever executed, because no fixture could produce the
   * configuration they exist for. A deployment that lost the key must refuse the
   * write; the alternative is a proxy password or a WireGuard private key
   * written to the database in the clear.
   */
  profileMasterKeyUnset?: boolean;
  /** Email admitted by the requireOwner gate. Unset → the gate stays
   *  fail-closed, which is the default posture for every other suite. */
  ownerEmail?: string;
  scopes?: ApiKeyScope[];
  accountStatus?: 'active' | 'suspended' | 'deleted';
  keyRevoked?: boolean;
  keyExpired?: boolean;
  /**
   * Provenance of the seeded key. Default `null` = an ordinary customer
   * API key. `'cli_device'` seeds the desktop device credential, which is
   * the ONLY credential that reaches the API on a `free` account: ordinary
   * keys are refused by the Free customer-API boundary before any route
   * gate runs, so a free-tier route test must opt into this.
   */
  keyProvenance?: 'cli_device';
  /**
   * Register the OAuth provider surface, including the staff-only
   * `/v1/admin/oauth/clients*` routes. `buildApp` gates that whole surface on
   * `deps.oauthStore`, so without this the routes 404 in tests and their
   * `driftstack_internal_admin` gates cannot be exercised at all — which is
   * precisely why they had no refusal coverage.
   */
  withOauthStore?: boolean;
  /**
   * Optional override for the seeded account id. Default is the
   * historical hardcoded value. Tests that need two distinct accounts
   * pass this to keep the second fixture from clobbering the first.
   */
  accountId?: string;
  /** Optional override for the seeded api-key id. */
  apiKeyId?: string;
  /**
   * If `true`, the fixture skips pre-seeding legal acceptances. Used by
   * tests that exercise the legal-acceptance gate (e.g. confirming
   * `POST /v1/api-keys` is blocked when documents are pending). Default
   * `false` — most tests are unrelated to the gate and need it open.
   */
  skipLegalAcceptance?: boolean;
  /** Optional override for the seeded email (must be unique per fixture). */
  email?: string;
  /** V-295d — set to a non-null URL to enable Slack outbound broadcasts in this fixture. */
  broadcastSlackUrl?: string | null;
  /** V-295d — set to a non-null URL to enable generic outbound broadcasts in this fixture. */
  broadcastGenericUrl?: string | null;
  /**
   * V-531.B — pass through to AppDeps.livekit so /v1/sessions/:id/
   * livekit-token registers. When omitted, the route stays
   * unregistered (404) — matches the prod-config-absent posture.
   */
  livekit?: { apiKey: string; apiSecret: string; wsUrl: string };
  /**
   * V-666 / V-487 — pass through to AppDeps.nowpaymentsIpnSecret so
   * /v1/webhooks/nowpayments registers. When omitted, the route stays
   * unregistered (404) — matches the prod-merchant-account-absent
   * posture.
   */
  nowpaymentsIpnSecret?: string;
  /**
   * Pass a (mock) NowPayments API client so the crypto-checkout route
   * mints real payment context instead of the stub posture. Wired with
   * a fixed test IPN-callback URL so the route's `nowpayments !==
   * undefined && ipnCallbackUrl !== undefined` gate is satisfied. Lets
   * tests exercise the V-666.SEC below-floor short-circuit + the
   * NowPayments happy path. Omitted → checkout stays stub.
   */
  nowpaymentsClient?: NowPaymentsApiClient;
  /**
   * V-667.C — pass through to AppDeps.{oauthClient,oauthClientService}
   * so /v1/auth/oauth-client/* registers. When omitted, the routes
   * stay unregistered (404) — matches the prod-OAUTH_CLIENT_*-absent
   * posture. Tests opt in with the minimal shape needed to register
   * (signing secret + callback + ≥1 provider).
   */
  oauthClient?: {
    signingSecret: string;
    callbackUrlBase: string;
    dashboardOrigin: string;
    google?: { clientId: string; clientSecret: string };
    github?: { clientId: string; clientSecret: string };
    /**
     * Injectable HTTP client for the two IDP calls. `vi.stubGlobal('fetch')`
     * cannot reach them — `lib/oauth-client-exchange.ts` captures
     * `globalThis.fetch` at module load, so the capture never sees a later
     * stub. Without this the callback's IDP legs were untestable and every
     * arm reaching them made a REAL request to the provider.
     */
    fetch?: typeof fetch;
  };
  /**
   * Wave 1119 / Slice 1119.2 — when `true`, omits `billingService` from
   * the AppDeps so `registerBillingDisabledRoutes` runs in place of
   * `registerBillingRoutes`. Matches the prod posture before
   * STRIPE_SECRET_KEY + DRIFTSTACK_TIER_PRICE_IDS land in
   * `/opt/driftstack/api/.env`.
   * Default `false`.
   */
  disableBilling?: boolean;
  /**
   * EG-API-1.4 — when `true`, injects a no-op `sessionEgressService`
   * stub so `egressProxyRequired` flips on in the session-routes wiring
   * (planning 133 §"Egress safeguard enforcement" defense-in-depth
   * layer 1). The stub never actually applies/releases anything;
   * tests exercising the safeguard don't need a real backend.
   * Default `false`.
   */
  enableEgressSafeguard?: boolean;
  /**
   * W615 — explicit SESSION_PROXY_REQUIRED override passthrough.
   * undefined → inferred from enableEgressSafeguard (the default
   * posture); false → never required (self-hosted/testing); true →
   * required even without a wired backend.
   */
  sessionProxyRequired?: boolean;
  /**
   * AI-D — when `true`, wires a deterministic AgentRuntime
   * (DeterministicAgentDecomposer + StubAgentExecutor +
   * InMemoryAgentSessionsRepo) so /v1/agent-sessions/* routes
   * register concretely. Default `false` = activation-gate-off
   * (matches prod posture until founder flips the LLM key path on).
   */
  enableAgentRuntime?: boolean;
  /**
   * What the ROUTE believes the deployment's decomposer is. `buildApp` defaults
   * this to `'deterministic'`, and the route uses it to decide whether a missing
   * Anthropic key is a real problem: on a deterministic deployment the
   * decomposer never reads a key, so gating would raise a false alarm for a turn
   * that would have succeeded.
   *
   * Setting `'claude'` does NOT change the decomposer instance the runtime uses
   * — it stays deterministic. That is faithful rather than sloppy: the branches
   * this flag opens all REFUSE before any decomposer call, so the instance
   * behind it is never consulted on those paths. Without this option the
   * `'claude'` legs of the key-resolution chain are unreachable from every
   * integration fixture, which is how the bundled-LLM tier-ineligible refusal
   * went unexecuted (assessment item 5f).
   */
  agentDecomposerKind?: 'claude' | 'deterministic';
  /** Test the fail-closed deployment posture when turn-receipt storage is absent. */
  disableAgentTurnReceipts?: boolean;
  /**
   * Founder directive #63 — inject a CP-side live proxy connectivity probe so the
   * pre-launch gate runs in tests. Omitted → no probe wired → the gate is a no-op
   * (matches today's behaviour; the existing proxy_id → 201 tests stay green).
   * The gate tests pass a stub whose `.probe()` returns pass/fail/timeout.
   */
  proxyConnectivityProbe?: ProxyConnectivityProbe;
  /** Override the legacy saved-proxy TCP test probe. Omitted keeps the
   * deterministic TEST-NET fixture behavior. */
  proxyTcpProbe?: (host: string, port: number, timeoutMs: number) => Promise<void>;
  /**
   * Founder directive #63 — override the pre-launch probe on/off flag in tests
   * (default true in the route, ON in prod). Lets a test assert the disable path.
   */
  proxyPrelaunchProbeEnabled?: boolean;
  /**
   * v2-#18 — when `true` AND `enableAgentRuntime` is also `true`,
   * AgentRuntime is wired with a capturing usage recorder that
   * appends each `.record()` call into the fixture's
   * `agentDecomposerUsageRecords` array. Lets the end-to-end smoke
   * test assert the decomposer → runtime → recorder chain fires
   * through the HTTP layer without needing the Drizzle path.
   */
  captureAgentDecomposerUsage?: boolean;
  /**
   * Arc 1 sub-slice 6.5 (v2-#6) — when set, the test fixture wires a
   * BundledLlmService backed by InMemoryBundledLlmRepo. The repo
   * starts populated with this account's consent + cap settings; the
   * fixture also wires deps.deploymentFallbackKey to a stub literal
   * so the route's bundled-LLM leg can resolve. Pre-existing spend
   * can be seeded via `fx.bundledLlmRepo.addSpend(...)`.
   */
  enableBundledLlm?: {
    consent: boolean;
    monthlyCapUsdCents: number;
  };
  /**
   * Billing-integrity hardening — override the per-account CONCURRENT
   * bundled-LLM-turn ceiling so a test can trip the limiter at 1-2
   * concurrent turns. Omitted → the route's default of 3.
   */
  bundledTurnMaxConcurrency?: number;
  /**
   * Wires the active BYOKAnthropicService (backed by
   * InMemoryBYOKAnthropicRepo) so the GET/PUT/DELETE byok-anthropic
   * routes register their real handlers instead of the 503
   * activation-gate stubs. Exposes `fx.byokAnthropicRepo` for direct
   * assertions. The /test connection-check leg still calls Anthropic,
   * so this opt covers the storage routes (set/clear/metadata), not
   * the live-key /test endpoint.
   */
  enableByokAnthropic?: boolean;
  /**
   * V-820 — when `true`, wires the fleet control-plane deps
   * (FleetNodeAuthImpl over an InMemoryFleetNodesRepo + an
   * InMemoryFleetNonceCache + a FleetControlRegistry) so the live
   * `/v1/fleet/events` WebSocket handler registers instead of the 503
   * disabled stub. Exposes `fx.fleetNodesRepo` (register a node's
   * Ed25519 pubkey so a signed JWT verifies) + `fx.fleetControlRegistry`
   * (inspect live connections / drive a dispatch). Default `false`.
   */
  enableFleetControlPlane?: boolean;
  /**
   * V-278.C — exercise the STRICT CORS posture (permissiveCors=false). Supply
   * the canonical `dashboardOrigin` (auto-allowed) and/or an explicit
   * `allowedOrigins` list (CORS_ALLOWED_ORIGINS). Omitted → permissive (default).
   */
  corsStrict?: { dashboardOrigin?: string; allowedOrigins?: string[] };
  /**
   * Founder safeguard (2026-06-24) — override the per-account CONCURRENT
   * in-flight upload cap (bytes) for POST /v1/agent-sessions/:id/files. Lets a
   * test trip the cap with tiny payloads instead of holding ~512 MB of buffers.
   * Omitted → the route's 512 MB default. Threaded into AppDeps as
   * `agentUploadMaxAccountInFlightBytes`.
   */
  uploadMaxAccountInFlightBytes?: number;
  /**
   * Hardening (2026-06-24, LOW defense-in-depth) — override the per-account
   * CONCURRENT-RELAY COUNT cap for the cookies/set, history, downloads-list +
   * downloads-content routes. Lets a test trip the cap at 1–2 concurrent relays.
   * Omitted → the route's default of 16. Threaded into AppDeps as
   * `agentRelayMaxAccountInFlight`.
   */
  relayMaxAccountInFlight?: number;
  /**
   * Hardening (2026-06-24, LOW defense-in-depth) — override the per-account
   * CONCURRENT-UPLOAD COUNT cap for POST /:id/files. Lets a test trip the count
   * cap at 1–2 concurrent uploads. Omitted → the route's default of 4. Threaded
   * into AppDeps as `agentUploadMaxAccountInFlightCount`.
   */
  uploadMaxAccountInFlightCount?: number;
  /**
   * DoS hardening — opt INTO the app-wide global IP rate limit (default is
   * disabled in tests, see the buildApp call). A dedicated suite passes a
   * tiny capacity to trip the gate with a handful of requests from one IP.
   */
  globalIpRateLimit?: { capacity: number; refillPerSecond: number } | null;
  /**
   * Override the protected Prometheus scrape token. `null` models the
   * fail-closed production posture when METRICS_SCRAPE_TOKEN is absent;
   * omitted retains the fixture's historical test token.
   */
  metricsScrapeToken?: string | null;
  /**
   * Fastify's trusted-proxy boundary. Securely defaults to false just like
   * buildApp; route-level tests that intentionally exercise an authoritative
   * forwarded client IP must opt into the production-shaped hop count.
   */
  trustProxy?: boolean | number | string;
}

export interface SeedAdditionalOpts {
  accountId?: string;
  apiKeyId?: string;
  tier?: AccountTier;
  scopes?: ApiKeyScope[];
  accountStatus?: 'active' | 'suspended' | 'deleted';
  email?: string;
  name?: string;
}

export interface AdditionalAccount {
  accountId: string;
  apiKeyId: string;
  plaintext: string;
}

export interface TestAppFixture {
  app: Awaited<ReturnType<typeof buildApp>>;
  /** V-730 — the live per-session BYOK plaintext cache, so a test can prove
   *  that clearing or rotating the stored key evicts what open agent sessions
   *  are still holding. */
  byokKeyCache: InMemoryByokKeyCache;
  authRepo: InMemoryAuthRepo;
  authCache: InMemoryAuthCache;
  authCoalescer: AuthCoalescer;
  sessionsRepo: InMemorySessionsRepo;
  apiKeysRepo: InMemoryApiKeysRepo;
  usageRepo: InMemoryUsageRepo;
  webhooksRepo: InMemoryWebhooksRepo;
  /** V-307 — exposed so tests can enqueue deliveries directly without
   *  a real session-completion event. */
  webhooksService: WebhooksService;
  adminAuditRepo: InMemoryAdminAuditLogRepo;
  /** V-281 — exposed so tests can assert customer-audit rows post admin action. */
  accountAuditRepo: InMemoryAccountAuditRepo;
  /** Arc 4 Wave 2.B 8.18/8.19 — exposed so tests can scrape /metrics
   *  + read counter values directly via registry.getValue(). */
  metricsRegistry: MetricsRegistry;
  /** Arc 4 Wave 2.B sub-slice 8.13d — exposed so tests can assert
   *  the takeover route called recordHeartbeat and the handback
   *  route called forget. */
  pairModeHeartbeatTracker: InMemoryPairModeHeartbeatTracker;
  /** gui_control_key control-auth tests — the in-memory agent-sessions
   *  repo, present only when `enableAgentRuntime` is set (undefined
   *  otherwise). Lets a test set/expire a session's gui_control_key
   *  directly via `setGuiControlKey(...)`. */
  agentSessionsRepo?: InMemoryAgentSessionsRepo;
  /** Durable message-turn receipt double wired with the agent runtime. */
  agentTurnReceiptsRepo?: InMemoryAgentTurnReceiptsRepo;
  /** V-295a — exposed so tests can assert incident state. */
  incidentsRepo: InMemoryIncidentsRepo;
  /** V-295c3 — exposed so tests can assert subscriber state. */
  statusSubscribersRepo: InMemoryStatusSubscribersRepo;
  /** V-295c3-tombstone — exposed for direct purge invocation in tests. */
  statusSubscribersService: StatusSubscribersService;
  /** V-295d — recorded outbound broadcast HTTP calls (URL + parsed JSON body). */
  broadcastFetchCalls: ReadonlyArray<{ url: string; body: unknown }>;
  /**
   * v2-#18 — recorded AgentDecomposerUsageRecorder.record() calls.
   * Populated only when the fixture is built with both
   * `enableAgentRuntime: true` AND `captureAgentDecomposerUsage: true`.
   * Otherwise stays empty.
   */
  agentDecomposerUsageRecords: ReadonlyArray<{
    accountId: string;
    driftstackSessionId: string | null;
    agentSessionId: string;
    decomposeResultKind: 'plan' | 'clarify' | 'refuse';
    usage: DecomposeUsage;
    tokensConsumed: number;
    now: Date;
    keySource?: 'header' | 'cached' | 'bundled' | 'fallback' | 'none';
  }>;
  /**
   * Arc 1 sub-slice 6.5 (v2-#6) — exposed when `enableBundledLlm` is
   * set so tests can `addSpend(accountId, when, cents)` to simulate
   * prior bundled-LLM cost rows before issuing a chat turn.
   */
  bundledLlmRepo: InMemoryBundledLlmRepo;
  /** Billing-integrity hardening — the bundled-turn concurrency limiter
   *  wired into the app. Tests pre-occupy slots (tryAcquire) to assert the
   *  /message route 429s when an account is at its bundled-turn ceiling. */
  bundledTurnConcurrency: BundledTurnConcurrencyLimiter;
  /** Exposed when `enableByokAnthropic` is set so tests can assert
   *  stored-key state directly (findByAccount) after route calls. */
  byokAnthropicRepo: InMemoryBYOKAnthropicRepo;
  /** V-295e — exposed for direct event-bus subscription in tests. */
  incidentEventBus: IncidentEventBus;
  /** S45 — customer SSE notification bus; tests subscribe directly to
   *  assert incident.broadcast fan-out on public-incident lifecycle. */
  notificationEventBus: NotificationEventBus;
  /** V-295e — exposed so tests can seed probe history before calling SLA. */
  probesRepo: InMemoryProbesRepo;
  /** V-298c — exposed so tests can seed account-email mappings (for accept flow). */
  teamMembersRepo: InMemoryTeamMembersRepo;
  /** V-298c — exposed for direct service tests beyond the route layer. */
  teamMembersService: TeamMembersService;
  /** V-326e6 — exposed so tests can seed legal acceptances for an
   *  OWNER account when exercising team-RBAC api-key writes. */
  legalRepo: InMemoryLegalRepo;
  legalCatalog: ReturnType<typeof buildLegalCatalogFromContent>;
  /** V-295c3 — recording email service: tests can read .sends to assert
   *  exactly which template fired with what variables. */
  emailSends: ReadonlyArray<EmailSendRecord>;
  rateLimitOverridesRepo: InMemoryRateLimitOverridesRepo;
  rateLimitStore: MemoryRateLimitStore;
  authFlowsRepo: InMemoryAuthFlowsRepo;
  /** V-667.C — exposed so tests can seed links directly + read back to
   *  assert state after route mutations. */
  oauthLinksRepo: InMemoryOAuthLinksRepo;
  stripeWebhooksRepo: InMemoryStripeWebhooksRepo;
  /** Stripe webhook signing secret used by the test fixture. */
  stripeWebhookSigningSecret: string;
  profilesRepo: InMemoryProfilesRepo;
  billingRepo: InMemoryBillingRepo;
  billingProvider: InMemoryBillingProvider;
  /** V-202c — lifecycle dedup state (first_failure_email_sent_at, etc.). */
  accountLifecycleRepo: InMemoryAccountLifecycleRepo;
  /** V-202d — scheduled jobs ledger; tests can inspect or trigger processTick. */
  scheduledJobsRepo: InMemoryScheduledJobsRepo;
  /** V-202d — service handle so tests can call processTick(now) deterministically. */
  scheduledJobsService: ScheduledJobsService;
  driver: MockDriver;
  /**
   * V-541.D — populate to drive the in-memory cost aggregator from
   * an integration test. Keyed on accountId; value is the usage
   * snapshot the aggregator returns for any billing-cycle query.
   */
  costUsageByAccount: Map<string, UsageInputs>;
  /** V-666.C — handle to the crypto-orders service powering POST /v1/billing/crypto-checkout. */
  cryptoOrdersService: CryptoOrdersService;
  /** V-666.C — in-memory repo so tests can read back orders by id. */
  cryptoOrdersRepo: InMemoryCryptoOrdersRepo;
  /** V-218 — in-memory validation-schedules repo backing the admin
   *  validation-harness routes; exposed so tests can vi.spyOn() it to
   *  force a mutation failure (D-025 audit-failure-branch coverage). */
  validationSchedulesRepo: InMemoryValidationSchedulesRepo;
  /** V-218 — the (mock) recapture bridge the validation-harness service
   *  dispatches to; exposed so tests can vi.spyOn(triggerRecapture) to
   *  force a POST .../trigger failure (D-025 audit-failure-branch
   *  coverage) without a real recapture backend. */
  recaptureBridge: ValidationHarnessRecaptureBridge;
  /** Pricing-as-data Phase A — exposed so tests can setPrice() and assert
   *  the owner-edited price flows through the quote + charge reads. */
  pricingService: PricingService;
  platformSecretsService: PlatformSecretsService;
  /** V-820 — fleet-node registry (register a node's Ed25519 pubkey so a
   *  signed JWT verifies). Always present; only consulted by the live
   *  route when `enableFleetControlPlane` wired it into AppDeps. */
  fleetNodesRepo: InMemoryFleetNodesRepo;
  /** V-820 — live fleet-node connection registry; inspect size() or
   *  drive `get(nodeId)?.correlator.dispatch(...)` in tests. */
  fleetControlRegistry: FleetControlRegistry;
  /** Plaintext API key — pass as `Authorization: Bearer <plaintext>`. */
  plaintext: string;
  accountId: string;
  apiKeyId: string;
  /** V-352b — in-memory bucket + putCalls inspector for avatar tests. */
  r2PublicStore: R2FakeStore;
  cleanup: () => Promise<void>;
}

/**
 * V-352b — in-memory R2 fake for avatar upload tests. Stores objects
 * by key in a Map; presigned GETs return a synthetic
 * `https://r2-fake.test/<bucket>/<key>?sig=...` URL so tests can
 * inspect what would have been served. Mirrors the real R2 interface
 * surface used by the route layer (putObject, presignGet, headObject).
 */
export interface R2FakeStore {
  /** All objects currently in the fake bucket, keyed by R2 key. */
  readonly objects: Map<string, { body: Buffer; contentType?: string }>;
  /** putObject calls in order — useful for asserting upload count. */
  readonly putCalls: Array<{ key: string; size: number; contentType?: string }>;
}

function makeR2Fake(): { r2: R2; store: R2FakeStore } {
  const objects = new Map<string, { body: Buffer; contentType?: string }>();
  const putCalls: R2FakeStore['putCalls'] = [];
  const bucket = 'driftstack-test-public';
  const r2: R2 = {
    bucket,
    headObject(key) {
      return Promise.resolve({ exists: objects.has(key) });
    },
    putObject({ key, body, contentType }) {
      const buf = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
      objects.set(key, { body: buf, contentType });
      putCalls.push({ key, size: buf.length, contentType });
      return Promise.resolve();
    },
    deleteObject(key) {
      // Idempotent like S3/R2 — a missing key is a no-op.
      objects.delete(key);
      return Promise.resolve();
    },
    presignPut({ key }) {
      return Promise.resolve(`https://r2-fake.test/${bucket}/${key}?put=1`);
    },
    presignGet({ key, expiresIn }) {
      const ttl = expiresIn ?? 900;
      return Promise.resolve(`https://r2-fake.test/${bucket}/${key}?ttl=${ttl}`);
    },
    listObjects(prefix) {
      // The fake store doesn't track lastModified; report null so the
      // orphan-reaper never treats a fake object as reap-eligible (null =
      // always-skip, its safest default). Dedicated reaper tests inject their
      // own R2 fake with real timestamps.
      const out: Array<{ key: string; lastModified: Date | null }> = [];
      for (const key of objects.keys()) {
        if (key.startsWith(prefix)) out.push({ key, lastModified: null });
      }
      return Promise.resolve(out);
    },
  };
  return { r2, store: { objects, putCalls } };
}

export async function buildTestApp(opts: TestAppOptions = {}): Promise<TestAppFixture> {
  const authRepo = new InMemoryAuthRepo();
  const rateLimitStore = new MemoryRateLimitStore();
  const r2PublicFakeBundle = makeR2Fake();
  const r2PublicFake = r2PublicFakeBundle.r2;
  const r2PublicStore = r2PublicFakeBundle.store;

  const accountId = opts.accountId ?? '00000000-0000-4000-8000-000000000001';
  const apiKeyId = opts.apiKeyId ?? '00000000-0000-4000-8000-000000000a01';

  authRepo.upsertAccount({
    id: accountId,
    email: opts.email ?? 'tester@driftstack.local',
    name: 'Tester',
    tier: opts.tier ?? 'api_builder',
    status: opts.accountStatus ?? 'active',
    timezone: null,
    avatarR2Key: null,
    slug: null,
    region: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  });

  const plaintext = generateApiKey('test');
  const keyHash = await hashApiKey(plaintext);
  const keyPrefix = keyPrefixFromPlaintext(plaintext);

  authRepo.upsertApiKey({
    id: apiKeyId,
    accountId,
    name: 'test-key',
    keyPrefix,
    keyHash,
    scopes: opts.scopes ?? ['read', 'write', 'account_owner', 'driftstack_internal_admin'],
    lastUsedAt: null,
    revokedAt: opts.keyRevoked === true ? new Date('2026-01-15T00:00:00Z') : null,
    expiresAt: opts.keyExpired === true ? new Date('2026-01-15T00:00:00Z') : null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    provenance: opts.keyProvenance ?? null,
  });

  const sessionsRepo = new InMemorySessionsRepo();
  const driver = new MockDriver({
    fastForwardLatency: true,
    navigateLatencyMs: 0,
    interactLatencyMs: 0,
  });

  // Pass authRepo so revocations / inserts propagate to both repos in the
  // same way they would share a single DB row in production.
  const apiKeysRepo = new InMemoryApiKeysRepo(authRepo);
  apiKeysRepo.upsert({
    id: apiKeyId,
    accountId,
    name: 'test-key',
    keyPrefix,
    keyHash,
    scopes: opts.scopes ?? ['read', 'write', 'account_owner', 'driftstack_internal_admin'],
    lastUsedAt: null,
    revokedAt: opts.keyRevoked === true ? new Date('2026-01-15T00:00:00Z') : null,
    expiresAt: opts.keyExpired === true ? new Date('2026-01-15T00:00:00Z') : null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    // Both repos back the SAME production row, so provenance must match on
    // each — the keys repo re-upserts into authRepo and would otherwise
    // silently downgrade a desktop credential back to an ordinary key.
    provenance: opts.keyProvenance ?? null,
  });
  const authCache = new InMemoryAuthCache();
  const authCoalescer = new AuthCoalescer();

  const usageRepo = new InMemoryUsageRepo();
  const usageService = new UsageService(usageRepo);

  // Arc 4 Wave 2.B sub-slice 8.18/8.19 (v2-#8) — Prometheus metrics
  // registry. Pre-registers every counter so call sites can inc()
  // blindly without first checking registration. Constructed BEFORE
  // the audit service so emit-on-event services downstream can take
  // the registry at construction time. The same registration block
  // lives in bootstrap.ts (prod).
  const metricsRegistry = new MetricsRegistry();
  metricsRegistry.registerGauge(
    METRIC_NAMES.scheduledJobChainPending,
    'Liveness of each self-re-arming job chain.',
    ['job_type'],
  );
  metricsRegistry.registerCounter(
    METRIC_NAMES.unhandledRejectionTotal,
    'Unhandled promise rejections swallowed by the process backstop.',
  );
  metricsRegistry.registerCounter(
    METRIC_NAMES.retentionPurgeTotal,
    'Account-deletion retention purge outcomes by arm.',
    ['arm', 'outcome'],
  );
  metricsRegistry.registerCounter(
    METRIC_NAMES.pairModeTransitionTotal,
    'Pair-mode state-machine transitions, labelled by from + to states.',
    ['from', 'to'],
  );
  metricsRegistry.registerCounter(
    METRIC_NAMES.bundledLlmRequestTotal,
    'Bundled-LLM decompose requests, labelled by outcome.',
    ['outcome'],
  );
  metricsRegistry.registerCounter(
    METRIC_NAMES.bundledLlmErrorTotal,
    'Bundled-LLM decompose errors, labelled by error kind.',
    ['kind'],
  );
  // Arc 7 obs.3 — agent decompose result-kind counter.
  metricsRegistry.registerCounter(
    METRIC_NAMES.agentDecomposeTotal,
    'Agent decompose() call counter, labelled by result kind (plan / clarify / refuse).',
    ['result_kind'],
  );
  // Arc 7 obs.4 — BYOK Anthropic /test outcome counter.
  metricsRegistry.registerCounter(
    METRIC_NAMES.byokAnthropicTestTotal,
    'BYOK Anthropic /test endpoint outcomes (ok / invalid / quota_exceeded / not_set / not_wired / unknown).',
    ['outcome'],
  );
  // Arc 7 obs.5 — rate-limit consume counter.
  metricsRegistry.registerCounter(
    METRIC_NAMES.rateLimitTotal,
    'Rate-limit consume counter, labelled by bucket + outcome (allowed | exceeded).',
    ['bucket', 'outcome'],
  );
  // DoS hardening — rate-limit primary-store (Redis) failure counter.
  metricsRegistry.registerCounter(
    METRIC_NAMES.rateLimitStoreFallbackTotal,
    'Rate-limit primary-store failures that degraded to the in-process memory fallback, labelled by limiter (account | ip).',
    ['limiter'],
  );
  // Arc 7 obs.6 — auth resolution outcome counter.
  metricsRegistry.registerCounter(
    METRIC_NAMES.authTotal,
    'Auth resolution outcomes (ok / unauthorized / invalid / revoked / expired / forbidden / error).',
    ['outcome'],
  );
  // Arc 7 obs.7 — OAuth /token exchange outcome counter.
  metricsRegistry.registerCounter(
    METRIC_NAMES.oauthTokenTotal,
    'OAuth /token exchange outcomes (ok + OAuthError codes + error).',
    ['outcome'],
  );
  // Arc 7 obs.8 — Stripe webhook receiver outcome counter.
  metricsRegistry.registerCounter(
    METRIC_NAMES.stripeWebhookTotal,
    'Stripe webhook receiver outcomes (handled / duplicate / ignored / error / signature_invalid / signature_missing / empty_body / malformed_event).',
    ['outcome'],
  );
  // Arc 7 obs.9 — NOWPayments IPN receiver outcome counter.
  metricsRegistry.registerCounter(
    METRIC_NAMES.nowpaymentsWebhookTotal,
    'NOWPayments IPN receiver outcomes (ok / signature_missing / signature_invalid / empty_body / malformed_event).',
    ['outcome'],
  );
  // Arc 7 obs.10 — account audit log emission counter.
  metricsRegistry.registerCounter(
    METRIC_NAMES.accountAuditEmitTotal,
    'Customer-facing audit log emissions, labelled by action prefix + actor type.',
    ['prefix', 'actor_type', 'outcome'],
  );
  // Arc 7 obs.11 — admin audit log emission counter.
  metricsRegistry.registerCounter(
    METRIC_NAMES.adminAuditEmitTotal,
    'Admin audit log emissions, labelled by action prefix.',
    ['prefix', 'outcome'],
  );
  // Arc 7 obs.12 — LiveKit token mint outcome counter.
  metricsRegistry.registerCounter(
    METRIC_NAMES.livekitTokenMintTotal,
    'LiveKit token mint outcomes, labelled by role (publisher | subscriber | unknown) + outcome (ok / not_found / validation / forbidden / no_mac / secret_unreadable). Emitted by both /v1/sessions/:id/livekit-token (V-531.B) and /v1/agent-sessions/:id/livekit-token (LK.3); the role label discriminates publisher (legacy session-livekit surface) from subscriber (LK.3 + LK.6 gui-client).',
    ['role', 'outcome'],
  );
  // Arc 7 obs.13 — outbound email send outcome counter.
  metricsRegistry.registerCounter(
    METRIC_NAMES.emailSendTotal,
    'Outbound email sends, labelled by template + outcome (ok + classifyEmailError categories).',
    ['template', 'outcome'],
  );
  // Arc 7 obs.14 — outbound webhook delivery counters.
  metricsRegistry.registerCounter(
    METRIC_NAMES.webhookDeliveryAttemptTotal,
    'Outbound webhook delivery attempts, labelled by outcome (success / http_error / timeout / transport_error).',
    ['outcome'],
  );
  metricsRegistry.registerCounter(
    METRIC_NAMES.webhookDeliveryTerminalTotal,
    'Outbound webhook delivery terminal state transitions, labelled by terminal_state (delivered | dlq).',
    ['terminal_state'],
  );
  // Arc 7 obs.15 — foundational HTTP request counter.
  metricsRegistry.registerCounter(
    METRIC_NAMES.httpRequestTotal,
    'HTTP requests, labelled by method × route template × status_class (1xx/2xx/3xx/4xx/5xx).',
    ['method', 'route', 'status_class'],
  );
  // Arc 7 obs.16 — LK.2 Mac LiveKit credential registration outcomes.
  metricsRegistry.registerCounter(
    METRIC_NAMES.macNodeLivekitRegisterTotal,
    'POST /v1/mac-nodes/register outcomes (ok | validation | encryption_error | not_found | unknown).',
    ['outcome'],
  );

  // V-216 — customer-facing audit; constructed early so all
  // emit-on-event services (webhooks, sessions, api-keys, profiles)
  // can wire it.
  const accountAuditRepo = new InMemoryAccountAuditRepo();
  const accountAuditService = new AccountAuditService(accountAuditRepo, metricsRegistry);

  // V-202c — pre-construct logger + email + lifecycle service so
  // sessions can wire accountLifecycle. Test logger is reused below
  // by other services that take it explicitly.
  const testLogger = createTestLogger();
  const baseEmail = createEmailService({ config: null, logger: testLogger });
  const { service: noopEmail, sends: emailSends } = createRecordingEmailService(baseEmail);
  const emailPreferencesRepo = new InMemoryEmailPreferencesRepo();
  const emailPreferencesService = new EmailPreferencesService(emailPreferencesRepo);
  const accountLifecycleRepo = new InMemoryAccountLifecycleRepo();
  // Seed the account-lifecycle row so V-202c first-failure dispatch
  // can resolve the email + dedup flag without a separate seeding
  // step in tests.
  accountLifecycleRepo.upsert({
    id: accountId,
    email: opts.email ?? 'tester@driftstack.local',
    firstFailureEmailSentAt: null,
  });
  const accountLifecycleService = new AccountLifecycleService(
    accountLifecycleRepo,
    noopEmail,
    emailPreferencesService,
    testLogger,
    {
      docsBaseUrl: 'https://driftstack.local/docs',
      billingPortalUrl: 'http://localhost:5173/billing',
      dashboardUrl: 'http://localhost:5173',
    },
    accountAuditService, // V-202b — tier_changed audit emit
  );

  // Scheduled-jobs service. Tests can call
  // `scheduledJobsService.processTick()` directly to fire any due jobs
  // without waiting on a setInterval poller.
  const scheduledJobsRepo = new InMemoryScheduledJobsRepo();
  const scheduledJobsService = new ScheduledJobsService(scheduledJobsRepo, testLogger, {
    workerId: 'test-worker',
  });

  const webhooksRepo = new InMemoryWebhooksRepo();
  // V-225 — accountAudit wired for webhook_endpoint.{created,deleted}.
  const webhooksService = new WebhooksService(webhooksRepo, accountAuditService);
  const webhooksAdminService = new WebhooksAdminService(webhooksRepo);

  const adminAuditRepo = new InMemoryAdminAuditLogRepo();
  const adminAuditService = new AdminAuditService(adminAuditRepo, metricsRegistry);

  const accountsAdminRepo = new InMemoryAccountsAdminRepo(authRepo);
  // accountsAdminService is constructed further down (after sessionsService)
  // so suspend() can reclaim running sessions via the SuspendSessionReclaimer —
  // mirrors the bootstrap wiring order.
  // V-295c3 — public-status email subscribers.
  const statusSubscribersRepo = new InMemoryStatusSubscribersRepo();
  const statusSubscribersService = new StatusSubscribersService(statusSubscribersRepo, noopEmail, {
    statusPageBaseUrl: 'https://status.driftstack.test',
  });

  // V-298b/c — Team RBAC v1.
  const teamMembersRepo = new InMemoryTeamMembersRepo();
  // Seed the test account's email so accept-flow tests can match it.
  teamMembersRepo.upsertAccountEmail(accountId, opts.email ?? 'tester@driftstack.local');
  const teamMembersService = new TeamMembersService(
    teamMembersRepo,
    noopEmail,
    { dashboardBaseUrl: 'https://app.driftstack.test' },
    accountAuditService,
  );

  // V-295c3-followup — incident-notification fan-out.
  // V-545.B Phase 2 — throttle repo wired in by default for test
  // coverage of notifyUpdated; fixtures that need to disable can
  // construct their own service instance.
  const incidentUpdateNotificationsRepo = new InMemoryIncidentUpdateNotificationsRepo();
  const incidentNotifications = new IncidentNotificationsService(
    statusSubscribersService,
    noopEmail,
    testLogger,
    { statusPageBaseUrl: 'https://status.driftstack.test' },
    incidentUpdateNotificationsRepo,
  );

  // V-295e — incident event bus + SLA reporting. Probes repo is also
  // exposed so SLA tests can seed probe history directly.
  const probesRepo = new InMemoryProbesRepo();
  const slaReportingService = new SlaReportingService(probesRepo);
  const incidentEventBus = new IncidentEventBus();

  // Arc 1 sub-slice 6.5 (v2-#6) — bundled-LLM repo + service. Always
  // declared so fixture shape is stable; consent flag flips only when
  // opts.enableBundledLlm is set.
  const bundledLlmRepo = new InMemoryBundledLlmRepo();
  if (opts.enableBundledLlm !== undefined) {
    bundledLlmRepo.set(accountId, {
      consent: opts.enableBundledLlm.consent,
      monthlyCapUsdCents: opts.enableBundledLlm.monthlyCapUsdCents,
    });
  }
  const bundledLlmService = new BundledLlmService(bundledLlmRepo);
  // Billing-integrity hardening — bundled-turn concurrency limiter. Always
  // constructed so the fixture can expose it (a test pre-occupies slots to
  // assert the route 429s when full); ceiling defaults to 3 unless the
  // test overrides via opts.bundledTurnMaxConcurrency.
  const bundledTurnConcurrency = new BundledTurnConcurrencyLimiter(
    opts.bundledTurnMaxConcurrency ?? undefined,
  );

  // BYOK Anthropic — active service wired only when opts.enableByokAnthropic
  // is set; otherwise byokAnthropicService stays undefined and the routes
  // register their 503 activation-gate stubs. Repo is always declared so
  // the fixture shape is stable.
  const byokAnthropicRepo = new InMemoryBYOKAnthropicRepo();
  const testByokKeyCache = new InMemoryByokKeyCache();
  const byokAnthropicService =
    opts.enableByokAnthropic === true
      ? new BYOKAnthropicService(byokAnthropicRepo, {
          // 32 zero-bytes base64 — round-trip-only test key (production
          // uses the real MFA_ENCRYPTION_KEY env).
          encryptionKey: Buffer.alloc(32, 0).toString('base64'),
        })
      : undefined;

  // Arc 2 sub-slice 8.3 (v2-#8) — transcript event bus. Always wired
  // so AgentRuntime can publish; route registration is gated below
  // on enableAgentRuntime being on.
  const agentSessionEventBus = new AgentSessionEventBus();
  // gui_control_key control-auth tests — exposed only when
  // enableAgentRuntime wires the runtime + repo below. Lets a test
  // directly set/expire a session's gui_control_key (e.g. assert the
  // expired-key path 401s) without time-flaky waits. Stays undefined
  // when the runtime isn't wired.
  let agentSessionsRepoForTests: InMemoryAgentSessionsRepo | undefined;
  let agentTurnReceiptsRepoForTests: InMemoryAgentTurnReceiptsRepo | undefined;
  // Arc 2 sub-slice 8.8 (v2-#8) — in-memory takeover lock for tests.
  const pairModeLock = new InMemoryPairModeTakeoverLock();
  // Arc 4 Wave 2.B sub-slice 8.13d (v2-#8) — heartbeat tracker for tests.
  const pairModeHeartbeatTracker = new InMemoryPairModeHeartbeatTracker();
  // AI-B4 — in-memory recipes repo for tests; production path uses
  // DrizzleRecipesRepo. Always wired so the /v1/recipes route
  // registers (activation gate requires both recipesRepo +
  // agentSessionsRepo to be present).
  const recipesRepo = new InMemoryRecipesRepo();
  // V-820 — fleet control-plane deps. Always constructed so the fixture
  // shape is stable; only wired into AppDeps (taking the live
  // /v1/fleet/events WS route off the 503 stub) when
  // opts.enableFleetControlPlane is set. The nonce cache is passed to
  // both the verifier (replay defence) and AppDeps (the activation gate
  // requires all three: auth + nonceCache + registry).
  const fleetNodesRepo = new InMemoryFleetNodesRepo();
  const fleetNonceCache = new InMemoryFleetNonceCache();
  const fleetNodeAuth = new FleetNodeAuthImpl(fleetNodesRepo, fleetNonceCache);
  const fleetControlRegistry = new FleetControlRegistry();
  // Arc 4 Wave 2.B sub-slice 8.18 — metrics registry is now
  // constructed earlier (before the audit service), see above.

  // v2-#18 — capturing usage recorder for the AgentRuntime end-to-end
  // smoke. Always declared (even when captureAgentDecomposerUsage is
  // off) so the fixture shape is stable.
  const agentDecomposerUsageRecords: Array<{
    accountId: string;
    driftstackSessionId: string | null;
    agentSessionId: string;
    decomposeResultKind: 'plan' | 'clarify' | 'refuse';
    usage: DecomposeUsage;
    tokensConsumed: number;
    now: Date;
    keySource?: 'header' | 'cached' | 'bundled' | 'fallback' | 'none';
  }> = [];

  // V-295d — outbound incident broadcasts. Recording fetcher captures
  // POST calls so tests can assert payloads without real HTTP.
  const broadcastFetchCalls: { url: string; body: unknown }[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  const broadcastFetcher = async (url: string, init: RequestInit): Promise<Response> => {
    broadcastFetchCalls.push({
      url,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
    });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const incidentBroadcast = new IncidentBroadcastService(
    {
      slackWebhookUrl: opts.broadcastSlackUrl ?? null,
      genericWebhookUrl: opts.broadcastGenericUrl ?? null,
      statusPageBaseUrl: 'https://status.driftstack.test',
    },
    testLogger,
    broadcastFetcher,
  );

  // V-295a — incidents service with in-memory repo + V-295c3-followup
  // lifecycle hooks for incident-notification fan-out + V-295d
  // outbound broadcasts.
  // S45 2026-07-07 — mirror prod bootstrap: every public-incident hook
  // also publishes an `incident.broadcast` frame to the customer SSE
  // notification bus (per-subscriber accountId stamping via
  // publishBroadcast).
  const notificationEventBus = new NotificationEventBus();
  const publishIncidentNotification = (incident: IncidentRow): void => {
    notificationEventBus.publishBroadcast({
      kind: 'incident.broadcast',
      incidentId: `inc_${incident.id}`,
      severity: incident.severity,
      title: incident.title,
      at: new Date().toISOString(),
    });
  };
  const incidentsRepo = new InMemoryIncidentsRepo();
  const incidentsService = new IncidentsService(incidentsRepo, {
    onPublicCreated: async (incident, update) => {
      incidentEventBus.publishCreated(incident, update);
      publishIncidentNotification(incident);
      await Promise.all([
        incidentNotifications.notifyCreated(incident, update),
        incidentBroadcast.notifyCreated(incident, update),
      ]);
    },
    onPublicResolved: async (incident, update) => {
      incidentEventBus.publishResolved(incident, update);
      publishIncidentNotification(incident);
      await Promise.all([
        incidentNotifications.notifyResolved(incident, update),
        incidentBroadcast.notifyResolved(incident, update),
      ]);
    },
    // V-545.B Phase 2 — mirror prod bootstrap so integration tests
    // exercising addUpdate fire the throttled notifyUpdated path.
    // S45 — SSE frames are not throttled (live stream, no inbox).
    onPublicUpdated: async (incident, update) => {
      publishIncidentNotification(incident);
      await incidentNotifications.notifyUpdated(incident, update);
    },
  });

  const rateLimitOverridesRepo = new InMemoryRateLimitOverridesRepo(authRepo);
  const rateLimitOverridesService = new RateLimitOverridesService(
    rateLimitOverridesRepo,
    authCache,
  );

  // V-218 — validation harness with mock recapture bridge.
  const validationSchedulesRepo = new InMemoryValidationSchedulesRepo();
  const recaptureBridge: ValidationHarnessRecaptureBridge = {
    triggerRecapture: () => Promise.resolve({ id: `run_${testRandomUUID()}` }),
  };
  const validationHarnessService = new ValidationHarnessService(
    validationSchedulesRepo,
    recaptureBridge,
    { iosVersion: '18.7', safariVersion: '26.4' },
  );

  // Wire webhooks INTO sessions + api-keys services for event emission.
  const sessionsService = new SessionsService({
    repo: sessionsRepo,
    driver,
    webhooks: webhooksService,
    accountAudit: accountAuditService,
    accountLifecycle: accountLifecycleService,
  });
  // accountsAdminService is constructed further down (after apiKeysService /
  // authFlowsService exist — its GDPR Article 17 deleteAccount() reclaim
  // path depends on both, plus webhooksService already built above), mirroring
  // bootstrap.ts's construction order.
  const adminBillingService = new AdminBillingService(new InMemoryAdminBillingRepo());
  const pricingService = new PricingService(new InMemoryPricingRepo());
  // Secrets Phase A — enabled with a fixed test key so route tests can
  // exercise set/reveal end-to-end (32 zero bytes, base64).
  const platformSecretsService = new PlatformSecretsService(
    new InMemoryPlatformSecretsRepo(),
    Buffer.alloc(32).toString('base64'),
  );
  // Legal-acceptance plumbing — uses an in-memory catalog with a fixed
  // canned document set (one per documentKey) so tests don't depend on
  // file-system reads.
  const legalRepo = new InMemoryLegalRepo();
  const legalCatalog = buildLegalCatalogFromContent([
    {
      documentKey: 'tos',
      title: 'Terms of Service',
      sourcePath: 'docs/legal/terms-of-service.md',
      content:
        '# Test ToS\n\n**Version:** 0.1.0-draft · **Effective:** 2026-05-03\n\nFixture content.',
    },
    {
      documentKey: 'privacy',
      title: 'Privacy Policy',
      sourcePath: 'docs/legal/privacy-policy.md',
      content:
        '# Test Privacy\n\n**Version:** 0.1.0-draft · **Effective:** 2026-05-03\n\nFixture content.',
    },
    {
      documentKey: 'dpa',
      title: 'DPA',
      sourcePath: 'docs/legal/dpa.md',
      content:
        '# Test DPA\n\n**Version:** 0.1.0-draft · **Effective:** 2026-05-03\n\nFixture content.',
    },
    {
      documentKey: 'aup',
      title: 'AUP',
      sourcePath: 'docs/legal/acceptable-use-policy.md',
      content:
        '# Test AUP\n\n**Version:** 0.1.0-draft · **Effective:** 2026-05-03\n\nFixture content.',
    },
  ]);
  const legalService = new LegalService(legalCatalog, legalRepo);

  // Pre-seed acceptances for the seeded account so the api-key
  // issuance gate (V-049) doesn't block existing tests that exercise
  // /v1/api-keys without separately accepting docs. Tests that
  // exercise the gate set `skipLegalAcceptance: true` and then assert
  // 409s.
  if (opts.skipLegalAcceptance !== true) {
    for (const entry of legalCatalog.entries()) {
      await legalRepo.recordAcceptance({
        accountId,
        documentKey: entry.documentKey,
        version: entry.version,
        contentHash: entry.contentHash,
        acceptedFromIp: null,
        acceptedUserAgent: null,
      });
    }
  }

  const apiKeysService = new ApiKeysService(
    apiKeysRepo,
    authCache,
    webhooksService,
    legalService,
    accountAuditService,
  );

  // V-079: auth-flow service. Uses a no-op email service (Postmark
  // unconfigured) and exposes debug tokens so tests can read the
  // plaintext from the response without scraping email.
  // testLogger + noopEmail constructed earlier for V-202c lifecycle
  // service; reused here.
  const authFlowsRepo = new InMemoryAuthFlowsRepo();

  // V-353b — MFA service backed by in-memory repo. Encryption key is
  // a fixed 32-byte test key so tests are deterministic.
  const mfaRepo = new InMemoryMfaRepo(authFlowsRepo);
  const mfaService = new MfaService(
    mfaRepo,
    {
      // 32-byte all-zeros key, base64. Test-only — never use in prod.
      encryptionKey: Buffer.alloc(32, 0).toString('base64'),
    },
    accountAuditService,
    authCache,
  );

  // V-353d — in-memory challenge token store for the MFA login
  // hand-off. Lives in tests as a Map; production wires Redis.
  const mfaChallengeStore = new InMemoryMfaChallengeStore();

  const authFlowsService = new AuthFlowsService(
    authFlowsRepo,
    noopEmail,
    testLogger,
    {
      verifyEmailUrl: 'http://localhost:5173/verify-email',
      magicLinkUrl: 'http://localhost:5173/auth/magic-link',
      passwordResetUrl: 'http://localhost:5173/reset-password',
      exposeDebugToken: true,
      // Undefined keeps the service's own `?? 'free'` default, so every
      // existing fixture is byte-for-byte unaffected.
      ...(opts.signupTier !== undefined ? { initialTier: opts.signupTier } : {}),
    },
    authCache, // V-168 — cache invalidation on logout
    accountAuditService, // V-224 — emit account.{email_verified,login,logout,password_changed}
    mfaService, // V-353d — branch login() on MFA enrollment
    mfaChallengeStore, // V-353d — short-lived challenge store
  );

  // Wired with the sessions reclaimer + the GDPR Article 17 delete-reclaim
  // trio (web sessions / API keys / webhooks), mirroring bootstrap.ts.
  const accountsAdminService = new AccountsAdminService(
    accountsAdminRepo,
    authCache,
    sessionsService,
    authFlowsService,
    apiKeysService,
    webhooksService,
  );

  // V-266 — browser-OAuth flow with in-memory store for tests.
  const cliAuthorizeService = new CliAuthorizeService({
    store: new InMemoryCliAuthorizeStore(),
    dashboardOrigin: 'http://localhost:5173',
    secretEncryptionKeyBase64: Buffer.alloc(32, 7).toString('base64'),
  });

  // V-168 — bridge web sessions issued by AuthFlowsService into the auth
  // path so a freshly-signed-up user's web-session bearer can authenticate
  // on routes that use requireAuth (e.g. POST /v1/api-keys). The Drizzle
  // production wiring queries `web_sessions` directly; the in-memory
  // fixture delegates through this finder.
  authRepo.setWebSessionFinder({
    async findActiveWebSession(args) {
      const row = await authFlowsRepo.findActiveWebSession(args);
      if (!row) return null;
      return {
        id: row.id,
        accountId: row.accountId,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
        lastUsedAt: row.lastUsedAt,
        mfaSatisfiedAt: row.mfaSatisfiedAt,
        createdAt: row.createdAt,
      };
    },
    touchWebSessionLastUsed(id, at) {
      return authFlowsRepo.touchWebSession(id, at);
    },
    // Bridge accounts created by AuthFlowsService.signup so the auth
    // path's getAccount finds them. Production wiring uses one
    // accounts table; the in-memory fixture has separate maps.
    async getAccount(id) {
      const row = await authFlowsRepo.findAccountById(id);
      if (!row) return null;
      return {
        id: row.id,
        email: row.email,
        name: row.name,
        tier: row.tier,
        status: row.status,
        timezone: null,
        avatarR2Key: null,
        slug: null,
        region: null,
        createdAt: row.createdAt,
        updatedAt: row.createdAt,
      };
    },
  });

  // V-080 + V-089: Stripe webhook service + a deterministic signing
  // secret so tests can sign canned events without a real Stripe
  // dashboard. priceToTier mirrors the test fixture's tierPrices so
  // subscription events resolve back to the right local tier.
  const stripeWebhooksRepo = new InMemoryStripeWebhooksRepo();
  // Production keeps ONE accounts.tier column, so a Stripe/crypto activation is
  // immediately visible to authentication. Mirror every tier write into the
  // auth store (and drop the cached context) so a fixture upgrade authenticates
  // on the NEW tier — otherwise an upgraded account keeps hitting tier gates it
  // has already paid past.
  stripeWebhooksRepo.setTierMirror((mirroredAccountId, tier) => {
    const existing = authRepo.allAccounts().find((a) => a.id === mirroredAccountId);
    if (existing !== undefined) authRepo.upsertAccount({ ...existing, tier });
    void authCache.invalidateAccount(mirroredAccountId);
  });
  // Register the seeded account so the webhook handler can resolve it.
  // The test fixture pins a known stripe_customer_id ('cus_test_default')
  // so canned subscription events with `customer: 'cus_test_default'`
  // round-trip cleanly.
  stripeWebhooksRepo.registerAccount({
    accountId,
    stripeCustomerId: 'cus_test_default',
    tier: opts.tier ?? 'api_builder',
  });
  const stripeWebhooksService = new StripeWebhooksService(
    stripeWebhooksRepo,
    {
      logger: testLogger,
      priceToTier: {
        price_solo_monthly: 'solo_manual',
        price_solo_annual: 'solo_manual',
        price_team_monthly: 'team_manual',
        price_team_annual: 'team_manual',
        price_agency_monthly: 'agency_manual',
        price_agency_annual: 'agency_manual',
        price_api_starter_monthly: 'api_starter',
        price_api_starter_annual: 'api_starter',
        price_api_builder_monthly: 'api_builder',
        price_api_builder_annual: 'api_builder',
        price_api_scale_monthly: 'api_scale',
        price_api_scale_annual: 'api_scale',
      },
    },
    accountLifecycleService, // V-202b — fans out tier_changed audit + email at one call site
    authCache, // invalidate the cached AccountContext on a Stripe-driven tier change (rate-limit tier freshness)
  );
  const stripeWebhookSigningSecret = 'whsec_test_fixture_secret';

  // V-081: Profiles service.
  const profilesRepo = new InMemoryProfilesRepo();
  // ARC A — per-account customer proxies repo + a fixed test master key so the
  // /v1/account/me/proxies routes are live and password-wrapping is exercised.
  const accountProxiesRepo = new InMemoryAccountProxiesRepo();
  // `profileMasterKeyUnset` reproduces a deployment with PROFILE_MASTER_KEY
  // absent. bootstrap.ts sets the same buffer to null there and logs that
  // "encrypted account proxies are unreadable and credentialed writes fail
  // closed" — null is what makes those writes fail closed, so it has to be the
  // same null, not a separate flag the route consults.
  const proxyMasterKey = opts.profileMasterKeyUnset === true ? null : Buffer.alloc(32, 7);
  const accountProxiesService = new AccountProxiesService(accountProxiesRepo, proxyMasterKey);
  // V-225 — accountAudit wired for profile.{created,deleted}.
  const profilesService = new ProfilesService(profilesRepo, accountAuditService);
  // V-312 — profile snapshots service shares the profiles repo for
  // tier-cap + name-conflict enforcement on restore.
  const profileSnapshotsService = new ProfileSnapshotsService(
    new InMemoryProfileSnapshotsRepo(),
    profilesRepo,
    accountAuditService,
  );

  // V-082: Billing service against an in-memory provider. The seeded
  // account is registered with the billing repo so getAccount + the
  // ensureCustomer flow round-trip without DB.
  const billingRepo = new InMemoryBillingRepo();
  billingRepo.upsertAccount({
    id: accountId,
    email: opts.email ?? 'tester@driftstack.local',
    name: 'Tester',
    tier: opts.tier ?? 'api_builder',
    stripeCustomerId: null,
  });
  const billingProvider = new InMemoryBillingProvider();
  const billingService = new BillingService(billingRepo, billingProvider, {
    tierPrices: {
      solo_manual: { monthly: 'price_solo_monthly', annual: 'price_solo_annual' },
      team_manual: { monthly: 'price_team_monthly', annual: 'price_team_annual' },
      agency_manual: { monthly: 'price_agency_monthly', annual: 'price_agency_annual' },
      api_starter: { monthly: 'price_api_starter_monthly', annual: 'price_api_starter_annual' },
      api_builder: { monthly: 'price_api_builder_monthly', annual: 'price_api_builder_annual' },
      api_scale: { monthly: 'price_api_scale_monthly', annual: 'price_api_scale_annual' },
    },
    defaultSuccessUrl: 'http://localhost:5173/billing/success',
    defaultCancelUrl: 'http://localhost:5173/billing/cancel',
    portalReturnUrl: 'http://localhost:5173/billing',
  });

  // V-541.D — cost-monitoring service against an in-memory aggregator
  // that tests populate via the returned `costUsageByAccount` map.
  const costUsageByAccount = new Map<string, UsageInputs>();
  const costMonitoringService = new CostMonitoringService({
    aggregator: {
      aggregateForAccount: ({ accountId }) =>
        Promise.resolve(costUsageByAccount.get(accountId) ?? null),
    },
    rates: {
      computeCentsPerMinute: 1,
      storageCentsPerGbMonth: 2,
      egressCentsPerGb: 5,
      emailCentsPerSend: 1,
      llmCentsPer1kInputTokens: 30,
      llmCentsPer1kOutputTokens: 150,
    },
    resolveTier: (id) => {
      const acc = billingRepo.getAccount(id);
      return acc.then((a) => a?.tier ?? null);
    },
  });

  // V-666.C — in-memory crypto-orders store for the customer-facing
  // /v1/billing/crypto-checkout route. Tests that exercise the IPN
  // pipeline can read back the resulting CryptoOrder by id.
  const cryptoOrdersRepo = new InMemoryCryptoOrdersRepo();
  // S41 2026-07-07 (founder-approved: wire crypto activation) — tier
  // activation on the paid transition, wired against the SAME in-memory
  // Stripe-webhooks repo account facet the Stripe tests mutate, so crypto +
  // Stripe tier changes observe each other exactly like prod (both write
  // accounts.tier), and against the same lifecycle/auth-cache fan-out.
  const cryptoTierActivation = new CryptoTierActivationService(
    stripeWebhooksRepo,
    testLogger,
    accountLifecycleService,
    authCache,
  );
  const cryptoOrdersService = new CryptoOrdersService({
    repo: cryptoOrdersRepo,
    tierActivator: cryptoTierActivation,
    logger: testLogger,
  });

  // V-667.C — OAuth-client service. Only constructed when the test
  // opts in via opts.oauthClient; matches the prod app.ts gate
  // (oauthClient + ≥1 provider) so tests that don't pass the option
  // see the same 404-from-unregistered-route surface prod does
  // pre-env-wire.
  const oauthLinksRepo = new InMemoryOAuthLinksRepo();
  const oauthPendingLinksRepo = new InMemoryOAuthPendingLinksRepo();
  const oauthClientService =
    opts.oauthClient !== undefined
      ? new OAuthClientServiceImpl({
          links: oauthLinksRepo,
          pending: oauthPendingLinksRepo,
          accounts: {
            findIdByEmail: async (email) => {
              const row = await authFlowsRepo.findAccountByEmail(email);
              return row ? row.id : null;
            },
            createFromIdp: async (args) => {
              const created = await authFlowsRepo.createAccount({
                email: args.email,
                name: args.name,
                passwordHash: '',
                initialTier: 'free',
              });
              await authFlowsRepo.markEmailVerified(created.id, new Date());
              return created.id;
            },
          },
          mailer: {
            // Test seam — V-667.C unit tests already cover the
            // mailer-fired side. Integration tests assert the
            // pending-row was inserted; the mailer no-op here keeps
            // tests deterministic without recording fixtures.
            sendVerifyMergeEmail: () => Promise.resolve(),
          },
        })
      : undefined;

  const app = await buildApp({
    logger: testLogger,
    ...(opts.readinessChecks !== undefined ? { readinessChecks: opts.readinessChecks } : {}),
    // Gates the whole OAuth provider surface in buildApp, including the
    // staff-only client routes. Off by default so existing fixtures are
    // unchanged.
    ...(opts.withOauthStore === true ? { oauthStore: new InMemoryOAuthStore() } : {}),
    trustProxy: opts.trustProxy ?? false,
    // requireOwner admits exactly one email and fails CLOSED when this is
    // unset, so every fixture-built app forbade the owner-only admin surface
    // and nothing could reach it. Off by default, which keeps that posture for
    // suites that are not about the owner gate; a suite that needs the surface
    // passes the account's own email and gets in.
    ...(opts.ownerEmail !== undefined ? { ownerEmail: opts.ownerEmail } : {}),
    authRepo,
    authCache,
    authCoalescer,
    rateLimitStore,
    // DoS hardening — the global IP gate (default 600/min/IP) is disabled
    // for integration tests so the many high-volume inject() loops (which
    // all share remoteAddress 127.0.0.1) aren't throttled. Dedicated
    // suites that assert the gate pass opts.globalIpRateLimit to enable it.
    globalIpRateLimit: opts.globalIpRateLimit ?? null,
    sessionsService,
    apiKeysService,
    usageService,
    webhooksService,
    webhooksAdminService,
    adminAuditService,
    accountsAdminService,
    adminBillingService,
    pricingService,
    platformSecretsService,
    incidentsService,
    statusSubscribersService,
    incidentEventBus,
    // S45 — activates GET /v1/account/me/notifications in tests, same
    // opt-in wire the prod bootstrap uses.
    notificationEventBus,
    slaReportingService,
    teamMembersService,
    rateLimitOverridesService,
    legalService,
    emailPreferencesService,
    accountAuditService,
    validationHarnessService,
    accountLifecycleService,
    scheduledJobsService,
    authFlowsService,
    cliAuthorizeService,
    mfaService,
    stripeWebhooksService,
    stripeWebhookSigningSecret,
    profilesService,
    profileSnapshotsService,
    ...(opts.disableBilling === true ? {} : { billingService }),
    ...(opts.enableEgressSafeguard === true
      ? {
          sessionEgressService: {
            applyToSession: () =>
              Promise.reject(new Error('test stub: applyToSession not implemented')),
            releaseFromSession: () => Promise.resolve(),
          },
        }
      : {}),
    // W615 — explicit override beats backend inference (only spread when set
    // so exactOptionalPropertyTypes stays satisfied).
    ...(opts.sessionProxyRequired === undefined
      ? {}
      : { sessionProxyRequired: opts.sessionProxyRequired }),
    // Spread-only-when-set, same as the line above: exactOptionalPropertyTypes
    // rejects an explicit `undefined` here.
    ...(opts.agentDecomposerKind === undefined
      ? {}
      : { agentDecomposerKind: opts.agentDecomposerKind }),
    ...(opts.enableAgentRuntime === true
      ? (() => {
          const agentSessionsRepo = new InMemoryAgentSessionsRepo();
          agentSessionsRepoForTests = agentSessionsRepo;
          const agentTurnReceiptsRepo =
            opts.disableAgentTurnReceipts === true
              ? undefined
              : new InMemoryAgentTurnReceiptsRepo();
          agentTurnReceiptsRepoForTests = agentTurnReceiptsRepo;
          // v2-#18 — optional capturing usage recorder. When the test
          // passes `captureAgentDecomposerUsage: true`, AgentRuntime
          // wires a recorder that appends each .record() call into the
          // fixture's `agentDecomposerUsageRecords` array. Lets the
          // end-to-end smoke test assert the decomposer→runtime→recorder
          // chain fires correctly through the HTTP layer without
          // needing the Drizzle path.
          const agentRuntime = new AgentRuntime({
            decomposer: new DeterministicAgentDecomposer(),
            executor: new StubAgentExecutor(),
            sessions: agentSessionsRepo,
            archetype: 'iphone16pro_ios18_7_safari26_4',
            eventBus: agentSessionEventBus,
            // Arc 7 obs.3 — wire the metrics registry so the
            // driftstack_agent_decompose_total counter ticks under
            // the integration smoke.
            metrics: metricsRegistry,
            ...(opts.captureAgentDecomposerUsage === true
              ? {
                  usageRecorder: {
                    record: async (recordArgs) => {
                      agentDecomposerUsageRecords.push(recordArgs);
                      return Promise.resolve();
                    },
                  },
                }
              : {}),
          });
          return {
            agentRuntime,
            agentSessionsRepo,
            ...(agentTurnReceiptsRepo !== undefined ? { agentTurnReceiptsRepo } : {}),
            agentSessionEventBus,
          };
        })()
      : {}),
    // Founder safeguard (2026-06-24) — per-account in-flight upload cap override
    // (bytes). Only spread when set so exactOptionalPropertyTypes stays happy;
    // omitted → the route's 512 MB default. Lets the cap test trip with tiny payloads.
    ...(opts.uploadMaxAccountInFlightBytes === undefined
      ? {}
      : { agentUploadMaxAccountInFlightBytes: opts.uploadMaxAccountInFlightBytes }),
    // Hardening (2026-06-24) — per-account concurrent-relay COUNT cap + concurrent-
    // upload COUNT cap overrides. Only spread when set (exactOptionalPropertyTypes);
    // omitted → the route defaults (16 / 4). Let the cap tests trip them at 1–2.
    ...(opts.relayMaxAccountInFlight === undefined
      ? {}
      : { agentRelayMaxAccountInFlight: opts.relayMaxAccountInFlight }),
    ...(opts.uploadMaxAccountInFlightCount === undefined
      ? {}
      : { agentUploadMaxAccountInFlightCount: opts.uploadMaxAccountInFlightCount }),
    // Arc 1 sub-slice 6.5 (v2-#6) — bundled-LLM service is always
    // wired (matches the prod bootstrap which constructs it
    // unconditionally). The route layer separately gates the bundled
    // leg on deploymentFallbackKey being set; sub-slice 6.6 GET +
    // PATCH need the service regardless.
    bundledLlmService,
    // Billing-integrity hardening — inject the fixture-built bundled-turn
    // limiter so a test can pre-occupy slots and assert the route 429s.
    bundledTurnConcurrency,
    ...(byokAnthropicService !== undefined ? { byokAnthropicService } : {}),
    // V-730 — so a test can prove that clearing / rotating the stored key
    // EVICTS the plaintext already cached for open agent sessions.
    ...(byokAnthropicService !== undefined ? { byokKeyCache: testByokKeyCache } : {}),
    // V-820 — wire the fleet control-plane deps so the live WS handler
    // registers. All three are required by the app.ts activation gate.
    ...(opts.enableFleetControlPlane === true
      ? { fleetNodeAuth, fleetNonceCache, fleetControlRegistry }
      : {}),
    // Arc 2 sub-slice 8.4 (v2-#8) — stub MFA-key for the gui_control_key
    // mint. 32 raw bytes base64-encoded. Tests assert the route works
    // round-trip; production uses the real MFA_ENCRYPTION_KEY env.
    guiControlKeyEncryptionKey: Buffer.alloc(32, 7).toString('base64'),
    // Arc 2 sub-slice 8.8 (v2-#8) — in-memory takeover lock; always
    // wired so the takeover/handback routes register for tests.
    pairModeLock,
    // Arc 4 Wave 2.B sub-slice 8.13d (v2-#8) — heartbeat tracker so
    // takeover/handback handlers can record activity. The sweep
    // service itself isn't wired in the test fixture (tests would
    // become time-flaky); integration tests for the sweep live in
    // unit tests against PairModeHeartbeatSweep directly.
    pairModeHeartbeatTracker,
    // AI-B4 (v2-#8) — recipes repo. Wired unconditionally so the
    // /v1/recipes route activates against the in-memory repo for
    // tests; prod gates on Drizzle wiring per the activation
    // pattern. Recipes track agent-session snapshots so customers
    // can replay the same flow without re-paying decompose cost.
    recipesRepo,
    // Arc 4 Wave 2.B sub-slice 8.18 (v2-#8) — Prometheus metrics
    // registry + scrape token. Wired by default so /metrics + pair-mode
    // counters can be asserted; an explicit null exercises fail-closed
    // missing-config behavior.
    metricsRegistry,
    ...(opts.metricsScrapeToken === null
      ? {}
      : { metricsScrapeToken: opts.metricsScrapeToken ?? 'test-scrape-token' }),
    // Stub deployment fallback key — only used when a test seeds
    // opts.enableBundledLlm with consent=true so the bundled-LLM leg
    // can actually resolve. Otherwise harmless; default-fallback
    // posture stays gated by allowFallbackForUnconfiguredCustomers.
    ...(opts.enableBundledLlm !== undefined
      ? { agentDecomposerFallbackKey: 'sk-ant-test-deployment-fallback' }
      : {}),
    costMonitoringService,
    cryptoOrdersService,
    sessionRepo: sessionsRepo,
    apiKeysRepo,
    profilesRepo,
    accountProxiesRepo,
    accountProxiesService,
    // Founder directive #63 — CP-side live proxy pre-launch probe. Only wired when
    // a test injects a stub (default: unwired → gate no-op, today's behaviour).
    ...(opts.proxyConnectivityProbe !== undefined
      ? { proxyConnectivityProbe: opts.proxyConnectivityProbe }
      : {}),
    ...(opts.proxyPrelaunchProbeEnabled !== undefined
      ? { proxyPrelaunchProbeEnabled: opts.proxyPrelaunchProbeEnabled }
      : {}),
    profileMasterKey: proxyMasterKey,
    // ARC A slice 4b — deterministic probe so the proxy test endpoint doesn't
    // open real sockets. Use a reserved example hostname instead of TEST-NET
    // literals: the outbound SSRF guard correctly rejects non-global IP space.
    proxyTcpProbe:
      opts.proxyTcpProbe ??
      ((host: string) =>
        host === 'reachable-proxy.example.com'
          ? Promise.resolve()
          : Promise.reject(new Error('unreachable'))),
    // V-352b — fake R2 public bucket so /v1/account/me/avatar can be
    // exercised in integration tests without touching real Cloudflare.
    r2Public: r2PublicFake,
    driver,
    // V-278.C — default permissive (most route tests don't care). Tests that
    // exercise the STRICT posture pass `corsStrict` to flip it + supply the
    // dashboard origin / explicit allow-list.
    permissiveCors: opts.corsStrict === undefined,
    ...(opts.corsStrict?.dashboardOrigin !== undefined
      ? { dashboardOrigin: opts.corsStrict.dashboardOrigin }
      : {}),
    ...(opts.corsStrict?.allowedOrigins !== undefined
      ? { corsAllowedOrigins: opts.corsStrict.allowedOrigins }
      : {}),
    ...(opts.livekit !== undefined ? { livekit: opts.livekit } : {}),
    ...(opts.nowpaymentsIpnSecret !== undefined
      ? { nowpaymentsIpnSecret: opts.nowpaymentsIpnSecret }
      : {}),
    ...(opts.nowpaymentsClient !== undefined
      ? {
          nowpaymentsApiClient: opts.nowpaymentsClient,
          nowpaymentsIpnCallbackUrl: 'https://test.driftstack.dev/v1/webhooks/nowpayments',
        }
      : {}),
    ...(opts.oauthClient !== undefined && oauthClientService !== undefined
      ? { oauthClient: opts.oauthClient, oauthClientService, oauthLinksRepo }
      : {}),
  });

  return {
    app,
    /** V-730 — lets a test prove that clearing / rotating the stored key evicts
     *  the plaintext cached for open agent sessions. */
    byokKeyCache: testByokKeyCache,
    authRepo,
    authCache,
    authCoalescer,
    webhooksRepo,
    webhooksService,
    adminAuditRepo,
    accountAuditRepo,
    metricsRegistry,
    pairModeHeartbeatTracker,
    ...(agentSessionsRepoForTests !== undefined
      ? { agentSessionsRepo: agentSessionsRepoForTests }
      : {}),
    ...(agentTurnReceiptsRepoForTests !== undefined
      ? { agentTurnReceiptsRepo: agentTurnReceiptsRepoForTests }
      : {}),
    incidentsRepo,
    statusSubscribersRepo,
    statusSubscribersService,
    broadcastFetchCalls,
    agentDecomposerUsageRecords,
    bundledLlmRepo,
    bundledTurnConcurrency,
    byokAnthropicRepo,
    fleetNodesRepo,
    fleetControlRegistry,
    incidentEventBus,
    notificationEventBus,
    probesRepo,
    teamMembersRepo,
    teamMembersService,
    legalRepo,
    legalCatalog,
    emailSends,
    rateLimitOverridesRepo,
    sessionsRepo,
    apiKeysRepo,
    usageRepo,
    rateLimitStore,
    authFlowsRepo,
    stripeWebhooksRepo,
    stripeWebhookSigningSecret,
    profilesRepo,
    billingRepo,
    billingProvider,
    accountLifecycleRepo,
    scheduledJobsRepo,
    scheduledJobsService,
    driver,
    costUsageByAccount,
    cryptoOrdersService,
    cryptoOrdersRepo,
    validationSchedulesRepo,
    recaptureBridge,
    pricingService,
    platformSecretsService,
    oauthLinksRepo,
    plaintext,
    accountId,
    apiKeyId,
    r2PublicStore,
    cleanup: async () => {
      await app.close();
    },
  };
}

/**
 * Seed a second (or third, etc.) account on an existing test fixture.
 * Used by tests that need cross-account interaction — e.g. admin A
 * suspending account B then verifying B's keys 403 while A's keys
 * still work.
 *
 * The new account/key are written to BOTH `authRepo` and `apiKeysRepo`
 * (via the constructor-paired propagation set up in V-012). Returns
 * the new ids and plaintext key.
 */
export async function seedAdditionalAccount(
  fx: TestAppFixture,
  opts: SeedAdditionalOpts = {},
): Promise<AdditionalAccount> {
  const accountId = opts.accountId ?? '00000000-0000-4000-8000-0000000000a2';
  const apiKeyId = opts.apiKeyId ?? '00000000-0000-4000-8000-000000000a02';

  fx.authRepo.upsertAccount({
    id: accountId,
    email: opts.email ?? `tester-${accountId.slice(-4)}@driftstack.local`,
    name: opts.name ?? 'Tester-2',
    tier: opts.tier ?? 'api_builder',
    status: opts.accountStatus ?? 'active',
    timezone: null,
    avatarR2Key: null,
    slug: null,
    region: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  });

  const plaintext = generateApiKey('test');
  const keyHash = await hashApiKey(plaintext);
  const keyPrefix = keyPrefixFromPlaintext(plaintext);

  const keyRow = {
    id: apiKeyId,
    accountId,
    name: 'second-account-key',
    keyPrefix,
    keyHash,
    scopes:
      opts.scopes ??
      (['read', 'write', 'account_owner', 'driftstack_internal_admin'] as ApiKeyScope[]),
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };

  fx.authRepo.upsertApiKey(keyRow);
  fx.apiKeysRepo.upsert(keyRow);
  // V-202c — seed lifecycle row for the new account so a session.failed
  // here can resolve email + dedup flag.
  fx.accountLifecycleRepo.upsert({
    id: accountId,
    email: opts.email ?? `tester-${accountId.slice(-4)}@driftstack.local`,
    firstFailureEmailSentAt: null,
  });

  return { accountId, apiKeyId, plaintext };
}
