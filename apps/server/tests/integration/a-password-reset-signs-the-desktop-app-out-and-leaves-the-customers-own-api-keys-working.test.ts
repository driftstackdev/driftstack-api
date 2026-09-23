// A password reset signs the desktop app out, and leaves the customer's own API
// keys working.
//
// A reset is how a customer recovers from a stolen credential, and the docs say
// it "invalidates ALL prior sessions… Every prior device must re-authenticate"
// (apps/docs/src/pages/api/auth.md). The desktop app does not hold a web
// session: its sign-in is an API key minted by the device-code flow
// (`provenance = 'cli_device'`). The reset revoked only web sessions, so a stolen
// desktop credential kept working after it — with `account_owner`, able to run
// sessions and agent tasks — and the only way out was to find it by hand on the
// API keys page. (Identity-shape audit, finding 1: `F7 after password reset:
// browser 401 | desktop device credential 200 | device starts a session 201`.)
//
// The keys a customer minted themselves (provenance NULL) are integrations, not
// devices, and the reset does not promise them: they stay working. Another
// account's desktop credential is untouched.
//
// Runs through the whole app on a freshly migrated database of its own, with an
// auth cache, so the cached authentication path is exercised too.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, type Database } from '../../src/db/client.js';
import { createTestLogger } from '../../src/lib/logger.js';
import { InMemoryAuthCache } from '../../src/services/auth-cache.js';
import { AuthFlowsService } from '../../src/services/auth-flows.js';
import { createEmailService } from '../../src/services/email.js';
import { InMemoryMfaChallengeStore } from '../../src/services/mfa-challenge-store.js';
import { buildLegalCatalog } from '../../src/services/legal-catalog.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import { InMemoryAuthFlowsRepo } from './_helpers/in-memory-auth-flows-repo.js';
import {
  adminCreditsHarness,
  type AdminCreditsHarness,
} from './_helpers/admin-credits-route-fixtures.js';
import {
  accountAuditRows,
  buildRealApp,
  seedAccount,
  seedApiKey,
  seedWebSession,
  send,
  type RealApp,
  type SeededKey,
  type SeededWebSession,
} from './_helpers/real-app-with-signed-in-identities.js';

const ISOLATED_DB_NAME = 'driftstack_iso_identity_reset';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Records every invalidation, so the test can see the reset asked for them. */
class RecordingAuthCache extends InMemoryAuthCache {
  readonly invalidatedKeys: string[] = [];
  readonly invalidatedAccounts: string[] = [];
  override async invalidateKey(keyId: string): Promise<void> {
    this.invalidatedKeys.push(keyId);
    await super.invalidateKey(keyId);
  }
  override async invalidateAccount(accountId: string): Promise<void> {
    this.invalidatedAccounts.push(accountId);
    await super.invalidateAccount(accountId);
  }
}

interface Customer {
  readonly accountId: string;
  readonly email: string;
  readonly browser: SeededWebSession;
  readonly desktop: SeededKey;
  readonly secondDesktop: SeededKey;
  readonly integration: SeededKey;
}

let client: postgres.Sql | null = null;
let database: Database | null = null;
let harness: AdminCreditsHarness | null = null;
let app: RealApp | null = null;
let cache: RecordingAuthCache | null = null;
let customer: Customer | null = null;
let bystanderDesktop: SeededKey | null = null;

function sql(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}
function theApp(): RealApp {
  if (app === null) throw new Error('the app was not built');
  return app;
}
function who(): Customer {
  if (customer === null) throw new Error('customer not seeded');
  return customer;
}

/** The desktop app's credential, as the device-code sign-in mints it. */
const DEVICE_SCOPES = ['read', 'write', 'account_owner'] as const;

async function seedCustomer(
  catalog: ReturnType<typeof buildLegalCatalog>,
  email: string,
): Promise<Customer> {
  const accountId = await seedAccount(sql(), email, catalog);
  return {
    accountId,
    email,
    browser: await seedWebSession(sql(), accountId),
    desktop: await seedApiKey(sql(), accountId, {
      scopes: [...DEVICE_SCOPES],
      name: 'Desktop client',
      provenance: 'cli_device',
    }),
    secondDesktop: await seedApiKey(sql(), accountId, {
      scopes: [...DEVICE_SCOPES],
      name: 'Desktop client',
      provenance: 'cli_device',
    }),
    integration: await seedApiKey(sql(), accountId, {
      scopes: ['read', 'write', 'account_owner'],
      name: 'CI integration',
      provenance: null,
    }),
  };
}

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME, 6);
  if (opened === null) return;
  client = opened.sql;
  database = createDb(opened.url, { max: 6 });
  harness = adminCreditsHarness(opened.url);
  const catalog = buildLegalCatalog({ repoRoot: REPO_ROOT });
  customer = await seedCustomer(catalog, `reset-${randomUUID()}@example.test`);
  const bystander = await seedCustomer(catalog, `bystander-${randomUUID()}@example.test`);
  bystanderDesktop = bystander.desktop;
  cache = new RecordingAuthCache();
  app = await buildRealApp(database, harness, catalog, {
    staffEmails: new Set(),
    authCache: cache,
  });
}, 120_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await harness?.base.database.close().catch(() => {});
  await database?.close().catch(() => {});
  await client?.end({ timeout: 5 }).catch(() => {});
});

describe.skipIf(!RUN_DB_TESTS)(
  'a password reset signs the desktop app out and leaves the customer’s own API keys working',
  () => {
    let resetSession = '';

    it('before the reset every credential works — twice each, so the second request is a cache hit — otherwise the arms below would be measuring a 401 that was always there', async () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
      const c = who();
      for (const bearer of [
        c.browser.token,
        c.desktop.plaintext,
        c.secondDesktop.plaintext,
        c.integration.plaintext,
        bystanderDesktop?.plaintext ?? '',
      ]) {
        for (let i = 0; i < 2; i++) {
          const me = await send(theApp(), bearer, 'GET', '/v1/whoami');
          expect(me.status).toBe(200);
        }
      }
    });

    it('the customer’s integration subscribes to api_key.revoked', async () => {
      const created = await send(theApp(), who().integration.plaintext, 'POST', '/v1/webhooks', {
        url: 'https://hooks.example.test/driftstack',
        events: ['api_key.revoked'],
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
    });

    it('the reset itself answers 200 with a new signed-in session', async () => {
      const c = who();
      const requested = await theApp().inject({
        method: 'POST',
        url: '/v1/auth/password-reset/request',
        payload: { email: c.email },
      });
      expect(requested.statusCode, requested.body).toBe(200);
      const token = requested.json<{ debug_token?: string }>().debug_token;
      expect(token, 'the debug token the reset link carries').toBeTypeOf('string');
      const confirmed = await theApp().inject({
        method: 'POST',
        url: '/v1/auth/password-reset/confirm',
        payload: { token, new_password: 'a brand new passphrase for this account' },
      });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      resetSession = confirmed.json<{ session?: { token?: string } }>().session?.token ?? '';
      expect(resetSession.length, JSON.stringify(confirmed.json())).toBeGreaterThan(0);
    });

    it('CRITICAL after the reset the desktop app’s credentials are refused — both of them, on the cached path too — and the old browser session is refused', async () => {
      const c = who();
      for (const [label, bearer] of [
        ['the old browser session', c.browser.token],
        ['the desktop app', c.desktop.plaintext],
        ['a second desktop install', c.secondDesktop.plaintext],
      ] as const) {
        const me = await send(theApp(), bearer, 'GET', '/v1/whoami');
        expect(me.status, `${label} still authenticates after the reset`).toBe(401);
      }
      const start = await send(theApp(), c.desktop.plaintext, 'POST', '/v1/sessions', {});
      expect(start.status, 'the stolen desktop credential can still start a session').toBe(401);
    });

    it('CRITICAL the customer’s own integration key, the new session, and another account’s desktop app keep working', async () => {
      const c = who();
      expect((await send(theApp(), c.integration.plaintext, 'GET', '/v1/whoami')).status).toBe(200);
      expect((await send(theApp(), resetSession, 'GET', '/v1/whoami')).status).toBe(200);
      expect(
        (await send(theApp(), bystanderDesktop?.plaintext ?? '', 'GET', '/v1/whoami')).status,
      ).toBe(200);
    });

    it('the database holds exactly that: the two desktop credentials revoked at the moment the browser session was, the integration key and the other account’s desktop credential not revoked', async () => {
      const c = who();
      const keys = await sql()<Array<{ id: string; revoked_at: Date | null }>>`
        SELECT id::text, revoked_at FROM api_keys
         WHERE id = ANY(${sql().array([
           c.desktop.id,
           c.secondDesktop.id,
           c.integration.id,
           bystanderDesktop?.id ?? '',
         ])}::uuid[])
         ORDER BY id`;
      const revoked = new Map(keys.map((k) => [k.id, k.revoked_at]));
      const [browser] = await sql()<Array<{ revoked_at: Date | null }>>`
        SELECT revoked_at FROM web_sessions WHERE id = ${c.browser.id}::uuid`;
      expect(browser?.revoked_at).not.toBeNull();
      // One revocation, one instant: the sessions and the device credentials go together.
      expect(revoked.get(c.desktop.id)?.toISOString()).toBe(browser?.revoked_at?.toISOString());
      expect(revoked.get(c.secondDesktop.id)?.toISOString()).toBe(
        browser?.revoked_at?.toISOString(),
      );
      expect(revoked.get(c.integration.id)).toBeNull();
      expect(revoked.get(bystanderDesktop?.id ?? '')).toBeNull();
    });

    it('each revoked desktop credential leaves one "Recent activity" row, attributed the way the reset’s own sign-out is, and its cache entry is dropped', async () => {
      const c = who();
      const rows = await accountAuditRows(sql(), c.accountId, 'api_key.revoked');
      expect(rows.map((r) => r.target_resource_id).sort()).toEqual(
        [`key_${c.desktop.id}`, `key_${c.secondDesktop.id}`].sort(),
      );
      const [signOut] = await accountAuditRows(sql(), c.accountId, 'account.logout');
      expect(signOut?.payload?.revoked_via).toBe('password_reset');
      for (const row of rows) {
        expect(row.actor_type).toBe(signOut?.actor_type);
        expect(row.actor_account_id).toBe(signOut?.actor_account_id);
        expect(row.actor_key_id).toBeNull();
        expect(row.actor_web_session_id).toBeNull();
        expect(row.payload?.revoked_via).toBe('password_reset');
      }
      expect(cache?.invalidatedKeys).toEqual(
        expect.arrayContaining([c.desktop.id, c.secondDesktop.id]),
      );
      expect(cache?.invalidatedKeys).not.toContain(c.integration.id);
    });

    it('CRITICAL each revoked desktop credential sends the api_key.revoked webhook once, with the payload an ordinary revocation carries', async () => {
      const c = who();
      const deliveries = await sql()<
        Array<{ type: string; data: { api_key_id: string; name: string; revoked_at: string } }>
      >`
        SELECT d.payload->>'type' AS type, d.payload->'data' AS data
          FROM webhook_deliveries d
          JOIN webhook_endpoints e ON e.id = d.webhook_id
         WHERE e.account_id = ${c.accountId}::uuid AND d.event_type = 'api_key.revoked'
         ORDER BY d.payload->'data'->>'api_key_id'`;
      const [key] = await sql()<Array<{ revoked_at: Date }>>`
        SELECT revoked_at FROM api_keys WHERE id = ${c.desktop.id}::uuid`;
      const revokedAt = key?.revoked_at.toISOString() ?? 'not revoked';
      expect(deliveries).toEqual(
        [c.desktop.id, c.secondDesktop.id].sort().map((id) => ({
          type: 'api_key.revoked',
          data: { api_key_id: `key_${id}`, name: 'Desktop client', revoked_at: revokedAt },
        })),
      );
    });
  },
);

// The MFA-enrolled branch keeps no session (the reset mints none until the
// challenge is passed), so it revokes through the same helper with nothing
// kept. It needs no database: the in-memory repo applies the same predicates.
describe('with MFA enrolled, a password reset signs the desktop app out too', () => {
  it('the challenge is issued, every web session and desktop credential of the account is revoked, and the integration key and another account’s desktop credential are not', async () => {
    const repo = new InMemoryAuthFlowsRepo();
    const accountId = randomUUID();
    const otherAccountId = randomUUID();
    repo.seedAccount({
      id: accountId,
      email: `mfa-reset-${accountId}@example.test`,
      name: null,
      passwordHash: null,
      emailVerifiedAt: new Date(),
      tier: 'api_scale',
      status: 'active',
      authEpoch: 0,
      createdAt: new Date(),
    });
    const at = new Date(Date.now() + 86_400_000);
    await repo.insertWebSession({
      accountId,
      tokenHash: 'old-browser',
      authEpoch: 0,
      expiresAt: at,
      issuedFromIp: null,
      userAgent: 'old-browser',
    });
    const key = (id: string, owner: string, provenance: string | null, extra = {}) => ({
      id,
      accountId: owner,
      name: provenance === 'cli_device' ? 'Desktop client' : 'integration',
      provenance,
      revokedAt: null,
      expiresAt: null,
      ...extra,
    });
    repo.seedApiKey(key('desktop', accountId, 'cli_device'));
    repo.seedApiKey(key('integration', accountId, null));
    repo.seedApiKey(key('elsewhere', otherAccountId, 'cli_device'));
    const expiredAt = new Date(Date.now() - 1_000);
    repo.seedApiKey(key('expired-desktop', accountId, 'cli_device', { expiresAt: expiredAt }));

    const logger = createTestLogger();
    const cache = new InMemoryAuthCache();
    const invalidateKey = vi.spyOn(cache, 'invalidateKey');
    const service = new AuthFlowsService(
      repo,
      createEmailService({ config: null, logger }),
      logger,
      {
        verifyEmailUrl: 'https://app.driftstack.local/verify-email',
        magicLinkUrl: 'https://app.driftstack.local/auth/magic-link',
        passwordResetUrl: 'https://app.driftstack.local/reset-password',
        exposeDebugToken: true,
      },
      cache,
      null,
      {
        getStatus: vi.fn().mockResolvedValue({
          enrolled: true,
          enrolledAt: new Date(),
          lastUsedAt: null,
          unusedRecoveryCodes: 10,
        }),
        verifyCode: vi.fn().mockResolvedValue('totp'),
      } as never,
      new InMemoryMfaChallengeStore(),
    );
    const requested = await service.requestPasswordReset({
      email: `mfa-reset-${accountId}@example.test`,
      requestedFromIp: null,
    });
    const result = await service.confirmPasswordReset({
      token: requested.debugToken as string,
      newPassword: 'a brand new passphrase for this account',
      issuedFromIp: null,
      userAgent: null,
    });

    expect(result.kind).toBe('mfa_required');
    expect(await repo.listActiveWebSessionsForAccount(accountId, new Date())).toEqual([]);
    expect(repo.apiKey('desktop')?.revokedAt).not.toBeNull();
    expect(repo.apiKey('integration')?.revokedAt).toBeNull();
    expect(repo.apiKey('elsewhere')?.revokedAt).toBeNull();
    // Already unusable, so not revoked again and not announced.
    expect(repo.apiKey('expired-desktop')?.revokedAt).toBeNull();
    expect(invalidateKey.mock.calls.map(([id]) => id)).toEqual(['desktop']);
  });
});
