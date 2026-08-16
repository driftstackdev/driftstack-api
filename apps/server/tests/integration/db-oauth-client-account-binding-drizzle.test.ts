// An account-bound OAuth client cannot be used by a different account.
//
// `consumeAuthorizationForCode` checks, after loading the client:
//
//   if (client.accountId !== null && client.accountId !== args.account_id) {
//     return 'account_mismatch';
//   }
//
// `oauth_clients.account_id` is nullable: NULL means a public client any account
// may authorize, non-NULL means the client is PRIVATE to that account. The check is
// the only thing enforcing that binding at consume time.
//
// Deleting it does not throw. Execution falls through to the DELETE of the
// authorization and the INSERT of the code, and the method answers 'inserted' — so
// a client private to account A becomes usable by account B, and since A controls
// that client's redirect_uri and secret, the code minted for B's account is
// delivered to A. The binding is exactly the control that stops a tenant's private
// client from being offered to other tenants.
//
// Measured never executed: from a coverage pass taken WITH DATABASE_URL set (so the
// integration files were running and cannot be why a branch looks unfired), this
// `return` has a statement count of zero. The only references anywhere are a
// content-parity pin on the SERVICE's `if (committed === 'account_mismatch')` text
// and the in-memory store's type signature — a pin on the handling of a value, and
// a declaration that it exists, neither of which requires the repo to ever produce
// it.
//
// The assertions cover the refusal AND its absence of side effects, because the
// dangerous fall-through is not the return value but the two writes that follow it.
// A test asserting only the verdict would pass against an implementation that
// refused after consuming the authorization.

import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleOAuthStore } from '../../src/db/oauth-store.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

let admin: ReturnType<typeof postgres> | null = null;
const seeded: Array<{ owner: string; other: string; clientId: string }> = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  admin = postgres(DB_URL, { max: 2 });
  try {
    await admin`SELECT 1 FROM oauth_authorizations LIMIT 0`;
  } catch {
    await admin.end({ timeout: 1 }).catch(() => {});
    admin = null;
  }
});

afterAll(async () => {
  if (!admin) return;
  for (const { owner, other, clientId } of seeded) {
    await admin`DELETE FROM oauth_authorization_codes WHERE client_id = ${clientId}`.catch(
      () => {},
    );
    await admin`DELETE FROM oauth_authorizations WHERE client_id = ${clientId}`.catch(() => {});
    await admin`DELETE FROM oauth_clients WHERE client_id = ${clientId}`.catch(() => {});
    await admin`DELETE FROM accounts WHERE id IN (${owner}, ${other})`.catch(() => {});
  }
  await admin.end({ timeout: 5 });
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'an account-bound OAuth client refuses a different account (real Postgres)',
  () => {
    it("CRITICAL consumeAuthorizationForCode answers account_mismatch, consumes nothing, and mints no code when the client is private to another account. Without that check it falls through to the DELETE and the INSERT and answers inserted, so one tenant's private client becomes usable by another — and because the owning tenant controls that client's redirect_uri and secret, the code minted for the other account is delivered to them.", async () => {
      if (!admin) {
        if (process.env.CI) {
          throw new Error(
            'real-PG oauth-client-binding test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const a = admin;
      const owner = randomUUID();
      const other = randomUUID();
      const clientId = `oauth-bound-${randomUUID()}`;
      const authorizationId = `authz-${randomUUID()}`;
      seeded.push({ owner, other, clientId });

      await a`
        INSERT INTO accounts (id, email, status) VALUES
          (${owner}, ${`oauth-owner-${owner}@test.local`}, 'active'),
          (${other}, ${`oauth-other-${other}@test.local`}, 'active')`;
      // account_id = owner — a PRIVATE client, not a public one.
      await a`
        INSERT INTO oauth_clients (client_id, client_secret_hash, redirect_uris, label, account_id, created_at)
        VALUES (${clientId}, ${sha256Hex(`secret-${clientId}`)}, ${a.array(['https://app.test.local/cb'])},
                'account-bound client', ${owner}, now())`;
      await a`
        INSERT INTO oauth_authorizations
          (authorization_hash, client_id, redirect_uri, state, scopes, code_challenge, created_at)
        VALUES (${sha256Hex(authorizationId)}, ${clientId}, 'https://app.test.local/cb', 'st',
                ARRAY['read']::api_key_scope[], 'challenge', now())`;

      const store = new DrizzleOAuthStore({
        client: a,
        db: drizzle(a) as unknown as ReturnType<typeof drizzle<typeof schema>>,
        close: async () => {},
      });

      const now = Date.now();
      const verdict = await store.consumeAuthorizationForCode({
        authorization_id: authorizationId,
        code: `code-${randomUUID()}`,
        // The OTHER account — the one the client is not bound to.
        account_id: other,
        scope: ['read'],
        created_at: now,
        not_before: now - 600_000,
      });

      expect(verdict, 'a client private to another account must be refused').toBe(
        'account_mismatch',
      );

      // The two writes the refusal must precede. Without the check these both land
      // and the refusal never happens at all, so asserting the verdict alone would
      // not distinguish "refused" from "refused after doing the work".
      const codes = await a<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM oauth_authorization_codes WHERE client_id = ${clientId}`;
      expect(codes[0]?.n, 'no authorization code may be minted for a mismatched account').toBe(0);

      const left = await a<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM oauth_authorizations WHERE client_id = ${clientId}`;
      expect(left[0]?.n, 'the authorization survives so its rightful owner can still use it').toBe(
        1,
      );
    });

    it('the same client still works for the account it is bound to', async () => {
      if (!admin) {
        if (process.env.CI) {
          throw new Error(
            'real-PG oauth-client-binding test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const a = admin;
      const owner = randomUUID();
      const other = randomUUID();
      const clientId = `oauth-bound-ok-${randomUUID()}`;
      const authorizationId = `authz-${randomUUID()}`;
      seeded.push({ owner, other, clientId });

      await a`
        INSERT INTO accounts (id, email, status) VALUES
          (${owner}, ${`oauth-owner-${owner}@test.local`}, 'active'),
          (${other}, ${`oauth-other-${other}@test.local`}, 'active')`;
      await a`
        INSERT INTO oauth_clients (client_id, client_secret_hash, redirect_uris, label, account_id, created_at)
        VALUES (${clientId}, ${sha256Hex(`secret-${clientId}`)}, ${a.array(['https://app.test.local/cb'])},
                'account-bound client', ${owner}, now())`;
      await a`
        INSERT INTO oauth_authorizations
          (authorization_hash, client_id, redirect_uri, state, scopes, code_challenge, created_at)
        VALUES (${sha256Hex(authorizationId)}, ${clientId}, 'https://app.test.local/cb', 'st',
                ARRAY['read']::api_key_scope[], 'challenge', now())`;

      const store = new DrizzleOAuthStore({
        client: a,
        db: drizzle(a) as unknown as ReturnType<typeof drizzle<typeof schema>>,
        close: async () => {},
      });

      const now = Date.now();
      // The positive arm exists so "refuse everything" cannot satisfy this file —
      // the binding must reject the stranger AND admit the owner.
      const verdict = await store.consumeAuthorizationForCode({
        authorization_id: authorizationId,
        code: `code-${randomUUID()}`,
        account_id: owner,
        scope: ['read'],
        created_at: now,
        not_before: now - 600_000,
      });

      expect(verdict).toBe('inserted');
      const codes = await a<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM oauth_authorization_codes WHERE client_id = ${clientId}`;
      expect(codes[0]?.n).toBe(1);
    });
  },
);
