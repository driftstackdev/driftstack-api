// Retention for the per-request AI diagnostics rows.
//
// 90 days. The rows are content-free and cannot be joined to a customer, so no
// privacy window drives this; the number is chosen for the question the table
// answers. "Did last month's planner change move the completion rate?" needs a
// full quarter to compare against, and nothing asked of this table needs more —
// anything older belongs in the metrics backend, which keeps the same signals
// as time series. Without a prune the table grows by one row per request
// forever, which is the failure every other append-only table here already had
// once.
//
// Wired exactly like scheduled-jobs-prune-sweeper: a self-re-arming
// scheduled_jobs row, restart-safe, on the liveness roster.

import type { ScheduledJobsService, ScheduledJobRow } from './scheduled-jobs.js';
import type { AgentTurnTelemetryRepo } from '../db/agent-turn-telemetry-repo.js';
import { AGENT_TURN_TELEMETRY_RETENTION_DAYS } from './agent-turn-telemetry.js';

export const AGENT_TURN_TELEMETRY_PRUNE_JOB_TYPE = 'agent_turn_telemetry.prune';

/** Daily, unless a tick finds a backlog (see the catch-up interval below).
 *  Against a 90-day window nothing is gained by pruning more often. */
export const AGENT_TURN_TELEMETRY_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Bounded work per tick so a neglected backlog cannot hold the poller. */
export const AGENT_TURN_TELEMETRY_PRUNE_BATCH_LIMIT = 10_000;

/**
 * How soon to come back when a tick deleted a FULL batch.
 *
 * A full batch means there is more past the cutoff. One row is written per
 * request — every 409 of a retrying client included — so waiting a day between
 * batches capped deletion at 10,000 rows a day: above about seven requests a
 * minute the table grew without bound and "90 days" was false. A minute apart
 * keeps each tick small for the poller and still clears 14 million rows a day.
 */
export const AGENT_TURN_TELEMETRY_PRUNE_CATCH_UP_INTERVAL_MS = 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RegisterAgentTurnTelemetryPruneJobOpts {
  scheduledJobs: ScheduledJobsService;
  repo: Pick<AgentTurnTelemetryRepo, 'pruneOlderThan'>;
  logger?: {
    info?: (obj: Record<string, unknown>, msg: string) => void;
    error?: (obj: Record<string, unknown>, msg: string) => void;
  };
  /** Test seam — defaults to `Date.now`. */
  nowFn?: () => number;
}

/**
 * The handler prunes once, then re-arms.
 *
 * Chain survival: a prune failure is SWALLOWED (and logged) and the re-arm runs
 * exactly once afterwards. Re-throwing would make the poller retry the job, and
 * a re-arm in `finally` would then fan out one new chain per attempt; not
 * re-arming at all would leave the chain dead until a restart. The prune is a
 * bounded delete-by-cutoff, so whatever one run misses the next one takes.
 */
export function registerAgentTurnTelemetryPruneJob(
  opts: RegisterAgentTurnTelemetryPruneJobOpts,
): void {
  const now = opts.nowFn ?? Date.now;
  opts.scheduledJobs.register(AGENT_TURN_TELEMETRY_PRUNE_JOB_TYPE, async (job: ScheduledJobRow) => {
    let backlogRemains = false;
    try {
      const cutoff = new Date(now() - AGENT_TURN_TELEMETRY_RETENTION_DAYS * DAY_MS);
      const deleted = await opts.repo.pruneOlderThan(
        cutoff,
        AGENT_TURN_TELEMETRY_PRUNE_BATCH_LIMIT,
      );
      backlogRemains = deleted >= AGENT_TURN_TELEMETRY_PRUNE_BATCH_LIMIT;
      if (deleted > 0) {
        opts.logger?.info?.(
          {
            component: 'agent-turn-telemetry-prune',
            deleted,
            cutoff: cutoff.toISOString(),
            capped: backlogRemains,
          },
          'pruned agent turn diagnostics past retention',
        );
      }
    } catch (err) {
      opts.logger?.error?.(
        {
          component: 'agent-turn-telemetry-prune',
          event: 'agent_turn_telemetry_prune_failed',
          err: { message: err instanceof Error ? err.message : String(err) },
        },
        'agent turn diagnostics prune failed — re-arming; rows retry next run',
      );
    }
    await enqueueNextAgentTurnTelemetryPrune({
      scheduledJobs: opts.scheduledJobs,
      nowFn: now,
      currentRunAt: job.runAt,
      // A FAILED prune re-arms at the daily interval, never the short one: a
      // database that is refusing deletes is not helped by being asked again in
      // a minute, indefinitely.
      ...(backlogRemains ? { intervalMs: AGENT_TURN_TELEMETRY_PRUNE_CATCH_UP_INTERVAL_MS } : {}),
    });
  });
}

/**
 * Enqueue the next prune. Bootstrap omits `currentRunAt` and dedups against
 * every pending row; a re-arm passes the running row's `runAt` and dedups only
 * against a LATER pending successor, so the chain survives its own tick.
 */
export async function enqueueNextAgentTurnTelemetryPrune(opts: {
  scheduledJobs: ScheduledJobsService;
  nowFn?: () => number;
  currentRunAt?: Date;
  /** Defaults to the daily interval. */
  intervalMs?: number;
}): Promise<void> {
  const now = (opts.nowFn ?? Date.now)();
  await opts.scheduledJobs.enqueue({
    jobType: AGENT_TURN_TELEMETRY_PRUNE_JOB_TYPE,
    accountId: null,
    payload: {},
    runAt: new Date(now + (opts.intervalMs ?? AGENT_TURN_TELEMETRY_PRUNE_INTERVAL_MS)),
    dedupOnAccountAndType: true,
    ...(opts.currentRunAt === undefined ? {} : { dedupAfterRunAt: opts.currentRunAt }),
  });
}
