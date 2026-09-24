// The whole app, wired the way bootstrap wires it, against an isolated database
// — plus accounts that hold every credential shape a real one can hold: a
// signed-in browser (web session), an API key, and the desktop app's device
// credential (an API key with provenance 'cli_device').
//
// Shared by the identity-shape suites. Modelled on the builder in
// an-action-taken-from-a-signed-in-browser-is-recorded-against-its-web-session
// .test.ts, with three additions those suites need: the auth flows (password
// reset), an optional auth cache (to drive the cached authentication path), and
// the staff allow-list and owner as parameters (to model a de-listing, which is
// a restart with a different list).

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { ApiKeyScope } from '@driftstack/api-types';
import { buildApp } from '../../../src/lib/app.js';
import { createTestLogger } from '../../../src/lib/logger.js';
import { MemoryRateLimitStore } from '../../../src/lib/memory-rate-limit-store.js';
import { generateApiKey, hashApiKey, keyPrefixFromPlaintext } from '../../../src/lib/api-keys.js';
import type { Database } from '../../../src/db/client.js';
import { DrizzleAccountAuthRepo } from '../../../src/db/auth-repo.js';
import { DrizzleAuthFlowsRepo } from '../../../src/db/auth-flows-repo.js';
import { DrizzleSessionRepo } from '../../../src/db/sessions-repo.js';
import { DrizzleApiKeysRepo } from '../../../src/db/api-keys-repo.js';
import { DrizzleUsageRepo } from '../../../src/db/usage-repo.js';
import { DrizzleWebhooksRepo } from '../../../src/db/webhooks-repo.js';
import { DrizzleAdminAuditLogRepo } from '../../../src/db/admin-audit-repo.js';
import { DrizzleAccountsAdminRepo } from '../../../src/db/admin-accounts-repo.js';
import { DrizzleAdminBillingRepo } from '../../../src/db/admin-billing-repo.js';
import { DrizzlePricingRepo } from '../../../src/db/pricing-repo.js';
import { DrizzlePlatformSecretsRepo } from '../../../src/db/platform-secrets-repo.js';
import { DrizzleRateLimitOverridesRepo } from '../../../src/db/rate-limit-overrides-repo.js';
import { DrizzleLegalRepo } from '../../../src/db/legal-repo.js';
import { DrizzleEmailPreferencesRepo } from '../../../src/db/email-preferences-repo.js';
import { DrizzleAccountAuditRepo } from '../../../src/db/account-audit-repo.js';
import { DrizzleAccountLifecycleRepo } from '../../../src/db/account-lifecycle-repo.js';
import { DrizzleValidationSchedulesRepo } from '../../../src/db/validation-schedules-repo.js';
import { DrizzleIncidentsRepo } from '../../../src/db/incidents-repo.js';
import { MockDriver } from '../../../src/drivers/mock.js';
import type { AuthCache } from '../../../src/services/auth-cache.js';
import { AuthFlowsService } from '../../../src/services/auth-flows.js';
import { InMemoryMfaChallengeStore } from '../../../src/services/mfa-challenge-store.js';
import { SessionsService } from '../../../src/services/sessions.js';
import { ApiKeysService } from '../../../src/services/api-keys.js';
import { UsageService } from '../../../src/services/usage.js';
import { WebhooksAdminService, WebhooksService } from '../../../src/services/webhooks.js';
import { AdminAuditService } from '../../../src/services/admin-audit.js';
import { AccountsAdminService } from '../../../src/services/admin-accounts.js';
import { AdminBillingService } from '../../../src/services/admin-billing.js';
import { PricingService } from '../../../src/services/pricing.js';
import { PlatformSecretsService } from '../../../src/services/platform-secrets.js';
import { RateLimitOverridesService } from '../../../src/services/rate-limit-overrides.js';
import { LegalService } from '../../../src/services/legal.js';
import type { buildLegalCatalog } from '../../../src/services/legal-catalog.js';
import { EmailPreferencesService } from '../../../src/services/email-preferences.js';
import { AccountAuditService } from '../../../src/services/account-audit.js';
import { AccountLifecycleService } from '../../../src/services/account-lifecycle.js';
import { createEmailService } from '../../../src/services/email.js';
import { ValidationHarnessService } from '../../../src/services/validation-harness.js';
import { IncidentsService } from '../../../src/services/incidents.js';
import type { AdminCreditsHarness } from './admin-credits-route-fixtures.js';

export type RealApp = Awaited<ReturnType<typeof buildApp>>;
export type LegalCatalog = ReturnType<typeof buildLegalCatalog>;

/** A credential as the database holds it, and the bearer that presents it. */
export interface SeededKey {
  readonly id: string;
  readonly plaintext: string;
}

export interface SeededWebSession {
  readonly id: string;
  readonly token: string;
}

/** An account with the legal documents accepted (the key-mint gate passes). */
export async function seedAccount(
  sql: postgres.Sql,
  email: string,
  catalog: LegalCatalog,
  tier: 'api_scale' | 'api_starter' | 'free' = 'api_scale',
): Promise<string> {
  const accountId = randomUUID();
  await sql`
    INSERT INTO accounts (id, email, name, tier, status)
    VALUES (${accountId}::uuid, ${email}, 'Seeded', ${tier}::account_tier, 'active')`;
  for (const entry of catalog.entries()) {
    await sql`
      INSERT INTO legal_acceptances (account_id, document_key, version, content_hash)
      VALUES (${accountId}::uuid, ${entry.documentKey}, ${entry.version}, ${entry.contentHash})`;
  }
  return accountId;
}

/**
 * An API key row, as a real mint leaves it. `provenance: 'cli_device'` is the
 * desktop app's credential (the device-code sign-in mints exactly this);
 * `createdByAccountId` names a team member who minted it on someone else's
 * account.
 */
export async function seedApiKey(
  sql: postgres.Sql,
  accountId: string,
  opts: {
    scopes: ApiKeyScope[];
    name?: string;
    provenance?: 'cli_device' | null;
    createdByAccountId?: string | null;
  },
): Promise<SeededKey> {
  const plaintext = generateApiKey('live');
  const [row] = await sql<Array<{ id: string }>>`
    INSERT INTO api_keys (account_id, name, key_prefix, key_hash, scopes, provenance, created_by_account_id)
    VALUES (${accountId}::uuid, ${opts.name ?? 'seeded'}, ${keyPrefixFromPlaintext(plaintext)},
            ${await hashApiKey(plaintext)}, ${sql.array(opts.scopes)}::text[]::api_key_scope[],
            ${opts.provenance ?? null}, ${opts.createdByAccountId ?? null}::uuid)
    RETURNING id::text`;
  if (row === undefined) throw new Error('the API key was not seeded');
  return { id: row.id, plaintext };
}

/** A signed-in browser: an opaque token, stored as its sha256. */
export async function seedWebSession(
  sql: postgres.Sql,
  accountId: string,
): Promise<SeededWebSession> {
  const token = randomBytes(32).toString('base64url');
  const id = randomUUID();
  // The session is minted at the account's current auth epoch, as issueWebSession does.
  await sql`
    INSERT INTO web_sessions (id, account_id, token_hash, auth_epoch, expires_at, user_agent, last_used_at)
    SELECT ${id}::uuid, a.id, ${createHash('sha256').update(token).digest('hex')}, a.auth_epoch,
           ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz, 'vitest', now()
      FROM accounts a WHERE a.id = ${accountId}::uuid`;
  return { id, token };
}

export interface RealAppOptions {
  /** The staff allow-list the process booted with (owner is unioned in, as bootstrap does). */
  readonly staffEmails: ReadonlySet<string>;
  readonly ownerEmail?: string;
  /** Omit for no cache (every request takes the slow path). */
  readonly authCache?: AuthCache | null;
}

/** The whole app, wired the way bootstrap wires it, against the isolated database. */
export async function buildRealApp(
  db: Database,
  creditsHarness: AdminCreditsHarness,
  catalog: LegalCatalog,
  opts: RealAppOptions,
): Promise<RealApp> {
  const logger = createTestLogger();
  const authCache = opts.authCache ?? null;
  const accountAuditService = new AccountAuditService(new DrizzleAccountAuditRepo(db));
  const webhooksRepo = new DrizzleWebhooksRepo(db, {
    secretEncryptionKeyBase64: Buffer.alloc(32, 17).toString('base64'),
  });
  const webhooksService = new WebhooksService(webhooksRepo, accountAuditService);
  const emailPreferencesService = new EmailPreferencesService(new DrizzleEmailPreferencesRepo(db));
  const noopEmail = createEmailService({ config: null, logger });
  const accountLifecycleService = new AccountLifecycleService(
    new DrizzleAccountLifecycleRepo(db),
    noopEmail,
    emailPreferencesService,
    logger,
    {
      docsBaseUrl: 'https://driftstack.local/docs',
      billingPortalUrl: 'http://localhost:5173/billing',
      dashboardUrl: 'http://localhost:5173',
    },
    accountAuditService,
  );
  const sessionsRepo = new DrizzleSessionRepo(db);
  const apiKeysRepo = new DrizzleApiKeysRepo(db);
  const driver = new MockDriver({ fastForwardLatency: true });
  const legalService = new LegalService(catalog, new DrizzleLegalRepo(db));
  const sessionsService = new SessionsService({
    repo: sessionsRepo,
    driver,
    webhooks: webhooksService,
    accountAudit: accountAuditService,
    accountLifecycle: accountLifecycleService,
  });
  const apiKeysService = new ApiKeysService(
    apiKeysRepo,
    authCache,
    webhooksService,
    legalService,
    accountAuditService,
  );
  const authFlowsService = new AuthFlowsService(
    new DrizzleAuthFlowsRepo(db),
    noopEmail,
    logger,
    {
      verifyEmailUrl: 'http://localhost:5173/verify-email',
      magicLinkUrl: 'http://localhost:5173/magic-link',
      passwordResetUrl: 'http://localhost:5173/reset-password',
      exposeDebugToken: true,
    },
    authCache,
    accountAuditService,
    null,
    // Bootstrap always wires the short-lived store (Redis there); the sign-in
    // limits live in it (sign-in audit #2, #3), so the app here has one too.
    new InMemoryMfaChallengeStore(),
    emailPreferencesService,
    webhooksService,
  );
  const staffEmails =
    opts.ownerEmail !== undefined
      ? new Set([...opts.staffEmails, opts.ownerEmail])
      : new Set(opts.staffEmails);
  return buildApp({
    logger,
    authRepo: new DrizzleAccountAuthRepo(db),
    authCache,
    authCoalescer: null,
    rateLimitStore: new MemoryRateLimitStore(),
    globalIpRateLimit: null,
    sessionsService,
    apiKeysService,
    authFlowsService,
    usageService: new UsageService(new DrizzleUsageRepo(db)),
    webhooksService,
    webhooksAdminService: new WebhooksAdminService(webhooksRepo),
    adminAuditService: new AdminAuditService(new DrizzleAdminAuditLogRepo(db)),
    // Wired as bootstrap wires it: the termination reclaims every surface.
    accountsAdminService: new AccountsAdminService(
      new DrizzleAccountsAdminRepo(db, creditsHarness.overrides),
      authCache,
      sessionsService,
      authFlowsService,
      apiKeysService,
      webhooksService,
    ),
    incidentsService: new IncidentsService(new DrizzleIncidentsRepo(db)),
    adminBillingService: new AdminBillingService(new DrizzleAdminBillingRepo(db)),
    pricingService: new PricingService(new DrizzlePricingRepo(db)),
    platformSecretsService: new PlatformSecretsService(
      new DrizzlePlatformSecretsRepo(db),
      Buffer.alloc(32, 3).toString('base64'),
    ),
    rateLimitOverridesService: new RateLimitOverridesService(
      new DrizzleRateLimitOverridesRepo(db),
      null,
    ),
    legalService,
    emailPreferencesService,
    accountAuditService,
    validationHarnessService: new ValidationHarnessService(
      new DrizzleValidationSchedulesRepo(db),
      { triggerRecapture: () => Promise.resolve({ id: `run_${randomUUID()}` }) },
      { iosVersion: '18.7', safariVersion: '26.4' },
    ),
    accountLifecycleService,
    sessionRepo: sessionsRepo,
    apiKeysRepo,
    driver,
    aiCredits: creditsHarness.aiCredits,
    staffEmails,
    ...(opts.ownerEmail !== undefined ? { ownerEmail: opts.ownerEmail } : {}),
    permissiveCors: true,
  });
}

/** One request, as `bearer`; the body parsed when there is one. */
export async function send(
  app: RealApp,
  bearer: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${bearer}`, ...headers },
    ...(payload === undefined ? {} : { payload }),
  });
  return { status: res.statusCode, body: res.body.length > 0 ? res.json() : null };
}

/** The customer audit rows for one action on one account, as the database holds them. */
export async function accountAuditRows(
  sql: postgres.Sql,
  accountId: string,
  action: string,
): Promise<
  Array<{
    actor_type: string;
    actor_account_id: string | null;
    actor_key_id: string | null;
    actor_web_session_id: string | null;
    target_resource_id: string | null;
    payload: Record<string, unknown> | null;
  }>
> {
  return sql`
    SELECT actor_type::text AS actor_type, actor_account_id::text AS actor_account_id,
           actor_key_id::text AS actor_key_id, actor_web_session_id::text AS actor_web_session_id,
           target_resource_id, payload
      FROM account_audit_log
     WHERE account_id = ${accountId}::uuid AND action = ${action}
     ORDER BY timestamp, id`;
}
