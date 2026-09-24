// A team member cannot create or rotate an owner-level key on the owner's account.
//
// An `admin` team member may write to the owner's resources (team.md: "full read +
// write"), and that includes the owner's API keys through `X-Driftstack-Account`.
// But a key authenticates as the account it lives on, so a key carrying
// `account_owner` — or the legacy `admin` alias, which satisfies it — on the OWNER's
// account IS the owner: billing, the provider key, team membership, minting more
// keys. The member's own browser session carries `account_owner` on the MEMBER's
// account, and `create()` refused only the staff scopes a caller did not hold, so a
// member could mint the owner's own authority for themselves (audit F1). Rotation
// was the second door: a member could rotate the owner's own `account_owner` key,
// receive the new plaintext, and cut the owner's key to the grace window (F3).
//
// Refused now, with a 403 that names the rule. Read, write, granular and
// `gui_control` keys stay grantable — that is what "full read + write" means — and
// the owner's own create and rotate are unchanged.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../src/db/client.js';
import { buildLegalCatalog } from '../../src/services/legal-catalog.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
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

const ISOLATED_DB_NAME = 'driftstack_iso_team_owner_level_keys';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

let client: postgres.Sql | null = null;
let database: Database | null = null;
let harness: AdminCreditsHarness | null = null;
let app: RealApp | null = null;

let ownerId = '';
let memberId = '';
let ownerBrowser = '';
let memberBrowser = '';
/** The owner's own `account_owner` key, minted by the owner. */
let ownerKey: SeededKey | null = null;
/** A pre-split key of the owner's carrying the legacy `admin` alias. */
let ownerLegacyAdminKey: SeededKey | null = null;

function sql(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}
function theApp(): RealApp {
  if (app === null) throw new Error('the app was not built');
  return app;
}
function asOwner(): Record<string, string> {
  return { 'x-driftstack-account': `acc_${ownerId}` };
}

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME, 8);
  if (opened === null) return;
  client = opened.sql;
  database = createDb(opened.url, { max: 8 });
  harness = adminCreditsHarness(opened.url);
  const catalog = buildLegalCatalog({ repoRoot: REPO_ROOT });

  ownerId = await seedAccount(sql(), `owner-${randomUUID()}@example.test`, catalog);
  memberId = await seedAccount(sql(), `member-${randomUUID()}@example.test`, catalog);
  await sql()`
    INSERT INTO team_members (owner_account_id, member_account_id, role, invited_at, accepted_at)
    VALUES (${ownerId}::uuid, ${memberId}::uuid, 'admin', now(), now())`;
  ownerBrowser = (await seedWebSession(sql(), ownerId)).token;
  memberBrowser = (await seedWebSession(sql(), memberId)).token;
  ownerKey = await seedApiKey(sql(), ownerId, {
    scopes: ['read', 'write', 'account_owner'],
    name: 'owner automation',
    createdByAccountId: ownerId,
  });
  ownerLegacyAdminKey = await seedApiKey(sql(), ownerId, {
    scopes: ['admin'],
    name: 'owner pre-split key',
    createdByAccountId: ownerId,
  });

  app = await buildRealApp(database, harness, catalog, { staffEmails: new Set() });
}, 120_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await harness?.base.database.close().catch(() => {});
  await database?.close().catch(() => {});
  await client?.end({ timeout: 5 }).catch(() => {});
});

/** Keys on the owner's account the member minted that satisfy `account_owner`. */
async function ownerLevelKeysMintedByMember(): Promise<number> {
  const [row] = await sql()<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM api_keys
     WHERE account_id = ${ownerId}::uuid
       AND created_by_account_id = ${memberId}::uuid
       AND scopes && ARRAY['account_owner', 'admin']::api_key_scope[]`;
  return row?.n ?? 0;
}

async function keysOnOwnerAccount(): Promise<number> {
  const [row] = await sql()<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM api_keys WHERE account_id = ${ownerId}::uuid`;
  return row?.n ?? 0;
}

async function keyRow(id: string): Promise<{
  account_id: string;
  created_by_account_id: string | null;
  scopes: string[];
  expires_at: Date | null;
  revoked_at: Date | null;
}> {
  const [row] = await sql()<
    Array<{
      account_id: string;
      created_by_account_id: string | null;
      scopes: string[];
      expires_at: Date | null;
      revoked_at: Date | null;
    }>
  >`
    SELECT account_id::text, created_by_account_id::text, scopes::text[] AS scopes,
           expires_at, revoked_at
      FROM api_keys WHERE id = ${id}::uuid`;
  if (row === undefined) throw new Error(`no api_keys row ${id}`);
  return row;
}

function detailOf(body: unknown): string {
  return (body as { detail?: string } | null)?.detail ?? '';
}

function keyIdOf(body: unknown): string {
  return ((body as { id: string }).id ?? '').replace(/^key_/, '');
}

describe.skipIf(!RUN_DB_TESTS)(
  "a team member cannot create or rotate an owner-level key on the owner's account",
  () => {
    it('CRITICAL an admin member cannot create an account_owner key on the owner, and nothing is written', async () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
      const before = await ownerLevelKeysMintedByMember();
      const refused = await send(
        theApp(),
        memberBrowser,
        'POST',
        '/v1/api-keys',
        { name: 'owner authority for me', scopes: ['account_owner'] },
        asOwner(),
      );
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(detailOf(refused.body)).toBe(
        "A team member can't create a key with account_owner, admin or admin:… scope on the owner's account. Ask the owner.",
      );
      expect(await ownerLevelKeysMintedByMember()).toBe(before);
    });

    it('CRITICAL an admin member cannot create a key with the legacy admin alias on the owner either — it satisfies account_owner', async () => {
      const before = await ownerLevelKeysMintedByMember();
      const refused = await send(
        theApp(),
        memberBrowser,
        'POST',
        '/v1/api-keys',
        { name: 'the alias', scopes: ['read', 'admin'] },
        asOwner(),
      );
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(detailOf(refused.body)).toMatch(/A team member can't create a key with account_owner/);
      expect(await ownerLevelKeysMintedByMember()).toBe(before);
    });

    it('CRITICAL an admin member cannot create an admin:billing key on the owner — billing refuses acting-as, and a key on the owner is the owner', async () => {
      const refused = await send(
        theApp(),
        memberBrowser,
        'POST',
        '/v1/api-keys',
        { name: 'billing for me', scopes: ['admin:billing'] },
        asOwner(),
      );
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(detailOf(refused.body)).toMatch(/A team member can't create a key with account_owner/);
      // Reading billing stays grantable: it opens nothing acting-as keeps closed.
      const reader = await send(
        theApp(),
        memberBrowser,
        'POST',
        '/v1/api-keys',
        { name: 'billing reader', scopes: ['read:billing'] },
        asOwner(),
      );
      expect(reader.status, JSON.stringify(reader.body)).toBe(201);
    });

    it('an admin member can still create read + write keys on the owner, recorded as minted by the member', async () => {
      const created = await send(
        theApp(),
        memberBrowser,
        'POST',
        '/v1/api-keys',
        { name: 'team integration', scopes: ['read', 'write'] },
        asOwner(),
      );
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const row = await keyRow(keyIdOf(created.body));
      expect(row.account_id).toBe(ownerId);
      expect(row.created_by_account_id).toBe(memberId);
      expect(row.scopes.sort()).toEqual(['read', 'write']);
    });

    it('an admin member can still create granular and gui_control keys on the owner', async () => {
      const created = await send(
        theApp(),
        memberBrowser,
        'POST',
        '/v1/api-keys',
        { name: 'narrow', scopes: ['read:sessions', 'write:sessions', 'gui_control'] },
        asOwner(),
      );
      expect(created.status, JSON.stringify(created.body)).toBe(201);
    });

    it("CRITICAL an admin member cannot rotate the owner's own account_owner key: 403, no successor, and the owner's key is untouched", async () => {
      const keysBefore = await keysOnOwnerAccount();
      const refused = await send(
        theApp(),
        memberBrowser,
        'POST',
        `/v1/api-keys/key_${ownerKey?.id ?? ''}/rotate`,
        undefined,
        asOwner(),
      );
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(detailOf(refused.body)).toBe(
        "A team member can't rotate a key with account_owner, admin or admin:… scope on the owner's account. Ask the owner.",
      );
      expect(await keysOnOwnerAccount(), 'no successor row was minted').toBe(keysBefore);
      const untouched = await keyRow(ownerKey?.id ?? '');
      expect(untouched.expires_at, 'no grace expiry was set on the owner key').toBeNull();
      expect(untouched.revoked_at).toBeNull();
      // ...and it still works for the owner.
      expect((await send(theApp(), ownerKey?.plaintext ?? '', 'GET', '/v1/whoami')).status).toBe(
        200,
      );
    });

    it("CRITICAL an admin member cannot rotate the owner's legacy admin-alias key either", async () => {
      const keysBefore = await keysOnOwnerAccount();
      const refused = await send(
        theApp(),
        memberBrowser,
        'POST',
        `/v1/api-keys/key_${ownerLegacyAdminKey?.id ?? ''}/rotate`,
        undefined,
        asOwner(),
      );
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(await keysOnOwnerAccount()).toBe(keysBefore);
      expect((await keyRow(ownerLegacyAdminKey?.id ?? '')).expires_at).toBeNull();
    });

    it('the owner can still create an account_owner key and rotate their own account_owner key, which keeps the owner as its minter', async () => {
      const created = await send(theApp(), ownerBrowser, 'POST', '/v1/api-keys', {
        name: 'owner second key',
        scopes: ['account_owner'],
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const createdRow = await keyRow(keyIdOf(created.body));
      expect(createdRow.created_by_account_id).toBe(ownerId);

      const rotated = await send(
        theApp(),
        ownerBrowser,
        'POST',
        `/v1/api-keys/key_${ownerKey?.id ?? ''}/rotate`,
      );
      expect(rotated.status, JSON.stringify(rotated.body)).toBe(201);
      const successor = await keyRow(keyIdOf(rotated.body));
      expect(successor.account_id).toBe(ownerId);
      expect(successor.created_by_account_id).toBe(ownerId);
      expect(successor.scopes).toContain('account_owner');
      expect((await keyRow(ownerKey?.id ?? '')).expires_at).not.toBeNull();
    });
  },
);
