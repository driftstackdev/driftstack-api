// 2026-05-20 — auth-token sweeper service.
//
// Periodic DELETE of stale rows across the three auth-flow token
// tables (email_verify_tokens / magic_link_tokens / password_reset_
// tokens). Per the 2026-05-20 stale-row audit
// (docs/internal/2026-05-20-stale-row-audit.md), consumeAuthToken()
// only marks rows as consumed; nothing currently deletes them. Same
// shape of bug as the 2026-05-19 scheduled_jobs accumulation incident
// but pre-scale (~10 rows at 10 customers; ~70K rows at 10K). This
// sweeper closes the loop before scale.
//
// Retention policy:
//   - consumed rows kept ≥30 days post-consumption (forensic window
//     for support tickets — "the magic link expired but I clicked it"
//     diagnostics still work).
//   - expired-but-unconsumed rows kept ≥7 days post-expiration
//     (covers the typical retry window — customer abandons + comes
//     back later via the same email link).
//
// Scheduling: exposes `tickOnce(now)` for a future scheduled-jobs
// entry. Same pattern as agent-pair-mode-heartbeat-sweep.ts. The
// re-arm dedup ignores the current/older run-time cohort but still collapses
// future successors; bootstrap dedups against every pending row. See
// `enqueueNextAuthTokensSweep` JSDoc for the full reasoning.

import type { AuthFlowsRepo, AuthFlowKind } from './auth-flows.js';
import type { ScheduledJobsService, ScheduledJobRow } from './scheduled-jobs.js';
import type { Logger } from '../lib/logger.js';

export const AUTH_TOKENS_SWEEP_JOB_TYPE = 'auth_tokens.sweep';

const CONSUMED_RETENTION_DAYS = 30;
const EXPIRED_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const KINDS: readonly AuthFlowKind[] = ['email_verify', 'magic_link', 'password_reset'];

export interface AuthTokensSweeperDeps {
  readonly repo: AuthFlowsRepo;
  readonly consumedRetentionDays?: number;
  readonly expiredRetentionDays?: number;
}

export interface SweepTickResult {
  readonly deletedByKind: Record<AuthFlowKind, number>;
  readonly totalDeleted: number;
}

export class AuthTokensSweeperService {
  private readonly consumedMs: number;
  private readonly expiredMs: number;

  constructor(private readonly deps: AuthTokensSweeperDeps) {
    this.consumedMs = (deps.consumedRetentionDays ?? CONSUMED_RETENTION_DAYS) * DAY_MS;
    this.expiredMs = (deps.expiredRetentionDays ?? EXPIRED_RETENTION_DAYS) * DAY_MS;
  }

  async tickOnce(now: Date): Promise<SweepTickResult> {
    const consumedBefore = new Date(now.getTime() - this.consumedMs);
    const expiredBefore = new Date(now.getTime() - this.expiredMs);

    const deletedByKind: Record<AuthFlowKind, number> = {
      email_verify: 0,
      magic_link: 0,
      password_reset: 0,
    };

    let totalDeleted = 0;
    for (const kind of KINDS) {
      const n = await this.deps.repo.deleteStaleAuthTokens({
        kind,
        consumedBefore,
        expiredBefore,
      });
      deletedByKind[kind] = n;
      totalDeleted += n;
    }

    return { deletedByKind, totalDeleted };
  }
}

/**
 * Wire the sweeper onto the ScheduledJobsService. Cadence: daily at
 * 03:00 UTC (low-traffic window; matches the audit-archive sweep
 * pattern). Re-arms itself after each run via `enqueueNextAuthTokensSweep`.
 *
 * The re-arm uses future-successor dedup. The current/older run-time cohort
 * is ignored because the current row is not complete until after the handler;
 * a pending successor strictly after this run still suppresses the enqueue.
 * That keeps the chain alive while making handler replay and legacy duplicate
 * current rows converge on one future successor.
 *
 * Chain survival: the re-arm must run even if `tickOnce` throws. If it did
 * not, a throw would leave no re-arm, the poller would retry the job, and
 * once `maxAttempts` is exhausted the job is markFailed with NO pending
 * sweep row — the self-re-arming chain is then dead until a process restart
 * and stale auth-flow tokens accumulate forever (the exact unbounded-row
 * growth this sweeper exists to prevent). We therefore SWALLOW a tick
 * failure (logging it) and re-arm exactly once. We must NOT
 * re-throw-and-re-arm-in-`finally`: the poller would retry the same job and
 * each attempt would re-arm → duplicate parallel chains (fan-out). The tick
 * is idempotent (a DELETE of stale rows) — the next tick re-runs any kinds
 * this one missed.
 */
export interface RegisterAuthTokensSweepJobOpts {
  scheduledJobs: ScheduledJobsService;
  sweeper: AuthTokensSweeperService;
  logger: Logger;
  /** Test seam — defaults to `Date.now`. */
  nowFn?: () => number;
}

export function registerAuthTokensSweepJob(opts: RegisterAuthTokensSweepJobOpts): void {
  const now = opts.nowFn ?? Date.now;
  opts.scheduledJobs.register(AUTH_TOKENS_SWEEP_JOB_TYPE, async (job: ScheduledJobRow) => {
    try {
      const result = await opts.sweeper.tickOnce(new Date(now()));
      opts.logger.info?.(
        {
          component: 'auth-tokens-sweep',
          deleted_email_verify: result.deletedByKind.email_verify,
          deleted_magic_link: result.deletedByKind.magic_link,
          deleted_password_reset: result.deletedByKind.password_reset,
          total_deleted: result.totalDeleted,
        },
        'auth-tokens sweep complete',
      );
    } catch (err) {
      // Swallow-not-rethrow: re-throwing would skip the re-arm below and, once
      // the poller exhausts maxAttempts, kill the self-re-arming chain (see the
      // "Chain survival" note on RegisterAuthTokensSweepJobOpts). Re-arming in a
      // `finally` instead would let every poller retry re-arm → fan-out. We log
      // and fall through to the single re-arm; the next tick re-runs the delete.
      const message = err instanceof Error ? err.message : String(err);
      opts.logger.error?.(
        {
          component: 'auth-tokens-sweep',
          event: 'auth_tokens_sweep_tick_failed',
          err: { message },
        },
        'auth-tokens sweep tick failed — re-arming; stale rows retry next tick',
      );
    }
    // Re-arm path always runs. Dedup ignores this current/older run-time cohort
    // but observes a future successor, so crash retries cannot fan out.
    await enqueueNextAuthTokensSweep({
      scheduledJobs: opts.scheduledJobs,
      nowFn: now,
      currentRunAt: job.runAt,
    });
  });
}

/**
 * Enqueue the next daily sweep at 03:00 UTC strictly after `now`.
 *
 * Bootstrap omits `currentRunAt` and dedups against every pending row. An
 * in-handler re-arm supplies the current row's `runAt`, ignoring only that
 * current/older cohort while still deduplicating any future successor.
 */
export async function enqueueNextAuthTokensSweep(opts: {
  scheduledJobs: ScheduledJobsService;
  nowFn?: () => number;
  /** Current run-time cohort ignored for a crash-safe in-handler re-arm. */
  currentRunAt?: Date;
}): Promise<{ enqueued: boolean }> {
  const now = (opts.nowFn ?? Date.now)();
  return opts.scheduledJobs.enqueue({
    jobType: AUTH_TOKENS_SWEEP_JOB_TYPE,
    accountId: null,
    payload: {},
    runAt: nextSweepRunAt(new Date(now)),
    dedupOnAccountAndType: true,
    ...(opts.currentRunAt === undefined ? {} : { dedupAfterRunAt: opts.currentRunAt }),
  });
}

/** Returns 03:00 UTC strictly after `now`. */
export function nextSweepRunAt(now: Date): Date {
  const next = new Date(now.getTime());
  next.setUTCHours(3, 0, 0, 0);
  // If `now` is already past 03:00 UTC today, push to tomorrow.
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}
