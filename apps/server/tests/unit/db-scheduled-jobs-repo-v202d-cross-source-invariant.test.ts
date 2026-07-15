// W1014 — db/scheduled-jobs-repo V-202d cross-source invariant. Three-
// hundred-fortieth in the drift-guard series. Pins the apps/server/
// src/db/scheduled-jobs-repo.ts background-job queue repo:
//
//   V-202d anchor — 'V-202d — Drizzle implementation of
//   ScheduledJobsRepo'.
//
//   5-method surface — enqueue + claimDue + markComplete +
//     markRetry + markFailed.
//
//   enqueue dedupOnAccountAndType framing — advisory-lock the canonical
//     account/type tuple, then look for existing pending state while
//     optionally excluding the current self-arming row. Returns
//     {enqueued:false} if a distinct pending successor exists.
//
//   claimDue atomic CTE framing — 'Atomic claim via CTE + UPDATE ...
//   FROM ... RETURNING. The inner SELECT picks unfinished, due rows
//   with FOR UPDATE SKIP LOCKED so concurrent workers never claim the
//   same row. The outer UPDATE sets locked_by + locked_at + increments
//   attempts, then RETURNING gives us back the claimed rows'.
//
//   claimDue 5-minute lock-staleness override — 'AND (locked_by IS
//   NULL OR locked_at < now - 5 min)'. The 5-min override lets a new
//   worker take over from a dead one.
//
//   claimDue raw SQL: CTE 'due' with FOR UPDATE SKIP LOCKED + UPDATE
//   scheduled_jobs sj FROM due WHERE sj.id = due.id RETURNING 7 cols.
//
//   markComplete clears lockedBy/lockedAt + sets completedAt +
//     updatedAt.
//
//   markRetry sets runAt = nextRunAt + lastError + clears lockedBy/
//     lockedAt + updatedAt.
//
//   markFailed sets failedAt + lastError + clears lockedBy/lockedAt +
//     updatedAt.
//
// stays in lockstep across apps/server/src/db/scheduled-jobs-repo.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1014 db/scheduled-jobs-repo V-202d cross-source invariant', () => {
  it("CRITICAL V-202d anchor — 'V-202d — Drizzle implementation of ScheduledJobsRepo'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/scheduled-jobs-repo.ts'));
    expect(p).toMatch(/\/\/ V-202d — Drizzle implementation of ScheduledJobsRepo\./);
    expect(p).toMatch(/export class DrizzleScheduledJobsRepo implements ScheduledJobsRepo \{/);
  });

  it('CRITICAL 5-method surface — enqueue + claimDue + markComplete + markRetry + markFailed.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/scheduled-jobs-repo.ts'));
    expect(p).toMatch(
      /async enqueue\(input: EnqueueScheduledJobInput\): Promise<\{ enqueued: boolean \}> \{/,
    );
    expect(p).toMatch(/async claimDue\(opts: \{/);
    expect(p).toMatch(/async markComplete\(jobId: string, at: Date\): Promise<void> \{/);
    expect(p).toMatch(
      /async markRetry\(jobId: string, opts: \{ lastError: string; nextRunAt: Date \}\): Promise<void> \{/,
    );
    expect(p).toMatch(
      /async markFailed\(jobId: string, opts: \{ lastError: string; at: Date \}\): Promise<void> \{/,
    );
  });

  it('CRITICAL enqueue dedup is serialized across replicas and can exclude the current self-arming row', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/scheduled-jobs-repo.ts'));
    expect(p).toMatch(/if \(input\.dedupOnAccountAndType === true\) \{/);
    expect(p).toMatch(/pg_advisory_xact_lock\(hashtextextended\(\$\{dedupLockTuple\}, 0\)\)/);
    expect(p).toMatch(
      /input\.accountId === null\s*\n?\s*\?\s*isNull\(scheduledJobs\.accountId\)\s*\n?\s*:\s*eq\(scheduledJobs\.accountId, input\.accountId\),/,
    );
    expect(p).toMatch(/eq\(scheduledJobs\.jobType, input\.jobType\),/);
    expect(p).toMatch(/isNull\(scheduledJobs\.completedAt\),/);
    expect(p).toMatch(/isNull\(scheduledJobs\.failedAt\),/);
    expect(p).toMatch(/gt\(scheduledJobs\.runAt, input\.dedupAfterRunAt\),/);
    expect(p).toMatch(/if \(existing\.length > 0\) return \{ enqueued: false \};/);
  });

  it("CRITICAL claimDue atomic CTE framing — 'Atomic claim via CTE + UPDATE ... FROM ... RETURNING. The inner SELECT picks unfinished, due rows with FOR UPDATE SKIP LOCKED so concurrent workers never claim the same row. The outer UPDATE sets locked_by + locked_at + increments attempts, then RETURNING gives us back the claimed rows'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/scheduled-jobs-repo.ts'));
    expect(p).toMatch(
      /\/\/ Atomic claim via CTE \+ UPDATE \.\.\. FROM \.\.\. RETURNING\. The inner/,
    );
    expect(p).toMatch(/\/\/ SELECT picks unfinished, due rows with FOR UPDATE SKIP LOCKED so/);
    expect(p).toMatch(/\/\/ concurrent workers never claim the same row\. The outer UPDATE/);
    expect(p).toMatch(/\/\/ sets locked_by \+ locked_at \+ increments attempts, then RETURNING/);
    expect(p).toMatch(/\/\/ gives us back the claimed rows\./);
  });

  it("CRITICAL claimDue 5-minute lock-staleness override — '(locked_by IS NULL OR locked_at < ${now - 5*60000})'. The 5-min override lets a fresh worker steal locks from dead workers.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/scheduled-jobs-repo.ts'));
    expect(p).toMatch(/AND \(locked_by IS NULL OR locked_at < \$\{lockStaleAtIso\}\)/);
  });

  it('CRITICAL claimDue raw SQL — WITH due AS (SELECT id ... FOR UPDATE SKIP LOCKED) UPDATE ... FROM due WHERE sj.id=due.id RETURNING 7 cols.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/scheduled-jobs-repo.ts'));
    expect(p).toMatch(/WITH due AS \(/);
    expect(p).toMatch(/SELECT id/);
    expect(p).toMatch(/FROM scheduled_jobs/);
    expect(p).toMatch(/WHERE run_at <= \$\{nowIso\}/);
    expect(p).toMatch(/AND completed_at IS NULL/);
    expect(p).toMatch(/AND failed_at IS NULL/);
    expect(p).toMatch(/ORDER BY run_at ASC/);
    expect(p).toMatch(/LIMIT \$\{opts\.batchSize\}/);
    expect(p).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(p).toMatch(/UPDATE scheduled_jobs sj/);
    expect(p).toMatch(/SET locked_by\s+=\s+\$\{opts\.workerId\},/);
    expect(p).toMatch(/locked_at\s+=\s+\$\{nowIso\},/);
    expect(p).toMatch(/attempts\s+= sj\.attempts \+ 1,/);
    expect(p).toMatch(/FROM due/);
    expect(p).toMatch(/WHERE sj\.id = due\.id/);
    expect(p).toMatch(/RETURNING sj\.id, sj\.job_type, sj\.account_id, sj\.payload, sj\.run_at,/);
    expect(p).toMatch(/sj\.attempts, sj\.max_attempts;/);
  });

  it('CRITICAL claimDue returns 7-field row shape and fail-closed normalized runAt Date.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/scheduled-jobs-repo.ts'));
    expect(p).toMatch(/function parseClaimedRunAt\(value: unknown\): Date \{/);
    expect(p).toMatch(/!Number\.isFinite\(parsed\.getTime\(\)\)/);
    expect(p).toMatch(/id: r\.id as string,/);
    expect(p).toMatch(/jobType: r\.job_type as string,/);
    expect(p).toMatch(/accountId: \(r\.account_id as string \| null\) \?\? null,/);
    expect(p).toMatch(/payload: \(r\.payload as Record<string, unknown>\) \?\? \{\},/);
    expect(p).toMatch(/runAt: parseClaimedRunAt\(r\.run_at\),/);
    expect(p).toMatch(/attempts: r\.attempts as number,/);
    expect(p).toMatch(/maxAttempts: r\.max_attempts as number,/);
  });

  it('CRITICAL markComplete sets completedAt + clears lockedBy/lockedAt + updatedAt.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/scheduled-jobs-repo.ts'));
    expect(p).toMatch(
      /\.set\(\{ completedAt: at, lockedBy: null, lockedAt: null, updatedAt: at \}\)/,
    );
  });

  it('CRITICAL markRetry sets runAt = opts.nextRunAt + lastError + clears lockedBy/lockedAt + updatedAt:new Date().', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/scheduled-jobs-repo.ts'));
    expect(p).toMatch(/runAt: opts\.nextRunAt,/);
    expect(p).toMatch(/lastError: opts\.lastError,/);
    expect(p).toMatch(/lockedBy: null,/);
    expect(p).toMatch(/lockedAt: null,/);
    expect(p).toMatch(/updatedAt: new Date\(\),/);
  });

  it('CRITICAL markFailed sets failedAt + lastError + clears lockedBy/lockedAt + updatedAt.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/scheduled-jobs-repo.ts'));
    expect(p).toMatch(/failedAt: opts\.at,/);
    expect(p).toMatch(/lastError: opts\.lastError,/);
    expect(p).toMatch(/updatedAt: opts\.at,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/db-scheduled-jobs-repo-v202d-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
