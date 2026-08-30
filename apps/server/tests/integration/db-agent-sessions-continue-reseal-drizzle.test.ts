// V-2167 — the continued chat's transcript is RE-SEALED under the new session
// id, proven against the REAL DrizzleAgentSessionsRepo on a real Postgres.
//
// The route-level arm with this title runs on the in-memory repo, which stores
// plain entry arrays and never encrypts anything — so it could not tell
// re-encryption from a ciphertext copy, and the property it claims lived only
// in a comment. These arms hold the actual envelope: the stored column is AES-
// GCM with AAD binding {accountId, sessionId}, so a seeded create must decrypt
// under the NEW id (arm 2), and a byte-copied ciphertext must NOT (arm 3 — the
// control that proves arm 2 could fail).
//
// Isolated database + schema: same discipline as the concurrency twin file.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureIsolatedDatabase } from './_helpers/isolated-database.js';
import { DrizzleAgentSessionsRepo } from '../../src/db/agent-sessions-repo.js';
import type * as schema from '../../src/db/schema.js';
import type { TranscriptEntry } from '../../src/services/agent-decomposer.js';

const ISOLATED_DB_NAME = 'driftstack_iso_agent_reseal';
let DB_URL = '';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const TRANSCRIPT_KEY = Buffer.alloc(32, 23).toString('base64');
const TEST_SCHEMA = `agent_sessions_reseal_${randomUUID().replaceAll('-', '')}`;

let dbReachable = false;
let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;

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
  await admin.unsafe(
    `CREATE TABLE "${TEST_SCHEMA}".agent_sessions (LIKE public.agent_sessions INCLUDING ALL)`,
  );
  client = postgres(DB_URL, {
    max: 2,
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

function buildRepo(c: NonNullable<typeof client>): DrizzleAgentSessionsRepo {
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return new DrizzleAgentSessionsRepo(
    { client: c, db, close: async () => {} },
    { transcriptEncryptionKeyBase64: TRANSCRIPT_KEY },
  );
}

const ENTRY: TranscriptEntry = {
  at: '2026-08-30T12:00:00.000Z',
  role: 'user',
  body: 'book me a flight to Lisbon',
};

describe.skipIf(!RUN_DB_TESTS)(
  'continue-from re-seals the transcript under the NEW id (Drizzle path, real Postgres)',
  () => {
    it('CRITICAL the dependency was reachable, so a green here is not "no service"', () => {
      expect(dbReachable, 'the integration dependency was unreachable').toBeTruthy();
    });

    it('⛔ a seeded createIfUnderActiveCap decrypts under the new id — the production continue path', async () => {
      if (!dbReachable || !client) return;
      const repo = buildRepo(client);
      const accountId = randomUUID();
      const source = await repo.createIfUnderActiveCap(
        { accountId, tokenBudgetTotal: 50_000, seedTranscript: [ENTRY] },
        5,
      );
      expect(source).not.toBeNull();
      const continued = await repo.createIfUnderActiveCap(
        { accountId, tokenBudgetTotal: 50_000, seedTranscript: source!.transcript },
        5,
      );
      expect(continued).not.toBeNull();
      expect(continued!.id).not.toBe(source!.id);
      // Reading back through the repo authenticates the envelope under
      // {accountId, sessionId: continued.id} — this only succeeds if the seed
      // was re-encrypted, never if ciphertext was carried across.
      const readBack = await repo.get(continued!.id);
      expect(readBack?.transcript).toEqual([ENTRY]);
    });

    it('⛔ CONTROL: a byte-copied ciphertext does NOT decrypt — the arm above can fail', async () => {
      if (!dbReachable || !client) return;
      const repo = buildRepo(client);
      const accountId = randomUUID();
      const source = await repo.createIfUnderActiveCap(
        { accountId, tokenBudgetTotal: 50_000, seedTranscript: [ENTRY] },
        5,
      );
      const target = await repo.createIfUnderActiveCap({ accountId, tokenBudgetTotal: 50_000 }, 5);
      expect(source).not.toBeNull();
      expect(target).not.toBeNull();
      // The defect this file guards against, committed deliberately: carry the
      // SOURCE's sealed column into the TARGET row byte-for-byte.
      await client`
        UPDATE agent_sessions
        SET transcript = (SELECT transcript FROM agent_sessions WHERE id = ${source!.id})
        WHERE id = ${target!.id}
      `;
      // AAD binds {accountId, sessionId}: the copy authenticates for nobody.
      // Without this control, the arm above would also pass in a world where
      // the envelope ignored the session id entirely.
      await expect(repo.get(target!.id)).rejects.toThrow();
    });

    it('plain create() honors the seed too — the in-memory twin already did', async () => {
      if (!dbReachable || !client) return;
      const repo = buildRepo(client);
      const accountId = randomUUID();
      // Before V-2167 this encrypted [] and silently dropped the seed: a caller
      // reaching create() directly got an empty continued chat while the same
      // code against the in-memory twin kept the history — the double was more
      // faithful than the artifact.
      const created = await repo.create({
        accountId,
        tokenBudgetTotal: 50_000,
        seedTranscript: [ENTRY],
      });
      const readBack = await repo.get(created.id);
      expect(readBack?.transcript).toEqual([ENTRY]);
    });
  },
);
