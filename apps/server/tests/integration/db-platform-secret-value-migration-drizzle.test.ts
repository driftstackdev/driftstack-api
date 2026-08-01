// Real-Postgres proof for name-bound platform-secret values, page-atomic legacy
// conversion, metadata preservation and exact-CAS loss to a live successor.

import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureIsolatedDatabase } from './_helpers/isolated-database.js';
import { DrizzlePlatformSecretsRepo } from '../../src/db/platform-secrets-repo.js';
import { PlatformSecretsService } from '../../src/services/platform-secrets.js';
import {
  decryptPlatformSecretValue,
  encryptPlatformSecretValue,
  isPlatformSecretValueV2Envelope,
} from '../../src/lib/platform-secret-value-encryption.js';
import type * as schema from '../../src/db/schema.js';

// Runs against its OWN database: this file calls a GLOBAL envelope migration,
// which scans its whole table and therefore depends on rows owned by whatever
// else is running. See _helpers/isolated-database.ts for why fixture discipline
// cannot close that and isolation can.
const ISOLATED_DB_NAME = 'driftstack_iso_platform_secret';
let DB_URL = '';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const TEST_SCHEMA = `platform_secret_value_${randomUUID().replaceAll('-', '')}`;
const KEY = Buffer.alloc(32, 83).toString('base64');
const WRONG_KEY = Buffer.alloc(32, 84).toString('base64');

let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;

function repoFor(sqlClient: ReturnType<typeof postgres>): DrizzlePlatformSecretsRepo {
  const db = drizzle(sqlClient) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return new DrizzlePlatformSecretsRepo({ db });
}

function encryptLegacy(plaintext: string, keyBase64 = KEY): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

async function insertSecret(args: {
  name: string;
  ciphertext: Buffer;
  description?: string;
  createdAt?: Date;
  updatedAt?: Date;
  updatedByKeyId?: string;
}): Promise<void> {
  const createdAt = args.createdAt ?? new Date('2026-07-14T21:00:00.000Z');
  const updatedAt = args.updatedAt ?? new Date('2026-07-14T21:01:00.000Z');
  await client!`
    INSERT INTO platform_secrets (
      name, description, ciphertext, created_at, updated_at, updated_by_key_id
    ) VALUES (
      ${args.name}, ${args.description ?? null}, ${args.ciphertext},
      ${createdAt.toISOString()}::timestamptz, ${updatedAt.toISOString()}::timestamptz,
      ${args.updatedByKeyId ?? null}::uuid
    )
  `;
}

beforeAll(async () => {
  const isolated = await ensureIsolatedDatabase(ISOLATED_DB_NAME);
  if (isolated === null) return;
  DB_URL = isolated;
  if (!RUN_DB_TESTS) return;
  admin = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await admin`SELECT 1`;
  } catch (error) {
    await admin.end({ timeout: 1 }).catch(() => {});
    admin = null;
    throw error;
  }
  await admin.unsafe(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  await admin.unsafe(`
    CREATE TABLE "${TEST_SCHEMA}".platform_secrets (
      name text PRIMARY KEY,
      description text,
      ciphertext bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by_key_id uuid
    )
  `);
  client = postgres(DB_URL, {
    max: 3,
    connection: { options: `-c search_path=${TEST_SCHEMA}` },
  });
  const [current] = await client<Array<{ value: string }>>`SELECT current_schema() AS value`;
  expect(current?.value).toBe(TEST_SCHEMA);
});

beforeEach(async () => {
  if (client) await client`TRUNCATE platform_secrets`;
});

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
  if (admin) {
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
    await admin.end({ timeout: 5 });
  }
});

describe.skipIf(!RUN_DB_TESTS)(
  'platform-secret name-bound migration (Drizzle path, real Postgres)',
  () => {
    it('fails wrong-key without writes, migrates metadata-preserving, and rejects relocation', async () => {
      if (!client) return;
      const repo = repoFor(client);
      const actorId = randomUUID();
      const createdAt = new Date('2026-07-14T21:10:00.000Z');
      const updatedAt = new Date('2026-07-14T21:11:00.000Z');
      const legacy = encryptLegacy('stripe-live-value');
      await insertSecret({
        name: 'stripe_secret_key',
        ciphertext: legacy,
        description: 'Stripe live key',
        createdAt,
        updatedAt,
        updatedByKeyId: actorId,
      });

      await expect(repo.migrateValueEnvelopes(WRONG_KEY, 500)).rejects.toThrow();
      const [afterWrongKey] = await client<
        Array<{
          ciphertext: Buffer;
          description: string;
          created_at: Date;
          updated_at: Date;
          updated_by_key_id: string;
        }>
      >`
        SELECT ciphertext, description, created_at, updated_at, updated_by_key_id
        FROM platform_secrets WHERE name = 'stripe_secret_key'
      `;
      expect(afterWrongKey?.ciphertext.equals(legacy)).toBe(true);

      await expect(repo.migrateValueEnvelopes(KEY, 500)).resolves.toEqual({
        scanned: 1,
        converted: 1,
        remaining: 0,
      });
      const [migrated] = await client<
        Array<{
          ciphertext: Buffer;
          description: string;
          created_at: Date;
          updated_at: Date;
          updated_by_key_id: string;
        }>
      >`
        SELECT ciphertext, description, created_at, updated_at, updated_by_key_id
        FROM platform_secrets WHERE name = 'stripe_secret_key'
      `;
      expect(isPlatformSecretValueV2Envelope(migrated!.ciphertext)).toBe(true);
      expect(decryptPlatformSecretValue(migrated!.ciphertext, KEY, 'stripe_secret_key')).toBe(
        'stripe-live-value',
      );
      expect(migrated?.description).toBe('Stripe live key');
      expect(new Date(String(migrated!.created_at)).toISOString()).toBe(createdAt.toISOString());
      expect(new Date(String(migrated!.updated_at)).toISOString()).toBe(updatedAt.toISOString());
      expect(migrated?.updated_by_key_id).toBe(actorId);
      await expect(repo.migrateValueEnvelopes(WRONG_KEY, 500)).rejects.toThrow();

      await insertSecret({
        name: 'postmark_server_token',
        ciphertext: encryptPlatformSecretValue('postmark-value', KEY, 'postmark_server_token'),
      });
      await client`
        UPDATE platform_secrets SET ciphertext = ${migrated!.ciphertext}
        WHERE name = 'postmark_server_token'
      `;
      expect(() =>
        decryptPlatformSecretValue(migrated!.ciphertext, KEY, 'postmark_server_token'),
      ).toThrow();
    });

    it('prevalidates the complete legacy page before its first write', async () => {
      if (!client) return;
      const repo = repoFor(client);
      await insertSecret({ name: 'a_valid', ciphertext: encryptLegacy('valid-value') });
      await insertSecret({
        name: 'z_wrong_key',
        ciphertext: encryptLegacy('wrong-key-value', WRONG_KEY),
      });

      await expect(repo.migrateValueEnvelopes(KEY, 500)).rejects.toThrow();
      const rows = await client<Array<{ ciphertext: Buffer }>>`
        SELECT ciphertext FROM platform_secrets ORDER BY name
      `;
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => !isPlatformSecretValueV2Envelope(row.ciphertext))).toBe(true);
    });

    it('loses exact name+ciphertext CAS safely to a concurrent v2 successor', async () => {
      if (!client) return;
      const updatedAt = new Date('2026-07-14T21:20:00.000Z');
      await insertSecret({
        name: 'concurrent_key',
        ciphertext: encryptLegacy('legacy-value'),
        updatedAt,
      });
      const successor = encryptPlatformSecretValue('successor-value', KEY, 'concurrent_key');
      const blocker = postgres(DB_URL, {
        max: 1,
        connection: { options: `-c search_path=${TEST_SCHEMA}` },
      });
      const migratorClient = postgres(DB_URL, {
        max: 1,
        connection: { options: `-c search_path=${TEST_SCHEMA}` },
      });
      const [backend] = await migratorClient<Array<{ pid: number }>>`
        SELECT pg_backend_pid()::int AS pid
      `;
      const migratorRepo = repoFor(migratorClient);
      let migration: Promise<{ scanned: number; converted: number; remaining: number }> | null =
        null;
      let blocked = false;
      try {
        await blocker`BEGIN`;
        await blocker`SELECT name FROM platform_secrets WHERE name = 'concurrent_key' FOR UPDATE`;
        migration = migratorRepo.migrateValueEnvelopes(KEY, 500);
        void migration.catch(() => {});
        for (let attempt = 0; attempt < 100; attempt++) {
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
          UPDATE platform_secrets SET ciphertext = ${successor} WHERE name = 'concurrent_key'
        `;
        await blocker`COMMIT`;

        await expect(migration).resolves.toEqual({ scanned: 1, converted: 0, remaining: 0 });
        expect(blocked).toBe(true);
        const [after] = await client<Array<{ ciphertext: Buffer; updated_at: Date }>>`
          SELECT ciphertext, updated_at FROM platform_secrets WHERE name = 'concurrent_key'
        `;
        expect(after?.ciphertext.equals(successor)).toBe(true);
        expect(decryptPlatformSecretValue(after!.ciphertext, KEY, 'concurrent_key')).toBe(
          'successor-value',
        );
        expect(new Date(String(after!.updated_at)).toISOString()).toBe(updatedAt.toISOString());
      } finally {
        await blocker`ROLLBACK`.catch(() => {});
        await migratorClient.end({ timeout: 5 });
        await blocker.end({ timeout: 5 });
      }
    });

    it('serializes five first writes into one created and four updated outcomes', async () => {
      if (!client) return;
      const service = new PlatformSecretsService(repoFor(client), KEY);
      const values = Array.from({ length: 5 }, (_, index) => `value-${index.toString()}`);

      const outcomes = await Promise.all(
        values.map((value) => service.set({ name: 'concurrent_key', value })),
      );

      expect(outcomes.sort()).toEqual(['created', 'updated', 'updated', 'updated', 'updated']);
      const [countRow] = await client<Array<{ total: number }>>`
        SELECT count(*)::int AS total FROM platform_secrets WHERE name = 'concurrent_key'
      `;
      expect(countRow?.total).toBe(1);
      const [stored] = await client<Array<{ ciphertext: Buffer }>>`
        SELECT ciphertext FROM platform_secrets WHERE name = 'concurrent_key'
      `;
      expect(isPlatformSecretValueV2Envelope(stored!.ciphertext)).toBe(true);
      const finalValue = decryptPlatformSecretValue(stored!.ciphertext, KEY, 'concurrent_key');
      expect(values).toContain(finalValue);
    });
  },
);
