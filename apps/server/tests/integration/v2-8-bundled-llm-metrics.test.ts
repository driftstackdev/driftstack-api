// Arc 4 Wave 2.B sub-slice 8.19 (v2-#8) — bundled-LLM Prometheus metrics.
//
// Pins the three counter emission points:
//   - bundled_llm_request_total{outcome="ok"}        on a consented + under-cap turn
//   - bundled_llm_error_total{kind="consent_missing"} on consent=false turn
//   - bundled_llm_error_total{kind="budget_exhausted"} on cap-reached turn

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

describe('Arc 4 Wave 2.B sub-slice 8.19 bundled-LLM Prometheus metrics', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('successful bundled-LLM turn increments driftstack_bundled_llm_request_total{outcome="ok"}', async () => {
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
    const turn = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'open https://example.com and capture' },
    });
    expect(turn.statusCode).toBe(200);
    expect(
      fx.metricsRegistry.getValue('driftstack_bundled_llm_request_total', { outcome: 'ok' }),
    ).toBe(1);
  });

  it('consent=false turn increments driftstack_bundled_llm_error_total{kind="consent_missing"}', async () => {
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
    await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'open https://example.com and capture' },
    });
    expect(
      fx.metricsRegistry.getValue('driftstack_bundled_llm_error_total', {
        kind: 'consent_missing',
      }),
    ).toBe(1);
  });

  it('budget-exhausted turn increments driftstack_bundled_llm_error_total{kind="budget_exhausted"}', async () => {
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
    fx.bundledLlmRepo.addSpend(fx.accountId, new Date(), 2000);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'open https://example.com and capture' },
    });
    expect(res.statusCode).toBe(402);
    expect(
      fx.metricsRegistry.getValue('driftstack_bundled_llm_error_total', {
        kind: 'budget_exhausted',
      }),
    ).toBe(1);
  });
});
