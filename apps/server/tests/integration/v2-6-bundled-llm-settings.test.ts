// Arc 1 sub-slice 6.6 (v2-#6) — self-service bundled-LLM settings.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

describe('Arc 1 v2-#6 sub-slice 6.6 GET + PATCH /v1/account/me/bundled-llm-settings', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('GET defaults — consent=false + cap=$20 (2000 cents) when no row was seeded', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/bundled-llm-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ consent: false, monthly_cap_usd_cents: 2000 });
  });

  it('PATCH flips consent — returns new state; GET round-trips', async () => {
    fx = await buildTestApp({
      enableBundledLlm: { consent: false, monthlyCapUsdCents: 2000 },
    });
    const patch = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/bundled-llm-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { consent: true },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toEqual({ consent: true, monthly_cap_usd_cents: 2000 });

    const get = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/bundled-llm-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(get.json()).toEqual({ consent: true, monthly_cap_usd_cents: 2000 });
  });

  it('PATCH raises the cap up to $10,000 (1_000_000 cents) — accepted at upper bound', async () => {
    fx = await buildTestApp({
      enableBundledLlm: { consent: true, monthlyCapUsdCents: 2000 },
    });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/bundled-llm-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { monthly_cap_usd_cents: 1_000_000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ consent: true, monthly_cap_usd_cents: 1_000_000 });
  });

  it('PATCH rejects monthly_cap_usd_cents > 1_000_000 ($10,000 cap) with 400', async () => {
    fx = await buildTestApp({
      enableBundledLlm: { consent: true, monthlyCapUsdCents: 2000 },
    });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/bundled-llm-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { monthly_cap_usd_cents: 1_000_001 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH rejects negative monthly_cap_usd_cents with 400', async () => {
    fx = await buildTestApp({
      enableBundledLlm: { consent: true, monthlyCapUsdCents: 2000 },
    });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/bundled-llm-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { monthly_cap_usd_cents: -1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH with empty body → 400 (must include at least one field)', async () => {
    fx = await buildTestApp({
      enableBundledLlm: { consent: false, monthlyCapUsdCents: 2000 },
    });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/bundled-llm-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH partial update — only consent supplied leaves cap unchanged; only cap supplied leaves consent unchanged', async () => {
    fx = await buildTestApp({
      enableBundledLlm: { consent: true, monthlyCapUsdCents: 5000 },
    });

    // Update only consent. Cap stays at 5000.
    const r1 = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/bundled-llm-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { consent: false },
    });
    expect(r1.json()).toEqual({ consent: false, monthly_cap_usd_cents: 5000 });

    // Update only cap. Consent stays at false (from the prior PATCH).
    const r2 = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/bundled-llm-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { monthly_cap_usd_cents: 1500 },
    });
    expect(r2.json()).toEqual({ consent: false, monthly_cap_usd_cents: 1500 });
  });
});
