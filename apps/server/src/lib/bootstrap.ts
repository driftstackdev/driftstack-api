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
import { resolve } from 'node:path';
import { createDb, type Database } from '../db/client.js';
import { DrizzleAccountAuthRepo } from '../db/auth-repo.js';
import { DrizzleSessionRepo } from '../db/sessions-repo.js';
import { DrizzleApiKeysRepo } from '../db/api-keys-repo.js';
import { DrizzleUsageRepo } from '../db/usage-repo.js';
import { DrizzleWebhooksRepo } from '../db/webhooks-repo.js';
import { DrizzleAdminAuditLogRepo } from '../db/admin-audit-repo.js';
import { DrizzleAccountsAdminRepo } from '../db/admin-accounts-repo.js';
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
import { RateLimitOverridesService } from '../services/rate-limit-overrides.js';
import { LegalService } from '../services/legal.js';
import { AuthFlowsService } from '../services/auth-flows.js';
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
import { createR2Client, r2ReadinessCheck, type R2 } from './r2.js';
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

  // Auth cache + coalescer.
  const authCache = new RedisAuthCache(redis, logger);
  const authCoalescer = new AuthCoalescer();

  // Rate limit store.
  const rateLimitStore = new RedisRateLimitStore(redis);

  // Driver — mock or real WebKit per config.
  const driver = createDriver(config);

  // Webhooks first so sessions + api-keys can wire it.
  const webhooksService = new WebhooksService(webhooksRepo);
  const webhooksAdminService = new WebhooksAdminService(webhooksRepo);

  // Sessions, api-keys, usage.
  const sessionsService = new SessionsService({
    repo: sessionsRepo,
    driver,
    webhooks: webhooksService,
  });
  const usageService = new UsageService(usageRepo);

  // Admin services.
  const adminAuditService = new AdminAuditService(adminAuditRepo);
  const accountsAdminService = new AccountsAdminService(accountsAdminRepo, authCache);
  const rateLimitOverridesService = new RateLimitOverridesService(
    rateLimitOverridesRepo,
    authCache,
  );

  // Legal catalog — reads docs/legal/*.md from the runtime image.
  // V-051 Dockerfile copies these into the image at build time.
  const legalCatalog = buildLegalCatalog({ repoRoot: resolve(process.cwd()) });
  const legalService = new LegalService(legalCatalog, legalRepo);

  // ApiKeysService needs legalService (V-049 issuance gate).
  const apiKeysService = new ApiKeysService(apiKeysRepo, authCache, webhooksService, legalService);

  // V-079: user-facing auth flows.
  const authFlowsRepo = new DrizzleAuthFlowsRepo(dbHandle);
  const authFlowsService = new AuthFlowsService(authFlowsRepo, email, logger, {
    verifyEmailUrl: config.authFlowUrls.verifyEmail,
    magicLinkUrl: config.authFlowUrls.magicLink,
    passwordResetUrl: config.authFlowUrls.passwordReset,
    exposeDebugToken: config.authFlowUrls.exposeDebugToken,
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
  const stripeWebhooksService = new StripeWebhooksService(stripeWebhooksRepo, {
    logger,
    priceToTier,
  });

  // V-081: Profiles service.
  const profilesRepo = new DrizzleProfilesRepo(dbHandle);
  const profilesService = new ProfilesService(profilesRepo);

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
    rateLimitOverridesService,
    legalService,
    authFlowsService,
    profilesService,
    // V-100: admin force-actions take direct repo + driver access.
    sessionRepo: sessionsRepo,
    apiKeysRepo,
    driver,
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

  let torn = false;
  async function teardown(): Promise<void> {
    if (torn) return;
    torn = true;
    logger.info({ component: 'bootstrap' }, 'tearing down');
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
