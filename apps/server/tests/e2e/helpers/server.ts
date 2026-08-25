// Boots a real Fastify app for e2e tests, wired against real Postgres + Redis.
//
// Single shared database (DATABASE_URL); migrations applied idempotently on
// every server boot (no-op once applied). State isolation between tests is
// via TRUNCATE in resetState() before every test (FK-aware order).
//
// Workers serialise on this DB — playwright.config.ts sets workers=1.
// Multi-worker DB isolation would require per-worker DATABASEs (not just
// schemas), since Postgres enum types aren't schema-scoped — V-009 captures
// the empirical finding that drove this design choice.

import { assertLocalDestructiveTarget } from './destructive-target-guard.js';
import { isExpectedCascadeChatter, formatNotice } from './postgres-notices.js';
import type { AddressInfo } from 'node:net';
import { Redis } from 'ioredis';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildApp } from '../../../src/lib/app.js';
import { DrizzleIncidentsRepo } from '../../../src/db/incidents-repo.js';
import { IncidentsService } from '../../../src/services/incidents.js';
import { createTestLogger } from '../../../src/lib/logger.js';
import { MockDriver } from '../../../src/drivers/mock.js';
import { SessionsService } from '../../../src/services/sessions.js';
import { ApiKeysService } from '../../../src/services/api-keys.js';
import { UsageService } from '../../../src/services/usage.js';
import { WebhooksService, WebhooksAdminService } from '../../../src/services/webhooks.js';
import { WebhookDeliveryWorker } from '../../../src/services/webhook-worker.js';
import { AdminAuditService } from '../../../src/services/admin-audit.js';
import { AccountsAdminService } from '../../../src/services/admin-accounts.js';
import { AdminBillingService } from '../../../src/services/admin-billing.js';
import { PricingService } from '../../../src/services/pricing.js';
import { DrizzlePricingRepo } from '../../../src/db/pricing-repo.js';
import { DrizzlePlatformSecretsRepo } from '../../../src/db/platform-secrets-repo.js';
import { PlatformSecretsService } from '../../../src/services/platform-secrets.js';
import { RateLimitOverridesService } from '../../../src/services/rate-limit-overrides.js';
import { LegalService } from '../../../src/services/legal.js';
import { buildLegalCatalog } from '../../../src/services/legal-catalog.js';
import { DrizzleLegalRepo } from '../../../src/db/legal-repo.js';
import { RedisAuthCache } from '../../../src/services/auth-cache.js';
import { AuthCoalescer } from '../../../src/services/auth-coalescer.js';
import { ProfilesService } from '../../../src/services/profiles.js';
import { MfaService } from '../../../src/services/mfa.js';
import { InMemoryMfaChallengeStore } from '../../../src/services/mfa-challenge-store.js';
import { AuthFlowsService } from '../../../src/services/auth-flows.js';
import { StatusSubscribersService } from '../../../src/services/status-subscribers.js';
import { TeamMembersService } from '../../../src/services/team-members.js';
import { ProfileSnapshotsService } from '../../../src/services/profile-snapshots.js';
import {
  CliAuthorizeService,
  InMemoryCliAuthorizeStore,
} from '../../../src/services/cli-authorize.js';
import { DrizzleAccountAuthRepo } from '../../../src/db/auth-repo.js';
import { DrizzleAuthFlowsRepo } from '../../../src/db/auth-flows-repo.js';
import { DrizzleMfaRepo } from '../../../src/db/mfa-repo.js';
import { DrizzleSessionRepo } from '../../../src/db/sessions-repo.js';
import { DrizzleProfilesRepo } from '../../../src/db/profiles-repo.js';
import { DrizzleStatusSubscribersRepo } from '../../../src/db/status-subscribers-repo.js';
import { DrizzleTeamMembersRepo } from '../../../src/db/team-members-repo.js';
import { DrizzleProfileSnapshotsRepo } from '../../../src/db/profile-snapshots-repo.js';
import { DrizzleApiKeysRepo } from '../../../src/db/api-keys-repo.js';
import { DrizzleUsageRepo } from '../../../src/db/usage-repo.js';
import { DrizzleWebhooksRepo } from '../../../src/db/webhooks-repo.js';
import { DrizzleAdminAuditLogRepo } from '../../../src/db/admin-audit-repo.js';
import { DrizzleAccountsAdminRepo } from '../../../src/db/admin-accounts-repo.js';
import { DrizzleAdminBillingRepo } from '../../../src/db/admin-billing-repo.js';
import { DrizzleRateLimitOverridesRepo } from '../../../src/db/rate-limit-overrides-repo.js';
import { RedisRateLimitStore } from '../../../src/lib/redis-rate-limit-store.js';
import { EmailPreferencesService } from '../../../src/services/email-preferences.js';
import { DrizzleEmailPreferencesRepo } from '../../../src/db/email-preferences-repo.js';
import { AccountAuditService } from '../../../src/services/account-audit.js';
import { DrizzleAccountAuditRepo } from '../../../src/db/account-audit-repo.js';
import { AccountLifecycleService } from '../../../src/services/account-lifecycle.js';
import { DrizzleAccountLifecycleRepo } from '../../../src/db/account-lifecycle-repo.js';
import { ScheduledJobsService } from '../../../src/services/scheduled-jobs.js';
import { DrizzleScheduledJobsRepo } from '../../../src/db/scheduled-jobs-repo.js';
import { createEmailService } from '../../../src/services/email.js';
import { BillingService } from '../../../src/services/billing.js';
import { DrizzleBillingRepo } from '../../../src/db/billing-repo.js';
import { InMemoryBillingProvider } from '../../integration/_helpers/in-memory-billing.js';
import { DrizzleOAuthStore } from '../../../src/db/oauth-store.js';
import {
  CostMonitoringService,
  type UsageAggregator,
} from '../../../src/services/cost-monitoring.js';
import type { UsageInputs } from '../../../src/lib/cost-estimator.js';
import {
  ValidationHarnessService,
  type ValidationHarnessRecaptureBridge,
} from '../../../src/services/validation-harness.js';
import { DrizzleValidationSchedulesRepo } from '../../../src/db/validation-schedules-repo.js';
import { randomUUID } from 'node:crypto';
import * as schema from '../../../src/db/schema.js';

export interface TestServer {
  baseUrl: string;
  client: ReturnType<typeof postgres>;
  redis: Redis;
  webhookWorker: WebhookDeliveryWorker;
  /**
   * A worker wired to plain fetch instead of `ssrfGuardedFetch`.
   *
   * The guarded worker above is production-faithful and REFUSES loopback, which
   * is correct and is asserted by its own spec. That makes the signed-payload
   * path unreachable end-to-end against a local receiver, so this seam exists
   * solely to exercise signature generation and payload shape over a real HTTP
   * hop. It must never be used to assert delivery POLICY — only plumbing.
   */
  unguardedWebhookWorker: WebhookDeliveryWorker;
  /** V-540.B-15 — Stripe stub state for billing-write spec assertions. */
  billingProvider: InMemoryBillingProvider;
  /**
   * V-541.B / V-540.B-3 — populate this map to drive the cost
   * aggregator from a spec. Keyed on accountId; value is the usage
   * snapshot the aggregator returns for any billing-cycle query.
   */
  costUsageByAccount: Map<string, UsageInputs>;
  cleanup: () => Promise<void>;
  resetState: () => Promise<void>;
}

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DEFAULT_REDIS_URL = 'redis://localhost:6379';

const TRUNCATE_SQL = `
  TRUNCATE TABLE
    "session_events",
    "sessions",
    "usage_records",
    "rate_limit_buckets",
    "rate_limit_overrides",
    "webhook_deliveries",
    "webhook_endpoints",
    "incident_updates",
    "incidents",
    "admin_audit_log",
    "email_verify_tokens",
    "magic_link_tokens",
    "password_reset_tokens",
    "web_sessions",
    "processed_stripe_events",
    "subscriptions",
    "profiles",
    "api_keys",
    "accounts"
  RESTART IDENTITY CASCADE
`;

export async function startTestServer(): Promise<TestServer> {
  const dbUrl = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
  const redisUrl = process.env.REDIS_URL ?? DEFAULT_REDIS_URL;

  // Before ANY connection is opened: this function drops the public schema a few
  // lines below, and resetState() truncates every account table. Both targets
  // must be a local throwaway. Checked here rather than at the DROP because a
  // caller that has already connected has pointed real credentials at a real
  // host.
  assertLocalDestructiveTarget(dbUrl, redisUrl, process.env);

  // `TRUNCATE … CASCADE` emits one NOTICE per cascaded table and resetState()
  // runs before EVERY test, so postgres.js printed 104 multi-line notice objects
  // from a single spec file and thousands across the suite — which is what a
  // Playwright failure gets buried under on a red CI run.
  //
  // Filtered rather than silenced wholesale: only the expected cascade chatter
  // is dropped, so a notice that actually means something (a migration warning,
  // a skipped DDL) still prints. Doing this with `SET LOCAL` in an explicit
  // transaction is not an option — postgres.js rejects a raw BEGIN on a pooled
  // client with UNSAFE_TRANSACTION.
  //
  // The predicate lives in ./postgres-notices.ts with the measurement that
  // motivated it: the first version of this filter read `notice.message` only,
  // which missed the DROP SCHEMA notices below entirely — they summarise in
  // `message` and list in `detail` — and those were 75% of a green run's log.
  const client = postgres(dbUrl, {
    max: 5,
    onnotice: (notice) => {
      if (isExpectedCascadeChatter(notice)) return;
      console.warn(formatNotice(notice));
    },
  });
  const db = drizzle(client, { schema });

  // E2E owns the database. Drop everything (including drizzle's migration
  // log) and re-run migrations from scratch. This makes the suite hermetic:
  // no dependency on prior dev / seed state. Drizzle's migration log lives
  // under the `drizzle` schema (separate from `public` which holds the app
  // tables), so both must be dropped to force a full re-apply.
  await client.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
  await client.unsafe('DROP SCHEMA IF EXISTS "public" CASCADE');
  await client.unsafe('CREATE SCHEMA "public"');

  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, '..', '..', '..', 'src', 'db', 'migrations');
  await migrate(db, { migrationsFolder });

  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  await redis.flushdb();

  const database = { client, db, close: async () => client.end({ timeout: 5 }) };

  const logger = createTestLogger();
  const authRepo = new DrizzleAccountAuthRepo(database);
  const sessionsRepo = new DrizzleSessionRepo(database);
  const profilesRepo = new DrizzleProfilesRepo(database);
  const apiKeysRepo = new DrizzleApiKeysRepo(database);
  const usageRepo = new DrizzleUsageRepo(database);
  // V-1588 — `buildApp` registers the admin-incidents routes only when this is
  // supplied, so without it five declared operations answer "No route for" and
  // the malformed-id sweep scored them as refusals. The lifecycle hooks are left
  // at the service's own documented default of `{}` rather than stubbed: they
  // fire on successful creates, not on the not-found paths under test, and a
  // hand-written no-op here would be a double nobody asked for.
  const incidentsService = new IncidentsService(new DrizzleIncidentsRepo(database));
  const rateLimitStore = new RedisRateLimitStore(redis);
  const authCache = new RedisAuthCache(redis, logger);

  const driver = new MockDriver({
    fastForwardLatency: false,
    navigateLatencyMs: 30,
    interactLatencyMs: 10,
  });

  const accountAuditRepo = new DrizzleAccountAuditRepo(database);
  const accountAuditService = new AccountAuditService(accountAuditRepo);

  const webhooksRepo = new DrizzleWebhooksRepo(database, {
    secretEncryptionKeyBase64: Buffer.alloc(32, 17).toString('base64'),
  });
  // V-225 — accountAudit wired for webhook_endpoint.{created,deleted}.
  const webhooksService = new WebhooksService(webhooksRepo, accountAuditService);
  const webhooksAdminService = new WebhooksAdminService(webhooksRepo);

  const adminAuditRepo = new DrizzleAdminAuditLogRepo(database);
  const adminAuditService = new AdminAuditService(adminAuditRepo);

  const accountsAdminRepo = new DrizzleAccountsAdminRepo(database);
  const accountsAdminService = new AccountsAdminService(accountsAdminRepo, authCache);
  const adminBillingService = new AdminBillingService(new DrizzleAdminBillingRepo(database));
  const pricingService = new PricingService(new DrizzlePricingRepo(database));
  const platformSecretsService = new PlatformSecretsService(
    new DrizzlePlatformSecretsRepo(database),
    Buffer.alloc(32).toString('base64'),
  );

  const rateLimitOverridesRepo = new DrizzleRateLimitOverridesRepo(database);
  const rateLimitOverridesService = new RateLimitOverridesService(
    rateLimitOverridesRepo,
    authCache,
  );
  // V-202c — lifecycle service constructed before sessions so the
  // accountLifecycle dep can be wired. Email is no-op in e2e (Postmark
  // unconfigured); email-prefs is constructed here and reused below.
  const emailPreferencesRepo = new DrizzleEmailPreferencesRepo(database);
  const emailPreferencesService = new EmailPreferencesService(emailPreferencesRepo);
  const noopEmail = createEmailService({ config: null, logger });
  const accountLifecycleRepo = new DrizzleAccountLifecycleRepo(database);
  const accountLifecycleService = new AccountLifecycleService(
    accountLifecycleRepo,
    noopEmail,
    emailPreferencesService,
    logger,
    {
      docsBaseUrl: 'https://driftstack.local/docs',
      billingPortalUrl: 'http://localhost:5173/billing',
      dashboardUrl: 'http://localhost:5173',
    },
    accountAuditService, // V-202b — tier_changed audit emit
  );

  const scheduledJobsRepo = new DrizzleScheduledJobsRepo(database);
  const scheduledJobsService = new ScheduledJobsService(scheduledJobsRepo, logger, {
    workerId: 'e2e-test-worker',
  });

  const sessionsService = new SessionsService({
    repo: sessionsRepo,
    driver,
    webhooks: webhooksService,
    accountAudit: accountAuditService,
    accountLifecycle: accountLifecycleService,
  });
  // legalService is constructed below; ApiKeysService gets the gate
  // wired in production. e2e tests authenticate with pre-seeded keys
  // and don't typically hit /v1/api-keys; if they do, they need to
  // also seed legal_acceptances per the migration shape.
  const usageService = new UsageService(usageRepo);

  const webhookWorker = new WebhookDeliveryWorker({
    repo: webhooksRepo,
    logger,
    deliveryTimeoutMs: 5_000,
  });
  // See the interface comment: plumbing-only seam, never policy.
  const unguardedWebhookWorker = new WebhookDeliveryWorker({
    repo: webhooksRepo,
    logger,
    deliveryTimeoutMs: 5_000,
    fetch: globalThis.fetch,
  });

  const authCoalescer = new AuthCoalescer(logger);
  const legalRepo = new DrizzleLegalRepo(database);
  const legalCatalog = buildLegalCatalog({ repoRoot: resolve(here, '../../../../../') });
  const legalService = new LegalService(legalCatalog, legalRepo);

  const validationSchedulesRepo = new DrizzleValidationSchedulesRepo(database);
  const recaptureBridge: ValidationHarnessRecaptureBridge = {
    triggerRecapture: () => Promise.resolve({ id: `run_${randomUUID()}` }),
  };
  const validationHarnessService = new ValidationHarnessService(
    validationSchedulesRepo,
    recaptureBridge,
    { iosVersion: '18.7', safariVersion: '26.4' },
  );

  const apiKeysService = new ApiKeysService(
    apiKeysRepo,
    authCache,
    webhooksService,
    legalService,
    accountAuditService,
  );

  // 2026-05-20 — wire StatusSubscribers + TeamMembers + ProfileSnapshots +
  // CliAuthorize services. Each gates a separate route block in
  // apps/server/src/lib/app.ts (deps.statusSubscribersService at 798,
  // deps.teamMembersService at 814, deps.cliAuthorizeService at 931,
  // deps.profileSnapshotsService at 1030). Without these the
  // corresponding e2e specs hit 404 on routes that production wires
  // unconditionally. Mirrors the integration helper pattern.
  const statusSubscribersRepo = new DrizzleStatusSubscribersRepo(database);
  const statusSubscribersService = new StatusSubscribersService(statusSubscribersRepo, noopEmail, {
    statusPageBaseUrl: 'https://status.driftstack.test',
  });
  const teamMembersRepo = new DrizzleTeamMembersRepo(database);
  // 2026-05-21 — pass authCache so accept/remove invalidate the
  // member's cached AccountContext immediately. Without it, the
  // newly-accepted membership only shows up after the 30s TTL — which
  // breaks the team/owners e2e test that asserts `body.data.length=1`
  // right after the accept call.
  const teamMembersService = new TeamMembersService(
    teamMembersRepo,
    noopEmail,
    { dashboardBaseUrl: 'https://app.driftstack.test' },
    accountAuditService,
    authCache,
  );
  const profileSnapshotsRepo = new DrizzleProfileSnapshotsRepo(database);
  const profileSnapshotsService = new ProfileSnapshotsService(
    profileSnapshotsRepo,
    profilesRepo,
    accountAuditService,
  );
  // ProfilesService gates /v1/profiles routes AND is the prerequisite
  // for profile-snapshots routes (apps/server/src/lib/app.ts:1026 +
  // :1030 nested). Production wires it unconditionally; e2e was
  // missing the construction, leaving 404 on both /v1/profiles and
  // /v1/profiles/:id/snapshots.
  const profilesService = new ProfilesService(profilesRepo, accountAuditService);
  const cliAuthorizeService = new CliAuthorizeService({
    store: new InMemoryCliAuthorizeStore(),
    dashboardOrigin: 'http://localhost:5173',
    secretEncryptionKeyBase64: Buffer.alloc(32, 7).toString('base64'),
  });

  // 2026-05-20 — wire MFA + AuthFlows services so the /v1/account/mfa/*
  // and /v1/account/web-sessions routes register in e2e. Production
  // wiring at bootstrap.ts:652 + :796. Mirror the integration helper
  // (build-test-app.ts:949) which uses an all-zeros 32-byte key + an
  // InMemoryMfaChallengeStore so e2e doesn't need MFA_ENCRYPTION_KEY
  // in the runner env.
  const mfaRepo = new DrizzleMfaRepo(database);
  const mfaService = new MfaService(
    mfaRepo,
    { encryptionKey: Buffer.alloc(32, 0).toString('base64') },
    accountAuditService,
    authCache,
  );
  const mfaChallengeStore = new InMemoryMfaChallengeStore();
  const authFlowsRepo = new DrizzleAuthFlowsRepo(database);
  const authFlowsService = new AuthFlowsService(
    authFlowsRepo,
    noopEmail,
    logger,
    {
      verifyEmailUrl: 'http://localhost:5173/verify-email',
      magicLinkUrl: 'http://localhost:5173/auth/magic-link',
      passwordResetUrl: 'http://localhost:5173/reset-password',
      exposeDebugToken: true,
    },
    authCache,
    accountAuditService,
    mfaService,
    mfaChallengeStore,
  );

  // V-541.B / V-540.B-3 — wire a cost-monitoring service backed by an
  // in-memory aggregator. Tests populate `costUsageByAccount` to drive
  // the aggregator; tier resolution reads the live accounts table.
  const costUsageByAccount = new Map<string, UsageInputs>();
  const costAggregator: UsageAggregator = {
    aggregateForAccount: async ({ accountId }) =>
      Promise.resolve(costUsageByAccount.get(accountId) ?? null),
  };
  const costMonitoringService = new CostMonitoringService({
    aggregator: costAggregator,
    rates: {
      computeCentsPerMinute: 1,
      storageCentsPerGbMonth: 2,
      egressCentsPerGb: 5,
      emailCentsPerSend: 1,
      llmCentsPer1kInputTokens: 30,
      llmCentsPer1kOutputTokens: 150,
    },
    resolveTier: async (accountId) => {
      const db = drizzle(client, { schema });
      const [row] = await db
        .select({ tier: schema.accounts.tier })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, accountId))
        .limit(1);
      return row?.tier ?? null;
    },
  });

  // V-540.B-15 — wire BillingService against the real Drizzle repo
  // (reads/writes accounts.stripe_customer_id + trial_pack columns)
  // and the in-memory provider stub. Real Stripe never fires in e2e;
  // the stub gives deterministic checkout URLs + records calls for
  // assertion.
  const billingRepo = new DrizzleBillingRepo({ db: drizzle(client, { schema }) });
  const billingProvider = new InMemoryBillingProvider();
  // Production-equivalent OAuth persistence. The global TRUNCATE below
  // clears these FK-linked tables between tests; no process-local provider
  // state remains to mask restart or multi-instance behavior.
  const oauthStore = new DrizzleOAuthStore(database);
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

  const app = await buildApp({
    logger,
    authRepo,
    authCache,
    authCoalescer,
    sessionsService,
    apiKeysService,
    usageService,
    webhooksService,
    webhooksAdminService,
    adminAuditService,
    accountsAdminService,
    incidentsService,
    adminBillingService,
    pricingService,
    platformSecretsService,
    rateLimitOverridesService,
    legalService,
    emailPreferencesService,
    accountAuditService,
    validationHarnessService,
    accountLifecycleService,
    scheduledJobsService,
    billingService,
    oauthStore,
    costMonitoringService,
    rateLimitStore,
    // 2026-05-20 — wire the V-237 repos so the /v1/account/me route
    // registers in the test app (previously absent, causing every
    // GET /v1/account/me + sibling routes to 404). Surfaced after the
    // catastrophic-backtracking regex fix unblocked CI completion.
    sessionRepo: sessionsRepo,
    // V-1588 — the admin force-action routes need all three of sessionRepo,
    // apiKeysRepo and driver before they register. Only the first was passed, so
    // POST /v1/admin/sessions/:id/destroy and POST /v1/admin/api-keys/:id/revoke
    // answered "No route for" and the malformed-id sweep read that as a refusal.
    // Both objects already exist here and are the same ones the rest of this
    // harness uses; nothing new is stubbed.
    apiKeysRepo,
    driver,
    profilesRepo,
    // 2026-05-20 — mfaService unlocks /v1/account/mfa/*; authFlowsService
    // unlocks /v1/auth/* + /v1/account/web-sessions. Both gated on
    // service presence in apps/server/src/lib/app.ts:885 + 897.
    mfaService,
    authFlowsService,
    // 2026-05-20 — wire the remaining feature services so e2e specs
    // for status-subscribe / team / profile-snapshots / cli-authorize
    // can exercise their respective route blocks.
    statusSubscribersService,
    teamMembersService,
    profilesService,
    profileSnapshotsService,
    cliAuthorizeService,
    permissiveCors: true,
  });

  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr: AddressInfo | string | null = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('listening on a unix socket?');
  const baseUrl = `http://127.0.0.1:${addr.port.toString()}`;

  const resetState = async (): Promise<void> => {
    await client.unsafe(TRUNCATE_SQL);
    await redis.flushdb();
    // 2026-05-21 — clear the in-memory billing provider state so
    // checkoutSessions / portalSessions / customers from a prior test
    // don't leak into the next test's `[0]` index. Surfaced by the
    // billing-write-happy-path spec which read `[0]` expecting the
    // current test's session but found the previous test's.
    billingProvider.state.checkoutSessions.length = 0;
    billingProvider.state.portalSessions.length = 0;
    billingProvider.state.customers.clear();
    costUsageByAccount.clear();
  };

  const cleanup = async (): Promise<void> => {
    await app.close();
    await redis.quit();
    await client.end({ timeout: 5 });
  };

  return {
    baseUrl,
    client,
    redis,
    webhookWorker,
    unguardedWebhookWorker,
    billingProvider,
    costUsageByAccount,
    cleanup,
    resetState,
  };
}
