// A removed linked sign-in is deleted from the database, unless it is the last
// way in.
//
// Sign-in audit, finding 5 — the database half. The route and the sign-in half
// run in-memory in a-linked-google-or-github-sign-in-can-be-removed-and-then-no-
// longer-signs-in.test.ts; this file runs DELETE /v1/account/me/oauth-links/:id
// through the whole app on a real database, so the Drizzle statement — the
// ownership scope, the last-way-in check under a row lock, and the delete — is
// what answers.
//
// The removal DELETES the row rather than stamping `last_revoked_at`: a stamped
// row would keep the (provider, provider_sub) pair taken forever, so the identity
// could never be linked again, not even through the emailed merge confirmation.
// After the delete, the production link lookup finds nothing and the OAuth
// service routes that identity to the merge confirmation — no session.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../src/db/client.js';
import { buildLegalCatalog } from '../../src/services/legal-catalog.js';
import {
  DrizzleOAuthLinksRepo,
  DrizzleOAuthPendingLinksRepo,
} from '../../src/db/oauth-links-repo.js';
import { OAuthClientServiceImpl } from '../../src/services/oauth-client-service.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
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
} from './_helpers/real-app-with-signed-in-identities.js';

const ISOLATED_DB_NAME = 'driftstack_iso_signin_link_removal';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

let client: postgres.Sql | null = null;
let database: Database | null = null;
let harness: AdminCreditsHarness | null = null;
let app: RealApp | null = null;
let catalog: ReturnType<typeof buildLegalCatalog> | null = null;

function sql(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}
function theApp(): RealApp {
  if (app === null) throw new Error('the app was not built');
  return app;
}
function db(): Database {
  if (database === null) throw new Error('database not opened');
  return database;
}

/** An account, with or without a password, and a signed-in browser. */
async function customer(password: 'set' | 'none'): Promise<{
  accountId: string;
  email: string;
  session: string;
}> {
  if (catalog === null) throw new Error('catalog not built');
  const email = `links-${randomUUID()}@example.test`;
  const accountId = await seedAccount(sql(), email, catalog, 'free');
  await sql()`
    UPDATE accounts SET password_hash = ${password === 'set' ? 'scrypt$placeholder' : ''},
                        email_verified_at = now()
     WHERE id = ${accountId}::uuid`;
  const session = await seedWebSession(sql(), accountId);
  return { accountId, email, session: session.token };
}

async function link(
  accountId: string,
  provider: 'github' | 'google',
  sub: string,
  email: string,
  revoked = false,
): Promise<string> {
  const [row] = await sql()<Array<{ id: string }>>`
    INSERT INTO account_oauth_links (account_id, provider, provider_sub, provider_email, last_revoked_at)
    VALUES (${accountId}::uuid, ${provider}, ${sub}, ${email}, ${revoked ? new Date().toISOString() : null}::timestamptz)
    RETURNING id::text`;
  if (row === undefined) throw new Error('link not inserted');
  return row.id;
}

async function linkIds(accountId: string): Promise<string[]> {
  const rows = await sql()<Array<{ id: string }>>`
    SELECT id::text FROM account_oauth_links WHERE account_id = ${accountId}::uuid ORDER BY id`;
  return rows.map((r) => r.id);
}

function remove(bearer: string, linkId: string): Promise<{ status: number; body: unknown }> {
  return send(theApp(), bearer, 'DELETE', `/v1/account/me/oauth-links/ol_${linkId}`);
}

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME, 6);
  if (opened === null) return;
  client = opened.sql;
  database = createDb(opened.url, { max: 6 });
  harness = adminCreditsHarness(opened.url);
  catalog = buildLegalCatalog({ repoRoot: REPO_ROOT });
  app = await buildRealApp(database, harness, catalog, { staffEmails: new Set() });
}, 120_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await harness?.base.database.close().catch(() => {});
  await database?.close().catch(() => {});
  await client?.end({ timeout: 5 }).catch(() => {});
});

describe.skipIf(!RUN_DB_TESTS)(
  'a removed linked sign-in is deleted from the database, unless it is the last way in',
  () => {
    it('the isolated database is reachable', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    it('CRITICAL the link row is deleted, the production lookup no longer finds the identity, and the OAuth service sends it to the merge confirmation instead of signing it in', async () => {
      const c = await customer('set');
      const sub = `gh-${randomUUID()}`;
      const linkId = await link(c.accountId, 'github', sub, c.email);
      const links = new DrizzleOAuthLinksRepo(db());
      expect((await links.findByProviderSub('github', sub))?.id).toBe(linkId);

      const res = await remove(c.session, linkId);
      expect(res.status, JSON.stringify(res.body)).toBe(204);
      expect(await linkIds(c.accountId)).toEqual([]);
      expect(await links.findByProviderSub('github', sub)).toBeNull();

      const service = new OAuthClientServiceImpl({
        links,
        pending: new DrizzleOAuthPendingLinksRepo(db()),
        accounts: {
          findIdByEmail: (email) =>
            Promise.resolve(email.toLowerCase() === c.email ? c.accountId : null),
          createFromIdp: () => Promise.reject(new Error('no account should be created')),
        },
        mailer: { sendVerifyMergeEmail: () => Promise.resolve() },
      });
      const outcome = await service.linkOrCreateAccount({
        provider: 'github',
        providerSub: sub,
        email: c.email,
        name: null,
        avatarUrl: null,
      });
      expect(outcome.kind).toBe('collision-pending-verification');
    });

    it('the removal leaves one "Recent activity" row on the account, attributed to the customer', async () => {
      const c = await customer('set');
      const linkId = await link(c.accountId, 'google', `g-${randomUUID()}`, c.email);
      expect((await remove(c.session, linkId)).status).toBe(204);
      const rows = await accountAuditRows(sql(), c.accountId, 'account.oauth_link_removed');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor_type).toBe('customer');
      expect(rows[0]?.actor_account_id).toBe(c.accountId);
      expect(rows[0]?.target_resource_id).toBe(`ol_${linkId}`);
      expect(rows[0]?.payload?.provider).toBe('google');
    });

    it('CRITICAL no password and one working link: refused with 409, the row stays', async () => {
      const c = await customer('none');
      const linkId = await link(c.accountId, 'github', `gh-${randomUUID()}`, c.email);
      const res = await remove(c.session, linkId);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(await linkIds(c.accountId)).toEqual([linkId]);
      expect(await accountAuditRows(sql(), c.accountId, 'account.oauth_link_removed')).toEqual([]);
    });

    it('no password, a working link and one the provider already revoked: the revoked one can go, the working one then cannot', async () => {
      const c = await customer('none');
      const working = await link(c.accountId, 'github', `gh-${randomUUID()}`, c.email);
      const revoked = await link(c.accountId, 'google', `g-${randomUUID()}`, c.email, true);
      expect((await remove(c.session, revoked)).status).toBe(204);
      expect((await remove(c.session, working)).status).toBe(409);
      expect(await linkIds(c.accountId)).toEqual([working]);
    });

    it('no password and two working links: one can go, the last cannot', async () => {
      const c = await customer('none');
      const a = await link(c.accountId, 'github', `gh-${randomUUID()}`, c.email);
      const b = await link(c.accountId, 'google', `g-${randomUUID()}`, c.email);
      expect((await remove(c.session, a)).status).toBe(204);
      expect((await remove(c.session, b)).status).toBe(409);
      expect(await linkIds(c.accountId)).toEqual([b]);
    });

    it('another account’s link is 404 and untouched; an API key of the owner is refused', async () => {
      const owner = await customer('set');
      const stranger = await customer('set');
      const linkId = await link(owner.accountId, 'github', `gh-${randomUUID()}`, owner.email);
      expect((await remove(stranger.session, linkId)).status).toBe(404);
      const key = await seedApiKey(sql(), owner.accountId, {
        scopes: ['read', 'write', 'account_owner'],
      });
      expect((await remove(key.plaintext, linkId)).status).toBe(403);
      expect(await linkIds(owner.accountId)).toEqual([linkId]);
    });
  },
);
