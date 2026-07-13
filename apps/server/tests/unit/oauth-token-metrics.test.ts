// Arc 7 obs.7 — `driftstack_oauth_token_total{outcome}` counter
// emitted by the OAuth /token route. Sweeps the OAuthError code
// space + the ok path against a stubbed OAuthService so the test
// exercises only the route-layer instrumentation.

import { describe, expect, it, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerOAuthRoutes } from '../../src/routes/oauth.js';
import { MetricsRegistry, METRIC_NAMES } from '../../src/services/metrics-registry.js';
import { OAuthError, type OAuthService } from '../../src/services/oauth.js';
import { MemoryRateLimitStore } from '../../src/lib/memory-rate-limit-store.js';

function makeRegistry(): MetricsRegistry {
  const m = new MetricsRegistry();
  m.registerCounter(METRIC_NAMES.oauthTokenTotal, 'OAuth /token exchange outcomes.', ['outcome']);
  return m;
}

interface BuildArgs {
  metrics?: MetricsRegistry;
  exchangeBehaviour:
    | {
        kind: 'ok';
        result: {
          access_token: string;
          token_type: 'Bearer';
          expires_in: number;
          scope: readonly string[];
        };
      }
    | { kind: 'throw'; err: unknown };
}

function buildService(b: BuildArgs['exchangeBehaviour']): OAuthService {
  return {
    exchangeCode: () => {
      if (b.kind === 'ok') return Promise.resolve(b.result);
      const reason = b.err instanceof Error ? b.err : new Error(String(b.err));
      return Promise.reject(reason);
    },
  } as unknown as OAuthService;
}

async function buildApp(args: BuildArgs) {
  const app = Fastify();
  // OAuth /token doesn't itself sit behind requireAuth/requireScope —
  // PKCE + client_secret IS the auth. Stub the decorators anyway so
  // the admin routes registered alongside don't fail at register time.
  app.decorate('requireScope', () => async () => {});
  app.decorate('requireAuth', async () => {});
  app.decorate('rateLimit', () => async () => {});
  registerOAuthRoutes(app, {
    service: buildService(args.exchangeBehaviour),
    rateLimitStore: new MemoryRateLimitStore(),
    ...(args.metrics !== undefined ? { metrics: args.metrics } : {}),
  });
  await app.ready();
  return app;
}

const VALID_BODY = {
  grant_type: 'authorization_code',
  code: 'authcode_x',
  code_verifier: 'A'.repeat(64), // PKCE verifier 43-128 chars
  client_id: 'oac_x',
  client_secret: 'oas_y',
  redirect_uri: 'https://example.com/callback',
};

describe('Arc 7 obs.7 — oauth_token_total counter', () => {
  let metrics: MetricsRegistry;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    metrics = makeRegistry();
    app = undefined;
  });

  it('outcome="ok" on successful exchange', async () => {
    app = await buildApp({
      metrics,
      exchangeBehaviour: {
        kind: 'ok',
        result: {
          access_token: 'tok_x',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: ['read', 'write'],
        },
      },
    });
    const res = await app.inject({ method: 'POST', url: '/v1/oauth/token', payload: VALID_BODY });
    expect(res.statusCode).toBe(200);
    expect(metrics.getValue(METRIC_NAMES.oauthTokenTotal, { outcome: 'ok' })).toBe(1);
    await app.close();
  });

  it('outcome="invalid_grant" when the code is expired / unknown / PKCE-mismatched', async () => {
    app = await buildApp({
      metrics,
      exchangeBehaviour: {
        kind: 'throw',
        err: new OAuthError('invalid_grant', 'code expired or unknown'),
      },
    });
    const res = await app.inject({ method: 'POST', url: '/v1/oauth/token', payload: VALID_BODY });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(metrics.getValue(METRIC_NAMES.oauthTokenTotal, { outcome: 'invalid_grant' })).toBe(1);
    await app.close();
  });

  it('outcome="invalid_client" when client_id/secret mismatch', async () => {
    app = await buildApp({
      metrics,
      exchangeBehaviour: {
        kind: 'throw',
        err: new OAuthError('invalid_client', 'client_id + client_secret mismatch'),
      },
    });
    const res = await app.inject({ method: 'POST', url: '/v1/oauth/token', payload: VALID_BODY });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(metrics.getValue(METRIC_NAMES.oauthTokenTotal, { outcome: 'invalid_client' })).toBe(1);
    await app.close();
  });

  it('outcome="error" on non-OAuthError throw', async () => {
    app = await buildApp({
      metrics,
      exchangeBehaviour: { kind: 'throw', err: new Error('unexpected') },
    });
    const res = await app.inject({ method: 'POST', url: '/v1/oauth/token', payload: VALID_BODY });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(metrics.getValue(METRIC_NAMES.oauthTokenTotal, { outcome: 'error' })).toBe(1);
    await app.close();
  });

  it('omitting metrics is a silent no-op (does not throw)', async () => {
    app = await buildApp({
      exchangeBehaviour: {
        kind: 'ok',
        result: {
          access_token: 'tok_x',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: ['read'],
        },
      },
    });
    const res = await app.inject({ method: 'POST', url: '/v1/oauth/token', payload: VALID_BODY });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('Prometheus exposition format includes the new metric', async () => {
    app = await buildApp({
      metrics,
      exchangeBehaviour: {
        kind: 'ok',
        result: {
          access_token: 'tok_x',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: ['read'],
        },
      },
    });
    await app.inject({ method: 'POST', url: '/v1/oauth/token', payload: VALID_BODY });
    const rendered = metrics.render();
    expect(rendered).toContain('# TYPE driftstack_oauth_token_total counter');
    expect(rendered).toMatch(/driftstack_oauth_token_total\{outcome="ok"\} 1/);
    await app.close();
  });
});
