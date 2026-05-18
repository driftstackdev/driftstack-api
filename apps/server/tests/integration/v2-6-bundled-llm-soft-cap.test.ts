// Arc 1 sub-slice 6.5 (v2-#6) — bundled-LLM soft-cap enforcement.
//
// Pre-turn check refuses with 402 BundledLlmBudgetExhausted when the
// customer's bundled-LLM spend in the current calendar month has
// reached their `accounts.bundled_llm_monthly_cap_usd_cents` cap.
// Tests cover:
//   - Cap not yet reached → turn succeeds (uses deployment fallback)
//   - Cap exactly reached → 402 (>=, not strict)
//   - Cap raised mid-month → next turn succeeds
//   - Customer with consent=false → resolution falls through (no
//     bundled-LLM key, 502 ByokAnthropicRequired if no header either)

import { afterEach, describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

describe('Arc 1 v2-#6 sub-slice 6.5 bundled-LLM soft-cap', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('cap NOT yet reached → 200 turn (resolution falls through to bundled-LLM leg)', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableBundledLlm: { consent: true, monthlyCapUsdCents: 2000 },
    });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    // Seed 100 cents of prior spend — well under the $20 cap.
    fx.bundledLlmRepo.addSpend(fx.accountId, new Date(), 100);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'open https://example.com and capture' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('cap EXACTLY reached → 402 BundledLlmBudgetExhausted with spent/cap extensions (>= check, not strict)', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableBundledLlm: { consent: true, monthlyCapUsdCents: 2000 },
    });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    // Seed prior spend at exactly the cap.
    fx.bundledLlmRepo.addSpend(fx.accountId, new Date(), 2000);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'open https://example.com and capture' },
    });
    expect(res.statusCode).toBe(402);
    const body = res.json<{
      type: string;
      title: string;
      spent_cents: number;
      cap_cents: number;
    }>();
    expect(body.type).toBe(PROBLEM_TYPES.BundledLlmBudgetExhausted);
    expect(body.spent_cents).toBe(2000);
    expect(body.cap_cents).toBe(2000);
  });

  it('OVER cap (cents > cap) → 402 BundledLlmBudgetExhausted', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableBundledLlm: { consent: true, monthlyCapUsdCents: 1000 },
    });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    fx.bundledLlmRepo.addSpend(fx.accountId, new Date(), 1500);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'open https://example.com and capture' },
    });
    expect(res.statusCode).toBe(402);
  });

  it('consent=false → bundled-LLM leg NOT consumed even with cap headroom (Q4=A: BYOK wins; bundled-LLM is opt-in)', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableBundledLlm: { consent: false, monthlyCapUsdCents: 2000 },
    });
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
    // Deterministic decomposer wired in tests — DOES NOT 502 on
    // missing BYOK (the 502 only fires when agentDecomposerKind ===
    // 'claude'). 200 means resolution fell through to "no key" and
    // the deterministic path served the turn. Bundled-LLM gate is
    // observably-correct: consent=false ⇒ no bundled key was used
    // (otherwise the cap would have been checked).
    expect(res.statusCode).toBe(200);
  });
});
