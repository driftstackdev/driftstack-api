// V-785 — which parked pair-mode sessions the boot seed asks for.
//
// The integration sibling proves bootstrap actually asks and that the answer
// reaches the heartbeat tracker. This file owns the selection rule, where the
// two failure directions are opposite and both bad:
//
//   too few   a parked session left out is invisible to the 5s sweep, so the
//             revert `docs/api/agent-sessions.md` promises after 30s never
//             fires — and the session cannot rescue itself, because the
//             input-event route 409s on every parked state before it reaches
//             `recordHeartbeat`.
//
//   too many  an `ai-driving` session handed a heartbeat is handed a countdown
//             it never asked for. It is at rest, not waiting on anyone, and
//             `heartbeat-timeout` from `ai-driving` is a no-op today — so the
//             cost is wasted sweep work now and a real bug the moment that
//             transition stops being inert.
//
// The unknown-kind case is the deliberate asymmetry: a state this build does
// not recognise is INCLUDED. Being timed out is the safe direction; being
// stranded is not.

import { describe, expect, it } from 'vitest';

import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';

async function repoWith(
  rows: { pairModeState: unknown; close?: boolean }[],
): Promise<{ repo: InMemoryAgentSessionsRepo; ids: string[] }> {
  const repo = new InMemoryAgentSessionsRepo();
  const ids: string[] = [];
  for (const row of rows) {
    const session = await repo.create({
      accountId: 'acc_v785',
      tokenBudgetTotal: 1000,
      mode: 'pair',
    });
    await repo.setPairModeState(session.id, row.pairModeState);
    if (row.close === true) await repo.closeWithReason(session.id, 'test');
    ids.push(session.id);
  }
  return { repo, ids };
}

describe('V-785 the boot seed asks for exactly the parked pair-mode sessions', () => {
  it('CRITICAL every non-ai-driving state is returned. Each of these is a session waiting on a client that may never come back, and the heartbeat sweep is the only thing that can release it — a state left out here is a session parked until the orphan reaper closes it.', async () => {
    const { repo, ids } = await repoWith([
      { pairModeState: { kind: 'takeover-pending', requestedByClientId: 'c', requestedAt: 'x' } },
      { pairModeState: { kind: 'takeover-queued', requestedByClientId: 'c', queuedAt: 'x' } },
      { pairModeState: { kind: 'human-driving', clientId: 'c', sinceAt: 'x' } },
      { pairModeState: { kind: 'handback-pending', requestedAt: 'x' } },
    ]);

    const parked = await repo.listActivePairModeSessionIds();
    expect([...parked].sort(), 'all four parked states').toEqual([...ids].sort());
  });

  it('CRITICAL an ai-driving session is NOT returned. It is the resting state — nobody is waiting on a client — and seeding it would give every ordinary pair session a countdown it never asked for.', async () => {
    const { repo } = await repoWith([{ pairModeState: { kind: 'ai-driving' } }]);
    await expect(repo.listActivePairModeSessionIds()).resolves.toEqual([]);
  });

  it('CRITICAL a session with NO pair-mode state is NOT returned. Non-pair sessions carry SQL NULL here, and a null-handling slip that swept them in would seed the tracker with every session on the deployment.', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    await repo.create({ accountId: 'acc_v785', tokenBudgetTotal: 1000, mode: 'ai' });
    await expect(repo.listActivePairModeSessionIds()).resolves.toEqual([]);
  });

  it('CRITICAL a CLOSED session is NOT returned even while parked. Its state was frozen at close; there is nothing to revert to, and seeding it would have the sweep do transition work against a dead row on every tick.', async () => {
    const { repo } = await repoWith([
      {
        pairModeState: { kind: 'takeover-pending', requestedByClientId: 'c', requestedAt: 'x' },
        close: true,
      },
    ]);
    await expect(repo.listActivePairModeSessionIds()).resolves.toEqual([]);
  });

  it('CRITICAL an UNRECOGNISED kind IS returned. This asymmetry is deliberate: a state a future build introduces, or a malformed row, is exactly the one most likely to strand a session, and the two directions are not equally bad — a spurious timeout costs one auto-revert, a missed one parks a session until it is reaped.', async () => {
    const { repo, ids } = await repoWith([
      { pairModeState: { kind: 'some-future-state' } },
      { pairModeState: {} },
    ]);
    const parked = await repo.listActivePairModeSessionIds();
    expect([...parked].sort(), 'unknown and kind-less states both included').toEqual(
      [...ids].sort(),
    );
  });

  it('CRITICAL the selection is not vacuous — a mixed population returns the parked ones and only those. Each case above passes on an empty result for its own reason; this one cannot.', async () => {
    const { repo, ids } = await repoWith([
      { pairModeState: { kind: 'ai-driving' } },
      { pairModeState: { kind: 'human-driving', clientId: 'c', sinceAt: 'x' } },
      { pairModeState: { kind: 'ai-driving' } },
      {
        pairModeState: { kind: 'takeover-pending', requestedByClientId: 'c', requestedAt: 'x' },
        close: true,
      },
      { pairModeState: { kind: 'takeover-pending', requestedByClientId: 'c', requestedAt: 'x' } },
    ]);

    const parked = await repo.listActivePairModeSessionIds();
    expect(parked, 'two of five').toHaveLength(2);
    expect([...parked].sort()).toEqual([ids[1]!, ids[4]!].sort());
  });
});
