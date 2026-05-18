// Arc 7 obs.4 — `driftstack_byok_anthropic_test_total{outcome}`
// counter emitted by the /v1/account/me/byok-anthropic-key/test
// route. Built against the test fixture's metrics registry +
// fastify in-process test app so we sweep every classified outcome
// without standing up Anthropic SDK HTTP.

import { describe, expect, it, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { registerAccountByokAnthropicRoutes } from '../../src/routes/account-byok-anthropic.js';
import { MetricsRegistry, METRIC_NAMES } from '../../src/services/metrics-registry.js';
import type { BYOKAnthropicService } from '../../src/services/byok-anthropic.js';

// Minimal in-test BYOK service double — satisfies the routes' surface
// without dragging the full Drizzle-backed service in.
function makeFakeService(plaintext: string | null): BYOKAnthropicService {
  return {
    getPlaintext: () => Promise.resolve(plaintext),
    // Unused by the /test path but required for type narrowing.
    getMetadata: () =>
      Promise.resolve({ hasKey: plaintext !== null, setAt: null, lastUsedAt: null }),
    setKey: () => Promise.resolve({ setAt: new Date() }),
    clearKey: () => Promise.resolve(),
    touchLastUsedAt: () => Promise.resolve(),
  } as unknown as BYOKAnthropicService;
}

async function buildTestApp(args: {
  plaintext: string | null;
  testResult: { ok: true } | { ok: false; reason: string };
  metrics: MetricsRegistry;
}) {
  const app = Fastify();
  // Stub the auth + scope + rateLimit decorators the route uses.
  app.decorate('requireAuth', (req: { account?: unknown }, _reply: unknown, done: () => void) => {
    req.account = {
      account: { id: 'acc_obs4', tier: 'starter' },
      apiKey: { id: 'key_obs4', scopes: ['account_owner', 'read', 'write'] },
    };
    done();
  });
  app.decorate('requireScope', () => (_req: unknown, _reply: unknown, done: () => void) => done());
  app.decorate('rateLimit', () => (_req: unknown, _reply: unknown, done: () => void) => done());
  app.decorateRequest('account', null);

  registerAccountByokAnthropicRoutes(app, {
    service: makeFakeService(args.plaintext),
    testConnection: () => Promise.resolve(args.testResult),
    metrics: args.metrics,
  });

  await app.ready();
  return app;
}

function makeRegistry(): MetricsRegistry {
  const m = new MetricsRegistry();
  m.registerCounter(
    METRIC_NAMES.byokAnthropicTestTotal,
    'BYOK Anthropic /test endpoint outcomes (ok / invalid / quota_exceeded / not_set / not_wired / unknown).',
    ['outcome'],
  );
  return m;
}

describe('Arc 7 obs.4 — byok_anthropic_test_total counter', () => {
  let metrics: MetricsRegistry;
  beforeEach(() => {
    metrics = makeRegistry();
  });

  it('outcome="ok" on successful tester result', async () => {
    const app = await buildTestApp({
      plaintext: 'sk-ant-api03-fakeplaintext',
      testResult: { ok: true },
      metrics,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/account/me/byok-anthropic-key/test',
    });
    expect(res.statusCode).toBe(200);
    expect(metrics.getValue(METRIC_NAMES.byokAnthropicTestTotal, { outcome: 'ok' })).toBe(1);
    await app.close();
  });

  it('outcome="not_set" when no plaintext is stored', async () => {
    const app = await buildTestApp({
      plaintext: null,
      testResult: { ok: false, reason: 'unused' },
      metrics,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/account/me/byok-anthropic-key/test',
    });
    expect(res.statusCode).toBe(400);
    expect(metrics.getValue(METRIC_NAMES.byokAnthropicTestTotal, { outcome: 'not_set' })).toBe(1);
    expect(metrics.getValue(METRIC_NAMES.byokAnthropicTestTotal, { outcome: 'ok' })).toBe(0);
    await app.close();
  });

  it('outcome="not_wired" when tester reports it is not yet wired', async () => {
    const app = await buildTestApp({
      plaintext: 'sk-ant-api03-fakeplaintext',
      testResult: { ok: false, reason: 'Connection tester not yet wired. AI-B1.b ships...' },
      metrics,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/account/me/byok-anthropic-key/test',
    });
    expect(res.statusCode).toBe(200);
    expect(metrics.getValue(METRIC_NAMES.byokAnthropicTestTotal, { outcome: 'not_wired' })).toBe(1);
    await app.close();
  });

  it('outcome="quota_exceeded" on quota / rate-limit reason strings', async () => {
    const app = await buildTestApp({
      plaintext: 'sk-ant-api03-fakeplaintext',
      testResult: { ok: false, reason: 'Anthropic returned 429 rate limit exceeded' },
      metrics,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/account/me/byok-anthropic-key/test',
    });
    expect(res.statusCode).toBe(200);
    expect(
      metrics.getValue(METRIC_NAMES.byokAnthropicTestTotal, { outcome: 'quota_exceeded' }),
    ).toBe(1);
    await app.close();
  });

  it('outcome="invalid" on 401/403/invalid-key reason strings', async () => {
    const app = await buildTestApp({
      plaintext: 'sk-ant-api03-fakeplaintext',
      testResult: { ok: false, reason: 'Anthropic returned 401 Unauthorized: invalid api key' },
      metrics,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/account/me/byok-anthropic-key/test',
    });
    expect(res.statusCode).toBe(200);
    expect(metrics.getValue(METRIC_NAMES.byokAnthropicTestTotal, { outcome: 'invalid' })).toBe(1);
    await app.close();
  });

  it('outcome="unknown" on unclassified reason strings', async () => {
    const app = await buildTestApp({
      plaintext: 'sk-ant-api03-fakeplaintext',
      testResult: { ok: false, reason: 'ECONNRESET while talking to api.anthropic.com' },
      metrics,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/account/me/byok-anthropic-key/test',
    });
    expect(res.statusCode).toBe(200);
    expect(metrics.getValue(METRIC_NAMES.byokAnthropicTestTotal, { outcome: 'unknown' })).toBe(1);
    await app.close();
  });

  it('omitting the metrics option is a silent no-op (does not throw)', async () => {
    const app = Fastify();
    app.decorate('requireAuth', (req: { account?: unknown }, _reply: unknown, done: () => void) => {
      req.account = {
        account: { id: 'acc_obs4', tier: 'starter' },
        apiKey: { id: 'key_obs4', scopes: ['account_owner', 'read', 'write'] },
      };
      done();
    });
    app.decorate(
      'requireScope',
      () => (_req: unknown, _reply: unknown, done: () => void) => done(),
    );
    app.decorate('rateLimit', () => (_req: unknown, _reply: unknown, done: () => void) => done());
    app.decorateRequest('account', null);
    registerAccountByokAnthropicRoutes(app, {
      service: makeFakeService('sk-ant-api03-fakeplaintext'),
      testConnection: () => Promise.resolve({ ok: true }),
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/account/me/byok-anthropic-key/test',
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
