// Wave 1119 / Slice 1119.2 — when billing env is unconfigured (no
// STRIPE_SECRET_KEY / DRIFTSTACK_TIER_PRICE_IDS), the four
// `/v1/billing/*` paths return
// 503 + `FeatureUnavailable` problem-type (not 404). The customer
// dashboard's existing 503-detection leg
// (apps/customer-dashboard/src/pages/select-tier.astro since 121cd266)
// surfaces a "Billing setup is still in progress on this server"
// message instead of bare "HTTP 404".

import { afterEach, describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

describe('Wave 1119 / Slice 1119.2 — /v1/billing/* with billing disabled', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('POST /v1/billing/checkout-session → 503 FeatureUnavailable', async () => {
    fx = await buildTestApp({ disableBilling: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      payload: { tier: 'api_builder', billing_period: 'monthly' },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json<{ type: string; title: string; detail: string }>();
    expect(body.type).toBe(PROBLEM_TYPES.FeatureUnavailable);
    expect(body.title).toBe('Feature unavailable');
    expect(body.detail).toMatch(/Billing is not configured on this server/);
  });

  // POST /v1/billing/trial-pack was retired 2026-05-27 (trial_pack
  // retirement) — the route is no longer registered on either the
  // enabled or disabled billing surface.

  it('POST /v1/billing/portal-session → 503 FeatureUnavailable', async () => {
    fx = await buildTestApp({ disableBilling: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/portal-session',
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });

  it('GET /v1/billing → 503 FeatureUnavailable', async () => {
    fx = await buildTestApp({ disableBilling: true });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing',
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });

  it('v2-#26 GET /v1/account/me/billing-portal → 503 FeatureUnavailable (mirrors the POST portal-session stub so dashboard 503-detection works on the redirect variant too)', async () => {
    fx = await buildTestApp({ disableBilling: true });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/billing-portal',
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });

  it('contains a support-contact pointer in detail (so dashboard can show "contact us if you expected this")', async () => {
    fx = await buildTestApp({ disableBilling: true });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing',
    });
    expect(res.json<{ detail: string }>().detail).toMatch(/support@driftstack\.dev/);
  });

  it('returns content-type application/problem+json (RFC 7807)', async () => {
    fx = await buildTestApp({ disableBilling: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });
});
