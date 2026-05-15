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
import type { RateLimitStore } from '../services/rate-limit.js';
import type { SessionsService } from '../services/sessions.js';
import type { ApiKeysService } from '../services/api-keys.js';
import type { UsageService } from '../services/usage.js';
import type { WebhooksService, WebhooksAdminService } from '../services/webhooks.js';
import type { AdminAuditService } from '../services/admin-audit.js';
import type { AccountsAdminService } from '../services/admin-accounts.js';
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
import type { ValidationHarnessService } from '../services/validation-harness.js';
import { registerAdminValidationHarnessRoutes } from '../routes/admin-validation-harness.js';
import { registerAccountRateLimitsRoutes } from '../routes/account-rate-limits.js';
import type { AuthFlowsService } from '../services/auth-flows.js';
import type { CliAuthorizeService } from '../services/cli-authorize.js';
import type { StripeWebhooksService } from '../services/stripe-webhooks.js';
import type { ProfilesService } from '../services/profiles.js';
import type { ProfileSnapshotsService } from '../services/profile-snapshots.js';
import type { BillingService } from '../services/billing.js';
import type { SessionRepo } from '../services/sessions.js';
import type { ProfilesRepo } from '../services/profiles.js';
import { registerAccountMeRoutes } from '../routes/account-me.js';
import { registerAccountWebSessionsRoutes } from '../routes/account-web-sessions.js';
import { registerAccountMfaRoutes } from '../routes/account-mfa.js';
import type { ApiKeysRepo } from '../services/api-keys.js';
import type { Driver } from '../drivers/types.js';
import type { R2 } from './r2.js';
import type { MfaService } from '../services/mfa.js';
import authPlugin from '../middleware/auth.js';
import rateLimitPlugin from '../middleware/rate-limit.js';
import requestIdPlugin from '../middleware/request-id.js';
import { registerErrorHandler } from '../middleware/error-handler.js';
import { registerSessionRoutes } from '../routes/sessions.js';
import { registerAdminRoutes } from '../routes/admin.js';
import { registerStatusRoutes } from '../routes/status.js';
import { registerOpenApiRoutes } from '../routes/openapi.js';
import { registerWebhookRoutes } from '../routes/webhooks.js';
import { registerAdminAccountsRoutes } from '../routes/admin-accounts.js';
import { registerAdminIncidentsRoutes } from '../routes/admin-incidents.js';
import { registerAdminWebhookRoutes } from '../routes/admin-webhooks.js';
import { registerAdminAuditLogRoutes } from '../routes/admin-audit-log.js';
import { registerAdminOverviewRoutes } from '../routes/admin-overview.js';
import { registerAdminSessionsRoutes } from '../routes/admin-sessions.js';
import { registerAdminApiKeysRoutes } from '../routes/admin-api-keys.js';
import { registerAdminRateLimitOverridesRoutes } from '../routes/admin-rate-limit-overrides.js';
import { registerLegalRoutes } from '../routes/legal.js';
import { registerAuthRoutes } from '../routes/auth.js';
import { registerAuthCliRoutes } from '../routes/auth-cli.js';
import { registerStripeWebhookRoutes } from '../routes/webhooks-stripe.js';
import { registerNowpaymentsWebhookRoutes } from '../routes/webhooks-nowpayments.js';
import { registerLivekitTokenRoute } from '../routes/sessions-livekit-token.js';
import { registerOAuthClientRoutes } from '../routes/auth-oauth-client.js';
import { registerAccountOauthLinksRoutes } from '../routes/account-oauth-links.js';
import type { OAuthLinksRepo } from '../services/oauth-client.js';
import type { OAuthClientService } from '../services/oauth-client.js';
import { registerCryptoCheckoutRoutes } from '../routes/billing-crypto.js';
import { registerCryptoQuoteRoutes } from '../routes/billing-crypto-quote.js';
import { registerCustomerCryptoOrdersRoutes } from '../routes/billing-crypto-orders.js';
import { registerAdminCryptoOrdersRoutes } from '../routes/admin-crypto-orders.js';
import type { CryptoOrdersService } from '../services/crypto-orders.js';
import { registerOAuthRoutes } from '../routes/oauth.js';
import { OAuthService, type OAuthStore } from '../services/oauth.js';
import { registerAdminCostRoutes } from '../routes/admin-cost.js';
import { registerAdminUsageRoutes } from '../routes/admin-usage.js';
import { registerAccountCostRoutes } from '../routes/account-cost.js';
import type { CostMonitoringService } from '../services/cost-monitoring.js';
import { registerProfileRoutes } from '../routes/profiles.js';
import { registerProfileSnapshotsRoutes } from '../routes/profile-snapshots.js';
import { registerBillingRoutes } from '../routes/billing.js';
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

export interface AppDeps {
  logger: Logger;
  authRepo: AccountAuthRepo;
  authCache: AuthCache | null;
  authCoalescer: AuthCoalescer | null;
  rateLimitStore: RateLimitStore;
  sessionsService: SessionsService;
  apiKeysService: ApiKeysService;
  usageService: UsageService;
  webhooksService: WebhooksService;
  webhooksAdminService: WebhooksAdminService;
  adminAuditService: AdminAuditService;
  accountsAdminService: AccountsAdminService;
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
   * Optional — when omitted, the trial-pack expiry email and any future
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
   * V-667.B — OAuth store. When provided, /v1/oauth/* + /v1/admin/oauth/*
   * routes register. When omitted, OAuth is not exposed (pre-launch
   * posture). Tests pass `new InMemoryOAuthStore()`; production wires
   * a Drizzle-backed implementation in V-667.C.
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
  /** V-082: billing service (Stripe checkout / portal / trial-pack). Optional. */
  billingService?: BillingService;
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
  /**
   * V-352b — public R2 bucket client used by avatar upload + the
   * presigned-GET URL surfaced on /v1/account/me. When omitted, the
   * avatar upload endpoint returns 503 FeatureUnavailable and the
   * read endpoint returns `avatar_url: null`. Tests usually omit it;
   * production wires the same client used by V-295c2 status snapshots.
   */
  r2Public?: R2 | null;
  /**
   * V-353b — MFA service. When omitted, /v1/account/mfa/* routes are
   * not registered. Tests that don't exercise MFA pass null. The
   * service holds the AES-256-GCM env-key encryption + TOTP verifier;
   * persistence is via DrizzleMfaRepo (or the in-memory fixture).
   */
  mfaService?: MfaService;
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
   * V-278.B follow-up — explicit allow-list of origins for production
   * CORS. Set via env `CORS_ALLOWED_ORIGINS=https://app.driftstack.dev,https://staging.driftstack.dev`.
   * When set + `permissiveCors=false`, the app accepts requests from
   * exactly these origins (in addition to the localhost regex pattern
   * for ad-hoc dev probing). Empty / undefined = localhost-only (dev).
   */
  corsAllowedOrigins?: string[];
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
   * V-667.C — OAuth-CLIENT routes (/v1/auth/oauth-client/*). When the
   * service is provided AND the config has at least one fully-
   * configured provider + signingSecret + callbackUrl, the 3 routes
   * register. Otherwise stays unregistered (same posture as livekit /
   * nowpayments).
   */
  oauthClientService?: OAuthClientService;
  oauthClient?: {
    signingSecret: string;
    callbackUrl: string;
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
    origin:
      deps.permissiveCors === true
        ? true
        : [/^https?:\/\/localhost(:\d+)?$/, ...(deps.corsAllowedOrigins ?? [])],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'authorization',
      'content-type',
      'x-request-id',
      'stripe-signature',
      'x-nowpayments-sig',
    ],
    exposedHeaders: [
      'x-request-id',
      // W199 — full RateLimit-header set documented at /docs/rate-limits.
      'x-ratelimit-bucket',
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
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

  await app.register(authPlugin, {
    authRepo: deps.authRepo,
    authCache: deps.authCache,
    authCoalescer: deps.authCoalescer,
    // V-353e — step-up gate consults MFA enrollment state; null when
    // MFA is disabled in this deploy (gate becomes a no-op).
    mfaService: deps.mfaService ?? null,
  });
  await app.register(rateLimitPlugin, { store: deps.rateLimitStore });

  registerErrorHandler(app);

  // V-666.BS — stamp Cache-Control: no-store, private on every
  // /v1/account/* response. These routes return caller-private
  // data (profile, audit log, costs, MFA enrollment, sessions,
  // rate-limit usage). Even though every request is auth-gated,
  // the explicit header is defense-in-depth: it prevents shared /
  // proxy caches from holding onto private payloads, and forbids
  // browser back/forward cache from serving stale state after a
  // logout. Mirrors the V-666.BE pattern on /v1/admin/crypto-orders.
  //
  // V-666.BT — same rationale broadened to every /v1/admin/* route.
  // Admin views are live operational state (account lookups, audit
  // log, webhook deliveries, sweep counts, idempotency metrics);
  // none of it should ever be cached. The crypto-orders route used
  // to register its own hook; folded in here so every admin
  // endpoint inherits the header uniformly.
  // V-666.BW — broadened again to cover /v1/billing/*. Billing
  // state, crypto checkouts, and crypto-order envelopes are all
  // caller-private dynamic state. Some routes already set the
  // header explicitly; the broader hook makes it the default so
  // a future endpoint can't accidentally omit it.
  app.addHook('onSend', (req, reply, _payload, done) => {
    if (
      req.url.startsWith('/v1/account/') ||
      req.url.startsWith('/v1/admin/') ||
      req.url.startsWith('/v1/billing/') ||
      req.url === '/v1/billing'
    ) {
      void reply.header('cache-control', 'no-store, private');
    }
    done();
  });

  registerSessionRoutes(app, { service: deps.sessionsService, authRepo: deps.authRepo });
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
  registerAdminSessionsRoutes(app, { sessionsService: deps.sessionsService });
  registerAdminApiKeysRoutes(app, { apiKeysService: deps.apiKeysService });
  registerAdminRateLimitOverridesRoutes(app, {
    rateLimitOverrides: deps.rateLimitOverridesService,
  });
  registerLegalRoutes(app, deps.legalService);
  registerEmailPreferencesRoutes(app, { emailPreferences: deps.emailPreferencesService });
  registerAccountAuditRoutes(app, { accountAudit: deps.accountAuditService });
  registerAdminValidationHarnessRoutes(app, { harness: deps.validationHarnessService });
  registerAccountRateLimitsRoutes(app);
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
    });
  }
  // V-176 — public-facing status endpoint. Reuses the readinessChecks
  // already supplied to /ready; no additional wiring needed at deps
  // level. /v1/status has no auth (public status pages are public).
  registerStatusRoutes(app, { readinessChecks: deps.readinessChecks ?? [] });
  if (deps.authFlowsService !== undefined) {
    registerAuthRoutes(app, {
      service: deps.authFlowsService,
      rateLimitStore: deps.rateLimitStore,
    });
    // V-355 — customer-facing web-session list + revoke. Lives next to
    // the auth flows since it shares the AuthFlowsService surface.
    registerAccountWebSessionsRoutes(app, { service: deps.authFlowsService });
  }
  // V-353b — customer-facing MFA enrollment + verify + disable +
  // recovery codes. Independent of authFlowsService — the routes are
  // bearer-auth-gated like everything else, no /v1/auth/* dependency.
  if (deps.mfaService !== undefined) {
    registerAccountMfaRoutes(app, { service: deps.mfaService });
  }
  if (deps.cliAuthorizeService !== undefined) {
    registerAuthCliRoutes(app, {
      cliAuthorizeService: deps.cliAuthorizeService,
      apiKeysService: deps.apiKeysService,
    });
  }
  if (deps.stripeWebhooksService !== undefined && deps.stripeWebhookSigningSecret !== undefined) {
    registerStripeWebhookRoutes(app, {
      service: deps.stripeWebhooksService,
      signingSecret: deps.stripeWebhookSigningSecret,
      logger: deps.logger,
    });
  }
  if (deps.nowpaymentsIpnSecret !== undefined && deps.nowpaymentsIpnSecret.length > 0) {
    registerNowpaymentsWebhookRoutes(app, {
      ipnSecret: deps.nowpaymentsIpnSecret,
      logger: deps.logger,
      ...(deps.cryptoOrdersService !== undefined
        ? { ordersService: deps.cryptoOrdersService }
        : {}),
    });
  }
  // V-531.B — LiveKit token-mint route. Gated on all 3 livekit fields
  // (apiKey + apiSecret + wsUrl); partial config = unregistered route.
  // Ownership check uses the sessions-service repo: the route is per-
  // session and the caller must own the session (cross-account → 404).
  if (deps.livekit !== undefined) {
    registerLivekitTokenRoute(app, {
      apiKey: deps.livekit.apiKey,
      apiSecret: deps.livekit.apiSecret,
      wsUrl: deps.livekit.wsUrl,
      isSessionOwned: async (accountId, sessionId) => {
        const row = await deps.sessionsService.findOwnedSessionLite(accountId, sessionId);
        return row !== null;
      },
    });
  }
  // V-667.C — OAuth-client routes. Gated on all 4: service wired +
  // signingSecret + callbackUrl + at least one provider configured.
  if (
    deps.oauthClientService !== undefined &&
    deps.oauthClient !== undefined &&
    (deps.oauthClient.google !== undefined || deps.oauthClient.github !== undefined)
  ) {
    const providers: Record<string, { clientId: string; clientSecret: string }> = {};
    if (deps.oauthClient.google) providers.google = deps.oauthClient.google;
    if (deps.oauthClient.github) providers.github = deps.oauthClient.github;
    registerOAuthClientRoutes(app, {
      service: deps.oauthClientService,
      providers: providers,
      callbackUrl: deps.oauthClient.callbackUrl,
      signingSecret: deps.oauthClient.signingSecret,
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
    registerCryptoCheckoutRoutes(app, { service: deps.cryptoOrdersService });
    registerCustomerCryptoOrdersRoutes(app, { service: deps.cryptoOrdersService });
    registerAdminCryptoOrdersRoutes(app, { service: deps.cryptoOrdersService });
  }
  registerCryptoQuoteRoutes(app);
  if (deps.oauthStore !== undefined) {
    registerOAuthRoutes(app, {
      service: new OAuthService(deps.oauthStore),
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
    registerProfileRoutes(app, { service: deps.profilesService, authRepo: deps.authRepo });
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
  // version (from package.json env), git sha (from GIT_SHA env at
  // deploy time, "unknown" otherwise), and process start time.
  // Public + unauthenticated so deploy automation + uptime probes can
  // confirm "what's running where" without needing a key. Lives at
  // /version (not /v1/*) because it has no auth — /v1/* routes are
  // contractually authed per the OpenAPI security check.
  const startedAt = new Date().toISOString();
  const buildVersion = process.env.npm_package_version ?? '0.0.0';
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
          return {
            name: c.name,
            ok: false,
            latency_ms: Date.now() - start,
            error: err instanceof Error ? err.message : 'unknown',
          };
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
