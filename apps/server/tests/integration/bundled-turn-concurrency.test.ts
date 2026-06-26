// Billing-integrity hardening — bundled-LLM soft-cap TOCTOU race.
//
// The soft-cap gate reads sumMonthlySpendCents() then compares spent >=
// cap, and the cost row is only written AFTER the turn. N concurrent
// turns therefore all read the same pre-increment spend, all pass, and
// all overspend the cap. The per-account concurrent-turn limiter bounds
// N so the overshoot is capped (429 past the ceiling).
//
// These tests pre-occupy the limiter's slots (deterministic, no flaky
// real race) to prove the /message route consults it and 429s when full,
// and that a normal turn releases its slot (no leak).

import { afterEach, describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

async function createSession(): Promise<string> {
  const create = await fx.app.inject({
    method: 'POST',
    url: '/v1/agent-sessions',
    headers: { authorization: `Bearer ${fx.plaintext}` },
    payload: {},
  });
  return create.json<{ id: string }>().id;
}

function sendTurn(id: string) {
  return fx.app.inject({
    method: 'POST',
    url: `/v1/agent-sessions/${id}/message`,
    headers: { authorization: `Bearer ${fx.plaintext}` },
    payload: { user_message: 'open https://example.com and capture' },
  });
}

describe('bundled-LLM concurrent-turn cap (soft-cap TOCTOU bound)', () => {
  it('429s a bundled turn when the account is already at its in-flight ceiling', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableBundledLlm: { consent: true, monthlyCapUsdCents: 2000 },
      bundledTurnMaxConcurrency: 1,
    });
    const id = await createSession();
    // Simulate ONE bundled turn already in-flight by occupying the single
    // slot directly — the cap-passing turn below must then 429 rather than
    // resolve the bundled key and overspend the cap.
    expect(fx.bundledTurnConcurrency.tryAcquire(fx.accountId)).toBe(true);

    const res = await sendTurn(id);
    expect(res.statusCode).toBe(429);
    const body = res.json<{ type: string; limit: number; current_sessions: number }>();
    expect(body.type).toBe(PROBLEM_TYPES.ConcurrencyLimit);
    expect(body.limit).toBe(1);
  });

  it('releases the slot after a NORMAL turn completes (no leak) so the next turn is admitted', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableBundledLlm: { consent: true, monthlyCapUsdCents: 2000 },
      bundledTurnMaxConcurrency: 1,
    });
    const id = await createSession();

    // First turn resolves the bundled key (cap has headroom), runs, and
    // must release its slot on completion.
    const first = await sendTurn(id);
    expect(first.statusCode).toBe(200);
    expect(fx.bundledTurnConcurrency.current(fx.accountId)).toBe(0);

    // A second sequential turn must therefore still be admitted (the slot
    // wasn't leaked by the first turn).
    const second = await sendTurn(id);
    expect(second.statusCode).toBe(200);
    expect(fx.bundledTurnConcurrency.current(fx.accountId)).toBe(0);
  });

  it('does NOT consume a slot when the soft-cap gate refuses (slot reserved only after the cap passes)', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableBundledLlm: { consent: true, monthlyCapUsdCents: 2000 },
      bundledTurnMaxConcurrency: 1,
    });
    const id = await createSession();
    // Seed spend at the cap → the turn 402s at the soft-cap gate, BEFORE
    // any concurrency slot is reserved. The slot must remain free.
    fx.bundledLlmRepo.addSpend(fx.accountId, new Date(), 2000);

    const res = await sendTurn(id);
    expect(res.statusCode).toBe(402);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.BundledLlmBudgetExhausted);
    // No slot leaked by the refused turn.
    expect(fx.bundledTurnConcurrency.current(fx.accountId)).toBe(0);
  });

  it('a NON-bundled turn (BYOK header present) never touches the bundled-turn limiter', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableBundledLlm: { consent: true, monthlyCapUsdCents: 2000 },
      bundledTurnMaxConcurrency: 1,
    });
    const id = await createSession();
    // Occupy the single bundled slot. A BYOK-header turn resolves the
    // header key (not the bundled leg), so it must NOT be gated by the
    // bundled-turn limiter — it should still run.
    expect(fx.bundledTurnConcurrency.tryAcquire(fx.accountId)).toBe(true);

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-byok-anthropic-api-key': 'sk-ant-byok-header-key',
      },
      payload: { user_message: 'open https://example.com and capture' },
    });
    expect(res.statusCode).not.toBe(429);
    // The bundled slot count is unchanged (still the one we occupied).
    expect(fx.bundledTurnConcurrency.current(fx.accountId)).toBe(1);
  });
});
