// W928 — V-541.E cost-nightly-job scheduled-recompute cross-source
// invariant. Two-hundred-fifty-fourth in the drift-guard series.
// Pins the nightly cost-recompute scheduled-job wiring:
//
//   V-541.E anchor — 'nightly cost-recompute scheduled-job wiring.
//   Registers a cost.recompute_nightly handler against the existing
//   V-202d ScheduledJobsService'.
//
//   COST_NIGHTLY_JOB_TYPE = 'cost.recompute_nightly'.
//
//   Account list pulled from pluggable AccountIdProvider (production
//   wires to accounts table; tests pass stub).
//
//   Each tick:
//     1. listAllAccountIds() → ids[].
//     2. Empty? log debug, re-enqueue tomorrow, return.
//     3. dispatcher.evaluate({ accountIds: ids, billingCycle:
//        billingCycleFromDate(tickStart) }).
//     4. Log info with accounts + alerts_fired + alerts_skipped.
//     5. Re-arm next run via enqueueNextNightlyRun.
//
//   enqueueNextNightlyRun framing — 'Idempotent via the
//   scheduled_jobs dedup flag: if there's already a pending row for
//   this job_type with account_id IS NULL, the enqueue is a no-op'.
//
//   runAt = nextMidnightUtc(now) — predictable wall-clock landing
//   for ops; strictly after `now`.
//
//   dedupOnAccountAndType: true plus optional dedupAfterRunAt — bootstrap
//   sees all pending rows; re-arms ignore current/older cohorts while still
//   collapsing future successors.
//
//   registerCostNightlyJob 'Idempotent: re-registering replaces the
//   previous handler' (matches V-202d register() last-write-wins).
//
// stays in lockstep across apps/server/src/services/cost-nightly-job.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COST_NIGHTLY_JOB_TYPE, nextMidnightUtc } from '../../src/services/cost-nightly-job.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W928 V-541.E cost-nightly-job cross-source invariant', () => {
  // ─── V-541.E anchor + V-202d wiring ──────────────────────────

  it("CRITICAL apps/server/src/services/cost-nightly-job.ts header pins V-541.E anchor — 'V-541.E — nightly cost-recompute scheduled-job wiring. Registers a cost.recompute_nightly handler against the existing V-202d ScheduledJobsService'. The V-541.E + V-202d wiring is the dependency-provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-nightly-job.ts'));
    expect(p).toMatch(/V-541\.E — nightly cost-recompute scheduled-job wiring/);
    expect(p).toMatch(/Registers a `cost\.recompute_nightly` handler against the existing/);
    expect(p).toMatch(/V-202d ScheduledJobsService/);
  });

  // ─── COST_NIGHTLY_JOB_TYPE constant ──────────────────────────

  it("CRITICAL COST_NIGHTLY_JOB_TYPE = 'cost.recompute_nightly'. The exact slug is what the scheduled-jobs table indexes; drift would orphan the handler from the queue.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-nightly-job.ts'));
    expect(p).toMatch(/export const COST_NIGHTLY_JOB_TYPE = 'cost\.recompute_nightly';/);
    expect(COST_NIGHTLY_JOB_TYPE).toBe('cost.recompute_nightly');
  });

  // ─── AccountIdProvider pluggable contract ────────────────────

  it('CRITICAL AccountIdProvider has 1 method — listAllAccountIds(): Promise<readonly string[]>. The 1-method pluggable provider lets production wire to accounts table while tests stub.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-nightly-job.ts'));
    expect(p).toMatch(/export interface AccountIdProvider \{/);
    expect(p).toMatch(/Return the full set of account ids to evaluate in this tick/);
    expect(p).toMatch(/listAllAccountIds\(\): Promise<readonly string\[\]>;/);
  });

  // ─── RegisterCostNightlyJobOpts shape ────────────────────────

  it('CRITICAL RegisterCostNightlyJobOpts has 5+1 fields — scheduledJobs + service + dispatcher + accounts + logger + nowFn (optional test seam). The 5-DI surface explicitly names every dependency; nowFn defaults to Date.now.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-nightly-job.ts'));
    expect(p).toMatch(/export interface RegisterCostNightlyJobOpts \{/);
    expect(p).toMatch(/scheduledJobs: ScheduledJobsService;/);
    expect(p).toMatch(/service: CostMonitoringService;/);
    expect(p).toMatch(/dispatcher: CostAlertDispatcher;/);
    expect(p).toMatch(/accounts: AccountIdProvider;/);
    expect(p).toMatch(/logger: Logger;/);
    expect(p).toMatch(/Test seam — defaults to `Date\.now`/);
    expect(p).toMatch(/nowFn\?: \(\) => number;/);
  });

  // ─── registerCostNightlyJob idempotence framing ──────────────

  it("CRITICAL registerCostNightlyJob JSDoc pins 'Wire the nightly-recompute handler onto the ScheduledJobsService. Idempotent: re-registering replaces the previous handler'. The idempotent contract matches V-202d register() last-write-wins.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-nightly-job.ts'));
    expect(p).toMatch(/Wire the nightly-recompute handler onto the ScheduledJobsService/);
    expect(p).toMatch(/Idempotent: re-registering replaces the previous handler/);
  });

  // ─── 5-step tick semantics ───────────────────────────────────

  it('CRITICAL tick semantics pinned — listAllAccountIds → empty/log+re-enqueue OR dispatcher.evaluate → log info → re-arm next via enqueueNextNightlyRun. The 5-step tick is what the nightly handler does.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-nightly-job.ts'));
    expect(p).toMatch(/const ids = await opts\.accounts\.listAllAccountIds\(\);/);
    expect(p).toMatch(/if \(ids\.length === 0\)/);
    expect(p).toMatch(/Even with zero accounts, re-enqueue tomorrow/);
    expect(p).toMatch(/await opts\.dispatcher\.evaluate\(\{/);
    expect(p).toMatch(/Re-arm the next run/);
    expect(p).toMatch(
      /await enqueueNextNightlyRun\(\{[\s\S]*?scheduledJobs: opts\.scheduledJobs,[\s\S]*?nowFn: now,[\s\S]*?currentRunAt: job\.runAt,[\s\S]*?\}\);/,
    );
  });

  it('CRITICAL dispatcher.evaluate args — accountIds: ids + billingCycle: billingCycleFromDate(cycleAnchorForTick(tickStart)). C12: the cycle is anchored to the just-ended day so a month-end run evaluates the completed cycle, not the empty new one.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-nightly-job.ts'));
    expect(p).toMatch(/accountIds: ids,/);
    expect(p).toMatch(/billingCycle: billingCycleFromDate\(cycleAnchorForTick\(tickStart\)\),/);
  });

  // ─── Info log fields ─────────────────────────────────────────

  it("CRITICAL info log carries 4 fields — component: 'cost-nightly' + accounts (count) + alerts_fired + alerts_skipped. The 4-field telemetry is the dashboard contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-nightly-job.ts'));
    expect(p).toMatch(/component: 'cost-nightly',/);
    expect(p).toMatch(/accounts: ids\.length,/);
    expect(p).toMatch(/alerts_fired: result\.alertsFired,/);
    expect(p).toMatch(/alerts_skipped: result\.alertsSkipped,/);
    expect(p).toMatch(/'cost nightly recompute complete'/);
  });

  // ─── enqueueNextNightlyRun idempotence + V-202d dedup ────────

  it("CRITICAL enqueueNextNightlyRun JSDoc pins 'Idempotent via the scheduled_jobs dedup flag: if there's already a pending row for this job_type with account_id IS NULL, the enqueue is a no-op'. The (job_type, account_id IS NULL) dedup is the V-202d primitive.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-nightly-job.ts'));
    expect(p).toMatch(/Enqueue the next nightly run\. Idempotent via the scheduled_jobs/);
    expect(p).toMatch(/dedup flag: if there's already a pending row for this job_type/);
    expect(p).toMatch(/with account_id IS NULL, the enqueue is a no-op/);
  });

  it('CRITICAL enqueueNextNightlyRun always dedups and optionally limits matches to future successors', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-nightly-job.ts'));
    expect(p).toMatch(/jobType: COST_NIGHTLY_JOB_TYPE,/);
    expect(p).toMatch(/accountId: null,/);
    expect(p).toMatch(/payload: \{\},/);
    expect(p).toMatch(/runAt: nextMidnightUtc\(new Date\(now\)\),/);
    expect(p).toMatch(/currentRunAt\?: Date;/);
    expect(p).toMatch(/dedupOnAccountAndType: true,/);
    expect(p).toMatch(/dedupAfterRunAt: opts\.currentRunAt/);
  });

  // ─── nextMidnightUtc semantics + runtime ─────────────────────

  it("CRITICAL nextMidnightUtc JSDoc — 'Returns the next UTC midnight strictly after now. Used so the nightly run lands at a predictable wall-clock time for ops'. The predictable-wall-clock framing is the ops-visibility decision.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-nightly-job.ts'));
    expect(p).toMatch(/Returns the next UTC midnight strictly after `now`\. Used so the/);
    expect(p).toMatch(/nightly run lands at a predictable wall-clock time for ops/);
  });

  it('CRITICAL nextMidnightUtc impl — setUTCHours(0,0,0,0) then setUTCDate(getUTCDate()+1). The 2-step normalization handles end-of-month + DST without branching.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-nightly-job.ts'));
    expect(p).toMatch(/next\.setUTCHours\(0, 0, 0, 0\);/);
    expect(p).toMatch(/next\.setUTCDate\(next\.getUTCDate\(\) \+ 1\);/);
  });

  it('CRITICAL nextMidnightUtc runtime — mid-day input rolls to next midnight. May 15 12:30 UTC → May 16 00:00 UTC.', () => {
    const next = nextMidnightUtc(new Date('2026-05-15T12:30:00Z'));
    expect(next.toISOString()).toBe('2026-05-16T00:00:00.000Z');
  });

  it("CRITICAL nextMidnightUtc runtime — midnight-input STILL rolls to next day. The 'strictly after now' contract means May 15 00:00 → May 16 00:00 (not May 15).", () => {
    const next = nextMidnightUtc(new Date('2026-05-15T00:00:00Z'));
    expect(next.toISOString()).toBe('2026-05-16T00:00:00.000Z');
  });

  it('CRITICAL nextMidnightUtc end-of-month rollover — May 31 23:59 → Jun 1 00:00. The Date arithmetic handles month-rollover natively.', () => {
    const next = nextMidnightUtc(new Date('2026-05-31T23:59:00Z'));
    expect(next.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('CRITICAL nextMidnightUtc end-of-year rollover — Dec 31 23:59 → Jan 1 00:00 of next year. The native JS Date math handles year-boundary.', () => {
    const next = nextMidnightUtc(new Date('2026-12-31T23:59:00Z'));
    expect(next.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  // ─── Bootstrap cadence framing ───────────────────────────────

  it("CRITICAL cadence framing — 'bootstrap calls enqueueNextNightlyRun() on app start and after each successful run. Re-enqueue is idempotent via the V-202d dedup-on-account-and-type flag (job_type cost.recompute_nightly, account_id null)'. The boot+after-run cadence guarantees the nightly never falls off the schedule.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-nightly-job.ts'));
    expect(p).toMatch(/Cadence: bootstrap calls `enqueueNextNightlyRun\(\)` on app start/);
    expect(p).toMatch(/and after each successful run\. Re-enqueue is idempotent via the/);
    expect(p).toMatch(/V-202d dedup-on-account-and-type flag/);
    expect(p).toMatch(/\(job_type 'cost\.recompute_/);
    expect(p).toMatch(/nightly', account_id null\)/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/cost-nightly-job-v541e-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
