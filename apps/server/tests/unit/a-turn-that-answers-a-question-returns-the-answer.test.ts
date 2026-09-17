// The agent computed an answer and showed nobody.
//
// Asking "go to ifconfig.me and tell me the IP" produced a read-back answer that
// was sanitized, billed and appended to the transcript — and then stopped there.
// `RunTurnResult` carried only the plan and the step results, so the reply body
// had no answer, and the chat rendered "✓ navigated · ✓ captured screenshot".
// The one thing the customer asked for was the one thing that never arrived.
//
// This pins the two ways it now leaves the runtime:
//   • on the turn result, so the ordinary response body carries it;
//   • on the live progress stream, so a subscriber has it without waiting for
//     the body.
//
// And it pins the progress events themselves (B2). Before them, Send produced
// three dots for the whole planning + browser-warm-up window — 10 to 30 seconds
// typically — because the ONLY progress signal was `step`, which cannot fire
// until an intent has already finished. The ORDER is what makes them useful, so
// the order is asserted rather than the mere presence of each name.
//
// ⛔ Every arm here is mutation-proved: each assertion fails if the emission it
// covers is deleted. In particular the phase order arm fails if `planning` is
// moved after the decompose call, which is the edit that would silently give
// back the original silence.

import { describe, expect, it } from 'vitest';
import { AgentRuntime, type AgentTurnProgressEvent } from '../../src/services/agent-runtime.js';
import { DeterministicAgentDecomposer } from '../../src/services/agent-decomposer-deterministic.js';
import { StubAgentExecutor } from '../../src/services/agent-executor.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import type { DecomposeArgs } from '../../src/services/agent-decomposer.js';

const READ_TASK = 'get the IP from https://browserleaks.com/ip and capture the page';
const ANSWER = 'Your IP address is 203.0.113.7.';

async function makeRuntime(opts: { observe?: () => Promise<string | null>; answer?: string } = {}) {
  const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-05-16T00:00:00Z'));
  const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
  const base = new DeterministicAgentDecomposer();
  const stub = new StubAgentExecutor();
  const runtime = new AgentRuntime({
    decomposer: {
      decompose: (a: DecomposeArgs) => base.decompose(a),
      answerFromObservation: () =>
        Promise.resolve({ answer: opts.answer ?? ANSWER, tokensConsumed: 40 }),
    },
    executor: {
      execute: (a: Parameters<StubAgentExecutor['execute']>[0]) => stub.execute(a),
      observe: opts.observe ?? (() => Promise.resolve('Your IP: 203.0.113.7')),
    },
    sessions,
    archetype: 'iphone16pro_ios18_7_safari26_4',
  });
  return { runtime, sessions, seedId: seed.id };
}

describe('a turn that answers a question returns the answer', () => {
  it('carries the read-back answer on the plan-executed result, not only in the transcript', async () => {
    const { runtime, sessions, seedId } = await makeRuntime();
    const result = await runtime.runTurn({
      agentSessionId: seedId,
      userMessage: READ_TASK,
      byokApiKey: 'sk-ant-test-fake-key',
    });
    expect(result.kind).toBe('plan-executed');
    if (result.kind !== 'plan-executed') throw new Error('narrow');
    expect(result.answer).toBe(ANSWER);
    // The transcript copy is unchanged — this is additive, not a move.
    const final = await sessions.get(seedId);
    expect(final?.transcript.at(-1)?.body).toBe(ANSWER);
  });

  it('omits `answer` entirely on a turn that produced none, so the old rendering is untouched', async () => {
    // A null observation is the existing "could not read the page back" path.
    const { runtime, seedId } = await makeRuntime({ observe: () => Promise.resolve(null) });
    const result = await runtime.runTurn({
      agentSessionId: seedId,
      userMessage: READ_TASK,
      byokApiKey: 'sk-ant-test-fake-key',
    });
    if (result.kind !== 'plan-executed') throw new Error('narrow');
    expect(result.answer).toBeUndefined();
    expect('answer' in result).toBe(false);
  });

  it('publishes the answer on the progress stream too, so a subscriber need not wait for the body', async () => {
    const seen: AgentTurnProgressEvent[] = [];
    const { runtime, seedId } = await makeRuntime();
    await runtime.runTurn({
      agentSessionId: seedId,
      userMessage: READ_TASK,
      byokApiKey: 'sk-ant-test-fake-key',
      onProgress: (e) => seen.push(e),
    });
    expect(seen.filter((e) => e.kind === 'answer')).toEqual([{ kind: 'answer', answer: ANSWER }]);
  });

  it('withholds the streamed answer from a turn that loses authority at the finish line', async () => {
    // ⛔ The stream and the body must agree. The finalize authority check can
    // still turn a turn into an interrupted result that deliberately carries NO
    // answer — and an answer already pushed down the stream would be exactly the
    // exposure under a successor controller that the transcript guard beside it
    // refuses. Authority is flipped here the moment the answer lands in the
    // transcript, which is the only window where the two could disagree.
    const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-05-16T00:00:00Z'));
    const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
    let answerLanded = false;
    let checksAfterAnswer = 0;
    const flipping: typeof sessions = Object.assign(Object.create(sessions) as typeof sessions, {
      appendTranscriptIfAuthorityRevision: async (
        id: string,
        revision: number,
        entry: Parameters<typeof sessions.appendTranscriptIfAuthorityRevision>[2],
      ) => {
        const out = await sessions.appendTranscriptIfAuthorityRevision(id, revision, entry);
        if (entry.body === ANSWER) answerLanded = true;
        return out;
      },
      getAuthoritySnapshot: async (id: string) => {
        const snap = await sessions.getAuthoritySnapshot(id);
        if (snap === null || !answerLanded) return snap;
        // The FIRST check after the answer lands is the read-back's own, which
        // must pass — otherwise the turn never reaches the point where it has an
        // answer to publish, and this arm would prove nothing. Authority is lost
        // at the NEXT one: the finalize check, the only window in which the
        // stream and the body can disagree.
        checksAfterAnswer += 1;
        return checksAfterAnswer <= 1 ? snap : { ...snap, revision: snap.revision + 1 };
      },
    });
    const base = new DeterministicAgentDecomposer();
    const stub = new StubAgentExecutor();
    const runtime = new AgentRuntime({
      decomposer: {
        decompose: (a: DecomposeArgs) => base.decompose(a),
        answerFromObservation: () => Promise.resolve({ answer: ANSWER, tokensConsumed: 40 }),
      },
      executor: {
        execute: (a: Parameters<StubAgentExecutor['execute']>[0]) => stub.execute(a),
        observe: () => Promise.resolve('Your IP: 203.0.113.7'),
      },
      sessions: flipping,
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    const seen: AgentTurnProgressEvent[] = [];
    const result = await runtime.runTurn({
      agentSessionId: seed.id,
      userMessage: READ_TASK,
      byokApiKey: 'sk-ant-test-fake-key',
      onProgress: (e) => seen.push(e),
    });
    expect(result.kind).not.toBe('plan-executed');
    expect(seen.some((e) => e.kind === 'answer')).toBe(false);
  });

  it('emits phase / plan / step_start in order, with planning BEFORE the model call', async () => {
    const seen: AgentTurnProgressEvent[] = [];
    // The decomposer resolves only once the test has observed `planning`. If the
    // phase were emitted after the call instead of before it, this send would
    // deadlock rather than merely report a different order — which is exactly
    // the property that matters: the customer must be told before the wait, not
    // after it.
    let releaseDecompose = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseDecompose = resolve;
    });
    const base = new DeterministicAgentDecomposer();
    const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-05-16T00:00:00Z'));
    const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
    const stub = new StubAgentExecutor();
    const gated = new AgentRuntime({
      decomposer: {
        decompose: async (a: DecomposeArgs) => {
          await gate;
          return base.decompose(a);
        },
      },
      executor: stub,
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    const turn = gated.runTurn({
      agentSessionId: seed.id,
      userMessage: READ_TASK,
      onProgress: (e) => seen.push(e),
    });
    // Drain until the turn parks on the gated decompose. Bounded, so a runtime
    // that never emits `planning` fails this arm instead of hanging the suite —
    // and the gate is what proves the phase preceded the call: the decomposer
    // has provably not returned yet at this point.
    for (let tick = 0; tick < 50 && seen.length === 0; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(seen).toEqual([{ kind: 'phase', phase: 'planning' }]);
    releaseDecompose();
    await turn;

    const phases = seen.filter((e) => e.kind === 'phase').map((e) => e.phase);
    expect(phases.slice(0, 3)).toEqual(['planning', 'starting_browser', 'executing']);

    const plans = seen.filter((e) => e.kind === 'plan');
    expect(plans).toHaveLength(1);
    const plan = plans[0];
    if (plan?.kind !== 'plan') throw new Error('narrow');
    expect(plan.total).toBeGreaterThan(0);
    expect(plan.intents).toHaveLength(plan.total);

    // Every planned step announces its start, in order, before the run ends.
    const starts = seen.filter((e) => e.kind === 'step_start');
    expect(starts.map((e) => (e.kind === 'step_start' ? e.index : -1))).toEqual(
      Array.from({ length: plan.total }, (_unused, i) => i),
    );
    // The plan is published BEFORE the first step starts — that ordering is the
    // whole point of the plan event, since the browser warm-up sits between them.
    expect(seen.indexOf(plan)).toBeLessThan(seen.indexOf(starts[0] as AgentTurnProgressEvent));
  });

  it('announces reading_page and answering around the read-back, and only when one runs', async () => {
    const withReadback: AgentTurnProgressEvent[] = [];
    const answering = await makeRuntime();
    await answering.runtime.runTurn({
      agentSessionId: answering.seedId,
      userMessage: READ_TASK,
      byokApiKey: 'sk-ant-test-fake-key',
      onProgress: (e) => withReadback.push(e),
    });
    const readPhases = withReadback.filter((e) => e.kind === 'phase').map((e) => e.phase);
    expect(readPhases.slice(-2)).toEqual(['reading_page', 'answering']);

    // The negative control: the SAME task with no key never reaches a read-back,
    // so neither phase may be claimed. Without this, a phase emitted
    // unconditionally would still satisfy the arm above.
    const noReadback: AgentTurnProgressEvent[] = [];
    const gatedOff = await makeRuntime();
    await gatedOff.runtime.runTurn({
      agentSessionId: gatedOff.seedId,
      userMessage: READ_TASK,
      onProgress: (e) => noReadback.push(e),
    });
    const offPhases = noReadback.filter((e) => e.kind === 'phase').map((e) => e.phase);
    expect(offPhases).not.toContain('reading_page');
    expect(offPhases).not.toContain('answering');
    expect(noReadback.some((e) => e.kind === 'answer')).toBe(false);
  });

  it('never lets a throwing progress sink affect the turn', async () => {
    const { runtime, sessions, seedId } = await makeRuntime();
    const result = await runtime.runTurn({
      agentSessionId: seedId,
      userMessage: READ_TASK,
      byokApiKey: 'sk-ant-test-fake-key',
      onProgress: () => {
        throw new Error('a subscriber blew up');
      },
    });
    expect(result.kind).toBe('plan-executed');
    if (result.kind !== 'plan-executed') throw new Error('narrow');
    expect(result.answer).toBe(ANSWER);
    expect((await sessions.get(seedId))?.transcript).toHaveLength(3);
  });

  it('runs identically with no subscriber at all', async () => {
    const { runtime, sessions, seedId } = await makeRuntime();
    const result = await runtime.runTurn({
      agentSessionId: seedId,
      userMessage: READ_TASK,
      byokApiKey: 'sk-ant-test-fake-key',
    });
    expect(result.kind).toBe('plan-executed');
    expect((await sessions.get(seedId))?.transcript).toHaveLength(3);
  });
});
