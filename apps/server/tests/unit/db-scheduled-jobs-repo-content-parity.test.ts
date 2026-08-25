// W445.C — drift guard for apps/server/src/db/scheduled-jobs-repo.ts.
// V-202d Drizzle ScheduledJobsRepo. Drift here either drops the FOR
// UPDATE SKIP LOCKED clause (concurrent workers claim the same row
// and run handlers twice) or removes the 5-minute lock-recovery
// window (zombie workers leave jobs permanently locked).
//
//   • V-202d framing pinned.
//   • enqueue dedup: transaction-scoped advisory lock serializes the
//     canonical (accountId, jobType) tuple across replicas before the
//     pending-row recheck and insert. Null-accountId branch remains
//     explicit via isNull() — pre-2026-05-20 prod incident
//     short-circuited on `accountId !== null` and silently skipped
//     dedup for global jobs (13 dupes of auth_tokens.sweep).
//   • claimDue atomic framing pinned: CTE + UPDATE...FROM...RETURNING;
//     inner SELECT picks unfinished+due rows with FOR UPDATE SKIP
//     LOCKED so concurrent workers never claim same row; outer
//     UPDATE sets locked_by + locked_at + attempts++; RETURNING
//     gives back claimed rows.
//   • 5-minute zombie-lock recovery: (locked_by IS NULL OR
//     locked_at < now - 5min).
//   • markComplete: completedAt + clear locked_by/locked_at + updatedAt.
//   • markRetry: bump runAt + lastError + clear locked + updatedAt.
//   • markFailed: failedAt + lastError + clear locked + updatedAt.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/scheduled-jobs-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W445.C apps/server/src/db/scheduled-jobs-repo.ts content parity', () => {
  const body = read(LIB);

  it("V-202d framing pinned: 'Drizzle implementation of ScheduledJobsRepo.'", () => {
    expect(body).toMatch(/\/\/ V-202d — Drizzle implementation of ScheduledJobsRepo\./);
  });

  it('imports the exact query primitives, Database, scheduledJobs schema and service types', () => {
    expect(body).toMatch(
      /import \{ and, eq, gt, isNotNull, isNull, lt, or, sql \} from 'drizzle-orm';/,
    );
    expect(body).toMatch(/import \{ scheduledJobs \} from '\.\/schema\.js';/);
    expect(body).toMatch(
      /import type \{\s*EnqueueScheduledJobInput,\s*ScheduledJobRow,\s*ScheduledJobsRepo,\s*\} from '\.\.\/services\/scheduled-jobs\.js';/,
    );
  });

  it('enqueue dedup is cross-replica atomic: canonical tuple advisory lock, pending recheck, then insert in one transaction; null account uses isNull', () => {
    expect(body).toMatch(/if \(input\.dedupOnAccountAndType === true\) \{/);
    expect(body).toMatch(
      /const dedupLockTuple = JSON\.stringify\(\[input\.accountId, input\.jobType\]\);/,
    );
    expect(body).toMatch(/return this\.database\.db\.transaction\(async \(tx\) => \{/);
    expect(body).toMatch(
      /await tx\.execute\(sql`SELECT pg_advisory_xact_lock\(hashtextextended\(\$\{dedupLockTuple\}, 0\)\)`\);/,
    );
    expect(body).toMatch(
      /input\.accountId === null\s*\? isNull\(scheduledJobs\.accountId\)\s*: eq\(scheduledJobs\.accountId, input\.accountId\),\s*eq\(scheduledJobs\.jobType, input\.jobType\),\s*isNull\(scheduledJobs\.completedAt\),\s*isNull\(scheduledJobs\.failedAt\),/,
    );
    expect(body).toMatch(/if \(existing\.length > 0\) return \{ enqueued: false \};/);
    expect(body).toMatch(
      /input\.dedupAfterRunAt === undefined\s*\? undefined\s*: gt\(scheduledJobs\.runAt, input\.dedupAfterRunAt\),/,
    );
    expect(body).toMatch(
      /await tx\.insert\(scheduledJobs\)\.values\(\{\s*jobType: input\.jobType,\s*accountId: input\.accountId,\s*payload: input\.payload,\s*runAt: input\.runAt,\s*\}\);\s*return \{ enqueued: true \};/,
    );
    const transaction = body.split('const dedupLockTuple')[1] ?? '';
    expect(transaction.indexOf('await tx.execute')).toBeLessThan(
      transaction.indexOf('const existing = await tx'),
    );
    expect(transaction.indexOf('const existing = await tx')).toBeLessThan(
      transaction.indexOf('await tx.insert(scheduledJobs)'),
    );
  });

  it('null-accountId dedup incident comment pinned: the prod 2026-05-20 incident is documented in-source so the bug regression-tests against re-introducing the `accountId !== null` short-circuit', () => {
    expect(body).toMatch(
      /Caught in prod 2026-05-20: 13 pending auth_tokens\.sweep rows\s*\/\/ accumulated across service restarts because of a missed NULL branch\./,
    );
  });

  it("claimDue atomic framing pinned: 'Atomic claim via CTE + UPDATE ... FROM ... RETURNING. The inner SELECT picks unfinished, due rows with FOR UPDATE SKIP LOCKED so concurrent workers never claim the same row. The outer UPDATE sets locked_by + locked_at + increments attempts, then RETURNING gives us back the claimed rows.'", () => {
    expect(body).toMatch(
      /\/\/ Atomic claim via CTE \+ UPDATE \.\.\. FROM \.\.\. RETURNING\. The inner\s*\/\/ SELECT picks unfinished, due rows with FOR UPDATE SKIP LOCKED so\s*\/\/ concurrent workers never claim the same row\. The outer UPDATE\s*\/\/ sets locked_by \+ locked_at \+ increments attempts, then RETURNING\s*\/\/ gives us back the claimed rows\./,
    );
  });

  it('claimDue raw SQL: WITH due AS (SELECT id FROM scheduled_jobs WHERE run_at <= now AND completed_at IS NULL AND failed_at IS NULL AND (locked_by IS NULL OR locked_at < now - 5min) ORDER BY run_at ASC LIMIT batchSize FOR UPDATE SKIP LOCKED) UPDATE ... SET locked_by, locked_at, attempts++, updated_at RETURNING 7 columns', () => {
    expect(body).toMatch(
      /WITH due AS \(\s*SELECT id\s*FROM scheduled_jobs\s*WHERE run_at <= \$\{nowIso\}\s*AND completed_at IS NULL\s*AND failed_at IS NULL\s*AND \(locked_by IS NULL OR locked_at < \$\{lockStaleAtIso\}\)\s*ORDER BY run_at ASC\s*LIMIT \$\{opts\.batchSize\}\s*FOR UPDATE SKIP LOCKED\s*\)\s*UPDATE scheduled_jobs sj\s*SET locked_by\s*= \$\{opts\.workerId\},\s*locked_at\s*= \$\{nowIso\},\s*attempts\s+= sj\.attempts \+ 1,\s*updated_at\s+= \$\{nowIso\}\s*FROM due\s*WHERE sj\.id = due\.id\s*RETURNING sj\.id, sj\.job_type, sj\.account_id, sj\.payload, sj\.run_at,\s*sj\.attempts, sj\.max_attempts;/,
    );
  });

  it('claimDue dual-shape row iter normalizes the raw timestamp and maps the ScheduledJobRow shape', () => {
    expect(body).toMatch(
      /\/\/ postgres-js returns rows as a typed array\.\s*const rows = \(result as unknown as \{ rows\?: unknown\[\] \}\)\.rows \?\? \(result as unknown\[\]\);/,
    );
    expect(body).toMatch(/function parseClaimedRunAt\(value: unknown\): Date \{/);
    expect(body).toMatch(/value instanceof Date \? value : typeof value === 'string'/);
    expect(body).toMatch(/!Number\.isFinite\(parsed\.getTime\(\)\)/);
    expect(body).toMatch(
      /throw new TypeError\('scheduled_jobs\.run_at returned an invalid timestamp'\)/,
    );
    expect(body).toMatch(/return \(rows as Array<Record<string, unknown>>\)\.map\(\(r\) => \(\{/);
    expect(body).toMatch(/id: r\.id as string,/);
    expect(body).toMatch(/jobType: r\.job_type as string,/);
    expect(body).toMatch(/accountId: \(r\.account_id as string \| null\) \?\? null,/);
    expect(body).toMatch(/payload: \(r\.payload as Record<string, unknown>\) \?\? \{\},/);
    expect(body).toMatch(/runAt: parseClaimedRunAt\(r\.run_at\),/);
    expect(body).toMatch(/attempts: r\.attempts as number,/);
    expect(body).toMatch(/maxAttempts: r\.max_attempts as number,/);
  });

  it('markComplete/markRetry/markFailed each set their terminal fields AND are fenced on locked_by = workerId (V-747), returning whether the fence matched', () => {
    expect(body).toMatch(
      /async markComplete\(jobId: string, at: Date, workerId: string\): Promise<boolean>/,
    );
    expect(body).toMatch(
      /\.set\(\{ completedAt: at, lockedBy: null, lockedAt: null, updatedAt: at \}\)/,
    );
    // V-747 — this used to pin `.where(eq(scheduledJobs.id, jobId))`, i.e. it froze
    // the UNFENCED settle in place as though intended. A settle keyed on id alone
    // lets an overrunning handler's late write land on a row another claim now
    // owns. All three settles must carry the lock fence, and the bare id-only form
    // must not come back.
    const fence =
      /\.where\(and\(eq\(scheduledJobs\.id, jobId\), eq\(scheduledJobs\.lockedBy, (workerId|opts\.workerId)\)\)\)/g;
    expect(body.match(fence) ?? []).toHaveLength(3);
    expect(body).not.toMatch(/\.where\(eq\(scheduledJobs\.id, jobId\)\);/);
    // >= 3 rather than == 3: enqueue also returns an id, so this counts the three
    // settle sites plus any pre-existing returning() in the file.
    expect(
      (body.match(/\.returning\(\{ id: scheduledJobs\.id \}\)/g) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
    expect(body).toMatch(
      /\.set\(\{\s*runAt: opts\.nextRunAt,\s*lastError: opts\.lastError,\s*lockedBy: null,\s*lockedAt: null,\s*updatedAt: new Date\(\),\s*\}\)/,
    );
    expect(body).toMatch(
      /\.set\(\{\s*failedAt: opts\.at,\s*lastError: opts\.lastError,\s*lockedBy: null,\s*lockedAt: null,\s*updatedAt: opts\.at,\s*\}\)/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
