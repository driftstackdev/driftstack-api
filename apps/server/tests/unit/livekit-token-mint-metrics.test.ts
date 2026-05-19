// Arc 7 obs.12 — `driftstack_livekit_token_mint_total{role,outcome}`
// counter emitted by the LiveKit token mint route. Sweeps the
// validation / not_found / ok paths against a real Fastify instance.

import { describe, expect, it, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { registerLivekitTokenRoute } from '../../src/routes/sessions-livekit-token.js';
import { MetricsRegistry, METRIC_NAMES } from '../../src/services/metrics-registry.js';

const stubAuthPlugin = fp(
  (_app, _opts, done) => {
    done();
  },
  { name: 'auth' },
);

function makeRegistry(): MetricsRegistry {
  const m = new MetricsRegistry();
  m.registerCounter(METRIC_NAMES.livekitTokenMintTotal, 'LiveKit token mint outcomes.', [
    'role',
    'outcome',
  ]);
  return m;
}

async function buildApp(args: {
  metrics?: MetricsRegistry;
  isSessionOwned: (accountId: string, sessionId: string) => Promise<boolean>;
}) {
  const app = Fastify();
  app.decorateRequest('account', null);
  app.addHook('onRequest', (req: FastifyRequest, _reply, done) => {
    (req as { account: unknown }).account = {
      account: { id: 'acc_obs12', tier: 'starter' },
      apiKey: { id: 'key_obs12', scopes: ['read', 'write'] },
    };
    done();
  });
  await app.register(stubAuthPlugin);
  app.decorate('rateLimit', () => async () => {});
  app.decorate('requireAuth', async () => {});
  registerLivekitTokenRoute(app, {
    apiKey: 'lk_api_test',
    apiSecret: 'lk_secret_test_at_least_32_chars_for_jwt_signing',
    wsUrl: 'wss://livekit.example/ws',
    isSessionOwned: args.isSessionOwned,
    ...(args.metrics !== undefined ? { metrics: args.metrics } : {}),
  });
  await app.ready();
  return app;
}

const VALID_SES_ID = 'ses_11111111-2222-3333-4444-555555555555';

describe('Arc 7 obs.12 — livekit_token_mint_total counter', () => {
  let metrics: MetricsRegistry;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    metrics = makeRegistry();
    app = undefined;
  });

  it('outcome="not_found" + role="unknown" when the session id fails the shape check', async () => {
    app = await buildApp({ metrics, isSessionOwned: () => Promise.resolve(true) });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions/not-a-valid-id/livekit-token',
      payload: { role: 'publisher' },
    });
    expect(res.statusCode).toBe(404);
    expect(
      metrics.getValue(METRIC_NAMES.livekitTokenMintTotal, {
        role: 'unknown',
        outcome: 'not_found',
      }),
    ).toBe(1);
    await app.close();
  });

  it('outcome="validation" + role="unknown" when the body fails schema', async () => {
    app = await buildApp({ metrics, isSessionOwned: () => Promise.resolve(true) });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${VALID_SES_ID}/livekit-token`,
      payload: { role: 'not-a-real-role' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(
      metrics.getValue(METRIC_NAMES.livekitTokenMintTotal, {
        role: 'unknown',
        outcome: 'validation',
      }),
    ).toBe(1);
    await app.close();
  });

  it('outcome="not_found" + role="publisher" when the session is not owned by the caller', async () => {
    app = await buildApp({ metrics, isSessionOwned: () => Promise.resolve(false) });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${VALID_SES_ID}/livekit-token`,
      payload: { role: 'publisher' },
    });
    expect(res.statusCode).toBe(404);
    expect(
      metrics.getValue(METRIC_NAMES.livekitTokenMintTotal, {
        role: 'publisher',
        outcome: 'not_found',
      }),
    ).toBe(1);
    await app.close();
  });

  it('outcome="ok" + role="publisher" on a successful mint', async () => {
    app = await buildApp({ metrics, isSessionOwned: () => Promise.resolve(true) });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${VALID_SES_ID}/livekit-token`,
      payload: { role: 'publisher' },
    });
    expect(res.statusCode).toBe(200);
    expect(
      metrics.getValue(METRIC_NAMES.livekitTokenMintTotal, { role: 'publisher', outcome: 'ok' }),
    ).toBe(1);
    await app.close();
  });

  it('outcome="ok" + role="subscriber" on a subscriber mint', async () => {
    app = await buildApp({ metrics, isSessionOwned: () => Promise.resolve(true) });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${VALID_SES_ID}/livekit-token`,
      payload: { role: 'subscriber' },
    });
    expect(res.statusCode).toBe(200);
    expect(
      metrics.getValue(METRIC_NAMES.livekitTokenMintTotal, { role: 'subscriber', outcome: 'ok' }),
    ).toBe(1);
    await app.close();
  });

  it('omitting metrics is a silent no-op (does not throw)', async () => {
    app = await buildApp({ isSessionOwned: () => Promise.resolve(true) });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${VALID_SES_ID}/livekit-token`,
      payload: { role: 'publisher' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
