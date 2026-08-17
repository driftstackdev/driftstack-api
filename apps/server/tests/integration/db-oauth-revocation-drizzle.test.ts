// Revoking an OAuth token has to actually stop it authenticating.
//
// v8 coverage: `db/oauth-store.ts` is the lowest-covered repository at 41.6% of
// functions, and the split is telling — the mint-and-read hot path
// (`consumeCodeForToken`, `findLiveToken`, `findTokenForAuthentication`) is
// exercised, while `revokeToken`, `revokeClient` and `rotateClientSecretHash`
// execute zero statements. Nothing in the suite revokes anything and then
// checks it stopped working.
//
// That gap matters because of how an OAuth token is stored. `consumeCodeForToken`
// inserts an `api_keys` row FIRST and reuses its id as the `oauth_access_tokens`
// id — the token is a real API key with provenance 'oauth', and the `api_keys`
// row is what the normal authentication path reads. So each revoke has to write
// BOTH rows:
//
//   oauth_access_tokens   the OAuth-side record.
//   api_keys              the authority requests actually authenticate against.
//
// Revoke only the first and the token keeps working everywhere that matters,
// while every OAuth-side listing shows it as revoked — a revocation that reports
// success and changes nothing. That is the failure this file is here to catch,
// and it is invisible to a test that only re-reads through the OAuth store.
//
// `revokeClient` is the same property one level up (revoking a client must take
// its live tokens with it, and nobody else's), and `rotateClientSecretHash`
// carries the matching no-resurrection rule: a revoked client's secret cannot be
// rotated back into use.
//
// Against a real Postgres: every one of these is a transaction that takes a row
// lock, re-reads inside it, and writes two tables conditionally on
// `isNull(revokedAt)`. None of that survives being re-expressed in a double.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleOAuthStore } from '../../src/db/oauth-store.js';
import { sha256Hex } from '../../src/services/auth-cache.js';
import type { AccessToken } from '../../src/services/oauth.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const HOUR = 60 * 60 * 1000;

let sql: ReturnType<typeof postgres> | null = null;
let store: DrizzleOAuthStore | null = null;
let dbReachable = false;
const seededAccounts: string[] = [];

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
    await sql`SELECT revoked_at FROM oauth_access_tokens LIMIT 0`;
    dbReachable = true;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    sql = null;
    return;
  }
  store = new DrizzleOAuthStore({ db: drizzle(sql) } as unknown as never);
});

afterAll(async () => {
  if (sql && seededAccounts.length > 0) {
    await sql`DELETE FROM accounts WHERE id = ANY(${sql.array(seededAccounts)}::uuid[])`.catch(
      () => undefined,
    );
  }
  await sql?.end({ timeout: 2 }).catch(() => undefined);
});

interface Minted {
  accountId: string;
  clientId: string;
  clientSecretHash: string;
  token: string;
}

/**
 * Mints a token the way production does — through the real exchange — so the
 * paired api_keys authority row exists exactly as it would live. Seeding the
 * two tables by hand would let the pairing this file is about drift out from
 * under the assertions.
 */
async function mintToken(): Promise<Minted> {
  const accountId = randomUUID();
  const clientId = `oauth-rev-${randomUUID()}`;
  const clientSecretHash = sha256Hex(`secret-${clientId}`);
  const code = `code-${randomUUID()}`;
  const token = `tok-${randomUUID()}`;

  await sql!`
    INSERT INTO accounts (id, email, status)
    VALUES (${accountId}, ${`oauth-rev-${accountId}@test.local`}, 'active')`;
  seededAccounts.push(accountId);
  await sql!`
    INSERT INTO oauth_clients (client_id, client_secret_hash, redirect_uris, label, account_id, created_at)
    VALUES (${clientId}, ${clientSecretHash}, ${sql!.array(['https://app.test.local/cb'])},
            'oauth revocation probe', ${accountId}, now())`;
  await sql!`
    INSERT INTO oauth_authorization_codes
      (code_hash, client_id, redirect_uri, state, scopes, code_challenge, account_id, created_at)
    VALUES (${sha256Hex(code)}, ${clientId}, 'https://app.test.local/cb', 'st',
            ARRAY['read']::api_key_scope[], 'challenge', ${accountId}, now())`;

  const now = Date.now();
  const accessToken: AccessToken = {
    token,
    client_id: clientId,
    account_id: accountId,
    scope: ['read'],
    created_at: now,
    expires_at: now + HOUR,
  };
  const outcome = await store!.consumeCodeForToken({
    code,
    consumed_at: now,
    token: accessToken,
    expectedClientSecretHash: clientSecretHash,
  });
  expect(outcome, 'fixture precondition: the token exchange did not mint a token').toBe('inserted');
  return { accountId, clientId, clientSecretHash, token };
}

/** The authority row requests actually authenticate against. */
async function authorityRevoked(token: string): Promise<boolean> {
  const [row] = await sql!<{ revoked_at: Date | null }[]>`
    SELECT k.revoked_at FROM api_keys k WHERE k.key_hash = ${sha256Hex(token)}`;
  expect(row, 'no api_keys authority row was minted for this token').toBeDefined();
  return row?.revoked_at !== null;
}

describe('OAuth revocation', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database"', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL a freshly minted token authenticates', async () => {
    if (!dbReachable || !store) return;
    const { token, accountId } = await mintToken();
    const found = await store.findTokenForAuthentication(token, Date.now());
    expect(found?.account_id, 'the mint path produced a token that cannot authenticate').toBe(
      accountId,
    );
    expect(await authorityRevoked(token)).toBe(false);
  });

  it('CRITICAL a revoked token stops authenticating', async () => {
    if (!dbReachable || !store) return;
    const { token } = await mintToken();
    await store.revokeToken(token);
    expect(
      await store.findTokenForAuthentication(token, Date.now()),
      'the token still authenticated after being revoked',
    ).toBeNull();
  });

  it('CRITICAL revoking a token also revokes the api key it authenticates through', async () => {
    if (!dbReachable || !store) return;
    const { token } = await mintToken();
    await store.revokeToken(token);
    expect(
      await authorityRevoked(token),
      'the OAuth row was revoked but its paired api_keys authority was left live — the token keeps ' +
        'working on the path requests actually use, while every OAuth listing shows it revoked',
    ).toBe(true);
  });

  it('CRITICAL revoking an unknown token changes nothing', async () => {
    if (!dbReachable || !store) return;
    const { token } = await mintToken();
    await store.revokeToken(`tok-${randomUUID()}`);
    expect(
      await store.findTokenForAuthentication(token, Date.now()),
      'revoking a token that does not exist revoked a live one',
    ).not.toBeNull();
  });

  it('CRITICAL revoking a client revokes its live tokens, on both tables', async () => {
    if (!dbReachable || !store) return;
    const { clientId, token } = await mintToken();
    await store.revokeClient(clientId, Date.now());
    expect(
      await store.findTokenForAuthentication(token, Date.now()),
      'a revoked client’s token still authenticated',
    ).toBeNull();
    expect(
      await authorityRevoked(token),
      'the client was revoked but its token’s api_keys authority stayed live',
    ).toBe(true);
  });

  it('CRITICAL revoking one client leaves another client’s token alone', async () => {
    if (!dbReachable || !store) return;
    const mine = await mintToken();
    const theirs = await mintToken();
    await store.revokeClient(mine.clientId, Date.now());
    expect(
      await store.findTokenForAuthentication(theirs.token, Date.now()),
      'revoking one client cascaded into another client’s tokens',
    ).not.toBeNull();
    expect(await authorityRevoked(theirs.token)).toBe(false);
  });

  it('CRITICAL a revoked client is gone from reads and cannot rotate its secret', async () => {
    if (!dbReachable || !store) return;
    const { clientId } = await mintToken();
    expect((await store.getClient(clientId))?.revoked_at, 'precondition: client starts live').toBe(
      null,
    );
    await store.revokeClient(clientId, Date.now());
    expect((await store.getClient(clientId))?.revoked_at).not.toBeNull();
    expect(
      await store.rotateClientSecretHash(clientId, sha256Hex('brand-new-secret')),
      'a revoked client rotated its secret back into use — revocation has to be final, or it is ' +
        'just a password change',
    ).toBe(false);
  });

  it('CRITICAL a live client can rotate its secret', async () => {
    if (!dbReachable || !store) return;
    const { clientId } = await mintToken();
    expect(
      await store.rotateClientSecretHash(clientId, sha256Hex('rotated')),
      'a live client could not rotate its secret — the no-resurrection rule above would pass ' +
        'trivially if rotation never worked at all',
    ).toBe(true);
    expect((await store.getClient(clientId))?.client_secret_hash).toBe(sha256Hex('rotated'));
  });
});
