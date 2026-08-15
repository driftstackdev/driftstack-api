// `pruneFinished` must never take a job that has not finished, against real
// Postgres in an isolated database.
//
// It is the last member of the "global DELETE bounded only by time" class. Unlike
// the others it deletes on a disjunction of two terminal timestamps:
//
//   or( and(completedAt IS NOT NULL, completedAt < olderThan),
//       and(failedAt    IS NOT NULL, failedAt    < olderThan) )
//
// I had recorded this one as "safe by construction" from reading it — the
// IS NOT NULL pairs mean a PENDING row (both timestamps null) can never match, so
// losing an age bound only widens the delete within already-terminal rows. That
// is an argument, and arguments about SQL null semantics are exactly what this
// week's instrument failures were made of. This file measures it instead.
//
// What it protects: `scheduled_jobs` is the self-arming chain table. Deleting a
// PENDING row does not lose history, it kills the chain — the job never runs
// again and does not re-arm, which is the "chain is dead and will not run again
// without a restart" state the liveness gauge exists to detect. The retention
// purges, the reminder sweeps and the reconciliation jobs all live here.
//
// Isolated per `global-scope-db-tests-are-isolated`, like its siblings: this is a
// whole-table delete and must not run against the shared database.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleScheduledJobsRepo } from '../../src/db/scheduled-jobs-repo.js';
import { ensureIsolatedDatabase } from './_helpers/isolated-database.js';
import type * as schema from '../../src/db/schema.js';

const ISOLATED_DB_NAME = 'driftstack_iso_jobs_prune';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

let DB_URL = '';
let client: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  const isolated = await ensureIsolatedDatabase(ISOLATED_DB_NAME);
  if (isolated === null) return;
  DB_URL = isolated;
  if (!RUN_DB_TESTS) return;
  client = postgres(DB_URL, { max: 1 });
  try {
    await client`SELECT 1 FROM scheduled_jobs LIMIT 0`;
  } catch {
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) await client.end({ timeout: 5 });
});

describe.skipIf(!RUN_DB_TESTS)('scheduled-jobs pruneFinished (isolated real Postgres)', () => {
  it('CRITICAL never deletes a PENDING job. Losing a finished row loses history; losing a pending one kills the self-arming chain — it never runs again and never re-arms, which is precisely the dead-chain state the liveness gauge exists to detect.', async () => {
    if (!client) {
      if (process.env.CI) {
        throw new Error(
          'real-PG prune-finished test: isolated database unreachable/unmigrated in CI — vacuous pass is forbidden',
        );
      }
      return;
    }
    const pg = client;
    const db = drizzle(pg) as unknown as ReturnType<typeof drizzle<typeof schema>>;
    const repo = new DrizzleScheduledJobsRepo({ client: pg, db, close: async () => {} });

    const cutoff = new Date('2026-07-01T00:00:00.000Z');
    const run = randomUUID().replaceAll('-', '').slice(0, 10);

    const mk = async (
      label: string,
      cols: { completedAt?: string; failedAt?: string },
    ): Promise<string> => {
      const [row] = await pg`
        INSERT INTO scheduled_jobs (job_type, run_at, completed_at, failed_at)
        VALUES (${`${run}-${label}`}, ${'2026-06-01T00:00:00.000Z'},
                ${cols.completedAt ?? null}, ${cols.failedAt ?? null})
        RETURNING id`;
      return row?.id as string;
    };

    // A pending row — both terminal timestamps null. This is the one that must
    // survive no matter what, and the only reason the argument-from-reading said
    // it would.
    const pending = await mk('pending', {});
    // Terminal and old, by each of the two disjuncts.
    const oldCompleted = await mk('old-completed', { completedAt: '2026-06-30T00:00:00.000Z' });
    const oldFailed = await mk('old-failed', { failedAt: '2026-06-30T00:00:00.000Z' });
    // Terminal but NEWER than the cutoff — recent history that must be kept.
    const freshCompleted = await mk('fresh-completed', { completedAt: '2026-07-02T00:00:00.000Z' });
    // One per disjunct: without a fresh FAILED row the age bound on the second
    // branch is unmeasurable, and a ledger would report it covered when the
    // fixture simply could not tell.
    const freshFailed = await mk('fresh-failed', { failedAt: '2026-07-02T00:00:00.000Z' });

    const deleted = await repo.pruneFinished(cutoff);
    expect(deleted).toBe(2);

    const rows = await pg<Array<{ id: string }>>`
      SELECT id FROM scheduled_jobs WHERE job_type LIKE ${`${run}-%`}`;
    const ids = rows.map((r) => r.id);

    expect(ids, 'a PENDING job must never be pruned — this kills the chain').toContain(pending);
    expect(ids, 'terminal but newer than the cutoff is still history worth keeping').toContain(
      freshCompleted,
    );
    expect(ids, 'and the same on the failed branch').toContain(freshFailed);
    expect(ids, 'an old completed job is pruned').not.toContain(oldCompleted);
    expect(ids, 'an old failed job is pruned — the second disjunct').not.toContain(oldFailed);
    expect(ids).toHaveLength(3);
  });
});
