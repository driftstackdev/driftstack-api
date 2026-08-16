// An OAuth authorization code is SINGLE-USE, and the only thing enforcing that is
// a row lock — forced ordering, not a race.
//
// `consumeCodeForToken` is a read-modify-write on the code row:
//
//   SELECT … FROM oauth_authorization_codes … FOR UPDATE   ← the lock
//   if (code.consumedAt !== null) return 'code_unavailable' ← the check, in JS
//   … INSERT api_keys, INSERT oauth_access_tokens …
//   UPDATE oauth_authorization_codes SET consumed_at = …    ← the mark
//
// The marking UPDATE carries NO `AND consumed_at IS NULL` predicate, so there is
// no conditional-UPDATE fallback underneath the lock. Nor does a unique constraint
// stand in: each exchange mints its own token value, so two replays produce two
// DIFFERENT `key_hash`es and both inserts succeed. The lock is the whole guard.
//
// Lose it and two concurrent exchanges of one stolen code both observe
// `consumedAt === null`, both pass the check, and both mint an api_keys authority
// row — one authorization code yielding two live API keys, where revoking the one
// the customer can see leaves the other working. That is OAuth code replay, and
// the RFC calls single-use on this exact step mandatory for that reason.
//
// Measured before writing this: `unit/oauth.test.ts` DOES race
// `consumeCodeForToken` via Promise.all, so a coverage ledger reports the method
// as raced. It cannot reach this lock — it has zero `postgres(` calls and runs
// against the in-memory store, where the property is enforced by JavaScript's
// single thread rather than by Postgres. A race against a fake store says nothing
// about a row lock.
//
// Forced ordering, then, as with the other five locks proven this way. The holder
// takes FOR KEY SHARE on the code row:
//   - it CONFLICTS with the repo's FOR UPDATE, so the guarded path blocks;
//   - an unguarded path takes no lock on its SELECT and finishes with an UPDATE
//     that takes FOR NO KEY UPDATE — compatible with KEY SHARE — so it sails
//     through and settles immediately.
// A holder taking FOR UPDATE would block both and prove nothing.

import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleOAuthStore } from '../../src/db/oauth-store.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

let holder: ReturnType<typeof postgres> | null = null;
let worker: ReturnType<typeof postgres> | null = null;
const seeded: Array<{ accountId: string; clientId: string }> = [];

/** A one-shot latch: `promise` settles when `fire()` is called. */
function gate(): { promise: Promise<void>; fire: () => void } {
  let fire: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    fire = (): void => {
      resolve();
    };
  });
  return { promise, fire };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  holder = postgres(DB_URL, { max: 1 });
  worker = postgres(DB_URL, { max: 1 });
  try {
    await holder`SELECT 1 FROM oauth_authorization_codes LIMIT 0`;
  } catch {
    await holder.end({ timeout: 1 }).catch(() => {});
    await worker.end({ timeout: 1 }).catch(() => {});
    holder = null;
    worker = null;
  }
});

afterAll(async () => {
  if (holder) {
    for (const { accountId, clientId } of seeded) {
      await holder`DELETE FROM oauth_access_tokens WHERE account_id = ${accountId}`.catch(() => {});
      await holder`DELETE FROM api_keys WHERE account_id = ${accountId}`.catch(() => {});
      await holder`DELETE FROM oauth_authorization_codes WHERE client_id = ${clientId}`.catch(
        () => {},
      );
      await holder`DELETE FROM oauth_clients WHERE client_id = ${clientId}`.catch(() => {});
      await holder`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await holder.end({ timeout: 5 });
  }
  if (worker) await worker.end({ timeout: 5 });
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'OAuth code single-use rests on its row lock (real Postgres, forced ordering)',
  () => {
    it('CRITICAL consumeCodeForToken BLOCKS while another session holds the authorization-code row, so a replayed code cannot be exchanged twice. The consumed_at check runs in JS and the marking UPDATE has no consumed_at IS NULL predicate, so without this lock two concurrent exchanges of one stolen code each mint an api_keys authority row — two live API keys from one code, and revoking the visible one leaves the other working.', async () => {
      if (!holder || !worker) {
        if (process.env.CI) {
          throw new Error(
            'real-PG oauth-code-lock test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const h = holder;
      const w = worker;
      const accountId = randomUUID();
      const clientId = `oauth-lock-${randomUUID()}`;
      const clientSecretHash = sha256Hex(`secret-${clientId}`);
      const code = `code-${randomUUID()}`;
      const codeHash = sha256Hex(code);
      seeded.push({ accountId, clientId });

      await h`
        INSERT INTO accounts (id, email, status)
        VALUES (${accountId}, ${`oauth-lock-${accountId}@test.local`}, 'active')`;
      await h`
        INSERT INTO oauth_clients (client_id, client_secret_hash, redirect_uris, label, account_id, created_at)
        VALUES (${clientId}, ${clientSecretHash}, ${h.array(['https://app.test.local/cb'])},
                'oauth lock probe', ${accountId}, now())`;
      await h`
        INSERT INTO oauth_authorization_codes
          (code_hash, client_id, redirect_uri, state, scopes, code_challenge, account_id, created_at, consumed_at)
        VALUES (${codeHash}, ${clientId}, 'https://app.test.local/cb', 'st',
                ARRAY['read']::api_key_scope[], 'challenge', ${accountId}, now(), NULL)`;

      const store = new DrizzleOAuthStore({
        client: w,
        db: drizzle(w) as unknown as ReturnType<typeof drizzle<typeof schema>>,
        close: async () => {},
      });

      const lockTaken = gate();
      const release = gate();

      const holderTxn = h.begin(async (tx) => {
        // KEY SHARE, not FOR UPDATE — see the header. This conflicts with the
        // repo's FOR UPDATE and with nothing the unguarded path would take.
        await tx`SELECT code_hash FROM oauth_authorization_codes WHERE code_hash = ${codeHash} FOR KEY SHARE`;
        lockTaken.fire();
        await release.promise;
      });

      await lockTaken.promise;

      const now = Date.now();
      let settled = false;
      const pending = store
        .consumeCodeForToken({
          code,
          consumed_at: now,
          token: {
            token: `tok-${randomUUID()}`,
            client_id: clientId,
            account_id: accountId,
            scope: ['read'],
            created_at: now,
            expires_at: now + 3_600_000,
          },
          expectedClientSecretHash: clientSecretHash,
        })
        .then((r) => {
          settled = true;
          return r;
        });

      // Asserting the ABSENCE of progress, so this wants slack rather than
      // precision: the same exchange completes in single-digit milliseconds when
      // the row is free.
      await delay(600);
      expect(
        settled,
        'consumeCodeForToken must be waiting on the authorization-code row, not reading a consumed_at past it',
      ).toBe(false);

      release.fire();
      await holderTxn;

      // It proceeds once released, and the exchange is the one that lands.
      await expect(pending).resolves.toBe('inserted');
      expect(settled).toBe(true);

      const codes = await h<Array<{ consumed_at: Date | null }>>`
        SELECT consumed_at FROM oauth_authorization_codes WHERE code_hash = ${codeHash}`;
      expect(codes[0]?.consumed_at, 'the code is marked consumed exactly once').not.toBeNull();

      const keys = await h<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM api_keys WHERE account_id = ${accountId}`;
      expect(keys[0]?.n, 'one authority row, not two').toBe(1);
    });
  },
);
