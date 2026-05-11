// V-683 — integration tests for GET /v1/admin/cost/config.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;
afterEach(async () => {
  if (fx) await fx.cleanup();
});

interface ConfigResponse {
  rates: {
    computeCentsPerMinute: number;
    storageCentsPerGbMonth: number;
    egressCentsPerGb: number;
    emailCentsPerSend: number;
    llmCentsPer1kInputTokens: number;
    llmCentsPer1kOutputTokens: number;
  };
  tierThresholds: Record<string, { softCents: number; hardCents: number }>;
}

describe('V-683 GET /v1/admin/cost/config', () => {
  it('401/403 for a key without internal-admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/cost/config',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect([401, 403]).toContain(res.statusCode);
  });

  it('200 with the rate card + threshold table for an internal-admin key', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/cost/config',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ConfigResponse>();
    // The test fixture's CostMonitoringService is wired with the
    // happy-path rates (matches V-541.D fixture default).
    expect(body.rates.computeCentsPerMinute).toBeGreaterThan(0);
    expect(body.rates.llmCentsPer1kOutputTokens).toBeGreaterThan(
      body.rates.llmCentsPer1kInputTokens,
    );
    // Tier thresholds present + non-empty.
    expect(Object.keys(body.tierThresholds).length).toBeGreaterThan(0);
  });
});
