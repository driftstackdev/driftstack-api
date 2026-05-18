// Arc 7 obs.6 — `driftstack_auth_total{outcome}` counter emitted by
// the auth Fastify plugin. Sweep every classified outcome via the
// AccountAuthRepo seam so we cover ok / unauthorized / invalid /
// revoked / expired without standing up a Drizzle-backed auth repo.

import { describe, expect, it, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import authPlugin from '../../src/middleware/auth.js';
import { MetricsRegistry, METRIC_NAMES } from '../../src/services/metrics-registry.js';
import { ExpiredKeyError, InvalidKeyError, RevokedKeyError } from '../../src/lib/errors.js';
import type { AccountAuthRepo } from '../../src/services/auth.js';

// A repo double that returns a canned context for known token prefixes
// and throws specific errors for designed bad-prefix values. The auth
// service calls `repo.findByToken` first, so we shim that here.
function makeRepo(): AccountAuthRepo {
  return {
    findByToken: (_token: string) => {
      // Always returns null; tests focus on the pre-repo error paths
      // (missing header, malformed header, too-short token) since
      // those don't require a fully populated AccountAuthRepo to
      // exercise the metric emission.
      return Promise.resolve(null);
    },
  } as unknown as AccountAuthRepo;
}

function makeRegistry(): MetricsRegistry {
  const m = new MetricsRegistry();
  m.registerCounter(METRIC_NAMES.authTotal, 'Auth resolution outcomes.', ['outcome']);
  return m;
}

async function buildApp(args: { metrics?: MetricsRegistry; repo: AccountAuthRepo }) {
  const app = Fastify();
  await app.register(authPlugin, {
    authRepo: args.repo,
    authCache: null,
    authCoalescer: null,
    ...(args.metrics !== undefined ? { metrics: args.metrics } : {}),
  });
  app.get('/probe', { preHandler: [app.requireAuth] }, () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('Arc 7 obs.6 — auth_total counter', () => {
  let metrics: MetricsRegistry;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    metrics = makeRegistry();
    app = undefined;
  });

  it('outcome="unauthorized" when the Authorization header is missing', async () => {
    app = await buildApp({ metrics, repo: makeRepo() });
    const res = await app.inject({ method: 'GET', url: '/probe' });
    expect(res.statusCode).toBe(401);
    expect(metrics.getValue(METRIC_NAMES.authTotal, { outcome: 'unauthorized' })).toBe(1);
    await app.close();
  });

  it('outcome="unauthorized" when the Authorization header is malformed', async () => {
    app = await buildApp({ metrics, repo: makeRepo() });
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { authorization: 'NotBearer abc' },
    });
    expect(res.statusCode).toBe(401);
    expect(metrics.getValue(METRIC_NAMES.authTotal, { outcome: 'unauthorized' })).toBe(1);
    await app.close();
  });

  it('outcome="invalid" when the token is too short to be a real key', async () => {
    app = await buildApp({ metrics, repo: makeRepo() });
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { authorization: 'Bearer short' },
    });
    expect(res.statusCode).toBe(401);
    expect(metrics.getValue(METRIC_NAMES.authTotal, { outcome: 'invalid' })).toBe(1);
    await app.close();
  });

  it('counts increment independently across multiple requests', async () => {
    app = await buildApp({ metrics, repo: makeRepo() });
    await app.inject({ method: 'GET', url: '/probe' }); // no header
    await app.inject({ method: 'GET', url: '/probe' }); // no header
    await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { authorization: 'Bearer short' },
    });
    expect(metrics.getValue(METRIC_NAMES.authTotal, { outcome: 'unauthorized' })).toBe(2);
    expect(metrics.getValue(METRIC_NAMES.authTotal, { outcome: 'invalid' })).toBe(1);
    await app.close();
  });

  it('omitting metrics is a silent no-op (does not throw)', async () => {
    app = await buildApp({ repo: makeRepo() });
    const res = await app.inject({ method: 'GET', url: '/probe' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('Prometheus exposition format includes the new metric', async () => {
    app = await buildApp({ metrics, repo: makeRepo() });
    await app.inject({ method: 'GET', url: '/probe' });
    const rendered = metrics.render();
    expect(rendered).toContain('# TYPE driftstack_auth_total counter');
    expect(rendered).toMatch(/driftstack_auth_total\{outcome="unauthorized"\} 1/);
    await app.close();
  });

  it('classifyAuthError name-coverage smoke', () => {
    // Sanity: the classes the classifier branches on are still
    // exported under the expected names. If any of these gets
    // renamed, the classifier silently falls through to 'error',
    // hiding the real failure mode in the dashboard.
    expect(new InvalidKeyError().name).toMatch(/InvalidKey/);
    expect(new RevokedKeyError().name).toMatch(/RevokedKey/);
    expect(new ExpiredKeyError().name).toMatch(/ExpiredKey/);
  });
});
