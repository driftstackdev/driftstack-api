// The intents of a turn cover every plan it made.
//
// A turn can plan, act, look at the page and plan again, several times. The
// response's `results` has always covered every step that ran, across all of
// those plans. Its `intents` carried only the FIRST plan, so a program reading
// the two side by side saw four results against two intents and had no way to
// know what the other two steps had been asked to do. The session transcript
// already recorded the whole list; the response now returns the same one.
//
// ADDITIVE: the field keeps its name and its shape. A single-plan turn returns
// exactly what it always did. The streamed `plan` frames are untouched: each
// still announces its own plan only, with `offset` saying where it starts.
//
// When a plan is ABANDONED part-way (a step failed and the turn planned again),
// `intents` still lists every step that was attempted, so it is longer than
// `results`: the steps of the abandoned plan that never ran are in it and have
// no result. Each `results[i].intent` remains the exact step that result is for.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentDecomposer,
  AgentIntent,
  DecomposeArgs,
  DecomposeResult,
} from '../../src/services/agent-decomposer.js';
import type * as AgentExecutorModule from '../../src/services/agent-executor.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

// The stub device runs every step. This one can also FAIL a step, which is the
// only way a turn abandons a plan: a tap on MISSING is not found on the page.
const MISSING = '#not-on-this-page';

vi.mock('../../src/services/agent-executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentExecutorModule>();
  class StubAgentExecutorThatCanFailAStep extends actual.StubAgentExecutor {
    override async execute(
      args: AgentExecutorModule.ExecuteArgs,
    ): Promise<AgentExecutorModule.ExecutorRunResult> {
      const failAt = args.plan.intents.findIndex(
        (i) => i.kind === 'interact' && i.selector === '#not-on-this-page',
      );
      if (failAt === -1) return super.execute(args);
      const ran = await super.execute({
        ...args,
        plan: { ...args.plan, intents: args.plan.intents.slice(0, failAt) },
      });
      const intent = args.plan.intents[failAt];
      if (intent === undefined) return ran;
      const failure: AgentExecutorModule.IntentResult = {
        kind: 'failure',
        intent,
        reason: 'The element was not found on the page.',
      };
      try {
        args.onStep?.(failure, ran.results.length);
      } catch {
        /* progress is best-effort */
      }
      return { results: [...ran.results, failure], ok: false };
    }
  }
  return { ...actual, StubAgentExecutor: StubAgentExecutorThatCanFailAStep };
});

function scriptedPlanner(plans: (call: number) => DecomposeResult): AgentDecomposer {
  let calls = 0;
  return {
    decompose: (_args: DecomposeArgs): Promise<DecomposeResult> => {
      calls += 1;
      return Promise.resolve(plans(calls));
    },
  };
}

const NAVIGATE: AgentIntent = { kind: 'navigate', url: 'https://example.com/' };
const WAIT: AgentIntent = { kind: 'wait', condition: 'idle' };
const SCROLL: AgentIntent = { kind: 'scroll', direction: 'down', amount_px: 400 };
const SCREENSHOT: AgentIntent = { kind: 'capture', capture: 'screenshot' };

/** Plan, act, look, plan again — three times, every step running. */
const threePlans = (): AgentDecomposer =>
  scriptedPlanner((call) =>
    call === 1
      ? { kind: 'plan', status: 'continue', intents: [NAVIGATE, WAIT], tokensConsumed: 10 }
      : call === 2
        ? { kind: 'plan', status: 'continue', intents: [SCROLL], tokensConsumed: 10 }
        : { kind: 'plan', status: 'done', intents: [SCREENSHOT], tokensConsumed: 10 },
  );

interface Body {
  kind: string;
  ok: boolean;
  intents: Array<{ kind: string; selector?: string }>;
  results: Array<{ kind: string; intent: { kind: string; selector?: string } }>;
}

describe('the intents of a turn cover every plan it made', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  async function send(decomposer: AgentDecomposer, accept = 'application/json') {
    fx = await buildTestApp({ enableAgentRuntime: true, agentDecomposer: decomposer });
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
      headers: { authorization: `Bearer ${fx.plaintext}`, accept },
      payload: { user_message: 'open example.com, scroll down and take a screenshot' },
    });
    return { id, response };
  }

  it('CRITICAL a turn that planned three times returns all four steps in `intents`, one for one with `results`, not just the first plan’s two', async () => {
    const { response } = await send(threePlans());
    expect(response.statusCode).toBe(200);
    const body = response.json<Body>();
    expect(body.kind).toBe('plan-executed');
    expect(body.results).toHaveLength(4);
    expect(body.intents.map((i) => i.kind)).toEqual(['navigate', 'wait', 'scroll', 'capture']);
    // They line up: step i of `intents` is the step result i is for.
    expect(body.intents).toEqual(body.results.map((r) => r.intent));
  });

  it('the response’s `intents` is the same list the session transcript records for the turn', async () => {
    const { id, response } = await send(threePlans());
    const stored = await fx.agentSessionsRepo?.get(id);
    const planEntry = stored?.transcript.find(
      (entry) => entry.intents !== undefined && entry.intents.length > 0,
    );
    expect(planEntry?.intents?.map((i) => i.kind)).toEqual(
      response.json<Body>().intents.map((i) => i.kind),
    );
  });

  it('the streamed turn’s final response carries the whole list too, while each `plan` frame still announces only its own plan', async () => {
    const { response } = await send(threePlans(), 'text/event-stream');
    const frames = response.body
      .split(/\r?\n\r?\n/)
      .map((block) => ({
        event: /^event: (.+)$/m.exec(block)?.[1] ?? 'message',
        data: /^data: (.+)$/m.exec(block)?.[1] ?? '',
      }))
      .filter((f) => f.data.length > 0);

    const plans = frames
      .filter((f) => f.event === 'plan')
      .map((f) => JSON.parse(f.data) as { intents: unknown[]; offset?: number; total: number });
    // ⛔ UNCHANGED. One plan per frame, each saying where it starts.
    expect(plans.map((p) => [p.intents.length, p.offset, p.total])).toEqual([
      [2, undefined, 2],
      [1, 2, 3],
      [1, 3, 4],
    ]);

    const terminal = JSON.parse(frames.at(-1)?.data ?? '{}') as { status: number; body: Body };
    expect(frames.at(-1)?.event).toBe('response');
    expect(terminal.status).toBe(200);
    expect(terminal.body.intents.map((i) => i.kind)).toEqual([
      'navigate',
      'wait',
      'scroll',
      'capture',
    ]);
  });

  it('a single-plan turn returns exactly the plan it made, as before', async () => {
    const { response } = await send(
      scriptedPlanner(() => ({
        kind: 'plan',
        intents: [NAVIGATE, SCREENSHOT],
        tokensConsumed: 10,
      })),
    );
    const body = response.json<Body>();
    expect(body.intents.map((i) => i.kind)).toEqual(['navigate', 'capture']);
    expect(body.intents).toEqual(body.results.map((r) => r.intent));
  });

  it('when a step fails and the turn plans again, `intents` keeps the abandoned plan’s unrun steps, so it is longer than `results`, and each result still names its own step', async () => {
    const tapMissing: AgentIntent = { kind: 'interact', action: 'tap', selector: MISSING };
    const { response } = await send(
      scriptedPlanner((call) =>
        call === 1
          ? // Step 2 fails, so step 3 (the screenshot) never runs under this plan.
            { kind: 'plan', intents: [NAVIGATE, tapMissing, SCREENSHOT], tokensConsumed: 10 }
          : { kind: 'plan', intents: [SCROLL, SCREENSHOT], tokensConsumed: 10 },
      ),
    );
    expect(response.statusCode).toBe(200);
    const body = response.json<Body>();
    expect(body.ok).toBe(true);
    // Every step attempted: the first plan's three, then the second plan's two.
    expect(body.intents.map((i) => i.kind)).toEqual([
      'navigate',
      'interact',
      'capture',
      'scroll',
      'capture',
    ]);
    // What RAN: navigate ✓, tap ✗, then the new plan's scroll ✓ and capture ✓.
    expect(body.results.map((r) => [r.kind, r.intent.kind])).toEqual([
      ['success', 'navigate'],
      ['failure', 'interact'],
      ['success', 'scroll'],
      ['success', 'capture'],
    ]);
    // Every step that ran is in `intents`; the pairing is `results[i].intent`.
    expect(body.intents.length).toBeGreaterThanOrEqual(body.results.length);
  });
});
