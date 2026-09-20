// B6 — A MULTI-SEGMENT TURN, AS THE ROUTE PUTS IT ON THE WIRE.
//
// A turn is a loop now: look, plan as far as you can see, act, look again. Each
// pass announces its own plan, and the progress frames were written when a turn
// had exactly one. The defect that follows is specific and was already live for
// re-plans: `step_start` carries an index into the TURN's step list, and the
// route captioned it with `publicPlan[index]` — an index into the CURRENT
// segment's plan. Every step after the first segment was captioned with the
// wrong step, or with "Working" once the index ran off the end.
//
// ⛔ ADDITIVE, AND PINNED AS ADDITIVE. `offset`, `segment`, `status` and `cause`
// are new fields on existing frames; `notice` is a new frame and a new body
// field. A client that knows none of them still gets a whole turn, and a
// single-segment turn puts exactly the bytes on the wire it always did (that
// half is pinned by a-turn-streams-what-it-is-doing-before-a-step-finishes).

import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentDecomposer,
  DecomposeArgs,
  DecomposeResult,
} from '../../src/services/agent-decomposer.js';
import {
  MAX_PLANNER_CALLS_PER_TURN,
  TURN_LOOP_STOP_SENTENCES,
  TURN_NOTICE_REASONS,
} from '../../src/services/agent-runtime.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

interface Frame {
  event: string;
  data: string;
}

function parseFrames(body: string): Frame[] {
  return body
    .split(/\r?\n\r?\n/)
    .map((block) => {
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
        else if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
      }
      return { event, data: data.join('\n') };
    })
    .filter((f) => f.data.length > 0);
}

function scriptedPlanner(plans: (call: number) => DecomposeResult): AgentDecomposer {
  let calls = 0;
  return {
    decompose: (_args: DecomposeArgs): Promise<DecomposeResult> => {
      calls += 1;
      return Promise.resolve(plans(calls));
    },
  };
}

/** A fresh planner per turn: it counts its own calls. */
const threeSegments = (): AgentDecomposer =>
  scriptedPlanner((call) =>
    call === 1
      ? {
          kind: 'plan',
          status: 'continue',
          intents: [
            { kind: 'navigate', url: 'https://example.com/' },
            { kind: 'wait', condition: 'idle' },
          ],
          tokensConsumed: 10,
        }
      : call === 2
        ? {
            kind: 'plan',
            status: 'continue',
            intents: [{ kind: 'scroll', direction: 'down', amount_px: 400 }],
            tokensConsumed: 10,
          }
        : {
            kind: 'plan',
            status: 'done',
            intents: [{ kind: 'capture', capture: 'screenshot' }],
            tokensConsumed: 10,
          },
  );

describe('a turn of several segments streams as ONE step list', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  async function stream(decomposer: AgentDecomposer, accept = 'text/event-stream') {
    fx = await buildTestApp({ enableAgentRuntime: true, agentDecomposer: decomposer });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    return fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}`, accept },
      payload: { user_message: 'open example.com, scroll down and take a screenshot' },
    });
  }

  it('each later plan frame says where it starts, and every step_start is captioned with ITS OWN step', async () => {
    const response = await stream(threeSegments());
    expect(response.statusCode).toBe(200);
    const frames = parseFrames(response.body);

    const plans = frames
      .filter((f) => f.event === 'plan')
      .map(
        (f) =>
          JSON.parse(f.data) as {
            total: number;
            labels: string[];
            offset?: number;
            segment?: number;
            status?: string;
          },
      );
    expect(plans.map((p) => [p.offset, p.segment, p.status, p.total, p.labels.length])).toEqual([
      // The first segment is announced exactly as a whole plan always was.
      [undefined, undefined, 'continue', 2, 2],
      [2, 2, 'continue', 3, 1],
      [3, 3, 'done', 4, 1],
    ]);

    const starts = frames
      .filter((f) => f.event === 'step_start')
      .map((f) => JSON.parse(f.data) as { index: number; label: string });
    expect(starts.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    // ⛔ THE DEFECT: captioned from the turn-wide index into a segment-local
    // list, steps 2 and 3 read "Working". Each must carry its own plan's label.
    const labelAt = new Map<number, string>();
    for (const plan of plans) {
      plan.labels.forEach((label, i) => labelAt.set((plan.offset ?? 0) + i, label));
    }
    expect(starts.map((s) => s.label)).toEqual([0, 1, 2, 3].map((i) => labelAt.get(i)));
    expect(starts.every((s) => s.label !== 'Working')).toBe(true);

    // Step RESULTS are in the same one list: no index dropped, none duplicated.
    const steps = frames
      .filter((f) => f.event === 'step')
      .map((f) => (JSON.parse(f.data) as { index: number }).index);
    expect(steps).toEqual([0, 1, 2, 3]);
  });

  it('the customer is told the agent is LOOKING and CONTINUING, with the reason on the frame', async () => {
    const frames = parseFrames((await stream(threeSegments())).body);
    const phases = frames
      .filter((f) => f.event === 'phase')
      .map((f) => JSON.parse(f.data) as { phase: string; segment?: number; cause?: string });
    // The first pass carries no cause — byte for byte what it always sent.
    expect(phases[0]).toEqual({ phase: 'planning' });
    expect(phases.filter((p) => p.cause !== undefined)).toEqual([
      { phase: 'reading_page', segment: 2, cause: 'continue' },
      { phase: 'planning', segment: 2, cause: 'continue' },
      { phase: 'reading_page', segment: 3, cause: 'continue' },
      { phase: 'planning', segment: 3, cause: 'continue' },
    ]);
  });

  it('the settled body carries every segment’s results in order, and no notice when the task finished', async () => {
    const response = await stream(threeSegments(), 'application/json');
    const body = response.json<{
      kind: string;
      ok: boolean;
      results: unknown[];
      notice?: string;
    }>();
    expect(body.kind).toBe('plan-executed');
    expect(body.ok).toBe(true);
    expect(body.results).toHaveLength(4);
    expect(body).not.toHaveProperty('notice');
    // Neither half of the pair: a finished task has nothing to say about how it
    // ended, so a program never sees a reason without a sentence.
    expect(body).not.toHaveProperty('notice_reason');
  });

  it('⛔ a turn that STOPS AT A BOUND says so — as a `notice` frame before the terminal, and as `notice` in the body — because every step on the screen is a tick', async () => {
    const forever = scriptedPlanner((call) => ({
      kind: 'plan',
      status: 'continue',
      intents: [{ kind: 'scroll', direction: 'down', amount_px: 100 * call }],
      tokensConsumed: 10,
    }));
    const frames = parseFrames((await stream(forever)).body);
    const names = frames.map((f) => f.event);
    const notice = frames.find((f) => f.event === 'notice');
    // The sentence for a person, and beside it the one word a program branches
    // on — the same pair the terminal body carries.
    expect(JSON.parse(notice?.data ?? '{}')).toEqual({
      notice: TURN_LOOP_STOP_SENTENCES.planner_call_limit,
      notice_reason: TURN_NOTICE_REASONS.planner_call_limit,
    });
    expect(names.indexOf('notice')).toBeGreaterThan(names.lastIndexOf('step'));
    expect(names.at(-1)).toBe('response');
    const terminal = JSON.parse(frames.at(-1)?.data ?? '{}') as {
      body: { ok: boolean; results: unknown[]; notice?: string; notice_reason?: string };
    };
    expect(terminal.body.ok).toBe(true);
    expect(terminal.body.results).toHaveLength(MAX_PLANNER_CALLS_PER_TURN);
    expect(terminal.body.notice).toBe(TURN_LOOP_STOP_SENTENCES.planner_call_limit);
    expect(terminal.body.notice_reason).toBe(TURN_NOTICE_REASONS.planner_call_limit);
  });
});
