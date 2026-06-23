// 2026-06-19 — unit tests for the worker-CONNECTED orphan auto-close helper
// (closeAgentSessionOnTerminalStatus, A3 W2682).
//
// Pins: a terminal sessionStatus frame closes the matching ACTIVE row with the
// frame's clean snake_case reason; idempotent on a duplicate frame; a no-op on
// an already-closed / missing row; reason = frame.reason ?? `session-<status>`;
// the liveness-store entry is dropped; a repo failure is swallowed (never throws
// into the WS receive loop).

import { describe, expect, it } from 'vitest';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import { SessionLivenessStore } from '../../src/services/session-liveness-store.js';
import { closeAgentSessionOnTerminalStatus } from '../../src/services/agent-session-terminal-close.js';
import type { AgentSessionsRepo } from '../../src/services/agent-sessions.js';
import type { SessionStatus } from '../../src/schemas/harness-control-protocol.js';
import type { Logger } from '../../src/lib/logger.js';

const noopLogger = { info: () => {}, warn: () => {} } as unknown as Logger;

function terminalFrame(
  sessionId: string,
  status: 'ended' | 'errored',
  reason?: string,
): SessionStatus {
  return { type: 'sessionStatus', sessionId, status, timestamp: 't', ...(reason && { reason }) };
}

describe('closeAgentSessionOnTerminalStatus (A3 W2682)', () => {
  it('closes an ACTIVE row with the frame reason on a terminal frame', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const created = await repo.create({ accountId: 'acct_1', tokenBudgetTotal: 1000 });
    expect(created.status).toBe('active');

    await closeAgentSessionOnTerminalStatus({
      agentSessions: repo,
      frame: terminalFrame(created.id, 'ended', 'idle_timeout'),
      logger: noopLogger,
    });

    const after = await repo.get(created.id);
    expect(after?.status).toBe('closed');
    expect(after?.closedReason).toBe('idle_timeout');
  });

  it('synthesizes `session-<status>` when the frame omits a reason (provisioning-failure errored frame carries reason:nil)', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const created = await repo.create({ accountId: 'acct_1', tokenBudgetTotal: 1000 });

    await closeAgentSessionOnTerminalStatus({
      agentSessions: repo,
      frame: terminalFrame(created.id, 'errored'), // no reason
      logger: noopLogger,
    });

    const after = await repo.get(created.id);
    expect(after?.status).toBe('closed');
    expect(after?.closedReason).toBe('session-errored');
  });

  it('is idempotent on a duplicate terminal frame (the 2nd is a no-op; first close wins)', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const created = await repo.create({ accountId: 'acct_1', tokenBudgetTotal: 1000 });

    await closeAgentSessionOnTerminalStatus({
      agentSessions: repo,
      frame: terminalFrame(created.id, 'ended', 'idle_timeout'),
      logger: noopLogger,
    });
    const firstClose = await repo.get(created.id);
    // A second (duplicate) terminal frame with a DIFFERENT reason must NOT
    // re-stamp the row — the 'active'-guard makes it a no-op.
    await closeAgentSessionOnTerminalStatus({
      agentSessions: repo,
      frame: terminalFrame(created.id, 'errored', 'browser_crashed'),
      logger: noopLogger,
    });
    const secondClose = await repo.get(created.id);

    expect(secondClose?.status).toBe('closed');
    expect(secondClose?.closedReason).toBe('idle_timeout'); // unchanged
    expect(secondClose?.closedAt?.getTime()).toBe(firstClose?.closedAt?.getTime());
  });

  it('is a no-op on an already-closed row (e.g. a prior DELETE / backstop reaper)', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const created = await repo.create({ accountId: 'acct_1', tokenBudgetTotal: 1000 });
    await repo.closeWithReason(created.id, 'customer-deleted');

    await closeAgentSessionOnTerminalStatus({
      agentSessions: repo,
      frame: terminalFrame(created.id, 'ended', 'idle_timeout'),
      logger: noopLogger,
    });

    const after = await repo.get(created.id);
    expect(after?.status).toBe('closed');
    expect(after?.closedReason).toBe('customer-deleted'); // not overwritten
  });

  it('is a no-op (no throw) on an unknown / missing session id', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    await expect(
      closeAgentSessionOnTerminalStatus({
        agentSessions: repo,
        frame: terminalFrame('agt_does_not_exist', 'ended', 'idle_timeout'),
        logger: noopLogger,
      }),
    ).resolves.toBeUndefined();
  });

  it('drops the liveness-store entry for the ended session', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const created = await repo.create({ accountId: 'acct_1', tokenBudgetTotal: 1000 });
    const liveness = new SessionLivenessStore();
    liveness.recordBeat('node-1', { [created.id]: 'active' }, Date.now());
    expect(liveness.get(created.id)).not.toBeNull();

    await closeAgentSessionOnTerminalStatus({
      agentSessions: repo,
      frame: terminalFrame(created.id, 'ended', 'idle_timeout'),
      logger: noopLogger,
      livenessStore: liveness,
    });

    expect(liveness.get(created.id)).toBeNull();
  });

  it('drops the liveness-store entry even when the row was already closed (worker says it is gone)', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const created = await repo.create({ accountId: 'acct_1', tokenBudgetTotal: 1000 });
    await repo.closeWithReason(created.id, 'customer-deleted');
    const liveness = new SessionLivenessStore();
    liveness.recordBeat('node-1', { [created.id]: 'terminating' }, Date.now());

    await closeAgentSessionOnTerminalStatus({
      agentSessions: repo,
      frame: terminalFrame(created.id, 'ended', 'idle_timeout'),
      logger: noopLogger,
      livenessStore: liveness,
    });

    expect(liveness.get(created.id)).toBeNull();
  });

  it('swallows a repo failure (never throws into the WS receive loop)', async () => {
    const warned: unknown[] = [];
    const logger = {
      info: () => {},
      warn: (obj: unknown) => warned.push(obj),
    } as unknown as Logger;
    // A repo whose get() resolves an active row but closeWithReason rejects.
    const failingRepo: Pick<AgentSessionsRepo, 'get' | 'closeWithReason'> = {
      get: () =>
        Promise.resolve({ id: 'agt_a', status: 'active' } as Awaited<
          ReturnType<AgentSessionsRepo['get']>
        >),
      closeWithReason: () => Promise.reject(new Error('db down')),
    };

    await expect(
      closeAgentSessionOnTerminalStatus({
        agentSessions: failingRepo as AgentSessionsRepo,
        frame: terminalFrame('agt_a', 'errored', 'browser_crashed'),
        logger,
      }),
    ).resolves.toBeUndefined();
    expect(warned).toHaveLength(1);
  });
});

describe('closeAgentSessionOnTerminalStatus — cross-node ownership guard (audit #5)', () => {
  it('DROPS a terminal frame from a NON-owning node (node_id set + differs) — session stays active', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const created = await repo.create({ accountId: 'acct_1', tokenBudgetTotal: 1000 });
    await repo.setNodeId(created.id, 'node-A'); // owned by node-A
    await closeAgentSessionOnTerminalStatus({
      agentSessions: repo,
      frame: terminalFrame(created.id, 'ended', 'idle_timeout'),
      reportingNodeId: 'node-B', // a DIFFERENT node reports it terminal → spoof
      logger: noopLogger,
    });
    const after = await repo.get(created.id);
    expect(after?.status).toBe('active'); // not closed by the rogue node
  });

  it('CLOSES a terminal frame from the OWNING node', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const created = await repo.create({ accountId: 'acct_1', tokenBudgetTotal: 1000 });
    await repo.setNodeId(created.id, 'node-A');
    await closeAgentSessionOnTerminalStatus({
      agentSessions: repo,
      frame: terminalFrame(created.id, 'ended', 'idle_timeout'),
      reportingNodeId: 'node-A', // the owning node
      logger: noopLogger,
    });
    expect((await repo.get(created.id))?.status).toBe('closed');
  });

  it('ALLOWS a terminal frame when node_id is NULL (legacy/never-dispatched) — no teardown regression', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const created = await repo.create({ accountId: 'acct_1', tokenBudgetTotal: 1000 });
    // node_id left NULL (no setNodeId). The guard must NOT drop this.
    await closeAgentSessionOnTerminalStatus({
      agentSessions: repo,
      frame: terminalFrame(created.id, 'ended', 'idle_timeout'),
      reportingNodeId: 'node-B',
      logger: noopLogger,
    });
    expect((await repo.get(created.id))?.status).toBe('closed');
  });
});
