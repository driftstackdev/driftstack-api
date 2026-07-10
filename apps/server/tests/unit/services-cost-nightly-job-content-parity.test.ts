// W397.A — drift guard for apps/server/src/services/cost-nightly-job.ts.
// V-541.E nightly cost-recompute scheduled-job wiring. Closes the
// V-541 cluster: W396 covered V-541.B/H/C (monitoring/aggregator/
// alert-dispatcher); this is the job runner that ties them together
// via V-202d ScheduledJobsService. Drift here either silently stops
// nightly cost recomputes (re-arm step missed) or duplicates them
// (dedup flag dropped).
//
//   • V-541.E framing + V-202d ScheduledJobsService integration.
//   • COST_NIGHTLY_JOB_TYPE = 'cost.recompute_nightly'.
//   • Idempotent re-enqueue via dedupOnAccountAndType (job_type +
//     account_id=null).
//   • AccountIdProvider interface (pluggable: prod = accounts table,
//     tests = stub).
//   • registerCostNightlyJob: tick=listAllAccountIds → evaluate →
//     structured log → re-arm via enqueueNextNightlyRun.
//   • Zero-accounts branch: still re-enqueue tomorrow.
//   • enqueueNextNightlyRun: dedupOnAccountAndType=true, accountId
//     null, runAt=next UTC midnight.
//   • nextMidnightUtc: setUTCHours(0,0,0,0) + setUTCDate(+1) — strict
//     "next" semantics, predictable wall-clock time for ops.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/cost-nightly-job.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W397.A apps/server/src/services/cost-nightly-job.ts content parity', () => {
  const body = read(LIB);

  it('V-541.E framing + V-202d ScheduledJobsService registration pinned', () => {
    expect(body).toMatch(/V-541\.E — nightly cost-recompute scheduled-job wiring\./);
    expect(body).toMatch(
      /Registers a `cost\.recompute_nightly` handler against the existing\s*\n?\s*\/\/\s*V-202d ScheduledJobsService/,
    );
  });

  it('AccountIdProvider framing: pluggable provider (prod=accounts table, tests=stub)', () => {
    expect(body).toMatch(
      /Pulls the account list to evaluate\s*\n?\s*\/\/\s*from a pluggable provider \(production wires it to the accounts\s*\n?\s*\/\/\s*table; tests pass a stub\)/,
    );
  });

  it('Cadence framing: bootstrap kicks off + each successful tick re-enqueues; idempotent via dedup-on-account-and-type', () => {
    expect(body).toMatch(
      /Cadence: bootstrap calls `enqueueNextNightlyRun\(\)` on app start\s*\n?\s*\/\/\s*and after each successful run\. Re-enqueue is idempotent via the\s*\n?\s*\/\/\s*V-202d dedup-on-account-and-type flag \(job_type 'cost\.recompute_\s*\n?\s*\/\/\s*nightly', account_id null\)/,
    );
  });

  it('COST_NIGHTLY_JOB_TYPE constant: "cost.recompute_nightly"', () => {
    expect(body).toMatch(/export const COST_NIGHTLY_JOB_TYPE = 'cost\.recompute_nightly';/);
  });

  it('AccountIdProvider: listAllAccountIds returns readonly string[]', () => {
    expect(body).toMatch(
      /export interface AccountIdProvider \{\s*\n?\s*\/\*\* Return the full set of account ids to evaluate in this tick\. \*\/\s*\n?\s*listAllAccountIds\(\): Promise<readonly string\[\]>;\s*\n?\s*\}/,
    );
  });

  it('RegisterCostNightlyJobOpts: 6 fields (scheduledJobs / service / dispatcher / accounts / logger / nowFn? test seam)', () => {
    expect(body).toMatch(/export interface RegisterCostNightlyJobOpts \{/);
    expect(body).toMatch(/scheduledJobs: ScheduledJobsService;/);
    expect(body).toMatch(/service: CostMonitoringService;/);
    expect(body).toMatch(/dispatcher: CostAlertDispatcher;/);
    expect(body).toMatch(/accounts: AccountIdProvider;/);
    expect(body).toMatch(/logger: Logger;/);
    expect(body).toMatch(/Test seam — defaults to `Date\.now`\./);
    expect(body).toMatch(/nowFn\?: \(\) => number;/);
  });

  it('registerCostNightlyJob: idempotent re-register replaces previous handler', () => {
    expect(body).toMatch(
      /Wire the nightly-recompute handler onto the ScheduledJobsService\.\s*\n?\s*\*\s*Idempotent: re-registering replaces the previous handler\./,
    );
    expect(body).toMatch(
      /opts\.scheduledJobs\.register\(COST_NIGHTLY_JOB_TYPE, async \(_job: ScheduledJobRow\) => \{/,
    );
  });

  it('Tick body: listAllAccountIds → evaluate(ids, billingCycle) → info log + re-arm', () => {
    expect(body).toMatch(/const tickStart = new Date\(now\(\)\);/);
    expect(body).toMatch(/const ids = await opts\.accounts\.listAllAccountIds\(\);/);
    expect(body).toMatch(
      /const result = await opts\.dispatcher\.evaluate\(\{\s*\n?\s*accountIds: ids,[\s\S]*?billingCycle: billingCycleFromDate\(cycleAnchorForTick\(tickStart\)\),\s*\n?\s*\}\);/,
    );
    // W378 — log now also carries alerts_errored (+ alert_errors when >0) so a
    // per-account-isolated send failure surfaces here instead of killing the chain.
    expect(body).toMatch(
      /opts\.logger\.info\?\.\(\s*\n?\s*\{\s*\n?\s*component: 'cost-nightly',\s*\n?\s*accounts: ids\.length,\s*\n?\s*alerts_fired: result\.alertsFired,\s*\n?\s*alerts_skipped: result\.alertsSkipped,[\s\S]*?alerts_errored: result\.alertsErrored,[\s\S]*?\},\s*\n?\s*'cost nightly recompute complete',\s*\n?\s*\);/,
    );
    // Re-arm path enqueues with dedup OFF — the in-flight, still-locked
    // current job would otherwise trip the dedup check and kill the chain.
    expect(body).toMatch(/\/\/ Re-arm the next run\./);
    expect(body).toMatch(
      /await enqueueNextNightlyRun\(\{ scheduledJobs: opts\.scheduledJobs, nowFn: now, dedup: false \}\);/,
    );
  });

  it('Zero-accounts branch: debug log + still re-enqueue tomorrow (dedup OFF)', () => {
    expect(body).toMatch(/if \(ids\.length === 0\) \{/);
    expect(body).toMatch(
      /opts\.logger\.debug\?\.\(\{ component: 'cost-nightly' \}, 'no accounts to evaluate'\);/,
    );
    // Zero-accounts is also a re-arm path → dedup:false (chain must survive
    // the in-flight job even when there's nothing to evaluate).
    expect(body).toMatch(/\/\/ Even with zero accounts, re-enqueue tomorrow\./);
    // The chain-survival try/catch deepened this branch's indentation, so
    // prettier wraps the zero-accounts re-arm across lines (semantics identical).
    expect(body).toMatch(
      /await enqueueNextNightlyRun\(\{\s*\n?\s*scheduledJobs: opts\.scheduledJobs,\s*\n?\s*nowFn: now,\s*\n?\s*dedup: false,\s*\n?\s*\}\);\s*\n?\s*return;/,
    );
  });

  it('enqueueNextNightlyRun: dedupOnAccountAndType=opts.dedup ?? true (parameterized), accountId=null, runAt=nextMidnightUtc(now), payload={}', () => {
    expect(body).toMatch(
      /Enqueue the next nightly run\. Idempotent via the scheduled_jobs\s*\n?\s*\*\s*dedup flag: if there's already a pending row for this job_type\s*\n?\s*\*\s*with account_id IS NULL, the enqueue is a no-op\./,
    );
    // dedup is now parameterized: true (default) for bootstrap, false for the
    // in-handler re-arm so the still-locked current job can't block re-enqueue.
    expect(body).toMatch(/dedup\?: boolean;/);
    expect(body).toMatch(
      /return opts\.scheduledJobs\.enqueue\(\{\s*\n?\s*jobType: COST_NIGHTLY_JOB_TYPE,\s*\n?\s*accountId: null,\s*\n?\s*payload: \{\},\s*\n?\s*runAt: nextMidnightUtc\(new Date\(now\)\),\s*\n?\s*dedupOnAccountAndType: opts\.dedup \?\? true,\s*\n?\s*\}\);/,
    );
  });

  it('nextMidnightUtc: setUTCHours(0,0,0,0) + setUTCDate(+1) — strictly after now, predictable wall-clock', () => {
    expect(body).toMatch(
      /Returns the next UTC midnight strictly after `now`\. Used so the\s*\n?\s*\*\s*nightly run lands at a predictable wall-clock time for ops\./,
    );
    expect(body).toMatch(
      /export function nextMidnightUtc\(now: Date\): Date \{\s*\n?\s*const next = new Date\(now\.getTime\(\)\);\s*\n?\s*next\.setUTCHours\(0, 0, 0, 0\);\s*\n?\s*next\.setUTCDate\(next\.getUTCDate\(\) \+ 1\);\s*\n?\s*return next;\s*\n?\s*\}/,
    );
  });

  it('imports: CostAlertDispatcher + billingCycleFromDate/CostMonitoringService + ScheduledJobsService + Logger', () => {
    expect(body).toMatch(
      /import type \{ CostAlertDispatcher \} from '\.\/cost-alert-dispatcher\.js';/,
    );
    expect(body).toMatch(
      /import \{ billingCycleFromDate, type CostMonitoringService \} from '\.\/cost-monitoring\.js';/,
    );
    expect(body).toMatch(
      /import type \{ ScheduledJobsService, ScheduledJobRow \} from '\.\/scheduled-jobs\.js';/,
    );
    expect(body).toMatch(/import type \{ Logger \} from '\.\.\/lib\/logger\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
