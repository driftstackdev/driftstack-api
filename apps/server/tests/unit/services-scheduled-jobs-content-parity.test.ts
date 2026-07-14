// W409.B — drift guard for apps/server/src/services/scheduled-jobs.ts.
// V-202d generic time-shifted job dispatcher (founder verdict 2026-05-05).
// V-173-pattern setInterval poller + SELECT FOR UPDATE SKIP LOCKED claim;
// drift here either reissues the same job to concurrent workers (double-
// dispatch) or starves retries (exponential backoff math wrong).
//
//   • V-202d framing pinned: bootstrap-driven setInterval poller calling
//     processTick(now); SELECT FOR UPDATE SKIP LOCKED claim; per-job-type
//     handler dispatch; mark complete / retry / failed.
//   • Consumer-model framing pinned: register a handler keyed by
//     job_type + enqueue rows; no new table per consumer. Live
//     consumers: auth_tokens.sweep / sessions.duration_sweep /
//     cost.recompute_nightly; each self-re-arms from its handler.
//     (The trial_pack.expired first-consumer was removed with the
//     dead trial_pack lifecycle.)
//   • Defaults: batchSize=25, retryBackoffBaseMs=60_000.
//   • register(): last-write-wins map insert.
//   • No-handler path: markFailed with descriptive lastError ("no handler
//     registered for job_type=X"); warn-log includes operator guidance.
//   • Exponential backoff math: retryBackoffBaseMs * 2^(attempts-1)
//     with Math.max(0, attempts-1) floor.
//   • Exhausted-attempts: attempts >= maxAttempts → markFailed (not
//     markRetry); permanent fail error-logged.
//   • dedupOnAccountAndType: enqueue no-ops when pending (completed_at
//     NULL AND failed_at NULL) row exists for same (account_id, job_type),
//     optionally matching only successors after the handler's current runAt.
//   • claimDue: atomic, sets locked_by + locked_at + increments attempts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/scheduled-jobs.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W409.B apps/server/src/services/scheduled-jobs.ts content parity', () => {
  const body = read(LIB);

  it('V-202d framing pinned: founder verdict 2026-05-05 + V-173-pattern setInterval + SELECT FOR UPDATE SKIP LOCKED', () => {
    expect(body).toMatch(/V-202d — generic time-shifted job dispatcher built on the/);
    expect(body).toMatch(
      /`scheduled_jobs` table\. Per founder verdict \(2026-05-05\),\s*\n?\s*\/\/\s*V-173-pattern extension: bootstrap runs setInterval poller that\s*\n?\s*\/\/\s*calls `processTick\(now\)`; the service claims due jobs via\s*\n?\s*\/\/\s*SELECT \.\.\. FOR UPDATE SKIP LOCKED, dispatches each to its\s*\n?\s*\/\/\s*registered handler keyed by job_type/,
    );
  });

  it('Consumer-model framing pinned: register handler + enqueue rows; "no new table per consumer"; live consumers listed; trial_pack.expired GONE', () => {
    expect(body).toMatch(/Consumers register a handler keyed by job_type and enqueue rows/);
    expect(body).toMatch(/no new table per consumer/);
    expect(body).toMatch(/`auth_tokens\.sweep`/);
    expect(body).toMatch(/`sessions\.duration_sweep`/);
    expect(body).toMatch(/`cost\.recompute_nightly`/);
    expect(body).not.toMatch(/First consumer: trial-pack expiry/);
    expect(body).not.toMatch(/trial_pack\.expired/);
  });

  it('Defaults: batchSize=25 + retryBackoffBaseMs=60_000', () => {
    expect(body).toMatch(/this\.batchSize = config\.batchSize \?\? 25;/);
    expect(body).toMatch(/this\.retryBackoffBaseMs = config\.retryBackoffBaseMs \?\? 60_000;/);
  });

  it('ScheduledJobRow: 7 fields with attempts + maxAttempts + accountId nullable + payload Record<string, unknown>', () => {
    expect(body).toMatch(/export interface ScheduledJobRow \{/);
    expect(body).toMatch(/jobType: string;/);
    expect(body).toMatch(/accountId: string \| null;/);
    expect(body).toMatch(/payload: Record<string, unknown>;/);
    expect(body).toMatch(/runAt: Date;/);
    expect(body).toMatch(/attempts: number;/);
    expect(body).toMatch(/maxAttempts: number;/);
  });

  it('dedupOnAccountAndType framing pinned: pending = completed_at IS NULL AND failed_at IS NULL; one pending job per account regardless of webhook re-fires', () => {
    expect(body).toMatch(
      /When true, `enqueue` no-ops if a pending job \(completed_at IS NULL\s*\n?\s*\*\s*AND failed_at IS NULL\) already exists with the same\s*\n?\s*\*\s*\(account_id, job_type\)\. Used to ensure one pending job per account\s*\n?\s*\*\s*regardless of how many times the triggering event re-fires\./,
    );
    expect(body).toMatch(/dedupOnAccountAndType\?: boolean;/);
    expect(body).toMatch(/dedupAfterRunAt\?: Date;/);
    expect(body).toMatch(/Self-arming handlers pass their current\s*\n?\s*\* job's runAt/);
    expect(body).toMatch(/leave unset for ordinary\/bootstrap enqueue/);
  });

  it('ScheduledJobsRepo: 5 methods (enqueue + claimDue + markComplete + markRetry + markFailed)', () => {
    expect(body).toMatch(/export interface ScheduledJobsRepo \{/);
    expect(body).toMatch(
      /enqueue\(input: EnqueueScheduledJobInput\): Promise<\{ enqueued: boolean \}>;/,
    );
    expect(body).toMatch(
      /claimDue\(opts: \{ batchSize: number; now: Date; workerId: string \}\): Promise<ScheduledJobRow\[\]>;/,
    );
    expect(body).toMatch(/markComplete\(jobId: string, at: Date\): Promise<void>;/);
    expect(body).toMatch(
      /markRetry\(jobId: string, opts: \{ lastError: string; nextRunAt: Date \}\): Promise<void>;/,
    );
    expect(body).toMatch(
      /markFailed\(jobId: string, opts: \{ lastError: string; at: Date \}\): Promise<void>;/,
    );
  });

  it('claimDue framing pinned: atomic + run_at <= now + not completed/failed + not locked + SELECT FOR UPDATE SKIP LOCKED required', () => {
    expect(body).toMatch(
      /Atomically claim up to `batchSize` due jobs \(run_at <= now,\s*\n?\s*\*\s*not yet completed\/failed, not currently locked\)\. Sets\s*\n?\s*\*\s*locked_by \+ locked_at \+ increments attempts\. The implementation\s*\n?\s*\*\s*MUST use SELECT \.\.\. FOR UPDATE SKIP LOCKED so concurrent workers\s*\n?\s*\*\s*never claim the same row\./,
    );
  });

  it('register: last-write-wins Map insert', () => {
    expect(body).toMatch(
      /\/\*\* Register a handler for a job_type\. Last-write-wins if called twice\. \*\/\s*\n?\s*register\(jobType: string, handler: ScheduledJobHandler\): void \{\s*\n?\s*this\.handlers\.set\(jobType, handler\);/,
    );
  });

  it('processTick: claims due → Promise.all dispatch → info-log on non-empty + returns processed count; early-return {processed:0} on empty', () => {
    expect(body).toMatch(
      /async processTick\(now: Date\): Promise<\{ processed: number \}> \{\s*\n?\s*const due = await this\.repo\.claimDue\(\{\s*\n?\s*batchSize: this\.batchSize,\s*\n?\s*now,\s*\n?\s*workerId: this\.workerId,\s*\n?\s*\}\);\s*\n?\s*if \(due\.length === 0\) return \{ processed: 0 \};/,
    );
    expect(body).toMatch(/await Promise\.all\(due\.map\(\(job\) => this\.runOne\(job, now\)\)\);/);
    expect(body).toMatch(/'scheduled-jobs tick processed due jobs',/);
    expect(body).toMatch(/jobTypes: Array\.from\(new Set\(due\.map\(\(j\) => j\.jobType\)\)\),/);
    expect(body).toMatch(/return \{ processed: due\.length \};/);
  });

  it('No-handler path: warn-log with operator guidance + markFailed with no-handler-registered error message', () => {
    expect(body).toMatch(
      /'no handler registered for job_type — marking failed \(operator should register or delete\)',/,
    );
    expect(body).toMatch(
      /await this\.repo\.markFailed\(job\.id, \{\s*\n?\s*lastError: `no handler registered for job_type=\$\{job\.jobType\}`,\s*\n?\s*at: now,\s*\n?\s*\}\);/,
    );
  });

  it('Exhausted-attempts: attempts >= maxAttempts → error-log + markFailed (not markRetry)', () => {
    expect(body).toMatch(/const exhausted = job\.attempts >= job\.maxAttempts;/);
    expect(body).toMatch(/if \(exhausted\) \{\s*\n?\s*this\.logger\.error\(/);
    expect(body).toMatch(/'job failed permanently — attempts exhausted',/);
    expect(body).toMatch(
      /await this\.repo\.markFailed\(job\.id, \{ lastError: message, at: now \}\);/,
    );
  });

  it('Exponential backoff: retryBackoffBaseMs * 2^(attempts-1) with Math.max(0, attempts-1) floor; 60s/120s/240s per default', () => {
    expect(body).toMatch(/\/\/ Exponential backoff: 60s, 120s, 240s, \.\.\. per default base\./);
    expect(body).toMatch(
      /const backoffMs = this\.retryBackoffBaseMs \* 2 \*\* Math\.max\(0, job\.attempts - 1\);/,
    );
    expect(body).toMatch(/const nextRunAt = new Date\(now\.getTime\(\) \+ backoffMs\);/);
  });

  it('Retry path: markRetry with lastError + nextRunAt; warn-log includes attempts + nextRunAt', () => {
    expect(body).toMatch(/'job failed — scheduling retry',/);
    expect(body).toMatch(
      /await this\.repo\.markRetry\(job\.id, \{ lastError: message, nextRunAt \}\);/,
    );
  });

  it('durable handler diagnostics use shared credential redaction with pre/post bounds', () => {
    expect(body).toMatch(/import \{ redactText \} from '\.\.\/lib\/redact-url\.js';/);
    expect(body).toMatch(/const SCHEDULED_JOB_ERROR_MAX_CHARS = 500;/);
    expect(body).toMatch(/const SCHEDULED_JOB_ERROR_PRE_REDACT_MAX_CHARS = 2_000;/);
    expect(body).toMatch(/const message = safeScheduledJobError\(err\);/);
    expect(body).toMatch(
      /return redactText\(raw\.slice\(0, SCHEDULED_JOB_ERROR_PRE_REDACT_MAX_CHARS\)\)\.slice\(/,
    );
  });

  it('imports: Logger from lib/logger', () => {
    expect(body).toMatch(/import type \{ Logger \} from '\.\.\/lib\/logger\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
