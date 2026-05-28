// 6.g — free-tier session-duration auto-destroy sweep safety test.
//
// LOAD-BEARING: a query bug that auto-destroys PAID sessions would be
// catastrophic (a paying customer's live session killed mid-flight). These
// cases pin the four corners of the eligibility predicate against the
// in-memory repo (which mirrors the Drizzle accounts-join semantics) driven
// through the real SessionsService destroy mechanics.
//
//   1. FREE session created >20 min ago (active)  → destroyed
//   2. FREE session created <20 min ago (active)  → NOT destroyed
//   3. PAID session created >20 min ago (active)  → NOT destroyed (cap=null)
//   4. already-destroyed / errored session        → left alone
//
// Time is driven by an injectable `nowFn` clock passed to tickOnce so no
// real waits are needed.

import { describe, expect, it } from 'vitest';
import {
  SESSION_DURATION_SWEEP_INTERVAL_MS,
  SESSION_DURATION_SWEEP_JOB_TYPE,
  SessionDurationSweeperService,
  durationCutoffsFor,
} from '../../src/services/session-duration-sweeper.js';
import { SessionsService } from '../../src/services/sessions.js';
import { InMemorySessionsRepo } from '../integration/_helpers/in-memory-sessions-repo.js';
import type { Driver } from '../../src/drivers/types.js';
import type { Logger } from '../../src/lib/logger.js';

const NOW = new Date('2026-05-27T12:00:00.000Z');
const MIN = 60 * 1000;

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as Logger;

/** Records driver.destroy calls so we can assert which sessions were torn down. */
function stubDriver(): { driver: Driver; destroyed: string[] } {
  const destroyed: string[] = [];
  const driver = {
    destroy(sessionId: string): Promise<void> {
      destroyed.push(sessionId);
      return Promise.resolve();
    },
  } as unknown as Driver;
  return { driver, destroyed };
}

function build() {
  const repo = new InMemorySessionsRepo();
  const { driver, destroyed } = stubDriver();
  const sessions = new SessionsService({ repo, driver });
  const sweeper = new SessionDurationSweeperService({ repo, sessions, logger: silentLogger });
  return { repo, sweeper, destroyed };
}

describe('SessionDurationSweeperService — free-tier auto-destroy safety', () => {
  it('1. destroys a FREE session created >20 min ago (active)', async () => {
    const { repo, sweeper, destroyed } = build();
    repo.setAccountTier('acc-free', 'free');
    const s = repo.seedSession({
      accountId: 'acc-free',
      status: 'ready',
      // 21 min ago — past the 20-min free cap.
      createdAt: new Date(NOW.getTime() - 21 * MIN),
      driverSessionId: 'drv-1',
    });

    const result = await sweeper.tickOnce(NOW);

    expect(result.destroyed).toBe(1);
    expect(repo.getSession(s.id)?.status).toBe('destroyed');
    expect(destroyed).toContain('drv-1');
  });

  it('2. leaves a FREE session created <20 min ago alone', async () => {
    const { repo, sweeper, destroyed } = build();
    repo.setAccountTier('acc-free', 'free');
    const s = repo.seedSession({
      accountId: 'acc-free',
      status: 'busy',
      // 19 min ago — still under the 20-min cap.
      createdAt: new Date(NOW.getTime() - 19 * MIN),
      driverSessionId: 'drv-2',
    });

    const result = await sweeper.tickOnce(NOW);

    expect(result.destroyed).toBe(0);
    expect(repo.getSession(s.id)?.status).toBe('busy');
    expect(destroyed).toHaveLength(0);
  });

  it('3. CRITICAL: never destroys a PAID (solo_manual) session, even created >20 min ago', async () => {
    const { repo, sweeper, destroyed } = build();
    repo.setAccountTier('acc-paid', 'solo_manual');
    const s = repo.seedSession({
      accountId: 'acc-paid',
      status: 'ready',
      // 10 HOURS ago — paid cap is null (unlimited), so still safe.
      createdAt: new Date(NOW.getTime() - 600 * MIN),
      driverSessionId: 'drv-3',
    });

    const result = await sweeper.tickOnce(NOW);

    expect(result.candidates).toBe(0);
    expect(result.destroyed).toBe(0);
    expect(repo.getSession(s.id)?.status).toBe('ready');
    expect(destroyed).toHaveLength(0);
  });

  it('4. leaves already-destroyed and errored sessions alone (terminal status excluded)', async () => {
    const { repo, sweeper, destroyed } = build();
    repo.setAccountTier('acc-free', 'free');
    const ago = new Date(NOW.getTime() - 60 * MIN);
    const destroyedSession = repo.seedSession({
      accountId: 'acc-free',
      status: 'destroyed',
      createdAt: ago,
      driverSessionId: 'drv-destroyed',
    });
    const erroredSession = repo.seedSession({
      accountId: 'acc-free',
      status: 'errored',
      createdAt: ago,
      driverSessionId: 'drv-errored',
    });

    const result = await sweeper.tickOnce(NOW);

    expect(result.candidates).toBe(0);
    expect(result.destroyed).toBe(0);
    // Status untouched; driver.destroy never re-fired on terminal rows.
    expect(repo.getSession(destroyedSession.id)?.status).toBe('destroyed');
    expect(repo.getSession(erroredSession.id)?.status).toBe('errored');
    expect(destroyed).toHaveLength(0);
  });

  it('mixed batch: destroys only the expired FREE session out of a free-expired / free-recent / paid-expired / destroyed set', async () => {
    const { repo, sweeper, destroyed } = build();
    repo.setAccountTier('acc-free', 'free');
    repo.setAccountTier('acc-paid', 'enterprise');

    const freeExpired = repo.seedSession({
      accountId: 'acc-free',
      status: 'ready',
      createdAt: new Date(NOW.getTime() - 30 * MIN),
      driverSessionId: 'drv-free-expired',
    });
    const freeRecent = repo.seedSession({
      accountId: 'acc-free',
      status: 'ready',
      createdAt: new Date(NOW.getTime() - 5 * MIN),
      driverSessionId: 'drv-free-recent',
    });
    const paidExpired = repo.seedSession({
      accountId: 'acc-paid',
      status: 'ready',
      createdAt: new Date(NOW.getTime() - 999 * MIN),
      driverSessionId: 'drv-paid-expired',
    });

    const result = await sweeper.tickOnce(NOW);

    expect(result.destroyed).toBe(1);
    expect(repo.getSession(freeExpired.id)?.status).toBe('destroyed');
    expect(repo.getSession(freeRecent.id)?.status).toBe('ready');
    expect(repo.getSession(paidExpired.id)?.status).toBe('ready');
    expect(destroyed).toEqual(['drv-free-expired']);
  });

  it('records an auto-destroyed event with the cap on the destroyed FREE session', async () => {
    const { repo, sweeper } = build();
    repo.setAccountTier('acc-free', 'free');
    repo.seedSession({
      accountId: 'acc-free',
      status: 'ready',
      createdAt: new Date(NOW.getTime() - 25 * MIN),
      driverSessionId: 'drv-evt',
    });

    await sweeper.tickOnce(NOW);

    const destroyEvent = repo.getEvents().find((e) => e.type === 'destroyed');
    expect(destroyEvent).toBeDefined();
    expect(destroyEvent?.payload).toMatchObject({
      auto_destroyed: true,
      reason: 'auto-destroyed: free-tier session duration cap',
      max_session_minutes: 20,
    });
  });

  it('durationCutoffsFor: only emits cutoffs for capped tiers (free); paid tiers (null cap) are absent', () => {
    const cutoffs = durationCutoffsFor(NOW);
    const tiers = cutoffs.map((c) => c.tier);
    expect(tiers).toEqual(['free']);
    // free cutoff = now - 20 min.
    expect(cutoffs[0]!.expiredBefore.toISOString()).toBe(
      new Date(NOW.getTime() - 20 * MIN).toISOString(),
    );
  });

  it('boundary: a FREE session created EXACTLY 20 min ago is NOT destroyed (strict less-than cutoff)', async () => {
    const { repo, sweeper } = build();
    repo.setAccountTier('acc-free', 'free');
    const s = repo.seedSession({
      accountId: 'acc-free',
      status: 'ready',
      // Exactly 20 min ago → createdAt == cutoff, not strictly before.
      createdAt: new Date(NOW.getTime() - 20 * MIN),
      driverSessionId: 'drv-boundary',
    });

    const result = await sweeper.tickOnce(NOW);

    expect(result.destroyed).toBe(0);
    expect(repo.getSession(s.id)?.status).toBe('ready');
  });

  it('job type is sessions.duration_sweep + cadence is 2 minutes', () => {
    expect(SESSION_DURATION_SWEEP_JOB_TYPE).toBe('sessions.duration_sweep');
    expect(SESSION_DURATION_SWEEP_INTERVAL_MS).toBe(2 * 60 * 1000);
  });
});
