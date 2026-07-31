// The other half of the retry-idempotency fix, against a real database.
//
// `agent-runtime-usage-record-retry-idempotency` proves the runtime reuses ONE
// row id across retry attempts. That is necessary and not sufficient: it says
// nothing about whether a second insert carrying that id is actually refused.
// This proves the refusal, because the two halves fail independently — a stable
// id with a plain insert still writes two rows, and a conflict-safe insert with
// a fresh id per attempt does too.
//
// The scenario being closed is a write that throws AFTER the server committed
// (connection reset post-commit, client timeout on a statement that landed).
// The retry then re-sends a row that is already there. Simulated directly: call
// `record` twice with the same id, which is exactly what the retry loop does.
//
// The first test asserts the database was actually reached. That is not
// ceremony — the first draft of this file silently failed to connect, so all of
// its assertions returned early and it passed while proving nothing, and the
// mutation that removes the conflict guard did not turn it red. A DB-guarded
// suite without that assertion cannot tell "green" from "never ran".

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import { DrizzleAgentDecomposerUsageRecorder } from '../../src/db/agent-decomposer-usage-recorder.js';
import type { Database } from '../../src/db/client.js';
import type { Logger } from 'pino';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
const seededAccounts: string[] = [];

const silentLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM usage_records LIMIT 0`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 4 });
});

afterAll(async () => {
  if (client) {
    for (const accountId of seededAccounts) {
      await client`DELETE FROM usage_records WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

async function seedAccount(): Promise<string> {
  if (!client) throw new Error('no client');
  const accountId = randomUUID();
  seededAccounts.push(accountId);
  await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`usage-idem-${accountId}@test.local`})`;
  return accountId;
}

function recorderOf(): DrizzleAgentDecomposerUsageRecorder {
  if (!client) throw new Error('no client');
  const db = drizzle(client) as unknown as Database['db'];
  return new DrizzleAgentDecomposerUsageRecorder(
    { client, db, close: async () => {} },
    silentLogger,
  );
}

function recordArgs(
  accountId: string,
  recordId: string,
  tokensConsumed = 100,
): Parameters<DrizzleAgentDecomposerUsageRecorder['record']>[0] {
  return {
    accountId,
    recordId,
    driftstackSessionId: null,
    agentSessionId: 'aas_idem_test',
    decomposeResultKind: 'plan',
    usage: { decomposerKind: 'claude', costUsdCents: 10 },
    tokensConsumed,
    now: new Date(),
    keySource: 'bundled',
  };
}

async function rowCount(accountId: string): Promise<number> {
  const rows = await client!<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM usage_records WHERE account_id = ${accountId}::uuid`;
  return rows[0]?.n ?? 0;
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'a usage row re-sent with the same id does not charge the customer twice',
  () => {
    it('CRITICAL the database was actually reached. Every assertion below is DB-backed, so without this a connection failure would return early from all of them and the file would report green while proving nothing — which is exactly what the first draft did.', () => {
      expect(dbReachable, `could not reach ${DB_URL} — these results would be meaningless`).toBe(
        true,
      );
    });

    it('CRITICAL the SAME record id twice writes exactly ONE row. This is the committed-then-threw retry: the row already landed, the retry re-sends it, and a second flat $0.10 would consume the monthly cap at 2x and hard-402 the customer after fewer turns than they were sold.', async () => {
      const accountId = await seedAccount();
      const recorder = recorderOf();
      const id = randomUUID();

      await recorder.record(recordArgs(accountId, id));
      await recorder.record(recordArgs(accountId, id));

      expect(await rowCount(accountId), 'two sends of one row id must leave one row').toBe(1);
    });

    it('CRITICAL two DIFFERENT ids write TWO rows. Without this the check above is satisfied by a recorder that silently drops every write — undercounting the cap, which is the opposite failure and equally wrong.', async () => {
      const accountId = await seedAccount();
      const recorder = recorderOf();

      await recorder.record(recordArgs(accountId, randomUUID()));
      await recorder.record(recordArgs(accountId, randomUUID()));

      expect(await rowCount(accountId), 'genuinely distinct rows are both persisted').toBe(2);
    });

    it('CRITICAL the FIRST charge survives — a retry must not overwrite the row that already landed with different content.', async () => {
      const accountId = await seedAccount();
      const recorder = recorderOf();
      const id = randomUUID();

      await recorder.record(recordArgs(accountId, id, 100));
      await recorder.record(recordArgs(accountId, id, 999_999));

      const rows = await client!<Array<{ metadata: Record<string, unknown> }>>`
        SELECT metadata FROM usage_records WHERE id = ${id}::uuid`;
      expect(rows.length, 'exactly one row under that id').toBe(1);
      expect(
        rows[0]?.metadata.tokens_consumed,
        'the original charge survives; the retry did not rewrite it',
      ).toBe(100);
    });
  },
);
