// W915 — V-202d ScheduledJobs dispatcher cross-source invariant.
// Two-hundred-forty-first in the drift-guard series. Pins the
// generic time-shifted job dispatcher contract:
//
//   V-202d anchor — 'generic time-shifted job dispatcher built on
//   the scheduled_jobs table' (founder verdict 2026-05-05; V-173-
//   pattern extension).
//
//   Bootstrap setInterval poller calls processTick(now); service:
//     1. Claims due jobs via SELECT ... FOR UPDATE SKIP LOCKED.
//     2. Dispatches each to registered handler keyed by job_type.
//     3. Marks complete (or retries on transient failure / fails
//        permanently when attempts exhaust).
//
//   ScheduledJobRow (7 fields): id + jobType + accountId (nullable)
//     + payload + runAt + attempts + maxAttempts.
//
//   ScheduledJobsServiceConfig defaults:
//     - batchSize: 25 jobs per tick.
//     - retryBackoffBaseMs: 60_000 (60s).
//     - workerId: required (no default).
//
//   Backoff schedule: 60s, 120s, 240s, ... = base * 2^(attempts-1).
//
//   dedupOnAccountAndType — one pending job per (account_id, job_type),
//     used by trial-pack expiry to dedupe re-fires.
//
//   No-handler branch: mark failed + log warn 'no handler registered
//     for job_type — marking failed (operator should register or
//     delete)'.
//
//   Future-consumers framing: 'subscription renewal reminders, usage
//     rollups, cleanup jobs' just register a handler — no new table.
//
// stays in lockstep across apps/server/src/services/scheduled-jobs.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W915 V-202d ScheduledJobs dispatcher cross-source invariant', () => {
  // ─── V-202d anchor + founder-verdict provenance ──────────────

  it("CRITICAL apps/server/src/services/scheduled-jobs.ts header pins V-202d anchor — 'V-202d — generic time-shifted job dispatcher built on the scheduled_jobs table. Per founder verdict (2026-05-05), V-173-pattern extension'. The V-202d + 2026-05-05 founder-verdict are the policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/scheduled-jobs.ts'));
    expect(p).toMatch(/V-202d — generic time-shifted job dispatcher built on the/);
    expect(p).toMatch(/`scheduled_jobs` table\. Per founder verdict \(2026-05-05\)/);
    expect(p).toMatch(/V-173-pattern extension/);
  });

  // ─── processTick + SKIP LOCKED claim framing ─────────────────

  it("CRITICAL header pins 'bootstrap runs setInterval poller that calls processTick(now)'. The setInterval+processTick(now) pattern is the same V-173 cadence used by health-probe + cost-aggregator.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/scheduled-jobs.ts'));
    expect(p).toMatch(/bootstrap runs setInterval poller that\s*\n\/\/ calls `processTick\(now\)`/);
  });

  it("CRITICAL header pins 'SELECT ... FOR UPDATE SKIP LOCKED' claim pattern. The SKIP LOCKED is what makes the dispatcher horizontally-scalable — multiple workers can claim disjoint job sets without lock contention.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/scheduled-jobs.ts'));
    expect(p).toMatch(/SELECT \.\.\. FOR UPDATE SKIP LOCKED/);
  });

  // ─── ScheduledJobRow 7-field shape ───────────────────────────

  it('CRITICAL ScheduledJobRow has 7 fields — id + jobType + accountId (nullable) + payload + runAt + attempts + maxAttempts. The 7-field shape is what claimDue() returns to the dispatcher.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/scheduled-jobs.ts'));
    expect(p).toMatch(/export interface ScheduledJobRow \{/);
    expect(p).toMatch(/id: string;/);
    expect(p).toMatch(/jobType: string;/);
    expect(p).toMatch(/accountId: string \| null;/);
    expect(p).toMatch(/payload: Record<string, unknown>;/);
    expect(p).toMatch(/runAt: Date;/);
    expect(p).toMatch(/attempts: number;/);
    expect(p).toMatch(/maxAttempts: number;/);
  });

  // ─── Defaults: batchSize 25 + backoff 60s ────────────────────

  it('CRITICAL ScheduledJobsServiceConfig defaults — batchSize: 25 per tick + retryBackoffBaseMs: 60_000 (60s). The 25-per-tick batch + 60s base are the V-202d cadence defaults.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/scheduled-jobs.ts'));
    expect(p).toMatch(/this\.batchSize = config\.batchSize \?\? 25;/);
    expect(p).toMatch(/this\.retryBackoffBaseMs = config\.retryBackoffBaseMs \?\? 60_000;/);
  });

  it('CRITICAL workerId is REQUIRED — no default. The required field forces wiring a stable identifier — drift to optional would let workers run with anonymous lock holders (un-debuggable SKIP LOCKED contention).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/scheduled-jobs.ts'));
    expect(p).toMatch(/Identifier for this worker process; written to locked_by/);
    expect(p).toMatch(/workerId: string;/);
    expect(p).toMatch(/this\.workerId = config\.workerId;/);
  });

  // ─── Exponential backoff = base * 2^(attempts-1) ─────────────

  it("CRITICAL retryBackoffBaseMs comment pins 'Backoff for retries: ms = base * 2^(attempts-1)'. The exponential formula is what spreads retry storms — 60s → 120s → 240s → 480s → ... rather than fixed-interval retry.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/scheduled-jobs.ts'));
    expect(p).toMatch(/Backoff for retries: ms = base \* 2\^\(attempts-1\)/);
  });

  it("CRITICAL backoff impl framing — 'Exponential backoff: 60s, 120s, 240s, ... per default base'. The 60/120/240 sequence is what the inline comment documents AND what the runtime computes.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/scheduled-jobs.ts'));
    expect(p).toMatch(/Exponential backoff: 60s, 120s, 240s, \.\.\. per default base/);
    expect(p).toMatch(
      /const backoffMs = this\.retryBackoffBaseMs \* 2 \*\* Math\.max\(0, job\.attempts - 1\);/,
    );
  });

  it('CRITICAL backoff sequence math — attempts=1 → 60s, attempts=2 → 120s, attempts=3 → 240s, attempts=4 → 480s. The doubling per attempt is what the inline comment promises.', () => {
    const base = 60_000;
    const backoff = (attempts: number): number => base * 2 ** Math.max(0, attempts - 1);
    expect(backoff(1)).toBe(60_000);
    expect(backoff(2)).toBe(120_000);
    expect(backoff(3)).toBe(240_000);
    expect(backoff(4)).toBe(480_000);
  });

  // ─── dedupOnAccountAndType ───────────────────────────────────

  it("CRITICAL EnqueueScheduledJobInput.dedupOnAccountAndType comment pins 'enqueue no-ops if a pending job (completed_at IS NULL AND failed_at IS NULL) already exists with the same (account_id, job_type). Used to ensure one pending job per account regardless of how many times the triggering event re-fires'. The 2-column dedup is what makes the dispatcher idempotent under event re-fires.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/scheduled-jobs.ts'));
    expect(p).toMatch(
      /When true, `enqueue` no-ops if a pending job \(completed_at IS NULL\s*\n\s*\*\s*AND failed_at IS NULL\) already exists with the same/,
    );
    expect(p).toMatch(/\(account_id, job_type\)\. Used to ensure one pending job per account/);
    expect(p).toMatch(/regardless of how many times the triggering event re-fires/);
  });

  // ─── Consumer-registration + no-new-table framing ────────────

  it("CRITICAL header pins the consumer model — 'Consumers register a handler keyed by job_type and enqueue rows — no new table per consumer. Live consumers: auth_tokens.sweep / sessions.duration_sweep / cost.recompute_nightly. Each self-re-arms by enqueuing its next run from its own handler'. (The trial_pack.expired first-consumer was removed with the dead trial_pack lifecycle.)", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/scheduled-jobs.ts'));
    expect(p).toMatch(/Consumers register a handler keyed by job_type and enqueue rows/);
    expect(p).toMatch(/no new table per consumer/);
    expect(p).toMatch(/`auth_tokens\.sweep`/);
    expect(p).toMatch(/`sessions\.duration_sweep`/);
    expect(p).toMatch(/`cost\.recompute_nightly`/);
    expect(p).toMatch(/Each self-re-arms by enqueuing its next run from its own/);
    // Trial-pack job framing removed — assert GONE so it can't regress.
    expect(p).not.toMatch(/First consumer: trial-pack expiry/);
    expect(p).not.toMatch(/trial_pack\.expired/);
  });

  // ─── No-handler-registered branch ────────────────────────────

  it("CRITICAL no-handler-registered branch — log warn 'no handler registered for job_type — marking failed (operator should register or delete)' + repo.markFailed. The operator-prompt framing surfaces the orphan-job-type as ops-actionable.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/scheduled-jobs.ts'));
    expect(p).toMatch(
      /no handler registered for job_type — marking failed \(operator should register or delete\)/,
    );
    expect(p).toMatch(/lastError: `no handler registered for job_type=\$\{job\.jobType\}`/);
  });

  // ─── Exhaustion + permanent-failure log ──────────────────────

  it("CRITICAL exhausted-attempts branch — 'const exhausted = job.attempts >= job.maxAttempts' + log error 'job failed permanently — attempts exhausted' + markFailed. The exhaustion check is what prevents infinite retry of permanently-broken handlers.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/scheduled-jobs.ts'));
    expect(p).toMatch(/const exhausted = job\.attempts >= job\.maxAttempts;/);
    expect(p).toMatch(/job failed permanently — attempts exhausted/);
  });

  it('CRITICAL retry and terminal last_error share a bounded credential-safe diagnostic', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/scheduled-jobs.ts'));
    expect(p).toMatch(/const SCHEDULED_JOB_ERROR_MAX_CHARS = 500;/);
    expect(p).toMatch(/const message = safeScheduledJobError\(err\);/);
    expect(p).toMatch(/markFailed\(job\.id, \{ lastError: message, at: now \}\)/);
    expect(p).toMatch(/markRetry\(job\.id, \{ lastError: message, nextRunAt \}\)/);
  });

  // ─── register() last-write-wins ──────────────────────────────

  it("CRITICAL register(jobType, handler) is 'Last-write-wins if called twice'. The last-write-wins lets tests + hot-reload override handlers without explicit teardown.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/scheduled-jobs.ts'));
    expect(p).toMatch(/Register a handler for a job_type\. Last-write-wins if called twice/);
    expect(p).toMatch(
      /register\(jobType: string, handler: ScheduledJobHandler\): void \{\s*\n\s*this\.handlers\.set\(jobType, handler\);/,
    );
  });

  // ─── processTick returns count of jobs processed ─────────────

  it("CRITICAL processTick returns { processed: number } — 'count of jobs processed (claimed + dispatched), useful for tests + ops metrics'. The count is the observability seam — drift would make the dispatcher silent under load.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/scheduled-jobs.ts'));
    expect(p).toMatch(
      /Claims due jobs, runs handlers, marks each\s*\n\s*\*\s*complete \/ retry \/ failed\. Returns the count of jobs processed/,
    );
    expect(p).toMatch(/\(claimed \+ dispatched\), useful for tests \+ ops metrics/);
    expect(p).toMatch(/async processTick\(now: Date\): Promise<\{ processed: number \}> \{/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/scheduled-jobs-dispatcher-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
