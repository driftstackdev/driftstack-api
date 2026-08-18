// Six of `DrizzleOAuthStore`'s fourteen methods have never had their SQL run.
//
// Derived rather than guessed: every method on the four security-adjacent repos
// was matched against every call site in `tests/integration`. `auth-repo` and
// `oauth-links-repo` came back fully exercised, `auth-flows-repo` missed one, and
// `oauth-store` missed SIX — `insertClient`, `listClients`, `insertAuthorization`,
// `getAuthorization`, `getCode` and `getToken`.
//
// The reason is worth stating, because "there are four db-oauth-* files" reads as
// coverage. Those files seed `oauth_clients` and `oauth_authorization_codes` with
// hand-written INSERTs — deliberately, since they are about the revoke/consume
// transactions and want the rows to exist a specific way. So the TABLES are
// heavily exercised and the store's own writes into them are not. A wrong column,
// a dropped array spread, a Date that should have been null: none of it is
// reachable from a test that seeds by hand.
//
// This is item 5e's distinction exactly — low coverage on a Drizzle repo does not
// mean the behaviour is untested, it means THE SQL is untested — applied to the
// one place in the repo where the SQL holds OAuth client secrets, consent grants
// and access tokens.
//
// Round-trip is the assertion, not a status. Insert through the store, read back
// through the store, compare the whole record. A column written to the wrong
// place still inserts; only reading it back tells you where it went.
//
// Two properties here are not round-trips and matter more than the rest:
//
//   the authorization id is NOT STORED. `insertAuthorization` persists
//   `sha256Hex(authorization_id)`, and `getAuthorization` echoes the id its CALLER
//   supplied. So the row cannot yield the id it was created with — holding the
//   database is not holding the consent grant. Asserted by looking a DIFFERENT id
//   up against a row that exists.
//
//   `getCode` is time-fenced. It filters on `createdAt > now - AUTHORIZATION_CODE_TTL_MS`,
//   so an expired code reads as absent rather than as an expired row the caller
//   must remember to check. Asserted by inserting one older than the window.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleOAuthStore } from '../../src/db/oauth-store.js';
import { sha256Hex } from '../../src/services/auth-cache.js';
import type { OAuthClient, PendingAuthorization } from '../../src/services/oauth.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let sql: ReturnType<typeof postgres> | null = null;
let store: DrizzleOAuthStore | null = null;
let dbReachable = false;
const seededAccounts: string[] = [];
const seededClients: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  sql = postgres(DB_URL, { max: 2 });
  try {
    await sql`SELECT client_id FROM oauth_clients LIMIT 0`;
    dbReachable = true;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    sql = null;
    return;
  }
  store = new DrizzleOAuthStore({ db: drizzle(sql) } as unknown as never);
});

afterAll(async () => {
  if (sql && seededClients.length > 0) {
    await sql`DELETE FROM oauth_clients WHERE client_id = ANY(${sql.array(seededClients)})`.catch(
      () => undefined,
    );
  }
  if (sql && seededAccounts.length > 0) {
    await sql`DELETE FROM accounts WHERE id = ANY(${sql.array(seededAccounts)}::uuid[])`.catch(
      () => undefined,
    );
  }
  await sql?.end({ timeout: 2 }).catch(() => undefined);
});

async function seedAccount(): Promise<string> {
  const accountId = randomUUID();
  await sql!`
    INSERT INTO accounts (id, email, status)
    VALUES (${accountId}, ${`oauth-store-${accountId}@test.local`}, 'active')`;
  seededAccounts.push(accountId);
  return accountId;
}

/**
 * A client record with every field populated, so a round-trip can compare all of them.
 *
 * `idPrefix` exists for the ordering arm. With random ids, "order by created_at"
 * and "order by client_id" agree about half the time, so a mutation swapping them
 * SURVIVED — and the arm was not merely weak, it was a coin flip that happened to
 * land green. Giving the OLDER client an id that sorts LAST makes the two orders
 * disagree every run.
 */
function clientFixture(
  accountId: string,
  createdAt: number,
  idPrefix = 'oauth-store',
): OAuthClient {
  const clientId = `${idPrefix}-${randomUUID()}`;
  seededClients.push(clientId);
  return {
    client_id: clientId,
    client_secret_hash: sha256Hex(`secret-${clientId}`),
    // TWO uris, and not in sorted order: a text[] round-trip that only ever sees
    // one element cannot show a column that drops or reorders the rest.
    redirect_uris: ['https://zzz.test.local/cb', 'https://aaa.test.local/cb'],
    label: 'oauth store round-trip probe',
    account_id: accountId,
    created_at: createdAt,
    revoked_at: null,
  };
}

describe('the OAuth store writes rows it can read back', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database". Every arm below is a SQL round-trip; without a connection they would all skip and this file would report success while executing none of the statements it exists to execute.', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL insertClient → getClient round-trips every field. This is the first execution of that INSERT anywhere in the suite: the four existing db-oauth files seed oauth_clients with hand-written SQL, so a column written to the wrong place, a dropped redirect_uris spread, or a mis-mapped created_at would have inserted cleanly and been read back by nothing.', async () => {
    if (!dbReachable) return;
    const accountId = await seedAccount();
    // Whole seconds: Postgres timestamps round, and a fixture with millisecond
    // precision would fail on the round-trip for a reason that is not the subject.
    const createdAt = Math.floor(Date.now() / 1000) * 1000;
    const client = clientFixture(accountId, createdAt);

    await store!.insertClient(client);
    const read = await store!.getClient(client.client_id);

    expect(read, 'the client did not read back at all').not.toBeNull();
    expect(read, 'a field did not survive the round-trip through Postgres').toEqual(client);
  });

  it('CRITICAL a revoked_at on the way in survives the round-trip. insertClient branches on `revoked_at === null`, and the null side is what every other fixture exercises — so the branch that writes a real timestamp had never run, on the field that decides whether a client can authorize at all.', async () => {
    if (!dbReachable) return;
    const accountId = await seedAccount();
    const createdAt = Math.floor(Date.now() / 1000) * 1000;
    const revokedAt = createdAt + 1000;
    const client = { ...clientFixture(accountId, createdAt), revoked_at: revokedAt };

    await store!.insertClient(client);
    const read = await store!.getClient(client.client_id);

    expect(read?.revoked_at, 'a revoked client read back as live').toBe(revokedAt);
  });

  it('listClients returns what was inserted, oldest first. The ORDER BY is the whole query — an admin console paging this reads the list in the order this clause produces, and nothing had ever run it.', async () => {
    if (!dbReachable) return;
    const accountId = await seedAccount();
    const base = Math.floor(Date.now() / 1000) * 1000;
    // Ids chosen so client_id order is the REVERSE of created_at order.
    const older = clientFixture(accountId, base - 60_000, 'oauth-store-zzz');
    const newer = clientFixture(accountId, base, 'oauth-store-aaa');
    // Inserted newest-first so a listing that echoed insertion order would fail.
    await store!.insertClient(newer);
    await store!.insertClient(older);

    const all = await store!.listClients();
    const ours = all.filter(
      (c) => c.client_id === older.client_id || c.client_id === newer.client_id,
    );
    expect(
      ours.map((c) => c.client_id),
      'listClients did not order by created_at ascending',
    ).toEqual([older.client_id, newer.client_id]);
  });

  it('CRITICAL insertAuthorization → getAuthorization round-trips the pending consent grant. The store is where a half-finished OAuth authorization lives between /authorize and the code exchange; its INSERT had never executed against Postgres, including the scopes[] enum array that decides what the resulting token can do.', async () => {
    if (!dbReachable) return;
    const accountId = await seedAccount();
    const createdAt = Math.floor(Date.now() / 1000) * 1000;
    const client = clientFixture(accountId, createdAt);
    await store!.insertClient(client);

    const pending: PendingAuthorization = {
      authorization_id: `auth-${randomUUID()}`,
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0] as string,
      state: 'state-value',
      scope: ['read', 'write'],
      code_challenge: 'challenge-value',
      created_at: createdAt,
    };

    await store!.insertAuthorization(pending);
    const read = await store!.getAuthorization(pending.authorization_id);

    expect(read, 'the pending authorization did not read back').not.toBeNull();
    expect(read, 'a field did not survive the round-trip').toEqual(pending);
  });

  it('CRITICAL the authorization id is not recoverable from the row. Only sha256(authorization_id) is stored, so getAuthorization echoes the id its CALLER supplied — holding the database is not holding the consent grant. A schema that stored the id in the clear would pass every round-trip above and fail here, which is why the negative lookup is the arm that carries this property.', async () => {
    if (!dbReachable) return;
    const accountId = await seedAccount();
    const createdAt = Math.floor(Date.now() / 1000) * 1000;
    const client = clientFixture(accountId, createdAt);
    await store!.insertClient(client);

    const pending: PendingAuthorization = {
      authorization_id: `auth-${randomUUID()}`,
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0] as string,
      state: 'st',
      scope: ['read'],
      code_challenge: 'ch',
      created_at: createdAt,
    };
    await store!.insertAuthorization(pending);

    // The row exists; this is a different id against the same table.
    const miss = await store!.getAuthorization(`auth-${randomUUID()}`);
    expect(miss, 'a different authorization id resolved to an existing grant').toBeNull();

    // And the stored column really is the hash, not the id.
    const [row] = await sql!<{ authorization_hash: string }[]>`
      SELECT authorization_hash FROM oauth_authorizations
      WHERE authorization_hash = ${sha256Hex(pending.authorization_id)}`;
    expect(row?.authorization_hash, 'the authorization is not keyed by its hash').toBe(
      sha256Hex(pending.authorization_id),
    );
  });

  it('CRITICAL getCode returns a live code and does NOT return an expired one. The TTL is enforced inside the query, so an expired code reads as absent rather than as a row the caller has to remember to check — and that WHERE clause had never run. A code that outlived its window and still resolved would be a replayable consent grant.', async () => {
    if (!dbReachable) return;
    const accountId = await seedAccount();
    const createdAt = Math.floor(Date.now() / 1000) * 1000;
    const client = clientFixture(accountId, createdAt);
    await store!.insertClient(client);

    // Narrowed once: postgres.js refuses `string | undefined` in a template, and
    // `noUncheckedIndexedAccess` makes every element access exactly that.
    const redirectUri = client.redirect_uris[0] as string;
    const live = `code-${randomUUID()}`;
    const stale = `code-${randomUUID()}`;
    await sql!`
      INSERT INTO oauth_authorization_codes
        (code_hash, client_id, redirect_uri, state, scopes, code_challenge, account_id, created_at)
      VALUES (${sha256Hex(live)}, ${client.client_id}, ${redirectUri}, 'st',
              ARRAY['read']::api_key_scope[], 'ch', ${accountId}, now())`;
    // Comfortably past any plausible TTL, so the arm does not depend on its value.
    await sql!`
      INSERT INTO oauth_authorization_codes
        (code_hash, client_id, redirect_uri, state, scopes, code_challenge, account_id, created_at)
      VALUES (${sha256Hex(stale)}, ${client.client_id}, ${redirectUri}, 'st',
              ARRAY['read']::api_key_scope[], 'ch', ${accountId}, now() - interval '2 days')`;

    const found = await store!.getCode(live);
    expect(found?.code, 'a live authorization code did not resolve').toBe(live);
    expect(found?.client_id, 'the code resolved to the wrong client').toBe(client.client_id);
    expect(found?.consumed_at, 'a fresh code came back already consumed').toBeNull();

    expect(
      await store!.getCode(stale),
      'an authorization code past its TTL still resolved — that is a replayable consent grant',
    ).toBeNull();
  });

  it('getToken answers null for a token that was never minted. The read path is covered elsewhere through findLiveToken; this is the entry point the OAuth service actually calls, and an unknown credential resolving to anything but null is the shape of an authentication bypass.', async () => {
    if (!dbReachable) return;
    expect(
      await store!.getToken(`tok-${randomUUID()}`),
      'an unminted token resolved to an access token',
    ).toBeNull();
  });
});
