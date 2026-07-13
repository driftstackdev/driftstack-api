// Real-Postgres regression for password-reset sibling invalidation. Two
// different valid reset rows for one account race the same account-scoped
// conditional UPDATE: exactly one presented token may win, and both rows end
// consumed. The in-memory integration proves service behavior; this test
// proves the Drizzle/Postgres locking semantics that enforce it in production.

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
    client = postgres(DB_URL, { max: 5 });
    await client`SELECT 1 FROM password_reset_tokens LIMIT 0`;
    dbReachable = true;
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    await client?.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (!client) return;
  for (const accountId of seeded) {
    await client`DELETE FROM password_reset_tokens WHERE account_id = ${accountId}`.catch(() => {});
    await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
  }
  await client.end({ timeout: 5 });
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'password-reset token-family claim is atomic (real Postgres)',
  () => {
    it('two sibling claims yield one winner and consume the entire family', async () => {
      if (!dbReachable || !client) return;
      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`reset-family-${accountId}@test.local`})`;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAuthFlowsRepo({ client, db, close: async () => {} });
      const expiresAt = new Date(Date.now() + 60_000);
      const first = await repo.insertAuthToken({
        kind: 'password_reset',
        accountId,
        tokenHash: `first-${accountId}`,
        expiresAt,
        requestedFromIp: null,
      });
      const second = await repo.insertAuthToken({
        kind: 'password_reset',
        accountId,
        tokenHash: `second-${accountId}`,
        expiresAt,
        requestedFromIp: null,
      });

      const at = new Date();
      const results = await Promise.all(
        [first, second].map((row) =>
          repo.consumeAuthTokenFamily({
            kind: 'password_reset',
            id: row.id,
            accountId,
            at,
          }),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      const [remaining] = await client<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM password_reset_tokens
        WHERE account_id = ${accountId} AND consumed_at IS NULL
      `;
      expect(remaining?.count).toBe(0);
    });
  },
);
