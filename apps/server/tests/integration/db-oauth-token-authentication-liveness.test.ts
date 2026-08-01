// An expired or revoked OAuth bearer token does not authenticate.
//
// `findTokenForAuthentication` is the live credential check behind OAuth bearer
// auth — `services/auth.ts` calls it on the request path. It resolves a token
// only while FOUR conditions hold: the access token is unrevoked and unexpired,
// and the API key it is bound to is unrevoked and unexpired.
//
// Found by mutation sweep. All four were neutralised at once — the two
// `isNull(…revokedAt)` predicates deleted and the two `gt(…expiresAt, now)`
// checks rewritten to `gt(…expiresAt, new Date(0))`, which every real row
// satisfies — and the FULL suite stayed green: 2,566 files, 26,599 tests, zero
// failures. A revoked API key, an expired API key, a revoked access token and an
// expired access token would each still have authenticated, and nothing would
// have said so.
//
// There is no second line of defence here. Unlike the repo ownership checks
// closed earlier this week, where a service-layer check sat in front, THIS query
// is the credential check: whatever it returns is treated as an authenticated
// caller. Revocation in particular is the control a customer uses after leaking
// a key, and expiry is what bounds the damage of one they never noticed leaking.
//
// Against real Postgres, because all four conditions live in SQL — two of them
// inside an innerJoin, which is precisely where a predicate is easy to drop
// without any caller noticing.

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import { DrizzleOAuthStore } from '../../src/db/oauth-store.js';
import * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const NOW = new Date('2026-08-02T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

const sha256Hex = (v: string): string => createHash('sha256').update(v).digest('hex');

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
let store: DrizzleOAuthStore | null = null;
const seededAccounts: string[] = [];
const seededClients: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM oauth_access_tokens LIMIT 0`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 4 });
  store = new DrizzleOAuthStore({ client, db: drizzle(client, { schema }), close: async () => {} });
});

afterAll(async () => {
  if (client) {
    for (const accountId of seededAccounts) {
      await client`DELETE FROM oauth_access_tokens WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM api_keys WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    for (const clientId of seededClients) {
      await client`DELETE FROM oauth_clients WHERE client_id = ${clientId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

/**
 * One live OAuth grant: account, client, API key and the access token bound to
 * it. `oauth_access_tokens.id` and `api_keys.id` are deliberately the SAME id —
 * that is the join `findLiveToken` uses, so the API key's own revocation and
 * expiry apply to the token.
 */
async function seedGrant(
  args: {
    tokenExpiresAt?: Date;
    tokenRevokedAt?: Date | null;
    keyExpiresAt?: Date;
    keyRevokedAt?: Date | null;
  } = {},
): Promise<string> {
  if (!client) throw new Error('no client');
  const accountId = randomUUID();
  const clientId = `cli_${randomUUID()}`;
  const id = randomUUID();
  const token = `dsk_${randomUUID().replace(/-/g, '')}`;
  seededAccounts.push(accountId);
  seededClients.push(clientId);

  await client`
    INSERT INTO accounts (id, email, status)
    VALUES (${accountId}, ${`oauth-live-${accountId}@test.local`}, 'active')`;
  await client`
    INSERT INTO oauth_clients (client_id, client_secret_hash, redirect_uris, label, account_id, created_at)
    VALUES (${clientId}, ${sha256Hex(clientId)}, ARRAY['https://app.test/cb'], 'test client', ${accountId}, now())`;
  await client`
    INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash, scopes, expires_at, revoked_at)
    VALUES (
      ${id}, ${accountId}, 'oauth key', ${token.slice(0, 12)}, ${sha256Hex(token)}, ARRAY['read']::api_key_scope[],
      ${(args.keyExpiresAt ?? new Date(NOW.getTime() + HOUR_MS)).toISOString()}::timestamptz,
      ${args.keyRevokedAt === undefined || args.keyRevokedAt === null ? null : args.keyRevokedAt.toISOString()}
    )`;
  await client`
    INSERT INTO oauth_access_tokens (id, token_hash, client_id, account_id, scopes, created_at, expires_at, revoked_at)
    VALUES (
      ${id}, ${sha256Hex(token)}, ${clientId}, ${accountId}, ARRAY['read']::api_key_scope[], now(),
      ${(args.tokenExpiresAt ?? new Date(NOW.getTime() + HOUR_MS)).toISOString()}::timestamptz,
      ${args.tokenRevokedAt === undefined || args.tokenRevokedAt === null ? null : args.tokenRevokedAt.toISOString()}
    )`;
  return token;
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'OAuth bearer tokens authenticate only while live',
  () => {
    it('CRITICAL the database is reachable. Every case is a SQL round-trip; if the connection failed they would skip and this file would report success while proving nothing about a credential check.', () => {
      expect(dbReachable, `could not reach ${DB_URL} — these results would be meaningless`).toBe(
        true,
      );
    });

    it('CRITICAL a fully live token DOES authenticate. The positive arm — every other case here is a rejection, and a resolver that returned null for everything would satisfy all of them while breaking OAuth entirely.', async () => {
      const token = await seedGrant();

      const resolved = await store!.findTokenForAuthentication(token, NOW.getTime());

      expect(resolved, 'a live token resolves').not.toBeNull();
    });

    it('CRITICAL an EXPIRED access token does not authenticate. Expiry is what bounds the damage of a credential the customer never noticed leaking.', async () => {
      const token = await seedGrant({ tokenExpiresAt: new Date(NOW.getTime() - HOUR_MS) });

      expect(await store!.findTokenForAuthentication(token, NOW.getTime())).toBeNull();
    });

    it('CRITICAL a REVOKED access token does not authenticate. Revocation is the control a customer reaches for after a key leaks; if it does not take effect the leak cannot be stopped.', async () => {
      const token = await seedGrant({ tokenRevokedAt: new Date(NOW.getTime() - 60_000) });

      expect(await store!.findTokenForAuthentication(token, NOW.getTime())).toBeNull();
    });

    it('CRITICAL an expired API KEY kills the token bound to it, even when the token itself is still live. This predicate sits inside an innerJoin, which is exactly where a condition gets dropped without any caller noticing.', async () => {
      const token = await seedGrant({ keyExpiresAt: new Date(NOW.getTime() - HOUR_MS) });

      expect(await store!.findTokenForAuthentication(token, NOW.getTime())).toBeNull();
    });

    it('CRITICAL a revoked API KEY kills the token bound to it, even when the token itself is unrevoked. Revoking the key a customer can see must not leave a derived OAuth token alive behind it.', async () => {
      const token = await seedGrant({ keyRevokedAt: new Date(NOW.getTime() - 60_000) });

      expect(await store!.findTokenForAuthentication(token, NOW.getTime())).toBeNull();
    });

    it('CRITICAL expiry is evaluated against the CALLER’S clock, not a constant. A token live at one instant and expired an hour later must resolve differently for the same row, or the check is pinned to whatever `now` happened to be.', async () => {
      // The API key is given a far-future expiry deliberately. With the default
      // (NOW + 1h) the second call below returns null because the KEY expired,
      // not the token — so this case passed even with the token-expiry check
      // neutralised. Caught by mutation: it red 1 case instead of 2. A sibling
      // predicate masking the one under test is the same trap this sweep keeps
      // finding elsewhere, and it is just as easy to write into a new guard.
      const token = await seedGrant({
        tokenExpiresAt: new Date(NOW.getTime() + HOUR_MS),
        keyExpiresAt: new Date(NOW.getTime() + 10 * 24 * HOUR_MS),
      });

      expect(
        await store!.findTokenForAuthentication(token, NOW.getTime()),
        'live before its expiry',
      ).not.toBeNull();
      expect(
        await store!.findTokenForAuthentication(token, NOW.getTime() + 2 * HOUR_MS),
        'and dead after it',
      ).toBeNull();
    });
  },
);
