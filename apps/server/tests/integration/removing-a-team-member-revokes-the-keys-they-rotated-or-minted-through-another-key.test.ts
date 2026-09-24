// Removing a team member revokes the keys they rotated, or minted through another key.
//
// team.md promises: "Removal also revokes the API keys that member minted on your
// account." Removal revokes by minter — `created_by_account_id` — so the promise holds
// only as far as that column names the person who holds the plaintext. Two paths
// recorded the OWNER instead, and the key outlived the member's removal:
//
//   - Rotation (audit F3). The successor kept the old row's minter. When an admin
//     member rotated one of the owner's keys, the member received the new plaintext
//     and the new row said the owner minted it.
//   - A key minted BY a member's key (audit F2). A key a member minted lives on the
//     owner's account, so a key it mints is minted with `ctx.account` = the owner and
//     recorded as the owner's. Keys like that exist in production already, minted
//     before a member was refused owner-level keys (see the sibling file
//     a-team-member-cannot-create-or-rotate-an-owner-level-key-on-the-owners-account),
//     so the child of one is modelled by inserting the parent row directly.
//
// Both now record the member, and removal takes them with it — from the database and
// from the auth cache, so each stops working on the very next request. The owner's own
// key that the member rotated is not the member's: it keeps the grace window the
// rotation gave it.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleAccountAuditRepo } from '../../src/db/account-audit-repo.js';
import { DrizzleTeamMembersRepo } from '../../src/db/team-members-repo.js';
import { createTestLogger } from '../../src/lib/logger.js';
import { registerTeamRoutes } from '../../src/routes/team.js';
import { AccountAuditService } from '../../src/services/account-audit.js';
import { InMemoryAuthCache, sha256Hex } from '../../src/services/auth-cache.js';
import { createEmailService } from '../../src/services/email.js';
import { buildLegalCatalog } from '../../src/services/legal-catalog.js';
import { TeamMembersService } from '../../src/services/team-members.js';
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
  type LegalCatalog,
  type RealApp,
} from './_helpers/real-app-with-signed-in-identities.js';

const ISOLATED_DB_NAME = 'driftstack_iso_team_removal_revokes_keys';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

let client: postgres.Sql | null = null;
let database: Database | null = null;
let harness: AdminCreditsHarness | null = null;
let app: RealApp | null = null;
let catalog: LegalCatalog | null = null;
/** Shared by the app's authentication and the team service, as bootstrap wires them. */
const authCache = new InMemoryAuthCache();

function sql(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}
function theApp(): RealApp {
  if (app === null) throw new Error('the app was not built');
  return app;
}

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME, 8);
  if (opened === null) return;
  client = opened.sql;
  database = createDb(opened.url, { max: 8 });
  harness = adminCreditsHarness(opened.url);
  catalog = buildLegalCatalog({ repoRoot: REPO_ROOT });

  app = await buildRealApp(database, harness, catalog, { staffEmails: new Set(), authCache });
  // The shared builder does not wire the team routes; they are added here the way
  // bootstrap adds them, with the same auth cache the app authenticates through.
  registerTeamRoutes(app, {
    service: new TeamMembersService(
      new DrizzleTeamMembersRepo(database),
      createEmailService({ config: null, logger: createTestLogger() }),
      { dashboardBaseUrl: 'http://localhost:5173' },
      new AccountAuditService(new DrizzleAccountAuditRepo(database)),
      authCache,
    ),
  });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await harness?.base.database.close().catch(() => {});
  await database?.close().catch(() => {});
  await client?.end({ timeout: 5 }).catch(() => {});
});

interface Team {
  ownerId: string;
  memberId: string;
  membershipId: string;
  ownerBrowser: string;
  memberBrowser: string;
}

/** An owner with an admin member, both signed in. */
async function newTeam(): Promise<Team> {
  if (catalog === null) throw new Error('the legal catalog was not built');
  const ownerId = await seedAccount(sql(), `owner-${randomUUID()}@example.test`, catalog);
  const memberId = await seedAccount(sql(), `member-${randomUUID()}@example.test`, catalog);
  const [membership] = await sql()<Array<{ id: string }>>`
    INSERT INTO team_members (owner_account_id, member_account_id, role, invited_at, accepted_at)
    VALUES (${ownerId}::uuid, ${memberId}::uuid, 'admin', now(), now())
    RETURNING id::text`;
  if (membership === undefined) throw new Error('the membership was not seeded');
  return {
    ownerId,
    memberId,
    membershipId: membership.id,
    ownerBrowser: (await seedWebSession(sql(), ownerId)).token,
    memberBrowser: (await seedWebSession(sql(), memberId)).token,
  };
}

async function keyRow(id: string): Promise<{
  created_by_account_id: string | null;
  expires_at: Date | null;
  revoked_at: Date | null;
}> {
  const [row] = await sql()<
    Array<{
      created_by_account_id: string | null;
      expires_at: Date | null;
      revoked_at: Date | null;
    }>
  >`
    SELECT created_by_account_id::text, expires_at, revoked_at
      FROM api_keys WHERE id = ${id}::uuid`;
  if (row === undefined) throw new Error(`no api_keys row ${id}`);
  return row;
}

/** Twice: the first request takes the slow path and fills the cache, the second is a hit. */
async function whoamiTwice(bearer: string): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < 2; i++) out.push((await send(theApp(), bearer, 'GET', '/v1/whoami')).status);
  return out;
}

async function removeMember(team: Team): Promise<number> {
  return (
    await send(theApp(), team.ownerBrowser, 'DELETE', `/v1/team/members/mem_${team.membershipId}`)
  ).status;
}

function keyIdOf(body: unknown): string {
  return ((body as { id: string }).id ?? '').replace(/^key_/, '');
}

describe.skipIf(!RUN_DB_TESTS)(
  'removing a team member revokes the keys they rotated or minted through another key',
  () => {
    it("CRITICAL a key an admin member rotated is recorded as the member's and dies with the removal, while the owner's original keeps the grace expiry the rotation set", async () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
      const team = await newTeam();
      const ownerWriteKey = await seedApiKey(sql(), team.ownerId, {
        scopes: ['read', 'write'],
        name: 'owner integration',
        createdByAccountId: team.ownerId,
      });

      const rotated = await send(
        theApp(),
        team.memberBrowser,
        'POST',
        `/v1/api-keys/key_${ownerWriteKey.id}/rotate`,
        undefined,
        { 'x-driftstack-account': `acc_${team.ownerId}` },
      );
      expect(rotated.status, JSON.stringify(rotated.body)).toBe(201);
      const body = rotated.body as { plaintext: string; grace_period_ends_at: string };
      const successorId = keyIdOf(rotated.body);
      expect(
        (await keyRow(successorId)).created_by_account_id,
        'the member holds the new plaintext, so the member is its minter',
      ).toBe(team.memberId);
      expect(await whoamiTwice(body.plaintext)).toEqual([200, 200]);

      expect(await removeMember(team)).toBe(204);

      expect(await whoamiTwice(body.plaintext), 'revoked on the very next request').toEqual([
        401, 401,
      ]);
      expect((await keyRow(successorId)).revoked_at).not.toBeNull();

      const original = await keyRow(ownerWriteKey.id);
      expect(original.revoked_at, "the owner's own key is not the member's").toBeNull();
      expect(original.created_by_account_id).toBe(team.ownerId);
      expect(
        original.expires_at?.toISOString(),
        'removal leaves the grace expiry the rotation set',
      ).toBe(new Date(body.grace_period_ends_at).toISOString());
      expect(await whoamiTwice(ownerWriteKey.plaintext), 'still inside its grace window').toEqual([
        200, 200,
      ]);
    });

    it('CRITICAL a child minted by a member-minted key is recorded as the member’s, and removal revokes parent and child at once — cache included', async () => {
      const team = await newTeam();
      // As production may hold it: an owner-level key a member minted on the owner's
      // account before members were refused owner-level keys.
      const legacy = await seedApiKey(sql(), team.ownerId, {
        scopes: ['read', 'write', 'account_owner'],
        name: 'minted by the member, pre-fix',
        createdByAccountId: team.memberId,
      });

      const child = await send(theApp(), legacy.plaintext, 'POST', '/v1/api-keys', {
        name: 'grandchild credential',
        scopes: ['read', 'write'],
      });
      expect(child.status, JSON.stringify(child.body)).toBe(201);
      const childPlaintext = (child.body as { plaintext: string }).plaintext;
      const childId = keyIdOf(child.body);
      expect(
        (await keyRow(childId)).created_by_account_id,
        "minted by the member's key, so minted by the member — not by the account it lives on",
      ).toBe(team.memberId);

      expect(await whoamiTwice(legacy.plaintext)).toEqual([200, 200]);
      expect(await whoamiTwice(childPlaintext)).toEqual([200, 200]);
      expect(
        await authCache.get(sha256Hex(legacy.plaintext)),
        'precondition: the parent is cached, or the eviction below proves nothing',
      ).not.toBeNull();
      expect(await authCache.get(sha256Hex(childPlaintext))).not.toBeNull();

      expect(await removeMember(team)).toBe(204);

      expect(
        await authCache.get(sha256Hex(legacy.plaintext)),
        'the removal evicts the revoked keys from the auth cache',
      ).toBeNull();
      expect(await authCache.get(sha256Hex(childPlaintext))).toBeNull();
      expect(await whoamiTwice(legacy.plaintext)).toEqual([401, 401]);
      expect(await whoamiTwice(childPlaintext)).toEqual([401, 401]);

      const [removal] = await accountAuditRows(sql(), team.ownerId, 'team.member_removed');
      expect(
        [...((removal?.payload?.revoked_api_key_ids as string[] | undefined) ?? [])].sort(),
      ).toEqual([legacy.id, childId].sort());
    });

    it("a member-minted key cannot mint or rotate an owner-level key on the owner's account either", async () => {
      const team = await newTeam();
      const legacy = await seedApiKey(sql(), team.ownerId, {
        scopes: ['account_owner'],
        name: 'minted by the member, pre-fix',
        createdByAccountId: team.memberId,
      });
      const ownerKey = await seedApiKey(sql(), team.ownerId, {
        scopes: ['account_owner'],
        name: 'owner key',
        createdByAccountId: team.ownerId,
      });

      const mint = await send(theApp(), legacy.plaintext, 'POST', '/v1/api-keys', {
        name: 'perpetuate it',
        scopes: ['account_owner'],
      });
      expect(mint.status, JSON.stringify(mint.body)).toBe(403);

      const rotate = await send(
        theApp(),
        legacy.plaintext,
        'POST',
        `/v1/api-keys/key_${ownerKey.id}/rotate`,
      );
      expect(rotate.status, JSON.stringify(rotate.body)).toBe(403);
      expect((await keyRow(ownerKey.id)).expires_at).toBeNull();
    });

    it('CRITICAL a member-minted key cannot mint keys on a third account the owner is on the team of — no removal could reach that key', async () => {
      if (catalog === null) throw new Error('the legal catalog was not built');
      const team = await newTeam();
      const thirdId = await seedAccount(sql(), `third-${randomUUID()}@example.test`, catalog);
      await sql()`
        INSERT INTO team_members (owner_account_id, member_account_id, role, invited_at, accepted_at)
        VALUES (${thirdId}::uuid, ${team.ownerId}::uuid, 'admin', now(), now())`;
      const legacy = await seedApiKey(sql(), team.ownerId, {
        scopes: ['read', 'write', 'account_owner'],
        name: 'minted by the member, pre-fix',
        createdByAccountId: team.memberId,
      });

      const refused = await send(
        theApp(),
        legacy.plaintext,
        'POST',
        '/v1/api-keys',
        { name: 'onto the third account', scopes: ['read'] },
        { 'x-driftstack-account': `acc_${thirdId}` },
      );
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      const [row] = await sql()<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM api_keys WHERE account_id = ${thirdId}::uuid`;
      expect(row?.n).toBe(0);

      // The owner themself, through their own browser, still can.
      const allowed = await send(
        theApp(),
        team.ownerBrowser,
        'POST',
        '/v1/api-keys',
        { name: 'onto the third account', scopes: ['read'] },
        { 'x-driftstack-account': `acc_${thirdId}` },
      );
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
    });
  },
);
