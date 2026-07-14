import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleMfaRepo } from '../../src/db/mfa-repo.js';
import { decryptSecret, encryptSecret, MFA_TOTP_SECRET_V2_PREFIX } from '../../src/lib/mfa-totp.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const ENCRYPTION_KEY = Buffer.alloc(32, 41).toString('base64');
const WRONG_KEY = Buffer.alloc(32, 42).toString('base64');
const TEST_SCHEMA = `mfa_envelope_${randomUUID().replaceAll('-', '')}`;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;

function encryptLegacySecret(secret: Buffer, keyBase64 = ENCRYPTION_KEY) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

async function insertAccount(accountId: string): Promise<void> {
  await client!`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`mfa-envelope-${accountId}@test.local`})`;
}

async function insertLegacyTuple(
  accountId: string,
  tuple: { ciphertext: string; iv: string; tag: string },
  now = new Date(),
): Promise<void> {
  await client!`
    INSERT INTO account_mfa (
      account_id, totp_secret_ciphertext, totp_secret_iv, totp_secret_tag,
      created_at, updated_at
    ) VALUES (
      ${accountId}, ${tuple.ciphertext}, ${tuple.iv}, ${tuple.tag},
      ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz
    )
  `;
}

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM account_mfa LIMIT 0`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 1 });
  await client.unsafe(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  await client.unsafe(`
    CREATE TABLE "${TEST_SCHEMA}".accounts (
      id text PRIMARY KEY,
      email text NOT NULL
    );
    CREATE TABLE "${TEST_SCHEMA}".account_mfa (
      account_id text PRIMARY KEY REFERENCES "${TEST_SCHEMA}".accounts(id) ON DELETE CASCADE,
      totp_secret_ciphertext text NOT NULL,
      totp_secret_iv text NOT NULL,
      totp_secret_tag text NOT NULL,
      enrolled_at timestamptz,
      last_used_at timestamptz,
      last_used_totp_counter bigint,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
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
  'MFA secret record-bound migration (Drizzle path, real Postgres)',
  () => {
    it('leaves a legacy row byte-identical on wrong key, preserves its revision, and rejects account relocation after migration', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleMfaRepo({ client, db, close: async () => {} });
      const accountId = randomUUID();
      const otherAccountId = randomUUID();
      await insertAccount(accountId);
      await insertAccount(otherAccountId);
      const secret = Buffer.alloc(20, 11);
      const legacy = encryptLegacySecret(secret);
      const revision = new Date('2026-07-14T18:00:00.000Z');
      await insertLegacyTuple(accountId, legacy, revision);

      await expect(repo.migrateTotpSecretEnvelopes(WRONG_KEY, 500)).rejects.toThrow();
      const [afterWrongKey] = await client<
        Array<{
          ciphertext: string;
          iv: string;
          tag: string;
          updated_at: Date;
        }>
      >`SELECT
          totp_secret_ciphertext AS ciphertext,
          totp_secret_iv AS iv,
          totp_secret_tag AS tag,
          updated_at
        FROM account_mfa WHERE account_id = ${accountId}`;
      expect(afterWrongKey).toMatchObject(legacy);
      expect(new Date(String(afterWrongKey!.updated_at)).toISOString()).toBe(
        revision.toISOString(),
      );

      await expect(repo.migrateTotpSecretEnvelopes(ENCRYPTION_KEY, 500)).resolves.toEqual({
        scanned: 1,
        converted: 1,
        remaining: 0,
      });
      const migrated = await repo.findByAccount(accountId);
      expect(migrated?.totpSecretCiphertext.startsWith(MFA_TOTP_SECRET_V2_PREFIX)).toBe(true);
      expect(migrated?.updatedAt.toISOString()).toBe(revision.toISOString());
      expect(
        decryptSecret(
          {
            ciphertext: migrated!.totpSecretCiphertext,
            iv: migrated!.totpSecretIv,
            tag: migrated!.totpSecretTag,
          },
          ENCRYPTION_KEY,
          accountId,
        ).equals(secret),
      ).toBe(true);

      await client`UPDATE account_mfa SET account_id = ${otherAccountId} WHERE account_id = ${accountId}`;
      const relocated = await repo.findByAccount(otherAccountId);
      expect(() =>
        decryptSecret(
          {
            ciphertext: relocated!.totpSecretCiphertext,
            iv: relocated!.totpSecretIv,
            tag: relocated!.totpSecretTag,
          },
          ENCRYPTION_KEY,
          otherAccountId,
        ),
      ).toThrow();
      // Restore the row so successor-boot v2 probes in later cases see a valid
      // account-bound tuple rather than intentionally corrupted test state.
      await client`UPDATE account_mfa SET account_id = ${accountId} WHERE account_id = ${otherAccountId}`;
    });

    it('prevalidates the whole page before writing and refuses authenticated wrong-length legacy plaintext', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleMfaRepo({ client, db, close: async () => {} });
      const validAccountId = randomUUID();
      const invalidAccountId = randomUUID();
      await insertAccount(validAccountId);
      await insertAccount(invalidAccountId);
      const validLegacy = encryptLegacySecret(Buffer.alloc(20, 12));
      const invalidLegacy = encryptLegacySecret(Buffer.alloc(19, 13));
      await insertLegacyTuple(validAccountId, validLegacy, new Date('2026-07-14T18:01:00.000Z'));
      await insertLegacyTuple(
        invalidAccountId,
        invalidLegacy,
        new Date('2026-07-14T18:01:01.000Z'),
      );

      await expect(repo.migrateTotpSecretEnvelopes(ENCRYPTION_KEY, 500)).rejects.toThrow(
        /expected 20/,
      );
      const rows = await client<
        Array<{ account_id: string; ciphertext: string; iv: string; tag: string }>
      >`SELECT
          account_id,
          totp_secret_ciphertext AS ciphertext,
          totp_secret_iv AS iv,
          totp_secret_tag AS tag
        FROM account_mfa
        WHERE account_id IN (${validAccountId}, ${invalidAccountId})
        ORDER BY account_id`;
      const byAccount = new Map(rows.map((row) => [row.account_id, row]));
      expect(byAccount.get(validAccountId)).toMatchObject(validLegacy);
      expect(byAccount.get(invalidAccountId)).toMatchObject(invalidLegacy);

      const replacement = encryptLegacySecret(Buffer.alloc(20, 14));
      await client`UPDATE account_mfa SET
        totp_secret_ciphertext = ${replacement.ciphertext},
        totp_secret_iv = ${replacement.iv},
        totp_secret_tag = ${replacement.tag}
        WHERE account_id = ${invalidAccountId}`;
      await expect(repo.migrateTotpSecretEnvelopes(ENCRYPTION_KEY, 500)).resolves.toEqual({
        scanned: 2,
        converted: 2,
        remaining: 0,
      });
      await expect(repo.migrateTotpSecretEnvelopes(WRONG_KEY, 500)).rejects.toThrow();
      await expect(repo.migrateTotpSecretEnvelopes(ENCRYPTION_KEY, 500)).resolves.toEqual({
        scanned: 0,
        converted: 0,
        remaining: 0,
      });
    });

    it('loses an exact-tuple CAS safely when a concurrent writer replaces the legacy snapshot', async () => {
      if (!dbReachable || !client) return;
      const accountId = randomUUID();
      await insertAccount(accountId);
      await insertLegacyTuple(accountId, encryptLegacySecret(Buffer.alloc(20, 15)));

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
      const migratorRepo = new DrizzleMfaRepo({
        client: migratorClient,
        db: migratorDb,
        close: async () => {},
      });
      let migration: Promise<{ scanned: number; converted: number; remaining: number }> | null =
        null;
      let blocked = false;
      try {
        const replacement = encryptSecret(Buffer.alloc(20, 16), ENCRYPTION_KEY, accountId);
        await blocker.begin(async (tx) => {
          await tx`SELECT account_id FROM account_mfa WHERE account_id = ${accountId} FOR UPDATE`;
          migration = migratorRepo.migrateTotpSecretEnvelopes(ENCRYPTION_KEY, 500);
          void migration.catch(() => {});

          for (let attempt = 0; attempt < 100; attempt++) {
            const [activity] = await client!<Array<{ waiting: boolean }>>`
              SELECT wait_event_type = 'Lock' AS waiting
              FROM pg_stat_activity
              WHERE pid = ${backend!.pid}
                AND state = 'active'
              LIMIT 1
            `;
            if (activity?.waiting === true) {
              blocked = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          await tx`UPDATE account_mfa SET
            totp_secret_ciphertext = ${replacement.ciphertext},
            totp_secret_iv = ${replacement.iv},
            totp_secret_tag = ${replacement.tag}
            WHERE account_id = ${accountId}`;
        });
        const result = await migration!;
        expect(blocked).toBe(true);
        expect(result).toEqual({ scanned: 1, converted: 0, remaining: 0 });
      } finally {
        await migratorClient.end({ timeout: 5 });
        await blocker.end({ timeout: 5 });
      }
    });
  },
);
