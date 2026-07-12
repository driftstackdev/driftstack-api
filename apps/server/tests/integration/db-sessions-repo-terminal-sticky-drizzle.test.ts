// Drizzle-backed integration test for DrizzleSessionRepo.updateSessionStatus
// terminal-stickiness — against a REAL Postgres. The guard closes a concurrent-
// destroy resurrection race: once a row is 'destroyed'/'errored', a later write
// (a stale getState write-back, a reclaimed create, a redundant error-capture)
// must be a silent no-op. The in-memory twin mirrors the WHERE clause, but the
// actual notInArray(status, ['destroyed','errored']) predicate is validated here
// on real PG, since a resurrected row means use-after-destroy dispatch to a dead
// box + a duplicate session.completed webhook.
//
// Run scope:
//   - CI: build-test job has postgres:17-alpine at localhost:5432 with the
//     `driftstack` schema migrated; this test always runs there.
//   - Local dev: skips if DATABASE_URL postgres is unreachable.
//
// Shared-DB note: every row is seeded under its own random account, so sibling
// tests can't interfere.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleSessionRepo } from '../../src/db/sessions-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
// (accountId, apiKeyId) pairs seeded — cleaned in FK order:
// sessions → api_keys → accounts.
const seeded: Array<{ accountId: string; apiKeyId: string }> = [];

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
    await client`SELECT 1 FROM sessions LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) {
    for (const { accountId, apiKeyId } of seeded) {
      await client`DELETE FROM sessions WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM api_keys WHERE id = ${apiKeyId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleSessionRepo.updateSessionStatus terminal-stickiness (real Postgres)',
  () => {
    async function seedRow(status: string, destroyedAt: Date | null): Promise<string> {
      const acc = randomUUID();
      const key = randomUUID();
      seeded.push({ accountId: acc, apiKeyId: key });
      await client!`INSERT INTO accounts (id, email, tier) VALUES (${acc}, ${`ts-${acc}@test.local`}, 'free')`;
      await client!`INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash)
        VALUES (${key}, ${acc}, 'ts', ${`dsk_${key.slice(0, 8)}`}, ${`hash_${key}`})`;
      const [row] = await client!`
        INSERT INTO sessions (account_id, api_key_id, driver_session_id, status, destroyed_at)
        VALUES (${acc}, ${key}, ${`drv_${randomUUID()}`}, ${status}, ${destroyedAt ? destroyedAt.toISOString() : null})
        RETURNING id`;
      return row?.id as string;
    }

    async function readStatus(id: string): Promise<{ status: string; destroyedAt: string | null }> {
      const [row] = await client!`SELECT status, destroyed_at FROM sessions WHERE id = ${id}`;
      return { status: row?.status as string, destroyedAt: (row?.destroyed_at as string) ?? null };
    }

    it('a non-terminal write onto a destroyed row is a no-op (no resurrection; destroyedAt intact)', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleSessionRepo({ client, db, close: async () => {} });

      const destroyedAt = new Date(Date.UTC(2026, 5, 1, 0, 0, 0));
      const id = await seedRow('destroyed', destroyedAt);

      await repo.updateSessionStatus(id, 'ready');

      const after = await readStatus(id);
      expect(after.status).toBe('destroyed');
      expect(after.destroyedAt).not.toBeNull();
    });

    it('a terminal write onto a different terminal state is a no-op (no destroyed→errored flip)', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleSessionRepo({ client, db, close: async () => {} });

      const id = await seedRow('errored', new Date(Date.UTC(2026, 5, 2, 0, 0, 0)));

      await repo.updateSessionStatus(id, 'destroyed', { destroyedAt: new Date() });

      expect((await readStatus(id)).status).toBe('errored');
    });

    it('a NORMAL non-terminal→terminal transition still applies (ready → destroyed)', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleSessionRepo({ client, db, close: async () => {} });

      const id = await seedRow('ready', null);
      const destroyedAt = new Date(Date.UTC(2026, 5, 3, 0, 0, 0));

      await repo.updateSessionStatus(id, 'destroyed', { destroyedAt });

      const after = await readStatus(id);
      expect(after.status).toBe('destroyed');
      expect(after.destroyedAt).not.toBeNull();
    });
  },
);
