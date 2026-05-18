// Arc 7 obs.10 — end-to-end verification of the
// driftstack_account_audit_emit_total counter through real
// customer audit emissions. Parallels the obs.15 / obs.3 / obs.6 /
// obs.5 integration tests; pins the metric emission separately
// from the audit-row persistence covered by other integration
// suites.
//
// The audit log fires on many actions; this slice exercises the
// most common one — POST /v1/api-keys (api_key.created) — to prove
// the prefix-bucketing and actor_type labels stay correct through
// the AccountAuditService.record() path.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { METRIC_NAMES } from '../../src/services/metrics-registry.js';

describe('Arc 7 obs.10 — account_audit_emit_total counter (integration)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('POST /v1/api-keys ticks prefix="api_key", actor_type="customer"', async () => {
    fx = await buildTestApp();
    const before = fx.metricsRegistry.getValue(METRIC_NAMES.accountAuditEmitTotal, {
      prefix: 'api_key',
      actor_type: 'customer',
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'test-key', scopes: ['read'] },
    });
    expect(res.statusCode).toBe(201);
    expect(
      fx.metricsRegistry.getValue(METRIC_NAMES.accountAuditEmitTotal, {
        prefix: 'api_key',
        actor_type: 'customer',
      }),
    ).toBe(before + 1);
  });

  it('multiple emissions accumulate against the same prefix cell', async () => {
    fx = await buildTestApp();
    const before = fx.metricsRegistry.getValue(METRIC_NAMES.accountAuditEmitTotal, {
      prefix: 'api_key',
      actor_type: 'customer',
    });
    for (let i = 0; i < 3; i++) {
      await fx.app.inject({
        method: 'POST',
        url: '/v1/api-keys',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { name: `test-key-${i.toString()}`, scopes: ['read'] },
      });
    }
    expect(
      fx.metricsRegistry.getValue(METRIC_NAMES.accountAuditEmitTotal, {
        prefix: 'api_key',
        actor_type: 'customer',
      }),
    ).toBe(before + 3);
  });

  it('exposition rendering includes the new counter with at least one labelled cell', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'rendered-test', scopes: ['read'] },
    });
    const rendered = fx.metricsRegistry.render();
    expect(rendered).toContain('# TYPE driftstack_account_audit_emit_total counter');
    expect(rendered).toMatch(
      /driftstack_account_audit_emit_total\{prefix="api_key",actor_type="customer"\} \d+/,
    );
  });
});
