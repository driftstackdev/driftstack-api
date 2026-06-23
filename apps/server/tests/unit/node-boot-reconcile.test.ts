import { describe, expect, it, vi } from 'vitest';
import {
  reconcileNodeBootChange,
  WORKER_RESTARTED_CLOSE_REASON,
  WORKER_RESTART_SWEEP_MIN_IDLE_MS,
} from '../../src/services/node-boot-reconcile.js';

// The consumer always passes the recency-guard window (W2820) as the 4th arg.
const SWEEP_OPTS = { minIdleMs: WORKER_RESTART_SWEEP_MIN_IDLE_MS };

const logger = { info: vi.fn(), warn: vi.fn() } as never;

// Minimal agentSessions stub — the consumer only calls closeActiveByNodeExcept.
function sessionsStub(impl?: (nodeId: string, keepIds: readonly string[]) => Promise<number>) {
  const closeActiveByNodeExcept = vi.fn(
    (nodeId: string, keepIds: readonly string[], _reason: string) =>
      impl ? impl(nodeId, keepIds) : Promise.resolve(0),
  );
  return { closeActiveByNodeExcept };
}

describe('reconcileNodeBootChange (CP bootId consumer, A2 W2813)', () => {
  it('no-op when bootId is absent on the wire (older node)', async () => {
    const agentSessions = sessionsStub();
    const map = new Map<string, string>();
    await reconcileNodeBootChange({
      agentSessions,
      macNodeId: 'node-a',
      bootId: undefined,
      reaffirmedSessionIds: [],
      bootIdByNode: map,
      logger,
    });
    expect(agentSessions.closeActiveByNodeExcept).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
  });

  it('records but does NOT close on the FIRST bootId seen for a node (no restart inferrable)', async () => {
    const agentSessions = sessionsStub();
    const map = new Map<string, string>();
    await reconcileNodeBootChange({
      agentSessions,
      macNodeId: 'node-a',
      bootId: 'boot-1',
      reaffirmedSessionIds: ['s1'],
      bootIdByNode: map,
      logger,
    });
    expect(agentSessions.closeActiveByNodeExcept).not.toHaveBeenCalled();
    expect(map.get('node-a')).toBe('boot-1');
  });

  it('does NOT close when the bootId is unchanged across beats (mere reconnect)', async () => {
    const agentSessions = sessionsStub();
    const map = new Map<string, string>([['node-a', 'boot-1']]);
    await reconcileNodeBootChange({
      agentSessions,
      macNodeId: 'node-a',
      bootId: 'boot-1',
      reaffirmedSessionIds: [],
      bootIdByNode: map,
      logger,
    });
    expect(agentSessions.closeActiveByNodeExcept).not.toHaveBeenCalled();
  });

  it("closes the node's active sessions EXCEPT the reaffirmed ones on a bootId CHANGE (restart)", async () => {
    const agentSessions = sessionsStub(() => Promise.resolve(2));
    const map = new Map<string, string>([['node-a', 'boot-1']]);
    await reconcileNodeBootChange({
      agentSessions,
      macNodeId: 'node-a',
      bootId: 'boot-2',
      reaffirmedSessionIds: ['s-new'],
      bootIdByNode: map,
      logger,
    });
    expect(agentSessions.closeActiveByNodeExcept).toHaveBeenCalledTimes(1);
    expect(agentSessions.closeActiveByNodeExcept).toHaveBeenCalledWith(
      'node-a',
      ['s-new'],
      WORKER_RESTARTED_CLOSE_REASON,
      SWEEP_OPTS,
    );
    expect(map.get('node-a')).toBe('boot-2'); // new bootId recorded
  });

  it('forwards an EMPTY keep-set when a restarted node reports zero sessions', async () => {
    const agentSessions = sessionsStub(() => Promise.resolve(3));
    const map = new Map<string, string>([['node-a', 'boot-1']]);
    await reconcileNodeBootChange({
      agentSessions,
      macNodeId: 'node-a',
      bootId: 'boot-2',
      reaffirmedSessionIds: [],
      bootIdByNode: map,
      logger,
    });
    expect(agentSessions.closeActiveByNodeExcept).toHaveBeenCalledWith(
      'node-a',
      [],
      WORKER_RESTARTED_CLOSE_REASON,
      SWEEP_OPTS,
    );
  });

  it('tracks nodes independently — a change on one node does not affect another', async () => {
    const agentSessions = sessionsStub(() => Promise.resolve(1));
    const map = new Map<string, string>([
      ['node-a', 'boot-1'],
      ['node-b', 'boot-x'],
    ]);
    await reconcileNodeBootChange({
      agentSessions,
      macNodeId: 'node-a',
      bootId: 'boot-2',
      reaffirmedSessionIds: [],
      bootIdByNode: map,
      logger,
    });
    // Only node-a swept; node-b's recorded bootId untouched.
    expect(agentSessions.closeActiveByNodeExcept).toHaveBeenCalledTimes(1);
    expect(agentSessions.closeActiveByNodeExcept).toHaveBeenCalledWith(
      'node-a',
      expect.anything(),
      WORKER_RESTARTED_CLOSE_REASON,
      SWEEP_OPTS,
    );
    expect(map.get('node-b')).toBe('boot-x');
  });

  it('does NOT close after a CP restart (fresh map) — the first beat only records', async () => {
    // A CP restart empties bootIdByNode. The very next beat from a node carries a
    // bootId we have no prior value for → record only, never a mass-close.
    const agentSessions = sessionsStub();
    const map = new Map<string, string>(); // fresh, as after a CP restart
    await reconcileNodeBootChange({
      agentSessions,
      macNodeId: 'node-a',
      bootId: 'boot-7',
      reaffirmedSessionIds: ['s1', 's2'],
      bootIdByNode: map,
      logger,
    });
    expect(agentSessions.closeActiveByNodeExcept).not.toHaveBeenCalled();
    expect(map.get('node-a')).toBe('boot-7');
  });

  it('swallows a close failure (never rejects) so the heartbeat receive loop is safe', async () => {
    const agentSessions = sessionsStub(() => Promise.reject(new Error('db blip')));
    const map = new Map<string, string>([['node-a', 'boot-1']]);
    await expect(
      reconcileNodeBootChange({
        agentSessions,
        macNodeId: 'node-a',
        bootId: 'boot-2',
        reaffirmedSessionIds: [],
        bootIdByNode: map,
        logger,
      }),
    ).resolves.toBeUndefined();
  });
});
