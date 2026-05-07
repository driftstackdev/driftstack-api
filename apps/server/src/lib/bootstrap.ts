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
import { DrizzleStripeWebhooksRepo } from '../db/stripe-webhooks-repo.js';
import { DrizzleProfilesRepo } from '../db/profiles-repo.js';
import { SessionsService } from '../services/sessions.js';
import { ApiKeysService } from '../services/api-keys.js';
import { UsageService } from '../services/usage.js';
import { WebhooksService, WebhooksAdminService } from '../services/webhooks.js';
import { AdminAuditService } from '../services/admin-audit.js';
import { AccountsAdminService } from '../services/admin-accounts.js';
import { IncidentsService } from '../services/incidents.js';
import { DrizzleIncidentsRepo } from '../db/incidents-repo.js';
import { FetchProber, HealthProbeService } from '../services/health-probe.js';
import { DrizzleProbesRepo } from '../db/health-probes-repo.js';
import { StatusSnapshotService } from '../services/status-snapshot.js';
import { RateLimitOverridesService } from '../services/rate-limit-overrides.js';
import { LegalService } from '../services/legal.js';
import { AuthFlowsService } from '../services/auth-flows.js';
import { CliAuthorizeService } from '../services/cli-authorize.js';
import { StripeWebhooksService } from '../services/stripe-webhooks.js';
import { ProfilesService } from '../services/profiles.js';
import type { AccountTier } from '@driftstack/api-types';
import { BillingService, type BillingProvider } from '../services/billing.js';
import { StripeBillingProvider } from '../services/stripe-billing-provider.js';
import { StripeApiClient } from './stripe-api.js';
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

  // Driver — mock or real WebKit per config.
  const driver = createDriver(config);

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
      docsBaseUrl: 'https://driftstack.dev/docs',
      billingPortalUrl: config.stripe?.portalReturnUrl ?? 'https://app.driftstack.dev/billing',
      dashboardUrl: 'https://app.driftstack.dev',
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
  // V-295a — public-status incidents service.
  const incidentsRepo = new DrizzleIncidentsRepo(dbHandle);
  const incidentsService = new IncidentsService(incidentsRepo);

  // V-295b — health-probe poller. The default probe target is this
  // server's own /health endpoint via env-configured PUBLIC_API_BASE_URL
  // (Hetzner deploy sets this). When unset (local dev), we skip probing
  // — there's no useful target to probe from inside the same process.
  const publicApiBaseUrl = process.env.PUBLIC_API_BASE_URL;
  const probesRepo = new DrizzleProbesRepo(dbHandle);
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

  // V-079: user-facing auth flows.
  const authFlowsRepo = new DrizzleAuthFlowsRepo(dbHandle);
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
      defaultSuccessUrl: config.stripe.successUrl ?? 'https://app.driftstack.dev/billing/success',
      defaultCancelUrl: config.stripe.cancelUrl ?? 'https://app.driftstack.dev/billing/cancel',
      portalReturnUrl: config.stripe.portalReturnUrl ?? 'https://app.driftstack.dev/billing',
    });
    logger.info({ component: 'billing' }, 'BillingService wired with StripeBillingProvider');
  } else {
    logger.warn(
      { component: 'billing' },
      'BillingService NOT wired (STRIPE_SECRET_KEY + DRIFTSTACK_TIER_PRICE_IDS + STRIPE_TRIAL_PACK_PRICE_ID required); /v1/billing/* routes will not register',
    );
  }

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
    // V-100: admin force-actions take direct repo + driver access.
    // V-237: profilesRepo also feeds /v1/account/me.
    sessionRepo: sessionsRepo,
    apiKeysRepo,
    driver,
    profilesRepo,
    ...(config.stripe?.webhookSecret !== undefined
      ? {
          stripeWebhooksService,
          stripeWebhookSigningSecret: config.stripe.webhookSecret,
        }
      : {}),
    ...(billingService !== undefined ? { billingService } : {}),
    readinessChecks,
    permissiveCors: false,
    // V-117: pass through to buildApp so it installs the Sentry
    // error-capture + breadcrumb hooks. Both are no-ops when
    // sentry.isInitialized is false (i.e. SENTRY_DSN unset).
    sentry,
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
  logger.info(
    {
      component: 'bootstrap',
      sentry: sentry.isInitialized,
      r2: r2 !== null,
      email: email.isConfigured,
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
