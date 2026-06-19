// 2026-06-19 — worker-disconnect agent-session reaper.
//
// Pins the PRECISE complement to the 12h orphan_reap backstop: a node's active
// sessions close `grace` seconds after its control-plane connection drops,
// UNLESS it re-registers within the grace (which cancels the close — so a
// transient WS blip / deliberate restart never false-closes a live session).
// Drives the grace timer through the setTimeoutFn/clearTimeoutFn seam (a manual
// queue) so expiry is deterministic without real wall-clock.

import { describe, expect, it } from 'vitest';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import {
  WorkerDisconnectReaperService,
  WORKER_DISCONNECTED_CLOSE_REASON,
  resolveDisconnectGraceSeconds,
} from '../../src/services/worker-disconnect-reaper.js';
import type { Logger } from '../../src/lib/logger.js';

const HALF_HOUR = 30 * 60;

// Manual timer queue: each setTimeoutFn returns an incrementing handle; fire()
// invokes the pending callback for a handle. Mirrors the deterministic-timer
// pattern used elsewhere in the suite (no real setTimeout).
function manualTimers() {
  let nextHandle = 1;
  const cbs = new Map<number, () => void>();
  const armedMs: number[] = [];
  return {
    setTimeoutFn: (cb: () => void, ms: number) => {
      const handle = nextHandle++;
      cbs.set(handle, cb);
      armedMs.push(ms);
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => {
      cbs.delete(handle as unknown as number);
    },
    fire: (handle: number) => {
      const cb = cbs.get(handle);
      if (cb === undefined) throw new Error(`no pending timer for handle ${handle}`);
      cbs.delete(handle);
      cb();
    },
    isPending: (handle: number) => cbs.has(handle),
    armedMs,
  };
}

const noopLogger = { info: () => {}, warn: () => {} } as unknown as Logger;

function makeReaper(repo: InMemoryAgentSessionsRepo, graceSeconds = 120) {
  const timers = manualTimers();
  const reaper = new WorkerDisconnectReaperService({
    repo,
    logger: noopLogger,
    graceSeconds,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  return { reaper, timers };
}

async function activeSessionOnNode(repo: InMemoryAgentSessionsRepo, nodeId: string) {
  const rec = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
  await repo.setNodeId(rec.id, nodeId);
  return rec;
}

describe('resolveDisconnectGraceSeconds', () => {
  it('defaults to 120 when the env var is unset', () => {
    expect(resolveDisconnectGraceSeconds({})).toBe(120);
  });

  it('honors a valid positive override', () => {
    expect(
      resolveDisconnectGraceSeconds({ DRIFTSTACK_WORKER_DISCONNECT_GRACE_SECONDS: '300' }),
    ).toBe(300);
  });

  it('falls back to 120 for a non-finite / non-positive value (never disables the grace)', () => {
    expect(
      resolveDisconnectGraceSeconds({ DRIFTSTACK_WORKER_DISCONNECT_GRACE_SECONDS: 'nope' }),
    ).toBe(120);
    expect(resolveDisconnectGraceSeconds({ DRIFTSTACK_WORKER_DISCONNECT_GRACE_SECONDS: '0' })).toBe(
      120,
    );
    expect(
      resolveDisconnectGraceSeconds({ DRIFTSTACK_WORKER_DISCONNECT_GRACE_SECONDS: '-5' }),
    ).toBe(120);
  });
});

describe('WorkerDisconnectReaperService', () => {
  it('disconnect + grace expiry closes the node’s active sessions (reason worker-disconnected); the timer arms at grace*1000 ms', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const s1 = await activeSessionOnNode(repo, 'node-A');
    const s2 = await activeSessionOnNode(repo, 'node-A');
    const { reaper, timers } = makeReaper(repo, HALF_HOUR);

    reaper.onNodeDisconnected('node-A');
    expect(reaper.pendingCount()).toBe(1);
    expect(timers.armedMs[0]).toBe(HALF_HOUR * 1000);
    // Still active until the grace fires.
    expect((await repo.get(s1.id))!.status).toBe('active');

    timers.fire(1); // grace expired
    // Let the async closeNode microtask settle.
    await Promise.resolve();
    await Promise.resolve();

    expect((await repo.get(s1.id))!.status).toBe('closed');
    expect((await repo.get(s1.id))!.closedReason).toBe(WORKER_DISCONNECTED_CLOSE_REASON);
    expect(WORKER_DISCONNECTED_CLOSE_REASON).toBe('worker-disconnected');
    expect((await repo.get(s2.id))!.status).toBe('closed');
    expect(reaper.pendingCount()).toBe(0);
  });

  it('re-register WITHIN the grace CANCELS the timer — no close (transient WS blip / deliberate restart stays live)', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const s1 = await activeSessionOnNode(repo, 'node-A');
    const { reaper, timers } = makeReaper(repo);

    reaper.onNodeDisconnected('node-A');
    expect(reaper.pendingCount()).toBe(1);
    // The node reconnects before the grace fires.
    reaper.onNodeRegistered('node-A');
    expect(reaper.pendingCount()).toBe(0);
    expect(timers.isPending(1)).toBe(false); // timer was cleared
    // The session is NOT closed — the worker is alive.
    expect((await repo.get(s1.id))!.status).toBe('active');
    expect((await repo.get(s1.id))!.closedReason).toBeNull();
  });

  it('another node’s sessions are untouched when a different node disconnects', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const onA = await activeSessionOnNode(repo, 'node-A');
    const onB = await activeSessionOnNode(repo, 'node-B');
    const { reaper, timers } = makeReaper(repo);

    reaper.onNodeDisconnected('node-A');
    timers.fire(1);
    await Promise.resolve();
    await Promise.resolve();

    expect((await repo.get(onA.id))!.status).toBe('closed');
    // node-B never disconnected → its active session is untouched.
    expect((await repo.get(onB.id))!.status).toBe('active');
  });

  it('an already-closed session is untouched (no double-close, original reason kept) when its node disconnects', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const closed = await activeSessionOnNode(repo, 'node-A');
    await repo.closeWithReason(closed.id, 'customer-closed');
    const stillActive = await activeSessionOnNode(repo, 'node-A');
    const { reaper, timers } = makeReaper(repo);

    reaper.onNodeDisconnected('node-A');
    timers.fire(1);
    await Promise.resolve();
    await Promise.resolve();

    // The already-closed row keeps its original reason (not re-stamped).
    expect((await repo.get(closed.id))!.closedReason).toBe('customer-closed');
    // The still-active row on the same node IS closed.
    expect((await repo.get(stillActive.id))!.status).toBe('closed');
    expect((await repo.get(stillActive.id))!.closedReason).toBe(WORKER_DISCONNECTED_CLOSE_REASON);
  });

  it('a re-disconnect (flapping) replaces the pending timer — the window restarts from the LAST drop', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const s1 = await activeSessionOnNode(repo, 'node-A');
    const { reaper, timers } = makeReaper(repo);

    reaper.onNodeDisconnected('node-A'); // timer handle 1
    reaper.onNodeDisconnected('node-A'); // replaces → handle 1 cleared, handle 2 armed
    expect(reaper.pendingCount()).toBe(1);
    expect(timers.isPending(1)).toBe(false);
    expect(timers.isPending(2)).toBe(true);
    // Firing the STALE handle throws in the test queue (it was cleared) — prove
    // it's gone, then fire the live one.
    timers.fire(2);
    await Promise.resolve();
    await Promise.resolve();
    expect((await repo.get(s1.id))!.status).toBe('closed');
  });

  it('a closeActiveByNode failure on grace expiry is swallowed (no uncaught throw in the timer cb)', async () => {
    const throwingRepo = {
      closeActiveByNode: () => Promise.reject(new Error('db down')),
    } as unknown as InMemoryAgentSessionsRepo;
    const { reaper, timers } = makeReaper(throwingRepo);
    reaper.onNodeDisconnected('node-A');
    expect(() => timers.fire(1)).not.toThrow();
    // settle the rejected promise so it doesn't surface as unhandled
    await Promise.resolve();
    await Promise.resolve();
    expect(reaper.pendingCount()).toBe(0);
  });

  it('onNodeRegistered with no pending timer is a harmless no-op', () => {
    const repo = new InMemoryAgentSessionsRepo();
    const { reaper } = makeReaper(repo);
    expect(() => reaper.onNodeRegistered('never-disconnected')).not.toThrow();
    expect(reaper.pendingCount()).toBe(0);
  });

  it('stop() clears all pending timers', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    await activeSessionOnNode(repo, 'node-A');
    await activeSessionOnNode(repo, 'node-B');
    const { reaper } = makeReaper(repo);
    reaper.onNodeDisconnected('node-A');
    reaper.onNodeDisconnected('node-B');
    expect(reaper.pendingCount()).toBe(2);
    reaper.stop();
    expect(reaper.pendingCount()).toBe(0);
  });
});
