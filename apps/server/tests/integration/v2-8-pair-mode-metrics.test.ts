// Arc 4 Wave 2.B sub-slice 8.18 (v2-#8) — Prometheus metrics integration.
//
// Pins three properties together:
//   1. /metrics requires the bearer token
//   2. The pair-mode counter increments on a real takeover request
//   3. The rendered text contains the expected metric name + labels

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

describe('Arc 4 Wave 2.B sub-slice 8.18 Prometheus pair-mode metrics', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('GET /metrics requires the scrape bearer token', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const unauth = await fx.app.inject({ method: 'GET', url: '/metrics' });
    expect(unauth.statusCode).toBe(401);
    const wrong = await fx.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(wrong.statusCode).toBe(401);
    const ok = await fx.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer test-scrape-token' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('text/plain');
  });

  it('takeover increments driftstack_pair_mode_transition_total{from,to}', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'pair' },
    });
    const id = create.json<{ id: string }>().id;
    expect(
      fx.metricsRegistry.getValue('driftstack_pair_mode_transition_total', {
        from: 'ai-driving',
        to: 'takeover-pending',
      }),
    ).toBe(0);
    await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/takeover`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { client_id: 'cli_a' },
    });
    expect(
      fx.metricsRegistry.getValue('driftstack_pair_mode_transition_total', {
        from: 'ai-driving',
        to: 'takeover-pending',
      }),
    ).toBe(1);

    const scrape = await fx.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer test-scrape-token' },
    });
    expect(scrape.statusCode).toBe(200);
    expect(scrape.body).toContain(
      'driftstack_pair_mode_transition_total{from="ai-driving",to="takeover-pending"} 1',
    );
    expect(scrape.body).toContain('# TYPE driftstack_pair_mode_transition_total counter');
  });
});
