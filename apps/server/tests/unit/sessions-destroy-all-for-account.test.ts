// SessionsService.destroyAllForAccount — the suspend-reclaim path that
// forcibly tears down an account's still-running browser sessions when the
// account is suspended (so they stop consuming the driver). Mirrors the
// system-actor mechanics of autoDestroyExpired; driven through the real
// service against the in-memory repo + a stub driver.

import { describe, expect, it } from 'vitest';
import { SessionsService } from '../../src/services/sessions.js';
import { InMemorySessionsRepo } from '../integration/_helpers/in-memory-sessions-repo.js';
import type { Driver } from '../../src/drivers/types.js';

const NOW = new Date('2026-05-31T12:00:00.000Z');

/** Records driver.destroy calls; optionally rejects for specific driver ids. */
function stubDriver(failFor: string[] = []): { driver: Driver; destroyed: string[] } {
  const destroyed: string[] = [];
  const driver = {
    destroy(driverSessionId: string): Promise<void> {
      if (failFor.includes(driverSessionId)) return Promise.reject(new Error('driver boom'));
      destroyed.push(driverSessionId);
      return Promise.resolve();
    },
  } as unknown as Driver;
  return { driver, destroyed };
}

describe('SessionsService.destroyAllForAccount — suspend reclaim', () => {
  it('destroys every active session for the account; leaves other accounts + terminal sessions alone; emits session.completed per destroy', async () => {
    const repo = new InMemorySessionsRepo();
    const { driver, destroyed } = stubDriver();
    const events: Array<{ accountId: string; eventType: string }> = [];
    const webhooks = {
      enqueueEvent: (accountId: string, eventType: string): Promise<number> => {
        events.push({ accountId, eventType });
        return Promise.resolve(1);
      },
    };
    const sessions = new SessionsService({ repo, driver, webhooks });

    repo.seedSession({
      accountId: 'acc-1',
      status: 'ready',
      createdAt: NOW,
      driverSessionId: 'd1',
    });
    repo.seedSession({ accountId: 'acc-1', status: 'busy', createdAt: NOW, driverSessionId: 'd2' });
    repo.seedSession({
      accountId: 'acc-1',
      status: 'creating',
      createdAt: NOW,
      driverSessionId: 'd3',
    });
    // terminal — excluded by listActiveByAccount's status filter.
    repo.seedSession({
      accountId: 'acc-1',
      status: 'destroyed',
      createdAt: NOW,
      driverSessionId: 'd4',
    });
    // other account — untouched.
    repo.seedSession({
      accountId: 'acc-2',
      status: 'ready',
      createdAt: NOW,
      driverSessionId: 'dX',
    });

    const count = await sessions.destroyAllForAccount('acc-1');

    expect(count).toBe(3);
    expect([...destroyed].sort()).toEqual(['d1', 'd2', 'd3']);
    // acc-2's session was not torn down.
    expect(destroyed).not.toContain('dX');
    // one session.completed per destroyed session, fanned to acc-1.
    const completed = events.filter(
      (e) => e.eventType === 'session.completed' && e.accountId === 'acc-1',
    );
    expect(completed).toHaveLength(3);
  });

  it('is best-effort per session — one driver failure does not block the rest', async () => {
    const repo = new InMemorySessionsRepo();
    const { driver, destroyed } = stubDriver(['boom']);
    const sessions = new SessionsService({ repo, driver });

    const failed = repo.seedSession({
      accountId: 'acc-1',
      status: 'ready',
      createdAt: NOW,
      driverSessionId: 'boom',
    });
    repo.seedSession({
      accountId: 'acc-1',
      status: 'ready',
      createdAt: NOW,
      driverSessionId: 'ok',
    });

    const count = await sessions.destroyAllForAccount('acc-1');

    expect(count).toBe(1);
    expect(destroyed).toEqual(['ok']);
    expect(repo.getSession(failed.id)?.status).toBe('destroyed');
    expect(
      repo
        .getEvents()
        .filter((event) => event.sessionId === failed.id && event.type === 'destroyed'),
    ).toHaveLength(0);
  });

  it('two concurrent suspension reclaims destroy each session exactly once', async () => {
    const repo = new InMemorySessionsRepo();
    const { driver, destroyed } = stubDriver();
    const sessions = new SessionsService({ repo, driver });
    const first = repo.seedSession({
      accountId: 'acc-1',
      status: 'ready',
      createdAt: NOW,
      driverSessionId: 'first',
    });
    const second = repo.seedSession({
      accountId: 'acc-1',
      status: 'busy',
      createdAt: NOW,
      driverSessionId: 'second',
    });

    const counts = await Promise.all([
      sessions.destroyAllForAccount('acc-1'),
      sessions.destroyAllForAccount('acc-1'),
    ]);

    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(2);
    expect([...destroyed].sort()).toEqual(['first', 'second']);
    expect(
      repo
        .getEvents()
        .filter(
          (event) =>
            (event.sessionId === first.id || event.sessionId === second.id) &&
            event.type === 'destroyed',
        ),
    ).toHaveLength(2);
  });

  it('returns 0 when the account has no active sessions', async () => {
    const repo = new InMemorySessionsRepo();
    const { driver, destroyed } = stubDriver();
    const sessions = new SessionsService({ repo, driver });
    expect(await sessions.destroyAllForAccount('acc-empty')).toBe(0);
    expect(destroyed).toEqual([]);
  });
});
