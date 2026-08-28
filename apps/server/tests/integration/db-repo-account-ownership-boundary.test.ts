// The repo layer's own account boundary, exercised directly.
//
// Found by mutation sweep, not by reading. Every `eq(table.accountId, …)`
// predicate in `agent-sessions-repo.ts` (8) and `account-proxies-repo.ts` (6)
// was neutralised — rewritten to `eq(t.accountId, t.accountId)`, which is
// always true — and the ENTIRE suite stayed green: 2,564 files, 26,584 tests,
// zero failures. Fourteen cross-account checks, none of them proving anything.
//
// They are not the only defence and this was not a live vulnerability: the
// service and route layers check ownership before these methods are reached,
// and there ARE route tests for that ("cross-account guard rejects before
// setMode"). But those tests drive a repo DOUBLE, so they exercise the service
// check and never the SQL. The five DB integration files that do use the real
// Drizzle repos test idempotency, concurrency, transcript migration and
// receipts — none of them ever passes a mismatched account id.
//
// So the repo predicate is a second line of defence in a codebase where the
// first line is well tested and the second is not tested at all. That is worth
// closing on its own terms: defence in depth that nothing verifies is defence
// in belief. If a service refactor ever drops the outer check — or a new caller
// reaches the repo directly, which is exactly what the sweeper arms added this
// week do — the backstop is what stands between one customer and another's
// agent transcripts or proxy credentials.
//
// Drives the REAL repos against real Postgres, because the thing under test is
// the SQL predicate. A fake repo would assert the fake.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import { DrizzleAgentSessionsRepo } from '../../src/db/agent-sessions-repo.js';
import { DrizzleAccountProxiesRepo } from '../../src/db/account-proxies-repo.js';
import { DrizzleApiKeysRepo } from '../../src/db/api-keys-repo.js';
import { DrizzleTeamMembersRepo } from '../../src/db/team-members-repo.js';
import { DrizzleAgentTurnReceiptsRepo } from '../../src/db/agent-turn-receipts-repo.js';
import * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const TRANSCRIPT_KEY = Buffer.alloc(32, 11).toString('base64');

// `agent_turn_receipts_request_hash` is CHECKed against `^[0-9a-f]{64}$` — a
// sha256 digest. A readable label like 'victim-hash' is rejected by Postgres,
// which is the constraint doing its job and the fixture inventing a shape the
// column does not accept.
const VICTIM_HASH = 'a'.repeat(64);
const SHARED_HASH = 'c'.repeat(64);

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
let sessions: DrizzleAgentSessionsRepo | null = null;
let proxies: DrizzleAccountProxiesRepo | null = null;
let apiKeysRepo: DrizzleApiKeysRepo | null = null;
let teamRepo: DrizzleTeamMembersRepo | null = null;
let receipts: DrizzleAgentTurnReceiptsRepo | null = null;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM agent_sessions LIMIT 0`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 4 });
  const db = drizzle(client, { schema });
  const handle = { client, db, close: async () => {} };
  sessions = new DrizzleAgentSessionsRepo(handle, {
    transcriptEncryptionKeyBase64: TRANSCRIPT_KEY,
  });
  proxies = new DrizzleAccountProxiesRepo(handle);
  apiKeysRepo = new DrizzleApiKeysRepo(handle);
  teamRepo = new DrizzleTeamMembersRepo(handle);
  receipts = new DrizzleAgentTurnReceiptsRepo(handle, TRANSCRIPT_KEY);
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM team_members WHERE owner_account_id = ${accountId} OR member_account_id = ${accountId}`.catch(
        () => {},
      );
      await client`DELETE FROM agent_turn_receipts WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM api_keys WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM account_proxies WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM agent_sessions WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

async function seedAccount(): Promise<string> {
  if (!client) throw new Error('no client');
  const accountId = randomUUID();
  seeded.push(accountId);
  await client`
    INSERT INTO accounts (id, email, status)
    VALUES (${accountId}, ${`ownership-${accountId}@test.local`}, 'active')`;
  return accountId;
}

/**
 * Seeded through the repo rather than raw SQL: `transcript` is stored as an
 * encrypted v2 envelope and the read path refuses anything else, so a
 * hand-written INSERT produces a row the repo cannot decode — a fixture failure
 * that looks exactly like a boundary failure.
 */
async function seedSession(accountId: string): Promise<string> {
  if (!sessions) throw new Error('no repo');
  const session = await sessions.create({ accountId, tokenBudgetTotal: 1000 });
  return session.id;
}

async function seedProxy(accountId: string): Promise<string> {
  if (!client) throw new Error('no client');
  const id = randomUUID();
  await client`
    INSERT INTO account_proxies (id, account_id, label, scheme, host, port, username)
    VALUES (${id}, ${accountId}, ${`proxy-${id}`}, 'http', 'proxy.test', 8080, 'user')`;
  return id;
}

/**
 * V-1187 — `api_keys.key_prefix` carries `uniqueIndex('api_keys_prefix_unique')`, so every
 * fixture needs its own prefix; a shared one fails on insert and reads as a boundary failure.
 */
async function seedApiKey(accountId: string, createdByAccountId?: string): Promise<string> {
  if (!apiKeysRepo) throw new Error('no repo');
  const tag = randomUUID().slice(0, 8);
  const row = await apiKeysRepo.insertApiKey({
    accountId,
    name: `boundary-${tag}`,
    scopes: ['read'],
    keyPrefix: `ds_test_${tag}`,
    keyHash: `hash-${tag}`,
    expiresAt: null,
    createdByAccountId: createdByAccountId ?? null,
  });
  return row.id;
}

/** A live, accepted membership of `member` in `owner`'s team. */
async function seedMembership(owner: string, member: string): Promise<string> {
  if (!client) throw new Error('no client');
  const id = randomUUID();
  await client`
    INSERT INTO team_members (id, owner_account_id, member_account_id, role, invited_at, accepted_at)
    VALUES (${id}, ${owner}, ${member}, 'member', now(), now())`;
  return id;
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'repo methods enforce their own account boundary',
  () => {
    it('CRITICAL the database is reachable. Every case here is a SQL round-trip; if the connection failed they would skip and this file would report success while proving nothing about a cross-account boundary.', () => {
      expect(dbReachable, `could not reach ${DB_URL} — these results would be meaningless`).toBe(
        true,
      );
    });

    it('CRITICAL the fixtures are real — victim rows exist and ARE reachable by their true owner. Every check below is an absence; without this positive arm a repo that returned nothing to anyone would satisfy all of them.', async () => {
      const owner = await seedAccount();
      await seedSession(owner);
      const proxyId = await seedProxy(owner);

      expect((await sessions!.listByAccount(owner)).length, 'the owner sees the session').toBe(1);
      expect((await proxies!.list(owner)).length, 'the owner sees the proxy').toBe(1);
      expect(
        (await proxies!.findById({ id: proxyId, accountId: owner }))?.id,
        'and can fetch it by id',
      ).toBe(proxyId);
    });

    it('CRITICAL agent sessions are not listed to another account. `listByAccount` is the read behind the customer-facing session list; without the SQL predicate it returns whatever the caller asks for.', async () => {
      const victim = await seedAccount();
      const attacker = await seedAccount();
      await seedSession(victim);

      expect(
        await sessions!.listByAccount(attacker),
        'the attacker sees nothing of the victim’s',
      ).toEqual([]);
    });

    it('CRITICAL the paged agent-session read enforces the same boundary as the unpaged one. Two reads of the same table diverging is how a boundary gets fixed in one place and left open in the other.', async () => {
      const victim = await seedAccount();
      const attacker = await seedAccount();
      await seedSession(victim);

      const page = await sessions!.listPageByAccount(attacker, { limit: 50 });
      expect(page.items, 'the attacker’s page is empty').toEqual([]);
    });

    it('CRITICAL the active-session count is per account. It feeds the concurrency cap, so a count that leaks across accounts lets one customer’s usage exhaust another’s quota.', async () => {
      const victim = await seedAccount();
      const attacker = await seedAccount();
      await seedSession(victim);

      expect(await sessions!.countActive(attacker), 'the attacker counts none').toBe(0);
    });

    it('CRITICAL proxies are not listed to another account. The rows carry wrapped credentials, so this boundary is the one protecting a customer’s proxy password.', async () => {
      const victim = await seedAccount();
      const attacker = await seedAccount();
      await seedProxy(victim);

      expect(await proxies!.list(attacker), 'the attacker sees no proxies').toEqual([]);
    });

    it('CRITICAL a proxy cannot be fetched by id from another account. Guessing or leaking an id must not be enough — the id alone is not authorisation.', async () => {
      const victim = await seedAccount();
      const attacker = await seedAccount();
      const proxyId = await seedProxy(victim);

      expect(
        await proxies!.findById({ id: proxyId, accountId: attacker }),
        'a known id under the wrong account resolves to nothing',
      ).toBeNull();
    });

    // ── V-1187 — api-keys-repo, added after the same mutation sweep that produced this
    // file found it uncovered. Neutralising `findApiKey`'s account predicate (leaving
    // `accountId` referenced, so the unused-parameter type error cannot stand in for a
    // real test) left 30,777 tests passing: only two CONTENT-PARITY files failed, and
    // both pin the source text rather than the behaviour. Route-level cross-account
    // rotation IS covered by `cross-account-isolation-every-creatable-family`; this is
    // the repo backstop underneath it, which nothing exercised.

    it('CRITICAL an API key cannot be fetched by id from another account. `findApiKey` takes the account explicitly and there is a deliberate `findApiKeyUnscoped` beside it, so a dropped predicate turns the scoped read into the unscoped one silently — the two differ by one clause and nothing behavioural compared them.', async () => {
      const victim = await seedAccount();
      const attacker = await seedAccount();
      const keyId = await seedApiKey(victim);

      expect((await apiKeysRepo!.findApiKey(keyId, victim))?.id, 'the owner can fetch it').toBe(
        keyId,
      );
      expect(
        await apiKeysRepo!.findApiKey(keyId, attacker),
        'the attacker fetched the victim key by id',
      ).toBeNull();
    });

    it('CRITICAL API keys are not listed to another account. The row carries the scope set and key metadata, so a cross-account list is an inventory of what the victim can do before anything is even used.', async () => {
      const victim = await seedAccount();
      const attacker = await seedAccount();
      await seedApiKey(victim);

      expect((await apiKeysRepo!.listApiKeys(victim)).length, 'the owner sees the key').toBe(1);
      expect(
        await apiKeysRepo!.listApiKeys(attacker),
        'the attacker listed the victim key',
      ).toEqual([]);
    });

    it('CRITICAL an API key cannot be REVOKED from another account, and survives the attempt. Revocation takes `accountId: string | null`, where null is the deliberate admin-unscoped path — so a customer-scoped call that stops scoping becomes the admin path without changing shape.', async () => {
      const victim = await seedAccount();
      const attacker = await seedAccount();
      const keyId = await seedApiKey(victim);

      const result = await apiKeysRepo!.revokeApiKeyAtomic({
        id: keyId,
        accountId: attacker,
        revokedAt: new Date(),
      });
      expect(result.kind, 'the attacker revoked the victim key').not.toBe('revoked');
      expect(
        (await apiKeysRepo!.findApiKey(keyId, victim))?.revokedAt ?? null,
        'the victim key was revoked by someone else',
      ).toBeNull();
    });

    it('CRITICAL an API key cannot be ROTATED from another account, and the original is untouched. This is the severe one: rotation mints a successor and returns its plaintext, so a working cross-account rotation is simultaneously a credential takeover and a denial of service against the live key.', async () => {
      const victim = await seedAccount();
      const attacker = await seedAccount();
      const keyId = await seedApiKey(victim);
      const tag = randomUUID().slice(0, 8);

      const result = await apiKeysRepo!.rotateApiKeyAtomic({
        oldKeyId: keyId,
        accountId: attacker,
        keyPrefix: `ds_test_${tag}`,
        keyHash: `hash-${tag}`,
        now: new Date(),
        gracePeriodMs: 0,
      });
      expect(result.kind, 'the attacker rotated the victim key').toBe('not_found');

      const after = await apiKeysRepo!.findApiKey(keyId, victim);
      expect(after?.id, 'the victim key vanished').toBe(keyId);
      expect(after?.revokedAt ?? null, 'the victim key was revoked by the rotation').toBeNull();
      expect(
        (await apiKeysRepo!.listApiKeys(victim)).length,
        'a successor key was minted into the victim account',
      ).toBe(1);
    });

    // ── V-1188 — team-members-repo. Found by the same sweep, and the only one of the
    // three candidates that turned out to be REACHABLE: neutralising this predicate
    // changed nothing the suite could see, and a member really can hold seats in two
    // owner accounts (`listApiKeysMintedBy` exists precisely because keys minted BY an
    // account live on OTHER accounts).

    it('CRITICAL offboarding a member revokes the keys they minted on THIS owner only. The revoke is scoped by owner AND minter; drop the owner half and removing someone from one team revokes the keys they minted for every other team they belong to — a cross-tenant denial of service triggered by an ordinary offboarding, with no attacker involved.', async () => {
      const ownerA = await seedAccount();
      const ownerB = await seedAccount();
      const member = await seedAccount();
      const membershipInA = await seedMembership(ownerA, member);
      await seedMembership(ownerB, member);

      const keyInA = await seedApiKey(ownerA, member);
      const keyInB = await seedApiKey(ownerB, member);

      const result = await teamRepo!.removeMemberWithInvites(membershipInA, ownerA);
      expect(result?.memberAccountId, 'the membership was not removed').toBe(member);
      expect(
        result?.revokedApiKeyIds,
        "the member's key on this owner survived offboarding",
      ).toEqual([keyInA]);

      expect(
        (await apiKeysRepo!.findApiKey(keyInA, ownerA))?.revokedAt ?? null,
        'the offboarded key is still live',
      ).not.toBeNull();
      expect(
        (await apiKeysRepo!.findApiKey(keyInB, ownerB))?.revokedAt ?? null,
        "offboarding from one team revoked the member's key on an unrelated team",
      ).toBeNull();
    });

    it('CRITICAL a proxy cannot be DELETED from another account. This is the irreversible one: without the predicate, an id is enough to destroy another customer’s proxy configuration.', async () => {
      const victim = await seedAccount();
      const attacker = await seedAccount();
      const proxyId = await seedProxy(victim);

      await proxies!.delete({ id: proxyId, accountId: attacker }).catch(() => undefined);

      expect(
        (await proxies!.list(victim)).length,
        'the victim’s proxy survives an attacker’s delete',
      ).toBe(1);
    });

    it("CRITICAL completing a turn receipt cannot reach another account's row. `complete` updates on FIVE predicates — account, key, session, hash, state — so every field except the account is held EQUAL to the victim's here, deliberately. A first version varied session and hash too and passed under mutation: the refusal it observed came from those, and the arm proved nothing about the account predicate it was named for. Isolating one predicate means the fixture may be unrealistic (an attacker would not know the victim's session id); that is the price of attributing the refusal. Neutralised, the update lands on the victim's row and replaces their stored response with ciphertext whose AAD names the attacker, so the victim's own replay then fails to decrypt — not a disclosure, a durable denial of their idempotent turn.", async () => {
      const victim = await seedAccount();
      const attacker = await seedAccount();
      const victimSession = await seedSession(victim);
      const key = `idem_${randomUUID()}`;

      expect(
        await receipts!.reserve({
          accountId: victim,
          agentSessionId: victimSession,
          idempotencyKey: key,
          requestHash: VICTIM_HASH,
        }),
        'fixture: the victim holds an in-progress receipt under this key',
      ).toEqual({ kind: 'reserved' });

      // Same key, attacker's own account and session. With the predicate intact
      // the UPDATE matches zero rows and `complete` REFUSES rather than
      // returning quietly — asserted here because the refusal is the observable
      // half, and a silent no-op would look identical to a successful write
      // that happened to land on the right row.
      await expect(
        receipts!.complete({
          accountId: attacker,
          // The victim's session and hash on purpose — see the title. Only the
          // account differs, so only the account predicate can refuse this.
          agentSessionId: victimSession,
          idempotencyKey: key,
          requestHash: VICTIM_HASH,
          terminal: { status: 200, body: { owner: 'attacker' } },
        }),
        "completing another account's receipt must refuse, not succeed",
      ).rejects.toThrow();

      const [row] = await client!`
        SELECT state FROM agent_turn_receipts
        WHERE account_id = ${victim} AND idempotency_key = ${key}`;
      expect(row?.state, "the victim's receipt was completed by another account").toBe(
        'in_progress',
      );
    });

    it("CRITICAL a replay lookup does not return another account's terminal response. On an insert conflict `reserve` re-reads the row and, when session and request hash match, decrypts and RETURNS its stored body — and `readTerminal` builds the decryption AAD from the ROW, so a row fetched across the boundary decrypts cleanly rather than failing closed. The (session, hash) equality is what actually stops disclosure; the account predicate is the second line, and the second line is the half nothing was asserting. ⚠️ Unlike the arm above, this one is not fully deterministic under mutation: the unscoped read is a `limit(1)` with no ORDER BY, so it catches the break only when the scan reaches the victim's row first. The victim is seeded first to make that the likely order; the arm above is the deterministic proof.", async () => {
      const victim = await seedAccount();
      const attacker = await seedAccount();
      const victimSession = await seedSession(victim);
      const attackerSession = await seedSession(attacker);
      const key = `idem_${randomUUID()}`;

      await receipts!.reserve({
        accountId: victim,
        agentSessionId: victimSession,
        idempotencyKey: key,
        requestHash: SHARED_HASH,
      });
      await receipts!.complete({
        accountId: victim,
        agentSessionId: victimSession,
        idempotencyKey: key,
        requestHash: SHARED_HASH,
        terminal: { status: 200, body: { owner: 'victim' } },
      });

      const attackerArgs = {
        accountId: attacker,
        agentSessionId: attackerSession,
        idempotencyKey: key,
        requestHash: SHARED_HASH,
      };
      expect(
        await receipts!.reserve(attackerArgs),
        'fixture: the attacker gets their OWN row, not a conflict',
      ).toEqual({ kind: 'reserved' });

      const replay = await receipts!.reserve(attackerArgs);
      expect(replay.kind, "the attacker's own reservation is still in progress").toBe(
        'in-progress',
      );
    });
  },
);
