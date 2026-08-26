// Isolated real-Postgres proof for saved-recipe v2 payload binding. The test
// schema intentionally has no agent-session FK so it can also prove that the
// production ON DELETE SET NULL transition does not affect payload readability.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertIsolatedDatabase, ensureIsolatedDatabase } from './_helpers/isolated-database.js';
import { DrizzleRecipesRepo } from '../../src/db/recipes-repo.js';
import { encryptPlatformSecret } from '../../src/lib/platform-secret-encryption.js';
import {
  encryptRecipeIntentLog,
  encryptRecipeTranscriptSnapshot,
} from '../../src/services/recipe-payload-encryption.js';
import type * as schema from '../../src/db/schema.js';

// Runs against its OWN database: this file calls a GLOBAL envelope migration,
// which scans its whole table and therefore depends on rows owned by whatever
// else is running. See _helpers/isolated-database.ts for why fixture discipline
// cannot close that and isolation can.
const ISOLATED_DB_NAME = 'driftstack_iso_recipes';
let DB_URL = '';
const KEY = Buffer.alloc(32, 51).toString('base64');
const WRONG_KEY = Buffer.alloc(32, 52).toString('base64');
const TEST_SCHEMA = `recipe_payload_envelope_${randomUUID().replaceAll('-', '')}`;
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

let client: ReturnType<typeof postgres> | null = null;

const intentLog = [
  {
    kind: 'interact' as const,
    action: 'type' as const,
    selector: '#password',
    value: 'legacy-password-secret',
    sensitive: true,
  },
];
const transcript = [
  {
    at: '2026-07-14T00:00:00.000Z',
    role: 'user' as const,
    body: 'legacy transcript secret',
  },
];

function recipeId(): string {
  return `rec_${randomUUID()}`;
}

function legacyIntent(key = KEY): unknown {
  return {
    kind: 'driftstack.recipe-intent-log',
    version: 1,
    ciphertext: encryptPlatformSecret(JSON.stringify(intentLog), key, undefined).toString('base64'),
  };
}

function legacyTranscript(key = KEY): unknown {
  return {
    kind: 'driftstack.agent-transcript',
    version: 1,
    ciphertext: encryptPlatformSecret(JSON.stringify(transcript), key, undefined).toString(
      'base64',
    ),
  };
}

async function insertRecipe(args: {
  id: string;
  accountId: string;
  intent: unknown;
  snapshot: unknown;
  agentSessionId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}): Promise<void> {
  const createdAt = args.createdAt ?? new Date('2026-07-14T21:40:00.000Z');
  const updatedAt = args.updatedAt ?? new Date('2026-07-14T21:41:00.000Z');
  await client!`
    INSERT INTO recipes (
      id, account_id, agent_session_id, label, description,
      intent_log, transcript_snapshot, created_at, updated_at
    ) VALUES (
      ${args.id}, ${args.accountId}, ${args.agentSessionId ?? null}, 'Saved recipe', NULL,
      ${JSON.stringify(args.intent)}::text::jsonb, ${JSON.stringify(args.snapshot)}::text::jsonb,
      ${createdAt.toISOString()}::timestamptz, ${updatedAt.toISOString()}::timestamptz
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
    await probe.end({ timeout: 1 });
  } catch (error) {
    await probe.end({ timeout: 1 }).catch(() => {});
    throw error;
  }
  client = postgres(DB_URL, { max: 1 });
  // This file TRUNCATEs; prove the connection before anything destructive runs.
  await assertIsolatedDatabase(client, ISOLATED_DB_NAME);
  await client.unsafe(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  await client.unsafe(`
    CREATE TABLE "${TEST_SCHEMA}".recipes (
      id text PRIMARY KEY,
      account_id uuid NOT NULL,
      agent_session_id text,
      label text NOT NULL,
      description text,
      intent_log jsonb NOT NULL,
      transcript_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.unsafe(`SET search_path TO "${TEST_SCHEMA}"`);
});

beforeEach(async () => {
  if (client) await client`TRUNCATE recipes`;
});

afterAll(async () => {
  if (!client) return;
  await client.unsafe('SET search_path TO public').catch(() => {});
  await client.unsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
  await client.end({ timeout: 5 });
});

describe.skipIf(!RUN_DB_TESTS)(
  'saved recipe record-bound migration (Drizzle path, real Postgres)',
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

    it("CRITICAL list clamps an oversized limit to MAX_RECIPE_PAGE. This clamp had NO coverage of ANY kind: removing it left the entire suite green — 28,015 passed, not even a source-text pin noticed. Its two siblings (profiles, profile-snapshots) at least had pins. The routes in front carry a Zod .max(100), so the clamp is defence-in-depth, and a caller reaching this repo without one would pull the account's whole recipe table.", async () => {
      if (!client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleRecipesRepo(
        { client, db, close: async () => {} },
        { payloadEncryptionKeyBase64: KEY },
      );
      const accountId = randomUUID();
      // Seeded through the repo, not by raw INSERT. A first version bulk-loaded
      // 101 rows of plain jsonb in one statement and list() refused them with
      // "Recipe intent-log storage is not a v2 envelope": the payload envelope
      // is bound to { accountId, recipeId }, so one ciphertext cannot be reused
      // across rows and there is no valid bulk shortcut.
      for (let i = 0; i < 101; i += 1) {
        await repo.create({
          accountId,
          agentSessionId: null,
          label: `cap-rec-${String(i)}`,
          intentLog: [],
          transcriptSnapshot: [],
        });
      }

      const page = await repo.list({ accountId, limit: 5000 });
      expect(page.data.length, 'the oversized limit was clamped to MAX_RECIPE_PAGE').toBe(100);
    });

    it('preserves bytes/timestamps on wrong key, migrates, and rejects record relocation', async () => {
      if (!client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleRecipesRepo(
        { client, db, close: async () => {} },
        { payloadEncryptionKeyBase64: KEY },
      );
      const wrongKeyRepo = new DrizzleRecipesRepo(
        { client, db, close: async () => {} },
        { payloadEncryptionKeyBase64: WRONG_KEY },
      );
      const accountA = randomUUID();
      const accountB = randomUUID();
      const sourceId = recipeId();
      const sameAccountId = recipeId();
      const crossAccountId = recipeId();
      const sourceSessionId = `agt_${randomUUID()}`;
      const createdAt = new Date('2026-07-14T21:42:00.000Z');
      const updatedAt = new Date('2026-07-14T21:43:00.000Z');
      await insertRecipe({
        id: sourceId,
        accountId: accountA,
        intent: legacyIntent(),
        snapshot: legacyTranscript(),
        agentSessionId: sourceSessionId,
        createdAt,
        updatedAt,
      });

      const [before] = await client<
        Array<{
          intent_log: unknown;
          transcript_snapshot: unknown;
          created_at: Date;
          updated_at: Date;
        }>
      >`
        SELECT intent_log, transcript_snapshot, created_at, updated_at
        FROM recipes WHERE id = ${sourceId}
      `;
      await expect(wrongKeyRepo.migratePayloadEnvelopes(500)).rejects.toThrow();
      const [afterWrongKey] = await client<
        Array<{
          intent_log: unknown;
          transcript_snapshot: unknown;
          created_at: Date;
          updated_at: Date;
        }>
      >`
        SELECT intent_log, transcript_snapshot, created_at, updated_at
        FROM recipes WHERE id = ${sourceId}
      `;
      expect(afterWrongKey?.intent_log).toEqual(before?.intent_log);
      expect(afterWrongKey?.transcript_snapshot).toEqual(before?.transcript_snapshot);
      expect(new Date(String(afterWrongKey!.created_at)).toISOString()).toBe(
        createdAt.toISOString(),
      );
      expect(new Date(String(afterWrongKey!.updated_at)).toISOString()).toBe(
        updatedAt.toISOString(),
      );

      await expect(repo.migratePayloadEnvelopes(500)).resolves.toEqual({
        scanned: 1,
        converted: 1,
        remaining: 0,
      });
      const [migrated] = await client<
        Array<{
          intent_log: unknown;
          transcript_snapshot: unknown;
          created_at: Date;
          updated_at: Date;
        }>
      >`
        SELECT intent_log, transcript_snapshot, created_at, updated_at
        FROM recipes WHERE id = ${sourceId}
      `;
      expect(migrated?.intent_log).toMatchObject({
        kind: 'driftstack.recipe-intent-log',
        version: 2,
      });
      expect(migrated?.transcript_snapshot).toMatchObject({
        kind: 'driftstack.recipe-transcript-snapshot',
        version: 2,
      });
      expect(new Date(String(migrated!.created_at)).toISOString()).toBe(createdAt.toISOString());
      expect(new Date(String(migrated!.updated_at)).toISOString()).toBe(updatedAt.toISOString());
      expect((await repo.getById({ accountId: accountA, id: sourceId }))?.intentLog).toEqual(
        intentLog,
      );

      await client`UPDATE recipes SET agent_session_id = NULL WHERE id = ${sourceId}`;
      expect(
        (await repo.getById({ accountId: accountA, id: sourceId }))?.transcriptSnapshot,
      ).toEqual(transcript);
      await expect(wrongKeyRepo.migratePayloadEnvelopes(500)).rejects.toThrow();

      await insertRecipe({
        id: sameAccountId,
        accountId: accountA,
        intent: [],
        snapshot: [],
      });
      await insertRecipe({
        id: crossAccountId,
        accountId: accountB,
        intent: [],
        snapshot: [],
      });
      for (const targetId of [sameAccountId, crossAccountId]) {
        await client`
          UPDATE recipes SET
            intent_log = ${JSON.stringify(migrated!.intent_log)}::text::jsonb,
            transcript_snapshot = ${JSON.stringify(migrated!.transcript_snapshot)}::text::jsonb
          WHERE id = ${targetId}
        `;
      }
      await expect(repo.getById({ accountId: accountA, id: sameAccountId })).rejects.toThrow();
      await expect(repo.getById({ accountId: accountB, id: crossAccountId })).rejects.toThrow();
    });

    it('prevalidates the complete bounded page before writing any recipe', async () => {
      if (!client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleRecipesRepo(
        { client, db, close: async () => {} },
        { payloadEncryptionKeyBase64: KEY },
      );
      const accountId = randomUUID();
      const validId = 'rec_00000000-0000-4000-8000-000000000001';
      const invalidId = 'rec_00000000-0000-4000-8000-000000000002';
      await insertRecipe({
        id: validId,
        accountId,
        intent: legacyIntent(),
        snapshot: legacyTranscript(),
      });
      await insertRecipe({
        id: invalidId,
        accountId,
        intent: legacyIntent(WRONG_KEY),
        snapshot: legacyTranscript(WRONG_KEY),
      });

      await expect(repo.migratePayloadEnvelopes(500)).rejects.toThrow();
      const rows = await client<Array<{ intent_log: { version?: number } }>>`
        SELECT intent_log FROM recipes ORDER BY id
      `;
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.intent_log.version === 1)).toBe(true);
    });

    it('loses exact five-field CAS safely to a concurrent v2 successor', async () => {
      if (!client) return;
      const accountId = randomUUID();
      const id = recipeId();
      const updatedAt = new Date('2026-07-14T21:44:00.000Z');
      await insertRecipe({
        id,
        accountId,
        intent: intentLog,
        snapshot: transcript,
        updatedAt,
      });
      const context = { accountId, recipeId: id };
      const successorIntent = encryptRecipeIntentLog(
        [{ kind: 'navigate', url: 'https://successor.test/' }],
        KEY,
        context,
      );
      const successorTranscript = encryptRecipeTranscriptSnapshot(
        [{ at: '2026-07-14T21:45:00.000Z', role: 'agent', body: 'successor' }],
        KEY,
        context,
      );

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
      const migratorRepo = new DrizzleRecipesRepo(
        { client: migratorClient, db: migratorDb, close: async () => {} },
        { payloadEncryptionKeyBase64: KEY },
      );
      let migration: Promise<{ scanned: number; converted: number; remaining: number }> | null =
        null;
      let blocked = false;
      try {
        await blocker`BEGIN`;
        await blocker`SELECT id FROM recipes WHERE id = ${id} FOR UPDATE`;
        migration = migratorRepo.migratePayloadEnvelopes(500);
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
          UPDATE recipes SET
            intent_log = ${blocker.json({
              kind: successorIntent.kind,
              version: successorIntent.version,
              ciphertext: successorIntent.ciphertext,
            })},
            transcript_snapshot = ${blocker.json({
              kind: successorTranscript.kind,
              version: successorTranscript.version,
              ciphertext: successorTranscript.ciphertext,
            })}
          WHERE id = ${id}
        `;
        await blocker`COMMIT`;

        const result = await migration;
        expect(blocked).toBe(true);
        const [after] = await client<
          Array<{ intent_log: unknown; transcript_snapshot: unknown; updated_at: Date }>
        >`
          SELECT intent_log, transcript_snapshot, updated_at FROM recipes WHERE id = ${id}
        `;
        expect(after?.intent_log).toEqual(successorIntent);
        expect(after?.transcript_snapshot).toEqual(successorTranscript);
        expect(new Date(String(after!.updated_at)).toISOString()).toBe(updatedAt.toISOString());
        const [classification] = await client<Array<{ is_v2: boolean }>>`
          SELECT (
            intent_log->>'kind' = 'driftstack.recipe-intent-log'
            AND intent_log->>'version' = '2'
            AND transcript_snapshot->>'kind' = 'driftstack.recipe-transcript-snapshot'
            AND transcript_snapshot->>'version' = '2'
          ) AS is_v2
          FROM recipes WHERE id = ${id}
        `;
        expect(classification?.is_v2).toBe(true);
        expect(result).toEqual({ scanned: 1, converted: 0, remaining: 0 });
      } finally {
        await blocker`ROLLBACK`.catch(() => {});
        await migratorClient.end({ timeout: 5 });
        await blocker.end({ timeout: 5 });
      }
    });
  },
);
