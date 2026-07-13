// Real-Postgres proof that a web-session revoke is an atomic claim across
// pooled API connections. This is the cross-process backstop for refresh-token
// rotation: only the transaction that flips revoked_at NULL→timestamp may mint.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAuthFlowsRepo } from '../../src/db/auth-flows-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
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
  client = postgres(DB_URL, { max: 5 });
  try {
    await client`SELECT 1 FROM web_sessions LIMIT 0`;
    dbReachable = true;
  } catch {
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (!client) return;
  for (const accountId of seeded) {
    await client`DELETE FROM web_sessions WHERE account_id = ${accountId}`.catch(() => {});
    await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
  }
  await client.end({ timeout: 5 });
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'web-session revoke first-winner claim (Drizzle path, real Postgres)',
  () => {
    it('returns true to exactly one concurrent revoker', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAuthFlowsRepo({ client, db, close: async () => {} });
      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`refresh-claim-${accountId}@test.local`})`;
      const session = await repo.insertWebSession({
        accountId,
        tokenHash: `hash-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
        issuedFromIp: null,
        userAgent: null,
      });

      const results = await Promise.all([
        repo.revokeWebSession(session.id, new Date()),
        repo.revokeWebSession(session.id, new Date()),
      ]);
      expect(results.sort()).toEqual([false, true]);
    });
  },
);
