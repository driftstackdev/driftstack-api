// Real-Postgres proof that API-key rotation and revocation serialize on the
// current key row. A revoke that commits first must prevent successor minting;
// a rotation that commits first remains a valid serial winner.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleApiKeysRepo } from '../../src/db/api-keys-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
const seededAccountIds: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 8 });
  try {
    await client`SELECT 1 FROM api_keys LIMIT 0`;
    dbReachable = true;
  } catch {
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (!client) return;
  for (const accountId of seededAccountIds) {
    await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
  }
  await client.end({ timeout: 5 });
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'API-key rotate/revoke authority (Drizzle path, real Postgres)',
  () => {
    it('never mints a successor when revoke commits before the locked rotation check', async () => {
      if (!dbReachable || !client) {
        throw new Error('real PostgreSQL setup failed');
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleApiKeysRepo({ client, db, close: async () => {} });
      const accountId = randomUUID();
      seededAccountIds.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`rotate-race-${accountId}@test.local`})`;
      const oldKey = await repo.insertApiKey({
        accountId,
        name: 'old',
        scopes: ['read'],
        keyPrefix: `old_${randomUUID()}`,
        keyHash: `hash_${randomUUID()}`,
        expiresAt: null,
      });
      const revokedAt = new Date('2026-07-13T12:00:00.000Z');
      let pendingRotation: ReturnType<DrizzleApiKeysRepo['rotateApiKeyAtomic']> | undefined;

      await client.begin(async (tx) => {
        await tx`
          UPDATE api_keys
             SET revoked_at = ${revokedAt.toISOString()}::timestamptz
           WHERE id = ${oldKey.id}
        `;
        pendingRotation = repo.rotateApiKeyAtomic({
          oldKeyId: oldKey.id,
          accountId,
          keyPrefix: `successor_${randomUUID()}`,
          keyHash: `hash_${randomUUID()}`,
          now: new Date('2026-07-13T12:00:01.000Z'),
          gracePeriodMs: 60_000,
        });
        // Give the separate pooled transaction a turn to reach the row lock
        // before this transaction commits the revoke.
        await new Promise<void>((resolve) => setImmediate(resolve));
      });

      expect(pendingRotation).toBeDefined();
      await expect(pendingRotation).resolves.toEqual({ kind: 'revoked' });
      const rows = await client`
        SELECT id, revoked_at
          FROM api_keys
         WHERE account_id = ${accountId}
      `;
      expect(rows).toHaveLength(1);
      expect(String(rows[0]?.id)).toBe(oldKey.id);
      expect(rows[0]?.revoked_at).not.toBeNull();
    });

    it('allows the successor when rotation commits before a later revoke', async () => {
      if (!dbReachable || !client) {
        throw new Error('real PostgreSQL setup failed');
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleApiKeysRepo({ client, db, close: async () => {} });
      const accountId = randomUUID();
      seededAccountIds.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`rotate-first-${accountId}@test.local`})`;
      const oldKey = await repo.insertApiKey({
        accountId,
        name: 'old',
        scopes: ['read', 'write'],
        keyPrefix: `old_${randomUUID()}`,
        keyHash: `hash_${randomUUID()}`,
        expiresAt: null,
      });
      const rotated = await repo.rotateApiKeyAtomic({
        oldKeyId: oldKey.id,
        accountId,
        keyPrefix: `successor_${randomUUID()}`,
        keyHash: `hash_${randomUUID()}`,
        now: new Date('2026-07-13T12:00:00.000Z'),
        gracePeriodMs: 60_000,
      });
      expect(rotated.kind).toBe('rotated');
      if (rotated.kind !== 'rotated') throw new Error('rotation unexpectedly lost');

      await repo.markRevoked(oldKey.id, new Date('2026-07-13T12:00:01.000Z'));
      const rows = await client`
        SELECT id, revoked_at, expires_at
          FROM api_keys
         WHERE account_id = ${accountId}
         ORDER BY created_at, id
      `;
      expect(rows).toHaveLength(2);
      const successor = rows.find((row) => String(row.id) === rotated.newRow.id);
      expect(successor?.revoked_at).toBeNull();
      expect(successor?.expires_at).toBeNull();
    });
  },
);
