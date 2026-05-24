// Integration coverage for the v2-#6 bundled-LLM settings surface:
//   GET   /v1/account/me/bundled-llm-settings
//   PATCH /v1/account/me/bundled-llm-settings
//   GET   /v1/account/me/bundled-llm-status
//
// These routes had unit/service coverage but no end-to-end test
// exercising the wired route → BundledLlmService → repo chain, the
// PatchBodySchema range/refine validation, or the status spend math.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { PROBLEM_TYPES } from '@driftstack/api-types';

interface SettingsResponse {
  consent: boolean;
  monthly_cap_usd_cents: number;
}
interface StatusResponse {
  consent: boolean;
  cap_cents: number;
  used_this_month_cents: number;
  remaining_cents: number;
  refused_count_this_month: number;
  month_started_at: string;
}

describe('bundled-LLM settings surface', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('GET settings returns the seeded consent + cap', async () => {
    fx = await buildTestApp({ enableBundledLlm: { consent: false, monthlyCapUsdCents: 2000 } });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/bundled-llm-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SettingsResponse>();
    expect(body.consent).toBe(false);
    expect(body.monthly_cap_usd_cents).toBe(2000);
  });

  it('PATCH flips consent + the change is reflected on the next GET', async () => {
    fx = await buildTestApp({ enableBundledLlm: { consent: false, monthlyCapUsdCents: 2000 } });
    const patch = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/bundled-llm-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { consent: true },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json<SettingsResponse>().consent).toBe(true);

    const get = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/bundled-llm-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(get.json<SettingsResponse>().consent).toBe(true);
  });

  it('PATCH consent change emits an account.bundled_llm_consent_changed audit row', async () => {
    fx = await buildTestApp({ enableBundledLlm: { consent: false, monthlyCapUsdCents: 2000 } });
    await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/bundled-llm-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { consent: true },
    });
    const rows = fx.accountAuditRepo
      .getAll()
      .filter((r) => r.action === 'account.bundled_llm_consent_changed');
    expect(rows.length).toBe(1);
    expect(rows[0]?.payload).toMatchObject({ from: false, to: true });
  });

  it('PATCH rejects an out-of-range cap (> $10,000) with 400', async () => {
    fx = await buildTestApp({ enableBundledLlm: { consent: false, monthlyCapUsdCents: 2000 } });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/bundled-llm-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { monthly_cap_usd_cents: 1_000_001 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.ValidationFailed);
  });

  it('PATCH with an empty body is rejected (must include consent or cap)', async () => {
    fx = await buildTestApp({ enableBundledLlm: { consent: false, monthlyCapUsdCents: 2000 } });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me/bundled-llm-settings',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.ValidationFailed);
  });

  it('GET status computes remaining = cap − month-to-date spend', async () => {
    fx = await buildTestApp({ enableBundledLlm: { consent: true, monthlyCapUsdCents: 2000 } });
    // Seed $5.00 of prior-turn spend this month.
    fx.bundledLlmRepo.addSpend(fx.accountId, new Date(), 500);
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/bundled-llm-status',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<StatusResponse>();
    expect(body.consent).toBe(true);
    expect(body.cap_cents).toBe(2000);
    expect(body.used_this_month_cents).toBe(500);
    expect(body.remaining_cents).toBe(1500);
    expect(body.refused_count_this_month).toBe(0);
    expect(Number.isNaN(Date.parse(body.month_started_at))).toBe(false);
  });
});
