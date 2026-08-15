// The one raw-SQL statement in the repo layer that had never executed.
//
// Found by measurement rather than by reading: of 18 raw-SQL sites across
// apps/server/src/db, per-line coverage showed exactly two never running —
// migrate.ts (a CLI entrypoint, legitimately) and this one:
//
//     SELECT DISTINCT job_type FROM scheduled_jobs
//     WHERE completed_at IS NULL AND failed_at IS NULL
//
// scheduled-jobs-repo reports 83% file coverage, which is the point: file-level
// numbers hide a single dead statement, and a raw string is the one kind of
// statement TypeScript cannot check. A renamed column here compiles and lints.
//
// It is not decorative. `job-chain-liveness` calls it to decide which job types
// still have outstanding work, and every existing test of that path supplies a
// double — `repoWith([...])`, the in-memory repo, `Promise.resolve([])`. The
// decision was covered; the query was not.
//
// Shared-database discipline: this query has no account scope, so it sees rows
// from every db-* file running concurrently. Every arm therefore asserts about a
// job_type unique to this run and never about the full result set.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleScheduledJobsRepo } from '../../src/db/scheduled-jobs-repo.js';
import * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

/** Unique to this run so concurrent db-* files cannot change the answer. */
const KIND = `pendingtypes-${randomUUID().slice(0, 8)}`;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
let repo: DrizzleScheduledJobsRepo | null = null;
const seededJobIds: string[] = [];

async function seedJob(
  jobType: string,
  state: 'pending' | 'completed' | 'failed',
): Promise<string> {
  if (!client) throw new Error('no client');
  const id = randomUUID();
  const completedAt = state === 'completed' ? new Date().toISOString() : null;
  const failedAt = state === 'failed' ? new Date().toISOString() : null;
  await client`
    INSERT INTO scheduled_jobs
      (id, job_type, payload, run_at, attempts, max_attempts,
       completed_at, failed_at, created_at, updated_at)
    VALUES (${id}, ${jobType}, ${'{}'}::jsonb, now(), 0, 5,
            ${completedAt}::timestamptz, ${failedAt}::timestamptz, now(), now())`;
  seededJobIds.push(id);
  return id;
}

beforeAll(async () => {
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
  try {
    await client`SELECT 1 FROM scheduled_jobs LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
    return;
  }
  repo = new DrizzleScheduledJobsRepo({
    client,
    db: drizzle(client, { schema }),
    close: async () => {},
  });
});

afterAll(async () => {
  if (client) {
    for (const id of seededJobIds) {
      await client`DELETE FROM scheduled_jobs WHERE id = ${id}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleScheduledJobsRepo.jobTypesWithPendingWork (raw SQL against real Postgres)',
  () => {
    it('CRITICAL the database is reachable and migrated. In CI the service and migrate step are part of the job, so an unreachable database must FAIL rather than let every arm below pass vacuously.', () => {
      if (!process.env.CI && !process.env.DATABASE_URL) return;
      expect(dbReachable, 'postgres reachable and scheduled_jobs present').toBe(true);
      expect(repo, 'repo constructed').not.toBeNull();
    });

    it('CRITICAL the statement executes at all and reports a pending job type. This is the first execution of this raw SQL under vitest — a renamed column in that string would compile, lint clean, and fail only here.', async () => {
      if (!dbReachable || !repo) return;
      await seedJob(KIND, 'pending');
      const types = await repo.jobTypesWithPendingWork();
      expect(types, 'a pending job makes its type appear').toContain(KIND);
    });

    it('CRITICAL a completed job type disappears from the result. job-chain-liveness treats presence as outstanding work — a completed job still reported would keep a finished chain permanently "alive".', async () => {
      if (!dbReachable || !repo || !client) return;
      const done = `${KIND}-done`;
      await seedJob(done, 'completed');
      const types = await repo.jobTypesWithPendingWork();
      expect(types.includes(done), 'completed_at set excludes it').toBe(false);
    });

    it('CRITICAL a failed job type disappears too. failed_at is a separate column from completed_at, so a filter that checked only one would keep dead work in the pending set forever.', async () => {
      if (!dbReachable || !repo) return;
      const failed = `${KIND}-failed`;
      await seedJob(failed, 'failed');
      const types = await repo.jobTypesWithPendingWork();
      expect(types.includes(failed), 'failed_at set excludes it').toBe(false);
    });

    it('CRITICAL the DISTINCT collapses many pending jobs of one type to a single entry. The caller builds a Set from this, so a duplicate is invisible to it — but the query is also read directly, and the contract is one row per type.', async () => {
      if (!dbReachable || !repo) return;
      const many = `${KIND}-many`;
      await seedJob(many, 'pending');
      await seedJob(many, 'pending');
      await seedJob(many, 'pending');
      const types = await repo.jobTypesWithPendingWork();
      expect(types.filter((t) => t === many).length, 'three pending jobs, one entry').toBe(1);
    });

    it('CRITICAL a type whose only jobs are settled is absent even though rows exist. Distinguishes "no rows" from "no PENDING rows" — the filter is the whole behaviour, and a query returning every distinct type would still pass the arms above.', async () => {
      if (!dbReachable || !repo) return;
      const settled = `${KIND}-settled`;
      await seedJob(settled, 'completed');
      await seedJob(settled, 'failed');
      const types = await repo.jobTypesWithPendingWork();
      expect(types.includes(settled), 'rows exist but none pending').toBe(false);
    });
  },
);
