// Hourly retention for persistent third-party OAuth provider state.
//
// Authorization handles and codes are useful for five minutes; access tokens
// are useful until their fixed one-hour expiry. Read/auth paths already reject
// older rows, but rejection alone does not remove them. This self-arming job
// closes that storage/data-minimization loop without touching retained API-key
// actor rows that existing sessions and audit records may reference.

import type { Logger } from '../lib/logger.js';
import type { OAuthPruneResult, OAuthStore } from './oauth.js';
import type { ScheduledJobRow, ScheduledJobsService } from './scheduled-jobs.js';

export const OAUTH_RETENTION_SWEEP_JOB_TYPE = 'oauth.retention_sweep';
export const OAUTH_RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

type OAuthRetentionStore = Pick<OAuthStore, 'pruneExpired'>;
type OAuthRetentionScheduler = Pick<ScheduledJobsService, 'register' | 'enqueue'>;

export class OAuthRetentionSweeperService {
  constructor(private readonly store: OAuthRetentionStore) {}

  tickOnce(now: Date): Promise<OAuthPruneResult> {
    return this.store.pruneExpired(now.getTime());
  }
}

export interface RegisterOAuthRetentionSweepJobOpts {
  scheduledJobs: OAuthRetentionScheduler;
  sweeper: OAuthRetentionSweeperService;
  logger: Logger;
  /** Test seam — defaults to Date.now. */
  nowFn?: () => number;
}

/**
 * Register one hourly, restart-safe cleanup chain. The in-handler re-arm uses
 * dedup that ignores the current/older run-time cohort. That permits the first
 * future successor but makes every peer or retry observe it, preventing crash,
 * ambiguous-commit, and legacy-duplicate fan-out. A failed idempotent delete
 * is swallowed and re-armed exactly once so the chain survives.
 */
export function registerOAuthRetentionSweepJob(opts: RegisterOAuthRetentionSweepJobOpts): void {
  const now = opts.nowFn ?? Date.now;
  opts.scheduledJobs.register(OAUTH_RETENTION_SWEEP_JOB_TYPE, async (job: ScheduledJobRow) => {
    try {
      const result = await opts.sweeper.tickOnce(new Date(now()));
      const total = result.authorizations + result.codes + result.tokens;
      if (total > 0) {
        opts.logger.info(
          {
            component: 'oauth-retention-sweep',
            authorizations: result.authorizations,
            codes: result.codes,
            tokens: result.tokens,
            total,
          },
          'OAuth retention sweep complete',
        );
      }
    } catch (err) {
      // Do not persist provider/SQL exception text in scheduler logs. The error
      // class is enough to diagnose the lane; the next idempotent tick retries.
      opts.logger.error(
        {
          component: 'oauth-retention-sweep',
          event: 'oauth_retention_sweep_failed',
          error_type: err instanceof Error ? err.name.slice(0, 80) : 'UnknownError',
        },
        'OAuth retention sweep failed — re-arming for the next tick',
      );
    }
    await enqueueNextOAuthRetentionSweep({
      scheduledJobs: opts.scheduledJobs,
      nowFn: now,
      currentRunAt: job.runAt,
    });
  });
}

export async function enqueueNextOAuthRetentionSweep(opts: {
  scheduledJobs: Pick<ScheduledJobsService, 'enqueue'>;
  nowFn?: () => number;
  /** Current run-time cohort ignored by dedup for crash-safe re-arms. */
  currentRunAt?: Date;
}): Promise<{ enqueued: boolean }> {
  const now = (opts.nowFn ?? Date.now)();
  return opts.scheduledJobs.enqueue({
    jobType: OAUTH_RETENTION_SWEEP_JOB_TYPE,
    accountId: null,
    payload: {},
    runAt: new Date(now + OAUTH_RETENTION_SWEEP_INTERVAL_MS),
    dedupOnAccountAndType: true,
    ...(opts.currentRunAt === undefined ? {} : { dedupAfterRunAt: opts.currentRunAt }),
  });
}
