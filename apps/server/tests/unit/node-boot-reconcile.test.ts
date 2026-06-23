import { describe, expect, it, vi } from 'vitest';
import {
  reconcileNodeBootChange,
  WORKER_RESTARTED_CLOSE_REASON,
  WORKER_RESTART_SWEEP_MIN_IDLE_MS,
  WORKER_RESTART_SWEEP_REPEAT_WINDOW_MS,
} from '../../src/services/node-boot-reconcile.js';

// The consumer always passes the recency-guard window (W2820) as the 4th arg.
const SWEEP_OPTS = { minIdleMs: WORKER_RESTART_SWEEP_MIN_IDLE_MS };

const logger = { info: vi.fn(), warn: vi.fn() } as never;
const NOW = 1_700_000_000_000;

// Minimal agentSessions stub — the consumer only calls closeActiveByNodeExcept.
function sessionsStub(impl?: (nodeId: string, keepIds: readonly string[]) => Promise<number>) {
  const closeActiveByNodeExcept = vi.fn(
    (nodeId: string, keepIds: readonly string[], _reason: string) =>
      impl ? impl(nodeId, keepIds) : Promise.resolve(0),
  );
  return { closeActiveByNodeExcept };
}

// Fill the W2821 re-sweep deps (restartSweepUntil + now + logger) with defaults; each call
// gets a fresh restartSweepUntil unless a test overrides it.
function reconcile(deps: {
  agentSessions: ReturnType<typeof sessionsStub>;
  macNodeId: string;
  bootId: string | undefined;
  reaffirmedSessionIds: readonly string[];
  bootIdByNode: Map<string, string>;
  restartSweepUntil?: Map<string, number>;
  now?: number;
}): Promise<void> {
  return reconcileNodeBootChange({
    restartSweepUntil: new Map<string, number>(),
    now: NOW,
    logger,
    ...deps,
  });
}

describe('reconcileNodeBootChange (CP bootId consumer, A2 W2813 + W2821 re-sweep)', () => {
  it('no-op when bootId is absent on the wire (older node)', async () => {
    const agentSessions = sessionsStub();
    const map = new Map<string, string>();
    await reconcile({
      agentSessions,
      macNodeId: 'node-a',
      bootId: undefined,
      reaffirmedSessionIds: [],
      bootIdByNode: map,
    });
    expect(agentSessions.closeActiveByNodeExcept).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
  });

  it('records but does NOT close on the FIRST bootId seen for a node (no restart inferrable)', async () => {
    const agentSessions = sessionsStub();
    const map = new Map<string, string>();
    await reconcile({
      agentSessions,
      macNodeId: 'node-a',
      bootId: 'boot-1',
      reaffirmedSessionIds: ['s1'],
      bootIdByNode: map,
    });
    expect(agentSessions.closeActiveByNodeExcept).not.toHaveBeenCalled();
    expect(map.get('node-a')).toBe('boot-1');
  });

  it('does NOT close when the bootId is unchanged + no open window (mere reconnect)', async () => {
    const agentSessions = sessionsStub();
    const map = new Map<string, string>([['node-a', 'boot-1']]);
    await reconcile({
      agentSessions,
      macNodeId: 'node-a',
      bootId: 'boot-1',
      reaffirmedSessionIds: [],
      bootIdByNode: map,
    });
    expect(agentSessions.closeActiveByNodeExcept).not.toHaveBeenCalled();
  });

  it("closes the node's active sessions EXCEPT the reaffirmed ones on a bootId CHANGE (restart)", async () => {
    const agentSessions = sessionsStub(() => Promise.resolve(2));
    const map = new Map<string, string>([['node-a', 'boot-1']]);
    await reconcile({
      agentSessions,
      macNodeId: 'node-a',
      bootId: 'boot-2',
      reaffirmedSessionIds: ['s-new'],
      bootIdByNode: map,
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

  it('a bootId CHANGE opens the re-sweep window deadline (now + WINDOW)', async () => {
    const agentSessions = sessionsStub(() => Promise.resolve(0));
    const map = new Map<string, string>([['node-a', 'boot-1']]);
    const restartSweepUntil = new Map<string, number>();
    await reconcile({
      agentSessions,
      macNodeId: 'node-a',
      bootId: 'boot-2',
      reaffirmedSessionIds: [],
      bootIdByNode: map,
      restartSweepUntil,
    });
    expect(restartSweepUntil.get('node-a')).toBe(NOW + WORKER_RESTART_SWEEP_REPEAT_WINDOW_MS);
  });

  it('RE-SWEEPS on an unchanged beat while WITHIN the post-restart window (young-orphan re-check)', async () => {
    const agentSessions = sessionsStub(() => Promise.resolve(1));
    const map = new Map<string, string>([['node-a', 'boot-2']]); // unchanged bootId
    const restartSweepUntil = new Map<string, number>([['node-a', NOW + 50_000]]); // window open
    await reconcile({
      agentSessions,
      macNodeId: 'node-a',
      bootId: 'boot-2',
      reaffirmedSessionIds: ['s-live'],
      bootIdByNode: map,
      restartSweepUntil,
    });
    // The orphan that aged past minIdleMs is now closed even though bootId didn't change.
    expect(agentSessions.closeActiveByNodeExcept).toHaveBeenCalledWith(
      'node-a',
      ['s-live'],
      WORKER_RESTARTED_CLOSE_REASON,
      SWEEP_OPTS,
    );
    // Window NOT cleared while still open.
    expect(restartSweepUntil.get('node-a')).toBe(NOW + 50_000);
  });

  it('does NOT re-sweep once the window has ELAPSED + clears the stale deadline', async () => {
    const agentSessions = sessionsStub();
    const map = new Map<string, string>([['node-a', 'boot-2']]); // unchanged
    const restartSweepUntil = new Map<string, number>([['node-a', NOW - 1]]); // expired
    await reconcile({
      agentSessions,
      macNodeId: 'node-a',
      bootId: 'boot-2',
      reaffirmedSessionIds: [],
      bootIdByNode: map,
      restartSweepUntil,
    });
    expect(agentSessions.closeActiveByNodeExcept).not.toHaveBeenCalled();
    expect(restartSweepUntil.has('node-a')).toBe(false); // stale deadline cleaned up
  });

  it('forwards an EMPTY keep-set when a restarted node reports zero sessions', async () => {
    const agentSessions = sessionsStub(() => Promise.resolve(3));
    const map = new Map<string, string>([['node-a', 'boot-1']]);
    await reconcile({
      agentSessions,
      macNodeId: 'node-a',
      bootId: 'boot-2',
      reaffirmedSessionIds: [],
      bootIdByNode: map,
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
    await reconcile({
      agentSessions,
      macNodeId: 'node-a',
      bootId: 'boot-2',
      reaffirmedSessionIds: [],
      bootIdByNode: map,
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
    await reconcile({
      agentSessions,
      macNodeId: 'node-a',
      bootId: 'boot-7',
      reaffirmedSessionIds: ['s1', 's2'],
      bootIdByNode: map,
    });
    expect(agentSessions.closeActiveByNodeExcept).not.toHaveBeenCalled();
    expect(map.get('node-a')).toBe('boot-7');
  });

  it('swallows a close failure (never rejects) so the heartbeat receive loop is safe', async () => {
    const agentSessions = sessionsStub(() => Promise.reject(new Error('db blip')));
    const map = new Map<string, string>([['node-a', 'boot-1']]);
    await expect(
      reconcile({
        agentSessions,
        macNodeId: 'node-a',
        bootId: 'boot-2',
        reaffirmedSessionIds: [],
        bootIdByNode: map,
      }),
    ).resolves.toBeUndefined();
  });
});
