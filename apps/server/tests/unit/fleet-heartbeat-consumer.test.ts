import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/lib/logger.js';
import type { Heartbeat } from '../../src/schemas/harness-control-protocol.js';
import { HeartbeatSchema } from '../../src/schemas/harness-control-protocol.js';
import { makeFleetHeartbeatConsumer } from '../../src/services/fleet-heartbeat-consumer.js';

function heartbeat(nodeId: string, timestamp: string): Heartbeat {
  return {
    type: 'heartbeat',
    macNodeId: nodeId,
    timestamp,
    cpuPercent: 12,
    memoryPercent: 34,
    activeSessionCount: 1,
    activeSessionStates: { agt_1: 'active' },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function logger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe('makeFleetHeartbeatConsumer', () => {
  // V-1742 — the worker has always shipped its latest fault on the heartbeat
  // (`ControlClient.swift` populates lastErrorSummary/lastErrorAtMs so "an
  // operator sees a worker's latest fault WITHOUT log-scraping") and this schema
  // never declared it. Zod's default object STRIPS unknown keys rather than
  // rejecting, so every beat parsed cleanly and the fault was discarded at the
  // receiver — the one signal that would explain an otherwise silent worker
  // failure, thrown away by the side that asked for it.
  //
  // Nothing else parses this schema, so a stripped field had no way to be noticed.
  it('CRITICAL a heartbeat carrying the worker-reported fault RETAINS it. Zod strips unknown keys silently, so an undeclared field is not an error anywhere — it is telemetry that arrives and vanishes.', () => {
    const beat = HeartbeatSchema.parse({
      type: 'heartbeat',
      macNodeId: 'node-1',
      timestamp: new Date().toISOString(),
      cpuPercent: 10,
      memoryPercent: 20,
      activeSessionCount: 0,
      lastErrorSummary: 'WebProcess terminated unexpectedly',
      lastErrorAtMs: 1_756_000_000_000,
    });
    expect(beat.lastErrorSummary, 'the fault summary must survive parsing').toBe(
      'WebProcess terminated unexpectedly',
    );
    expect(beat.lastErrorAtMs, 'the fault timestamp must survive parsing').toBe(1_756_000_000_000);
  });

  it('runs one beat per node and coalesces repeats to one newest successor', async () => {
    const first = deferred();
    const persisted: string[] = [];
    const liveness: string[] = [];
    const orphans: string[] = [];
    const boots: string[] = [];
    const consume = makeFleetHeartbeatConsumer({
      persistSnapshot: vi.fn(async (frame: Heartbeat) => {
        persisted.push(frame.timestamp);
        if (persisted.length === 1) await first.promise;
      }),
      recordLiveness: vi.fn((frame: Heartbeat) => {
        liveness.push(frame.timestamp);
      }),
      reconcileWorkerOrphans: vi.fn((frame: Heartbeat) => {
        orphans.push(frame.timestamp);
        return Promise.resolve();
      }),
      reconcileNodeBoot: vi.fn((frame: Heartbeat) => {
        boots.push(frame.timestamp);
        return Promise.resolve();
      }),
      logger: logger(),
    });

    consume(heartbeat('node-1', 'first'));
    consume(heartbeat('node-1', 'superseded'));
    consume(heartbeat('node-1', 'latest'));

    expect(persisted).toEqual(['first']);
    expect(liveness).toEqual(['first']);
    first.resolve();
    await vi.waitFor(() => expect(persisted).toEqual(['first', 'latest']));
    expect(liveness).toEqual(['first', 'latest']);
    expect(orphans).toEqual(['first', 'latest']);
    expect(boots).toEqual(['first', 'latest']);
  });

  it('isolates authenticated nodes so one blocked node does not stall another', () => {
    const persistSnapshot = vi.fn((_frame: Heartbeat) => new Promise<void>(() => undefined));
    const consume = makeFleetHeartbeatConsumer({
      persistSnapshot,
      recordLiveness: vi.fn(),
      reconcileWorkerOrphans: vi.fn(() => Promise.resolve()),
      reconcileNodeBoot: vi.fn(() => Promise.resolve()),
      logger: logger(),
    });

    consume(heartbeat('node-1', 'one'));
    consume(heartbeat('node-1', 'queued'));
    consume(heartbeat('node-2', 'two'));

    expect(persistSnapshot).toHaveBeenCalledTimes(2);
    expect(persistSnapshot).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ macNodeId: 'node-1' }),
    );
    expect(persistSnapshot).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ macNodeId: 'node-2' }),
    );
  });

  it('failure-isolates all subtasks and continues with the newest pending beat', async () => {
    const log = logger();
    const liveness = vi.fn(() => {
      throw new Error('memory store failed');
    });
    const consume = makeFleetHeartbeatConsumer({
      persistSnapshot: vi.fn(() => Promise.reject(new Error('db failed'))),
      recordLiveness: liveness,
      reconcileWorkerOrphans: vi.fn(() => Promise.reject(new Error('orphan failed'))),
      reconcileNodeBoot: vi.fn(() => Promise.reject(new Error('boot failed'))),
      logger: log,
    });

    consume(heartbeat('node-1', 'first'));
    consume(heartbeat('node-1', 'latest'));

    await vi.waitFor(() => expect(liveness).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledTimes(8));
    expect(log.error).not.toHaveBeenCalled();
  });
});
