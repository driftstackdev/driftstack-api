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
      /import type \{\s*\n?\s*EnqueueScheduledJobInput,\s*\n?\s*ScheduledJobRow,\s*\n?\s*ScheduledJobsRepo,\s*\n?\s*\} from '\.\.\/services\/scheduled-jobs\.js';/,
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
      /input\.accountId === null\s*\n?\s*\? isNull\(scheduledJobs\.accountId\)\s*\n?\s*: eq\(scheduledJobs\.accountId, input\.accountId\),\s*\n?\s*eq\(scheduledJobs\.jobType, input\.jobType\),\s*\n?\s*isNull\(scheduledJobs\.completedAt\),\s*\n?\s*isNull\(scheduledJobs\.failedAt\),/,
    );
    expect(body).toMatch(/if \(existing\.length > 0\) return \{ enqueued: false \};/);
    expect(body).toMatch(
      /input\.dedupAfterRunAt === undefined\s*\n?\s*\? undefined\s*\n?\s*: gt\(scheduledJobs\.runAt, input\.dedupAfterRunAt\),/,
    );
    expect(body).toMatch(
      /await tx\.insert\(scheduledJobs\)\.values\(\{\s*\n?\s*jobType: input\.jobType,\s*\n?\s*accountId: input\.accountId,\s*\n?\s*payload: input\.payload,\s*\n?\s*runAt: input\.runAt,\s*\n?\s*\}\);\s*\n?\s*return \{ enqueued: true \};/,
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
      /Caught in prod 2026-05-20: 13 pending auth_tokens\.sweep rows\s*\n?\s*\/\/ accumulated across service restarts because of a missed NULL branch\./,
    );
  });

  it("claimDue atomic framing pinned: 'Atomic claim via CTE + UPDATE ... FROM ... RETURNING. The inner SELECT picks unfinished, due rows with FOR UPDATE SKIP LOCKED so concurrent workers never claim the same row. The outer UPDATE sets locked_by + locked_at + increments attempts, then RETURNING gives us back the claimed rows.'", () => {
    expect(body).toMatch(
      /\/\/ Atomic claim via CTE \+ UPDATE \.\.\. FROM \.\.\. RETURNING\. The inner\s*\n?\s*\/\/ SELECT picks unfinished, due rows with FOR UPDATE SKIP LOCKED so\s*\n?\s*\/\/ concurrent workers never claim the same row\. The outer UPDATE\s*\n?\s*\/\/ sets locked_by \+ locked_at \+ increments attempts, then RETURNING\s*\n?\s*\/\/ gives us back the claimed rows\./,
    );
  });

  it('claimDue raw SQL: WITH due AS (SELECT id FROM scheduled_jobs WHERE run_at <= now AND completed_at IS NULL AND failed_at IS NULL AND (locked_by IS NULL OR locked_at < now - 5min) ORDER BY run_at ASC LIMIT batchSize FOR UPDATE SKIP LOCKED) UPDATE ... SET locked_by, locked_at, attempts++, updated_at RETURNING 7 columns', () => {
    expect(body).toMatch(
      /WITH due AS \(\s*\n?\s*SELECT id\s*\n?\s*FROM scheduled_jobs\s*\n?\s*WHERE run_at <= \$\{nowIso\}\s*\n?\s*AND completed_at IS NULL\s*\n?\s*AND failed_at IS NULL\s*\n?\s*AND \(locked_by IS NULL OR locked_at < \$\{lockStaleAtIso\}\)\s*\n?\s*ORDER BY run_at ASC\s*\n?\s*LIMIT \$\{opts\.batchSize\}\s*\n?\s*FOR UPDATE SKIP LOCKED\s*\n?\s*\)\s*\n?\s*UPDATE scheduled_jobs sj\s*\n?\s*SET locked_by\s*= \$\{opts\.workerId\},\s*\n?\s*locked_at\s*= \$\{nowIso\},\s*\n?\s*attempts\s+= sj\.attempts \+ 1,\s*\n?\s*updated_at\s+= \$\{nowIso\}\s*\n?\s*FROM due\s*\n?\s*WHERE sj\.id = due\.id\s*\n?\s*RETURNING sj\.id, sj\.job_type, sj\.account_id, sj\.payload, sj\.run_at,\s*\n?\s*sj\.attempts, sj\.max_attempts;/,
    );
  });

  it('claimDue dual-shape row iter (postgres-js typed array vs {rows} envelope); rows.map to ScheduledJobRow shape (snake_case → camel; payload defaulted {})', () => {
    expect(body).toMatch(
      /\/\/ postgres-js returns rows as a typed array\.\s*\n?\s*const rows = \(result as unknown as \{ rows\?: unknown\[\] \}\)\.rows \?\? \(result as unknown\[\]\);/,
    );
    expect(body).toMatch(
      /return \(rows as Array<Record<string, unknown>>\)\.map\(\(r\) => \(\{\s*\n?\s*id: r\.id as string,\s*\n?\s*jobType: r\.job_type as string,\s*\n?\s*accountId: \(r\.account_id as string \| null\) \?\? null,\s*\n?\s*payload: \(r\.payload as Record<string, unknown>\) \?\? \{\},\s*\n?\s*runAt: r\.run_at as Date,\s*\n?\s*attempts: r\.attempts as number,\s*\n?\s*maxAttempts: r\.max_attempts as number,\s*\n?\s*\}\)\);/,
    );
  });

  it('markComplete: completedAt + clear lockedBy/lockedAt + updatedAt where id; markRetry: bump runAt + lastError + clear locked + updatedAt; markFailed: failedAt + lastError + clear locked + updatedAt', () => {
    expect(body).toMatch(
      /async markComplete\(jobId: string, at: Date\): Promise<void> \{\s*\n?\s*await this\.database\.db\s*\n?\s*\.update\(scheduledJobs\)\s*\n?\s*\.set\(\{ completedAt: at, lockedBy: null, lockedAt: null, updatedAt: at \}\)\s*\n?\s*\.where\(eq\(scheduledJobs\.id, jobId\)\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /\.set\(\{\s*\n?\s*runAt: opts\.nextRunAt,\s*\n?\s*lastError: opts\.lastError,\s*\n?\s*lockedBy: null,\s*\n?\s*lockedAt: null,\s*\n?\s*updatedAt: new Date\(\),\s*\n?\s*\}\)/,
    );
    expect(body).toMatch(
      /\.set\(\{\s*\n?\s*failedAt: opts\.at,\s*\n?\s*lastError: opts\.lastError,\s*\n?\s*lockedBy: null,\s*\n?\s*lockedAt: null,\s*\n?\s*updatedAt: opts\.at,\s*\n?\s*\}\)/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
