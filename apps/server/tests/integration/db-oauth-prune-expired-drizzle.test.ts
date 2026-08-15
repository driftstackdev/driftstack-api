// `pruneExpired` must delete only what has actually expired, against real
// Postgres in an isolated database.
//
// It is a global sweep with no account scope — by design — and it deletes from
// THREE tables in one transaction, each guarded by exactly ONE time predicate and
// nothing else:
//
//   oauth_authorizations       createdAt <  now - AUTHORIZATION_CODE_TTL_MS
//   oauth_authorization_codes  createdAt <  now - AUTHORIZATION_CODE_TTL_MS
//   oauth_access_tokens        expiresAt <= now
//
// Lose any one of those and the sweep empties that table. The token row is the
// one that hurts: every OAuth-authenticated customer's credential disappears and
// every integration built on it breaks until the customer re-authorises. Nothing
// about that is recoverable by retrying the sweep.
//
// Coverage before this file: three unit tests, all against the in-memory store,
// which re-implements the same comparison by hand. No integration test called it
// — correctly, since `global-scope-db-tests-are-isolated` forbids a global
// operation against the SHARED database. `ensureIsolatedDatabase` is that rule's
// sanctioned exception and the meta-guard skips files that use it.
//
// The fixtures straddle each boundary rather than sitting far from it: a token one
// second past expiry and one a day short of it, an authorization just outside the
// code TTL and one just inside. A sweep that deleted everything and a sweep that
// deleted nothing both pass a test whose fixtures are all on one side.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleOAuthStore } from '../../src/db/oauth-store.js';
import { ensureIsolatedDatabase } from './_helpers/isolated-database.js';
import type * as schema from '../../src/db/schema.js';

const ISOLATED_DB_NAME = 'driftstack_iso_oauth_prune';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

let DB_URL = '';
let client: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  const isolated = await ensureIsolatedDatabase(ISOLATED_DB_NAME);
  if (isolated === null) return;
  DB_URL = isolated;
  if (!RUN_DB_TESTS) return;
  client = postgres(DB_URL, { max: 1 });
  try {
    await client`SELECT 1 FROM oauth_access_tokens LIMIT 0`;
  } catch {
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
});

describe.skipIf(!RUN_DB_TESTS)('OAuth pruneExpired (isolated real Postgres)', () => {
  it('CRITICAL deletes only tokens that have actually expired and authorizations past the code TTL — a live token surviving the sweep is the whole point, since deleting it logs a customer out of every integration they built', async () => {
    if (!client) {
      if (process.env.CI) {
        throw new Error(
          'real-PG oauth-prune test: isolated database unreachable/unmigrated in CI — vacuous pass is forbidden',
        );
      }
      return;
    }
    // Bind a non-null local: `client` is a module-level `let`, so the early
    // return above does not narrow it inside the helper closures below.
    const pg = client;
    const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
    const store = new DrizzleOAuthStore({ client, db, close: async () => {} });

    const accountId = randomUUID();
    const clientId = `cli_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const now = new Date('2026-07-01T12:00:00.000Z');
    await pg`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`oauth-${accountId}@test.local`})`;
    await pg`
      INSERT INTO oauth_clients (client_id, client_secret_hash, redirect_uris, label, account_id, created_at)
      VALUES (${clientId}, ${'a'.repeat(64)}, ARRAY['https://app.example/cb'], 'prune-test', ${accountId}, ${now.toISOString()})`;

    // The isolated database PERSISTS between runs, so every globally-unique
    // column needs a per-run value: api_keys.key_prefix is unique, and the
    // authorization hash is a primary key.
    const run = randomUUID().replaceAll('-', '').slice(0, 12);
    // Both hash columns carry a `^[0-9a-f]{64}$` check constraint, so fixtures
    // must be real 64-char hex rather than readable labels.
    const hex64 = (): string => (randomUUID() + randomUUID()).replaceAll('-', '');

    // Access tokens need a backing api_keys row (the token id IS the key id).
    const mkToken = async (label: string, expiresAt: string): Promise<string> => {
      const [key] = await pg`
        INSERT INTO api_keys (account_id, name, key_prefix, key_hash)
        VALUES (${accountId}, ${label}, ${`dk_${run}_${label}`}, ${`hash-${run}-${label}`})
        RETURNING id`;
      const id = key?.id as string;
      await pg`
        INSERT INTO oauth_access_tokens (id, token_hash, client_id, account_id, scopes, created_at, expires_at)
        VALUES (${id}, ${hex64()}, ${clientId}, ${accountId}, ARRAY['read:sessions']::api_key_scope[],
                ${now.toISOString()}, ${expiresAt})`;
      return id;
    };

    // One second past expiry, and one a day short of it — both near the boundary,
    // so a sweep that deletes everything and one that deletes nothing are each
    // caught.
    const expiredToken = await mkToken('expired', '2026-07-01T11:59:59.000Z');
    const liveToken = await mkToken('live', '2026-07-02T12:00:00.000Z');

    const mkAuthorization = async (hash: string, createdAt: string): Promise<void> => {
      await pg`
        INSERT INTO oauth_authorizations
          (authorization_hash, client_id, redirect_uri, state, scopes, code_challenge, created_at)
        VALUES (${hash}, ${clientId}, 'https://app.example/cb', 'st', ARRAY['read:sessions']::api_key_scope[],
                'chal', ${createdAt})`;
    };
    // The code TTL is minutes; an hour old is comfortably stale, "now" is fresh.
    const staleHash = hex64();
    const freshHash = hex64();
    await mkAuthorization(staleHash, '2026-07-01T11:00:00.000Z');
    await mkAuthorization(freshHash, now.toISOString());

    // The transaction deletes from THREE tables; a fixture for only two leaves
    // the third predicate unmeasured, and a ledger confirmed exactly that.
    const mkCode = async (hash: string, createdAt: string): Promise<void> => {
      await pg`
        INSERT INTO oauth_authorization_codes
          (code_hash, client_id, redirect_uri, state, scopes, code_challenge, account_id, created_at)
        VALUES (${hash}, ${clientId}, 'https://app.example/cb', 'st', ARRAY['read:sessions']::api_key_scope[],
                'chal', ${accountId}, ${createdAt})`;
    };
    const staleCode = hex64();
    const freshCode = hex64();
    await mkCode(staleCode, '2026-07-01T11:00:00.000Z');
    await mkCode(freshCode, now.toISOString());

    await store.pruneExpired(now.getTime());

    const tokens = await pg<Array<{ id: string }>>`SELECT id FROM oauth_access_tokens`;
    const tokenIds = tokens.map((r) => r.id);
    expect(tokenIds, 'an UNEXPIRED token must survive the sweep').toContain(liveToken);
    expect(tokenIds, 'an expired token must be swept').not.toContain(expiredToken);

    const auths = await pg<Array<{ authorization_hash: string }>>`
      SELECT authorization_hash FROM oauth_authorizations`;
    const hashes = auths.map((r) => r.authorization_hash);
    expect(hashes, 'an authorization inside the code TTL must survive').toContain(freshHash);
    expect(hashes, 'one past the code TTL must be swept').not.toContain(staleHash);

    const codes = await pg<Array<{ code_hash: string }>>`
      SELECT code_hash FROM oauth_authorization_codes`;
    const codeHashes = codes.map((r) => r.code_hash);
    expect(codeHashes, 'a code inside the TTL must survive — it is mid-exchange').toContain(
      freshCode,
    );
    expect(codeHashes, 'one past the TTL must be swept').not.toContain(staleCode);

    // The backing api_keys row is deliberately NOT deleted with the token — it
    // stays as an expired actor identity for session and audit FK integrity — so
    // assert that too rather than leaving the transaction's blast radius untested.
    const keys = await pg<Array<{ id: string }>>`
      SELECT id FROM api_keys WHERE account_id = ${accountId}`;
    expect(
      keys.map((r) => r.id),
      'the backing api_keys row outlives its token',
    ).toContain(expiredToken);
  });
});
