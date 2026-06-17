// Integration test for the SDK driving the Fastify app via Fastify's
// `inject()` (no real HTTP server needed; the SDK's HTTP layer accepts a
// `fetch` override and we wire it to inject()). This proves the SDK and
// server agree on the contract end-to-end.

import { afterEach, describe, expect, it } from 'vitest';
import {
  BadRequestError,
  Driftstack,
  FeatureUnavailableError,
  NotFoundError,
  ValidationError,
} from '../../src/index.js';
import {
  buildTestApp,
  type TestAppFixture,
} from '../../../../apps/server/tests/integration/_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

/** Wire fetch to fastify.inject so the SDK exercises the real route layer. */
function fetchAdapter(fixture: TestAppFixture): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlString =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlString);
    const method = (init?.method ?? 'GET') as 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
    }
    const payload = typeof init?.body === 'string' ? init.body : undefined;
    const res = await fixture.app.inject({
      method,
      url: url.pathname + url.search,
      headers,
      ...(payload !== undefined ? { payload } : {}),
    });
    const body = res.statusCode === 204 ? null : res.body;
    return new Response(body, {
      status: res.statusCode,
      headers: res.headers as Record<string, string>,
    });
  };
}

describe('@driftstack/sdk against real server', () => {
  it('end-to-end: create → navigate → state → capture → destroy', async () => {
    fx = await buildTestApp();
    const sdk = new Driftstack({
      apiKey: fx.plaintext,
      baseUrl: 'http://test.local',
      fetch: fetchAdapter(fx),
      retry: { maxAttempts: 0 },
    });

    const session = await sdk.sessions.create({ label: 'sdk-e2e' });
    expect(session.id).toMatch(/^ses_/);
    expect(session.status).toBe('ready');

    const nav = await sdk.sessions.navigate(session.id, { url: 'https://example.com' });
    expect(nav.status).toBe(200);
    expect(nav.final_url).toBe('https://example.com');

    const state = await sdk.sessions.getState(session.id);
    expect(state.url).toBe('https://example.com');

    const shot = await sdk.sessions.capture(session.id, { kind: 'screenshot' });
    expect(shot.encoding).toBe('base64');
    expect(typeof shot.data).toBe('string');

    await sdk.sessions.destroy(session.id);
  });

  it('typed errors flow through the SDK boundary', async () => {
    fx = await buildTestApp();
    const sdk = new Driftstack({
      apiKey: fx.plaintext,
      baseUrl: 'http://test.local',
      fetch: fetchAdapter(fx),
      retry: { maxAttempts: 0 },
    });

    await expect(
      sdk.sessions.navigate('ses_00000000-0000-4000-8000-000000000999', {
        url: 'https://example.com',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    await expect(sdk.sessions.create({ archetype: 'iPhone16Pro' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('list returns paginated shape', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const sdk = new Driftstack({
      apiKey: fx.plaintext,
      baseUrl: 'http://test.local',
      fetch: fetchAdapter(fx),
      retry: { maxAttempts: 0 },
    });

    await sdk.sessions.create({ label: 'a' });
    await sdk.sessions.create({ label: 'b' });

    const page = await sdk.sessions.list();
    expect(page.data.length).toBe(2);
    expect(page.has_more).toBe(false);
    expect(page.next_cursor).toBeNull();
  });

  it('apiKeys.create returns plaintext + admin revoke works', async () => {
    fx = await buildTestApp();
    const sdk = new Driftstack({
      apiKey: fx.plaintext,
      baseUrl: 'http://test.local',
      fetch: fetchAdapter(fx),
      retry: { maxAttempts: 0 },
    });

    const created = await sdk.apiKeys.create({ name: 'ci', scopes: ['read', 'write'] });
    expect(created.plaintext.startsWith('ds_live_')).toBe(true);

    const list = await sdk.apiKeys.list();
    expect(list.data.length).toBeGreaterThanOrEqual(2);

    await sdk.apiKeys.revoke(created.id);
  });

  it('usage.current returns the period summary', async () => {
    fx = await buildTestApp({ tier: 'api_scale' });
    const sdk = new Driftstack({
      apiKey: fx.plaintext,
      baseUrl: 'http://test.local',
      fetch: fetchAdapter(fx),
      retry: { maxAttempts: 0 },
    });

    const u = await sdk.usage.current();
    expect(u.tier).toBe('api_scale');
    expect(u.totals.navigate).toBe(0);
  });

  // ── V-091: webhooks resource ────────────────────────────────────────

  it('webhooks.create returns plaintext signing secret once', async () => {
    fx = await buildTestApp();
    const sdk = new Driftstack({
      apiKey: fx.plaintext,
      baseUrl: 'http://test.local',
      fetch: fetchAdapter(fx),
      retry: { maxAttempts: 0 },
    });

    const created = await sdk.webhooks.create({
      url: 'https://customer.example/hook',
      events: ['session.completed', 'session.failed'],
    });
    expect(created.id).toMatch(/^whk_/);
    expect(created.secret).toMatch(/^whsec_/);
    // List response strips the plaintext secret.
    const list = await sdk.webhooks.list();
    expect(list.data).toHaveLength(1);
    expect((list.data[0] as { secret?: unknown }).secret).toBeUndefined();
  });

  it('webhooks.get returns the endpoint without plaintext', async () => {
    fx = await buildTestApp();
    const sdk = new Driftstack({
      apiKey: fx.plaintext,
      baseUrl: 'http://test.local',
      fetch: fetchAdapter(fx),
      retry: { maxAttempts: 0 },
    });

    const created = await sdk.webhooks.create({
      url: 'https://customer.example/hook',
      events: ['session.completed'],
    });
    const fetched = await sdk.webhooks.get(created.id);
    expect(fetched.id).toBe(created.id);
    expect((fetched as { secret?: unknown }).secret).toBeUndefined();
  });

  it('webhooks.delete soft-disables the endpoint; second delete is idempotent', async () => {
    fx = await buildTestApp();
    const sdk = new Driftstack({
      apiKey: fx.plaintext,
      baseUrl: 'http://test.local',
      fetch: fetchAdapter(fx),
      retry: { maxAttempts: 0 },
    });

    const created = await sdk.webhooks.create({
      url: 'https://customer.example/hook',
      events: ['session.completed'],
    });
    await expect(sdk.webhooks.delete(created.id)).resolves.toBeUndefined();
    // Second delete is a 204 no-op (idempotent — endpoint stays disabled).
    await expect(sdk.webhooks.delete(created.id)).resolves.toBeUndefined();
  });

  it('webhooks.delete on unknown id throws NotFoundError', async () => {
    fx = await buildTestApp();
    const sdk = new Driftstack({
      apiKey: fx.plaintext,
      baseUrl: 'http://test.local',
      fetch: fetchAdapter(fx),
      retry: { maxAttempts: 0 },
    });

    await expect(
      sdk.webhooks.delete('whk_00000000-0000-4000-8000-000000000099'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('webhooks.listDeliveries returns paginated shape', async () => {
    fx = await buildTestApp();
    const sdk = new Driftstack({
      apiKey: fx.plaintext,
      baseUrl: 'http://test.local',
      fetch: fetchAdapter(fx),
      retry: { maxAttempts: 0 },
    });

    const created = await sdk.webhooks.create({
      url: 'https://customer.example/hook',
      events: ['session.completed'],
    });
    const page = await sdk.webhooks.listDeliveries(created.id, { limit: 10 });
    expect(page.data).toEqual([]);
    expect(page.has_more).toBe(false);
    expect(page.next_cursor).toBeNull();
  });

  it('webhooks.create surfaces ValidationError on non-https URL', async () => {
    fx = await buildTestApp();
    const sdk = new Driftstack({
      apiKey: fx.plaintext,
      baseUrl: 'http://test.local',
      fetch: fetchAdapter(fx),
      retry: { maxAttempts: 0 },
    });

    await expect(
      sdk.webhooks.create({
        url: 'http://insecure.example/hook',
        events: ['session.completed'],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  // ── V-101: profiles + billing resources ───────────────────────────────

  it('profiles.create + list + get + delete round-trips', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const sdk = new Driftstack({
      apiKey: fx.plaintext,
      baseUrl: 'http://test.local',
      fetch: fetchAdapter(fx),
      retry: { maxAttempts: 0 },
    });

    const created = await sdk.profiles.create({ name: 'sdk-test-profile' });
    expect(created.id).toMatch(/^prof_/);
    expect(created.name).toBe('sdk-test-profile');

    const list = await sdk.profiles.list();
    expect(list.data.length).toBe(1);

    const got = await sdk.profiles.get(created.id);
    expect(got.id).toBe(created.id);

    await expect(sdk.profiles.delete(created.id)).resolves.toBeUndefined();
  });

  it('billing.getState returns null subscription on a fresh account', async () => {
    fx = await buildTestApp();
    const sdk = new Driftstack({
      apiKey: fx.plaintext,
      baseUrl: 'http://test.local',
      fetch: fetchAdapter(fx),
      retry: { maxAttempts: 0 },
    });

    const state = await sdk.billing.getState();
    expect(state.subscription).toBeNull();
  });

  it('billing.createCheckoutSession returns a Stripe URL', async () => {
    fx = await buildTestApp();
    const sdk = new Driftstack({
      apiKey: fx.plaintext,
      baseUrl: 'http://test.local',
      fetch: fetchAdapter(fx),
      retry: { maxAttempts: 0 },
    });

    const result = await sdk.billing.createCheckoutSession({
      tier: 'api_builder',
      billing_period: 'monthly',
    });
    expect(result.checkout_url).toMatch(/^https:\/\//);
    expect(result.checkout_session_id).toMatch(/^cs_test_/);
  });

  // ─── EG-API-1.2/1.3 + AI-D — activation-gated route surfaces ────────
  // These tests exercise the SDK's error mapping on 503 FeatureUnavailable
  // (the disabled-stub posture that lives in prod until the
  // corresponding AppDeps service is wired on).

  it('SDK error mapping: egress.attachToSession on no-backend deployment → FeatureUnavailableError', async () => {
    fx = await buildTestApp();
    const sdk = new Driftstack({
      apiKey: fx.plaintext,
      baseUrl: 'http://test.local',
      fetch: fetchAdapter(fx),
      retry: { maxAttempts: 0 },
    });
    await expect(
      sdk.egress.attachToSession('ses_xxx', {
        session_id: 'ses_xxx',
        proxy: {
          type: 'socks5',
          socks5: { host: 'p.example', port: 1080, udp_associate: true, require_remote_dns: false },
        },
        egress_safeguard: {
          block_direct_internet: true,
          block_unproxied_dns: true,
          block_webrtc_stun_leakage: true,
        },
      }),
    ).rejects.toBeInstanceOf(FeatureUnavailableError);
  });

  it('SDK egress.listProxies hits the live account-proxies API → 200 empty list for a fresh account', async () => {
    fx = await buildTestApp();
    const sdk = new Driftstack({
      apiKey: fx.plaintext,
      baseUrl: 'http://test.local',
      fetch: fetchAdapter(fx),
      retry: { maxAttempts: 0 },
    });
    const result = await sdk.egress.listProxies();
    expect(result.data).toEqual([]);
  });

  it('SDK error mapping: egress.createProxy with a malformed OpenVPN .ovpn (no `client` directive) → BadRequestError; the api-types OpenVpnProxyConfigSchema .refine() pair bites at the account-proxies API boundary', async () => {
    fx = await buildTestApp();
    const sdk = new Driftstack({
      apiKey: fx.plaintext,
      baseUrl: 'http://test.local',
      fetch: fetchAdapter(fx),
      retry: { maxAttempts: 0 },
    });
    await expect(
      sdk.egress.createProxy({
        label: 'no-client-test',
        scheme: 'openvpn',
        host: 'vpn.example.com',
        port: 1194,
        openvpn: { config_blob: 'remote vpn.example.com 1194\ndev tun\n' },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('SDK error mapping: agentSessions.create on disabled-stub deployment → FeatureUnavailableError', async () => {
    fx = await buildTestApp();
    const sdk = new Driftstack({
      apiKey: fx.plaintext,
      baseUrl: 'http://test.local',
      fetch: fetchAdapter(fx),
      retry: { maxAttempts: 0 },
    });
    await expect(sdk.agentSessions.create()).rejects.toBeInstanceOf(FeatureUnavailableError);
  });

  it('SDK end-to-end: agentSessions.create + message + close (wired runtime)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const sdk = new Driftstack({
      apiKey: fx.plaintext,
      baseUrl: 'http://test.local',
      fetch: fetchAdapter(fx),
      retry: { maxAttempts: 0 },
    });
    const created = await sdk.agentSessions.create({ token_budget: 25_000 });
    expect(created.id).toMatch(/^agt_inmem_/);
    expect(created.status).toBe('active');

    const turn = await sdk.agentSessions.message(
      created.id,
      'open https://example.com and capture',
    );
    expect(turn.kind).toBe('plan-executed');
    if (turn.kind !== 'plan-executed') throw new Error('type narrow');
    expect(turn.ok).toBe(true);
    expect(turn.intents.length).toBeGreaterThan(0);

    const read = await sdk.agentSessions.get(created.id);
    expect(read.transcript_length).toBe(2);
    expect(read.token_budget_remaining).toBeLessThan(25_000);

    await sdk.agentSessions.close(created.id);
  });

  it('SDK end-to-end: agentSessions.get on a never-existed id → NotFoundError (caught the ab69eb17 503-vs-404 bug at the SDK layer)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const sdk = new Driftstack({
      apiKey: fx.plaintext,
      baseUrl: 'http://test.local',
      fetch: fetchAdapter(fx),
      retry: { maxAttempts: 0 },
    });
    await expect(sdk.agentSessions.get('agt_inmem_99999999')).rejects.toBeInstanceOf(NotFoundError);
  });
});
