// Builds a Fastify app instance configured for integration tests:
//   - silent logger (no log spam in test output)
//   - in-memory auth repo seeded with one Pro-tier account + one API key
//   - in-memory rate limiter
//   - permissive CORS
//
// Returns the app, plain-text key, and helpers for direct repo manipulation.

import { buildApp } from '../../../src/lib/app.js';
import { createTestLogger } from '../../../src/lib/logger.js';
import { MemoryRateLimitStore } from '../../../src/lib/memory-rate-limit-store.js';
import { generateApiKey, hashApiKey, keyPrefixFromPlaintext } from '../../../src/lib/api-keys.js';
import { MockDriver } from '../../../src/drivers/mock.js';
import { SessionsService } from '../../../src/services/sessions.js';
import { ApiKeysService } from '../../../src/services/api-keys.js';
import { UsageService } from '../../../src/services/usage.js';
import { WebhooksService, WebhooksAdminService } from '../../../src/services/webhooks.js';
import { AdminAuditService } from '../../../src/services/admin-audit.js';
import { AccountsAdminService } from '../../../src/services/admin-accounts.js';
import { IncidentsService } from '../../../src/services/incidents.js';
import { InMemoryIncidentsRepo } from './in-memory-incidents-repo.js';
import { InMemoryStatusSubscribersRepo } from './in-memory-status-subscribers-repo.js';
import { StatusSubscribersService } from '../../../src/services/status-subscribers.js';
import type { EmailService } from '../../../src/services/email.js';
import { RateLimitOverridesService } from '../../../src/services/rate-limit-overrides.js';
import { LegalService } from '../../../src/services/legal.js';
import { buildLegalCatalogFromContent } from '../../../src/services/legal-catalog.js';
import { EmailPreferencesService } from '../../../src/services/email-preferences.js';
import { InMemoryEmailPreferencesRepo } from './in-memory-email-preferences-repo.js';
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
import { InMemoryRateLimitOverridesRepo } from './in-memory-rate-limit-overrides-repo.js';
import { InMemoryLegalRepo } from './in-memory-legal-repo.js';
import { InMemoryAuthFlowsRepo } from './in-memory-auth-flows-repo.js';
import { InMemoryStripeWebhooksRepo } from './in-memory-stripe-webhooks-repo.js';
import { InMemoryProfilesRepo } from './in-memory-profiles-repo.js';
import { InMemoryBillingProvider, InMemoryBillingRepo } from './in-memory-billing.js';
import { BillingService } from '../../../src/services/billing.js';
import { AuthFlowsService } from '../../../src/services/auth-flows.js';
import {
  CliAuthorizeService,
  InMemoryCliAuthorizeStore,
} from '../../../src/services/cli-authorize.js';
import { StripeWebhooksService } from '../../../src/services/stripe-webhooks.js';
import { ProfilesService } from '../../../src/services/profiles.js';
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
    sendSubscriptionCancellation: async (args) => {
      record('subscription-cancellation', args);
      await realService.sendSubscriptionCancellation(args);
    },
    sendSupportAck: async (args) => {
      record('support-ack', args);
      await realService.sendSupportAck(args);
    },
    sendSignupWelcome: async (args) => {
      record('signup-welcome', args);
      await realService.sendSignupWelcome(args);
    },
    sendSessionFailedFirst: async (args) => {
      record('session-failed-first', args);
      await realService.sendSessionFailedFirst(args);
    },
    sendTierChanged: async (args) => {
      record('tier-changed', args);
      await realService.sendTierChanged(args);
    },
    sendTrialPackPurchased: async (args) => {
      record('trial-pack-purchased', args);
      await realService.sendTrialPackPurchased(args);
    },
    sendTrialPackExpired: async (args) => {
      record('trial-pack-expired', args);
      await realService.sendTrialPackExpired(args);
    },
    sendStatusSubscriptionConfirmation: async (args) => {
      record('status-subscription-confirmation', args);
      await realService.sendStatusSubscriptionConfirmation(args);
    },
    sendStatusSubscriptionWelcome: async (args) => {
      record('status-subscription-welcome', args);
      await realService.sendStatusSubscriptionWelcome(args);
    },
  };
  return { service, sends };
}

export interface TestAppOptions {
  tier?: AccountTier;
  scopes?: ApiKeyScope[];
  accountStatus?: 'active' | 'suspended' | 'deleted';
  keyRevoked?: boolean;
  keyExpired?: boolean;
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
  authRepo: InMemoryAuthRepo;
  authCache: InMemoryAuthCache;
  authCoalescer: AuthCoalescer;
  sessionsRepo: InMemorySessionsRepo;
  apiKeysRepo: InMemoryApiKeysRepo;
  usageRepo: InMemoryUsageRepo;
  webhooksRepo: InMemoryWebhooksRepo;
  adminAuditRepo: InMemoryAdminAuditLogRepo;
  /** V-281 — exposed so tests can assert customer-audit rows post admin action. */
  accountAuditRepo: InMemoryAccountAuditRepo;
  /** V-295a — exposed so tests can assert incident state. */
  incidentsRepo: InMemoryIncidentsRepo;
  /** V-295c3 — exposed so tests can assert subscriber state. */
  statusSubscribersRepo: InMemoryStatusSubscribersRepo;
  /** V-295c3 — recording email service: tests can read .sends to assert
   *  exactly which template fired with what variables. */
  emailSends: ReadonlyArray<EmailSendRecord>;
  rateLimitOverridesRepo: InMemoryRateLimitOverridesRepo;
  rateLimitStore: MemoryRateLimitStore;
  authFlowsRepo: InMemoryAuthFlowsRepo;
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
  /** Plaintext API key — pass as `Authorization: Bearer <plaintext>`. */
  plaintext: string;
  accountId: string;
  apiKeyId: string;
  cleanup: () => Promise<void>;
}

export async function buildTestApp(opts: TestAppOptions = {}): Promise<TestAppFixture> {
  const authRepo = new InMemoryAuthRepo();
  const rateLimitStore = new MemoryRateLimitStore();

  const accountId = opts.accountId ?? '00000000-0000-4000-8000-000000000001';
  const apiKeyId = opts.apiKeyId ?? '00000000-0000-4000-8000-000000000a01';

  authRepo.upsertAccount({
    id: accountId,
    email: opts.email ?? 'tester@driftstack.local',
    name: 'Tester',
    tier: opts.tier ?? 'api_builder',
    status: opts.accountStatus ?? 'active',
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
    scopes: opts.scopes ?? ['read', 'write', 'admin'],
    lastUsedAt: null,
    revokedAt: opts.keyRevoked === true ? new Date('2026-01-15T00:00:00Z') : null,
    expiresAt: opts.keyExpired === true ? new Date('2026-01-15T00:00:00Z') : null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
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
    scopes: opts.scopes ?? ['read', 'write', 'admin'],
    lastUsedAt: null,
    revokedAt: opts.keyRevoked === true ? new Date('2026-01-15T00:00:00Z') : null,
    expiresAt: opts.keyExpired === true ? new Date('2026-01-15T00:00:00Z') : null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });
  const authCache = new InMemoryAuthCache();
  const authCoalescer = new AuthCoalescer();

  const usageRepo = new InMemoryUsageRepo();
  const usageService = new UsageService(usageRepo);

  // V-216 — customer-facing audit; constructed early so all
  // emit-on-event services (webhooks, sessions, api-keys, profiles)
  // can wire it.
  const accountAuditRepo = new InMemoryAccountAuditRepo();
  const accountAuditService = new AccountAuditService(accountAuditRepo);

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

  // V-202d — scheduled-jobs service with the trial_pack.expired handler
  // pre-registered. Tests that exercise the trial-pack expiry flow can
  // call `scheduledJobsService.processTick()` directly to fire any due
  // jobs without waiting on a setInterval poller.
  const scheduledJobsRepo = new InMemoryScheduledJobsRepo();
  const scheduledJobsService = new ScheduledJobsService(scheduledJobsRepo, testLogger, {
    workerId: 'test-worker',
  });
  scheduledJobsService.register('trial_pack.expired', async (job) => {
    if (job.accountId === null) return;
    await accountLifecycleService.emit(job.accountId, {
      kind: 'subscription.trial_pack_expired',
    });
  });

  const webhooksRepo = new InMemoryWebhooksRepo();
  // V-225 — accountAudit wired for webhook_endpoint.{created,deleted}.
  const webhooksService = new WebhooksService(webhooksRepo, accountAuditService);
  const webhooksAdminService = new WebhooksAdminService(webhooksRepo);

  const adminAuditRepo = new InMemoryAdminAuditLogRepo();
  const adminAuditService = new AdminAuditService(adminAuditRepo);

  const accountsAdminRepo = new InMemoryAccountsAdminRepo(authRepo);
  const accountsAdminService = new AccountsAdminService(accountsAdminRepo, authCache);
  // V-295a — incidents service with in-memory repo.
  const incidentsRepo = new InMemoryIncidentsRepo();
  const incidentsService = new IncidentsService(incidentsRepo);

  // V-295c3 — public-status email subscribers.
  const statusSubscribersRepo = new InMemoryStatusSubscribersRepo();
  const statusSubscribersService = new StatusSubscribersService(statusSubscribersRepo, noopEmail, {
    statusPageBaseUrl: 'https://status.driftstack.test',
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
  const authFlowsService = new AuthFlowsService(
    authFlowsRepo,
    noopEmail,
    testLogger,
    {
      verifyEmailUrl: 'http://localhost:5173/auth/verify-email',
      magicLinkUrl: 'http://localhost:5173/auth/magic-link',
      passwordResetUrl: 'http://localhost:5173/auth/password-reset',
      exposeDebugToken: true,
    },
    authCache, // V-168 — cache invalidation on logout
    accountAuditService, // V-224 — emit account.{email_verified,login,logout,password_changed}
  );

  // V-266 — browser-OAuth flow with in-memory store for tests.
  const cliAuthorizeService = new CliAuthorizeService({
    store: new InMemoryCliAuthorizeStore(),
    dashboardOrigin: 'http://localhost:5173',
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
    scheduledJobsService, // V-202d — enqueues trial_pack.expired job at trial-pack purchase
  );
  const stripeWebhookSigningSecret = 'whsec_test_fixture_secret';

  // V-081: Profiles service.
  const profilesRepo = new InMemoryProfilesRepo();
  // V-225 — accountAudit wired for profile.{created,deleted}.
  const profilesService = new ProfilesService(profilesRepo, accountAuditService);

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
    trialPackPurchasedAt: null,
    trialPackCreditCents: null,
    trialPackExpiresAt: null,
    trialPackRedeemed: false,
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
    trialPackPriceId: 'price_trial_pack_one_time',
    defaultSuccessUrl: 'http://localhost:5173/billing/success',
    defaultCancelUrl: 'http://localhost:5173/billing/cancel',
    portalReturnUrl: 'http://localhost:5173/billing',
  });

  const app = await buildApp({
    logger: testLogger,
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
    rateLimitOverridesService,
    legalService,
    emailPreferencesService,
    accountAuditService,
    validationHarnessService,
    accountLifecycleService,
    scheduledJobsService,
    authFlowsService,
    cliAuthorizeService,
    stripeWebhooksService,
    stripeWebhookSigningSecret,
    profilesService,
    billingService,
    sessionRepo: sessionsRepo,
    apiKeysRepo,
    profilesRepo,
    driver,
    permissiveCors: true,
  });

  return {
    app,
    authRepo,
    authCache,
    authCoalescer,
    webhooksRepo,
    adminAuditRepo,
    accountAuditRepo,
    incidentsRepo,
    statusSubscribersRepo,
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
    plaintext,
    accountId,
    apiKeyId,
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
    scopes: opts.scopes ?? (['read', 'write', 'admin'] as ApiKeyScope[]),
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
