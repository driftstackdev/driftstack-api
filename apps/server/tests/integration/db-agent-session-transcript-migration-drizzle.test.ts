// Real-Postgres proof for the live agent-session transcript v2 cutover. The
// repository must authenticate legacy ciphertext before rewriting plaintext,
// preserve exact owner-visible history, bind envelopes to row identity, and
// compare-and-set so a concurrent newer transcript is never clobbered.

import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureIsolatedDatabase } from './_helpers/isolated-database.js';
import { DrizzleAgentSessionsRepo } from '../../src/db/agent-sessions-repo.js';
import type * as schema from '../../src/db/schema.js';
import type { TranscriptEntry } from '../../src/services/agent-decomposer.js';
import { encryptAgentSessionTranscript } from '../../src/services/agent-session-transcript-encryption.js';
import { encryptAgentTranscript } from '../../src/services/agent-transcript-encryption.js';

// Runs against its OWN database: this file calls a GLOBAL envelope migration,
// which scans its whole table and therefore depends on rows owned by whatever
// else is running. See _helpers/isolated-database.ts for why fixture discipline
// cannot close that and isolation can.
const ISOLATED_DB_NAME = 'driftstack_iso_agent_transcript';
let DB_URL = '';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const KEY = Buffer.alloc(32, 71).toString('base64');
const TEST_SCHEMA = `agent_transcript_migration_${randomUUID().replaceAll('-', '')}`;

let dbReachable = false;
let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;
const seededAccounts: string[] = [];

function makeRepo(encryptionKeyBase64: string | null = KEY): DrizzleAgentSessionsRepo {
  if (!client) throw new Error('Postgres test client is unavailable');
  const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return new DrizzleAgentSessionsRepo(
    { client, db, close: async () => {} },
    encryptionKeyBase64 === null ? {} : { transcriptEncryptionKeyBase64: encryptionKeyBase64 },
  );
}

async function seedAccount(label: string): Promise<string> {
  if (!client) throw new Error('Postgres test client is unavailable');
  const accountId = randomUUID();
  seededAccounts.push(accountId);
  await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`agt-v2-${label}-${accountId}@test.local`})`;
  return accountId;
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
  await admin.unsafe(`CREATE TABLE "${TEST_SCHEMA}".accounts (LIKE public.accounts INCLUDING ALL)`);
  await admin.unsafe(
    `CREATE TABLE "${TEST_SCHEMA}".agent_sessions (LIKE public.agent_sessions INCLUDING ALL)`,
  );
  client = postgres(DB_URL, {
    max: 6,
    connection: { options: `-c search_path=${TEST_SCHEMA}` },
  });
  const [current] = await client<Array<{ value: string }>>`SELECT current_schema() AS value`;
  expect(current?.value).toBe(TEST_SCHEMA);
  dbReachable = true;
});

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
  if (admin) {
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
    await admin.end({ timeout: 5 });
  }
});

afterEach(async () => {
  if (!client) return;
  while (seededAccounts.length > 0) {
    const accountId = seededAccounts.pop();
    if (accountId === undefined) continue;
    await client`DELETE FROM agent_sessions WHERE account_id = ${accountId}`.catch(() => {});
    await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
  }
});

describe.skipIf(!RUN_DB_TESTS)(
  'agent-session transcript v2 migration (Drizzle path, real Postgres)',
  () => {
    it('preflights v1 before writes, migrates arrays/v1, and binds exact row context', async () => {
      if (!dbReachable || !client) return;
      const accountId = await seedAccount('preserve');
      const repo = makeRepo();
      const plaintextRow = await repo.create({ accountId, tokenBudgetTotal: 100 });
      const v1Row = await repo.create({ accountId, tokenBudgetTotal: 100 });
      const v2Row = await repo.create({ accountId, tokenBudgetTotal: 100 });
      const plaintext: ReadonlyArray<TranscriptEntry> = [
        { at: 't0', role: 'user', body: 'plaintext-owner-value' },
      ];
      const v1Transcript: ReadonlyArray<TranscriptEntry> = [
        { at: 't1', role: 'agent', body: 'v1-owner-value' },
      ];
      await client`
        UPDATE agent_sessions
        SET transcript = ${JSON.stringify(plaintext)}::jsonb
        WHERE id = ${plaintextRow.id}
      `;
      await client`
        UPDATE agent_sessions
        SET transcript = ${JSON.stringify(encryptAgentTranscript(v1Transcript, KEY))}::jsonb
        WHERE id = ${v1Row.id}
      `;
      const beforeTimestamps = await client`
        SELECT id, updated_at FROM agent_sessions WHERE account_id = ${accountId}
      `;
      await expect(repo.get(plaintextRow.id)).rejects.toThrow(/not a v2/i);
      await expect(repo.get(v1Row.id)).rejects.toThrow(/not a v2/i);

      // A wrong configured key must authenticate the v1 probe and fail before
      // the plaintext row can be rewritten under that incorrect key.
      await expect(
        makeRepo(randomBytes(32).toString('base64')).migrateTranscriptEnvelopes(500),
      ).rejects.toThrow();
      const [stillPlaintext] =
        await client`SELECT transcript FROM agent_sessions WHERE id = ${plaintextRow.id}`;
      expect(stillPlaintext?.transcript).toEqual(plaintext);

      const migrated = await repo.migrateTranscriptEnvelopes(500);
      expect(migrated).toMatchObject({ scanned: 2, converted: 2, remaining: 0 });
      expect((await repo.get(plaintextRow.id))?.transcript).toEqual(plaintext);
      expect((await repo.get(v1Row.id))?.transcript).toEqual(v1Transcript);

      const stored = await client`
        SELECT id, transcript->>'kind' AS kind, transcript->>'version' AS version, updated_at
        FROM agent_sessions
        WHERE account_id = ${accountId}
      `;
      expect(stored).toHaveLength(3);
      expect(stored).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: plaintextRow.id,
            kind: 'driftstack.agent-session-transcript',
            version: '2',
          }),
          expect.objectContaining({
            id: v1Row.id,
            kind: 'driftstack.agent-session-transcript',
            version: '2',
          }),
          expect.objectContaining({
            id: v2Row.id,
            kind: 'driftstack.agent-session-transcript',
            version: '2',
          }),
        ]),
      );
      expect(
        stored
          .map((row) => ({ id: String(row.id), updated_at: String(row.updated_at) }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      ).toEqual(
        beforeTimestamps
          .map((row) => ({ id: String(row.id), updated_at: String(row.updated_at) }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      );

      // Structurally valid ciphertext from a sibling row cannot authenticate
      // under this destination row's immutable session identity.
      const [source] = await client`SELECT transcript FROM agent_sessions WHERE id = ${v1Row.id}`;
      await client`
        UPDATE agent_sessions SET transcript = ${JSON.stringify(source?.transcript)}::jsonb
        WHERE id = ${plaintextRow.id}
      `;
      await expect(repo.get(plaintextRow.id)).rejects.toThrow();
    });

    it('refuses missing-key creates before inserting and malformed storage before conversion', async () => {
      if (!dbReachable || !client) return;
      const accountId = await seedAccount('fail-closed');
      const noKeyRepo = makeRepo(null);
      await expect(noKeyRepo.create({ accountId, tokenBudgetTotal: 100 })).rejects.toThrow(
        /key is unavailable/i,
      );
      await expect(
        noKeyRepo.createIfUnderActiveCap({ accountId, tokenBudgetTotal: 100 }, 5),
      ).rejects.toThrow(/key is unavailable/i);
      const [before] =
        await client`SELECT count(*)::int AS count FROM agent_sessions WHERE account_id = ${accountId}`;
      expect(before?.count).toBe(0);

      const repo = makeRepo();
      await expect(repo.migrateTranscriptEnvelopes(0)).rejects.toThrow(/integer from 1 to 500/i);
      await expect(repo.migrateTranscriptEnvelopes(501)).rejects.toThrow(/integer from 1 to 500/i);
      await expect(noKeyRepo.migrateTranscriptEnvelopes(1)).rejects.toThrow(/key is unavailable/i);
      const malformed = await repo.create({ accountId, tokenBudgetTotal: 100 });
      const plaintext = await repo.create({ accountId, tokenBudgetTotal: 100 });
      const legacy = [{ at: 't0', role: 'user', body: 'must-remain-plaintext-on-preflight-fail' }];
      await client`
        UPDATE agent_sessions SET transcript = ${JSON.stringify({ kind: 'unknown', version: 9 })}::jsonb
        WHERE id = ${malformed.id}
      `;
      await client`
        UPDATE agent_sessions SET transcript = ${JSON.stringify(legacy)}::jsonb
        WHERE id = ${plaintext.id}
      `;
      await expect(repo.migrateTranscriptEnvelopes(500)).rejects.toThrow(/malformed envelope/i);
      const [stillPlaintext] =
        await client`SELECT transcript FROM agent_sessions WHERE id = ${plaintext.id}`;
      expect(stillPlaintext?.transcript).toEqual(legacy);
    });

    it('does not clobber a newer transcript when the exact-json CAS loses', async () => {
      if (!dbReachable || !client) return;
      const accountId = await seedAccount('cas');
      const repo = makeRepo();
      const session = await repo.create({ accountId, tokenBudgetTotal: 100 });
      const legacy = [{ at: 'old', role: 'user', body: 'selected-before-lock' }];
      await client`
        UPDATE agent_sessions
        SET transcript = ${JSON.stringify(legacy)}::jsonb, created_at = '1970-01-01T00:00:00Z'
        WHERE id = ${session.id}
      `;

      const blocker = await client.reserve();
      let migration: Promise<{ scanned: number; converted: number; remaining: number }> | undefined;
      let transactionOpen = false;
      try {
        await blocker`BEGIN`;
        transactionOpen = true;
        await blocker`SELECT id FROM agent_sessions WHERE id = ${session.id} FOR UPDATE`;
        let settled = false;
        migration = repo.migrateTranscriptEnvelopes(1).finally(() => {
          settled = true;
        });
        void migration.catch(() => {});

        let waitingOnLock = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const [waiting] = await client`
            SELECT count(*)::int AS count
            FROM pg_stat_activity
            WHERE wait_event_type = 'Lock'
              AND query ILIKE '%update "agent_sessions"%'
          `;
          if ((waiting?.count ?? 0) > 0) {
            waitingOnLock = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }

        const newer: ReadonlyArray<TranscriptEntry> = [
          { at: 'new', role: 'agent', body: 'concurrent-newer-value' },
        ];
        const newerEnvelope = encryptAgentSessionTranscript(newer, KEY, {
          accountId,
          sessionId: session.id,
        });
        await blocker`
          UPDATE agent_sessions
          SET transcript = ${JSON.stringify(newerEnvelope)}::jsonb
          WHERE id = ${session.id}
        `;
        await blocker`COMMIT`;
        transactionOpen = false;

        const migrationResult = await migration;
        expect(waitingOnLock).toBe(true);
        expect(settled).toBe(true);
        expect(migrationResult).toMatchObject({
          scanned: 1,
          converted: 0,
          remaining: 0,
        });
        expect((await repo.get(session.id))?.transcript).toEqual(newer);
      } finally {
        if (transactionOpen) await blocker`ROLLBACK`.catch(() => {});
        await migration?.catch(() => {});
        blocker.release();
      }
    });
  },
);
