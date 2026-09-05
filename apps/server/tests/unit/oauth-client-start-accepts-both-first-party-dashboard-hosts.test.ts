// T-3 host move (2026-09-05) — /v1/auth/oauth-client/start must accept a redirect_to
// on EITHER first-party dashboard host while the dashboard serves on both.
//
// Measured on prod before the fix: DASHBOARD_ORIGIN=https://app.driftstack.dev and the
// SPA on app.driftstack.io sends `redirect_to: window.location.origin + next`, so every
// Google/GitHub sign-in started from the .io dashboard answered
// 400 "redirect_to must be on the dashboard origin." The guard is an open-redirect
// defense and must stay a CLOSED allow-list — so it widens to the two first-party
// hosts only when the CONFIGURED origin is itself one of them; a self-hosted
// operator's guard stays exact.
//
// The route is mounted on a bare Fastify with no providers configured, so the
// provider check — which runs AFTER the origin check — is the observable "origin
// accepted" signal: a redirect_to that passes the origin gate answers with the
// provider message, one that fails answers with the origin message.

import Fastify from 'fastify';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { registerOAuthClientRoutes } from '../../src/routes/auth-oauth-client.js';
import { FIRST_PARTY_DASHBOARD_ORIGINS } from '../../src/lib/cors-allow.js';
import { MemoryRateLimitStore } from '../../src/lib/memory-rate-limit-store.js';
import type { OAuthClientService } from '../../src/services/oauth-client.js';
import type { AuthFlowsService } from '../../src/services/auth-flows.js';

const ORIGIN_MESSAGE = 'redirect_to must be on the dashboard origin.';
const PROVIDER_MESSAGE = 'Provider "google" is not configured on this server.';

async function mount(dashboardOrigin: string) {
  const app = Fastify();
  registerOAuthClientRoutes(app, {
    // Neither service is reached: with no providers configured the handler throws
    // at the provider check, which sits right after the origin check under test.
    service: {} as unknown as OAuthClientService,
    authFlows: {} as unknown as AuthFlowsService,
    providers: {},
    callbackUrlBase: 'https://api.test.invalid/v1/auth/oauth-client',
    dashboardOrigin,
    signingSecret: 's'.repeat(48),
    logger: pino({ level: 'silent' }),
    rateLimitStore: new MemoryRateLimitStore(),
  });
  await app.ready();
  return app;
}

async function start(app: Awaited<ReturnType<typeof mount>>, redirectTo: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/oauth-client/start',
    payload: { provider: 'google', redirect_to: redirectTo },
  });
  // Compare the parsed message, not the raw body: the JSON escapes the quotes in
  // `Provider "google"`, so a substring match on the raw text reads a pass as a miss.
  const parsed = JSON.parse(res.body) as { message?: string };
  return { status: res.statusCode, message: parsed.message ?? '' };
}

describe('T-3 — /start accepts both first-party dashboard hosts, and only those', () => {
  it('the allow-list is exactly the two first-party dashboard hosts', () => {
    expect([...FIRST_PARTY_DASHBOARD_ORIGINS]).toEqual([
      'https://app.driftstack.io',
      'https://app.driftstack.dev',
    ]);
  });

  it('CRITICAL configured for .dev (the live prod state), a sign-in started from the .io dashboard passes the origin gate', async () => {
    const app = await mount('https://app.driftstack.dev');
    const r = await start(app, 'https://app.driftstack.io/sessions?x=1');
    expect(r.status).toBe(400);
    expect(r.message).toBe(PROVIDER_MESSAGE);
    await app.close();
  });

  it('configured for .io, a sign-in started from the .dev dashboard passes too (the redirect window runs both ways)', async () => {
    const app = await mount('https://app.driftstack.io');
    const r = await start(app, 'https://app.driftstack.dev/');
    expect(r.status).toBe(400);
    expect(r.message).toBe(PROVIDER_MESSAGE);
    await app.close();
  });

  it('CRITICAL an off-site redirect_to is still refused — the widening did not open the redirect', async () => {
    const app = await mount('https://app.driftstack.dev');
    for (const target of [
      'https://evil.example/',
      'https://app.driftstack.io.evil.example/',
      'https://app.driftstack.dev.evil.example/',
      'http://app.driftstack.io/',
    ]) {
      const r = await start(app, target);
      expect(r.status, target).toBe(400);
      expect(r.message, target).toBe(ORIGIN_MESSAGE);
    }
    await app.close();
  });

  it("a self-hosted operator's guard stays exact: their origin is accepted, the first-party hosts are not", async () => {
    const app = await mount('https://dash.example.com');
    const own = await start(app, 'https://dash.example.com/after-login');
    expect(own.message).toBe(PROVIDER_MESSAGE);
    for (const target of FIRST_PARTY_DASHBOARD_ORIGINS) {
      const r = await start(app, `${target}/`);
      expect(r.status, target).toBe(400);
      expect(r.message, target).toBe(ORIGIN_MESSAGE);
    }
    await app.close();
  });
});
