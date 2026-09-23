// An admin API key works only while its account is on the staff list.
//
// `DRIFTSTACK_STAFF_EMAILS` is how staff are added and removed
// (docs/deployment/env-vars.md): an account on it gets `driftstack_internal_admin`
// — cross-account admin — when it signs in to the admin panel. But the list was
// consulted only for web sessions. A staff member's browser can mint an API key
// that CARRIES `driftstack_internal_admin`, and that key kept full admin after the
// person was taken off the list and the server restarted: removing someone from
// the list removed their browser's access and left their key's. (Identity-shape
// audit, finding 5: `F6 after de-listing: browser 403 | minted staff key 200 |
// suspend another customer with it 200`.)
//
// So on the API-key path — the slow path AND the cached path —
// `driftstack_internal_admin` is honoured only while the key's account is on the
// list (the owner always is). A key carrying it on an account off the list is an
// ordinary customer key. And a key with that scope cannot be minted onto an
// account off the list, where it could never be used.
//
// A de-listing is a restart with a different list, so the same database is
// served by two apps: one booted with the staff member listed, one without.
// Both have an auth cache and every check is made twice, so the second request
// is a cache hit.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../src/db/client.js';
import { InMemoryAuthCache } from '../../src/services/auth-cache.js';
import { buildLegalCatalog } from '../../src/services/legal-catalog.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import { newTaskAccount } from './_helpers/credit-reservation-fixtures.js';
import {
  adminCreditsHarness,
  type AdminCreditsHarness,
} from './_helpers/admin-credits-route-fixtures.js';
import {
  buildRealApp,
  seedAccount,
  seedApiKey,
  seedWebSession,
  send,
  type RealApp,
  type SeededKey,
} from './_helpers/real-app-with-signed-in-identities.js';

const ISOLATED_DB_NAME = 'driftstack_iso_identity_staff_list';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const OWNER_EMAIL = `owner-${randomUUID()}@driftstack.test`;
const STAFF_EMAIL = `staff-${randomUUID()}@driftstack.test`;

let client: postgres.Sql | null = null;
let database: Database | null = null;
let harness: AdminCreditsHarness | null = null;
/** Booted with the staff member on the list. */
let listed: RealApp | null = null;
/** The same database after a restart with the staff member removed. */
let delisted: RealApp | null = null;

let staffAccountId = '';
let staffKey: SeededKey | null = null;
let staffBrowser = '';
let ownerKey: SeededKey | null = null;
/** A customer the staff member is a team admin of — not on the list. */
let teamOwnerId = '';

function sql(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}
function app(which: 'listed' | 'delisted'): RealApp {
  const found = which === 'listed' ? listed : delisted;
  if (found === null) throw new Error('the app was not built');
  return found;
}

const ADMIN_SCOPES = ['read', 'write', 'account_owner', 'driftstack_internal_admin'] as const;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME, 8);
  if (opened === null) return;
  client = opened.sql;
  database = createDb(opened.url, { max: 8 });
  harness = adminCreditsHarness(opened.url);
  const catalog = buildLegalCatalog({ repoRoot: REPO_ROOT });

  staffAccountId = await seedAccount(sql(), STAFF_EMAIL, catalog);
  staffKey = await seedApiKey(sql(), staffAccountId, {
    scopes: [...ADMIN_SCOPES],
    name: 'staff key',
  });
  staffBrowser = (await seedWebSession(sql(), staffAccountId)).token;
  const ownerId = await seedAccount(sql(), OWNER_EMAIL, catalog);
  ownerKey = await seedApiKey(sql(), ownerId, { scopes: [...ADMIN_SCOPES], name: 'owner key' });

  teamOwnerId = await seedAccount(sql(), `team-owner-${randomUUID()}@example.test`, catalog);
  await sql()`
    INSERT INTO team_members (owner_account_id, member_account_id, role, invited_at, accepted_at)
    VALUES (${teamOwnerId}::uuid, ${staffAccountId}::uuid, 'admin', now(), now())`;

  listed = await buildRealApp(database, harness, catalog, {
    staffEmails: new Set([STAFF_EMAIL]),
    ownerEmail: OWNER_EMAIL,
    authCache: new InMemoryAuthCache(),
  });
  delisted = await buildRealApp(database, harness, catalog, {
    staffEmails: new Set(),
    ownerEmail: OWNER_EMAIL,
    authCache: new InMemoryAuthCache(),
  });
}, 120_000);

afterAll(async () => {
  await listed?.close().catch(() => {});
  await delisted?.close().catch(() => {});
  await harness?.base.database.close().catch(() => {});
  await database?.close().catch(() => {});
  await client?.end({ timeout: 5 }).catch(() => {});
});

/** Twice: the first request takes the slow path, the second is a cache hit. */
async function statusTwice(
  which: 'listed' | 'delisted',
  bearer: string,
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < 2; i++) {
    out.push((await send(app(which), bearer, method, url, payload)).status);
  }
  return out;
}

async function mintedWithAdminScope(accountId: string): Promise<number> {
  const [row] = await sql()<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM api_keys
     WHERE account_id = ${accountId}::uuid AND 'driftstack_internal_admin' = ANY(scopes)`;
  return row?.n ?? 0;
}

describe.skipIf(!RUN_DB_TESTS)(
  'an admin API key works only while its account is on the staff list',
  () => {
    let mintedWhileListed: string | null = null;

    it('while the staff member is listed, their browser, their key (slow path and cache hit) and a key they mint all reach the admin surface — nothing legitimate loses access', async () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
      expect(await statusTwice('listed', staffBrowser, 'GET', '/v1/admin/accounts')).toEqual([
        200, 200,
      ]);
      expect(
        await statusTwice('listed', staffKey?.plaintext ?? '', 'GET', '/v1/admin/accounts'),
      ).toEqual([200, 200]);
      const minted = await send(app('listed'), staffKey?.plaintext ?? '', 'POST', '/v1/api-keys', {
        name: 'staff automation',
        scopes: ['read', 'driftstack_internal_admin'],
      });
      expect(minted.status, JSON.stringify(minted.body)).toBe(201);
      mintedWhileListed = (minted.body as { plaintext: string }).plaintext;
      expect(await statusTwice('listed', mintedWhileListed, 'GET', '/v1/admin/accounts')).toEqual([
        200, 200,
      ]);
    });

    it('CRITICAL after the staff member is taken off the list, their key is refused the admin surface on the slow path and on a cache hit, and cannot suspend another customer', async () => {
      expect(await statusTwice('delisted', staffBrowser, 'GET', '/v1/admin/accounts')).toEqual([
        403, 403,
      ]);
      expect(
        await statusTwice('delisted', staffKey?.plaintext ?? '', 'GET', '/v1/admin/accounts'),
      ).toEqual([403, 403]);
      expect(
        await statusTwice('delisted', mintedWhileListed ?? '', 'GET', '/v1/admin/accounts'),
      ).toEqual([403, 403]);

      const target = await newTaskAccount(sql(), 'api_starter');
      const suspend = await send(
        app('delisted'),
        staffKey?.plaintext ?? '',
        'POST',
        `/v1/admin/accounts/acc_${target}/suspend`,
        { reason: 'a de-listed staff key' },
      );
      expect(suspend.status, JSON.stringify(suspend.body)).toBe(403);
      const [account] = await sql()<Array<{ status: string }>>`
        SELECT status::text FROM accounts WHERE id = ${target}::uuid`;
      expect(account?.status).toBe('active');
    });

    it('a de-listed key is still an ordinary key: it authenticates, and whoami no longer lists the admin scope', async () => {
      const me = await send(app('delisted'), staffKey?.plaintext ?? '', 'GET', '/v1/whoami');
      expect(me.status).toBe(200);
      const scopes = (me.body as { scopes: string[] }).scopes;
      expect(scopes).toContain('account_owner');
      expect(scopes).not.toContain('driftstack_internal_admin');
    });

    it('CRITICAL an account off the list cannot mint a key with the admin scope, and nothing is written; it can still mint an ordinary key', async () => {
      const before = await mintedWithAdminScope(staffAccountId);
      const refused = await send(
        app('delisted'),
        staffKey?.plaintext ?? '',
        'POST',
        '/v1/api-keys',
        {
          name: 'would never work',
          scopes: ['read', 'driftstack_internal_admin'],
        },
      );
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(await mintedWithAdminScope(staffAccountId)).toBe(before);

      const ordinary = await send(
        app('delisted'),
        staffKey?.plaintext ?? '',
        'POST',
        '/v1/api-keys',
        {
          name: 'ordinary',
          scopes: ['read'],
        },
      );
      expect(ordinary.status, JSON.stringify(ordinary.body)).toBe(201);
    });

    it('CRITICAL a listed staff member cannot mint an admin-scoped key onto a team owner’s account, which is not on the list', async () => {
      const before = await mintedWithAdminScope(teamOwnerId);
      const refused = await send(
        app('listed'),
        staffBrowser,
        'POST',
        '/v1/api-keys',
        { name: 'onto the team owner', scopes: ['read', 'driftstack_internal_admin'] },
        { 'x-driftstack-account': `acc_${teamOwnerId}` },
      );
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(await mintedWithAdminScope(teamOwnerId)).toBe(before);

      // The same team write without the admin scope is untouched.
      const ordinary = await send(
        app('listed'),
        staffBrowser,
        'POST',
        '/v1/api-keys',
        { name: 'onto the team owner', scopes: ['read'] },
        { 'x-driftstack-account': `acc_${teamOwnerId}` },
      );
      expect(ordinary.status, JSON.stringify(ordinary.body)).toBe(201);
    });

    it('the owner is always on the list: their admin key keeps working after the restart, on both paths', async () => {
      expect(
        await statusTwice('delisted', ownerKey?.plaintext ?? '', 'GET', '/v1/admin/accounts'),
      ).toEqual([200, 200]);
    });
  },
);
