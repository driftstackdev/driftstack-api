// Real-Postgres proof for the saved-recipe encryption boundary. The public
// repository contract returns plaintext to the owning account, while both JSONB
// columns must contain only authenticated ciphertext envelopes. Also proves the
// bounded legacy-array converter against actual jsonb equality/CAS semantics.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleRecipesRepo } from '../../src/db/recipes-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const KEY = Buffer.alloc(32, 51).toString('base64');
const WRONG_KEY = Buffer.alloc(32, 52).toString('base64');

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
const seededAccounts: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 2 });
  try {
    await client`SELECT 1 FROM recipes LIMIT 0`;
    dbReachable = true;
  } catch {
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client !== null) {
    for (const accountId of seededAccounts) {
      await client`DELETE FROM recipes WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

async function seedAccount(c: ReturnType<typeof postgres>): Promise<string> {
  const accountId = randomUUID();
  seededAccounts.push(accountId);
  await c`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`recipe-encryption-${accountId}@test.local`})`;
  return accountId;
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'saved recipe payload encryption (Drizzle path against real Postgres)',
  () => {
    it('writes ciphertext only, owner reads round-trip, wrong/missing keys fail closed', async () => {
      if (!dbReachable || client === null) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const database = { client, db, close: async () => {} };
      const repo = new DrizzleRecipesRepo(database, { payloadEncryptionKeyBase64: KEY });
      const accountId = await seedAccount(client);
      const intentSecret = 'card-4111111111111111';
      const transcriptSecret = 'customer said otp 493827';
      const created = await repo.create({
        accountId,
        agentSessionId: null,
        label: 'Encrypted login',
        intentLog: [
          {
            kind: 'interact',
            action: 'type',
            selector: '#card-number',
            value: intentSecret,
            sensitive: true,
          },
        ],
        transcriptSnapshot: [
          { at: '2026-07-13T00:00:00.000Z', role: 'user', body: transcriptSecret },
        ],
      });
      expect(created.intentLog[0]).toMatchObject({ value: intentSecret, sensitive: true });
      expect(created.transcriptSnapshot[0]?.body).toBe(transcriptSecret);

      const [stored] = await client<
        Array<{ intent_log: unknown; transcript_snapshot: unknown }>
      >`SELECT intent_log, transcript_snapshot FROM recipes WHERE id = ${created.id}`;
      expect(stored?.intent_log).toMatchObject({
        kind: 'driftstack.recipe-intent-log',
        version: 1,
      });
      expect(stored?.transcript_snapshot).toMatchObject({
        kind: 'driftstack.agent-transcript',
        version: 1,
      });
      expect(JSON.stringify(stored)).not.toMatch(/4111111111111111|493827/);

      expect((await repo.getById({ accountId, id: created.id }))?.intentLog).toEqual(
        created.intentLog,
      );
      const wrongKeyRepo = new DrizzleRecipesRepo(database, {
        payloadEncryptionKeyBase64: WRONG_KEY,
      });
      await expect(wrongKeyRepo.getById({ accountId, id: created.id })).rejects.toThrow();
      const missingKeyRepo = new DrizzleRecipesRepo(database);
      await expect(
        missingKeyRepo.create({
          accountId,
          agentSessionId: null,
          label: 'must fail',
          intentLog: [],
          transcriptSnapshot: [],
        }),
      ).rejects.toThrow('Recipe payload encryption key is unavailable.');
    });

    it('converts legacy plaintext JSONB with CAS and preserves owner-visible values', async () => {
      if (!dbReachable || client === null) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleRecipesRepo(
        { client, db, close: async () => {} },
        { payloadEncryptionKeyBase64: KEY },
      );
      const accountId = await seedAccount(client);
      const recipeId = `rec_${randomUUID()}`;
      const legacyIntentSecret = 'legacy-password-secret';
      const legacyTranscriptSecret = 'legacy transcript secret';
      const intentLog = [
        {
          kind: 'interact',
          action: 'type',
          selector: '#password',
          value: legacyIntentSecret,
          sensitive: true,
        },
      ];
      const transcript = [
        { at: '2026-07-13T00:00:00.000Z', role: 'user', body: legacyTranscriptSecret },
      ];
      await client`
        INSERT INTO recipes
          (id, account_id, agent_session_id, label, intent_log, transcript_snapshot)
        VALUES
          (${recipeId}, ${accountId}, NULL, 'Legacy plaintext', ${JSON.stringify(intentLog)}::jsonb, ${JSON.stringify(transcript)}::jsonb)
      `;

      const upgraded = await repo.encryptLegacyPayloads(500);
      expect(upgraded.converted).toBeGreaterThanOrEqual(1);
      const [stored] = await client<
        Array<{ intent_log: unknown; transcript_snapshot: unknown }>
      >`SELECT intent_log, transcript_snapshot FROM recipes WHERE id = ${recipeId}`;
      expect(JSON.stringify(stored)).not.toMatch(/legacy-password-secret|legacy transcript secret/);
      expect(stored?.intent_log).toMatchObject({ kind: 'driftstack.recipe-intent-log' });
      expect(stored?.transcript_snapshot).toMatchObject({ kind: 'driftstack.agent-transcript' });

      const read = await repo.getById({ accountId, id: recipeId });
      expect(read?.intentLog[0]).toMatchObject({ value: legacyIntentSecret, sensitive: true });
      expect(read?.transcriptSnapshot[0]?.body).toBe(legacyTranscriptSecret);
    });
  },
);
