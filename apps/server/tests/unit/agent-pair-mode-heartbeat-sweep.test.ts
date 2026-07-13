// Arc 4 Wave 2.B sub-slice 8.13c (v2-#8) — heartbeat sweep tests.

import { describe, expect, it, vi } from 'vitest';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import { AccountAuditService } from '../../src/services/account-audit.js';
import { InMemoryAccountAuditRepo } from '../integration/_helpers/in-memory-account-audit-repo.js';
import {
  InMemoryPairModeHeartbeatTracker,
  PAIR_MODE_HEARTBEAT_TTL_MS,
} from '../../src/services/agent-pair-mode-heartbeat.js';
import { PairModeHeartbeatSweep } from '../../src/services/agent-pair-mode-heartbeat-sweep.js';

const T0 = new Date('2026-05-18T12:00:00Z');
const T_PLUS_31S = new Date(T0.getTime() + 31_000);

async function setupPairSession(args: { state: 'ai-driving' | 'human-driving' }): Promise<{
  sessions: InMemoryAgentSessionsRepo;
  sessionId: string;
  accountId: string;
}> {
  const sessions = new InMemoryAgentSessionsRepo();
  const accountId = 'acc_x';
  const rec = await sessions.create({
    accountId,
    mode: 'pair',
    tokenBudgetTotal: 100_000,
  });
  if (args.state === 'human-driving') {
    await sessions.setPairModeState(rec.id, {
      kind: 'human-driving',
      clientId: 'cli_a',
      sinceAt: T0.toISOString(),
    });
  }
  return { sessions, sessionId: rec.id, accountId };
}

describe('Arc 4 Wave 2.B sub-slice 8.13c PairModeHeartbeatSweep', () => {
  it('zero stale sessions → tick is a no-op', async () => {
    const tracker = new InMemoryPairModeHeartbeatTracker();
    const { sessions } = await setupPairSession({ state: 'human-driving' });
    const auditRepo = new InMemoryAccountAuditRepo();
    const accountAudit = new AccountAuditService(auditRepo);
    const sweep = new PairModeHeartbeatSweep({ tracker, sessions, accountAudit });
    const res = await sweep.tickOnce(T0);
    expect(res).toEqual({ inspected: 0, transitioned: 0, truncated: false });
    expect(auditRepo.getAll()).toEqual([]);
  });

  it('stale human-driving session → heartbeat-timeout fires, state moves to ai-driving, audit row recorded', async () => {
    const tracker = new InMemoryPairModeHeartbeatTracker();
    const { sessions, sessionId, accountId } = await setupPairSession({
      state: 'human-driving',
    });
    tracker.recordHeartbeat({ sessionId, at: T0 });
    const auditRepo = new InMemoryAccountAuditRepo();
    const accountAudit = new AccountAuditService(auditRepo);
    const sweep = new PairModeHeartbeatSweep({ tracker, sessions, accountAudit });

    const res = await sweep.tickOnce(T_PLUS_31S);
    expect(res.inspected).toBe(1);
    expect(res.transitioned).toBe(1);

    const rec = await sessions.get(sessionId);
    expect(rec?.pairModeState).toEqual({ kind: 'ai-driving' });

    const rows = auditRepo.getAll();
    const timeoutRow = rows.find((r) => r.action === 'agent_session.pair_mode.timeout');
    expect(timeoutRow).toBeDefined();
    expect(timeoutRow?.actorType).toBe('system');
    expect(timeoutRow?.accountId).toBe(accountId);
    expect(timeoutRow?.targetResourceId).toBe(`agent_session_${sessionId}`);
    expect(timeoutRow?.payload).toMatchObject({ from: 'human-driving', to: 'ai-driving' });

    // Tracker entry forgotten so next tick doesn't re-fire.
    expect(tracker.getLastHeartbeatAt(sessionId)).toBeNull();
  });

  it('a concurrent mode winner makes the timeout CAS inert — no stale state overwrite or false audit', async () => {
    const tracker = new InMemoryPairModeHeartbeatTracker();
    const { sessions, sessionId } = await setupPairSession({ state: 'human-driving' });
    tracker.recordHeartbeat({ sessionId, at: T0 });
    const auditRepo = new InMemoryAccountAuditRepo();
    const accountAudit = new AccountAuditService(auditRepo);
    const original = sessions.compareAndSetPairModeState.bind(sessions);
    vi.spyOn(sessions, 'compareAndSetPairModeState').mockImplementationOnce(
      async (id, expected, next) => {
        await sessions.setMode(id, 'manual', null);
        return original(id, expected, next);
      },
    );
    const sweep = new PairModeHeartbeatSweep({ tracker, sessions, accountAudit });

    const res = await sweep.tickOnce(T_PLUS_31S);
    expect(res).toEqual({ inspected: 1, transitioned: 0, truncated: false });
    expect(await sessions.get(sessionId)).toMatchObject({
      mode: 'manual',
      pairModeState: null,
    });
    expect(auditRepo.getAll()).toEqual([]);
    expect(tracker.getLastHeartbeatAt(sessionId)).toEqual(T0);
  });

  it('a heartbeat refreshed during the timeout CAS rolls back only that timeout and remains tracked', async () => {
    const tracker = new InMemoryPairModeHeartbeatTracker();
    const { sessions, sessionId } = await setupPairSession({ state: 'human-driving' });
    tracker.recordHeartbeat({ sessionId, at: T0 });
    const refreshedAt = new Date(T_PLUS_31S.getTime() - 100);
    const auditRepo = new InMemoryAccountAuditRepo();
    const accountAudit = new AccountAuditService(auditRepo);
    const original = sessions.compareAndSetPairModeState.bind(sessions);
    vi.spyOn(sessions, 'compareAndSetPairModeState').mockImplementationOnce(
      async (id, expected, next) => {
        tracker.recordHeartbeat({ sessionId, at: refreshedAt });
        return original(id, expected, next);
      },
    );
    const sweep = new PairModeHeartbeatSweep({ tracker, sessions, accountAudit });

    const res = await sweep.tickOnce(T_PLUS_31S);
    expect(res).toEqual({ inspected: 1, transitioned: 0, truncated: false });
    expect((await sessions.get(sessionId))?.pairModeState).toMatchObject({
      kind: 'human-driving',
      clientId: 'cli_a',
    });
    expect(auditRepo.getAll()).toEqual([]);
    expect(tracker.getLastHeartbeatAt(sessionId)).toEqual(refreshedAt);
  });

  it('stale ai-driving session → no-op transition, no audit row emitted, tracker forgets the entry', async () => {
    const tracker = new InMemoryPairModeHeartbeatTracker();
    const { sessions, sessionId } = await setupPairSession({ state: 'ai-driving' });
    tracker.recordHeartbeat({ sessionId, at: T0 });
    const auditRepo = new InMemoryAccountAuditRepo();
    const accountAudit = new AccountAuditService(auditRepo);
    const sweep = new PairModeHeartbeatSweep({ tracker, sessions, accountAudit });

    const res = await sweep.tickOnce(T_PLUS_31S);
    expect(res.inspected).toBe(1);
    expect(res.transitioned).toBe(0);
    expect(auditRepo.getAll()).toEqual([]);
    expect(tracker.getLastHeartbeatAt(sessionId)).toBeNull();
  });

  it('audit emit failure does not break the sweep — transition still persists', async () => {
    const tracker = new InMemoryPairModeHeartbeatTracker();
    const { sessions, sessionId } = await setupPairSession({ state: 'human-driving' });
    tracker.recordHeartbeat({ sessionId, at: T0 });
    const failingAudit = {
      record: () => Promise.reject(new Error('audit down')),
    } as unknown as AccountAuditService;
    const sweep = new PairModeHeartbeatSweep({
      tracker,
      sessions,
      accountAudit: failingAudit,
    });
    const res = await sweep.tickOnce(T_PLUS_31S);
    expect(res.transitioned).toBe(1);
    const rec = await sessions.get(sessionId);
    expect(rec?.pairModeState).toEqual({ kind: 'ai-driving' });
  });

  it('session lookup miss → entry forgotten, sweep continues', async () => {
    const tracker = new InMemoryPairModeHeartbeatTracker();
    const { sessions } = await setupPairSession({ state: 'human-driving' });
    tracker.recordHeartbeat({ sessionId: 'agt_ghost', at: T0 });
    const auditRepo = new InMemoryAccountAuditRepo();
    const accountAudit = new AccountAuditService(auditRepo);
    const sweep = new PairModeHeartbeatSweep({ tracker, sessions, accountAudit });
    const res = await sweep.tickOnce(T_PLUS_31S);
    expect(res.inspected).toBe(1);
    expect(res.transitioned).toBe(0);
    expect(tracker.getLastHeartbeatAt('agt_ghost')).toBeNull();
  });

  it('maxPerTick truncates the stale set; truncated=true is reported', async () => {
    const tracker = new InMemoryPairModeHeartbeatTracker();
    const sessions = new InMemoryAgentSessionsRepo();
    // Seed 3 stale human-driving sessions.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const rec = await sessions.create({
        accountId: 'acc_x',
        mode: 'pair',
        tokenBudgetTotal: 100_000,
      });
      await sessions.setPairModeState(rec.id, {
        kind: 'human-driving',
        clientId: `cli_${i}`,
        sinceAt: T0.toISOString(),
      });
      tracker.recordHeartbeat({ sessionId: rec.id, at: new Date(T0.getTime() + i * 100) });
      ids.push(rec.id);
    }
    const accountAudit = new AccountAuditService(new InMemoryAccountAuditRepo());
    const sweep = new PairModeHeartbeatSweep({
      tracker,
      sessions,
      accountAudit,
      maxPerTick: 2,
    });
    const res = await sweep.tickOnce(T_PLUS_31S);
    expect(res.inspected).toBe(2);
    expect(res.transitioned).toBe(2);
    expect(res.truncated).toBe(true);
    // The third session remains stale + still tracked for the next tick.
    expect(
      tracker.findStaleSessions({ now: T_PLUS_31S, ttlMs: PAIR_MODE_HEARTBEAT_TTL_MS }),
    ).toEqual([ids[2]]);
  });

  // Arc 4 Wave 2.B sub-slice 8.13c.2 — closed-session defensive
  // guard. A session that closed BEFORE the heartbeat went stale
  // should NOT emit an `agent_session.pair_mode.timeout` audit row
  // — closed sessions can't transition state and the row would be
  // misleading ("auto-handback after 30s" on a row that has been
  // closed for hours).
  it('closed session → no-op tick, no audit row, tracker forgets the entry', async () => {
    const tracker = new InMemoryPairModeHeartbeatTracker();
    const { sessions, sessionId } = await setupPairSession({ state: 'human-driving' });
    // Close the session before the sweep runs.
    await sessions.closeWithReason(sessionId, 'customer ended');
    tracker.recordHeartbeat({ sessionId, at: T0 });
    const auditRepo = new InMemoryAccountAuditRepo();
    const accountAudit = new AccountAuditService(auditRepo);
    const sweep = new PairModeHeartbeatSweep({ tracker, sessions, accountAudit });
    const res = await sweep.tickOnce(T_PLUS_31S);
    expect(res.inspected).toBe(1);
    expect(res.transitioned).toBe(0);
    expect(auditRepo.getAll()).toEqual([]);
    expect(tracker.getLastHeartbeatAt(sessionId)).toBeNull();
  });

  // Re-entrancy guard: bootstrap fires tickOnce on a fixed 5s setInterval that
  // does NOT await the previous tick, so a slow tick can overlap the next. Since
  // `forget` runs only AFTER the persist, an unguarded overlap would process the
  // SAME stale session twice → a DUPLICATE pair_mode.timeout audit row. The guard
  // makes an overlapping invocation a clean no-op.
  it('re-entrancy guard: overlapping tickOnce is a no-op — a stale session is handled once, no duplicate timeout audit', async () => {
    const tracker = new InMemoryPairModeHeartbeatTracker();
    const { sessions, sessionId } = await setupPairSession({ state: 'human-driving' });
    tracker.recordHeartbeat({ sessionId, at: T0 });
    const auditRepo = new InMemoryAccountAuditRepo();
    const accountAudit = new AccountAuditService(auditRepo);
    const sweep = new PairModeHeartbeatSweep({ tracker, sessions, accountAudit });

    // Fire two ticks without awaiting the first — the second overlaps while the
    // first is mid-flight (the guard is set synchronously at entry).
    const p1 = sweep.tickOnce(T_PLUS_31S);
    const p2 = sweep.tickOnce(T_PLUS_31S);
    const [r1, r2] = await Promise.all([p1, p2]);

    // Exactly one tick did the work; the overlapping one was a clean no-op.
    expect(r1.transitioned).toBe(1);
    expect(r2).toEqual({ inspected: 0, transitioned: 0, truncated: false });
    // Critically: a single timeout audit row — no duplicate from the overlap.
    expect(
      auditRepo.getAll().filter((r) => r.action === 'agent_session.pair_mode.timeout'),
    ).toHaveLength(1);
  });

  it('custom ttlMs overrides the 30s default', async () => {
    const tracker = new InMemoryPairModeHeartbeatTracker();
    const { sessions, sessionId } = await setupPairSession({ state: 'human-driving' });
    tracker.recordHeartbeat({ sessionId, at: T0 });
    const accountAudit = new AccountAuditService(new InMemoryAccountAuditRepo());
    // ttl=10s, now=T0+15s — within 30s default (would be no-op),
    // but past the 10s override (so transitions).
    const sweep = new PairModeHeartbeatSweep({
      tracker,
      sessions,
      accountAudit,
      ttlMs: 10_000,
    });
    const res = await sweep.tickOnce(new Date(T0.getTime() + 15_000));
    expect(res.transitioned).toBe(1);
  });
});
