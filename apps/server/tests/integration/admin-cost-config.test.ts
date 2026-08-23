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

  // V-1355 — `account_ids` is a comma-separated string, and the route derives the
  // list by splitting, trimming and dropping empties. A value that is non-empty
  // as a STRING can therefore be empty as a LIST: `","` satisfies the schema's
  // `min(1)` and yields nothing. Coverage put the refusal that catches this in the
  // never-executed set, so nothing had ever sent the shape that produces it.
  //
  // Without the check the empty list reaches the cost lookup, which would answer
  // for zero accounts — a 200 carrying an empty overview reads to a staff caller
  // as "these accounts cost nothing", not as "you asked about no accounts".
  it('CRITICAL a comma-only account_ids is refused, not answered with an empty overview. The string passes the schema and the list does not survive the split, so the length check is the only thing between a malformed query and a confident empty answer.', async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/cost/overview?account_ids=%2C',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode, 'a list that empties after splitting is a bad request').toBe(400);
    expect(
      res.json<{ detail?: string }>().detail,
      'and the refusal names the field rather than failing further in',
    ).toContain('account_ids');
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
