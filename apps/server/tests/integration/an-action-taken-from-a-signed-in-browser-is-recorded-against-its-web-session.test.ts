// An action taken from a signed-in browser is recorded against its web
// session — and the same action taken with an API key is still recorded
// against its key.
//
// The admin panel and the customer dashboard both authenticate with a web
// session, and a web session acts with `ctx.apiKey.id = 'wsk_<web session
// uuid>'` (services/auth.ts). Every table that records the ACTING key kept it in
// a `uuid` column, most of them with a foreign key to `api_keys`, so nothing a
// signed-in browser did could be attributed:
//
//   · an audited admin write committed its change and THEN failed to write its
//     audit row (`invalid input syntax for type uuid: "wsk_…"`), so the admin got
//     a 500 for a change that had happened — production logged exactly that on
//     2026-05-27 for a tier change;
//   · where the acting key is itself part of the change (a price, a secret, a
//     rate-limit override, an incident, a rate card, an AI plan) the change
//     itself failed, and the AI-credits staff tools, which write their audit row
//     inside the change's own transaction, refused every change outright;
//   · a customer's own action (an API key minted from the dashboard) succeeded
//     and its "Recent activity" row silently never existed, because that audit
//     write is best-effort and swallowed.
//
// No test caught it because every one of those paths ran against in-memory
// repositories that accept any string. This file runs them against a real,
// freshly migrated database (its own, `ISOLATED_DB_NAME`), through the whole app
// wired the way production wires it: real Drizzle repositories, real web-session
// and API-key authentication from rows in that database, the staff allow-list
// and the owner gate. Each arm asserts three things: the request succeeds, the
// change is really there, and the row that records who did it names the web
// session (and no key), both in the table and on the published surface that
// reads it back.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiKeyScope } from '@driftstack/api-types';
import { buildApp } from '../../src/lib/app.js';
import { createTestLogger } from '../../src/lib/logger.js';
import { MemoryRateLimitStore } from '../../src/lib/memory-rate-limit-store.js';
import { generateApiKey, hashApiKey, keyPrefixFromPlaintext } from '../../src/lib/api-keys.js';
import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleAccountAuthRepo } from '../../src/db/auth-repo.js';
import { DrizzleSessionRepo } from '../../src/db/sessions-repo.js';
import { DrizzleApiKeysRepo } from '../../src/db/api-keys-repo.js';
import { DrizzleUsageRepo } from '../../src/db/usage-repo.js';
import { DrizzleWebhooksRepo } from '../../src/db/webhooks-repo.js';
import { DrizzleAdminAuditLogRepo } from '../../src/db/admin-audit-repo.js';
import { DrizzleAccountsAdminRepo } from '../../src/db/admin-accounts-repo.js';
import { DrizzleAdminBillingRepo } from '../../src/db/admin-billing-repo.js';
import { DrizzlePricingRepo } from '../../src/db/pricing-repo.js';
import { DrizzlePlatformSecretsRepo } from '../../src/db/platform-secrets-repo.js';
import { DrizzleRateLimitOverridesRepo } from '../../src/db/rate-limit-overrides-repo.js';
import { DrizzleLegalRepo } from '../../src/db/legal-repo.js';
import { DrizzleEmailPreferencesRepo } from '../../src/db/email-preferences-repo.js';
import { DrizzleAccountAuditRepo } from '../../src/db/account-audit-repo.js';
import { DrizzleAccountLifecycleRepo } from '../../src/db/account-lifecycle-repo.js';
import { DrizzleValidationSchedulesRepo } from '../../src/db/validation-schedules-repo.js';
import { DrizzleIncidentsRepo } from '../../src/db/incidents-repo.js';
import { MockDriver } from '../../src/drivers/mock.js';
import { SessionsService } from '../../src/services/sessions.js';
import { ApiKeysService } from '../../src/services/api-keys.js';
import { UsageService } from '../../src/services/usage.js';
import { WebhooksAdminService, WebhooksService } from '../../src/services/webhooks.js';
import { AdminAuditService } from '../../src/services/admin-audit.js';
import { AccountsAdminService } from '../../src/services/admin-accounts.js';
import { AdminBillingService } from '../../src/services/admin-billing.js';
import { PricingService } from '../../src/services/pricing.js';
import { PlatformSecretsService } from '../../src/services/platform-secrets.js';
import { RateLimitOverridesService } from '../../src/services/rate-limit-overrides.js';
import { LegalService } from '../../src/services/legal.js';
import { buildLegalCatalog } from '../../src/services/legal-catalog.js';
import { EmailPreferencesService } from '../../src/services/email-preferences.js';
import { AccountAuditService } from '../../src/services/account-audit.js';
import { AccountLifecycleService } from '../../src/services/account-lifecycle.js';
import { createEmailService } from '../../src/services/email.js';
import { ValidationHarnessService } from '../../src/services/validation-harness.js';
import { IncidentsService } from '../../src/services/incidents.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import { newTaskAccount } from './_helpers/credit-reservation-fixtures.js';
import { paidLine, subscription } from './_helpers/credit-grant-fixtures.js';
import {
  adminCreditsHarness,
  type AdminCreditsHarness,
} from './_helpers/admin-credits-route-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_web_session_actor';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The owner is also on the staff allow-list, as bootstrap makes them. */
const OWNER_EMAIL = `owner-${randomUUID()}@driftstack.test`;
const CUSTOMER_EMAIL = `customer-${randomUUID()}@example.test`;

type App = Awaited<ReturnType<typeof buildApp>>;

interface Identity {
  readonly accountId: string;
  readonly apiKeyId: string;
  readonly apiKeyPlaintext: string;
  readonly webSessionId: string;
  readonly webSessionToken: string;
}

/** Who a request is sent as, and what the rows it writes must therefore name. */
interface Actor {
  readonly label: 'a web session' | 'an API key';
  readonly bearer: string;
  /** `ctx.apiKey.id` for this caller. */
  readonly actingId: string;
  /** The key column's expected value (null for a web session). */
  readonly keyId: string | null;
  /** The web-session column's expected value (null for an API key). */
  readonly webSessionId: string | null;
  /** What a published response that carries the acting key must say. */
  readonly published: string;
}

let client: postgres.Sql | null = null;
let database: Database | null = null;
let harness: AdminCreditsHarness | null = null;
let app: App | null = null;
let owner: Identity | null = null;
let customer: Identity | null = null;

function sql(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

function h(): AdminCreditsHarness {
  if (harness === null) throw new Error('isolated database unreachable');
  return harness;
}

function theApp(): App {
  if (app === null) throw new Error('the app was not built');
  return app;
}

function asWebSession(who: Identity | null): Actor {
  if (who === null) throw new Error('identity not seeded');
  return {
    label: 'a web session',
    bearer: who.webSessionToken,
    actingId: `wsk_${who.webSessionId}`,
    keyId: null,
    webSessionId: who.webSessionId,
    published: `wsk_${who.webSessionId}`,
  };
}

function asApiKey(who: Identity | null): Actor {
  if (who === null) throw new Error('identity not seeded');
  return {
    label: 'an API key',
    bearer: who.apiKeyPlaintext,
    actingId: who.apiKeyId,
    keyId: who.apiKeyId,
    webSessionId: null,
    published: `key_${who.apiKeyId}`,
  };
}

/**
 * An account with an API key AND a signed-in web session, straight into the
 * database — the rows a real sign-in and a real mint leave behind. Legal
 * documents are accepted so the key-mint gate production wires is passed.
 */
async function seedIdentity(
  email: string,
  scopes: ApiKeyScope[],
  catalog: ReturnType<typeof buildLegalCatalog>,
): Promise<Identity> {
  const accountId = randomUUID();
  await sql()`
    INSERT INTO accounts (id, email, name, tier, status)
    VALUES (${accountId}::uuid, ${email}, 'Seeded', 'api_scale'::account_tier, 'active')`;

  const apiKeyPlaintext = generateApiKey('live');
  const [key] = await sql()<Array<{ id: string }>>`
    INSERT INTO api_keys (account_id, name, key_prefix, key_hash, scopes)
    VALUES (${accountId}::uuid, 'seeded', ${keyPrefixFromPlaintext(apiKeyPlaintext)},
            ${await hashApiKey(apiKeyPlaintext)}, ${sql().array(scopes)}::text[]::api_key_scope[])
    RETURNING id::text`;
  if (key === undefined) throw new Error('the API key was not seeded');

  // A web session token is opaque random bytes, looked up by its sha256.
  const webSessionToken = randomBytes(32).toString('base64url');
  const webSessionId = randomUUID();
  await sql()`
    INSERT INTO web_sessions (id, account_id, token_hash, expires_at, user_agent, last_used_at)
    VALUES (${webSessionId}::uuid, ${accountId}::uuid,
            ${createHash('sha256').update(webSessionToken).digest('hex')},
            ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz, 'vitest', now())`;

  for (const entry of catalog.entries()) {
    await sql()`
      INSERT INTO legal_acceptances (account_id, document_key, version, content_hash)
      VALUES (${accountId}::uuid, ${entry.documentKey}, ${entry.version}, ${entry.contentHash})`;
  }
  return { accountId, apiKeyId: key.id, apiKeyPlaintext, webSessionId, webSessionToken };
}

/** The whole app, wired the way bootstrap wires it, against the isolated database. */
async function buildRealApp(
  db: Database,
  creditsHarness: AdminCreditsHarness,
  catalog: ReturnType<typeof buildLegalCatalog>,
): Promise<App> {
  const logger = createTestLogger();
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
  return buildApp({
    logger,
    authRepo: new DrizzleAccountAuthRepo(db),
    authCache: null,
    authCoalescer: null,
    rateLimitStore: new MemoryRateLimitStore(),
    globalIpRateLimit: null,
    sessionsService: new SessionsService({
      repo: sessionsRepo,
      driver,
      webhooks: webhooksService,
      accountAudit: accountAuditService,
      accountLifecycle: accountLifecycleService,
    }),
    apiKeysService: new ApiKeysService(
      apiKeysRepo,
      null,
      webhooksService,
      legalService,
      accountAuditService,
    ),
    usageService: new UsageService(new DrizzleUsageRepo(db)),
    webhooksService,
    webhooksAdminService: new WebhooksAdminService(webhooksRepo),
    adminAuditService: new AdminAuditService(new DrizzleAdminAuditLogRepo(db)),
    accountsAdminService: new AccountsAdminService(
      new DrizzleAccountsAdminRepo(db, creditsHarness.overrides),
      null,
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
    staffEmails: new Set([OWNER_EMAIL]),
    ownerEmail: OWNER_EMAIL,
    permissiveCors: true,
  });
}

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME, 6);
  if (opened === null) return;
  client = opened.sql;
  database = createDb(opened.url, { max: 6 });
  harness = adminCreditsHarness(opened.url);
  const catalog = buildLegalCatalog({ repoRoot: REPO_ROOT });
  owner = await seedIdentity(OWNER_EMAIL, ['read', 'write', 'driftstack_internal_admin'], catalog);
  customer = await seedIdentity(CUSTOMER_EMAIL, ['read', 'write', 'account_owner'], catalog);
  app = await buildRealApp(database, harness, catalog);
}, 120_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await h()
    .base.database.close()
    .catch(() => {});
  await database?.close().catch(() => {});
  await client?.end({ timeout: 5 }).catch(() => {});
});

async function send(
  actor: Actor,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  payload?: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await theApp().inject({
    method,
    url,
    headers: { authorization: `Bearer ${actor.bearer}` },
    ...(payload === undefined ? {} : { payload }),
  });
  return { status: res.statusCode, body: res.body.length > 0 ? res.json() : null };
}

/**
 * The actor columns of every row matching `where`, as the database holds them.
 * `to_jsonb` rather than naming the columns, so the read is the same query
 * whatever the table's actor columns are called — the caller says which two to
 * compare.
 */
async function rowsOf(
  table: string,
  where: string,
  params: readonly string[],
): Promise<Array<Record<string, unknown>>> {
  const rows = await sql().unsafe<Array<{ row: Record<string, unknown> }>>(
    `SELECT to_jsonb(t) AS row FROM "${table}" t WHERE ${where} ORDER BY 1`,
    [...params],
  );
  return rows.map((r) => r.row);
}

function expectActor(
  rows: ReadonlyArray<Record<string, unknown>>,
  keyColumn: string,
  webSessionColumn: string,
  actor: Actor,
  what: string,
): void {
  expect(rows.length, `${what}: no row was written`).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row[keyColumn] ?? null, `${what}: ${keyColumn}`).toBe(actor.keyId);
    expect(row[webSessionColumn] ?? null, `${what}: ${webSessionColumn}`).toBe(actor.webSessionId);
  }
}

/** The admin audit rows for one action on one target, as the database holds them. */
async function adminAuditRows(
  action: string,
  target: { accountId?: string; resourceId?: string },
): Promise<Array<Record<string, unknown>>> {
  if (target.accountId !== undefined) {
    return rowsOf('admin_audit_log', `action::text = $1 AND target_account_id = $2::uuid`, [
      action,
      target.accountId,
    ]);
  }
  return rowsOf('admin_audit_log', `action::text = $1 AND target_resource_id = $2`, [
    action,
    target.resourceId ?? '',
  ]);
}

async function creditsAuditRows(
  action: string,
  target: { accountId?: string; resourceId?: string },
): Promise<Array<Record<string, unknown>>> {
  if (target.accountId !== undefined) {
    return rowsOf('ai_credits_admin_audit_log', `action = $1 AND target_account_id = $2::uuid`, [
      action,
      target.accountId,
    ]);
  }
  return rowsOf('ai_credits_admin_audit_log', `action = $1 AND target_resource_id = $2`, [
    action,
    target.resourceId ?? '',
  ]);
}

/** Every write below, once as a web session and once as an API key. */
function actors(): Actor[] {
  return [asWebSession(owner), asApiKey(owner)];
}

describe.skipIf(!RUN_DB_TESTS)(
  'an action taken from a signed-in browser is recorded against its web session',
  () => {
    it('the isolated database was rebuilt from the migrations, the app was built on it, and each caller authenticates as what it claims to be — otherwise every arm below would be measuring a 401', async () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
      expect(app).not.toBeNull();
      for (const actor of [...actors(), asWebSession(customer), asApiKey(customer)]) {
        const me = await send(actor, 'GET', '/v1/whoami');
        expect(me.status, `${actor.label} could not authenticate`).toBe(200);
      }
    });

    describe.each(['a web session', 'an API key'] as const)('as %s', (label) => {
      const actor = (): Actor => {
        const found = actors().find((a) => a.label === label);
        if (found === undefined) throw new Error(label);
        return found;
      };

      it('CRITICAL an admin tier change answers 200, the tier moves, and the audit row names the caller — in the table and on GET /v1/admin/audit-log', async () => {
        const target = await newTaskAccount(sql(), 'api_starter');
        const res = await send(actor(), 'POST', `/v1/admin/accounts/acc_${target}/tier`, {
          tier: 'api_builder',
          reason: 'web session attribution',
        });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const [account] = await sql()<Array<{ tier: string }>>`
          SELECT tier::text FROM accounts WHERE id = ${target}::uuid`;
        expect(account?.tier).toBe('api_builder');
        expectActor(
          await adminAuditRows('account.tier_changed', { accountId: target }),
          'admin_key_id',
          'admin_web_session_id',
          actor(),
          'admin_audit_log',
        );

        const listed = await send(
          actor(),
          'GET',
          `/v1/admin/audit-log?target_id=acc_${target}&action=account.tier_changed`,
        );
        expect(listed.status).toBe(200);
        const data = (listed.body as { data: Array<{ admin_key_id: string; result: string }> })
          .data;
        expect(data.map((e) => [e.admin_key_id, e.result])).toEqual([
          [actor().published, 'success'],
        ]);
      });

      it('CRITICAL the owner’s price edit answers 200, the price moves with the caller recorded on it, and it is audited', async () => {
        const cents = label === 'a web session' ? 4_900 : 5_100;
        const res = await send(actor(), 'PATCH', '/v1/admin/owner/pricing/api_starter', {
          monthly_cents: cents,
        });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const rows = await rowsOf('pricing', `tier = 'api_starter'`, []);
        expect(rows[0]?.monthly_cents).toBe(cents);
        expectActor(rows, 'updated_by_key_id', 'updated_by_web_session_id', actor(), 'pricing');
        const audits = (
          await adminAuditRows('pricing.updated', { resourceId: 'api_starter' })
        ).filter(
          (r) => (r.input_payload as { monthly_cents?: number } | null)?.monthly_cents === cents,
        );
        expectActor(audits, 'admin_key_id', 'admin_web_session_id', actor(), 'pricing.updated');
      });

      it('CRITICAL a platform secret is set (201) and revealed (200), the secret records the caller, and both are audited', async () => {
        const name = `web_session_actor_${label === 'a web session' ? 'ws' : 'key'}`;
        const set = await send(actor(), 'PUT', `/v1/admin/owner/secrets/${name}`, {
          value: 'not-a-real-secret',
          description: 'attribution probe',
        });
        expect(set.status, JSON.stringify(set.body)).toBe(201);
        expectActor(
          await rowsOf('platform_secrets', `name = $1`, [name]),
          'updated_by_key_id',
          'updated_by_web_session_id',
          actor(),
          'platform_secrets',
        );
        const revealed = await send(actor(), 'POST', `/v1/admin/owner/secrets/${name}/reveal`);
        expect(revealed.status, JSON.stringify(revealed.body)).toBe(200);
        expectActor(
          await adminAuditRows('secret.created', { resourceId: name }),
          'admin_key_id',
          'admin_web_session_id',
          actor(),
          'secret.created',
        );
        expectActor(
          await adminAuditRows('secret.revealed', { resourceId: name }),
          'admin_key_id',
          'admin_web_session_id',
          actor(),
          'secret.revealed',
        );
      });

      it('CRITICAL a rate-limit override is set (200), records the caller, is audited, and GET /v1/admin/rate-limit-overrides names the caller the way the auth context did', async () => {
        const target = await newTaskAccount(sql(), 'api_starter');
        const res = await send(actor(), 'POST', `/v1/admin/accounts/acc_${target}/quota-override`, {
          bucket_key: 'global',
          capacity: 50,
          refill_per_second: 2,
          duration_seconds: 3600,
          reason: 'attribution probe',
        });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expectActor(
          await rowsOf('rate_limit_overrides', `account_id = $1::uuid`, [target]),
          'set_by_key_id',
          'set_by_web_session_id',
          actor(),
          'rate_limit_overrides',
        );
        expectActor(
          await adminAuditRows('rate_limit_override.set', { accountId: target }),
          'admin_key_id',
          'admin_web_session_id',
          actor(),
          'rate_limit_override.set',
        );
        const listed = await send(
          actor(),
          'GET',
          `/v1/admin/rate-limit-overrides?account_id=acc_${target}`,
        );
        expect(listed.status).toBe(200);
        expect(
          (listed.body as { data: Array<{ set_by_key_id: string }> }).data.map(
            (o) => o.set_by_key_id,
          ),
        ).toEqual([actor().published]);
      });

      it('CRITICAL an incident is created (201) and updated (201), the incident and both timeline rows record the caller, and both are audited', async () => {
        const created = await send(actor(), 'POST', '/v1/admin/incidents', {
          title: `attribution probe (${label})`,
          description: 'An incident opened to prove who opened it.',
          severity: 'minor',
          public: false,
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const incidentId = (created.body as { incident: { id: string } }).incident.id.replace(
          /^inc_/,
          '',
        );
        const updated = await send(
          actor(),
          'POST',
          `/v1/admin/incidents/inc_${incidentId}/updates`,
          {
            message: 'Still looking.',
            status: 'identified',
          },
        );
        expect(updated.status, JSON.stringify(updated.body)).toBe(201);
        expectActor(
          await rowsOf('incidents', `id = $1::uuid`, [incidentId]),
          'created_by_admin_key_id',
          'created_by_admin_web_session_id',
          actor(),
          'incidents',
        );
        const updates = await rowsOf('incident_updates', `incident_id = $1::uuid`, [incidentId]);
        expect(updates, 'the initial update and the posted one').toHaveLength(2);
        expectActor(
          updates,
          'posted_by_admin_key_id',
          'posted_by_admin_web_session_id',
          actor(),
          'incident_updates',
        );
        for (const action of ['incident.created', 'incident.updated']) {
          expectActor(
            await adminAuditRows(action, { resourceId: `inc_${incidentId}` }),
            'admin_key_id',
            'admin_web_session_id',
            actor(),
            action,
          );
        }
      });

      it('CRITICAL an AI-credits goodwill grant answers 200, the lot exists, and its in-transaction audit row names the caller', async () => {
        const target = await newTaskAccount(sql(), 'team_manual');
        const res = await send(
          actor(),
          'POST',
          `/v1/admin/accounts/acc_${target}/credits/adjustments`,
          {
            kind: 'goodwill',
            credits: 25,
            expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
            reason: 'attribution probe',
            idempotency_key: `goodwill-${randomUUID()}`,
          },
        );
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const [lots] = await sql()<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM credit_lots WHERE account_id = ${target}::uuid`;
        expect(lots?.n).toBe(1);
        expectActor(
          await creditsAuditRows('credits.goodwill_granted', { accountId: target }),
          'admin_key_id',
          'admin_web_session_id',
          actor(),
          'credits.goodwill_granted',
        );
      });

      it('CRITICAL an AI plan override is set (200), records the caller, and is audited', async () => {
        const target = await newTaskAccount(sql(), 'team_manual');
        const res = await send(
          actor(),
          'PUT',
          `/v1/admin/accounts/acc_${target}/ai-plan-override`,
          {
            monthly_credits: 5000,
            reason: 'contract',
          },
        );
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expectActor(
          await rowsOf('credit_plan_overrides', `account_id = $1::uuid`, [target]),
          'set_by_key_id',
          'set_by_web_session_id',
          actor(),
          'credit_plan_overrides',
        );
        expectActor(
          await creditsAuditRows('credits.plan_override_set', { accountId: target }),
          'admin_key_id',
          'admin_web_session_id',
          actor(),
          'credits.plan_override_set',
        );
      });

      it('CRITICAL the owner publishes a rate card (200), the card records the caller, and it is audited', async () => {
        const days = label === 'a web session' ? 31 : 32;
        const res = await send(actor(), 'POST', '/v1/admin/credit-rate-cards', {
          markup_bp: 20000,
          effective_at: new Date(Date.now() + days * 24 * 3600 * 1000).toISOString(),
        });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const version = (res.body as { version: number }).version;
        expectActor(
          await rowsOf('credit_rate_cards', `version = $1::int`, [String(version)]),
          'created_by_key_id',
          'created_by_web_session_id',
          actor(),
          'credit_rate_cards',
        );
        expectActor(
          await creditsAuditRows('rate_card.published', { resourceId: `rate_card_${version}` }),
          'admin_key_id',
          'admin_web_session_id',
          actor(),
          'rate_card.published',
        );
      });

      it('CRITICAL a real cutover run moves the account (200, billing_mode credits) and its in-transaction audit row names the caller', async () => {
        const target = randomUUID();
        const email = `cutover-${target}@example.test`;
        h().internalEmails.add(email);
        await sql()`
          INSERT INTO accounts (id, email, tier) VALUES (${target}::uuid, ${email}, 'api_starter'::account_tier)`;
        await sql()`INSERT INTO credit_accounts (account_id) VALUES (${target}::uuid)`;
        const subscriptionId = await subscription(sql(), target, { tier: 'api_starter' });
        await paidLine(sql(), target, { subscriptionId, tier: 'api_starter' });

        const dry = await send(actor(), 'POST', '/v1/admin/ai-credits/cutover', {
          account_ids: [`acc_${target}`],
          to: 'credits',
          dry_run: true,
        });
        expect(dry.status, JSON.stringify(dry.body)).toBe(200);
        const run = await send(actor(), 'POST', '/v1/admin/ai-credits/cutover', {
          account_ids: [`acc_${target}`],
          to: 'credits',
          dry_run: false,
        });
        expect(run.status, JSON.stringify(run.body)).toBe(200);
        expect((run.body as { summary: { moved: number } }).summary.moved).toBe(1);
        const [row] = await sql()<Array<{ billing_mode: string }>>`
          SELECT billing_mode FROM credit_accounts WHERE account_id = ${target}::uuid`;
        expect(row?.billing_mode).toBe('credits');
        expectActor(
          await creditsAuditRows('credits.cutover_moved', { accountId: target }),
          'admin_key_id',
          'admin_web_session_id',
          actor(),
          'credits.cutover_moved',
        );
      });
    });

    describe('the customer side', () => {
      it('CRITICAL an API key minted from the dashboard (201) leaves a "Recent activity" row that names the web session in the table and publishes actor_key_id null — it was not a key', async () => {
        const actor = asWebSession(customer);
        const res = await send(actor, 'POST', '/v1/api-keys', {
          name: 'minted from the dashboard',
          scopes: ['read'],
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        const mintedId = (res.body as { id: string }).id;
        const rows = await rowsOf(
          'account_audit_log',
          `action = 'api_key.minted' AND target_resource_id = $1`,
          [mintedId],
        );
        expect(rows, 'the row the swallowed audit write used to lose').toHaveLength(1);
        expectActor(rows, 'actor_key_id', 'actor_web_session_id', actor, 'account_audit_log');

        const listed = await send(actor, 'GET', '/v1/account/audit-log?action=api_key.minted');
        expect(listed.status).toBe(200);
        const entries = (
          listed.body as {
            data: Array<{ target_resource_id: string | null; actor_key_id: string | null }>;
          }
        ).data.filter((e) => e.target_resource_id === mintedId);
        expect(entries.map((e) => e.actor_key_id)).toEqual([null]);
      });

      it('starting an automation session from a signed-in browser is refused with a 403 that says to use an API key, and creates nothing — it used to fail at the insert with a 500', async () => {
        const before = await rowsOf('sessions', `account_id = $1`, [customer?.accountId ?? '']);
        const res = await send(asWebSession(customer), 'POST', '/v1/sessions', {});
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect((res.body as { detail?: string }).detail).toMatch(/API key/);
        const after = await rowsOf('sessions', `account_id = $1`, [customer?.accountId ?? '']);
        expect(after).toHaveLength(before.length);
      });

      it('CRITICAL the same mint with an API key still names the key, and publishes it as key_<uuid>', async () => {
        const actor = asApiKey(customer);
        const res = await send(actor, 'POST', '/v1/api-keys', {
          name: 'minted with a key',
          scopes: ['read'],
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        const mintedId = (res.body as { id: string }).id;
        const rows = await rowsOf(
          'account_audit_log',
          `action = 'api_key.minted' AND target_resource_id = $1`,
          [mintedId],
        );
        expectActor(rows, 'actor_key_id', 'actor_web_session_id', actor, 'account_audit_log');
        const listed = await send(actor, 'GET', '/v1/account/audit-log?action=api_key.minted');
        const entries = (
          listed.body as {
            data: Array<{ target_resource_id: string | null; actor_key_id: string | null }>;
          }
        ).data.filter((e) => e.target_resource_id === mintedId);
        expect(entries.map((e) => e.actor_key_id)).toEqual([`key_${customer?.apiKeyId ?? ''}`]);
      });
    });

    it('an audit row outlives the web session it names: once the session row is gone (it is deleted with its account; the column has no foreign key), the audit row stays and still reads back as wsk_<uuid>', async () => {
      const target = await newTaskAccount(sql(), 'api_starter');
      // Only the owner is staff, so the web session that acts is a second one of
      // the owner's, whose row is then deleted outright.
      const token = randomBytes(32).toString('base64url');
      const sessionId = randomUUID();
      await sql()`
        INSERT INTO web_sessions (id, account_id, token_hash, expires_at, user_agent, last_used_at)
        VALUES (${sessionId}::uuid, ${owner?.accountId ?? ''}::uuid,
                ${createHash('sha256').update(token).digest('hex')},
                ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz, 'vitest', now())`;
      const res = await theApp().inject({
        method: 'POST',
        url: `/v1/admin/accounts/acc_${target}/suspend`,
        headers: { authorization: `Bearer ${token}` },
        payload: { reason: 'attribution probe' },
      });
      expect(res.statusCode, res.body).toBe(200);
      await sql()`DELETE FROM web_sessions WHERE id = ${sessionId}::uuid`;

      const listed = await send(
        asApiKey(owner),
        'GET',
        `/v1/admin/audit-log?target_id=acc_${target}&action=account.suspended`,
      );
      expect(listed.status).toBe(200);
      expect(
        (listed.body as { data: Array<{ admin_key_id: string }> }).data.map((e) => e.admin_key_id),
      ).toEqual([`wsk_${sessionId}`]);
    });
  },
);
