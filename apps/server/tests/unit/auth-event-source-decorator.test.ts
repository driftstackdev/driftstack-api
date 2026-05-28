// Behavioral coverage for `app.requireAuthEventSource` (apps/server/
// src/middleware/auth.ts). EventSource/SSE clients can't set an
// Authorization header, so this decorator accepts the bearer token
// from a `?ds_token=` query param as a fallback (the documented
// transcript-stream contract — apps/docs api/agent-sessions). The
// header still wins when present.
//
// We don't need a fully-valid key here: `authenticate()` rejects any
// token shorter than 24 chars with InvalidKeyError *before* touching
// the repo, so the metric outcome distinguishes the code paths:
//   - missing header AND missing ds_token → UnauthorizedError ("unauthorized")
//   - a (short) ds_token IS forwarded to authenticate → InvalidKeyError ("invalid")
// The only way a header-less request reaches "invalid" is if the
// ds_token query fallback successfully extracted + forwarded the token.

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import authPlugin from '../../src/middleware/auth.js';
import { MetricsRegistry, METRIC_NAMES } from '../../src/services/metrics-registry.js';
import type { AccountAuthRepo } from '../../src/services/auth.js';

function makeRepo(): AccountAuthRepo {
  // Always-null repo: every test here errors before any repo call
  // (missing token, or token too short for authenticate's length gate).
  return {
    findApiKeyByPrefix: () => Promise.resolve(null),
  } as unknown as AccountAuthRepo;
}

function makeRegistry(): MetricsRegistry {
  const m = new MetricsRegistry();
  m.registerCounter(METRIC_NAMES.authTotal, 'Auth resolution outcomes.', ['outcome']);
  return m;
}

async function buildApp(metrics: MetricsRegistry): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(authPlugin, {
    authRepo: makeRepo(),
    authCache: null,
    authCoalescer: null,
    metrics,
  });
  app.get('/sse', { preHandler: [app.requireAuthEventSource] }, () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('requireAuthEventSource — ds_token query fallback', () => {
  it('401 outcome="unauthorized" when neither Authorization header nor ds_token is present', async () => {
    const metrics = makeRegistry();
    const app = await buildApp(metrics);
    const res = await app.inject({ method: 'GET', url: '/sse' });
    expect(res.statusCode).toBe(401);
    expect(metrics.getValue(METRIC_NAMES.authTotal, { outcome: 'unauthorized' })).toBe(1);
    await app.close();
  });

  it('forwards the ?ds_token= value to authenticate (outcome="invalid" for a too-short token — only reachable if extraction worked)', async () => {
    const metrics = makeRegistry();
    const app = await buildApp(metrics);
    const res = await app.inject({ method: 'GET', url: '/sse?ds_token=tooShortToken' });
    expect(res.statusCode).toBe(401);
    // "invalid" (not "unauthorized") proves the query token was extracted
    // and handed to authenticate(), which rejected it on the length gate.
    expect(metrics.getValue(METRIC_NAMES.authTotal, { outcome: 'invalid' })).toBe(1);
    expect(metrics.getValue(METRIC_NAMES.authTotal, { outcome: 'unauthorized' })).toBe(0);
    await app.close();
  });

  it('an empty ?ds_token= is treated as absent → "unauthorized" (no empty-string token forwarded)', async () => {
    const metrics = makeRegistry();
    const app = await buildApp(metrics);
    const res = await app.inject({ method: 'GET', url: '/sse?ds_token=' });
    expect(res.statusCode).toBe(401);
    expect(metrics.getValue(METRIC_NAMES.authTotal, { outcome: 'unauthorized' })).toBe(1);
    await app.close();
  });

  it('the Authorization header wins over ds_token (a malformed header → "unauthorized", proving the header path was taken even when ds_token is present)', async () => {
    const metrics = makeRegistry();
    const app = await buildApp(metrics);
    const res = await app.inject({
      method: 'GET',
      url: '/sse?ds_token=tooShortToken',
      headers: { authorization: 'NotBearer something' },
    });
    expect(res.statusCode).toBe(401);
    // If ds_token had been used we'd see "invalid" (short token); the
    // malformed-header "unauthorized" proves the header path took priority.
    expect(metrics.getValue(METRIC_NAMES.authTotal, { outcome: 'unauthorized' })).toBe(1);
    expect(metrics.getValue(METRIC_NAMES.authTotal, { outcome: 'invalid' })).toBe(0);
    await app.close();
  });
});
