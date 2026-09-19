// A briefly unavailable AI says so in the customer's words.
//
// When the model provider is unavailable for a moment (overloaded, rate-limiting,
// a dropped connection), the turn does not fail: it comes back 200 as a `refuse`,
// the session stays active, and the customer can send the message again. The
// `refuse_reason` of that turn used to read 'agent layer temporarily unavailable;
// please retry' — "agent layer" is a name for part of the server, not something a
// customer knows. It now says what happened and what to do, in their terms.
//
// Nothing else about the turn changes: same kind, same status, no usage.

import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentDecomposer,
  DecomposeArgs,
  DecomposeResult,
} from '../../src/services/agent-decomposer.js';
import { AI_BRIEFLY_UNAVAILABLE_REFUSE_REASON } from '../../src/services/agent-runtime.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const SENTENCE =
  'The AI is briefly unavailable, so nothing was done with this message. Send it again in a moment.';

function plannerThatFailsOnceWith(message: string): AgentDecomposer {
  let calls = 0;
  return {
    decompose: (_args: DecomposeArgs): Promise<DecomposeResult> => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error(message));
      return Promise.resolve({
        kind: 'plan',
        intents: [{ kind: 'navigate', url: 'https://example.com/' }],
        tokensConsumed: 10,
      });
    },
  };
}

describe('a briefly unavailable AI says so in the customer’s words', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  const start = async (failure: string): Promise<string> => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      agentDecomposer: plannerThatFailsOnceWith(failure),
    });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    return create.json<{ id: string }>().id;
  };

  const send = (id: string, headers: Record<string, string> = {}) =>
    fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}`, ...headers },
      payload: { user_message: 'open https://example.com' },
    });

  it.each([
    [
      'the provider is overloaded',
      'Anthropic API 529: {"type":"error","error":{"type":"overloaded_error"}}',
    ],
    ['the provider is rate-limiting', 'Anthropic API 429: {"type":"error"}'],
    ['the connection dropped', 'fetch failed'],
  ])(
    'CRITICAL when %s, the turn is a 200 refuse whose reason is the customer’s sentence, with no word about how the server is built and none of the provider’s',
    async (_why, failure) => {
      const id = await start(failure);
      const res = await send(id);
      expect(res.statusCode).toBe(200);
      const body = res.json<{ kind: string; refuse_reason: string; usage?: unknown }>();
      expect(body.kind).toBe('refuse');
      expect(body.refuse_reason).toBe(SENTENCE);
      expect(AI_BRIEFLY_UNAVAILABLE_REFUSE_REASON).toBe(SENTENCE);
      expect(res.body).not.toMatch(/agent layer/i);
      expect(res.body).not.toMatch(/overloaded_error|Anthropic API|fetch failed/);
    },
  );

  it('the session stays active, and sending the message again runs it', async () => {
    const id = await start('Anthropic API 529: {"type":"error"}');
    expect((await send(id)).json<{ kind: string }>().kind).toBe('refuse');

    const session = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(session.json<{ status: string }>().status).toBe('active');

    const again = await send(id);
    expect(again.statusCode).toBe(200);
    expect(again.json<{ kind: string }>().kind).toBe('plan-executed');
  });

  it('the streamed turn’s final response carries the same sentence', async () => {
    const id = await start('Anthropic API 503: {"type":"error"}');
    const res = await send(id, { accept: 'text/event-stream' });
    const frame = /event: response\ndata: (.+)\n\n$/.exec(res.body)?.[1];
    const terminal = JSON.parse(frame ?? '{}') as {
      status: number;
      body: { kind: string; refuse_reason: string };
    };
    expect(terminal.status).toBe(200);
    expect(terminal.body.kind).toBe('refuse');
    expect(terminal.body.refuse_reason).toBe(SENTENCE);
  });
});
