// V-759 — periodic enforcement of the privacy-policy §9 retention windows.
//
// Why this is an anonymisation sweep and not a delete sweep, why `usage_records` must
// survive it, and why a revoked API key cannot be deleted at all, are recorded on
// `db/retention-scrub-repo.ts` and in
// docs/internal/2026-08-12-retention-anonymisation-design.md. Read one of those before
// changing the semantics here.
//
// Scheduling mirrors crypto-entitlement-expiry-sweeper EXACTLY: bootstrap enqueues the
// first tick, each run re-arms its own successor, and the enqueue dedups so a restart
// cannot fan out duplicate sweeps.
//
// The three steps run in a FIXED order — operations, then sessions, then keys — and the
// order is load-bearing for one of them: `session_operations` rows are found through their
// parent session's `destroyed_at`, so they must be collected while that parent still carries
// un-scrubbed context. Sessions and keys are independent of each other.

import type { ScheduledJobsService, ScheduledJobRow } from './scheduled-jobs.js';
import type { RetentionScrubRepo } from '../db/retention-scrub-repo.js';
import { RETENTION_WINDOW_DAYS } from '../db/retention-scrub-repo.js';

export const RETENTION_SCRUB_JOB_TYPE = 'privacy.retention_scrub';

/** Daily. The window is 90 days, so nothing is gained by sweeping more often. */
export const RETENTION_SCRUB_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Bounded work per tick so a long-neglected backlog cannot hold the poller for minutes. */
const DEFAULT_BATCH_LIMIT = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionScrubSweeperDeps {
  readonly repo: RetentionScrubRepo;
  readonly logger?: {
    info?: (obj: Record<string, unknown>, msg: string) => void;
    error?: (obj: Record<string, unknown>, msg: string) => void;
  };
  readonly batchLimit?: number;
  /** Override for tests. Production uses the disclosed 90 days. */
  readonly windowDays?: number;
}

export interface RetentionScrubTickResult {
  readonly operationsDeleted: number;
  readonly sessionsScrubbed: number;
  readonly apiKeysScrubbed: number;
  /** True when ANY step hit its batch limit — more remains for the next tick. */
  readonly capped: boolean;
}

export class RetentionScrubSweeperService {
  constructor(private readonly deps: RetentionScrubSweeperDeps) {}

  async tickOnce(now: Date): Promise<RetentionScrubTickResult> {
    const limit = this.deps.batchLimit ?? DEFAULT_BATCH_LIMIT;
    const windowDays = this.deps.windowDays ?? RETENTION_WINDOW_DAYS;
    const olderThan = new Date(now.getTime() - windowDays * DAY_MS);

    // Per-step isolation, mirroring the crypto sweeper's per-account isolation: one step
    // failing must not strand the other two, and a failed step's rows simply retry on the
    // next tick because every statement is idempotent.
    const ops = await this.step('session_operations', () =>
      this.deps.repo.deleteExpiredSessionOperations({ olderThan, limit }),
    );
    const sessions = await this.step('sessions', () =>
      this.deps.repo.scrubExpiredSessionMetadata({ olderThan, limit }),
    );
    const keys = await this.step('api_keys', () =>
      this.deps.repo.scrubExpiredRevokedApiKeys({ olderThan, limit }),
    );

    const result: RetentionScrubTickResult = {
      operationsDeleted: ops.affected,
      sessionsScrubbed: sessions.affected,
      apiKeysScrubbed: keys.affected,
      capped: ops.capped || sessions.capped || keys.capped,
    };

    // Log only when something happened. A daily no-op tick on a young deployment should not
    // add a line, but a tick that touched personal data is a retention event and should be
    // attributable after the fact.
    if (result.operationsDeleted + result.sessionsScrubbed + result.apiKeysScrubbed > 0) {
      this.deps.logger?.info?.(
        {
          component: 'retention-scrub-sweeper',
          event: 'retention_scrub_tick',
          window_days: windowDays,
          older_than: olderThan.toISOString(),
          ...result,
        },
        'privacy §9 retention scrub applied',
      );
    }
    return result;
  }

  private async step(
    step: string,
    run: () => Promise<{ affected: number; capped: boolean }>,
  ): Promise<{ affected: number; capped: boolean }> {
    try {
      return await run();
    } catch (err) {
      // A failed retention step means personal data is being held past its disclosed
      // window, which is a compliance condition rather than a transient nuisance — so it
      // alarms at error level rather than being swallowed. It is not rethrown: the other
      // steps must still run, and these statements are idempotent so the rows retry.
      this.deps.logger?.error?.(
        {
          component: 'retention-scrub-sweeper',
          event: 'retention_scrub_step_failed',
          step,
          err: { message: err instanceof Error ? err.message : String(err) },
        },
        'privacy §9 retention step FAILED — personal data is being retained past its disclosed window; retries next tick',
      );
      return { affected: 0, capped: false };
    }
  }
}

export interface RegisterRetentionScrubJobOpts {
  readonly scheduledJobs: ScheduledJobsService;
  readonly sweeper: RetentionScrubSweeperService;
  readonly logger?: { error?: (obj: Record<string, unknown>, msg: string) => void };
  readonly nowFn?: () => number;
}

export function registerRetentionScrubJob(opts: RegisterRetentionScrubJobOpts): void {
  const now = opts.nowFn ?? Date.now;
  opts.scheduledJobs.register(RETENTION_SCRUB_JOB_TYPE, async (job: ScheduledJobRow) => {
    try {
      await opts.sweeper.tickOnce(new Date(now()));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.logger?.error?.(
        {
          component: 'retention-scrub-sweeper',
          event: 'retention_scrub_tick_failed',
          err: { message },
        },
        'retention scrub tick failed — re-arming; rows retry next tick',
      );
    }
    // Re-arm unconditionally. A chain that stops re-arming stops enforcing a disclosed
    // retention window, silently, until the next process restart.
    await enqueueNextRetentionScrub({
      scheduledJobs: opts.scheduledJobs,
      nowFn: now,
      currentRunAt: job.runAt,
    });
  });
}

export async function enqueueNextRetentionScrub(opts: {
  scheduledJobs: ScheduledJobsService;
  nowFn?: () => number;
  currentRunAt?: Date;
}): Promise<{ enqueued: boolean }> {
  const now = (opts.nowFn ?? Date.now)();
  return opts.scheduledJobs.enqueue({
    jobType: RETENTION_SCRUB_JOB_TYPE,
    accountId: null,
    payload: {},
    runAt: new Date(now + RETENTION_SCRUB_INTERVAL_MS),
    dedupOnAccountAndType: true,
    ...(opts.currentRunAt === undefined ? {} : { dedupAfterRunAt: opts.currentRunAt }),
  });
}
