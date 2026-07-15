// Real-Postgres proof that API-key revocation has one persisted winner.

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
  'API-key atomic revocation (Drizzle path, real Postgres)',
  () => {
    it('returns one winner and four authoritative losers for five concurrent first revokes', async () => {
      if (!dbReachable || !client) throw new Error('real PostgreSQL setup failed');
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleApiKeysRepo({ client, db, close: async () => {} });
      const accountId = randomUUID();
      seededAccountIds.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`revoke-race-${accountId}@test.local`})`;
      const key = await repo.insertApiKey({
        accountId,
        name: 'concurrent-revoke',
        scopes: ['read'],
        keyPrefix: `revoke_${randomUUID()}`,
        keyHash: `hash_${randomUUID()}`,
        expiresAt: null,
      });
      const candidateTimes = Array.from(
        { length: 5 },
        (_, index) => new Date(Date.UTC(2026, 6, 14, 12, 0, 0, index)),
      );

      const outcomes = await Promise.all(
        candidateTimes.map((revokedAt) =>
          repo.revokeApiKeyAtomic({ id: key.id, accountId, revokedAt }),
        ),
      );

      expect(outcomes.filter((outcome) => outcome.kind === 'revoked')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.kind === 'already_revoked')).toHaveLength(4);
      expect(outcomes.filter((outcome) => outcome.kind === 'not_found')).toHaveLength(0);
      const persistedTimes = outcomes.flatMap((outcome) =>
        outcome.kind === 'not_found' || outcome.key.revokedAt === null
          ? []
          : [outcome.key.revokedAt.toISOString()],
      );
      expect(persistedTimes).toHaveLength(5);
      expect(new Set(persistedTimes).size).toBe(1);
      const [stored] = await client`
        SELECT revoked_at
          FROM api_keys
         WHERE id = ${key.id}
           AND account_id = ${accountId}
      `;
      expect(stored?.revoked_at).not.toBeNull();
      expect(new Date(String(stored?.revoked_at)).toISOString()).toBe(persistedTimes[0]);
    });

    it('fails closed on a wrong customer account while explicit admin scope can revoke', async () => {
      if (!dbReachable || !client) throw new Error('real PostgreSQL setup failed');
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleApiKeysRepo({ client, db, close: async () => {} });
      const accountId = randomUUID();
      const otherAccountId = randomUUID();
      seededAccountIds.push(accountId, otherAccountId);
      await client`
        INSERT INTO accounts (id, email)
        VALUES
          (${accountId}, ${`revoke-owner-${accountId}@test.local`}),
          (${otherAccountId}, ${`revoke-other-${otherAccountId}@test.local`})
      `;
      const key = await repo.insertApiKey({
        accountId,
        name: 'scope-proof',
        scopes: ['read'],
        keyPrefix: `scope_${randomUUID()}`,
        keyHash: `hash_${randomUUID()}`,
        expiresAt: null,
      });

      await expect(
        repo.revokeApiKeyAtomic({
          id: key.id,
          accountId: otherAccountId,
          revokedAt: new Date('2026-07-14T12:01:00.000Z'),
        }),
      ).resolves.toEqual({ kind: 'not_found' });
      const [beforeAdmin] = await client`SELECT revoked_at FROM api_keys WHERE id = ${key.id}`;
      expect(beforeAdmin?.revoked_at).toBeNull();

      const adminTime = new Date('2026-07-14T12:02:00.000Z');
      const adminOutcome = await repo.revokeApiKeyAtomic({
        id: key.id,
        accountId: null,
        revokedAt: adminTime,
      });
      expect(adminOutcome.kind).toBe('revoked');
      if (adminOutcome.kind !== 'revoked') throw new Error('admin revocation unexpectedly lost');
      expect(adminOutcome.key.accountId).toBe(accountId);
      expect(adminOutcome.key.revokedAt).toEqual(adminTime);
    });
  },
);
