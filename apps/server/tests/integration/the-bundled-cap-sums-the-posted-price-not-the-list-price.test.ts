// The bundled monthly soft cap sums the POSTED flat price, and only that —
// against a real database, through the real recorder and the real repo.
//
// Every bundled usage row now carries two costs: `cost_usd_cents` (the flat
// price per turn the customer was sold, which the cap is denominated in) and
// `list_price_cost_millicents` (what the call really cost). A cap query that
// summed the second — or both — would change what every existing cap means
// without anyone deciding it: an expensive turn would consume a customer's
// budget many times faster than the "$0.10 per turn" they were promised. The
// unit test beside this one proves the recorder writes both fields; only a real
// database can prove which one the cap's SQL actually adds up.
//
// Account-scoped throughout (every assertion reads one freshly seeded account),
// so the shared test database is safe here.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Logger } from 'pino';

import {
  DrizzleAgentDecomposerUsageRecorder,
  LIST_PRICE_COST_FIELD,
} from '../../src/db/agent-decomposer-usage-recorder.js';
import { DrizzleBundledLlmRepo } from '../../src/db/bundled-llm-repo.js';
import type { Database } from '../../src/db/client.js';

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
  await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`cap-sum-${accountId}@test.local`})`;
  return accountId;
}

function database(): Database {
  if (!client) throw new Error('no client');
  const db = drizzle(client) as unknown as Database['db'];
  return { client, db, close: async () => {} };
}

/** A call big enough that its list price dwarfs the flat 10 cents. */
const EXPENSIVE_CALL = {
  decomposerKind: 'claude' as const,
  model: 'claude-sonnet-5',
  anthropicInputTokens: 50_000,
  anthropicOutputTokens: 20_000,
  anthropicCacheReadInputTokens: 0,
  anthropicCacheCreationInputTokens: 0,
  costUsdCents: 30,
};
// Sonnet 5: 50,000 × 0.2 + 20,000 × 1.0 = 30,000 millicents (30 cents).
const EXPENSIVE_CALL_MILLICENTS = 30_000;

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'the bundled soft cap sums what was posted, never what the call cost',
  () => {
    it('CRITICAL the database was actually reached — otherwise every assertion below returns early and the file is green while proving nothing.', () => {
      expect(dbReachable, `could not reach ${DB_URL}`).toBe(true);
    });

    it('CRITICAL a bundled turn whose calls really cost 60 cents counts exactly the flat 10 against the cap — and the 60 cents is on the rows for the ledger to read', async () => {
      const accountId = await seedAccount();
      const db = database();
      const recorder = new DrizzleAgentDecomposerUsageRecorder(db, silentLogger);
      const now = new Date();
      const turn = {
        accountId,
        driftstackSessionId: null,
        agentSessionId: 'aas_cap_sum_test',
        decomposeResultKind: 'plan' as const,
        usage: EXPENSIVE_CALL,
        tokensConsumed: 70_000,
        now,
        keySource: 'bundled' as const,
      };
      // Two calls, one turn: the plan and the read-back.
      await recorder.record({ ...turn, recordId: randomUUID() });
      await recorder.record({
        ...turn,
        recordId: randomUUID(),
        bundledFlatCostAlreadyPosted: true,
      });

      const spent = await new DrizzleBundledLlmRepo(db).sumMonthlySpendCents({ accountId, now });
      expect(spent, 'the cap is denominated in the flat price per turn').toBe(10);

      const stored = await client!<Array<{ list: string | null }>>`
        SELECT sum((metadata->>${LIST_PRICE_COST_FIELD})::numeric)::text AS list
        FROM usage_records WHERE account_id = ${accountId}::uuid`;
      expect(Number(stored[0]?.list), 'both calls carry their true cost').toBe(
        2 * EXPENSIVE_CALL_MILLICENTS,
      );
    });
  },
);
