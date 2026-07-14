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
import type { AccountAuthRepo, AccountContext } from '../../src/services/auth.js';
import { type AuthCache, sha256Hex } from '../../src/services/auth-cache.js';

function makeRegistry(): MetricsRegistry {
  const m = new MetricsRegistry();
  m.registerCounter(METRIC_NAMES.authTotal, 'Auth resolution outcomes.', ['outcome']);
  return m;
}

// A long (≥24-char) valid token + its complete, unexpired AccountContext.
// `authenticate()` checks the cache BEFORE the repo/scrypt slow path, so a
// cache that resolves this sha drives the decorator's SUCCESS branch without
// any key-generation machinery. Mirrors the auth-cache fixture shape.
const VALID_TOKEN = 'ds_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CTX: AccountContext = {
  account: {
    id: 'acc-1',
    email: 'a@x.test',
    name: null,
    tier: 'api_builder',
    status: 'active',
    timezone: null,
    avatarR2Key: null,
    slug: null,
    region: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  },
  apiKey: {
    id: 'key-1',
    accountId: 'acc-1',
    name: 'default',
    keyPrefix: 'ds_live_aaaaaaaa',
    keyHash: 'hash',
    scopes: ['read', 'write'],
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  },
  rateLimitOverrides: {},
  teams: [],
  webSession: null,
};

function makeRepo(liveAuthority = true): AccountAuthRepo {
  // Positive cache hits deliberately re-read the exact credential, account,
  // team grants, and rate policy. Missing/short tokens still fail before these
  // methods run; `liveAuthority=false` proves cached data alone cannot pass.
  return {
    findApiKeyByPrefix: (prefix: string) =>
      Promise.resolve(liveAuthority && prefix === CTX.apiKey.keyPrefix ? CTX.apiKey : null),
    getAccount: (id: string) =>
      Promise.resolve(liveAuthority && id === CTX.account.id ? CTX.account : null),
    findTeamMemberships: () => Promise.resolve([]),
    findActiveRateLimitOverrides: () => Promise.resolve([]),
  } as unknown as AccountAuthRepo;
}

// Cache that returns CTX only for the valid token's sha (a fresh hit), null
// for anything else. Only `get` is exercised on the hit fast path; the rest
// are no-op stubs to satisfy the AuthCache interface.
function makeHitCache(): AuthCache {
  const hitSha = sha256Hex(VALID_TOKEN);
  return {
    get: (sha: string) => Promise.resolve(sha === hitSha ? CTX : null),
    set: () => Promise.resolve(),
    invalidateKey: () => Promise.resolve(),
    invalidateAccount: () => Promise.resolve(),
  };
}

async function buildApp(
  metrics: MetricsRegistry,
  cache: AuthCache | null = null,
  repo: AccountAuthRepo = makeRepo(),
): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(authPlugin, {
    authRepo: repo,
    authCache: cache,
    authCoalescer: null,
    metrics,
  });
  // The handler echoes the resolved auth context so a positive-path test can
  // assert the request was authenticated with the SAME account regardless of
  // whether the token arrived via header or ?ds_token= query param.
  app.get('/sse', { preHandler: [app.requireAuthEventSource] }, (req) => ({
    ok: true,
    accountId: req.account?.account.id ?? null,
    scopes: req.account?.apiKey.scopes ?? null,
  }));
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

  // Positive path — the prior tests only prove the token is EXTRACTED +
  // forwarded; these prove a *valid* ds_token actually authenticates and
  // populates request.account, so the SSE handler runs with full auth context
  // (the real EventSource-client guarantee, not just "extraction worked").
  it('a valid ?ds_token= authenticates via the query fallback → 200 + request.account populated + outcome="ok"', async () => {
    const metrics = makeRegistry();
    const app = await buildApp(metrics, makeHitCache());
    const res = await app.inject({ method: 'GET', url: `/sse?ds_token=${VALID_TOKEN}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, accountId: 'acc-1', scopes: ['read', 'write'] });
    expect(metrics.getValue(METRIC_NAMES.authTotal, { outcome: 'ok' })).toBe(1);
    await app.close();
  });

  it('the same valid token via Authorization header resolves the identical context (header + query paths converge)', async () => {
    const metrics = makeRegistry();
    const app = await buildApp(metrics, makeHitCache());
    const res = await app.inject({
      method: 'GET',
      url: '/sse',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, accountId: 'acc-1', scopes: ['read', 'write'] });
    expect(metrics.getValue(METRIC_NAMES.authTotal, { outcome: 'ok' })).toBe(1);
    await app.close();
  });

  it('rejects a cached query token when the live credential authority is gone', async () => {
    const metrics = makeRegistry();
    const app = await buildApp(metrics, makeHitCache(), makeRepo(false));
    const res = await app.inject({ method: 'GET', url: `/sse?ds_token=${VALID_TOKEN}` });
    expect(res.statusCode).toBe(401);
    expect(metrics.getValue(METRIC_NAMES.authTotal, { outcome: 'invalid' })).toBe(1);
    expect(metrics.getValue(METRIC_NAMES.authTotal, { outcome: 'ok' })).toBe(0);
    await app.close();
  });
});
