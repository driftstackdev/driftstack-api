// Drizzle-backed integration test for the agent_sessions idempotency
// PARTIAL UNIQUE INDEX against a REAL Postgres.
//
// `agent_sessions_idempotency_key_unique` (migration 0047) is
//   UNIQUE (account_id, idempotency_key) WHERE idempotency_key IS NOT NULL
// — the first-write-wins race backstop behind the route layer's
// findByIdempotencyKey pre-check. DrizzleAgentSessionsRepo.create inserts
// with NO onConflict clause, so a duplicate (account_id, key) relies on
// Postgres raising a UniqueViolation. An in-memory twin can't replicate a
// Postgres partial unique constraint, so this is the ONLY place the
// constraint — and its PARTIAL (NULL-allowed) nature — is actually proven.
//
// Run scope:
//   - CI: build-test job has postgres:17-alpine at localhost:5432 with the
//     `driftstack` schema migrated; this test always runs there.
//   - Local dev: skips if DATABASE_URL postgres is unreachable.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAgentSessionsRepo } from '../../src/db/agent-sessions-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const TRANSCRIPT_KEY = Buffer.alloc(32, 11).toString('base64');

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
// accountIds seeded — cleaned in FK order: agent_sessions → accounts.
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 1 });
  try {
    await client`SELECT 1 FROM agent_sessions LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM agent_sessions WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'agent_sessions idempotency partial unique index (Drizzle path against real Postgres)',
  () => {
    it('CRITICAL the dependency was reachable, so a green here is not "no service". V-793 — this arm previously sat inside beforeAll, where vitest registers nothing: the assertion existed as text, never ran, and the hole it was written to close stayed open.', () => {
      // Every arm below early-returns when the handle is absent. Without this
      // one, a run against a dead service reports PASSED — a green meaning
      // "nothing was tested", indistinguishable from "the service agreed".
      expect(dbReachable, 'the integration dependency was unreachable').toBeTruthy();
    });

    it('first-write-wins on (account_id, idempotency_key); NULL keys are exempt (partial index)', async () => {
      if (!dbReachable || !client) {
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAgentSessionsRepo(
        { client, db, close: async () => {} },
        { transcriptEncryptionKeyBase64: TRANSCRIPT_KEY },
      );

      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`agt-idem-${accountId}@test.local`})`;

      // First write with key 'k1' succeeds.
      const first = await repo.create({ accountId, idempotencyKey: 'k1', tokenBudgetTotal: 1000 });
      expect(first.idempotencyKey).toBe('k1');

      // Second write with the SAME (account, 'k1') is rejected by the partial
      // unique index — the race backstop when two POSTs share a key.
      await expect(
        repo.create({ accountId, idempotencyKey: 'k1', tokenBudgetTotal: 1000 }),
      ).rejects.toThrow();

      // The first (winning) write is retrievable by key.
      const found = await repo.findByIdempotencyKey(accountId, 'k1');
      expect(found?.id).toBe(first.id);

      // PARTIAL index (WHERE idempotency_key IS NOT NULL): two NULL-key
      // sessions for the same account both succeed — null is exempt.
      const n1 = await repo.create({ accountId, tokenBudgetTotal: 1000 });
      const n2 = await repo.create({ accountId, tokenBudgetTotal: 1000 });
      expect(n1.id).not.toBe(n2.id);
      expect(n1.idempotencyKey).toBeNull();
      expect(n2.idempotencyKey).toBeNull();

      // A different key on the same account is independent.
      const other = await repo.create({ accountId, idempotencyKey: 'k2', tokenBudgetTotal: 1000 });
      expect(other.idempotencyKey).toBe('k2');
      expect(other.id).not.toBe(first.id);
    });
  },
);
