// Every reason `consumeCodeForToken` refuses to mint a token.
//
// Found by v8 coverage, not by reading. Lines 234 and 249 of
// `db/oauth-store.ts` — the `return 'code_unavailable'` and
// `return 'client_authority_changed'` — are executed by NO test in the suite.
// Both rejection paths of the OAuth token exchange were unexercised.
//
// The filenames nearby suggest otherwise, and that is worth being precise
// about rather than dismissive. `db-oauth-code-single-use-lock-drizzle` and
// `db-oauth-client-authority-lock-drizzle` both call this method and both are
// good tests — of the ROW LOCK under concurrency. They assert the winner
// resolves 'inserted', the code is consumed exactly once, and one authority row
// exists. Neither drives a second consumption to observe what the loser is
// told. The only three mentions of 'code_unavailable' anywhere in the tests are
// a comment, a type signature on a test double, and a source-text regex over
// the caller — no assertion that the value is ever returned.
//
// What each guard stops, in the order the function checks them:
//
//   consumed already   authorization-code REPLAY. The single defining property
//                      of an auth code is that it works once.
//   wrong client       a code issued to client A redeemed by client B — the
//                      confused-deputy exchange that client binding exists for.
//   wrong account      a code issued for account A minting a token for account
//                      B: a token over someone else's data.
//   past its TTL       an old code out of a log, a proxy, a browser history.
//   client authority   revoked client, client re-bound to another account, or a
//                      secret that no longer matches — checked AFTER the code
//                      passes, so a valid code cannot outlive its client.
//
// Against a real Postgres because the checks read committed rows inside the
// transaction that takes the row lock; a double would test my re-reading of the
// predicate rather than the query.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleOAuthStore } from '../../src/db/oauth-store.js';
import { sha256Hex } from '../../src/services/auth-cache.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
/** Matches AUTHORIZATION_CODE_TTL_MS in the store; read via an expired row, not imported. */
const WELL_PAST_ANY_TTL_MS = 24 * 60 * 60 * 1000;

let sql: ReturnType<typeof postgres> | null = null;
let store: DrizzleOAuthStore | null = null;
let reachable = false;
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
    await sql`SELECT 1 FROM oauth_authorization_codes LIMIT 0`;
    reachable = true;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    sql = null;
    return;
  }
  store = new DrizzleOAuthStore({
    client: sql,
    db: drizzle(sql) as unknown as ReturnType<typeof drizzle<typeof schema>>,
  } as never);
});

afterAll(async () => {
  if (sql && seededAccounts.length > 0) {
    await sql`DELETE FROM accounts WHERE id = ANY(${sql.array(seededAccounts)}::uuid[])`.catch(
      () => undefined,
    );
  }
  await sql?.end({ timeout: 2 }).catch(() => undefined);
});

interface Fixture {
  accountId: string;
  clientId: string;
  clientSecretHash: string;
  code: string;
}

/** An account, a live client, and one unconsumed code bound to both. */
async function seed(options: { consumed?: boolean; ageMs?: number } = {}): Promise<Fixture> {
  const accountId = randomUUID();
  const clientId = `oauth-rej-${randomUUID()}`;
  const clientSecretHash = sha256Hex(`secret-${clientId}`);
  const code = `code-${randomUUID()}`;
  await sql!`
    INSERT INTO accounts (id, email, status)
    VALUES (${accountId}, ${`oauth-rej-${accountId}@test.local`}, 'active')`;
  seededAccounts.push(accountId);
  await sql!`
    INSERT INTO oauth_clients (client_id, client_secret_hash, redirect_uris, label, account_id, created_at)
    VALUES (${clientId}, ${clientSecretHash}, ${sql!.array(['https://app.test.local/cb'])},
            'oauth rejection probe', ${accountId}, now())`;
  const createdAt = new Date(Date.now() - (options.ageMs ?? 0));
  await sql!`
    INSERT INTO oauth_authorization_codes
      (code_hash, client_id, redirect_uri, state, scopes, code_challenge, account_id, created_at, consumed_at)
    VALUES (${sha256Hex(code)}, ${clientId}, 'https://app.test.local/cb', 'st',
            ARRAY['read']::api_key_scope[], 'challenge', ${accountId},
            ${createdAt.toISOString()}::timestamptz,
            ${options.consumed === true ? sql!`now()` : null})`;
  return { accountId, clientId, clientSecretHash, code };
}

function exchange(
  fixture: Fixture,
  overrides: Partial<{ clientId: string; accountId: string; secretHash: string }> = {},
): Promise<'inserted' | 'code_unavailable' | 'client_authority_changed'> {
  const now = Date.now();
  return store!.consumeCodeForToken({
    code: fixture.code,
    consumed_at: now,
    token: {
      token: `tok-${randomUUID()}`,
      client_id: overrides.clientId ?? fixture.clientId,
      account_id: overrides.accountId ?? fixture.accountId,
      scope: ['read'],
      created_at: now,
      expires_at: now + 3_600_000,
    },
    expectedClientSecretHash: overrides.secretHash ?? fixture.clientSecretHash,
  });
}

describe('consumeCodeForToken rejection reasons', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database"', () => {
    expect(reachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(true);
  });

  it('CRITICAL the happy path still mints, so the rejections below are not vacuous', async () => {
    if (!reachable) return;
    expect(await exchange(await seed())).toBe('inserted');
  });

  it('CRITICAL an already-consumed code is refused — authorization codes work once', async () => {
    if (!reachable) return;
    const fixture = await seed({ consumed: true });
    expect(
      await exchange(fixture),
      'a consumed authorization code minted a second token — this is code replay',
    ).toBe('code_unavailable');
  });

  it('CRITICAL a code issued to another client is refused', async () => {
    if (!reachable) return;
    const mine = await seed();
    const other = await seed();
    expect(
      await exchange(mine, { clientId: other.clientId, secretHash: other.clientSecretHash }),
      'a code issued to one client was redeemed by another — the confused-deputy exchange',
    ).toBe('code_unavailable');
  });

  it('CRITICAL a code issued for another account is refused', async () => {
    if (!reachable) return;
    const mine = await seed();
    const other = await seed();
    expect(
      await exchange(mine, { accountId: other.accountId }),
      'a code bound to one account minted a token over another account',
    ).toBe('code_unavailable');
  });

  it('CRITICAL a code older than its TTL is refused', async () => {
    if (!reachable) return;
    const stale = await seed({ ageMs: WELL_PAST_ANY_TTL_MS });
    expect(await exchange(stale), 'an expired authorization code was still redeemable').toBe(
      'code_unavailable',
    );
  });

  it('CRITICAL a revoked client cannot redeem a valid code', async () => {
    if (!reachable) return;
    const fixture = await seed();
    await sql!`UPDATE oauth_clients SET revoked_at = now() WHERE client_id = ${fixture.clientId}`;
    expect(
      await exchange(fixture),
      'a revoked client redeemed a code issued before its revocation — revocation must take ' +
        'effect at exchange time, not only at issue time',
    ).toBe('client_authority_changed');
  });

  it('CRITICAL a stale client secret cannot redeem a valid code', async () => {
    if (!reachable) return;
    const fixture = await seed();
    expect(
      await exchange(fixture, { secretHash: sha256Hex('a-different-secret') }),
      'the exchange accepted a client secret that no longer matches the stored hash',
    ).toBe('client_authority_changed');
  });
});
