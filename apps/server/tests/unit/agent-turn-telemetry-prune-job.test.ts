// Retention for the AI turn diagnostics rows: what is deleted, and that the job
// chain survives its own failure.

import { describe, expect, it } from 'vitest';
import { InMemoryAgentTurnTelemetryRepo } from '../../src/db/agent-turn-telemetry-repo.js';
import {
  AGENT_TURN_TELEMETRY_PRUNE_BATCH_LIMIT,
  AGENT_TURN_TELEMETRY_PRUNE_CATCH_UP_INTERVAL_MS,
  AGENT_TURN_TELEMETRY_PRUNE_INTERVAL_MS,
  AGENT_TURN_TELEMETRY_PRUNE_JOB_TYPE,
  enqueueNextAgentTurnTelemetryPrune,
  registerAgentTurnTelemetryPruneJob,
} from '../../src/services/agent-turn-telemetry-prune-job.js';
import { AGENT_TURN_TELEMETRY_RETENTION_DAYS } from '../../src/services/agent-turn-telemetry.js';
import type { ScheduledJobRow, ScheduledJobsService } from '../../src/services/scheduled-jobs.js';
import { row } from './_helpers/agent-turn-telemetry-row.js';

const NOW = Date.parse('2026-09-18T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

interface Enqueued {
  jobType: string;
  runAt: Date;
  dedupOnAccountAndType?: boolean;
  dedupAfterRunAt?: Date;
}

function fakeJobs(): {
  service: ScheduledJobsService;
  enqueued: Enqueued[];
  run: (job: Partial<ScheduledJobRow>) => Promise<void>;
} {
  const enqueued: Enqueued[] = [];
  let handler: ((job: ScheduledJobRow) => Promise<void>) | undefined;
  const service = {
    register: (_type: string, fn: (job: ScheduledJobRow) => Promise<void>) => {
      handler = fn;
    },
    enqueue: (args: Enqueued) => {
      enqueued.push(args);
      return Promise.resolve({ enqueued: true });
    },
  } as unknown as ScheduledJobsService;
  return {
    service,
    enqueued,
    run: async (job) => {
      if (handler === undefined) throw new Error('no handler registered');
      await handler({ runAt: new Date(NOW), ...job } as ScheduledJobRow);
    },
  };
}

describe('agent turn telemetry prune job', () => {
  it('deletes rows older than the retention window and keeps the rest', async () => {
    const repo = new InMemoryAgentTurnTelemetryRepo();
    const old = new Date(NOW - (AGENT_TURN_TELEMETRY_RETENTION_DAYS + 1) * DAY);
    const edge = new Date(NOW - (AGENT_TURN_TELEMETRY_RETENTION_DAYS - 1) * DAY);
    await repo.insert(row({ occurredAt: old }));
    await repo.insert(row({ occurredAt: old }));
    await repo.insert(row({ occurredAt: edge }));
    const jobs = fakeJobs();
    registerAgentTurnTelemetryPruneJob({ scheduledJobs: jobs.service, repo, nowFn: () => NOW });
    await jobs.run({});
    expect(repo.allForTest().map((r) => r.occurredAt)).toEqual([edge]);
    // …and the SUCCESSFUL tick re-armed too, exactly once. A chain that only
    // re-arms on the failure path dies on its first good day.
    expect(jobs.enqueued.map((e) => e.jobType)).toEqual([AGENT_TURN_TELEMETRY_PRUNE_JOB_TYPE]);
    expect(jobs.enqueued[0]?.runAt).toEqual(new Date(NOW + AGENT_TURN_TELEMETRY_PRUNE_INTERVAL_MS));
  });

  it('passes the batch limit, so a neglected backlog cannot hold the poller', async () => {
    const calls: Array<{ cutoff: Date; limit: number }> = [];
    const jobs = fakeJobs();
    registerAgentTurnTelemetryPruneJob({
      scheduledJobs: jobs.service,
      repo: {
        pruneOlderThan: (cutoff, limit) => {
          calls.push({ cutoff, limit });
          return Promise.resolve(0);
        },
      },
      nowFn: () => NOW,
    });
    await jobs.run({});
    expect(calls).toEqual([
      {
        cutoff: new Date(NOW - AGENT_TURN_TELEMETRY_RETENTION_DAYS * DAY),
        limit: AGENT_TURN_TELEMETRY_PRUNE_BATCH_LIMIT,
      },
    ]);
  });

  it('CRITICAL a FULL batch comes back in a minute, not a day. One row is written per request, so a day between 10,000-row batches capped deletion below the write rate of seven requests a minute and the 90-day promise was false. A partial batch means the backlog is gone and the chain returns to daily.', async () => {
    const deletedPerTick = [AGENT_TURN_TELEMETRY_PRUNE_BATCH_LIMIT, 17];
    const jobs = fakeJobs();
    registerAgentTurnTelemetryPruneJob({
      scheduledJobs: jobs.service,
      repo: { pruneOlderThan: () => Promise.resolve(deletedPerTick.shift() ?? 0) },
      nowFn: () => NOW,
    });
    await jobs.run({});
    await jobs.run({});
    expect(AGENT_TURN_TELEMETRY_PRUNE_CATCH_UP_INTERVAL_MS).toBeLessThan(
      AGENT_TURN_TELEMETRY_PRUNE_INTERVAL_MS / 100,
    );
    expect(jobs.enqueued.map((e) => e.runAt)).toEqual([
      new Date(NOW + AGENT_TURN_TELEMETRY_PRUNE_CATCH_UP_INTERVAL_MS),
      new Date(NOW + AGENT_TURN_TELEMETRY_PRUNE_INTERVAL_MS),
    ]);
  });

  it('CRITICAL re-arms exactly once even when the prune THROWS. A chain that stops re-arming stops pruning until the next restart, silently — and re-throwing would make the poller retry and fan out a new chain per attempt.', async () => {
    const errors: unknown[] = [];
    const jobs = fakeJobs();
    registerAgentTurnTelemetryPruneJob({
      scheduledJobs: jobs.service,
      repo: { pruneOlderThan: () => Promise.reject(new Error('db down')) },
      logger: { error: (obj) => errors.push(obj) },
      nowFn: () => NOW,
    });
    const runAt = new Date(NOW - 1000);
    await expect(jobs.run({ runAt })).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(jobs.enqueued).toEqual([
      {
        jobType: AGENT_TURN_TELEMETRY_PRUNE_JOB_TYPE,
        accountId: null,
        payload: {},
        runAt: new Date(NOW + AGENT_TURN_TELEMETRY_PRUNE_INTERVAL_MS),
        dedupOnAccountAndType: true,
        dedupAfterRunAt: runAt,
      },
    ]);
  });

  it('the bootstrap enqueue dedups against every pending row (no dedupAfterRunAt)', async () => {
    const jobs = fakeJobs();
    await enqueueNextAgentTurnTelemetryPrune({ scheduledJobs: jobs.service, nowFn: () => NOW });
    expect(jobs.enqueued).toHaveLength(1);
    expect(jobs.enqueued[0]).not.toHaveProperty('dedupAfterRunAt');
    expect(jobs.enqueued[0]?.dedupOnAccountAndType).toBe(true);
  });
});
