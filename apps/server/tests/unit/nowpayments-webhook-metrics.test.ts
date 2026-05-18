// Arc 7 obs.9 — `driftstack_nowpayments_webhook_total{outcome}`
// counter emitted by the /v1/webhooks/nowpayments route. Sweeps
// reject paths (missing signature, empty body, signature_invalid,
// malformed_event) + the ok path against a real Fastify instance.

import { describe, expect, it, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { registerNowpaymentsWebhookRoutes } from '../../src/routes/webhooks-nowpayments.js';
import { MetricsRegistry, METRIC_NAMES } from '../../src/services/metrics-registry.js';

const SECRET = 'ipn_test_secret';

function makeRegistry(): MetricsRegistry {
  const m = new MetricsRegistry();
  m.registerCounter(METRIC_NAMES.nowpaymentsWebhookTotal, 'NOWPayments IPN receiver outcomes.', [
    'outcome',
  ]);
  return m;
}

/** Compute the NOWPayments IPN signature for a JSON-object body —
 *  matches the canonicalisation in verifyNowpaymentsSignature
 *  (recursive lexicographic key-sort before HMAC-SHA512). */
function signCanonical(jsonObj: Record<string, unknown>): string {
  const canonical = sortKeys(jsonObj);
  const canonicalJson = JSON.stringify(canonical);
  return createHmac('sha512', SECRET).update(canonicalJson).digest('hex');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

async function buildApp(args: { metrics?: MetricsRegistry }) {
  const app = Fastify();
  registerNowpaymentsWebhookRoutes(app, {
    ipnSecret: SECRET,
    logger: {
      warn: () => {},
      info: () => {},
      error: () => {},
      debug: () => {},
      child: () => ({}) as never,
    } as never,
    ...(args.metrics !== undefined ? { metrics: args.metrics } : {}),
  });
  await app.ready();
  return app;
}

const VALID_EVENT = {
  payment_id: 12345,
  payment_status: 'finished',
  order_id: 'ord_x',
};

describe('Arc 7 obs.9 — nowpayments_webhook_total counter', () => {
  let metrics: MetricsRegistry;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    metrics = makeRegistry();
    app = undefined;
  });

  it('outcome="signature_missing" when x-nowpayments-sig is absent', async () => {
    app = await buildApp({ metrics });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/nowpayments',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_EVENT),
    });
    expect(res.statusCode).toBe(401);
    expect(
      metrics.getValue(METRIC_NAMES.nowpaymentsWebhookTotal, { outcome: 'signature_missing' }),
    ).toBe(1);
    await app.close();
  });

  it('outcome="signature_invalid" when the signature is wrong', async () => {
    app = await buildApp({ metrics });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/nowpayments',
      headers: {
        'content-type': 'application/json',
        'x-nowpayments-sig': '00'.repeat(64), // 64 bytes of zeroes — valid hex, wrong digest
      },
      payload: JSON.stringify(VALID_EVENT),
    });
    expect(res.statusCode).toBe(401);
    expect(
      metrics.getValue(METRIC_NAMES.nowpaymentsWebhookTotal, { outcome: 'signature_invalid' }),
    ).toBe(1);
    await app.close();
  });

  it('outcome="malformed_event" when the body is missing required fields', async () => {
    app = await buildApp({ metrics });
    const malformed = { not_a_payment: true };
    const payload = JSON.stringify(malformed);
    const sig = signCanonical(malformed);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/nowpayments',
      headers: {
        'content-type': 'application/json',
        'x-nowpayments-sig': sig,
      },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(
      metrics.getValue(METRIC_NAMES.nowpaymentsWebhookTotal, { outcome: 'malformed_event' }),
    ).toBe(1);
    await app.close();
  });

  it('outcome="ok" on a verified, parseable IPN', async () => {
    app = await buildApp({ metrics });
    const payload = JSON.stringify(VALID_EVENT);
    const sig = signCanonical(VALID_EVENT);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/nowpayments',
      headers: {
        'content-type': 'application/json',
        'x-nowpayments-sig': sig,
      },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(metrics.getValue(METRIC_NAMES.nowpaymentsWebhookTotal, { outcome: 'ok' })).toBe(1);
    await app.close();
  });

  it('omitting metrics is a silent no-op (does not throw)', async () => {
    app = await buildApp({});
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/nowpayments',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_EVENT),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('Prometheus exposition format includes the new metric', async () => {
    app = await buildApp({ metrics });
    await app.inject({
      method: 'POST',
      url: '/v1/webhooks/nowpayments',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_EVENT),
    });
    const rendered = metrics.render();
    expect(rendered).toContain('# TYPE driftstack_nowpayments_webhook_total counter');
    expect(rendered).toMatch(
      /driftstack_nowpayments_webhook_total\{outcome="signature_missing"\} 1/,
    );
    await app.close();
  });
});
