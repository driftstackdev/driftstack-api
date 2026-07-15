import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleProfilesRepo } from '../../src/db/profiles-repo.js';
import {
  deriveTenantMasterKey,
  PROFILE_DEK_V2_PREFIX,
  unwrapDek,
  unwrapProfileDek,
  wrapDek,
  wrapProfileDek,
} from '../../src/lib/profile-key-hierarchy.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const MASTER = Buffer.alloc(32, 61);
const WRONG_MASTER = Buffer.alloc(32, 62);
const TEST_SCHEMA = `profile_dek_envelope_${randomUUID().replaceAll('-', '')}`;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;

function legacyWrappedDek(accountId: string, masterKey: Buffer = MASTER): string {
  return wrapDek(Buffer.alloc(32, 7), deriveTenantMasterKey(masterKey, accountId));
}

async function insertLegacyProfile(args: {
  id: string;
  accountId: string;
  updatedAt: Date;
  masterKey?: Buffer;
}): Promise<string> {
  const wrappedDek = legacyWrappedDek(args.accountId, args.masterKey);
  await client!`
    INSERT INTO profiles (id, account_id, wrapped_dek, updated_at)
    VALUES (
      ${args.id}, ${args.accountId}, ${wrappedDek},
      ${args.updatedAt.toISOString()}::timestamptz
    )
  `;
  return wrappedDek;
}

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
  await client.unsafe(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  await client.unsafe(`
    CREATE TABLE "${TEST_SCHEMA}".profiles (
      id uuid PRIMARY KEY,
      account_id uuid NOT NULL,
      wrapped_dek text,
      updated_at timestamptz NOT NULL
    )
  `);
  await client.unsafe(`SET search_path TO "${TEST_SCHEMA}"`);
});

afterAll(async () => {
  if (!client) return;
  await client.unsafe('SET search_path TO public').catch(() => {});
  await client.unsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
  await client.end({ timeout: 5 });
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'profile DEK record-bound migration (Drizzle path, real Postgres)',
  () => {
    it('preserves bytes and metadata timestamp on wrong key, then rejects same-account row relocation', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleProfilesRepo({ client, db, close: async () => {} });
      const accountId = randomUUID();
      const id = randomUUID();
      const otherId = randomUUID();
      const updatedAt = new Date('2026-07-14T20:10:00.000Z');
      const legacy = await insertLegacyProfile({ id, accountId, updatedAt });

      await expect(repo.migrateWrappedDekEnvelopes(WRONG_MASTER, 500)).rejects.toThrow();
      const [afterWrongKey] = await client<
        Array<{ wrapped_dek: string; updated_at: Date }>
      >`SELECT wrapped_dek, updated_at FROM profiles WHERE id = ${id}`;
      expect(afterWrongKey?.wrapped_dek).toBe(legacy);
      expect(new Date(String(afterWrongKey!.updated_at)).toISOString()).toBe(
        updatedAt.toISOString(),
      );

      await expect(repo.migrateWrappedDekEnvelopes(MASTER, 500)).resolves.toEqual({
        scanned: 1,
        converted: 1,
        remaining: 0,
      });
      const [migrated] = await client<
        Array<{ wrapped_dek: string; updated_at: Date }>
      >`SELECT wrapped_dek, updated_at FROM profiles WHERE id = ${id}`;
      expect(migrated?.wrapped_dek.startsWith(PROFILE_DEK_V2_PREFIX)).toBe(true);
      expect(new Date(String(migrated!.updated_at)).toISOString()).toBe(updatedAt.toISOString());
      expect(
        unwrapProfileDek(MASTER, accountId, id, migrated!.wrapped_dek).equals(
          unwrapDek(legacy, deriveTenantMasterKey(MASTER, accountId)),
        ),
      ).toBe(true);
      await expect(repo.migrateWrappedDekEnvelopes(WRONG_MASTER, 500)).rejects.toThrow();

      const otherWrapped = wrapProfileDek(MASTER, accountId, otherId, Buffer.alloc(32, 9));
      await client`INSERT INTO profiles (id, account_id, wrapped_dek, updated_at)
        VALUES (${otherId}, ${accountId}, ${otherWrapped}, ${updatedAt.toISOString()}::timestamptz)`;
      await client`UPDATE profiles SET wrapped_dek = ${otherWrapped} WHERE id = ${id}`;
      expect(() => unwrapProfileDek(MASTER, accountId, id, otherWrapped)).toThrow();
      await client`UPDATE profiles SET wrapped_dek = ${migrated!.wrapped_dek} WHERE id = ${id}`;
    });

    it('prevalidates the complete legacy page before writing any row', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleProfilesRepo({ client, db, close: async () => {} });
      const accountId = randomUUID();
      const validId = randomUUID();
      const invalidId = randomUUID();
      const updatedAt = new Date('2026-07-14T20:11:00.000Z');
      await insertLegacyProfile({ id: validId, accountId, updatedAt });
      await insertLegacyProfile({
        id: invalidId,
        accountId,
        updatedAt,
        masterKey: WRONG_MASTER,
      });

      await expect(repo.migrateWrappedDekEnvelopes(MASTER, 500)).rejects.toThrow();
      const rows = await client<Array<{ id: string; wrapped_dek: string }>>`
        SELECT id::text, wrapped_dek FROM profiles
        WHERE id IN (${validId}, ${invalidId}) ORDER BY id
      `;
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => !row.wrapped_dek.startsWith(PROFILE_DEK_V2_PREFIX))).toBe(true);

      const repaired = legacyWrappedDek(accountId);
      await client`UPDATE profiles SET wrapped_dek = ${repaired} WHERE id = ${invalidId}`;
      await expect(repo.migrateWrappedDekEnvelopes(MASTER, 500)).resolves.toEqual({
        scanned: 2,
        converted: 2,
        remaining: 0,
      });
    });

    it('loses the exact record CAS safely when a concurrent successor replaces the legacy wrapper', async () => {
      if (!dbReachable || !client) return;
      const accountId = randomUUID();
      const id = randomUUID();
      const updatedAt = new Date('2026-07-14T20:12:00.000Z');
      await insertLegacyProfile({ id, accountId, updatedAt });

      const blocker = postgres(DB_URL, { max: 1 });
      const migratorClient = postgres(DB_URL, { max: 1 });
      await blocker.unsafe(`SET search_path TO "${TEST_SCHEMA}"`);
      await migratorClient.unsafe(`SET search_path TO "${TEST_SCHEMA}"`);
      const [backend] = await migratorClient<Array<{ pid: number }>>`
        SELECT pg_backend_pid()::int AS pid
      `;
      const migratorDb = drizzle(migratorClient) as unknown as ReturnType<
        typeof drizzle<typeof schema>
      >;
      const migratorRepo = new DrizzleProfilesRepo({
        client: migratorClient,
        db: migratorDb,
        close: async () => {},
      });
      let migration: Promise<{ scanned: number; converted: number; remaining: number }> | null =
        null;
      let blocked = false;
      const successor = wrapProfileDek(MASTER, accountId, id, Buffer.alloc(32, 11));
      try {
        await blocker.begin(async (tx) => {
          await tx`SELECT id FROM profiles WHERE id = ${id} FOR UPDATE`;
          migration = migratorRepo.migrateWrappedDekEnvelopes(MASTER, 500);
          void migration.catch(() => {});

          for (let attempt = 0; attempt < 100; attempt++) {
            const [activity] = await client!<Array<{ waiting: boolean }>>`
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
          await tx`UPDATE profiles SET wrapped_dek = ${successor} WHERE id = ${id}`;
        });

        await expect(migration!).resolves.toEqual({ scanned: 1, converted: 0, remaining: 0 });
        expect(blocked).toBe(true);
        const [after] = await client<
          Array<{ wrapped_dek: string; updated_at: Date }>
        >`SELECT wrapped_dek, updated_at FROM profiles WHERE id = ${id}`;
        expect(after?.wrapped_dek).toBe(successor);
        expect(new Date(String(after!.updated_at)).toISOString()).toBe(updatedAt.toISOString());
        expect(
          unwrapProfileDek(MASTER, accountId, id, successor).equals(Buffer.alloc(32, 11)),
        ).toBe(true);
      } finally {
        await migratorClient.end({ timeout: 5 });
        await blocker.end({ timeout: 5 });
      }
    });
  },
);
