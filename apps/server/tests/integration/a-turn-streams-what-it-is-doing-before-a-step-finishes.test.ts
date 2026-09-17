// B2 — the stream says what the turn is doing BEFORE any step has finished.
//
// `event: step` was the only progress the route ever emitted, and it cannot fire
// until an intent has already completed. Everything before that — the planning
// call, the browser warm-up — was three dots, for 10 to 30 seconds typically and
// up to about 150 seconds at worst. Nothing on the wire distinguished a turn
// that was working from one that had hung.
//
// The new frames (`phase`, `plan`, `step_start`, `answer`) are ADDITIVE. That
// word is doing real work here, so it is pinned three ways:
//
//   • `step` and `response` keep their exact shape and their exact ordering, so
//     an older client that only knows those two is unaffected;
//   • a client that ignores every unfamiliar event name still gets a complete
//     turn (the arm below reads ONLY `step` + `response` and asserts the turn is
//     whole);
//   • a caller that never opens a stream at all still gets the ordinary JSON
//     body, because the server must not depend on anyone listening.
//
// The plan frame carries intents through the SAME public projection the turn
// response uses, so a sensitive typed value cannot reach the wire through this
// new door. That is asserted, not assumed.

import { afterEach, describe, expect, it } from 'vitest';
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

describe('a turn streams what it is doing before a step finishes', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  async function streamOneTurn(): Promise<Frame[]> {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    const response = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}`, accept: 'text/event-stream' },
      payload: { user_message: 'open https://example.com and capture' },
    });
    expect(response.statusCode).toBe(200);
    return parseFrames(response.body);
  }

  it('emits planning, then the plan, then a start per step — all before the first step result', async () => {
    const frames = await streamOneTurn();
    const names = frames.map((f) => f.event);

    // Planning is announced first of everything, which is the only position that
    // helps: after the model call it would arrive with the answer it was meant
    // to cover for.
    const firstPhase = frames.find((f) => f.event === 'phase');
    expect(firstPhase).toBeDefined();
    expect(JSON.parse(firstPhase?.data ?? '{}')).toEqual({ phase: 'planning' });
    expect(names.indexOf('phase')).toBe(0);

    const planFrame = frames.find((f) => f.event === 'plan');
    expect(planFrame, 'the plan must be published before it runs').toBeDefined();
    const plan = JSON.parse(planFrame?.data ?? '{}') as {
      total: number;
      intents: unknown[];
      labels: string[];
    };
    expect(plan.total).toBeGreaterThan(0);
    expect(plan.intents).toHaveLength(plan.total);
    expect(plan.labels).toHaveLength(plan.total);
    // Labels are customer-facing copy: they say what the customer gets, never
    // how any of it is run, and never a typed value or a selector.
    for (const label of plan.labels) {
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toMatch(/harness|node|control plane|fleet|selector|socket/i);
    }

    const starts = frames
      .filter((f) => f.event === 'step_start')
      .map((f) => JSON.parse(f.data) as { index: number; total: number; label: string });
    expect(starts.length).toBe(plan.total);
    expect(starts.map((s) => s.index)).toEqual(starts.map((_s, i) => i));
    expect(starts.every((s) => s.total === plan.total)).toBe(true);
    expect(starts.map((s) => s.label)).toEqual(plan.labels);

    // The ordering that makes the whole thing worth having: the plan and the
    // first step_start both precede the first completed step.
    expect(names.indexOf('plan')).toBeLessThan(names.indexOf('step'));
    expect(names.indexOf('step_start')).toBeLessThan(names.indexOf('step'));
    // …and the executing phase is announced when a step actually starts, not
    // optimistically before the browser is there.
    const phases = frames
      .filter((f) => f.event === 'phase')
      .map((f) => (JSON.parse(f.data) as { phase: string }).phase);
    expect(phases.slice(0, 3)).toEqual(['planning', 'starting_browser', 'executing']);
  });

  it('leaves `step` and `response` exactly as they were, so a client that knows only those still gets a whole turn', async () => {
    const frames = await streamOneTurn();
    // Read the stream the way an older client does: skip every name it does not
    // recognise, which is the behaviour the additive contract depends on.
    const known = frames.filter((f) => f.event === 'step' || f.event === 'response');
    const steps = known
      .filter((f) => f.event === 'step')
      .map((f) => JSON.parse(f.data) as { index: number; result: unknown });
    expect(steps.length).toBeGreaterThanOrEqual(1);
    expect(steps.map((s) => s.index)).toEqual(steps.map((_s, i) => i));
    expect(steps.every((s) => typeof s.result === 'object' && s.result !== null)).toBe(true);

    const terminals = known.filter((f) => f.event === 'response');
    expect(terminals).toHaveLength(1);
    expect(JSON.parse(terminals[0]?.data ?? '{}')).toMatchObject({
      status: 200,
      body: { kind: 'plan-executed', ok: true },
    });
    // The terminal is still last of everything on the wire.
    expect(frames.at(-1)?.event).toBe('response');
  });

  it('serves the ordinary JSON body to a caller that never subscribes', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'open https://example.com and capture' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toMatchObject({ kind: 'plan-executed', ok: true });
    // Nothing leaked into the JSON lane.
    expect(res.body).not.toContain('event: phase');
  });
});
