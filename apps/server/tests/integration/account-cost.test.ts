// V-541.D — integration tests for GET /v1/account/cost.
//
// Customer-facing surface mirrors the admin V-541.B service but
// scopes to the calling account via requireAuth. Coverage: auth gate,
// zero-usage synthetic response, populated breakdown, custom
// billing_cycle param, malformed billing_cycle.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;
afterEach(async () => {
  if (fx) await fx.cleanup();
});

interface CostResponse {
  account_id: string;
  billing_cycle: string;
  tier: string;
  breakdown: {
    computeCents: number;
    storageCents: number;
    egressCents: number;
    emailCents: number;
    llmCents: number;
    totalCents: number;
    thresholdState: string;
  };
}

describe('V-541.D GET /v1/account/cost', () => {
  it('401 without auth', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/v1/account/cost' });
    expect(res.statusCode).toBe(401);
  });

  it('200 with synthetic zero breakdown for a fresh account (no usage in cycle)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/cost?billing_cycle=2026-05',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<CostResponse>();
    // S46 2026-07-07 (founder-approved) — canonical acc_ prefix, matching
    // GET /v1/account/me (was the bare internal uuid).
    expect(body.account_id).toBe(`acc_${fx.accountId}`);
    expect(body.billing_cycle).toBe('2026-05');
    expect(body.breakdown.totalCents).toBe(0);
    expect(body.breakdown.thresholdState).toBe('under-soft');
  });

  it('200 with populated breakdown when the aggregator returns usage', async () => {
    fx = await buildTestApp();
    fx.costUsageByAccount.set(fx.accountId, {
      sessionMinutes: 120,
      storageGbMonths: 10,
      egressGb: 1,
      emailSends: 5,
      llmInputTokens: 1_000,
      llmOutputTokens: 1_000,
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/cost?billing_cycle=2026-05',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<CostResponse>();
    // S46 2026-07-07 — the populated (service-summary) branch prefixes too.
    expect(body.account_id).toBe(`acc_${fx.accountId}`);
    expect(body.breakdown.computeCents).toBe(120);
    expect(body.breakdown.totalCents).toBeGreaterThan(0);
  });

  it('uses the current month when billing_cycle is omitted', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/cost',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<CostResponse>();
    expect(body.billing_cycle).toMatch(/^\d{4}-\d{2}$/);
  });

  it.each(['2026-5', '2026-00', '2026-13'])('400 on invalid billing_cycle %s', async (cycle) => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/account/cost?billing_cycle=${cycle}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it.each(['2026-01', '2026-12'])('accepts valid boundary billing_cycle %s', async (cycle) => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/account/cost?billing_cycle=${cycle}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<CostResponse>().billing_cycle).toBe(cycle);
  });

  it('fails closed without a zero summary when the authenticated tier has no thresholds', async () => {
    fx = await buildTestApp({ tier: 'enterprise' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/cost?billing_cycle=2026-05',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json<{ breakdown?: unknown }>().breakdown).toBeUndefined();
  });

  it('does NOT include operator-tuned threshold values in the customer response', async () => {
    fx = await buildTestApp();
    fx.costUsageByAccount.set(fx.accountId, {
      sessionMinutes: 120,
      storageGbMonths: 0,
      egressGb: 0,
      emailSends: 0,
      llmInputTokens: 0,
      llmOutputTokens: 0,
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/cost?billing_cycle=2026-05',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const body = res.json<CostResponse & { thresholds?: unknown }>();
    expect(body.thresholds).toBeUndefined();
  });
});

describe('#122 — read:billing floor on GET /v1/account/cost', () => {
  const get = (fxArg: TestAppFixture) =>
    fxArg.app.inject({
      method: 'GET',
      url: '/v1/account/cost?billing_cycle=2026-05',
      headers: { authorization: `Bearer ${fxArg.plaintext}` },
    });

  it('403 for a write-only key, naming the required scope', async () => {
    fx = await buildTestApp({ scopes: ['write'] });
    const res = await get(fx);
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toContain('read:billing');
  });

  it('200 for a granular read:billing key (zero-usage synthesized branch)', async () => {
    fx = await buildTestApp({ scopes: ['read:billing'] });
    expect((await get(fx)).statusCode).toBe(200);
  });

  it('200 for a broad read key (V-481) and an account_owner key', async () => {
    fx = await buildTestApp({ scopes: ['read'] });
    expect((await get(fx)).statusCode).toBe(200);
    await fx.cleanup();
    fx = await buildTestApp({ scopes: ['account_owner'] });
    expect((await get(fx)).statusCode).toBe(200);
  });
});
