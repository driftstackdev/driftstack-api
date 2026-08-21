// V-1217 — one contract for `totalsForPeriod`, executed against BOTH implementations of `UsageRepo`.
//
// The ninth of the twenty-nine, and it found a real divergence on a metered path.
//
//   DrizzleUsageRepo   ne(recordType, 'session_minute'), ne(…, 'agent_decomposer'),
//                      ne(…, 'agent_decomposer_bundled')   -- excluded from the SUM
//   InMemoryUsageRepo  totals[e.recordType] += e.quantity  -- every stored row, no exclusions
//
// Two different reasons for the same exclusion, and only one of them is cosmetic:
//
//   * `session_minute` is LIFECYCLE-DERIVED. Production computes it from real session lifetimes in
//     the `sessions` table and never sums stored `session_minute` rows. A double that sums them
//     reports minutes production would not — on the figure a customer's metered usage is read from.
//   * `agent_decomposer` and `agent_decomposer_bundled` are internal accounting, excluded outright
//     with nothing added back, so a double counting them inflates the total with rows the customer
//     is not supposed to see at all.
//
// LIMITATION, stated rather than hidden. The double has no sessions to derive minutes FROM, so it
// omits `session_minute` where production reports a derived figure. Excluding the stored rows makes
// the two agree about what must NOT be summed; it does not make the double a source of lifecycle
// minutes. The arm below therefore asserts the stored quantity is not counted — which both
// implementations can satisfy honestly — rather than asserting a derived value the double cannot
// produce. A test that needs real minutes has to use the real repo.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import type { UsageRepo } from '../../src/services/usage.js';
import { DrizzleUsageRepo } from '../../src/db/usage-repo.js';
import { InMemoryUsageRepo } from './_helpers/in-memory-usage-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

const PERIOD_START = new Date('2026-08-01T00:00:00.000Z');
const PERIOD_END = new Date('2026-09-01T00:00:00.000Z');
const INSIDE = new Date('2026-08-15T12:00:00.000Z');

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM usage_records LIMIT 0`;
    dbReachable = true;
  } catch {
    /* the Drizzle half skips; the in-memory half still runs */
  }
  await probe.end({ timeout: 1 }).catch(() => {});
  if (dbReachable) client = postgres(DB_URL, { max: 2 });
});

afterAll(async () => {
  if (client) {
    for (const a of seeded) {
      await client`DELETE FROM usage_records WHERE account_id = ${a}::uuid`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${a}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

interface Subject {
  repo: UsageRepo;
  account: () => Promise<string>;
  usage: (accountId: string, recordType: string, quantity: number, at: Date) => Promise<void>;
}

function inMemorySubject(): Subject {
  const repo = new InMemoryUsageRepo();
  return {
    repo,
    account: () => Promise.resolve(randomUUID()),
    usage: (accountId, recordType, quantity, at) => {
      repo.record({
        accountId,
        recordType,
        quantity,
        recordedAt: at,
      } as Parameters<InMemoryUsageRepo['record']>[0]);
      return Promise.resolve();
    },
  };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return {
    repo: new DrizzleUsageRepo({ client: c, db, close: async () => {} }),
    account: async () => {
      const id = randomUUID();
      seeded.push(id);
      await c`INSERT INTO accounts (id, email) VALUES (${id}, ${`usage-contract-${id}@test.local`})`;
      return id;
    },
    usage: async (accountId, recordType, quantity, at) => {
      await c`INSERT INTO usage_records (account_id, record_type, quantity, recorded_at)
              VALUES (${accountId}::uuid, ${recordType}, ${quantity}, ${at.toISOString()}::timestamptz)`;
    },
  };
}

const totals = async (s: Subject, accountId: string) =>
  (await s.repo.totalsForPeriod(accountId, PERIOD_START, PERIOD_END)).totals as Record<
    string,
    number | undefined
  >;

function usageRepoContract(label: string, make: () => Subject, enabled: () => boolean): void {
  describe(`UsageRepo contract — ${label}`, () => {
    it('CRITICAL a stored session_minute row is never summed into the total, in both. session_minute is derived from real session lifetimes in production and stored rows are excluded from the SUM, so a double that added them reports metered minutes the customer was never charged for.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      await s.usage(account, 'session_minute', 999, INSIDE);

      const t = await totals(s, account);
      expect(
        t['session_minute'] ?? 0,
        'the stored session_minute quantity was summed into the total',
      ).toBe(0);
    });

    it('CRITICAL the internal agent_decomposer record types are excluded outright, in both. They are internal accounting with nothing added back, so counting them inflates a customer-visible total with rows they are not supposed to see.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      await s.usage(account, 'agent_decomposer', 7, INSIDE);
      await s.usage(account, 'agent_decomposer_bundled', 11, INSIDE);

      const t = await totals(s, account);
      expect(t['agent_decomposer'] ?? 0, 'an internal record type was counted').toBe(0);
      expect(t['agent_decomposer_bundled'] ?? 0, 'an internal record type was counted').toBe(0);
    });

    it('CRITICAL a customer-facing record type IS counted, in both. Without this the exclusions above are satisfied by an implementation that counts nothing at all.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      await s.usage(account, 'navigate', 3, INSIDE);
      await s.usage(account, 'navigate', 4, INSIDE);

      expect((await totals(s, account))['navigate'], 'real usage was not counted').toBe(7);
    });

    it("CRITICAL totals are account-scoped, in both. This figure is what a customer is billed against, so another account's usage appearing in it is a billing error and a disclosure at once.", async () => {
      if (!enabled()) return;
      const s = make();
      const owner = await s.account();
      const stranger = await s.account();
      await s.usage(stranger, 'navigate', 5, INSIDE);

      expect((await totals(s, owner))['navigate'] ?? 0, "another account's usage was counted").toBe(
        0,
      );
    });

    it('CRITICAL the period is half-open — start inclusive, end exclusive — in both. An inclusive end double-counts the boundary row in two consecutive billing periods.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      await s.usage(account, 'navigate', 2, PERIOD_START);
      await s.usage(account, 'navigate', 100, PERIOD_END);

      expect((await totals(s, account))['navigate'], 'the period bounds are not [start, end)').toBe(
        2,
      );
    });
  });
}

usageRepoContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)('UsageRepo contract — real', () => {
  it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
    if (!process.env.CI && !dbReachable) return;
    expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
      true,
    );
  });

  usageRepoContract('drizzle', drizzleSubject, () => dbReachable);
});
