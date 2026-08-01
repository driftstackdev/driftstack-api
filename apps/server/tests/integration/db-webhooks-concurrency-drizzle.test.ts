// Drizzle-backed integration test: DrizzleWebhooksRepo.insertEndpointIfUnderLimit
// enforces the per-account active-endpoint cap ATOMICALLY under concurrency,
// against a REAL Postgres.
//
// The old create path was countActiveEndpoints() then a SEPARATE
// insertEndpoint() — a TOCTOU: N concurrent creates all read the same stale
// count, all pass the cap check, all insert → the 10-endpoint cap is exceeded.
// insertEndpointIfUnderLimit closes it: the count+insert run in ONE transaction
// serialised by a per-account pg_advisory_xact_lock, so the second transaction
// blocks on the lock until the first commits, then re-counts, sees the cap is
// full, and returns null (the service surfaces ConflictError).
//
// The in-memory twin is synchronous (no await gap → no race), so only a real
// Postgres with a MULTI-connection pool (max:5 → distinct connections) actually
// exercises the advisory lock. With the fix: exactly `limit` rows; the pre-fix
// count-then-insert would yield up to N.
//
// Run scope:
//   - CI: the build-test job has postgres:17 at localhost:5432 with the
//     `driftstack` schema migrated; this test always runs there.
//   - Local dev: skips if the DATABASE_URL postgres is unreachable.

import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureIsolatedDatabase } from './_helpers/isolated-database.js';
import { DrizzleWebhooksRepo } from '../../src/db/webhooks-repo.js';
import { encryptPlatformSecret } from '../../src/lib/platform-secret-encryption.js';
import {
  WEBHOOK_SECRET_V1_PREFIX,
  WEBHOOK_SECRET_V2_PREFIX,
  encryptWebhookSecret,
} from '../../src/lib/webhook-secret-encryption.js';
import type * as schema from '../../src/db/schema.js';
import type { NewWebhookEndpointInput } from '../../src/services/webhooks.js';

/**
 * This file gets its OWN database, and that is structural rather than tidiness.
 *
 * `encryptLegacySecrets` sweeps `webhook_endpoints` GLOBALLY — it takes no
 * account scope — so on a shared database its behaviour depends on rows owned
 * by whichever other test files happen to be running. That produced two
 * separate intermittent failures with different mechanisms: a row whose secret
 * was not convertible made the sweep THROW, and later a syntactically-v2
 * fixture made the key PROBE throw. Both were fixed by choosing better fixture
 * values, and both fixes were one clever fixture away from returning, because a
 * row is always in exactly one of two sets — the sweep selects NOT-v2, the probe
 * selects v2 — and no value is invisible to both.
 *
 * A dedicated database removes the shared state instead of negotiating with it.
 * The property then holds BY CONSTRUCTION rather than by repeated green runs:
 * no other file's rows exist here, so no fixture choice anywhere else can change
 * what this sweep sees.
 *
 * Only this file needs it — it is the only integration file that calls the
 * global sweep. Migrations are idempotent, so the setup cost is paid once.
 */
const ISOLATED_DB_NAME = 'driftstack_webhook_sweep_iso';
let DB_URL = '';
const WEBHOOK_KEY = Buffer.alloc(32, 17).toString('base64');

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
// accountIds seeded — cleaned in FK order: webhook_endpoints → accounts.
const seeded: string[] = [];

beforeAll(async () => {
  const isolated = await ensureIsolatedDatabase(ISOLATED_DB_NAME);
  if (isolated === null) return;
  DB_URL = isolated;
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  // max: 5 so concurrent transactions get distinct connections — the advisory
  // lock, not connection serialisation, is what's exercised.
  client = postgres(DB_URL, { max: 5 });
  try {
    await client`SELECT 1 FROM webhook_endpoints LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM webhook_endpoints WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

async function seedAccount(client: ReturnType<typeof postgres>): Promise<string> {
  const accountId = randomUUID();
  seeded.push(accountId);
  await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`wh-cap-${accountId}@test.local`})`;
  return accountId;
}

function mkInput(accountId: string, i: number): NewWebhookEndpointInput {
  const secretChar = 'abcdefghij'[i % 10]!;
  return {
    accountId,
    url: `https://hooks.example/${accountId.slice(0, 4)}-${i.toString()}`,
    secret: `whsec_${secretChar.repeat(32)}`,
    secretPrefix: `whsec_${i.toString()}`,
    events: ['session.completed'],
    description: null,
  };
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'webhook-endpoint cap enforcement is atomic (insertEndpointIfUnderLimit advisory lock, real Postgres)',
  () => {
    it('5 concurrent inserts on a limit-1 account yield EXACTLY 1 row (the advisory lock serialises → 4 losers get null)', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleWebhooksRepo(
        { client, db, close: async () => {} },
        { secretEncryptionKeyBase64: WEBHOOK_KEY },
      );
      const accountId = await seedAccount(client);

      // Pre-fix (bare count-then-insert) → all 5 read count=0 → 5 rows. With the
      // locked count+insert → exactly 1 inserts, the other 4 return null.
      const results = await Promise.all(
        [0, 1, 2, 3, 4].map((i) => repo.insertEndpointIfUnderLimit(mkInput(accountId, i), 1)),
      );
      expect(results.filter((r) => r !== null)).toHaveLength(1);
      expect(results.filter((r) => r === null)).toHaveLength(4);
      expect(await repo.countActiveEndpoints(accountId)).toBe(1);
      const winner = results.find((result) => result !== null);
      if (!winner) throw new Error('expected one webhook endpoint winner');
      expect(winner.secret).toMatch(/^whsec_/);
      const [stored] =
        await client`SELECT secret FROM webhook_endpoints WHERE account_id = ${accountId}`;
      expect(stored?.secret).toContain(WEBHOOK_SECRET_V2_PREFIX);
      expect(stored?.secret).not.toContain(winner.secret);

      const rotatedPlaintext = `whsec_${'r'.repeat(32)}`;
      const rotated = await repo.rotateSecret({
        id: winner.id,
        accountId,
        newSecret: rotatedPlaintext,
        newPrefix: rotatedPlaintext.slice(0, 12),
        graceExpiresAt: new Date(Date.now() + 86_400_000),
        now: new Date(),
      });
      expect(rotated?.secret).toBe(rotatedPlaintext);
      expect(rotated?.secretPrev).toBe(winner.secret);
      const [storedRotated] =
        await client`SELECT secret, secret_prev FROM webhook_endpoints WHERE id = ${winner.id}`;
      expect(storedRotated?.secret).toContain(WEBHOOK_SECRET_V2_PREFIX);
      expect(storedRotated?.secret_prev).toContain(WEBHOOK_SECRET_V2_PREFIX);
      expect(JSON.stringify(storedRotated)).not.toContain(rotatedPlaintext);
      expect(JSON.stringify(storedRotated)).not.toContain(winner.secret);
    });

    it('6 concurrent inserts on a limit-3 account yield EXACTLY 3 rows', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleWebhooksRepo(
        { client, db, close: async () => {} },
        { secretEncryptionKeyBase64: WEBHOOK_KEY },
      );
      const accountId = await seedAccount(client);

      const results = await Promise.all(
        [0, 1, 2, 3, 4, 5].map((i) => repo.insertEndpointIfUnderLimit(mkInput(accountId, i), 3)),
      );
      expect(results.filter((r) => r !== null)).toHaveLength(3);
      expect(await repo.countActiveEndpoints(accountId)).toBe(3);
    });

    it('bounded upgrader converts legacy current+previous keys without changing in-process plaintext', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleWebhooksRepo(
        { client, db, close: async () => {} },
        { secretEncryptionKeyBase64: WEBHOOK_KEY },
      );
      const accountId = await seedAccount(client);
      const current = `whsec_${'c'.repeat(32)}`;
      const previous = `whsec_${'d'.repeat(32)}`;
      const previousV1 = `${WEBHOOK_SECRET_V1_PREFIX}${encryptPlatformSecret(
        previous,
        WEBHOOK_KEY,
      ).toString('base64')}`;
      const [inserted] = await client`
        INSERT INTO webhook_endpoints
          (account_id, url, secret, secret_prefix, secret_prev, secret_prev_expires_at, events, description)
        VALUES
          (${accountId}, 'https://hooks.example/legacy', ${current}, 'whsec_cccccc', ${previousV1}, NOW() + INTERVAL '1 day', ARRAY['session.completed']::webhook_event_type[], NULL)
        RETURNING id
      `;
      const endpointId = String(inserted?.id);

      const upgraded = await repo.encryptLegacySecrets(500);
      // Asserted as the sweep's INVARIANT, not as a global row count.
      // `encryptLegacySecrets` takes no account scope — it sweeps the whole
      // table — so `scanned: 1` really asserts that webhook_endpoints holds
      // exactly this test's row. Six real-Postgres integration files insert
      // legacy secrets and vitest runs files in parallel, so that is false
      // whenever any of them overlaps: seeding one legacy endpoint under an
      // unrelated account reproduces it exactly, `scanned: 2` against 1.
      // What the upgrader actually promises is that everything it scans is
      // converted and nothing is left legacy, which is true regardless of who
      // else has rows in the table.
      expect(upgraded.converted, 'every row it scanned was converted').toBe(upgraded.scanned);
      expect(upgraded.scanned, "including this test's row").toBeGreaterThanOrEqual(1);
      expect(upgraded.remaining, 'and nothing was left legacy').toBe(0);
      const [stored] =
        await client`SELECT secret, secret_prev FROM webhook_endpoints WHERE id = ${endpointId}`;
      expect(stored?.secret).toContain(WEBHOOK_SECRET_V2_PREFIX);
      expect(stored?.secret_prev).toContain(WEBHOOK_SECRET_V2_PREFIX);
      expect(JSON.stringify(stored)).not.toContain(current);
      expect(JSON.stringify(stored)).not.toContain(previous);
      const read = await repo.findEndpoint(endpointId, accountId);
      expect(read?.secret).toBe(current);
      expect(read?.secretPrev).toBe(previous);
    });

    it('prevalidates the whole page, preserves timestamps, and rejects same/cross-account relocation', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleWebhooksRepo(
        { client, db, close: async () => {} },
        { secretEncryptionKeyBase64: WEBHOOK_KEY },
      );
      const accountA = await seedAccount(client);
      const accountB = await seedAccount(client);
      const idA1 = randomUUID();
      const idA2 = randomUUID();
      const idB1 = randomUUID();
      const secretA1 = `whsec_${'k'.repeat(32)}`;
      const secretA2 = `whsec_${'m'.repeat(32)}`;
      const secretB1 = `whsec_${'n'.repeat(32)}`;
      const wrongKey = randomBytes(32).toString('base64');
      const invalidV1 = `${WEBHOOK_SECRET_V1_PREFIX}${encryptPlatformSecret(
        secretA2,
        wrongKey,
      ).toString('base64')}`;
      const updatedAt = new Date('2026-07-14T22:50:00.000Z');
      const updatedAtIso = updatedAt.toISOString();

      await client`
        INSERT INTO webhook_endpoints
          (id, account_id, url, secret, secret_prefix, events, description, updated_at)
        VALUES
          (${idA1}, ${accountA}, 'https://hooks.example/a1', ${secretA1}, 'whsec_kkkkkk', ARRAY['session.completed']::webhook_event_type[], NULL, ${updatedAtIso}::timestamptz),
          (${idA2}, ${accountA}, 'https://hooks.example/a2', ${invalidV1}, 'whsec_mmmmmm', ARRAY['session.completed']::webhook_event_type[], NULL, ${updatedAtIso}::timestamptz),
          (${idB1}, ${accountB}, 'https://hooks.example/b1', ${secretB1}, 'whsec_nnnnnn', ARRAY['session.completed']::webhook_event_type[], NULL, ${updatedAtIso}::timestamptz)
      `;

      const before = await client<
        Array<{ id: string; secret: string; updated_at: string }>
      >`SELECT id::text, secret, updated_at FROM webhook_endpoints WHERE id IN (${idA1}, ${idA2}, ${idB1}) ORDER BY id`;
      await expect(repo.encryptLegacySecrets(500)).rejects.toThrow();
      const afterFailure = await client<
        Array<{ id: string; secret: string; updated_at: string }>
      >`SELECT id::text, secret, updated_at FROM webhook_endpoints WHERE id IN (${idA1}, ${idA2}, ${idB1}) ORDER BY id`;
      expect(afterFailure).toEqual(before);

      const repairedV1 = `${WEBHOOK_SECRET_V1_PREFIX}${encryptPlatformSecret(
        secretA2,
        WEBHOOK_KEY,
      ).toString('base64')}`;
      await client`UPDATE webhook_endpoints SET secret = ${repairedV1} WHERE id = ${idA2}`;
      // Invariant-scoped for the reason given on the first upgrader case above.
      const swept = await repo.encryptLegacySecrets(500);
      expect(swept.converted, 'every row it scanned was converted').toBe(swept.scanned);
      expect(swept.scanned, "including all three of this test's rows").toBeGreaterThanOrEqual(3);
      expect(swept.remaining, 'and nothing was left legacy').toBe(0);
      const migrated = await client<
        Array<{ id: string; secret: string; updated_at: string }>
      >`SELECT id::text, secret, updated_at FROM webhook_endpoints WHERE id IN (${idA1}, ${idA2}, ${idB1}) ORDER BY id`;
      expect(migrated.every((row) => row.secret.startsWith(WEBHOOK_SECRET_V2_PREFIX))).toBe(true);
      expect(
        migrated.every((row) => new Date(row.updated_at).toISOString() === updatedAt.toISOString()),
      ).toBe(true);

      const byId = new Map(migrated.map((row) => [row.id, row.secret]));
      await client`
        UPDATE webhook_endpoints SET secret = CASE id
          WHEN ${idA1}::uuid THEN ${byId.get(idA2)!}
          WHEN ${idA2}::uuid THEN ${byId.get(idA1)!}
          ELSE secret END
        WHERE id IN (${idA1}, ${idA2})
      `;
      await expect(repo.findEndpoint(idA1, accountA)).rejects.toThrow();
      await expect(repo.findEndpoint(idA2, accountA)).rejects.toThrow();

      await client`
        UPDATE webhook_endpoints SET secret = CASE id
          WHEN ${idA1}::uuid THEN ${byId.get(idA1)!}
          WHEN ${idA2}::uuid THEN ${byId.get(idA2)!}
          WHEN ${idB1}::uuid THEN ${byId.get(idA1)!}
          ELSE secret END
        WHERE id IN (${idA1}, ${idA2}, ${idB1})
      `;
      await expect(repo.findEndpoint(idB1, accountB)).rejects.toThrow();
      await client`UPDATE webhook_endpoints SET secret = ${byId.get(idB1)!} WHERE id = ${idB1}`;

      const wrongKeyRepo = new DrizzleWebhooksRepo(
        { client, db, close: async () => {} },
        { secretEncryptionKeyBase64: wrongKey },
      );
      await expect(wrongKeyRepo.encryptLegacySecrets(500)).rejects.toThrow();
      const afterWrongKey = await client<
        Array<{ id: string; secret: string; updated_at: string }>
      >`SELECT id::text, secret, updated_at FROM webhook_endpoints WHERE id IN (${idA1}, ${idA2}, ${idB1}) ORDER BY id`;
      expect(afterWrongKey).toEqual(migrated);
    });

    it('loses the exact four-field migration CAS safely to a concurrent v2 successor', async () => {
      if (!dbReachable || !client) return;
      const accountId = await seedAccount(client);
      const endpointId = randomUUID();
      const legacy = `whsec_${'p'.repeat(32)}`;
      const successor = encryptWebhookSecret(`whsec_${'q'.repeat(32)}`, WEBHOOK_KEY, {
        accountId,
        endpointId,
      });
      const updatedAt = new Date('2026-07-14T22:51:00.000Z');
      const updatedAtIso = updatedAt.toISOString();
      await client`
        INSERT INTO webhook_endpoints
          (id, account_id, url, secret, secret_prefix, events, description, updated_at)
        VALUES
          (${endpointId}, ${accountId}, 'https://hooks.example/cas', ${legacy}, 'whsec_pppppp', ARRAY['session.completed']::webhook_event_type[], NULL, ${updatedAtIso}::timestamptz)
      `;

      const blocker = postgres(DB_URL, { max: 1 });
      const migratorClient = postgres(DB_URL, { max: 1 });
      const [backend] = await migratorClient<Array<{ pid: number }>>`
        SELECT pg_backend_pid()::int AS pid
      `;
      const migratorDb = drizzle(migratorClient) as unknown as ReturnType<
        typeof drizzle<typeof schema>
      >;
      const migratorRepo = new DrizzleWebhooksRepo(
        { client: migratorClient, db: migratorDb, close: async () => {} },
        { secretEncryptionKeyBase64: WEBHOOK_KEY },
      );
      let migration: Promise<{ scanned: number; converted: number; remaining: number }> | null =
        null;
      let blocked = false;
      let transactionOpen = false;
      try {
        await blocker`BEGIN`;
        transactionOpen = true;
        await blocker`SELECT id FROM webhook_endpoints WHERE id = ${endpointId} FOR UPDATE`;
        migration = migratorRepo.encryptLegacySecrets(500);
        void migration.catch(() => {});
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const [activity] = await client<Array<{ waiting: boolean }>>`
            SELECT wait_event_type = 'Lock' AS waiting
            FROM pg_stat_activity
            WHERE pid = ${backend!.pid} AND state = 'active'
            LIMIT 1
          `;
          if (activity?.waiting === true) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await blocker`
          UPDATE webhook_endpoints SET secret = ${successor} WHERE id = ${endpointId}
        `;
        await blocker`COMMIT`;
        transactionOpen = false;

        // That THIS row lost the CAS is asserted per-row below — `stored.secret`
        // is the successor's value, never the migration's. A global
        // `converted: 0` would additionally require that no other test's legacy
        // row existed anywhere in the table, which is not this test's subject.
        const outcome = await migration;
        expect(outcome.scanned, 'the sweep reached this row').toBeGreaterThanOrEqual(1);
        expect(outcome.remaining, 'and left nothing legacy behind').toBe(0);
        expect(blocked).toBe(true);
        const [stored] = await client<
          Array<{ secret: string; updated_at: string }>
        >`SELECT secret, updated_at FROM webhook_endpoints WHERE id = ${endpointId}`;
        if (stored === undefined) throw new Error('Migrated webhook endpoint row disappeared.');
        expect(stored.secret).toBe(successor);
        expect(new Date(stored.updated_at).toISOString()).toBe(updatedAt.toISOString());
      } finally {
        if (transactionOpen) await blocker`ROLLBACK`.catch(() => {});
        await blocker.end({ timeout: 5 }).catch(() => {});
        await migratorClient.end({ timeout: 5 }).catch(() => {});
      }
    });
  },
);
