// A question that could not be answered says why.
//
// When a message asks for information ("…and tell me the total"), the turn reads
// the page back after its steps and returns the reply as `answer`. When that
// read-back cannot produce an answer, the turn works out a sentence saying why
// and adds it to the session transcript. The response used to drop it: a program
// got the list of completed steps, no `answer`, and no explanation.
//
// It now comes back as `answer_unavailable`, on the JSON response and on the
// streamed turn's final response alike. ADDITIVE and optional: it is present only
// on a turn that asked for information and got none, never alongside `answer`,
// and never on a turn that only acted.
//
// The device is the stub every agent-session integration test uses, given the
// one ability it lacks: reading the page back. What it reads is set per test.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentDecomposer,
  AnswerArgs,
  AnswerResult,
  DecomposeArgs,
  DecomposeResult,
} from '../../src/services/agent-decomposer.js';
import type * as AgentExecutorModule from '../../src/services/agent-executor.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const device = vi.hoisted(() => ({
  /** What the page says when it is read back; null is a page that cannot be read. */
  pageText: null as string | null,
}));

vi.mock('../../src/services/agent-executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentExecutorModule>();
  class StubAgentExecutorThatReadsThePage extends actual.StubAgentExecutor {
    observe(): Promise<string | null> {
      return Promise.resolve(device.pageText);
    }
  }
  return { ...actual, StubAgentExecutor: StubAgentExecutorThatReadsThePage };
});

const OWN_KEY = 'sk-ant-api03-readback-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ASKS =
  'Open https://portal.example.test/invoices and tell me the total of the latest invoice.';
const ONLY_ACTS = 'Open https://portal.example.test/invoices and take a screenshot.';

class PlannerThatCanAnswer implements AgentDecomposer {
  decompose(_args: DecomposeArgs): Promise<DecomposeResult> {
    return Promise.resolve({
      kind: 'plan',
      intents: [
        { kind: 'navigate', url: 'https://portal.example.test/invoices' },
        { kind: 'capture', capture: 'screenshot' },
      ],
      tokensConsumed: 50,
    });
  }

  answerFromObservation(args: AnswerArgs): Promise<AnswerResult> {
    const total = /Total due: (\$[\d,.]+)/.exec(args.observation)?.[1];
    return Promise.resolve({
      answer: total !== undefined ? `The latest invoice totals ${total}.` : '',
      tokensConsumed: 0,
    });
  }
}

interface Body {
  kind: string;
  ok: boolean;
  results: unknown[];
  answer?: string;
  answer_unavailable?: string;
}

describe('a question that could not be answered says why', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    device.pageText = null;
    if (fx) await fx.cleanup();
  });

  async function send(userMessage: string, headers: Record<string, string> = {}) {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      agentDecomposer: new PlannerThatCanAnswer(),
    });
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
      headers: { authorization: `Bearer ${fx.plaintext}`, ...headers },
      payload: { user_message: userMessage },
    });
    return { id, response };
  }

  it('CRITICAL the page could not be read back: every step ran, there is no `answer`, and `answer_unavailable` says why', async () => {
    device.pageText = null;
    const { id, response } = await send(ASKS, { 'x-byok-anthropic-api-key': OWN_KEY });
    expect(response.statusCode).toBe(200);
    const body = response.json<Body>();
    expect(body.kind).toBe('plan-executed');
    expect(body.ok).toBe(true);
    expect(body.results).toHaveLength(2);
    expect(body).not.toHaveProperty('answer');
    expect(body.answer_unavailable).toBe(
      'I finished the steps above, but could not read the page back afterwards, so I cannot answer from it.',
    );
    // The same sentence the session transcript already carried.
    const stored = await fx.agentSessionsRepo?.get(id);
    expect(stored?.transcript.at(-1)).toMatchObject({
      role: 'agent',
      body: body.answer_unavailable,
    });
  });

  it('no AI key to answer with: `answer_unavailable` names that as the reason', async () => {
    device.pageText = 'Invoices · Total due: $1,284.50';
    const { response } = await send(ASKS);
    const body = response.json<Body>();
    expect(body.kind).toBe('plan-executed');
    expect(body).not.toHaveProperty('answer');
    expect(body.answer_unavailable).toMatch(/no AI key/);
  });

  it('the streamed turn’s final response carries `answer_unavailable` too', async () => {
    device.pageText = null;
    const { response } = await send(ASKS, {
      'x-byok-anthropic-api-key': OWN_KEY,
      accept: 'text/event-stream',
    });
    expect(response.statusCode).toBe(200);
    const frame = /event: response\ndata: (.+)\n\n$/.exec(response.body)?.[1];
    const terminal = JSON.parse(frame ?? '{}') as { status: number; body: Body };
    expect(terminal.status).toBe(200);
    expect(terminal.body).not.toHaveProperty('answer');
    expect(terminal.body.answer_unavailable).toMatch(/could not read the page back/);
  });

  it('a question that WAS answered has `answer` and no `answer_unavailable`: only one of the two is ever present', async () => {
    device.pageText = 'Invoices · Total due: $1,284.50';
    const { response } = await send(ASKS, { 'x-byok-anthropic-api-key': OWN_KEY });
    const body = response.json<Body>();
    expect(body.answer).toBe('The latest invoice totals $1,284.50.');
    expect(body).not.toHaveProperty('answer_unavailable');
  });

  it('a message that only asked for an action has neither field, as before', async () => {
    device.pageText = null;
    const { response } = await send(ONLY_ACTS, { 'x-byok-anthropic-api-key': OWN_KEY });
    const body = response.json<Body>();
    expect(body.kind).toBe('plan-executed');
    expect(body.ok).toBe(true);
    expect(body).not.toHaveProperty('answer');
    expect(body).not.toHaveProperty('answer_unavailable');
  });
});
