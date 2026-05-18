// Production bootstrap.
//
// Constructs the full AppDeps graph from config + a logger, returning
// the deps + a teardown function for graceful shutdown. The shape is
// pure-factory: pass-in dependencies are not constructed lazily, and
// every external connection (Postgres pool, Redis client, R2 client,
// Sentry, Postmark) is opened here, so the SIGTERM handler can close
// them deterministically.
//
// Failure semantics:
//   - Postgres connection failure at boot → throw. The deploy
//     pipeline's /health probe will fail; orchestrator will not
//     promote.
//   - Redis connection failure at boot → throw (same reasoning;
//     auth-cache + rate-limit-store are load-bearing).
//   - R2 / Postmark / Sentry init failure at boot → log warn; the
//     service starts in degraded mode (those features no-op). These
//     are not on the request critical path.
//   - readinessChecks fire every /ready hit. /ready 503 on any
//     reachable-but-failing dep. Health checks are decoupled.

import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDb, type Database } from '../db/client.js';
import { DrizzleAccountAuthRepo } from '../db/auth-repo.js';
import { DrizzleSessionRepo } from '../db/sessions-repo.js';
import { DrizzleApiKeysRepo } from '../db/api-keys-repo.js';
import { DrizzleUsageRepo } from '../db/usage-repo.js';
import { DrizzleWebhooksRepo } from '../db/webhooks-repo.js';
import { DrizzleWebhookRotationReminderRepo } from '../db/webhook-rotation-reminder-repo.js';
import { DrizzleByokAnthropicRotationReminderRepo } from '../db/byok-anthropic-rotation-reminder-repo.js';
import { WebhookRotationReminderService } from '../services/webhook-rotation-reminder.js';
import { ByokAnthropicRotationReminderService } from '../services/byok-anthropic-rotation-reminder.js';
import { DrizzleAdminAuditLogRepo } from '../db/admin-audit-repo.js';
import { DrizzleAccountsAdminRepo } from '../db/admin-accounts-repo.js';
import { DrizzleEmailPreferencesRepo } from '../db/email-preferences-repo.js';
import { EmailPreferencesService } from '../services/email-preferences.js';
import { DrizzleAccountAuditRepo } from '../db/account-audit-repo.js';
import { AccountAuditService } from '../services/account-audit.js';
import { DrizzleAccountLifecycleRepo } from '../db/account-lifecycle-repo.js';
import { AccountLifecycleService } from '../services/account-lifecycle.js';
import { DrizzleScheduledJobsRepo } from '../db/scheduled-jobs-repo.js';
import { ScheduledJobsService } from '../services/scheduled-jobs.js';
import { DrizzleValidationSchedulesRepo } from '../db/validation-schedules-repo.js';
import {
  ValidationHarnessService,
  type ValidationHarnessRecaptureBridge,
} from '../services/validation-harness.js';
import { DrizzleRateLimitOverridesRepo } from '../db/rate-limit-overrides-repo.js';
import { DrizzleLegalRepo } from '../db/legal-repo.js';
import { DrizzleAuthFlowsRepo } from '../db/auth-flows-repo.js';
import { DrizzleOAuthLinksRepo, DrizzleOAuthPendingLinksRepo } from '../db/oauth-links-repo.js';
import { OAuthClientServiceImpl } from '../services/oauth-client-service.js';
import { DrizzleStripeWebhooksRepo } from '../db/stripe-webhooks-repo.js';
import { DrizzleProfilesRepo } from '../db/profiles-repo.js';
import { SessionsService } from '../services/sessions.js';
import { ApiKeysService } from '../services/api-keys.js';
import { MfaService } from '../services/mfa.js';
import { DrizzleMfaRepo } from '../db/mfa-repo.js';
import { BYOKAnthropicService } from '../services/byok-anthropic.js';
import { DrizzleBYOKAnthropicRepo } from '../db/byok-anthropic-repo.js';
import { SocksProxyBackend } from '../services/proxy-backends/socks5.js';
import { DrizzleRecipesRepo } from '../db/recipes-repo.js';
import { DrizzleAgentSessionsRepo } from '../db/agent-sessions-repo.js';
import { DrizzleAgentDecomposerUsageRecorder } from '../db/agent-decomposer-usage-recorder.js';
import { AgentRuntime } from '../services/agent-runtime.js';
import { StubAgentExecutor } from '../services/agent-executor.js';
import { ClaudeAgentDecomposer } from '../services/agent-decomposer-claude.js';
import { DeterministicAgentDecomposer } from '../services/agent-decomposer-deterministic.js';
import type { AgentDecomposer } from '../services/agent-decomposer.js';
import { InMemoryByokKeyCache } from '../services/byok-anthropic-key-cache.js';
import { RedisMfaChallengeStore } from '../services/mfa-challenge-store.js';
import { UsageService } from '../services/usage.js';
import { WebhooksService, WebhooksAdminService } from '../services/webhooks.js';
import { AdminAuditService } from '../services/admin-audit.js';
import { AccountsAdminService } from '../services/admin-accounts.js';
import { IncidentsService } from '../services/incidents.js';
import { DrizzleIncidentsRepo } from '../db/incidents-repo.js';
import { DrizzleIncidentUpdateNotificationsRepo } from '../db/incident-update-notifications-repo.js';
import { FetchProber, HealthProbeService } from '../services/health-probe.js';
import { DrizzleProbesRepo } from '../db/health-probes-repo.js';
import { StatusSnapshotService } from '../services/status-snapshot.js';
import { StatusSubscribersService } from '../services/status-subscribers.js';
import { DrizzleStatusSubscribersRepo } from '../db/status-subscribers-repo.js';
import { TeamMembersService } from '../services/team-members.js';
import { DrizzleTeamMembersRepo } from '../db/team-members-repo.js';
import { IncidentNotificationsService } from '../services/incident-notifications.js';
import { IncidentBroadcastService } from '../services/incident-broadcast.js';
import { IncidentEventBus } from '../services/incident-event-bus.js';
import { SlaReportingService } from '../services/sla-reporting.js';
import { RateLimitOverridesService } from '../services/rate-limit-overrides.js';
import { LegalService } from '../services/legal.js';
import { AuthFlowsService } from '../services/auth-flows.js';
import { CliAuthorizeService } from '../services/cli-authorize.js';
import { StripeWebhooksService } from '../services/stripe-webhooks.js';
import { ProfilesService } from '../services/profiles.js';
import { ProfileSnapshotsService } from '../services/profile-snapshots.js';
import { DrizzleProfileSnapshotsRepo } from '../db/profile-snapshots-repo.js';
import type { AccountTier } from '@driftstack/api-types';
import { BillingService, type BillingProvider } from '../services/billing.js';
import { CostMonitoringService } from '../services/cost-monitoring.js';
import { UsageAggregatorFromUsageRepo } from '../services/cost-aggregator.js';
import { DEFAULT_COST_RATES, DEFAULT_TIER_THRESHOLDS_DERIVED } from './cost-defaults.js';
import { StripeBillingProvider } from '../services/stripe-billing-provider.js';
import { StripeApiClient } from './stripe-api.js';
import { validateStripeKeyForLaunch } from './stripe-key-safety.js';
import { DrizzleBillingRepo } from '../db/billing-repo.js';
import { buildLegalCatalog } from '../services/legal-catalog.js';
import { RedisAuthCache } from '../services/auth-cache.js';
import { AuthCoalescer } from '../services/auth-coalescer.js';
import { RedisRateLimitStore } from '../lib/redis-rate-limit-store.js';
import { createDriver } from '../drivers/index.js';
import { createR2Client, createR2PublicClient, r2ReadinessCheck, type R2 } from './r2.js';
import { createEmailService, type EmailService } from '../services/email.js';
import { initSentry, type SentryClient } from './sentry.js';
import type { AppDeps, ReadinessCheck } from './app.js';
import type { Config } from './config.js';
import type { Logger } from './logger.js';

export interface BootstrapResult {
  deps: AppDeps;
  /** Live handles — exposed so SIGTERM can close them in order. */
  handles: {
    db: Database;
    redis: Redis;
    r2: R2 | null;
    email: EmailService;
    sentry: SentryClient;
  };
  /** Close everything in the right order; idempotent. */
  teardown: () => Promise<void>;
}

export async function createProductionDeps(
  config: Config,
  logger: Logger,
): Promise<BootstrapResult> {
  // Sentry first — so any later init exceptions surface there too.
  const sentry = initSentry({ config: config.sentry, logger });

  // Postgres pool. Fail-fast probe `SELECT 1` so a misconfigured
  // DATABASE_URL surfaces at boot, not on the first request.
  const dbHandle = createDb(config.databaseUrl, {
    ...(config.slowQueryLogThresholdMs !== undefined
      ? {
          slowQueryLog: {
            thresholdMs: config.slowQueryLogThresholdMs,
            logger,
          },
        }
      : {}),
  });
  await dbHandle.client`SELECT 1`;
  if (config.slowQueryLogThresholdMs !== undefined) {
    logger.info(
      {
        component: 'postgres',
        slowQueryLogThresholdMs: config.slowQueryLogThresholdMs,
      },
      'postgres connected (slow-query log enabled)',
    );
  } else {
    logger.info({ component: 'postgres' }, 'postgres connected');
  }

  // Redis (single client for both auth cache + rate limit store —
  // they share the same connection but use distinct key prefixes).
  // PING at boot for the same fail-fast posture as Postgres.
  const redis = new Redis(config.redisUrl, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
  });
  redis.on('error', (err) => {
    logger.warn(
      {
        component: 'redis',
        err: err instanceof Error ? { name: err.name, message: err.message } : { value: err },
      },
      'redis connection error',
    );
  });
  await redis.ping();
  logger.info({ component: 'redis' }, 'redis connected');

  // R2 — optional. Null if env not configured (logged below).
  const r2 = config.r2 !== null ? createR2Client(config.r2) : null;
  if (r2 === null) {
    logger.warn(
      { component: 'r2' },
      'R2 not configured — recordings durability + presigned URLs disabled. Set R2_* env vars to enable.',
    );
  } else {
    logger.info({ component: 'r2', bucket: r2.bucket }, 'R2 client initialized');
  }

  // Postmark email — optional. No-op if not configured.
  const email = createEmailService({ config: config.postmark, logger });

  // Repos — Drizzle-backed.
  const authRepo = new DrizzleAccountAuthRepo(dbHandle);
  const sessionsRepo = new DrizzleSessionRepo(dbHandle);
  const apiKeysRepo = new DrizzleApiKeysRepo(dbHandle);
  const usageRepo = new DrizzleUsageRepo(dbHandle);
  const webhooksRepo = new DrizzleWebhooksRepo(dbHandle);
  const adminAuditRepo = new DrizzleAdminAuditLogRepo(dbHandle);
  const accountsAdminRepo = new DrizzleAccountsAdminRepo(dbHandle);
  const rateLimitOverridesRepo = new DrizzleRateLimitOverridesRepo(dbHandle);
  const legalRepo = new DrizzleLegalRepo(dbHandle);
  const emailPreferencesRepo = new DrizzleEmailPreferencesRepo(dbHandle);
  const accountAuditRepo = new DrizzleAccountAuditRepo(dbHandle);
  const validationSchedulesRepo = new DrizzleValidationSchedulesRepo(dbHandle);
  const accountLifecycleRepo = new DrizzleAccountLifecycleRepo(dbHandle);
  const scheduledJobsRepo = new DrizzleScheduledJobsRepo(dbHandle);

  // Auth cache + coalescer.
  const authCache = new RedisAuthCache(redis, logger);
  const authCoalescer = new AuthCoalescer();

  // Rate limit store.
  const rateLimitStore = new RedisRateLimitStore(redis);

  // Driver — mock or real WebKit per config. The Playwright dev
  // driver is dynamically imported, so this is async.
  const driver = await createDriver(config);

  // V-216 — customer-facing audit log; constructed early so all
  // emit-on-event services downstream (webhooks, sessions, api-keys,
  // profiles) can wire it.
  const accountAuditService = new AccountAuditService(accountAuditRepo);

  // V-204 — email notification preferences. Constructed early because
  // V-202c lifecycle service consumes it for opt-out checks.
  const emailPreferencesService = new EmailPreferencesService(emailPreferencesRepo);

  // V-202c / V-202b — account lifecycle dispatcher (paired audit emit +
  // email send for events that have both surfaces). Wires
  // `session.failed.first`, `subscription.tier_changed`,
  // `subscription.trial_pack_purchased`. V-202b moved the V-226
  // tier-change audit emit from StripeWebhooksService into
  // lifecycle.handleTierChanged so the audit + email pair lives behind
  // one call (founder verdict 2026-05-05).
  const accountLifecycleService = new AccountLifecycleService(
    accountLifecycleRepo,
    email,
    emailPreferencesService,
    logger,
    {
      // V-057.E — both URLs derive from config so dev / staging /
      // production all get the right host without per-env literals
      // here. Same single-source-of-truth as the auth-flow URLs
      // (V-079.B): set DASHBOARD_ORIGIN once per env.
      docsBaseUrl: 'https://driftstack.dev/docs',
      billingPortalUrl: config.stripe?.portalReturnUrl ?? `${config.dashboardOrigin}/billing`,
      dashboardUrl: config.dashboardOrigin,
    },
    accountAuditService, // V-202b — required for tier_changed audit emit
  );

  // V-202d — generic scheduled-jobs dispatcher. Currently registers
  // one handler (`trial_pack.expired`) that delegates to the lifecycle
  // service. Future cron-shaped jobs reuse this service with new
  // `register(jobType, handler)` calls.
  // workerId composition: `<process-pid>@<host>` is sufficient here —
  // production runs single-replica today; multi-replica safety still
  // works because the SELECT FOR UPDATE SKIP LOCKED query in the repo
  // is what guarantees mutual exclusion, not the workerId.
  const scheduledJobsService = new ScheduledJobsService(scheduledJobsRepo, logger, {
    workerId: `pid-${process.pid.toString()}`,
  });
  scheduledJobsService.register('trial_pack.expired', async (job) => {
    if (job.accountId === null) return; // mis-enqueued; skip
    await accountLifecycleService.emit(job.accountId, {
      kind: 'subscription.trial_pack_expired',
    });
  });

  // Webhooks first so sessions + api-keys can wire it.
  // V-225 — accountAudit wired for webhook_endpoint.{created,deleted}.
  const webhooksService = new WebhooksService(webhooksRepo, accountAuditService);
  const webhooksAdminService = new WebhooksAdminService(webhooksRepo);

  // Sessions, api-keys, usage.
  const sessionsService = new SessionsService({
    repo: sessionsRepo,
    driver,
    webhooks: webhooksService,
    accountAudit: accountAuditService,
    accountLifecycle: accountLifecycleService,
  });
  const usageService = new UsageService(usageRepo);

  // Admin services.
  const adminAuditService = new AdminAuditService(adminAuditRepo);
  const accountsAdminService = new AccountsAdminService(accountsAdminRepo, authCache);
  const rateLimitOverridesService = new RateLimitOverridesService(
    rateLimitOverridesRepo,
    authCache,
  );
  // V-295c3 — public status-page email subscribers service. Always
  // active; emails no-op when Postmark is unconfigured (createEmailService
  // returns a stub that swallows sends). The status-page base URL is the
  // origin the subscribe-confirmation + unsubscribe emails embed; falls
  // back to https://status.driftstack.dev when env-unset.
  const statusPageBaseUrl = process.env.PUBLIC_STATUS_PAGE_URL ?? 'https://status.driftstack.dev';
  const statusSubscribersRepo = new DrizzleStatusSubscribersRepo(dbHandle);
  const statusSubscribersService = new StatusSubscribersService(statusSubscribersRepo, email, {
    statusPageBaseUrl,
  });

  // V-298b/c — Team RBAC v1 service. Routes wired in app.ts. The auth
  // path itself does NOT yet honor team membership (V-298d) — invites
  // can be sent + accepted, but membership grants no implicit
  // permissions on the owner's resources until V-298d.
  // V-057.E — sourced from `config.dashboardOrigin`, which is driven
  // by `DASHBOARD_ORIGIN` and prod-guarded against localhost. The
  // legacy `PUBLIC_DASHBOARD_URL` env var was redundant once
  // `DASHBOARD_ORIGIN` became the single source of truth and is no
  // longer read here.
  const dashboardBaseUrl = config.dashboardOrigin;
  const teamMembersRepo = new DrizzleTeamMembersRepo(dbHandle);
  const teamMembersService = new TeamMembersService(
    teamMembersRepo,
    email,
    { dashboardBaseUrl },
    accountAuditService,
    authCache,
  );

  // V-295c3-followup — incident-notification fan-out. Wired into the
  // IncidentsService lifecycle below so admin-posted AND auto-created
  // public incidents both fan out emails to confirmed subscribers.
  // V-545.B Phase 2 — throttle repo passed so notifyUpdated enforces
  // the 1-per-subscriber-per-incident-per-hour cap on per-update
  // emails.
  const incidentUpdateNotificationsRepo = new DrizzleIncidentUpdateNotificationsRepo(dbHandle);
  const incidentNotifications = new IncidentNotificationsService(
    statusSubscribersService,
    email,
    logger,
    { statusPageBaseUrl },
    incidentUpdateNotificationsRepo,
  );

  // V-295d — outbound incident broadcasts (Slack incoming-webhook +
  // generic JSON envelope for Twitter/Discord/N8N relays). Both env
  // vars optional: when unset, that channel is silently skipped.
  const incidentBroadcast = new IncidentBroadcastService(
    {
      slackWebhookUrl: process.env.BROADCAST_SLACK_WEBHOOK_URL ?? null,
      genericWebhookUrl: process.env.BROADCAST_GENERIC_WEBHOOK_URL ?? null,
      statusPageBaseUrl,
    },
    logger,
  );

  // V-295e — incident event bus (in-process pub/sub for SSE clients).
  // SlaReportingService constructed below once probesRepo exists.
  const incidentEventBus = new IncidentEventBus();

  // V-295a — public-status incidents service. Lifecycle dispatches both
  // email fan-out AND outbound broadcasts in parallel; one failing
  // doesn't stall the other.
  const incidentsRepo = new DrizzleIncidentsRepo(dbHandle);
  const incidentsService = new IncidentsService(incidentsRepo, {
    onPublicCreated: async (incident, update) => {
      // V-295e — bus emit is sync + in-process; doesn't need awaiting.
      incidentEventBus.publishCreated(incident, update);
      await Promise.all([
        incidentNotifications.notifyCreated(incident, update),
        incidentBroadcast.notifyCreated(incident, update),
      ]);
    },
    onPublicResolved: async (incident, update) => {
      incidentEventBus.publishResolved(incident, update);
      await Promise.all([
        incidentNotifications.notifyResolved(incident, update),
        incidentBroadcast.notifyResolved(incident, update),
      ]);
    },
    // V-545.B Phase 2 — per-update fan-out. notifyUpdated enforces
    // the throttle internally so a long-running incident can't spam
    // subscribers. Broadcast surface unchanged (Slack/generic webhooks
    // don't have the per-recipient throttle semantics email does).
    onPublicUpdated: async (incident, update) => {
      await incidentNotifications.notifyUpdated(incident, update);
    },
  });

  // V-295b — health-probe poller. The default probe target is this
  // server's own /health endpoint via env-configured PUBLIC_API_BASE_URL
  // (Hetzner deploy sets this). When unset (local dev), we skip probing
  // — there's no useful target to probe from inside the same process.
  const publicApiBaseUrl = process.env.PUBLIC_API_BASE_URL;
  const probesRepo = new DrizzleProbesRepo(dbHandle);
  const slaReportingService = new SlaReportingService(probesRepo);
  const healthProbeService = publicApiBaseUrl
    ? new HealthProbeService(probesRepo, incidentsService, new FetchProber(), logger, {
        targets: [
          {
            id: 'api',
            label: 'API server',
            url: `${publicApiBaseUrl.replace(/\/+$/, '')}/health`,
          },
        ],
      })
    : null;

  // V-295c2 — public status snapshot writer. Writes the same data the
  // public /v1/status/incidents endpoint surfaces to a SEPARATE
  // public-readable R2 bucket so the status site can fall back to the
  // snapshot when the live API fetch fails. The recordings bucket is
  // intentionally NOT used — recordings contain Customer Data and must
  // remain private. Active only when R2_BUCKET_PUBLIC is configured.
  const r2Public = config.r2 !== null ? createR2PublicClient(config.r2) : null;
  if (config.r2 !== null && r2Public === null) {
    logger.warn(
      { component: 'r2-public' },
      'R2_BUCKET_PUBLIC not set — status-snapshot writer disabled. ' +
        'Status page will fail open when API is unreachable. ' +
        'Set R2_BUCKET_PUBLIC + a public custom domain to enable V-295c2 fallback.',
    );
  }
  const statusSnapshotService = r2Public
    ? new StatusSnapshotService(incidentsService, r2Public, logger)
    : null;

  // Legal catalog — reads docs/legal/*.md from the runtime image.
  // V-051 Dockerfile copies these into the image at build time.
  const legalCatalog = buildLegalCatalog({ repoRoot: resolve(process.cwd()) });
  const legalService = new LegalService(legalCatalog, legalRepo);

  // V-218 — continuous validation harness.
  // The recapture bridge is a stub until Agent 1's V-203 Phase 2A
  // vendor probes land. Until then, dispatched runs return synthetic
  // run ids and don't execute actual probe traffic. The schedule +
  // ledger logic is real; only the validation execution is mocked.
  const recaptureBridge: ValidationHarnessRecaptureBridge = {
    triggerRecapture: () => Promise.resolve({ id: `run_${randomUUID()}` }),
  };
  const validationHarnessService = new ValidationHarnessService(
    validationSchedulesRepo,
    recaptureBridge,
    { iosVersion: '18.7', safariVersion: '26.4' },
  );

  // ApiKeysService needs legalService (V-049 issuance gate).
  // V-216: also wires accountAuditService for customer-facing audit emit.
  const apiKeysService = new ApiKeysService(
    apiKeysRepo,
    authCache,
    webhooksService,
    legalService,
    accountAuditService,
  );

  // V-353b — MFA service. Active only when MFA_ENCRYPTION_KEY is
  // configured (32 random bytes, base64-encoded). When unset, the
  // /v1/account/mfa/* routes simply don't register and customers
  // can't enroll. Generate the key with:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  // and set as MFA_ENCRYPTION_KEY in deploy env.
  const mfaService = config.mfaEncryptionKey
    ? new MfaService(
        new DrizzleMfaRepo(dbHandle),
        { encryptionKey: config.mfaEncryptionKey },
        accountAuditService,
      )
    : null;
  if (!mfaService) {
    logger.warn(
      { component: 'mfa' },
      'MFA_ENCRYPTION_KEY not set — /v1/account/mfa/* routes disabled. ' +
        "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\" " +
        'and set in deploy env to enable customer MFA enrollment.',
    );
  }
  // AI-CHAT BYOK Anthropic — per-customer key storage. Activation-
  // gated on MFA_ENCRYPTION_KEY (same env var; Q1 verdict 2026-05-17
  // reuses the MFA key for operational simplicity). When absent, the
  // /v1/account/me/byok-anthropic-key* routes register their 503
  // disabled stubs via the activation-gate pattern.
  const byokAnthropicService = config.mfaEncryptionKey
    ? new BYOKAnthropicService(new DrizzleBYOKAnthropicRepo(dbHandle), {
        encryptionKey: config.mfaEncryptionKey,
      })
    : null;

  // EG-API-1.6 — SocksProxyBackend is pure config-to-env-var with
  // no external deps; instantiate eagerly so the route surface
  // activates from process start. The backend itself accepts
  // SOCKS5 + rejects OpenVPN/WireGuard with a typed error.
  const sessionEgressService = new SocksProxyBackend();

  // AI-B4 — recipes repo (write-only at v1.0). Backed by Postgres
  // via migration 0044. Now activates because Q.1 wires
  // agentSessionsRepo below.
  const recipesRepo = new DrizzleRecipesRepo(dbHandle);

  // Q.1 AI-B1.b — agent-runtime composition. All 6 design questions
  // verdicted by orchestrator 2026-05-17; this wire implements:
  //
  //   Q.1.a — Keying: option 4. Claude wires when EITHER
  //           `BYOK_ANTHROPIC_FALLBACK_KEY` OR `byokAnthropicService`
  //           can resolve a key. Open-answer: explicit operator
  //           override env `DRIFTSTACK_AGENT_DECOMPOSER_FORCE=deterministic`
  //           forces the deterministic path regardless of key state
  //           (escape hatch for staging tests + prod incidents).
  //
  //   Q.1.b — Runtime fallthrough is wired in agent-runtime.ts; the
  //           bootstrap just picks the decomposer impl.
  //
  //   Q.1.d — Deployment-fallback is HARD 502 in prod (force BYOK
  //           per Tier-3 verdict 2026-05-16). Staging opt-in via
  //           `DRIFTSTACK_AGENT_DECOMPOSER_USE_FALLBACK=true`.
  //
  // The DeterministicAgentDecomposer remains the safe-default when
  // neither key path is available — agent-sessions routes still
  // return planned/clarified output rather than 503ing the customer.
  const agentSessionsRepo = new DrizzleAgentSessionsRepo(dbHandle);
  const agentExecutor = new StubAgentExecutor();
  const agentDecomposer = selectAgentDecomposer(config, logger);
  const agentDecomposerKind: 'claude' | 'deterministic' =
    agentDecomposer instanceof ClaudeAgentDecomposer ? 'claude' : 'deterministic';
  // v2-#4 Q.1.e — record one usage_records row per decompose() call.
  // Wired unconditionally; even the deterministic decomposer fires
  // it (with zero costs) so the audit trail is uniform.
  // v2-#5 Q.1.f — same recorder also emits the operator-only
  // `agent.decompose.{claude,deterministic}` audit event per turn.
  const agentDecomposerUsageRecorder = new DrizzleAgentDecomposerUsageRecorder(
    dbHandle,
    logger,
    accountAuditService,
  );
  const agentRuntime = new AgentRuntime({
    decomposer: agentDecomposer,
    executor: agentExecutor,
    sessions: agentSessionsRepo,
    archetype: 'iphone16pro_ios18_7_safari26_4',
    usageRecorder: agentDecomposerUsageRecorder,
  });
  // Q.1.c — per-session BYOK key cache. Pure in-memory; wired
  // unconditionally so the route can stash decrypted plaintexts
  // on session-create when byokAnthropicService is also wired.
  const byokKeyCache = new InMemoryByokKeyCache();

  // V-079: user-facing auth flows.
  const authFlowsRepo = new DrizzleAuthFlowsRepo(dbHandle);
  // V-353d — Redis-backed challenge-token store for the MFA login
  // hand-off. Always wired (lightweight); gated by MFA being
  // enrolled per-account in login(). Five-minute TTL; single-use.
  const mfaChallengeStore = new RedisMfaChallengeStore(redis);
  const authFlowsService = new AuthFlowsService(
    authFlowsRepo,
    email,
    logger,
    {
      verifyEmailUrl: config.authFlowUrls.verifyEmail,
      magicLinkUrl: config.authFlowUrls.magicLink,
      passwordResetUrl: config.authFlowUrls.passwordReset,
      exposeDebugToken: config.authFlowUrls.exposeDebugToken,
    },
    authCache, // V-168 — cache invalidation on logout
    accountAuditService, // V-224 — emit account.{email_verified,login,logout,password_changed}
    mfaService, // V-353d — branch login() on enrollment status
    mfaChallengeStore, // V-353d — short-lived challenge store
  );

  // V-266: browser-OAuth-style CLI / GUI activation flow. Pure
  // Redis state — no schema migration needed. Always wired (no
  // configuration gate); the dashboard-side handler is what gates
  // actual binding.
  const cliAuthorizeService = new CliAuthorizeService({
    redis,
    dashboardOrigin: config.dashboardOrigin,
  });

  // V-080: inbound Stripe webhook handler. Optional — only wired when
  // STRIPE_WEBHOOK_SECRET is configured. When absent, /v1/webhooks/stripe
  // is not registered and inbound deliveries 404 (Stripe will retry, but
  // that's a deploy misconfig signal, not a normal state).
  const stripeWebhooksRepo = new DrizzleStripeWebhooksRepo(dbHandle);
  // V-089: invert the tierPrices config to drive subscription event
  // tier resolution. Each (monthly | annual) price id maps back to the
  // same tier; the webhook handler uses this to determine which tier
  // to set on the account when a subscription created/updated event
  // arrives.
  const priceToTier: Record<string, AccountTier> = {};
  if (config.stripe?.tierPrices !== undefined) {
    for (const [tier, prices] of Object.entries(config.stripe.tierPrices) as Array<
      [AccountTier, { monthly: string; annual: string }]
    >) {
      priceToTier[prices.monthly] = tier;
      priceToTier[prices.annual] = tier;
    }
  }
  const stripeWebhooksService = new StripeWebhooksService(
    stripeWebhooksRepo,
    {
      logger,
      priceToTier,
    },
    accountLifecycleService, // V-202b — fans out tier_changed audit + email at one call site
    scheduledJobsService, // V-202d — enqueues trial_pack.expired job at trial-pack purchase
  );

  // V-081: Profiles service.
  // V-225 — accountAudit wired for profile.{created,deleted}.
  const profilesRepo = new DrizzleProfilesRepo(dbHandle);
  const profilesService = new ProfilesService(profilesRepo, accountAuditService);
  // V-312 — profile snapshots service shares the profiles repo for
  // tier-cap + name-conflict enforcement on restore.
  const profileSnapshotsService = new ProfileSnapshotsService(
    new DrizzleProfileSnapshotsRepo(dbHandle),
    profilesRepo,
    accountAuditService,
  );

  // Q.2 — fail-fast safety: refuse to boot if STRIPE_SECRET_KEY is
  // sk_live_ before the BV KvK launch cutover (2026-05-21). Catches
  // an accidental live-key-before-entity-in-place misconfiguration
  // BEFORE any routes register or any HTTP traffic starts.
  const stripeKeySafety = validateStripeKeyForLaunch({
    secretKey: config.stripe?.secretKey,
  });
  if (!stripeKeySafety.ok) {
    throw new Error(stripeKeySafety.reason);
  }

  // V-082 + V-088: Billing service. Activates only when all three of
  // STRIPE_SECRET_KEY + DRIFTSTACK_TIER_PRICE_IDS + STRIPE_TRIAL_PACK_PRICE_ID
  // are configured (the StripeBillingProvider needs the secret key
  // for API calls; tier + trial-pack price ids are needed to map
  // tier → Stripe Checkout price). When any is missing, billingService
  // is undefined and routes simply don't register.
  let billingService: BillingService | undefined;
  if (
    config.stripe?.secretKey !== undefined &&
    config.stripe.tierPrices !== undefined &&
    config.stripe.trialPackPriceId !== undefined
  ) {
    const stripeApi = new StripeApiClient({
      secretKey: config.stripe.secretKey,
      ...(config.stripe.apiVersion !== undefined ? { apiVersion: config.stripe.apiVersion } : {}),
      logger,
    });
    const billingProvider: BillingProvider = new StripeBillingProvider(stripeApi);
    const billingRepo = new DrizzleBillingRepo(dbHandle);
    billingService = new BillingService(billingRepo, billingProvider, {
      tierPrices: config.stripe.tierPrices,
      trialPackPriceId: config.stripe.trialPackPriceId,
      // V-057.E — derived from DASHBOARD_ORIGIN-driven config
      // instead of a per-env literal, same pattern as the email
      // URLs above. Explicit STRIPE_*_URL env vars still win.
      defaultSuccessUrl: config.stripe.successUrl ?? `${config.dashboardOrigin}/billing/success`,
      defaultCancelUrl: config.stripe.cancelUrl ?? `${config.dashboardOrigin}/billing/cancel`,
      portalReturnUrl: config.stripe.portalReturnUrl ?? `${config.dashboardOrigin}/billing`,
    });
    logger.info({ component: 'billing' }, 'BillingService wired with StripeBillingProvider');
  } else {
    logger.warn(
      { component: 'billing' },
      'BillingService NOT wired (STRIPE_SECRET_KEY + DRIFTSTACK_TIER_PRICE_IDS + STRIPE_TRIAL_PACK_PRICE_ID required); /v1/billing/* routes will not register',
    );
  }

  // V-541.G — CostMonitoringService wired against the production
  // defaults from `cost-defaults.ts`. The aggregator is a stub
  // returning null until V-541.H wires a real usage_records →
  // UsageInputs aggregator (this would join sessions, usage_records,
  // and Postmark / OpenAI cost lines). Until then, the admin and
  // customer cost routes register but always return "no usage in
  // cycle" — better than 404-routes-missing because the dashboard
  // can render an empty breakdown rather than a broken nav link.
  //
  // Tier resolution leans on the billing repo's getAccount → tier
  // field; this is the same source the existing billingService
  // uses, so the cost service can't drift away from the tier the
  // customer actually pays for.
  // V-541.H — real UsageAggregator over the V-073 usage_records
  // ledger. Fills `sessionMinutes` from real data; other dimensions
  // (storage, egress, email, llm) are zero placeholders until their
  // per-account meters land (V-541.I/J/K follow-ups).
  const costMonitoringService = new CostMonitoringService({
    aggregator: new UsageAggregatorFromUsageRepo({ repo: usageRepo }),
    rates: DEFAULT_COST_RATES,
    tierThresholds: DEFAULT_TIER_THRESHOLDS_DERIVED,
    resolveTier: async (accountId) => {
      const acc = await new DrizzleBillingRepo(dbHandle).getAccount(accountId);
      return acc?.tier ?? null;
    },
  });
  logger.info(
    { component: 'cost-monitoring' },
    'CostMonitoringService wired with DEFAULT_COST_RATES + DEFAULT_TIER_THRESHOLDS_DERIVED (real UsageAggregator over usage_records; storage/egress/email/llm dimensions zero until V-541.I/J/K land)',
  );

  // Readiness checks. Postgres + Redis are required; R2 only checked
  // if configured. Postmark + Sentry are never readiness-gated.
  const readinessChecks: ReadinessCheck[] = [
    {
      name: 'postgres',
      timeoutMs: 1500,
      fn: async () => {
        await dbHandle.client`SELECT 1`;
      },
    },
    {
      name: 'redis',
      timeoutMs: 1500,
      fn: async () => {
        await redis.ping();
      },
    },
  ];
  if (r2 !== null) {
    readinessChecks.push(r2ReadinessCheck(r2));
  }

  const deps: AppDeps = {
    logger,
    authRepo,
    authCache,
    authCoalescer,
    rateLimitStore,
    sessionsService,
    apiKeysService,
    usageService,
    webhooksService,
    webhooksAdminService,
    adminAuditService,
    accountsAdminService,
    incidentsService,
    statusSubscribersService,
    incidentEventBus,
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
    profilesService,
    profileSnapshotsService,
    // V-100: admin force-actions take direct repo + driver access.
    // V-237: profilesRepo also feeds /v1/account/me.
    sessionRepo: sessionsRepo,
    apiKeysRepo,
    driver,
    profilesRepo,
    // V-352b — public-bucket R2 client used by avatar upload + the
    // presigned-GET URL on /v1/account/me. Same client the V-295c2
    // status-snapshot writer uses; null when R2_BUCKET_PUBLIC isn't
    // configured (avatar endpoints fall back to 503 / null).
    r2Public,
    // V-353b — MFA service; null when MFA_ENCRYPTION_KEY isn't set
    // (avoids registering enrollment routes that would write to a
    // table we can't decrypt back from).
    ...(mfaService !== null ? { mfaService } : {}),
    // AI-CHAT BYOK Anthropic — per-customer key storage. Shares the
    // MFA_ENCRYPTION_KEY gate (one less env var to manage; Q1 verdict
    // 2026-05-17). When unset, app.ts registers 503 stubs.
    ...(byokAnthropicService !== null ? { byokAnthropicService } : {}),
    // EG-API-1.6 — concrete SocksProxyBackend for the Phase 1 SOCKS5
    // customer-egress path. Wired unconditionally: the backend is pure
    // config-to-env-var translation with no external deps, so it
    // activates as soon as the bootstrap mounts AppDeps. OpenVPN +
    // WireGuard are Phase 2/3 (rejected at the backend with a typed
    // error that the route layer maps to 503). When this wire lands,
    // the W247.A drift-sweep gate flips hasEgressImpl=true and the
    // marketing copy can update from "roadmap" to "live" per the
    // Path-1 autoflip plan (orchestrator handoff 2026-05-17).
    sessionEgressService,
    // AI-B4 — recipes repo. Wired unconditionally; now activates
    // because Q.1 wires agentSessionsRepo below.
    recipesRepo,
    // Q.1 — agent-runtime + agent-sessions repo wired unconditionally.
    // Decomposer selection (Claude vs deterministic) is per
    // `selectAgentDecomposer` below; runtime composition + sessions
    // repo are always wired so the /v1/agent-sessions/* routes
    // activate from process start.
    agentRuntime,
    agentSessionsRepo,
    byokKeyCache,
    agentDecomposerKind,
    // Q.1.d — staging opts in to consuming the deployment fallback
    // for unconfigured customers; prod (default false) hard-502s
    // ByokAnthropicRequired per the BYOK-for-v1.0 Tier-3 verdict.
    ...(config.byokAnthropic?.fallbackApiKey !== undefined
      ? { agentDecomposerFallbackKey: config.byokAnthropic.fallbackApiKey }
      : {}),
    agentDecomposerAllowFallback:
      config.agentDecomposer?.useFallbackForUnconfiguredCustomers ?? false,
    ...(config.stripe?.webhookSecret !== undefined
      ? {
          stripeWebhooksService,
          stripeWebhookSigningSecret: config.stripe.webhookSecret,
        }
      : {}),
    // V-666 / V-487 — NowPayments IPN secret. Without this, the
    // /v1/webhooks/nowpayments route stays unregistered (route file
    // header documents the wire-ready posture explicitly). app.ts
    // gates registration on a non-empty string so the empty-string
    // accident reads the same as "not configured".
    ...(config.nowpayments?.ipnSecret !== undefined && config.nowpayments.ipnSecret.length > 0
      ? { nowpaymentsIpnSecret: config.nowpayments.ipnSecret }
      : {}),
    // V-531.B — LiveKit token-mint surface. Same all-or-nothing
    // semantics as nowpayments: the route only registers when all
    // three fields are present. Partial config = unregistered route
    // = 404 = client falls back to HTTP polling. The route's
    // ownership check uses sessionsService.findOwnedSessionLite (no
    // driver side-effects).
    ...(config.livekit?.apiKey !== undefined &&
    config.livekit?.apiSecret !== undefined &&
    config.livekit?.wsUrl !== undefined
      ? {
          livekit: {
            apiKey: config.livekit.apiKey,
            apiSecret: config.livekit.apiSecret,
            wsUrl: config.livekit.wsUrl,
          },
        }
      : {}),
    // V-667.C — OAuth-client service + provider config. The route
    // registration gate is at app.ts; we wire the service whenever
    // signingSecret + callbackUrl + ≥1 provider are present. Pending-
    // mailer is a thin wrapper around the existing email service;
    // accounts lookup wraps authFlowsRepo.findAccountByEmail + a
    // simple createAccount call (passwordHash=null since IDP signup
    // doesn't set a password).
    ...(config.oauthClient !== undefined &&
    config.oauthClient.signingSecret !== undefined &&
    config.oauthClient.callbackUrlBase !== undefined &&
    (config.oauthClient.google !== undefined || config.oauthClient.github !== undefined)
      ? (() => {
          // V-667.C-followup — extract the links repo so it's also
          // passed as `oauthLinksRepo` for the customer-facing
          // /v1/account/me/oauth-links read endpoint. Same instance
          // both sides → no risk of read/write divergence.
          const oauthLinksRepo = new DrizzleOAuthLinksRepo(dbHandle);
          return {
            oauthLinksRepo,
            oauthClient: {
              signingSecret: config.oauthClient.signingSecret,
              callbackUrlBase: config.oauthClient.callbackUrlBase,
              dashboardOrigin: config.dashboardOrigin,
              ...(config.oauthClient.google !== undefined
                ? { google: config.oauthClient.google }
                : {}),
              ...(config.oauthClient.github !== undefined
                ? { github: config.oauthClient.github }
                : {}),
            },
            oauthClientService: new OAuthClientServiceImpl({
              links: oauthLinksRepo,
              pending: new DrizzleOAuthPendingLinksRepo(dbHandle),
              accounts: {
                findIdByEmail: async (e) => {
                  const row = await authFlowsRepo.findAccountByEmail(e);
                  return row ? row.id : null;
                },
                createFromIdp: async (args) => {
                  // IDP-asserted email is verified per Verdict 1 trust
                  // contract; mark emailVerifiedAt at creation time
                  // separately (createAccount doesn't set it). Tier
                  // defaults to 'free' — matches password signup.
                  const row = await authFlowsRepo.createAccount({
                    email: args.email,
                    name: args.name,
                    passwordHash: '', // sentinel — column is nullable,
                    // route layer treats empty hash as "no password set";
                    // user adds a password via /account/security later.
                    initialTier: 'trial_pack',
                  });
                  await authFlowsRepo.markEmailVerified(row.id, new Date());
                  return row.id;
                },
              },
              mailer: {
                // V-667.C — verify-merge email. Builds the confirm
                // link from the customer-facing dashboard origin so
                // the recipient lands on the dashboard's confirm-merge
                // page (which POSTs back to /v1/auth/oauth-client
                // /confirm-merge). DASHBOARD_ORIGIN strips its trailing
                // slash at schema-level, so template-literal `/...`
                // concatenation is safe.
                sendVerifyMergeEmail: async (args) => {
                  const confirmLink = `${config.dashboardOrigin}/auth/oauth-client/confirm-merge?token=${encodeURIComponent(args.plaintextToken)}`;
                  await email.sendOauthPendingLinkVerification({
                    to: args.to,
                    provider: args.provider,
                    confirmLink,
                    expiresAt: args.expiresAt,
                  });
                },
              },
            }),
          };
        })()
      : {}),
    ...(billingService !== undefined ? { billingService } : {}),
    costMonitoringService,
    readinessChecks,
    permissiveCors: false,
    corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    // V-117: pass through to buildApp so it installs the Sentry
    // error-capture + breadcrumb hooks. Both are no-ops when
    // sentry.isInitialized is false (i.e. SENTRY_DSN unset).
    sentry,
    // V-337 — driver name + playwright browser surface on /version
    // for client observability (GUI Connectivity test, ops tooling).
    driverName: config.driver,
    playwrightBrowser: config.playwrightBrowser,
  };

  // V-232 — background poller startup. Both processTick methods own
  // their own claim/dispatch/retry semantics; the bootstrap layer just
  // calls them on a 60s timer. 60s cadence is the V-173 webhook-worker
  // convention; trial-pack expiry and validation-harness scheduling
  // both have minute-level latency tolerance, so this matches.
  // Founder-approved cadence on V-202d ack (2026-05-06).
  //
  // Errors inside the tick are caught + logged warn-level by the
  // services themselves; the setInterval handler still wraps in a
  // try/catch as a defense-in-depth: an unexpected throw must NEVER
  // kill the interval, or background work silently stops.
  const POLLER_INTERVAL_MS = 60_000;
  const scheduledJobsTimer = setInterval(() => {
    void (async () => {
      try {
        await scheduledJobsService.processTick(new Date());
      } catch (err) {
        logger.warn(
          {
            component: 'scheduled-jobs-poller',
            err: err instanceof Error ? { name: err.name, message: err.message } : { value: err },
          },
          'scheduled-jobs processTick threw unexpectedly (interval continues)',
        );
      }
    })();
  }, POLLER_INTERVAL_MS);
  // Don't keep the event loop alive just for the poller — let the
  // app close cleanly on SIGINT without waiting on the next tick.
  scheduledJobsTimer.unref();

  const validationHarnessTimer = setInterval(() => {
    void (async () => {
      try {
        await validationHarnessService.processTick({ now: new Date() });
      } catch (err) {
        logger.warn(
          {
            component: 'validation-harness-poller',
            err: err instanceof Error ? { name: err.name, message: err.message } : { value: err },
          },
          'validation-harness processTick threw unexpectedly (interval continues)',
        );
      }
    })();
  }, POLLER_INTERVAL_MS);
  validationHarnessTimer.unref();

  // V-295b — health probe poller. Same 60s cadence; guarded by the
  // same try/catch so a one-tick failure never kills the interval.
  // Only runs in environments where PUBLIC_API_BASE_URL is set
  // (production via Hetzner deploy). Local dev = no-op.
  const healthProbeTimer = healthProbeService
    ? setInterval(() => {
        void (async () => {
          try {
            await healthProbeService.processTick(new Date());
          } catch (err) {
            logger.warn(
              {
                component: 'health-probe-poller',
                err:
                  err instanceof Error ? { name: err.name, message: err.message } : { value: err },
              },
              'health-probe processTick threw unexpectedly (interval continues)',
            );
          }
        })();
      }, POLLER_INTERVAL_MS)
    : null;
  healthProbeTimer?.unref();

  // V-295c2 — status snapshot poller. Same 60s cadence; independent
  // of the probe poller so a snapshot failure doesn't stall probe
  // ticks (and vice versa). Only runs when R2 is configured.
  const statusSnapshotTimer = statusSnapshotService
    ? setInterval(() => {
        void (async () => {
          try {
            await statusSnapshotService.processSnapshot(new Date());
          } catch (err) {
            logger.warn(
              {
                component: 'status-snapshot-poller',
                err:
                  err instanceof Error ? { name: err.name, message: err.message } : { value: err },
              },
              'status-snapshot processSnapshot threw unexpectedly (interval continues)',
            );
          }
        })();
      }, POLLER_INTERVAL_MS)
    : null;
  statusSnapshotTimer?.unref();

  // V-295c3-tombstone — daily status-subscriber email-purge poller.
  // Privacy §3.10 promises 90d post-unsubscribe email zero-out. Runs
  // every 24 hours; first tick fires 24h after boot (acceptable —
  // rows that just unsubscribed have 90 days before they're eligible
  // anyway). Audit-logs each purge as a system action (no admin actor)
  // — done via writes to admin_audit_log with the special
  // 'status_subscriber.purged' action and adminAccountId set to null.
  // The audit-log repo accepts null adminAccountId for system actions.
  const STATUS_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const statusPurgeTimer = setInterval(() => {
    void (async () => {
      try {
        const result = await statusSubscribersService.processPurge(new Date());
        if (result.purged.length > 0) {
          logger.info(
            { component: 'status-subscriber-purge', count: result.purged.length },
            'purged status-subscriber emails (90d post-unsubscribe)',
          );
        }
      } catch (err) {
        logger.warn(
          {
            component: 'status-subscriber-purge',
            err: err instanceof Error ? { name: err.name, message: err.message } : { value: err },
          },
          'status-subscriber-purge threw unexpectedly (interval continues)',
        );
      }
    })();
  }, STATUS_PURGE_INTERVAL_MS);
  statusPurgeTimer.unref();

  // v2-#17 — daily rotation-reminder sweeps for webhook signing secrets
  // (v2-#10/#10.5/#10.6) and BYOK Anthropic API keys (v2-#11/#11.5/#11.6).
  // Both reminder services are pure-sweep nags (no auto-rotation); the
  // services skip rows that don't need a reminder yet, so the per-tick
  // burst is bounded by perTickLimit (default 50). Default-on for
  // production; the operator can flip
  // DRIFTSTACK_DISABLE_KEY_ROTATION_REMINDERS=1 to suppress when a
  // customer-quiet account wants to silence the nag (e.g. canary
  // deployments). Daily cadence (24h) matches the V-295c3-tombstone
  // status-purge poller — no need for finer granularity since the
  // services' cooldown windows are days, not minutes.
  const ROTATION_REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const rotationRemindersDisabled = process.env.DRIFTSTACK_DISABLE_KEY_ROTATION_REMINDERS === '1';
  const webhookRotationReminderService = new WebhookRotationReminderService(
    new DrizzleWebhookRotationReminderRepo(dbHandle),
    email,
    logger,
  );
  const byokAnthropicRotationReminderService = new ByokAnthropicRotationReminderService(
    new DrizzleByokAnthropicRotationReminderRepo(dbHandle),
    email,
    logger,
  );
  const webhookRotationReminderTimer = rotationRemindersDisabled
    ? null
    : setInterval(() => {
        void (async () => {
          try {
            await webhookRotationReminderService.tickOnce(new Date());
          } catch (err) {
            logger.warn(
              {
                component: 'webhook-rotation-reminder-poller',
                err:
                  err instanceof Error ? { name: err.name, message: err.message } : { value: err },
              },
              'webhook-rotation-reminder tickOnce threw unexpectedly (interval continues)',
            );
          }
        })();
      }, ROTATION_REMINDER_INTERVAL_MS);
  webhookRotationReminderTimer?.unref();
  const byokAnthropicRotationReminderTimer = rotationRemindersDisabled
    ? null
    : setInterval(() => {
        void (async () => {
          try {
            await byokAnthropicRotationReminderService.tickOnce(new Date());
          } catch (err) {
            logger.warn(
              {
                component: 'byok-anthropic-rotation-reminder-poller',
                err:
                  err instanceof Error ? { name: err.name, message: err.message } : { value: err },
              },
              'byok-anthropic-rotation-reminder tickOnce threw unexpectedly (interval continues)',
            );
          }
        })();
      }, ROTATION_REMINDER_INTERVAL_MS);
  byokAnthropicRotationReminderTimer?.unref();

  // v2-#29 — daily stale-secret_prev cleanup. v2-#20's worker fix
  // already stops emitting the prev signature past the grace window;
  // this sweep is a data-hygiene follow-up that nulls the row columns
  // so a leaked DB snapshot can no longer surface the old plaintext.
  // Shares the same daily cadence + opt-out as the rotation reminders;
  // a deploy that wants no automatic mutations sets
  // DRIFTSTACK_DISABLE_KEY_ROTATION_REMINDERS=1.
  const webhookSecretPrevCleanupTimer = rotationRemindersDisabled
    ? null
    : setInterval(() => {
        void (async () => {
          try {
            const result = await webhooksRepo.clearStaleSecretPrev({ now: new Date() });
            if (result.cleared > 0) {
              logger.info(
                { component: 'webhook-secret-prev-cleanup', cleared: result.cleared },
                'webhook secret_prev cleanup nulled stale rows',
              );
            }
          } catch (err) {
            logger.warn(
              {
                component: 'webhook-secret-prev-cleanup',
                err:
                  err instanceof Error ? { name: err.name, message: err.message } : { value: err },
              },
              'webhook secret_prev cleanup threw unexpectedly (interval continues)',
            );
          }
        })();
      }, ROTATION_REMINDER_INTERVAL_MS);
  webhookSecretPrevCleanupTimer?.unref();
  if (rotationRemindersDisabled) {
    logger.warn(
      { component: 'rotation-reminders' },
      'DRIFTSTACK_DISABLE_KEY_ROTATION_REMINDERS=1 — webhook + BYOK Anthropic key rotation reminder sweeps disabled at boot',
    );
  }

  let torn = false;
  async function teardown(): Promise<void> {
    if (torn) return;
    torn = true;
    logger.info({ component: 'bootstrap' }, 'tearing down');
    // V-232 — stop pollers BEFORE other teardown so an in-flight tick
    // doesn't try to acquire a closing redis/db handle.
    clearInterval(scheduledJobsTimer);
    clearInterval(validationHarnessTimer);
    if (healthProbeTimer) clearInterval(healthProbeTimer);
    if (statusSnapshotTimer) clearInterval(statusSnapshotTimer);
    clearInterval(statusPurgeTimer);
    if (webhookRotationReminderTimer) clearInterval(webhookRotationReminderTimer);
    if (byokAnthropicRotationReminderTimer) clearInterval(byokAnthropicRotationReminderTimer);
    if (webhookSecretPrevCleanupTimer) clearInterval(webhookSecretPrevCleanupTimer);
    try {
      await sentry.flush(2000);
      await sentry.close(2000);
    } catch {
      /* swallow */
    }
    try {
      await redis.quit();
    } catch {
      /* swallow */
    }
    try {
      await dbHandle.close();
    } catch {
      /* swallow */
    }
    logger.info({ component: 'bootstrap' }, 'teardown complete');
  }

  // Log a one-line summary of the SDK init state at boot — easy
  // sanity check in production logs.
  // V-667.C — log which optional integrations registered at boot so
  // ops can confirm OAuth-client activation flipped on.
  const livekitActive =
    config.livekit?.apiKey !== undefined &&
    config.livekit?.apiSecret !== undefined &&
    config.livekit?.wsUrl !== undefined;
  const oauthClientActive =
    config.oauthClient !== undefined &&
    config.oauthClient.signingSecret !== undefined &&
    config.oauthClient.callbackUrlBase !== undefined &&
    (config.oauthClient.google !== undefined || config.oauthClient.github !== undefined);
  logger.info(
    {
      component: 'bootstrap',
      sentry: sentry.isInitialized,
      r2: r2 !== null,
      email: email.isConfigured,
      livekit: livekitActive,
      oauthClient: oauthClientActive,
      // v2-#27 — rotation-reminder activation state. ops uses this
      // line to confirm the v2-#17 daily sweeps are running in
      // production. `true` when neither timer was opt-out-disabled
      // via DRIFTSTACK_DISABLE_KEY_ROTATION_REMINDERS=1.
      rotationReminders: !rotationRemindersDisabled,
      driver: config.driver,
      env: config.nodeEnv,
    },
    'bootstrap complete',
  );

  return {
    deps,
    handles: { db: dbHandle, redis, r2, email, sentry },
    teardown,
  };
}

/**
 * Q.1 — agent-decomposer selection. Returns the impl bootstrap
 * should wire into AppDeps per the Q.1.a + Q.1.a-open-answer
 * verdicts (2026-05-17):
 *
 *   1. If `DRIFTSTACK_AGENT_DECOMPOSER_FORCE=deterministic` is set,
 *      return DeterministicAgentDecomposer regardless of key state.
 *      Operator escape hatch for staging tests + prod incidents.
 *
 *   2. Otherwise, if EITHER the deployment fallback key
 *      (`config.byokAnthropic.fallbackApiKey`) OR per-customer BYOK
 *      storage (`MFA_ENCRYPTION_KEY` set, byokAnthropicService
 *      wired) is configured, return ClaudeAgentDecomposer. The
 *      route layer's key-resolution chain decides per-turn which
 *      path actually serves the request.
 *
 *   3. Otherwise return DeterministicAgentDecomposer as the safe
 *      default — agent-sessions routes still return planned /
 *      clarified output rather than 503ing the customer.
 *
 * Logs the choice at info level so the operator can verify which
 * impl wired without grepping env vars.
 */
export function selectAgentDecomposer(config: Config, logger: Logger): AgentDecomposer {
  if (config.agentDecomposer?.forceImpl === 'deterministic') {
    logger.info(
      { component: 'agent-decomposer' },
      'agentDecomposer wired as DeterministicAgentDecomposer (forced via DRIFTSTACK_AGENT_DECOMPOSER_FORCE=deterministic)',
    );
    return new DeterministicAgentDecomposer();
  }
  const hasFallbackKey = config.byokAnthropic?.fallbackApiKey !== undefined;
  const hasCustomerKeyStorage = config.mfaEncryptionKey !== undefined;
  if (hasFallbackKey || hasCustomerKeyStorage) {
    logger.info(
      {
        component: 'agent-decomposer',
        keying: { hasFallbackKey, hasCustomerKeyStorage },
      },
      'agentDecomposer wired as ClaudeAgentDecomposer',
    );
    return new ClaudeAgentDecomposer();
  }
  logger.info(
    { component: 'agent-decomposer' },
    'agentDecomposer wired as DeterministicAgentDecomposer (no Anthropic key path configured)',
  );
  return new DeterministicAgentDecomposer();
}
