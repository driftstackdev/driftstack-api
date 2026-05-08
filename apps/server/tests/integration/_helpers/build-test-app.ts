// Builds a Fastify app instance configured for integration tests:
//   - silent logger (no log spam in test output)
//   - in-memory auth repo seeded with one Pro-tier account + one API key
//   - in-memory rate limiter
//   - permissive CORS
//
// Returns the app, plain-text key, and helpers for direct repo manipulation.

import { buildApp } from '../../../src/lib/app.js';
import type { R2 } from '../../../src/lib/r2.js';
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
import { IncidentNotificationsService } from '../../../src/services/incident-notifications.js';
import { IncidentBroadcastService } from '../../../src/services/incident-broadcast.js';
import { IncidentEventBus } from '../../../src/services/incident-event-bus.js';
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
import { InMemoryMfaRepo } from './in-memory-mfa-repo.js';
import { MfaService } from '../../../src/services/mfa.js';
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
    sendBillingRenewalReminder: async (args) => {
      record('billing-renewal-reminder', args);
      await realService.sendBillingRenewalReminder(args);
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
    sendSessionSuccessFirst: async (args) => {
      record('session-success-first', args);
      await realService.sendSessionSuccessFirst(args);
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
    sendStatusIncidentNotification: async (args) => {
      record(
        args.kind === 'created' ? 'status-incident-created' : 'status-incident-resolved',
        args,
      );
      await realService.sendStatusIncidentNotification(args);
    },
    sendTeamInvite: async (args) => {
      record('team-invite', args);
      await realService.sendTeamInvite(args);
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
  /** V-295d — set to a non-null URL to enable Slack outbound broadcasts in this fixture. */
  broadcastSlackUrl?: string | null;
  /** V-295d — set to a non-null URL to enable generic outbound broadcasts in this fixture. */
  broadcastGenericUrl?: string | null;
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
  /** V-307 — exposed so tests can enqueue deliveries directly without
   *  a real session-completion event. */
  webhooksService: WebhooksService;
  adminAuditRepo: InMemoryAdminAuditLogRepo;
  /** V-281 — exposed so tests can assert customer-audit rows post admin action. */
  accountAuditRepo: InMemoryAccountAuditRepo;
  /** V-295a — exposed so tests can assert incident state. */
  incidentsRepo: InMemoryIncidentsRepo;
  /** V-295c3 — exposed so tests can assert subscriber state. */
  statusSubscribersRepo: InMemoryStatusSubscribersRepo;
  /** V-295c3-tombstone — exposed for direct purge invocation in tests. */
  statusSubscribersService: StatusSubscribersService;
  /** V-295d — recorded outbound broadcast HTTP calls (URL + parsed JSON body). */
  broadcastFetchCalls: ReadonlyArray<{ url: string; body: unknown }>;
  /** V-295e — exposed for direct event-bus subscription in tests. */
  incidentEventBus: IncidentEventBus;
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
    presignPut({ key }) {
      return Promise.resolve(`https://r2-fake.test/${bucket}/${key}?put=1`);
    },
    presignGet({ key, expiresIn }) {
      const ttl = expiresIn ?? 900;
      return Promise.resolve(`https://r2-fake.test/${bucket}/${key}?ttl=${ttl}`);
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
  const incidentNotifications = new IncidentNotificationsService(
    statusSubscribersService,
    noopEmail,
    testLogger,
    { statusPageBaseUrl: 'https://status.driftstack.test' },
  );

  // V-295e — incident event bus + SLA reporting. Probes repo is also
  // exposed so SLA tests can seed probe history directly.
  const probesRepo = new InMemoryProbesRepo();
  const slaReportingService = new SlaReportingService(probesRepo);
  const incidentEventBus = new IncidentEventBus();

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
  const incidentsRepo = new InMemoryIncidentsRepo();
  const incidentsService = new IncidentsService(incidentsRepo, {
    onPublicCreated: async (incident, update) => {
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

  // V-353b — MFA service backed by in-memory repo. Encryption key is
  // a fixed 32-byte test key so tests are deterministic.
  const mfaRepo = new InMemoryMfaRepo();
  const mfaService = new MfaService(
    mfaRepo,
    {
      // 32-byte all-zeros key, base64. Test-only — never use in prod.
      encryptionKey: Buffer.alloc(32, 0).toString('base64'),
    },
    accountAuditService,
  );

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
        timezone: null,
        avatarR2Key: null,
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
    mfaService,
    stripeWebhooksService,
    stripeWebhookSigningSecret,
    profilesService,
    billingService,
    sessionRepo: sessionsRepo,
    apiKeysRepo,
    profilesRepo,
    // V-352b — fake R2 public bucket so /v1/account/me/avatar can be
    // exercised in integration tests without touching real Cloudflare.
    r2Public: r2PublicFake,
    driver,
    permissiveCors: true,
  });

  return {
    app,
    authRepo,
    authCache,
    authCoalescer,
    webhooksRepo,
    webhooksService,
    adminAuditRepo,
    accountAuditRepo,
    incidentsRepo,
    statusSubscribersRepo,
    statusSubscribersService,
    broadcastFetchCalls,
    incidentEventBus,
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
