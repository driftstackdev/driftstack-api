// An EXPIRED API key cannot be rotated back into a live one.
//
// `rotateApiKeyAtomic` locks the old row and screens it three ways before minting a
// successor:
//
//   if (!locked) return { kind: 'not_found' };
//   if (locked.revokedAt !== null) return { kind: 'revoked' };
//   if (locked.expiresAt !== null && locked.expiresAt <= input.now) return { kind: 'expired' };
//
// The first two have been exercised for a long time. The third had a statement
// count of ZERO — measured from a coverage pass taken with DATABASE_URL set, so the
// integration files were running and cannot be the reason it looks unfired.
//
// Deleting it does not throw. Execution proceeds to insert the successor and the
// method answers `rotated`, handing back fresh plaintext — so a key whose lifetime
// has already ended becomes a live credential again, with a new expiry, without
// anyone re-authorising it. Expiry is the control that makes a time-boxed key
// actually time-boxed; rotation is the one path that could quietly undo it, which
// is why the screen is there.
//
// The positive arm rotates a key that is still valid, so "refuse every rotation"
// cannot satisfy this file — the screen has to reject the expired key AND admit the
// live one. Both arms also assert the row COUNT, because the dangerous fall-through
// is the successor INSERT rather than the verdict: a test checking only `kind`
// would pass against an implementation that refused after minting.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleApiKeysRepo } from '../../src/db/api-keys-repo.js';
import type { Database } from '../../src/db/client.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const GRACE = 24 * 60 * 60 * 1000;

const NOW = new Date('2026-08-16T12:00:00.000Z');
const ALREADY_EXPIRED = new Date('2026-08-16T11:00:00.000Z');
const STILL_VALID = new Date('2026-08-16T13:00:00.000Z');

let client: ReturnType<typeof postgres> | null = null;
let db: ReturnType<typeof drizzle> | null = null;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 1 });
  db = drizzle(client);
  try {
    await client`SELECT 1 FROM api_keys LIMIT 0`;
  } catch {
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
    db = null;
  }
});

afterAll(async () => {
  if (!client) return;
  for (const accountId of seeded) {
    await client`DELETE FROM api_keys WHERE account_id = ${accountId}`.catch(() => {});
    await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
  }
  await client.end({ timeout: 5 });
});

async function seedKeyWithExpiry(
  sql: ReturnType<typeof postgres>,
  expiresAt: Date,
): Promise<{ accountId: string; keyId: string }> {
  const accountId = randomUUID();
  const keyId = randomUUID();
  seeded.push(accountId);
  await sql`
    INSERT INTO accounts (id, email, status)
    VALUES (${accountId}, ${`rotate-expiry-${accountId}@test.local`}, 'active')`;
  await sql`
    INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash, scopes, expires_at)
    VALUES (${keyId}, ${accountId}, 'ops', ${`dsk_${keyId.slice(0, 8)}`}, ${`h-${keyId}`},
            ARRAY['read']::api_key_scope[], ${expiresAt.toISOString()}::timestamptz)`;
  return { accountId, keyId };
}

/** One client and ONE drizzle handle, matching the sibling rotation tests. */
function repo(): DrizzleApiKeysRepo {
  return new DrizzleApiKeysRepo({
    client: client!,
    db: db!,
    close: async () => {},
  } as unknown as Database);
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'rotation refuses an expired key (real Postgres)',
  () => {
    it('CRITICAL rotateApiKeyAtomic answers expired and mints NO successor for a key whose expires_at has passed. Without that screen it proceeds to the insert and answers rotated, handing back fresh plaintext with a new expiry — so a time-boxed credential whose lifetime already ended becomes live again with nobody re-authorising it.', async () => {
      if (!client || !db) {
        if (process.env.CI) {
          throw new Error(
            'real-PG rotate-expiry test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const sql = client;
      const { accountId, keyId } = await seedKeyWithExpiry(sql, ALREADY_EXPIRED);

      const result = await repo().rotateApiKeyAtomic({
        oldKeyId: keyId,
        accountId,
        keyPrefix: `dsk_${randomUUID().slice(0, 8)}`,
        keyHash: `h-${randomUUID()}`,
        now: NOW,
        gracePeriodMs: GRACE,
      });

      expect(result.kind, 'an expired key must not be rotatable').toBe('expired');

      const rows = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM api_keys WHERE account_id = ${accountId}`;
      expect(rows[0]?.n, 'no successor row may be minted for an expired key').toBe(1);

      const old = await sql<Array<{ expires_at: string; revoked_at: Date | null }>>`
        SELECT expires_at, revoked_at FROM api_keys WHERE id = ${keyId}`;
      expect(old[0]?.revoked_at, 'the refused rotation leaves the old key untouched').toBeNull();
      // timestamptz arrives as a driver string; compare the instant, not its spelling.
      expect(new Date(old[0]!.expires_at).getTime(), 'and does not extend its expiry').toBe(
        ALREADY_EXPIRED.getTime(),
      );
    });

    it('still rotates a key whose expiry has NOT passed', async () => {
      if (!client || !db) {
        if (process.env.CI) {
          throw new Error(
            'real-PG rotate-expiry test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const sql = client;
      const { accountId, keyId } = await seedKeyWithExpiry(sql, STILL_VALID);

      const result = await repo().rotateApiKeyAtomic({
        oldKeyId: keyId,
        accountId,
        keyPrefix: `dsk_${randomUUID().slice(0, 8)}`,
        keyHash: `h-${randomUUID()}`,
        now: NOW,
        gracePeriodMs: GRACE,
      });

      expect(result.kind).toBe('rotated');
      const rows = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM api_keys WHERE account_id = ${accountId}`;
      expect(rows[0]?.n, 'the successor is minted alongside the old key').toBe(2);
    });
  },
);
