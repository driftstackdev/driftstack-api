// One authorization yields exactly ONE code — nine independent clients, not
// forced ordering.
//
// `consumeAuthorizationForCode` locks the authorization row, checks freshness,
// DELETEs it, and inserts an authorization code. The DELETE's row count is never
// examined, so without the lock two callers that both read the row before either
// commits will BOTH insert a code — one user consent producing two codes, each
// separately exchangeable for an API key. Same defect class as code replay, one
// step earlier in the flow.
//
// Why this file races instead of forcing ordering, unlike the other five lock
// proofs. The forced-ordering technique puts a holder on the row with FOR KEY
// SHARE, chosen so it conflicts with the repo's FOR UPDATE but with nothing an
// unguarded path would take. That choice does not exist here: an unguarded path
// still DELETEs the row, and a DELETE acquires a lock of FOR UPDATE strength
// because it removes the key. A KEY SHARE holder therefore blocks BOTH variants —
// the guarded one at its SELECT, the unguarded one at its DELETE — and the test
// would pass identically with the lock deleted. That is precisely the trap that
// fooled the first version of the profile-cap test, and it is worth stating
// because the technique that worked five times in a row does not transfer here.
//
// What does work is sample count. The measured rule: a race detects a lock when
// the callers are genuinely independent and there are enough of them. Two
// connections on a sub-millisecond path miss the window; nine separate `postgres()`
// clients hit it, which is how `db-session-operation-claim-drizzle` detects its
// lock. So this file opens nine independent clients and has each try to consume
// the SAME authorization with a DIFFERENT code.
//
// The assertion is self-evidencing rather than a bare count: exactly one caller
// may report 'inserted', and the codes table must hold exactly one row for the
// client. Distinct codes matter — with a shared code the primary key would mask
// the defect as a constraint error instead of showing the two codes it really
// produces.

import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleOAuthStore } from '../../src/db/oauth-store.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const CLIENTS = 9;

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

let admin: ReturnType<typeof postgres> | null = null;
let racers: Array<ReturnType<typeof postgres>> = [];
const seeded: Array<{ accountId: string; clientId: string }> = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  admin = postgres(DB_URL, { max: 1 });
  try {
    await admin`SELECT 1 FROM oauth_authorizations LIMIT 0`;
  } catch {
    await admin.end({ timeout: 1 }).catch(() => {});
    admin = null;
    return;
  }
  // Independent connections, deliberately — a shared pool would serialise these
  // callers inside this process and the race would never reach Postgres.
  racers = Array.from({ length: CLIENTS }, () => postgres(DB_URL, { max: 1 }));
});

afterAll(async () => {
  if (admin) {
    for (const { accountId, clientId } of seeded) {
      await admin`DELETE FROM oauth_authorization_codes WHERE client_id = ${clientId}`.catch(
        () => {},
      );
      await admin`DELETE FROM oauth_authorizations WHERE client_id = ${clientId}`.catch(() => {});
      await admin`DELETE FROM oauth_clients WHERE client_id = ${clientId}`.catch(() => {});
      await admin`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await admin.end({ timeout: 5 });
  }
  await Promise.all(racers.map((r) => r.end({ timeout: 5 })));
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'one OAuth authorization yields exactly one code (real Postgres, nine independent clients)',
  () => {
    it('CRITICAL nine concurrent consumes of ONE authorization insert exactly one code. The DELETE that retires the authorization never checks its row count, so without the row lock every caller that read before the winner committed also inserts a code — one user consent producing several codes, each separately exchangeable for an API key.', async () => {
      if (!admin || racers.length !== CLIENTS) {
        if (process.env.CI) {
          throw new Error(
            'real-PG oauth-authorization-single-use test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const a = admin;
      const accountId = randomUUID();
      const clientId = `oauth-authz-${randomUUID()}`;
      const authorizationId = `authz-${randomUUID()}`;
      seeded.push({ accountId, clientId });

      await a`
        INSERT INTO accounts (id, email, status)
        VALUES (${accountId}, ${`oauth-authz-${accountId}@test.local`}, 'active')`;
      await a`
        INSERT INTO oauth_clients (client_id, client_secret_hash, redirect_uris, label, account_id, created_at)
        VALUES (${clientId}, ${sha256Hex(`secret-${clientId}`)}, ${a.array(['https://app.test.local/cb'])},
                'oauth authz probe', ${accountId}, now())`;
      await a`
        INSERT INTO oauth_authorizations
          (authorization_hash, client_id, redirect_uri, state, scopes, code_challenge, created_at)
        VALUES (${sha256Hex(authorizationId)}, ${clientId}, 'https://app.test.local/cb', 'st',
                ARRAY['read']::api_key_scope[], 'challenge', now())`;

      const now = Date.now();
      const verdicts = await Promise.all(
        racers.map((client, i) =>
          new DrizzleOAuthStore({
            client,
            db: drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>,
            close: async () => {},
          }).consumeAuthorizationForCode({
            authorization_id: authorizationId,
            // Distinct per caller — see the header.
            code: `code-${String(i)}-${randomUUID()}`,
            account_id: accountId,
            scope: ['read'],
            created_at: now,
            not_before: now - 600_000,
          }),
        ),
      );

      const inserted = verdicts.filter((v) => v === 'inserted').length;
      expect(inserted, `exactly one consume may win — verdicts: ${verdicts.join(',')}`).toBe(1);

      const codes = await a<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM oauth_authorization_codes WHERE client_id = ${clientId}`;
      expect(codes[0]?.n, 'one authorization, one code').toBe(1);

      const left = await a<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM oauth_authorizations WHERE client_id = ${clientId}`;
      expect(left[0]?.n, 'the authorization is retired exactly once').toBe(0);
    });
  },
);
