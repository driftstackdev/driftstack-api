// 2026-06-19 — unit tests for the worker-CONNECTED orphan auto-close helper
// (closeAgentSessionOnTerminalStatus, A3 W2682).
//
// Pins: a terminal sessionStatus frame closes the matching ACTIVE row with the
// frame's clean snake_case reason; idempotent on a duplicate frame; a no-op on
// an already-closed / missing row; reason = frame.reason ?? `session-<status>`;
// the liveness-store entry is dropped; a repo failure is swallowed (never throws
// into the WS receive loop).

import { describe, expect, it, vi } from 'vitest';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import { SessionLivenessStore } from '../../src/services/session-liveness-store.js';
import { SessionPageStateStore } from '../../src/services/session-page-state-store.js';
import { closeAgentSessionOnTerminalStatus } from '../../src/services/agent-session-terminal-close.js';
import type { AgentSessionsRepo } from '../../src/services/agent-sessions.js';
import type { SessionStatus, PageStateFrame } from '../../src/schemas/harness-control-protocol.js';
import type { Logger } from '../../src/lib/logger.js';
import type { SessionCapabilityReportStore } from '../../src/services/session-capability-report-store.js';

const noopLogger = { info: () => {}, warn: () => {} } as unknown as Logger;

function terminalFrame(
  sessionId: string,
  status: 'ended' | 'errored',
  reason?: string,
): SessionStatus {
  return { type: 'sessionStatus', sessionId, status, timestamp: 't', ...(reason && { reason }) };
}

function pageStateFrame(sessionId: string, state: PageStateFrame['state']): PageStateFrame {
  return { type: 'pageState', sessionId, state, url: 'https://example.com', error: null };
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

  it('evicts the capability-report entry when the worker reports the session terminal', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const created = await repo.create({ accountId: 'acct_1', tokenBudgetTotal: 1000 });
    const deleteCapabilityReport = vi.fn();
    const capabilityReports = {
      delete: deleteCapabilityReport,
    } as unknown as SessionCapabilityReportStore;

    await closeAgentSessionOnTerminalStatus({
      agentSessions: repo,
      frame: terminalFrame(created.id, 'ended', 'idle_timeout'),
      logger: noopLogger,
      sessionCapabilityReportStore: capabilityReports,
    });

    expect(deleteCapabilityReport).toHaveBeenCalledWith(created.id);
  });

  // Audit 2026-07-01 (MEDIUM) — the exact gap the audit flagged: this
  // worker-CONNECTED terminal close is a session-termination path that is NOT
  // the customer DELETE route, and it never evicted sessionPageStateStore —
  // so a session ending this way (crash / idle_timeout / browser_crashed)
  // could leave its LAST reported pageState (possibly 'stalled', the exact
  // frozen-renderer signal the feature exists to detect) cached and served by
  // GET /:id/page-state indefinitely. Mirrors the liveness-store tests above.
  it('evicts the sessionPageStateStore entry for the ended session (dead-session-serves-stale-cache gap)', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const created = await repo.create({ accountId: 'acct_1', tokenBudgetTotal: 1000 });
    const pageStates = new SessionPageStateStore();
    pageStates.set(pageStateFrame(created.id, 'stalled'));
    expect(pageStates.get(created.id)).not.toBeNull();

    await closeAgentSessionOnTerminalStatus({
      agentSessions: repo,
      frame: terminalFrame(created.id, 'errored', 'browser_crashed'),
      logger: noopLogger,
      sessionPageStateStore: pageStates,
    });

    expect(pageStates.get(created.id)).toBeNull();
  });

  it('evicts the sessionPageStateStore entry even when the row was already closed (worker says it is gone)', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const created = await repo.create({ accountId: 'acct_1', tokenBudgetTotal: 1000 });
    await repo.closeWithReason(created.id, 'customer-deleted');
    const pageStates = new SessionPageStateStore();
    pageStates.set(pageStateFrame(created.id, 'stalled'));

    await closeAgentSessionOnTerminalStatus({
      agentSessions: repo,
      frame: terminalFrame(created.id, 'ended', 'idle_timeout'),
      logger: noopLogger,
      sessionPageStateStore: pageStates,
    });

    expect(pageStates.get(created.id)).toBeNull();
  });

  it('sessionPageStateStore absent (not wired) is a harmless no-op — never throws', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const created = await repo.create({ accountId: 'acct_1', tokenBudgetTotal: 1000 });

    await expect(
      closeAgentSessionOnTerminalStatus({
        agentSessions: repo,
        frame: terminalFrame(created.id, 'ended', 'idle_timeout'),
        logger: noopLogger,
      }),
    ).resolves.toBeUndefined();
  });

  it('does NOT evict sessionPageStateStore when the terminal frame is dropped by the cross-node spoof guard', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const created = await repo.create({ accountId: 'acct_1', tokenBudgetTotal: 1000 });
    await repo.setNodeId(created.id, 'node-A'); // owned by node-A
    const pageStates = new SessionPageStateStore();
    pageStates.set(pageStateFrame(created.id, 'loaded'));

    await closeAgentSessionOnTerminalStatus({
      agentSessions: repo,
      frame: terminalFrame(created.id, 'ended', 'idle_timeout'),
      reportingNodeId: 'node-B', // a DIFFERENT node — dropped before reaching the eviction
      logger: noopLogger,
      sessionPageStateStore: pageStates,
    });

    // The session stays active AND its live pageState must NOT be wiped by a
    // rogue node's dropped frame.
    expect((await repo.get(created.id))?.status).toBe('active');
    expect(pageStates.get(created.id)).not.toBeNull();
  });

  it("audit fix 2026-07-01: a genuine TOCTOU race — another closer wins the atomic closeWithReason UPDATE between this call's stale get() read and its own close attempt — is a safe no-op that does NOT clobber the race-winner's closed_reason", async () => {
    // Simulates the exact race the audit flagged: `get()` returns a STALE
    // 'active' snapshot (as it would mid-race against another closer), but
    // the REAL DrizzleAgentSessionsRepo.closeWithReason is atomic (a single
    // `UPDATE … WHERE id=$id AND status='active' RETURNING *`) — so by the
    // time THIS call's closeWithReason actually runs, another closer (e.g.
    // this node's own bootId sweep, or a concurrent customer DELETE) has
    // already landed first with a DIFFERENT reason, and the atomic WHERE no
    // longer matches. A faithful stand-in for that atomic no-op: it must
    // hand back the OTHER closer's row completely UNCHANGED, never writing
    // our attempted reason.
    const winningReason = 'browser_crashed';
    const winningClosedAt = new Date('2026-06-30T12:00:00Z');
    let closeWithReasonCalls = 0;
    const racyRepo: Pick<AgentSessionsRepo, 'get' | 'closeWithReason'> = {
      get: () =>
        Promise.resolve({
          id: 'agt_race',
          status: 'active', // STALE — another closer already won underneath.
          nodeId: null,
        } as Awaited<ReturnType<AgentSessionsRepo['get']>>),
      closeWithReason: (_id, _reason) => {
        closeWithReasonCalls += 1;
        // The atomic WHERE status='active' guard already lost the race —
        // a real closeWithReason no-ops and returns the WINNER's row,
        // regardless of what reason THIS caller asked for.
        return Promise.resolve({
          id: 'agt_race',
          status: 'closed',
          closedReason: winningReason,
          closedAt: winningClosedAt,
        } as Awaited<ReturnType<AgentSessionsRepo['closeWithReason']>>);
      },
    };

    const infoLogs: Record<string, unknown>[] = [];
    const logger = {
      info: (obj: unknown) => infoLogs.push(obj as Record<string, unknown>),
      warn: () => {},
    } as unknown as Logger;

    await closeAgentSessionOnTerminalStatus({
      agentSessions: racyRepo as AgentSessionsRepo,
      frame: terminalFrame('agt_race', 'ended', 'idle_timeout'), // the LOSING reason
      logger,
    });

    // closeWithReason still gets called once (the stale pre-check said
    // 'active') — its atomic guard is what actually loses the race, not the
    // service's pre-check.
    expect(closeWithReasonCalls).toBe(1);
    // The service must NOT claim ITS reason won when the atomic close
    // reports a DIFFERENT one actually landed.
    const closedLog = infoLogs.find(
      (l) => (l as { attemptedReason?: string }).attemptedReason === 'idle_timeout',
    );
    expect(closedLog).toBeDefined();
    expect((closedLog as { actualClosedReason?: string })?.actualClosedReason).toBe(winningReason);
    // No log line falsely claims 'idle_timeout' (the LOSING reason) as the
    // session's closed reason.
    expect(
      infoLogs.some(
        (l) => (l as { reason?: string }).reason === 'idle_timeout' && !('actualClosedReason' in l),
      ),
    ).toBe(false);
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

  it('DROPS an authenticated terminal frame when node_id is NULL', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const created = await repo.create({ accountId: 'acct_1', tokenBudgetTotal: 1000 });
    // node_id left NULL (no setNodeId). The reporting node has no ownership proof.
    await closeAgentSessionOnTerminalStatus({
      agentSessions: repo,
      frame: terminalFrame(created.id, 'ended', 'idle_timeout'),
      reportingNodeId: 'node-B',
      logger: noopLogger,
    });
    expect((await repo.get(created.id))?.status).toBe('active');
  });
});
