// A token cannot be minted for a client whose revocation is in flight — the
// client-authority row lock, proven by forced ordering.
//
// This lock is one half of a PAIR, and neither half means much alone:
//
//   revokeClient          — locks the client row, marks it revoked, then SELECTs
//                           that client's tokens and revokes each one.
//   consumeCodeForToken   — locks the SAME client row, checks `revokedAt`, then
//                           INSERTs a new api_keys authority row + access token.
//
// Together they make revocation COMPLETE: the cascade cannot run while an exchange
// is in flight, so no token is inserted after the cascade has already taken its
// list. Drop this lock and the exchange proceeds concurrently — its INSERT lands
// after `revokeClient` has SELECTed the tokens to revoke, so the new key is never
// in that list and never revoked. The customer revokes a compromised integration,
// sees it disappear from the dashboard, and one live API key remains behind it.
//
// The `revokedAt` check the exchange performs is not a substitute: it reads
// whatever snapshot it has, and without the lock that snapshot predates the
// revocation's commit.
//
// Note this is the SECOND lock in `consumeCodeForToken`. The first (the code row,
// covered by `db-oauth-code-single-use-lock`) is uncontended here on purpose — the
// holder takes only the client row, so the call sails through the code lock and
// stops precisely at the one under test.
//
// Lock mode, as established across the other proofs: the holder takes FOR KEY
// SHARE on the client row.
//   - It CONFLICTS with the repo's FOR UPDATE, so the guarded path blocks.
//   - `oauth_access_tokens` has a foreign key to `oauth_clients`, so an UNGUARDED
//     path's INSERT takes KEY SHARE on that same row — compatible with the
//     holder's KEY SHARE, so it sails through and settles immediately.
// A holder taking FOR UPDATE would block the FK's lock too, and would therefore
// pass identically with the lock deleted — the trap that fooled the first version
// of the profile-cap test.

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
    await holder`SELECT 1 FROM oauth_clients LIMIT 0`;
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
  'OAuth client-authority lock is taken during a code exchange (real Postgres, forced ordering)',
  () => {
    it("CRITICAL consumeCodeForToken BLOCKS while another session holds the CLIENT row, so a token cannot be minted alongside an in-flight revocation. revokeClient marks the client revoked and then revokes the tokens it SELECTs; without this lock an exchange inserts its key after that SELECT, so the cascade never sees it and a live API key survives the customer's revocation of a compromised integration.", async () => {
      if (!holder || !worker) {
        if (process.env.CI) {
          throw new Error(
            'real-PG oauth-client-authority-lock test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const h = holder;
      const w = worker;
      const accountId = randomUUID();
      const clientId = `oauth-authority-${randomUUID()}`;
      const clientSecretHash = sha256Hex(`secret-${clientId}`);
      const code = `code-${randomUUID()}`;
      const codeHash = sha256Hex(code);
      seeded.push({ accountId, clientId });

      await h`
        INSERT INTO accounts (id, email, status)
        VALUES (${accountId}, ${`oauth-authority-${accountId}@test.local`}, 'active')`;
      await h`
        INSERT INTO oauth_clients (client_id, client_secret_hash, redirect_uris, label, account_id, created_at)
        VALUES (${clientId}, ${clientSecretHash}, ${h.array(['https://app.test.local/cb'])},
                'oauth authority probe', ${accountId}, now())`;
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
        // The CLIENT row — standing in for revokeClient, which locks it the same
        // way. KEY SHARE rather than FOR UPDATE; see the header.
        await tx`SELECT client_id FROM oauth_clients WHERE client_id = ${clientId} FOR KEY SHARE`;
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
        'consumeCodeForToken must be waiting on the client row, not minting against a stale revokedAt',
      ).toBe(false);

      release.fire();
      await holderTxn;

      await expect(pending).resolves.toBe('inserted');
      expect(settled).toBe(true);

      const keys = await h<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM api_keys WHERE account_id = ${accountId}`;
      expect(keys[0]?.n, 'the exchange lands once the client row is free').toBe(1);
    });
  },
);
