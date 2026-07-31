// The retention purge predicate has an index that can serve it.
//
// Every arm of AccountDeletionPurgeSweeper — byok, proxy secrets, profiles and
// snapshots — opens with the same lookup: accounts whose status is `deleted`
// and whose deleted_at is older than the retention cutoff. Until migration
// 0109 nothing indexed either column, so each arm sequentially scanned the
// whole accounts table on every tick.
//
// The cost profile is the one that never gets caught. In steady state the
// query matches nothing, so the work is pure overhead that grows linearly with
// total signups to return zero rows — never slow enough to page, just quietly
// more expensive every week.
//
// Asks the PLANNER rather than reading schema.ts. A source-text pin on the
// index declaration proves a line exists in a TypeScript file; it says nothing
// about whether the index reached the database, and the migration could be
// absent from the journal, fail to apply, or build an index whose predicate
// does not actually cover the query. The planner is the only authority on
// "could this predicate use an index", so it is the thing asked.
//
// enable_seqscan is forced off, which is what makes this scale-independent.
// On a small table the planner rightly prefers a sequential scan and would
// report one no matter how good the index is; with seqscan priced at 1e10 it
// will use any index that CAN serve the predicate. Choosing not to is fine —
// having no option is the defect. That distinction is exactly what this
// measured before the fix: at 1e10 the planner still scanned sequentially,
// proving no usable index existed rather than merely that it preferred not to.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM accounts LIMIT 0`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 2 });
});

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
});

/**
 * The plan for `query`, with sequential scans priced out of contention.
 *
 * Runs inside a transaction and issues the SET as its own statement. Sending
 * `SET LOCAL …; EXPLAIN …` as one string instead returns an array of result
 * SETS rather than an array of rows, so the plan stringifies to
 * "[object Object]" and every substring assertion fails for a reason that has
 * nothing to do with the index. SET LOCAL also needs a transaction to scope
 * to; outside one it is a no-op, which would silently let the planner keep its
 * ordinary seqscan preference and make this whole file untrustworthy.
 */
async function planWithoutSeqScan(query: string): Promise<string> {
  if (!client) throw new Error('no client');
  return await client.begin(async (tx) => {
    await tx.unsafe('SET LOCAL enable_seqscan = off');
    const rows = (await tx.unsafe(`EXPLAIN ${query}`)) as unknown as Array<Record<string, string>>;
    return rows.map((r) => r['QUERY PLAN'] ?? '').join('\n');
  });
}

/** Exactly the lookup every purge arm performs. */
const PURGE_PREDICATE = `SELECT id FROM accounts WHERE status = 'deleted' AND deleted_at < now()`;

// Gated on DATABASE_URL exactly as the other db-* integration files are, so a
// checkout without Postgres skips the file wholesale rather than failing it.
// Deliberately NOT `it.runIf(dbReachable)`: vitest evaluates a runIf condition
// at COLLECTION time, before beforeAll has run, so dbReachable is still false
// and every case silently skips. The first draft of this file did that and
// reported "1 passed | 4 skipped" identically with the index present, dropped,
// and replaced by a wrong one — a guard that could not fail, which is worse
// than no guard because it reads as coverage.
describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'the retention purge predicate is index-supported',
  () => {
    it('CRITICAL the database is reachable. Every check here is a query; if the connection failed they would throw or skip and the file would report success while proving nothing about the index.', () => {
      expect(dbReachable, `could not reach ${DB_URL} — these results would be meaningless`).toBe(
        true,
      );
    });

    it('CRITICAL EXPLAIN itself works and the probe reaches the planner. A plan that came back empty would make the substring checks below vacuously pass, hiding a missing index behind a broken probe.', async () => {
      const plan = await planWithoutSeqScan(PURGE_PREDICATE);
      expect(plan.length, 'EXPLAIN returned a plan').toBeGreaterThan(20);
      expect(plan, 'the plan mentions the table under test').toMatch(/accounts/i);
    });

    it('CRITICAL an index can serve `status = deleted AND deleted_at < cutoff`. Without one every sweeper arm full-scans accounts on every tick, forever, to return no rows in the common case.', async () => {
      const plan = await planWithoutSeqScan(PURGE_PREDICATE);
      expect(
        plan,
        `no index can serve the retention purge predicate — every sweeper arm will sequentially scan accounts on every tick. Plan was:\n${plan}`,
      ).toMatch(/Index (Only )?Scan/);
    });

    it('CRITICAL the index chosen is the partial one built for this predicate. Satisfying the check above with an unrelated index — a full scan of accounts_pkey, say — reads as a pass while doing the same linear work the fix exists to remove.', async () => {
      const plan = await planWithoutSeqScan(PURGE_PREDICATE);
      expect(plan, `expected accounts_deleted_purge_idx to be used. Plan was:\n${plan}`).toContain(
        'accounts_deleted_purge_idx',
      );
    });

    it('CRITICAL the index is partial on status, so ordinary accounts are neither stored in it nor maintained on write. A non-partial index over every account would pass every check above while adding write cost to the signup path it has no business touching.', async () => {
      if (!client) throw new Error('no client');
      const rows = await client<Array<{ indexdef: string }>>`
        SELECT indexdef FROM pg_indexes
        WHERE tablename = 'accounts' AND indexname = 'accounts_deleted_purge_idx'`;
      expect(rows.length, 'the index exists in the live schema').toBe(1);
      expect(
        rows[0]!.indexdef,
        'it must carry a WHERE clause restricting it to deleted accounts',
      ).toMatch(/WHERE .*status = 'deleted'/);
    });
  },
);
