// The three background jobs that keep monthly AI credits granted and expired
// without anyone asking. Every one of them does its work by calling
// `refreshCredits`, which is idempotent, so a job that runs twice, late, or
// beside a billing event grants and expires exactly what one run would.
//
//   credits.window_boundary   one per account, due when that account's current
//                             window ENDS. It grants the next month the moment
//                             the old one is over. A renewal is often paid a
//                             little after its period starts, so when the next
//                             month is not paid for yet it looks again every 5
//                             minutes, for 24 hours, and then stops: the paid
//                             invoice's own event, and the sweep below, still
//                             grant it whenever it is paid.
//   credits.coverage_sweep    every 15 minutes: every account whose paid
//                             coverage earns a window right now and that has
//                             none. The backstop for an event that never came.
//   credits.expiry_sweep      every hour: every account holding a lot whose term
//                             has ended with credit still in it, ONE ACCOUNT AT
//                             A TIME, each under its own credit lock. Expired
//                             credit is already unspendable (every reader checks
//                             the term); this writes the ledger row that says so.
//
// ⛔ REGISTERED ONLY WHILE AI CREDITS ARE SWITCHED ON. Bootstrap registers and
// seeds these inside `if (creditGrants !== null)`, and `creditGrants` is null
// while DRIFTSTACK_AI_CREDITS_MODE is off. With it off no handler exists, no
// row is enqueued and nothing here runs.
//
// The two sweeps are self-re-arming chains like every other sweep in this
// server: a thrown tick is logged and SWALLOWED, then re-armed once, after the
// catch (see every-job-chain-rearms-on-a-throwing-tick for why neither
// re-throwing nor re-arming inside `try` is safe). Each walks accounts in id
// order from a cursor carried in its own payload, so an account that fails every
// time cannot hold the head of the queue: the walk moves past it and wraps.
//
// `credits.window_boundary` is NOT such a chain. It is started by an event (a
// window being granted), not at boot, and it has no pending row at all while no
// account has a window — so it is absent from the liveness roster on purpose
// (`EVENT_STARTED_JOB_TYPES` in job-chain-liveness.ts says why).

import type { PgInstant } from '../db/credit-windows-repo.js';
import { firstMillisecondAtOrAfter } from '../db/credit-windows-repo.js';
import type { Logger } from '../lib/logger.js';
import type { CreditsRefreshResult, CreditSweepResult } from './credit-grants.js';
import { CREDITS_INVARIANT_AUDIT_JOB_TYPE } from './credit-invariant-audit.js';
import type { ScheduledJobRow, ScheduledJobsService } from './scheduled-jobs.js';

export const CREDITS_WINDOW_BOUNDARY_JOB_TYPE = 'credits.window_boundary';
export const CREDITS_COVERAGE_SWEEP_JOB_TYPE = 'credits.coverage_sweep';
export const CREDITS_EXPIRY_SWEEP_JOB_TYPE = 'credits.expiry_sweep';

/**
 * The recurring chains, for the liveness gauge's "not run here" set while
 * credits are off. The daily invariant audit (S9, `credit-invariant-audit.ts`)
 * belongs here too: it is registered and seeded under the same switch, so with
 * the mode off it has no pending row and the gauge must omit it rather than
 * report a dead chain.
 */
export const CREDITS_RECURRING_JOB_TYPES: readonly string[] = [
  CREDITS_COVERAGE_SWEEP_JOB_TYPE,
  CREDITS_EXPIRY_SWEEP_JOB_TYPE,
  CREDITS_INVARIANT_AUDIT_JOB_TYPE,
];

export const CREDITS_COVERAGE_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
export const CREDITS_EXPIRY_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** A full batch means more accounts are waiting: come back soon rather than in a full interval. */
export const CREDITS_SWEEP_BACKLOG_DELAY_MS = 10 * 1000;
/** Accounts one sweep tick visits. */
export const CREDITS_SWEEP_BATCH_LIMIT = 200;
/** How often the boundary job looks again while the next month is not paid for yet. */
export const CREDITS_WINDOW_BOUNDARY_RETRY_MS = 5 * 60 * 1000;
/** How long after a window's end it keeps looking. */
export const CREDITS_WINDOW_BOUNDARY_GIVE_UP_MS = 24 * 60 * 60 * 1000;

/** What the jobs need of the grants service. */
export interface CreditGrantJobsTarget {
  refreshCredits(accountId: string): Promise<CreditsRefreshResult>;
  sweepCoverage(opts: { afterAccountId: string | null; limit: number }): Promise<CreditSweepResult>;
  sweepExpiry(opts: { afterAccountId: string | null; limit: number }): Promise<CreditSweepResult>;
}

interface RegisterOpts {
  scheduledJobs: ScheduledJobsService;
  grants: CreditGrantJobsTarget;
  logger?: Logger;
  nowFn?: () => number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The walk's cursor from a sweep row's payload: an account id, or null to start over. */
export function readSweepCursor(payload: Record<string, unknown>): string | null {
  const after = payload.after_account_id;
  return typeof after === 'string' && UUID_RE.test(after) ? after : null;
}

/** When the window this boundary row stands for ended, from its payload; null if unreadable. */
export function readBoundaryAt(payload: Record<string, unknown>): number | null {
  const at = payload.boundary_at;
  if (typeof at !== 'string') return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

export function registerCreditsCoverageSweepJob(opts: RegisterOpts): void {
  const now = opts.nowFn ?? Date.now;
  opts.scheduledJobs.register(CREDITS_COVERAGE_SWEEP_JOB_TYPE, async (job: ScheduledJobRow) => {
    let swept: CreditSweepResult | null = null;
    try {
      swept = await opts.grants.sweepCoverage({
        afterAccountId: readSweepCursor(job.payload),
        limit: CREDITS_SWEEP_BATCH_LIMIT,
      });
      if (swept.visited > 0) {
        opts.logger?.info?.(
          { component: 'credit-grants', event: 'credits_coverage_sweep_tick', ...swept },
          'credits coverage sweep tick',
        );
      }
    } catch (err) {
      opts.logger?.error?.(
        {
          component: 'credit-grants',
          event: 'credits_coverage_sweep_tick_failed',
          err: { message: errorMessage(err) },
        },
        'credits coverage sweep tick failed — re-arming; accounts retry next tick',
      );
    }
    await enqueueNextCreditsCoverageSweep({
      scheduledJobs: opts.scheduledJobs,
      nowFn: now,
      currentRunAt: job.runAt,
      afterAccountId: swept?.nextAfterAccountId ?? null,
    });
  });
}

export function registerCreditsExpirySweepJob(opts: RegisterOpts): void {
  const now = opts.nowFn ?? Date.now;
  opts.scheduledJobs.register(CREDITS_EXPIRY_SWEEP_JOB_TYPE, async (job: ScheduledJobRow) => {
    let swept: CreditSweepResult | null = null;
    try {
      swept = await opts.grants.sweepExpiry({
        afterAccountId: readSweepCursor(job.payload),
        limit: CREDITS_SWEEP_BATCH_LIMIT,
      });
      if (swept.visited > 0) {
        opts.logger?.info?.(
          { component: 'credit-grants', event: 'credits_expiry_sweep_tick', ...swept },
          'credits expiry sweep tick',
        );
      }
    } catch (err) {
      opts.logger?.error?.(
        {
          component: 'credit-grants',
          event: 'credits_expiry_sweep_tick_failed',
          err: { message: errorMessage(err) },
        },
        'credits expiry sweep tick failed — re-arming; lots retry next tick',
      );
    }
    await enqueueNextCreditsExpirySweep({
      scheduledJobs: opts.scheduledJobs,
      nowFn: now,
      currentRunAt: job.runAt,
      afterAccountId: swept?.nextAfterAccountId ?? null,
    });
  });
}

/**
 * The boundary handler: refresh the account, then arm the NEXT boundary.
 *
 *   · a window is current        → arm at that window's end;
 *   · none yet, under 24 h late  → look again in 5 minutes (the renewal's
 *                                  invoice is usually paid shortly after its
 *                                  period starts, and nothing is granted before);
 *   · none, and 24 h have passed → stop. Not an error: the plan may simply have
 *                                  ended. A later payment's own event re-arms.
 *
 * A refresh that THROWS counts as "none yet": it is logged and retried on the
 * same 5-minute cadence, so one bad tick does not end the account's chain.
 */
export function registerCreditsWindowBoundaryJob(opts: RegisterOpts): void {
  const now = opts.nowFn ?? Date.now;
  opts.scheduledJobs.register(CREDITS_WINDOW_BOUNDARY_JOB_TYPE, async (job: ScheduledJobRow) => {
    const accountId = job.accountId;
    if (accountId === null) return;
    let currentWindowEnd: PgInstant | null = null;
    try {
      currentWindowEnd = (await opts.grants.refreshCredits(accountId)).currentWindowEnd;
    } catch (err) {
      opts.logger?.error?.(
        {
          component: 'credit-grants',
          event: 'credits_window_boundary_failed',
          accountId,
          err: { message: errorMessage(err) },
        },
        'credits window boundary refresh failed — looking again shortly',
      );
    }
    if (currentWindowEnd !== null) {
      await enqueueNextCreditsWindowBoundary({
        scheduledJobs: opts.scheduledJobs,
        accountId,
        windowEnd: currentWindowEnd,
        currentRunAt: job.runAt,
      });
      return;
    }
    const boundaryAt = readBoundaryAt(job.payload) ?? job.runAt.getTime();
    if (now() - boundaryAt >= CREDITS_WINDOW_BOUNDARY_GIVE_UP_MS) {
      opts.logger?.info?.(
        { component: 'credit-grants', event: 'credits_window_boundary_gave_up', accountId },
        'no paid coverage 24 hours after the window ended — the boundary job stops looking',
      );
      return;
    }
    await enqueueNextCreditsWindowBoundary({
      scheduledJobs: opts.scheduledJobs,
      accountId,
      retryOfBoundaryAt: new Date(boundaryAt),
      nowFn: now,
      currentRunAt: job.runAt,
    });
  });
}

/**
 * Enqueue the next coverage sweep. Bootstrap omits `currentRunAt` and dedups
 * against every pending row; a re-arm passes the running row's `runAt` and
 * dedups only against a LATER successor. A cursor means the last batch was
 * full, so the next run is soon.
 */
export async function enqueueNextCreditsCoverageSweep(opts: {
  scheduledJobs: ScheduledJobsService;
  nowFn?: () => number;
  currentRunAt?: Date;
  afterAccountId?: string | null;
}): Promise<{ enqueued: boolean }> {
  const now = (opts.nowFn ?? Date.now)();
  const after = opts.afterAccountId ?? null;
  return opts.scheduledJobs.enqueue({
    jobType: CREDITS_COVERAGE_SWEEP_JOB_TYPE,
    accountId: null,
    payload: after === null ? {} : { after_account_id: after },
    runAt: new Date(
      now + (after === null ? CREDITS_COVERAGE_SWEEP_INTERVAL_MS : CREDITS_SWEEP_BACKLOG_DELAY_MS),
    ),
    dedupOnAccountAndType: true,
    ...(opts.currentRunAt === undefined ? {} : { dedupAfterRunAt: opts.currentRunAt }),
  });
}

/** Enqueue the next expiry sweep; same dedup and cursor rules as the coverage sweep. */
export async function enqueueNextCreditsExpirySweep(opts: {
  scheduledJobs: ScheduledJobsService;
  nowFn?: () => number;
  currentRunAt?: Date;
  afterAccountId?: string | null;
}): Promise<{ enqueued: boolean }> {
  const now = (opts.nowFn ?? Date.now)();
  const after = opts.afterAccountId ?? null;
  return opts.scheduledJobs.enqueue({
    jobType: CREDITS_EXPIRY_SWEEP_JOB_TYPE,
    accountId: null,
    payload: after === null ? {} : { after_account_id: after },
    runAt: new Date(
      now + (after === null ? CREDITS_EXPIRY_SWEEP_INTERVAL_MS : CREDITS_SWEEP_BACKLOG_DELAY_MS),
    ),
    dedupOnAccountAndType: true,
    ...(opts.currentRunAt === undefined ? {} : { dedupAfterRunAt: opts.currentRunAt }),
  });
}

/**
 * Arm one account's boundary job: at `windowEnd` for a window that is current,
 * or 5 minutes on (`retryOfBoundaryAt`) while the month after it is unpaid. One
 * pending row per account; the handler passes `currentRunAt`, as the sweeps do.
 */
export async function enqueueNextCreditsWindowBoundary(opts: {
  scheduledJobs: ScheduledJobsService;
  accountId: string;
  windowEnd?: PgInstant;
  retryOfBoundaryAt?: Date;
  nowFn?: () => number;
  currentRunAt?: Date;
}): Promise<{ enqueued: boolean }> {
  const retry = opts.retryOfBoundaryAt;
  const dueAt =
    opts.windowEnd !== undefined
      ? firstMillisecondAtOrAfter(opts.windowEnd)
      : new Date((opts.nowFn ?? Date.now)() + CREDITS_WINDOW_BOUNDARY_RETRY_MS);
  return opts.scheduledJobs.enqueue({
    jobType: CREDITS_WINDOW_BOUNDARY_JOB_TYPE,
    accountId: opts.accountId,
    payload: { boundary_at: (retry ?? dueAt).toISOString() },
    runAt: dueAt,
    dedupOnAccountAndType: true,
    ...(opts.currentRunAt === undefined ? {} : { dedupAfterRunAt: opts.currentRunAt }),
  });
}
