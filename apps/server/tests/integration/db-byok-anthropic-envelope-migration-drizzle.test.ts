import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertIsolatedDatabase, ensureIsolatedDatabase } from './_helpers/isolated-database.js';
import { DrizzleBYOKAnthropicRepo } from '../../src/db/byok-anthropic-repo.js';
import {
  BYOK_ANTHROPIC_KEY_V2_PREFIX,
  decryptByokAnthropicKey,
  encryptByokAnthropicKey,
} from '../../src/lib/byok-anthropic-encryption.js';
import type * as schema from '../../src/db/schema.js';

// Runs against its OWN database: this file calls a GLOBAL envelope migration,
// which scans its whole table and therefore depends on rows owned by whatever
// else is running. See _helpers/isolated-database.ts for why fixture discipline
// cannot close that and isolation can.
const ISOLATED_DB_NAME = 'driftstack_iso_byok';
let DB_URL = '';
const KEY = Buffer.alloc(32, 71).toString('base64');
const WRONG_KEY = Buffer.alloc(32, 72).toString('base64');
const TEST_SCHEMA = `byok_anthropic_envelope_${randomUUID().replaceAll('-', '')}`;
const PREFIX_BYTES = Buffer.from(BYOK_ANTHROPIC_KEY_V2_PREFIX, 'utf8');
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;

function encryptLegacyForTest(plaintext: string, keyBase64 = KEY): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

async function insertAccount(args: {
  id: string;
  ciphertext: Buffer;
  setAt: Date;
  lastUsedAt: Date;
  reminderAt: Date;
  updatedAt: Date;
}): Promise<void> {
  await client!`
    INSERT INTO accounts (
      id, byok_anthropic_api_key_ciphertext, byok_anthropic_api_key_set_at,
      byok_anthropic_api_key_last_used_at,
      byok_anthropic_api_key_last_reminder_sent_at, updated_at
    ) VALUES (
      ${args.id}, ${args.ciphertext}, ${args.setAt.toISOString()}::timestamptz,
      ${args.lastUsedAt.toISOString()}::timestamptz,
      ${args.reminderAt.toISOString()}::timestamptz,
      ${args.updatedAt.toISOString()}::timestamptz
    )
  `;
}

beforeAll(async () => {
  const isolated = await ensureIsolatedDatabase(ISOLATED_DB_NAME);
  if (isolated === null) return;
  DB_URL = isolated;
  if (!RUN_DB_TESTS) return;
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch (error) {
    await probe.end({ timeout: 1 }).catch(() => {});
    throw error;
  }
  client = postgres(DB_URL, { max: 1 });
  // This file TRUNCATEs `accounts`, which cascades to most of the schema.
  await assertIsolatedDatabase(client, ISOLATED_DB_NAME);
  await client.unsafe(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  await client.unsafe(`
    CREATE TABLE "${TEST_SCHEMA}".accounts (
      id uuid PRIMARY KEY,
      byok_anthropic_api_key_ciphertext bytea,
      byok_anthropic_api_key_set_at timestamptz,
      byok_anthropic_api_key_last_used_at timestamptz,
      byok_anthropic_api_key_last_reminder_sent_at timestamptz,
      updated_at timestamptz NOT NULL
    )
  `);
  await client.unsafe(`SET search_path TO "${TEST_SCHEMA}"`);
});

beforeEach(async () => {
  if (client) await client`TRUNCATE accounts`;
});

afterAll(async () => {
  if (!client) return;
  await client.unsafe('SET search_path TO public').catch(() => {});
  await client.unsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
  await client.end({ timeout: 5 });
});

describe.skipIf(!RUN_DB_TESTS)(
  'BYOK Anthropic account-bound migration (Drizzle path, real Postgres)',
  () => {
    it('CRITICAL the database is reachable, so nothing below can pass vacuously', () => {
      // Every arm in this file returns early when `client` is null. That is right
      // when the suite runs without a database: the describe is skipped and
      // nothing claims to have tested anything. But when the describe DOES run and
      // Postgres is down or unmigrated, every arm returns early and the file
      // reports as PASSED. A green meaning "the database was missing" is
      // indistinguishable from one meaning "the database agreed", and that is the
      // worse of the two failure modes.
      expect(
        client,
        'postgres unreachable or unmigrated — the arms below never ran',
      ).not.toBeNull();
    });

    it('preserves bytes/timestamps on wrong key, migrates, then rejects cross-account relocation', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleBYOKAnthropicRepo({ client, db, close: async () => {} });
      const accountA = randomUUID();
      const accountB = randomUUID();
      const setAt = new Date('2026-07-14T21:00:00.000Z');
      const lastUsedAt = new Date('2026-07-14T21:01:00.000Z');
      const reminderAt = new Date('2026-07-14T21:02:00.000Z');
      const updatedAt = new Date('2026-07-14T21:03:00.000Z');
      const legacy = encryptLegacyForTest('sk-ant-api03-account-a');
      await insertAccount({
        id: accountA,
        ciphertext: legacy,
        setAt,
        lastUsedAt,
        reminderAt,
        updatedAt,
      });

      await expect(repo.migrateCiphertextEnvelopes(WRONG_KEY, 500)).rejects.toThrow();
      const [afterWrongKey] = await client<
        Array<{
          ciphertext: Buffer;
          set_at: Date;
          last_used_at: Date;
          reminder_at: Date;
          updated_at: Date;
        }>
      >`
        SELECT byok_anthropic_api_key_ciphertext AS ciphertext,
               byok_anthropic_api_key_set_at AS set_at,
               byok_anthropic_api_key_last_used_at AS last_used_at,
               byok_anthropic_api_key_last_reminder_sent_at AS reminder_at,
               updated_at
        FROM accounts WHERE id = ${accountA}
      `;
      expect(afterWrongKey?.ciphertext.equals(legacy)).toBe(true);
      expect(new Date(String(afterWrongKey!.set_at)).toISOString()).toBe(setAt.toISOString());
      expect(new Date(String(afterWrongKey!.last_used_at)).toISOString()).toBe(
        lastUsedAt.toISOString(),
      );
      expect(new Date(String(afterWrongKey!.reminder_at)).toISOString()).toBe(
        reminderAt.toISOString(),
      );
      expect(new Date(String(afterWrongKey!.updated_at)).toISOString()).toBe(
        updatedAt.toISOString(),
      );

      await expect(repo.migrateCiphertextEnvelopes(KEY, 500)).resolves.toEqual({
        scanned: 1,
        converted: 1,
        remaining: 0,
      });
      const [migrated] = await client<Array<{ ciphertext: Buffer; updated_at: Date }>>`
        SELECT byok_anthropic_api_key_ciphertext AS ciphertext, updated_at
        FROM accounts WHERE id = ${accountA}
      `;
      expect(migrated?.ciphertext.subarray(0, PREFIX_BYTES.length).equals(PREFIX_BYTES)).toBe(true);
      expect(decryptByokAnthropicKey(migrated!.ciphertext, KEY, accountA)).toBe(
        'sk-ant-api03-account-a',
      );
      expect(new Date(String(migrated!.updated_at)).toISOString()).toBe(updatedAt.toISOString());
      await expect(repo.migrateCiphertextEnvelopes(WRONG_KEY, 500)).rejects.toThrow();

      await insertAccount({
        id: accountB,
        ciphertext: encryptByokAnthropicKey('sk-ant-api03-account-b', KEY, accountB),
        setAt,
        lastUsedAt,
        reminderAt,
        updatedAt,
      });
      await client`
        UPDATE accounts SET byok_anthropic_api_key_ciphertext = ${migrated!.ciphertext}
        WHERE id = ${accountB}
      `;
      expect(() => decryptByokAnthropicKey(migrated!.ciphertext, KEY, accountB)).toThrow();
    });

    it('prevalidates the complete legacy page before writing any row', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleBYOKAnthropicRepo({ client, db, close: async () => {} });
      const timestamp = new Date('2026-07-14T21:10:00.000Z');
      const validId = randomUUID();
      const invalidId = randomUUID();
      await insertAccount({
        id: validId,
        ciphertext: encryptLegacyForTest('sk-ant-api03-valid'),
        setAt: timestamp,
        lastUsedAt: timestamp,
        reminderAt: timestamp,
        updatedAt: timestamp,
      });
      await insertAccount({
        id: invalidId,
        ciphertext: encryptLegacyForTest('sk-ant-api03-invalid-key', WRONG_KEY),
        setAt: timestamp,
        lastUsedAt: timestamp,
        reminderAt: timestamp,
        updatedAt: timestamp,
      });

      await expect(repo.migrateCiphertextEnvelopes(KEY, 500)).rejects.toThrow();
      const rows = await client<Array<{ ciphertext: Buffer }>>`
        SELECT byok_anthropic_api_key_ciphertext AS ciphertext FROM accounts ORDER BY id
      `;
      expect(rows).toHaveLength(2);
      expect(
        rows.every((row) => !row.ciphertext.subarray(0, PREFIX_BYTES.length).equals(PREFIX_BYTES)),
      ).toBe(true);
    });

    async function expectBlockedCasPreservesSuccessor(kind: 'set' | 'clear'): Promise<void> {
      if (!client) return;
      await client`TRUNCATE accounts`;
      const accountId = randomUUID();
      const timestamp = new Date('2026-07-14T21:20:00.000Z');
      await insertAccount({
        id: accountId,
        ciphertext: encryptLegacyForTest('sk-ant-api03-old'),
        setAt: timestamp,
        lastUsedAt: timestamp,
        reminderAt: timestamp,
        updatedAt: timestamp,
      });

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
      const migratorRepo = new DrizzleBYOKAnthropicRepo({
        client: migratorClient,
        db: migratorDb,
        close: async () => {},
      });
      const successor = encryptByokAnthropicKey('sk-ant-api03-successor', KEY, accountId);
      let migration: Promise<{ scanned: number; converted: number; remaining: number }> | null =
        null;
      let blocked = false;
      try {
        await blocker.begin(async (tx) => {
          await tx`SELECT id FROM accounts WHERE id = ${accountId} FOR UPDATE`;
          migration = migratorRepo.migrateCiphertextEnvelopes(KEY, 500);
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
          if (kind === 'set') {
            await tx`
              UPDATE accounts SET byok_anthropic_api_key_ciphertext = ${successor}
              WHERE id = ${accountId}
            `;
          } else {
            await tx`
              UPDATE accounts SET byok_anthropic_api_key_ciphertext = NULL
              WHERE id = ${accountId}
            `;
          }
        });

        await expect(migration!).resolves.toEqual({ scanned: 1, converted: 0, remaining: 0 });
        expect(blocked).toBe(true);
        const [after] = await client<Array<{ ciphertext: Buffer | null; updated_at: Date }>>`
          SELECT byok_anthropic_api_key_ciphertext AS ciphertext, updated_at
          FROM accounts WHERE id = ${accountId}
        `;
        if (kind === 'set') {
          expect(after?.ciphertext?.equals(successor)).toBe(true);
          expect(decryptByokAnthropicKey(after!.ciphertext!, KEY, accountId)).toBe(
            'sk-ant-api03-successor',
          );
        } else {
          expect(after?.ciphertext).toBeNull();
        }
        expect(new Date(String(after!.updated_at)).toISOString()).toBe(timestamp.toISOString());
      } finally {
        await migratorClient.end({ timeout: 5 });
        await blocker.end({ timeout: 5 });
      }
    }

    it('loses exact CAS safely to concurrent set and clear successors', async () => {
      if (!dbReachable || !client) return;
      await expectBlockedCasPreservesSuccessor('set');
      await expectBlockedCasPreservesSuccessor('clear');
    });
  },
);
