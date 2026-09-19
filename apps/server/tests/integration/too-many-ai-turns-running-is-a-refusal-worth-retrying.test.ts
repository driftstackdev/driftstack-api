// "Too many AI turns running" is a refusal worth retrying, and says so.
//
// An account may have only so many turns running at once on Driftstack's
// included AI. Over that, the turn is refused. That refusal used to reuse the
// SESSION-slot error: type `concurrency-limit`, title "Concurrent session limit
// reached", detail "Account already has N active sessions; tier permits N", no
// Retry-After. Every part of that was wrong for this case:
//
//   - it is about AI TURNS, not sessions, and no plan limit is involved;
//   - `concurrency-limit` means "clears when YOU end a session", which is why it
//     carries no Retry-After and why every SDK treats it as not worth retrying.
//     This limit clears by itself, as soon as one of the running turns finishes.
//
// It is now a `rate-limited` refusal with a Retry-After, with copy about AI
// turns: the same family, and the same shape, as the account-wide running-turns
// limit beside it. How the released SDKs read the two types:
//
//   concurrency-limit → ConcurrencyLimitError, isRetryable false
//   rate-limited      → RateLimitError (retry_after_seconds), isRetryable true
//
// The slots are pre-occupied directly (deterministic, no real race).

import { afterEach, describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  retry_after_seconds?: number;
  current_sessions?: number;
  limit?: number;
}

describe('"too many AI turns running" is a refusal worth retrying, and says so', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  const atTheCeiling = async (limit: number): Promise<string> => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableBundledLlm: { consent: true, monthlyCapUsdCents: 2_000 },
      bundledTurnMaxConcurrency: limit,
    });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    for (let i = 0; i < limit; i += 1) {
      expect(fx.bundledTurnConcurrency.tryAcquire(fx.accountId)).toBe(true);
    }
    return create.json<{ id: string }>().id;
  };

  const sendTurn = (id: string, headers: Record<string, string> = {}) =>
    fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}`, ...headers },
      payload: { user_message: 'open https://example.com and capture' },
    });

  it('CRITICAL the refusal is 429 rate-limited with a Retry-After header and retry_after_seconds, not concurrency-limit', async () => {
    const id = await atTheCeiling(2);
    const res = await sendTurn(id);

    expect(res.statusCode).toBe(429);
    const body = res.json<Problem>();
    expect(body.type).toBe(PROBLEM_TYPES.RateLimited);
    expect(body.type).not.toBe(PROBLEM_TYPES.ConcurrencyLimit);
    expect(body.retry_after_seconds).toBe(1);
    expect(res.headers['retry-after']).toBe('1');
  });

  it('the copy is about AI turns: it gives the number running and the limit, and never talks about sessions or a plan', async () => {
    const id = await atTheCeiling(2);
    const body = (await sendTurn(id)).json<Problem>();

    expect(body.title).toBe('Too Many Requests');
    expect(body.detail).toBe(
      'Your account already has 2 AI turns running on Driftstack’s included AI (limit 2). Wait for one to finish, then try again.',
    );
    expect(body.detail).not.toMatch(/session/i);
    expect(body.detail).not.toMatch(/tier|plan/i);
    // The session-slot fields do not describe this refusal and are gone with the type.
    expect(body).not.toHaveProperty('current_sessions');
  });

  it('the streamed turn carries the same refusal in its final response', async () => {
    const id = await atTheCeiling(1);
    const res = await sendTurn(id, { accept: 'text/event-stream' });
    expect(res.statusCode).toBe(200);
    const frame = /event: response\ndata: (.+)\n\n$/.exec(res.body)?.[1];
    const terminal = JSON.parse(frame ?? '{}') as { status: number; body: Problem };
    expect(terminal.status).toBe(429);
    expect(terminal.body.type).toBe(PROBLEM_TYPES.RateLimited);
    expect(terminal.body.retry_after_seconds).toBe(1);
  });

  it('it clears by itself: once a running turn finishes, the same message is accepted, and the refused turn took no slot', async () => {
    const id = await atTheCeiling(1);
    expect((await sendTurn(id)).statusCode).toBe(429);
    expect(fx.bundledTurnConcurrency.current(fx.accountId)).toBe(1);

    fx.bundledTurnConcurrency.release(fx.accountId);
    const retried = await sendTurn(id);
    expect(retried.statusCode).toBe(200);
    expect(fx.bundledTurnConcurrency.current(fx.accountId)).toBe(0);
  });

  it('the SESSION limit is untouched: creating one session too many is still 429 concurrency-limit with no Retry-After', async () => {
    fx = await buildTestApp({ tier: 'solo_manual', enableAgentRuntime: true });
    const create = () =>
      fx.app.inject({
        method: 'POST',
        url: '/v1/agent-sessions',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { token_budget: 50_000, mode: 'manual' },
      });
    expect((await create()).statusCode).toBe(201);
    const refused = await create();
    expect(refused.statusCode).toBe(429);
    expect(refused.json<Problem>().type).toBe(PROBLEM_TYPES.ConcurrencyLimit);
    expect(refused.headers['retry-after']).toBeUndefined();
    expect(refused.json<Problem>().retry_after_seconds).toBeUndefined();
  });
});
