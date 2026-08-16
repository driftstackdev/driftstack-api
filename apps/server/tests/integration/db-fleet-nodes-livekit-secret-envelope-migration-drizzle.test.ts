import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureIsolatedDatabase } from './_helpers/isolated-database.js';
import { DrizzleFleetNodesRepo } from '../../src/db/fleet-nodes-repo.js';
import {
  decryptLivekitSecret,
  encryptLivekitSecret,
  LIVEKIT_SECRET_V2_PREFIX,
} from '../../src/lib/livekit-secret-encryption.js';
import type * as schema from '../../src/db/schema.js';

// Runs against its OWN database: this file calls a GLOBAL envelope migration,
// which scans its whole table and therefore depends on rows owned by whatever
// else is running. See _helpers/isolated-database.ts for why fixture discipline
// cannot close that and isolation can.
const ISOLATED_DB_NAME = 'driftstack_iso_fleet_lk';
let DB_URL = '';
const ENCRYPTION_KEY = Buffer.alloc(32, 51).toString('base64');
const WRONG_KEY = Buffer.alloc(32, 52).toString('base64');
const TEST_SCHEMA = `livekit_envelope_${randomUUID().replaceAll('-', '')}`;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;

function encryptLegacySecret(secret: string, keyBase64 = ENCRYPTION_KEY): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

async function insertLegacyNode(args: {
  id: string;
  apiKey: string;
  secret: string;
  wsUrl: string;
  registeredAt: Date;
  keyBase64?: string;
}): Promise<void> {
  const ciphertext = encryptLegacySecret(args.secret, args.keyBase64);
  await client!`
    INSERT INTO fleet_nodes (
      id, livekit_api_key, livekit_api_secret_ciphertext,
      livekit_ws_url, livekit_registered_at
    ) VALUES (
      ${args.id}, ${args.apiKey}, ${ciphertext},
      ${args.wsUrl}, ${args.registeredAt.toISOString()}::timestamptz
    )
  `;
}

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
  client = postgres(DB_URL, { max: 1 });
  await client.unsafe(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  await client.unsafe(`
    CREATE TABLE "${TEST_SCHEMA}".fleet_nodes (
      id uuid PRIMARY KEY,
      livekit_api_key text,
      livekit_api_secret_ciphertext text,
      livekit_ws_url text,
      livekit_registered_at timestamptz
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
  'LiveKit API secret record-bound migration (Drizzle path, real Postgres)',
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

    it('preserves bytes and operational timestamp on wrong key, then rejects physical tuple relocation after migration', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleFleetNodesRepo({ client, db, close: async () => {} });
      const id = randomUUID();
      const otherId = randomUUID();
      const apiKey = 'lk_api_migration_a';
      const wsUrl = 'wss://node-a.example.test:7880';
      const registeredAt = new Date('2026-07-14T20:00:00.000Z');
      await insertLegacyNode({
        id,
        apiKey,
        secret: 'lk_secret_migration_a',
        wsUrl,
        registeredAt,
      });

      const [before] = await client<
        Array<{ ciphertext: string; livekit_registered_at: Date }>
      >`SELECT livekit_api_secret_ciphertext AS ciphertext, livekit_registered_at
        FROM fleet_nodes WHERE id = ${id}`;
      await expect(repo.migrateLivekitSecretEnvelopes(WRONG_KEY, 500)).rejects.toThrow();
      const [afterWrongKey] = await client<
        Array<{ ciphertext: string; livekit_registered_at: Date }>
      >`SELECT livekit_api_secret_ciphertext AS ciphertext, livekit_registered_at
        FROM fleet_nodes WHERE id = ${id}`;
      expect(afterWrongKey?.ciphertext).toBe(before?.ciphertext);
      expect(new Date(String(afterWrongKey!.livekit_registered_at)).toISOString()).toBe(
        registeredAt.toISOString(),
      );

      await expect(repo.migrateLivekitSecretEnvelopes(ENCRYPTION_KEY, 500)).resolves.toEqual({
        scanned: 1,
        converted: 1,
        remaining: 0,
      });
      const [migrated] = await client<
        Array<{
          id: string;
          api_key: string;
          ciphertext: string;
          ws_url: string;
          livekit_registered_at: Date;
        }>
      >`SELECT id::text, livekit_api_key AS api_key,
          livekit_api_secret_ciphertext AS ciphertext,
          livekit_ws_url AS ws_url, livekit_registered_at
        FROM fleet_nodes WHERE id = ${id}`;
      expect(migrated?.ciphertext.startsWith(LIVEKIT_SECRET_V2_PREFIX)).toBe(true);
      expect(new Date(String(migrated!.livekit_registered_at)).toISOString()).toBe(
        registeredAt.toISOString(),
      );
      expect(
        decryptLivekitSecret(migrated!.ciphertext, ENCRYPTION_KEY, {
          nodeId: migrated!.id,
          apiKey: migrated!.api_key,
          wsUrl: migrated!.ws_url,
        }),
      ).toBe('lk_secret_migration_a');
      await expect(repo.migrateLivekitSecretEnvelopes(WRONG_KEY, 500)).rejects.toThrow();

      await client`UPDATE fleet_nodes SET id = ${otherId} WHERE id = ${id}`;
      expect(() =>
        decryptLivekitSecret(migrated!.ciphertext, ENCRYPTION_KEY, {
          nodeId: otherId,
          apiKey,
          wsUrl,
        }),
      ).toThrow();
      await client`UPDATE fleet_nodes SET id = ${id} WHERE id = ${otherId}`;

      await client`UPDATE fleet_nodes SET livekit_api_key = ${`${apiKey}-moved`} WHERE id = ${id}`;
      expect(() =>
        decryptLivekitSecret(migrated!.ciphertext, ENCRYPTION_KEY, {
          nodeId: id,
          apiKey: `${apiKey}-moved`,
          wsUrl,
        }),
      ).toThrow();
      await client`UPDATE fleet_nodes SET livekit_api_key = ${apiKey} WHERE id = ${id}`;

      const movedUrl = 'wss://node-b.example.test:7880';
      await client`UPDATE fleet_nodes SET livekit_ws_url = ${movedUrl} WHERE id = ${id}`;
      expect(() =>
        decryptLivekitSecret(migrated!.ciphertext, ENCRYPTION_KEY, {
          nodeId: id,
          apiKey,
          wsUrl: movedUrl,
        }),
      ).toThrow();
      await client`UPDATE fleet_nodes SET livekit_ws_url = ${wsUrl} WHERE id = ${id}`;
    });

    it('prevalidates the complete page before writing any row', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleFleetNodesRepo({ client, db, close: async () => {} });
      const validId = randomUUID();
      const invalidId = randomUUID();
      const registeredAt = new Date('2026-07-14T20:01:00.000Z');
      await insertLegacyNode({
        id: validId,
        apiKey: 'lk_api_page_valid',
        secret: 'lk_secret_page_valid',
        wsUrl: 'wss://valid.example.test',
        registeredAt,
      });
      await insertLegacyNode({
        id: invalidId,
        apiKey: 'lk_api_page_invalid',
        secret: 'lk_secret_page_invalid',
        wsUrl: 'wss://invalid.example.test',
        registeredAt,
        keyBase64: WRONG_KEY,
      });

      await expect(repo.migrateLivekitSecretEnvelopes(ENCRYPTION_KEY, 500)).rejects.toThrow();
      const rows = await client<Array<{ id: string; ciphertext: string }>>`
        SELECT id::text, livekit_api_secret_ciphertext AS ciphertext
        FROM fleet_nodes WHERE id IN (${validId}, ${invalidId}) ORDER BY id
      `;
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => !row.ciphertext.startsWith(LIVEKIT_SECRET_V2_PREFIX))).toBe(true);

      const replacement = encryptLegacySecret('lk_secret_page_repaired');
      await client`UPDATE fleet_nodes SET livekit_api_secret_ciphertext = ${replacement}
        WHERE id = ${invalidId}`;
      await expect(repo.migrateLivekitSecretEnvelopes(ENCRYPTION_KEY, 500)).resolves.toEqual({
        scanned: 2,
        converted: 2,
        remaining: 0,
      });
    });

    it('loses the exact five-field CAS safely when a concurrent registration replaces the legacy tuple', async () => {
      if (!dbReachable || !client) return;
      const id = randomUUID();
      const oldApiKey = 'lk_api_cas_old';
      const oldWsUrl = 'wss://old.example.test';
      const oldRegisteredAt = new Date('2026-07-14T20:02:00.000Z');
      await insertLegacyNode({
        id,
        apiKey: oldApiKey,
        secret: 'lk_secret_cas_old',
        wsUrl: oldWsUrl,
        registeredAt: oldRegisteredAt,
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
      const migratorRepo = new DrizzleFleetNodesRepo({
        client: migratorClient,
        db: migratorDb,
        close: async () => {},
      });
      let migration: Promise<{ scanned: number; converted: number; remaining: number }> | null =
        null;
      let blocked = false;
      try {
        const nextApiKey = 'lk_api_cas_new';
        const nextWsUrl = 'wss://new.example.test';
        const nextRegisteredAt = new Date('2026-07-14T20:03:00.000Z');
        const nextCiphertext = encryptLivekitSecret('lk_secret_cas_new', ENCRYPTION_KEY, {
          nodeId: id,
          apiKey: nextApiKey,
          wsUrl: nextWsUrl,
        });
        await blocker.begin(async (tx) => {
          await tx`SELECT id FROM fleet_nodes WHERE id = ${id} FOR UPDATE`;
          migration = migratorRepo.migrateLivekitSecretEnvelopes(ENCRYPTION_KEY, 500);
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
          await tx`UPDATE fleet_nodes SET
            livekit_api_key = ${nextApiKey},
            livekit_api_secret_ciphertext = ${nextCiphertext},
            livekit_ws_url = ${nextWsUrl},
            livekit_registered_at = ${nextRegisteredAt.toISOString()}::timestamptz
            WHERE id = ${id}`;
        });
        await expect(migration!).resolves.toEqual({ scanned: 1, converted: 0, remaining: 0 });
        expect(blocked).toBe(true);

        const [after] = await client<
          Array<{
            api_key: string;
            ciphertext: string;
            ws_url: string;
            registered_at: Date;
          }>
        >`SELECT livekit_api_key AS api_key,
            livekit_api_secret_ciphertext AS ciphertext,
            livekit_ws_url AS ws_url,
            livekit_registered_at AS registered_at
          FROM fleet_nodes WHERE id = ${id}`;
        expect(after?.api_key).toBe(nextApiKey);
        expect(after?.ciphertext).toBe(nextCiphertext);
        expect(after?.ws_url).toBe(nextWsUrl);
        expect(new Date(String(after!.registered_at)).toISOString()).toBe(
          nextRegisteredAt.toISOString(),
        );
      } finally {
        await migratorClient.end({ timeout: 5 });
        await blocker.end({ timeout: 5 });
      }
    });
  },
);
