// 2026-06-19 — orphaned agent-session reaper (wall-clock backstop).
//
// Mirrors profile-trash-purge-sweeper.test.ts: a stub-repo path that pins the
// cutoff tickOnce computes, a next-run scheduler path, the stable job-type, and
// an in-memory-repo data-correctness path that proves the safety invariants
// (only `active` rows older than the cutoff are closed; recent + already-closed
// rows are untouched).

import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionsRepo } from '../../src/services/agent-sessions.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import {
  AgentSessionOrphanSweeperService,
  AGENT_SESSION_ORPHAN_REAP_JOB_TYPE,
  enqueueNextAgentSessionOrphanReap,
  nextReapRunAt,
  registerAgentSessionOrphanReapJob,
  resolveMaxLifetimeHours,
} from '../../src/services/agent-session-orphan-sweeper.js';
import type { Logger } from '../../src/lib/logger.js';

const HOUR_MS = 60 * 60 * 1000;

// Minimal repo stub that records the cutoff tickOnce passes to
// reapOrphanedActiveBefore.
function stubRepo(): { repo: AgentSessionsRepo; cutoffs: Date[] } {
  const cutoffs: Date[] = [];
  const repo = {
    reapOrphanedActiveBefore: (cutoff: Date) => {
      cutoffs.push(cutoff);
      return Promise.resolve(2);
    },
  } as unknown as AgentSessionsRepo;
  return { repo, cutoffs };
}

describe('AgentSessionOrphanSweeperService.tickOnce', () => {
  it('reaps with a cutoff = now − cap (default 12h) and returns the count', async () => {
    const { repo, cutoffs } = stubRepo();
    const svc = new AgentSessionOrphanSweeperService({ repo });
    const now = new Date('2026-06-19T12:00:00.000Z');
    const res = await svc.tickOnce(now);
    expect(res.reaped).toBe(2);
    expect(cutoffs).toHaveLength(1);
    expect(cutoffs[0]!.getTime()).toBe(now.getTime() - 12 * HOUR_MS);
  });

  it('honors a custom maxLifetimeHours', async () => {
    const { repo, cutoffs } = stubRepo();
    const svc = new AgentSessionOrphanSweeperService({ repo, maxLifetimeHours: 6 });
    const now = new Date('2026-06-19T12:00:00.000Z');
    await svc.tickOnce(now);
    expect(cutoffs[0]!.getTime()).toBe(now.getTime() - 6 * HOUR_MS);
  });
});

describe('resolveMaxLifetimeHours', () => {
  it('defaults to 12 when the env var is unset', () => {
    expect(resolveMaxLifetimeHours({})).toBe(12);
  });

  it('honors a valid positive override', () => {
    expect(resolveMaxLifetimeHours({ DRIFTSTACK_AGENT_SESSION_MAX_LIFETIME_HOURS: '24' })).toBe(24);
  });

  it('falls back to 12 for a non-finite / non-positive value (never disables the backstop)', () => {
    expect(resolveMaxLifetimeHours({ DRIFTSTACK_AGENT_SESSION_MAX_LIFETIME_HOURS: 'nope' })).toBe(
      12,
    );
    expect(resolveMaxLifetimeHours({ DRIFTSTACK_AGENT_SESSION_MAX_LIFETIME_HOURS: '0' })).toBe(12);
    expect(resolveMaxLifetimeHours({ DRIFTSTACK_AGENT_SESSION_MAX_LIFETIME_HOURS: '-5' })).toBe(12);
  });

  it('falls back to 12 for an absurdly-large value (a fat-finger must NOT silently disable the backstop)', () => {
    // 120000 (a plausible typo for 12) would push the cutoff ~13.7 years into
    // the past → nothing ever old enough to reap → backstop disabled, which the
    // JSDoc promises is impossible. Anything above 30 days falls back.
    expect(resolveMaxLifetimeHours({ DRIFTSTACK_AGENT_SESSION_MAX_LIFETIME_HOURS: '120000' })).toBe(
      12,
    );
    // Exactly 30 days (the ceiling) is still honored.
    expect(
      resolveMaxLifetimeHours({ DRIFTSTACK_AGENT_SESSION_MAX_LIFETIME_HOURS: String(24 * 30) }),
    ).toBe(24 * 30);
    // Just over the ceiling falls back.
    expect(
      resolveMaxLifetimeHours({ DRIFTSTACK_AGENT_SESSION_MAX_LIFETIME_HOURS: String(24 * 30 + 1) }),
    ).toBe(12);
  });
});

describe('nextReapRunAt', () => {
  it('returns the top of the next hour when now is mid-hour', () => {
    const next = nextReapRunAt(new Date('2026-06-19T01:23:45.678Z'));
    expect(next.toISOString()).toBe('2026-06-19T02:00:00.000Z');
  });

  it('rolls to the next hour when now is exactly on the hour', () => {
    const next = nextReapRunAt(new Date('2026-06-19T04:00:00.000Z'));
    expect(next.toISOString()).toBe('2026-06-19T05:00:00.000Z');
  });
});

describe('job type', () => {
  it('is the stable agent_session.orphan_reap identifier', () => {
    expect(AGENT_SESSION_ORPHAN_REAP_JOB_TYPE).toBe('agent_session.orphan_reap');
  });
});

describe('enqueueNextAgentSessionOrphanReap (bootstrap enqueue)', () => {
  it('enqueues the reap job with accountId null at the top of the next hour, dedup default true', async () => {
    const jobs: Array<{
      jobType: string;
      accountId: string | null;
      runAt: Date;
      dedupOnAccountAndType: boolean | undefined;
    }> = [];
    const scheduledJobs = {
      enqueue: (input: {
        jobType: string;
        accountId: string | null;
        runAt: Date;
        dedupOnAccountAndType?: boolean;
      }) => {
        jobs.push({
          jobType: input.jobType,
          accountId: input.accountId,
          runAt: input.runAt,
          dedupOnAccountAndType: input.dedupOnAccountAndType,
        });
        return Promise.resolve({ enqueued: true });
      },
    };
    const now = new Date('2026-06-19T09:30:00.000Z').getTime();
    await enqueueNextAgentSessionOrphanReap({
      scheduledJobs: scheduledJobs as unknown as Parameters<
        typeof enqueueNextAgentSessionOrphanReap
      >[0]['scheduledJobs'],
      nowFn: () => now,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.jobType).toBe('agent_session.orphan_reap');
    expect(jobs[0]!.accountId).toBeNull();
    expect(jobs[0]!.runAt.toISOString()).toBe('2026-06-19T10:00:00.000Z');
    expect(jobs[0]!.dedupOnAccountAndType).toBe(true);
  });
});

describe('agent-session orphan reap scheduling (chain survival + dedup rule)', () => {
  function makeLogger(): Logger {
    const noop = () => undefined;
    return {
      error: noop,
      warn: noop,
      info: noop,
      debug: noop,
      trace: noop,
      fatal: noop,
      child: function () {
        return this;
      },
    } as unknown as Logger;
  }

  function fakeScheduledJobs() {
    const enqueues: Array<{
      jobType: string;
      dedup: boolean | undefined;
      dedupAfterRunAt?: Date;
      runAt: Date;
    }> = [];
    let handler: ((job: unknown) => Promise<void>) | null = null;
    const scheduledJobs = {
      register: (_jobType: string, h: (job: unknown) => Promise<void>) => {
        handler = h;
      },
      enqueue: (args: {
        jobType: string;
        dedupOnAccountAndType?: boolean;
        dedupAfterRunAt?: Date;
        runAt: Date;
      }) => {
        enqueues.push({
          jobType: args.jobType,
          dedup: args.dedupOnAccountAndType,
          dedupAfterRunAt: args.dedupAfterRunAt,
          runAt: args.runAt,
        });
        return Promise.resolve({ enqueued: true });
      },
    };
    const currentRunAt = new Date('2026-06-19T09:00:00.000Z');
    return {
      scheduledJobs,
      enqueues,
      currentRunAt,
      invoke: () => handler!({ runAt: currentRunAt }),
    };
  }

  it('the re-arm survives a tickOnce failure (chain never dies) and does not fan out', async () => {
    const f = fakeScheduledJobs();
    // A tick that always throws (e.g. reapOrphanedActiveBefore's DB statement
    // fails) must not stop the self-re-arming chain: the handler swallows + re-arms
    // exactly once. If it re-threw, the poller would retry to maxAttempts then
    // markFailed with no pending reap — the chain would die and no orphaned
    // session would ever close again. Captured mock (read off the local variable,
    // not the object → no-unbound-method).
    const tickOnce = vi.fn().mockRejectedValue(new Error('db down'));
    const sweeper = { tickOnce } as unknown as AgentSessionOrphanSweeperService;

    registerAgentSessionOrphanReapJob({
      scheduledJobs: f.scheduledJobs as unknown as Parameters<
        typeof registerAgentSessionOrphanReapJob
      >[0]['scheduledJobs'],
      sweeper,
      logger: makeLogger(),
      nowFn: () => new Date('2026-06-19T09:30:00.000Z').getTime(),
    });

    // The handler must resolve (not reject) despite the failing tick.
    await expect(f.invoke()).resolves.toBeUndefined();
    // Exactly one re-arm enqueued → chain alive, no duplicate parallel chains.
    expect(f.enqueues).toHaveLength(1);
    expect(f.enqueues[0]).toMatchObject({
      jobType: AGENT_SESSION_ORPHAN_REAP_JOB_TYPE,
      dedup: true,
      dedupAfterRunAt: f.currentRunAt,
    });
    expect(tickOnce).toHaveBeenCalledTimes(1);
  });

  it('on a clean tick, re-arms exactly once with future-successor dedup', async () => {
    const f = fakeScheduledJobs();
    const tickOnce = vi.fn().mockResolvedValue({ reaped: 3 });
    const sweeper = { tickOnce } as unknown as AgentSessionOrphanSweeperService;

    registerAgentSessionOrphanReapJob({
      scheduledJobs: f.scheduledJobs as unknown as Parameters<
        typeof registerAgentSessionOrphanReapJob
      >[0]['scheduledJobs'],
      sweeper,
      logger: makeLogger(),
      nowFn: () => new Date('2026-06-19T09:30:00.000Z').getTime(),
    });

    await expect(f.invoke()).resolves.toBeUndefined();
    expect(f.enqueues).toHaveLength(1);
    expect(f.enqueues[0]).toMatchObject({
      jobType: AGENT_SESSION_ORPHAN_REAP_JOB_TYPE,
      dedup: true,
      dedupAfterRunAt: f.currentRunAt,
    });
    // Re-arm at the top of the next hour after 09:30.
    expect(f.enqueues[0]!.runAt.toISOString()).toBe('2026-06-19T10:00:00.000Z');
    expect(tickOnce).toHaveBeenCalledTimes(1);
  });
});

describe('reapOrphanedActiveBefore data correctness (in-memory repo)', () => {
  const NEW = (accountId: string) => ({
    accountId,
    tokenBudgetTotal: 100_000,
  });

  it('closes an active session created BEFORE the cutoff; leaves a recent active session AND an already-closed one untouched', async () => {
    // Drive createdAt via the repo clock: each create() reads it, so we can mint
    // rows at controlled timestamps.
    let nowMs = new Date('2026-06-19T00:00:00.000Z').getTime();
    const repo = new InMemoryAgentSessionsRepo(() => new Date(nowMs));

    // (1) An OLD active session — created 24h ago, well past the 12h cap.
    nowMs = new Date('2026-06-18T00:00:00.000Z').getTime();
    const old = await repo.create(NEW('acc_1'));

    // (2) A RECENT active session — created 1h ago, inside the cap → must survive.
    nowMs = new Date('2026-06-18T23:00:00.000Z').getTime();
    const recent = await repo.create(NEW('acc_1'));

    // (3) An OLD session that is ALREADY closed — must be untouched (no double-count).
    nowMs = new Date('2026-06-18T00:00:00.000Z').getTime();
    const alreadyClosed = await repo.create(NEW('acc_2'));
    await repo.closeWithReason(alreadyClosed.id, 'budget-exhausted');

    // Cutoff = now (2026-06-19T00:00) − 12h = 2026-06-18T12:00.
    const cutoff = new Date('2026-06-18T12:00:00.000Z');
    const reaped = await repo.reapOrphanedActiveBefore(cutoff);

    // Only the single OLD active row was closed.
    expect(reaped).toBe(1);

    const oldAfter = await repo.get(old.id);
    expect(oldAfter!.status).toBe('closed');
    expect(oldAfter!.closedReason).toBe('orphaned-lifetime');
    expect(oldAfter!.closedAt).not.toBeNull();

    // The recent active session is the safety invariant — NOT touched.
    const recentAfter = await repo.get(recent.id);
    expect(recentAfter!.status).toBe('active');
    expect(recentAfter!.closedReason).toBeNull();

    // The already-closed row keeps its original close reason (not re-stamped).
    const closedAfter = await repo.get(alreadyClosed.id);
    expect(closedAfter!.status).toBe('closed');
    expect(closedAfter!.closedReason).toBe('budget-exhausted');

    // Idempotent — a second sweep at the same cutoff closes nothing new.
    expect(await repo.reapOrphanedActiveBefore(cutoff)).toBe(0);
  });
});
