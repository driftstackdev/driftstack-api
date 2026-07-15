// AI-D — integration tests for /v1/agent-sessions/* routes.
//
// Two postures:
//   1. Activation-gate ON (no agentRuntime wired in AppDeps — prod
//      default until founder flips the LLM key path on): every
//      endpoint returns 503 FeatureUnavailable.
//   2. Wired (deterministic decomposer + stub executor +
//      in-memory repo injected via the test helper): end-to-end
//      decompose → execute → transcript flow exercised.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROBLEM_TYPES, TIER_STORAGE_BYTES_CAP } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import type {
  ProxyConnectivityProbe,
  ProxyProbeResult,
} from '../../src/services/proxy-connectivity-probe.js';
import { hashAgentTurnRequest } from '../../src/services/agent-turn-receipts.js';

describe('AI-D /v1/agent-sessions/* (activation gate off — runtime not wired)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('POST /v1/agent-sessions → 503 FeatureUnavailable', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });

  it('GET /v1/agent-sessions (list) → 503 FeatureUnavailable (the list stub was missing — the dashboard "recent sessions" call hit a bare 404)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });

  it('POST /v1/agent-sessions/:id/message → 503', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_xxx/message',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'hi' },
    });
    expect(res.statusCode).toBe(503);
  });

  it('GET /v1/agent-sessions/:id → 503', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/agent-sessions/agt_xxx',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(503);
  });

  it('GET /v1/agent-sessions/:id/page-state → 503 (W650/A3-W1254 — gated like the others, not a bare 404)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/agent-sessions/agt_xxx/page-state',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(503);
  });

  it('DELETE /v1/agent-sessions/:id → 503', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/agent-sessions/agt_xxx',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(503);
  });

  // Arc 4 Wave 2.B sub-slice 8.20.h (v2-#8) — without this regression
  // pin, the disabled-routes stub was missing /takeover + /handback.
  // The SDK + dashboard would see a generic 404 instead of the
  // documented 503 FeatureUnavailable problem type — confusing
  // customers who'd expect "feature not enabled" framing.
  it('POST /v1/agent-sessions/:id/takeover → 503 FeatureUnavailable', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_xxx/takeover',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { client_id: 'cli_a' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });

  it('POST /v1/agent-sessions/:id/handback → 503 FeatureUnavailable', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_xxx/handback',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });

  it('Slice 3 (Wave 29-NNN ARC 3) POST /v1/agent-sessions/:id/mode → 503 FeatureUnavailable when runtime not wired', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_xxx/mode',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'pair' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });

  it('Slice 4 (Wave 29-NNN ARC 3) POST /v1/agent-sessions/:id/input-event → 503 FeatureUnavailable when runtime not wired', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_xxx/input-event',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { event: { type: 'mouseMove', x: 10, y: 20 } },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });

  it('W393 POST /v1/agent-sessions/:id/resume → 503 FeatureUnavailable when runtime not wired', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_xxx/resume',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });
});

describe('AI-D /v1/agent-sessions/* (wired — deterministic runtime)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('403 when the key lacks write scope (read-only key)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, scopes: ['read'] });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000 },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toContain('write');
  });

  // Team RBAC (2026-06-16) — agent-session create now honors X-Driftstack-Account
  // (admin team-launch). These pin the SECURITY boundary: the new header path
  // must fail CLOSED for non-members / malformed headers, and self-scope must be
  // unaffected. (Mirrors the driver-session V-326e3 contract + the
  // team-rbac-x-driftstack-account-end-to-end read tests.)
  it('create with X-Driftstack-Account pointing at a non-member account → fail-closed (4xx, never 201/500)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': 'acc_00000000-0000-4000-8000-000000000002',
      },
      payload: { token_budget: 50_000 },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500); // not a 500 — a clean fail-closed
    expect(res.statusCode).not.toBe(201); // never silently creates under a foreign account
  });

  it('create with a malformed X-Driftstack-Account → 4xx, not 500', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': 'not-a-valid-acc-id',
      },
      payload: { token_budget: 50_000 },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it("create with the caller's OWN account-id in X-Driftstack-Account → 201 (self-scope unchanged)", async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const me = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const ownId = me.json<{ id?: string }>().id ?? '';
    expect(ownId).toMatch(/^acc_/);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'x-driftstack-account': ownId },
      payload: { token_budget: 50_000 },
    });
    expect(res.statusCode).toBe(201);
  });

  it('geolocation override: valid coordinates → 201; out-of-range → 400 (A3 contract 2026-07-01)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const ok = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
      payload: {
        token_budget: 50_000,
        geolocation: { latitude: 48.8566, longitude: 2.3522, accuracy: 20 },
      },
    });
    expect(ok.statusCode).toBe(201);
    const bad = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
      payload: { token_budget: 50_000, geolocation: { latitude: 91, longitude: 0 } },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('ARC A: create with an unknown/unowned proxy_id → 404 (never confirms a foreign proxy)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, proxy_id: '00000000-0000-4000-8000-000000000099' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('ARC A: create with the caller’s OWN proxy_id → 201', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const proxy = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
      payload: { label: 'mine', host: 'proxy.customer.example', port: 1080, password: 'pw' },
    });
    expect(proxy.statusCode).toBe(201);
    const proxyId = proxy.json<{ id: string }>().id;
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, proxy_id: proxyId },
    });
    expect(res.statusCode).toBe(201);
  });

  it('#15: create with an HTTP-scheme proxy_id → 400 at create (not a silent 30s dead-end) — http has no inline-dispatch slot', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const proxy = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
      payload: {
        label: 'http one',
        scheme: 'http',
        host: 'proxy.customer.example',
        port: 8080,
      },
    });
    expect(proxy.statusCode).toBe(201);
    const proxyId = proxy.json<{ id: string }>().id;
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, proxy_id: proxyId },
    });
    // Authoritative reject at CREATE — the session row is never minted, so it
    // never leaks a phantom active slot (#16) and the GUI gets an instant honest
    // message instead of a 30s "the proxy may be down" timeout.
    expect(res.statusCode).toBe(400);
    expect(res.json<{ detail?: string }>().detail).toBe(
      'HTTP proxies are unsupported for browser sessions on this deployment — use a SOCKS5, OpenVPN, or WireGuard proxy.',
    );
  });

  // ── #63 LIVE proxy pre-launch validation gate ─────────────────────────────
  // A proxy must be TESTED LIVE + validated BEFORE a launch. A failing live test
  // BLOCKS the launch with a clean 422 (ProxyValidationFailed) — zero session row,
  // zero worker dispatch. A passing test proceeds to create as today.
  //
  // The stub probe stands in for ProxyConnectivityProbe (its `.probe()` returns a
  // typed pass/fail) so these tests don't open sockets; the probe's own handshake
  // logic is covered in proxy-connectivity-probe.test.ts.
  const stubProbe = (result: ProxyProbeResult): ProxyConnectivityProbe =>
    ({ probe: () => Promise.resolve(result) }) as unknown as ProxyConnectivityProbe;

  async function seedOwnSocks5Proxy(fixture: TestAppFixture): Promise<string> {
    const proxy = await fixture.app.inject({
      method: 'POST',
      url: '/v1/account/me/proxies',
      headers: { authorization: `Bearer ${fixture.plaintext}`, 'content-type': 'application/json' },
      payload: { label: 'mine', host: 'proxy.customer.example', port: 1080, password: 'pw' },
    });
    expect(proxy.statusCode).toBe(201);
    return proxy.json<{ id: string }>().id;
  }

  it('#63 probe PASS → 201 (launch proceeds; the live test succeeded)', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      proxyConnectivityProbe: stubProbe({ ok: true }),
    });
    const proxyId = await seedOwnSocks5Proxy(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, proxy_id: proxyId },
    });
    expect(res.statusCode).toBe(201);
  });

  it('#63 probe FAIL (unreachable) → 422 ProxyValidationFailed + NO session created (zero dispatch)', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      proxyConnectivityProbe: stubProbe({ ok: false, reason: 'unreachable' }),
    });
    const proxyId = await seedOwnSocks5Proxy(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, proxy_id: proxyId },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json<{ type: string; reason?: string }>();
    expect(body.type).toBe(PROBLEM_TYPES.ProxyValidationFailed);
    expect(body.reason).toBe('unreachable');
    // Fail-CLOSED: the session row was never created (no phantom active slot, no
    // worker spin-up). countActive stays 0.
    expect(await fx.agentSessionsRepo!.countActive(fx.accountId)).toBe(0);
  });

  it('#63 TRANSIENT unreachable then ok → retried ONCE → 201 (rotating-exit resilience, A3 W2949)', async () => {
    let calls = 0;
    const seqProbe = {
      probe: () => {
        calls += 1;
        return Promise.resolve(calls === 1 ? { ok: false, reason: 'unreachable' } : { ok: true });
      },
    } as unknown as ProxyConnectivityProbe;
    fx = await buildTestApp({ enableAgentRuntime: true, proxyConnectivityProbe: seqProbe });
    const proxyId = await seedOwnSocks5Proxy(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, proxy_id: proxyId },
    });
    expect(res.statusCode).toBe(201);
    expect(calls).toBe(2); // first attempt transient-unreachable, retried, second passed
  });

  it('#63 auth_failed is NOT retried (wrong creds cannot self-heal) → 422 after exactly ONE probe', async () => {
    let calls = 0;
    const authProbe = {
      probe: () => {
        calls += 1;
        return Promise.resolve({ ok: false, reason: 'auth_failed' as const });
      },
    } as unknown as ProxyConnectivityProbe;
    fx = await buildTestApp({ enableAgentRuntime: true, proxyConnectivityProbe: authProbe });
    const proxyId = await seedOwnSocks5Proxy(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, proxy_id: proxyId },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ reason?: string }>().reason).toBe('auth_failed');
    expect(calls).toBe(1); // auth_failed is terminal — no retry
  });

  it('#63 probe FAIL (auth_failed) → 422 with the auth_failed reason', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      proxyConnectivityProbe: stubProbe({ ok: false, reason: 'auth_failed' }),
    });
    const proxyId = await seedOwnSocks5Proxy(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, proxy_id: proxyId },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ reason?: string }>().reason).toBe('auth_failed');
  });

  it('#63 probe TIMEOUT → 422 (a slow/half-open proxy blocks the launch, not hangs it) + no session', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      proxyConnectivityProbe: stubProbe({ ok: false, reason: 'timeout' }),
    });
    const proxyId = await seedOwnSocks5Proxy(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, proxy_id: proxyId },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ reason?: string }>().reason).toBe('timeout');
    expect(await fx.agentSessionsRepo!.countActive(fx.accountId)).toBe(0);
  });

  it('#63 gate DISABLED (proxyPrelaunchProbeEnabled:false) → a failing probe does NOT block (201) — the operator escape hatch', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      proxyConnectivityProbe: stubProbe({ ok: false, reason: 'unreachable' }),
      proxyPrelaunchProbeEnabled: false,
    });
    const proxyId = await seedOwnSocks5Proxy(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, proxy_id: proxyId },
    });
    expect(res.statusCode).toBe(201);
  });

  it('#63 no probe wired → gate is a no-op (proxied create still 201, today’s behaviour)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const proxyId = await seedOwnSocks5Proxy(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, proxy_id: proxyId },
    });
    expect(res.statusCode).toBe(201);
  });

  it('#63 a create WITHOUT proxy_id never invokes the probe (no proxy = no gate)', async () => {
    let probeCalls = 0;
    fx = await buildTestApp({
      enableAgentRuntime: true,
      proxyConnectivityProbe: {
        probe: () => {
          probeCalls += 1;
          return Promise.resolve<ProxyProbeResult>({ ok: false, reason: 'unreachable' });
        },
      } as unknown as ProxyConnectivityProbe,
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000 },
    });
    expect(res.statusCode).toBe(201);
    expect(probeCalls).toBe(0);
  });

  it('#63 idempotent retry REPLAYS the original 201 WITHOUT re-probing (idempotency must replay success, not re-run the gate)', async () => {
    // A counting probe: first call passes (the real create), and we assert it is
    // NOT invoked again on the idempotent replay — otherwise a retry of an already-
    // succeeded create could return a fresh 422 + burn a rate-limit token.
    let probeCalls = 0;
    fx = await buildTestApp({
      enableAgentRuntime: true,
      proxyConnectivityProbe: {
        probe: () => {
          probeCalls += 1;
          return Promise.resolve<ProxyProbeResult>({ ok: true });
        },
      } as unknown as ProxyConnectivityProbe,
    });
    const proxyId = await seedOwnSocks5Proxy(fx);
    const key = 'idem-key-probe-replay-1';
    const first = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'idempotency-key': key },
      payload: { token_budget: 50_000, proxy_id: proxyId },
    });
    expect(first.statusCode).toBe(201);
    expect(probeCalls).toBe(1);
    const firstId = first.json<{ id: string }>().id;

    const replay = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'idempotency-key': key },
      payload: { token_budget: 50_000, proxy_id: proxyId },
    });
    expect(replay.statusCode).toBe(201);
    // Same session replayed, and the probe did NOT run again.
    expect(replay.json<{ id: string }>().id).toBe(firstId);
    expect(probeCalls).toBe(1);
    // Exactly one row — the replay didn't create a second session.
    expect(await fx.agentSessionsRepo!.countActive(fx.accountId)).toBe(1);
  });

  it('#63 skip_proxy_probe:true → "Launch anyway" override SKIPS the gate (a failing probe does NOT block; 201)', async () => {
    let probeCalls = 0;
    fx = await buildTestApp({
      enableAgentRuntime: true,
      proxyConnectivityProbe: {
        probe: () => {
          probeCalls += 1;
          return Promise.resolve<ProxyProbeResult>({ ok: false, reason: 'unreachable' });
        },
      } as unknown as ProxyConnectivityProbe,
    });
    const proxyId = await seedOwnSocks5Proxy(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, proxy_id: proxyId, skip_proxy_probe: true },
    });
    expect(res.statusCode).toBe(201);
    // The override skips the gate entirely — the probe is never even invoked.
    expect(probeCalls).toBe(0);
  });

  it('#63 skip_proxy_probe absent/false → the gate still runs (a failing probe blocks with 422)', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      proxyConnectivityProbe: stubProbe({ ok: false, reason: 'unreachable' }),
    });
    const proxyId = await seedOwnSocks5Proxy(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, proxy_id: proxyId, skip_proxy_probe: false },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ reason?: string }>().reason).toBe('unreachable');
  });

  it('#63 skip_proxy_probe must be a boolean → a non-boolean is rejected (400, never coerced to skip the gate)', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      proxyConnectivityProbe: stubProbe({ ok: false, reason: 'unreachable' }),
    });
    const proxyId = await seedOwnSocks5Proxy(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, proxy_id: proxyId, skip_proxy_probe: 'yes' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('initial_url validation: http(s) accepted (201); javascript:/file:/data:/garbage + over-length rejected (400) — customer start URL is scheme-guarded at the route', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const post = (initial_url: string) =>
      fx.app.inject({
        method: 'POST',
        url: '/v1/agent-sessions',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { token_budget: 50_000, initial_url },
      });
    // Valid http(s) → created (not a validation 400).
    expect((await post('https://news.example.com/x')).statusCode).toBe(201);
    expect((await post('http://example.org')).statusCode).toBe(201);
    // Dangerous / non-http schemes + unparseable → 400 at the route refine.
    expect((await post('javascript:alert(1)')).statusCode).toBe(400);
    expect((await post('file:///etc/passwd')).statusCode).toBe(400);
    expect((await post('data:text/html,x')).statusCode).toBe(400);
    expect((await post('not a url')).statusCode).toBe(400);
    // Over the 2048-char cap → 400.
    expect((await post('https://x.com/' + 'a'.repeat(2100))).statusCode).toBe(400);
  });

  it('GET /v1/agent-sessions is cursor-paginated: { data, has_more, next_cursor } — limit pages, the cursor reaches older sessions (was hard-capped at 100, no cursor)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const auth = { authorization: `Bearer ${fx.plaintext}` };
    // Create 3 sessions (newest last). created_at desc → the list returns them
    // most-recent first.
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const created = await fx.app.inject({
        method: 'POST',
        url: '/v1/agent-sessions',
        headers: auth,
        payload: { token_budget: 50_000 },
      });
      expect(created.statusCode).toBe(201);
      ids.push(created.json<{ id: string }>().id);
    }

    // Page 1 (limit=2) → 2 rows + has_more + a next_cursor.
    const page1 = await fx.app.inject({
      method: 'GET',
      url: '/v1/agent-sessions?limit=2',
      headers: auth,
    });
    expect(page1.statusCode).toBe(200);
    const b1 = page1.json<{
      data: { id: string }[];
      has_more: boolean;
      next_cursor: string | null;
    }>();
    expect(b1.data).toHaveLength(2);
    expect(b1.has_more).toBe(true);
    expect(b1.next_cursor).not.toBeNull();

    // Page 2 (the cursor) → the remaining 1 row, no more pages. Every created
    // id is reachable across the two pages (no silent truncation).
    const page2 = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions?limit=2&cursor=${encodeURIComponent(b1.next_cursor ?? '')}`,
      headers: auth,
    });
    expect(page2.statusCode).toBe(200);
    const b2 = page2.json<{
      data: { id: string }[];
      has_more: boolean;
      next_cursor: string | null;
    }>();
    expect(b2.data).toHaveLength(1);
    expect(b2.has_more).toBe(false);
    expect(b2.next_cursor).toBeNull();

    const seen = new Set([...b1.data, ...b2.data].map((s) => s.id));
    for (const id of ids) expect(seen.has(id)).toBe(true);
  });

  it('GET /v1/agent-sessions tolerates a malformed cursor → first page (never a 500)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const auth = { authorization: `Bearer ${fx.plaintext}` };
    await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: auth,
      payload: { token_budget: 50_000 },
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/agent-sessions?cursor=not-a-real-cursor',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: unknown[] }>().data.length).toBeGreaterThanOrEqual(1);
  });

  // Teams member-launch (898cb5f) — the SECURITY-SENSITIVE positive + RBAC
  // paths, exercised against a REAL seeded membership (the fail-closed
  // non-member / malformed cases are covered above). These pin the three
  // properties that matter for the cross-account boundary: an ADMIN member may
  // launch under the owner, a plain MEMBER may not, and owner-scoping holds so
  // an admin can never reach (hence never DEK-unwrap) a profile the owner does
  // not own. DEK owner-only is structurally guaranteed downstream — the DEK
  // lookup is keyed to ownerAccountId AND the unwrap is HKDF-bound to it — but
  // the route never reaches the DEK for an unowned profile because the
  // owner-scoped profile validation 404s first; that is what we pin here.
  const TEAM_OWNER_ID = '00000000-0000-4000-8000-000000000b01';
  const TEAM_MEMBERSHIP_ID = '00000000-0000-4000-8000-000000000b02';

  // S42 2026-07-07 (founder-approved) — the aiAgent tier gate resolves the
  // OWNER's tier via authRepo on team-scoped creates, so the owner account
  // must actually EXIST (the fabricated-membership-only setup used to skate
  // through because nothing read the owner row on a profileless create).
  // Seed a real owner on team_manual (the lowest aiAgent tier).
  function seedTeamOwnerAccount(fixture: TestAppFixture): void {
    fixture.authRepo.upsertAccount({
      id: TEAM_OWNER_ID,
      email: 'team-owner@driftstack.local',
      name: 'Team Owner',
      tier: 'team_manual',
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
  }

  it('Teams collection: an ADMIN lists only the selected owner workspace, paginates it, and cannot use a personal cursor to cross scope', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    seedTeamOwnerAccount(fx);
    fx.authRepo.setTeamMemberships(fx.accountId, [
      { membershipId: TEAM_MEMBERSHIP_ID, ownerAccountId: TEAM_OWNER_ID, role: 'admin' },
    ]);
    const repo = fx.agentSessionsRepo;
    expect(repo).toBeDefined();
    const personal = await repo!.create({ accountId: fx.accountId, tokenBudgetTotal: 50_000 });
    const ownerRows = await Promise.all(
      Array.from({ length: 3 }, () =>
        repo!.create({ accountId: TEAM_OWNER_ID, tokenBudgetTotal: 50_000 }),
      ),
    );
    const auth = {
      authorization: `Bearer ${fx.plaintext}`,
      'x-driftstack-account': `acc_${TEAM_OWNER_ID}`,
    };

    const first = await fx.app.inject({
      method: 'GET',
      url: '/v1/agent-sessions?limit=2',
      headers: auth,
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{
      data: Array<{ id: string; account_id: string }>;
      has_more: boolean;
      next_cursor: string | null;
    }>();
    expect(firstBody.data).toHaveLength(2);
    expect(firstBody.data.every((row) => row.account_id === TEAM_OWNER_ID)).toBe(true);
    expect(firstBody.data.some((row) => row.id === personal.id)).toBe(false);
    expect(firstBody.has_more).toBe(true);

    const second = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions?limit=2&cursor=${encodeURIComponent(firstBody.next_cursor ?? '')}`,
      headers: auth,
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json<{
      data: Array<{ id: string; account_id: string }>;
      has_more: boolean;
    }>();
    expect(secondBody.data).toHaveLength(1);
    expect(secondBody.has_more).toBe(false);
    const seenOwnerIds = new Set([...firstBody.data, ...secondBody.data].map((row) => row.id));
    expect(seenOwnerIds).toEqual(new Set(ownerRows.map((row) => row.id)));

    // A cursor is only an anchor inside the selected account's filtered list.
    // Supplying a valid cursor from the caller's personal workspace restarts
    // the owner's first page; it never admits the personal row.
    const foreignCursor = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions?limit=10&cursor=${encodeURIComponent(personal.id)}`,
      headers: auth,
    });
    expect(foreignCursor.statusCode).toBe(200);
    const foreignCursorRows = foreignCursor.json<{
      data: Array<{ id: string; account_id: string }>;
    }>().data;
    expect(foreignCursorRows).toHaveLength(3);
    expect(foreignCursorRows.every((row) => row.account_id === TEAM_OWNER_ID)).toBe(true);
    expect(foreignCursorRows.some((row) => row.id === personal.id)).toBe(false);

    const self = await fx.app.inject({
      method: 'GET',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(self.statusCode).toBe(200);
    expect(self.json<{ data: Array<{ id: string }> }>().data.map((row) => row.id)).toEqual([
      personal.id,
    ]);
  });

  it('Teams collection: a read-only member cannot list transcript/control-bearing owner agent sessions', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    seedTeamOwnerAccount(fx);
    fx.authRepo.setTeamMemberships(fx.accountId, [
      { membershipId: TEAM_MEMBERSHIP_ID, ownerAccountId: TEAM_OWNER_ID, role: 'member' },
    ]);
    await fx.agentSessionsRepo!.create({
      accountId: TEAM_OWNER_ID,
      tokenBudgetTotal: 50_000,
    });

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/agent-sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${TEAM_OWNER_ID}`,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toContain('requires admin role');
  });

  it('Teams member-launch: an ADMIN team member launching under the owner (X-Driftstack-Account=owner) → 201 (session scoped to the owner)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    seedTeamOwnerAccount(fx);
    fx.authRepo.setTeamMemberships(fx.accountId, [
      { membershipId: TEAM_MEMBERSHIP_ID, ownerAccountId: TEAM_OWNER_ID, role: 'admin' },
    ]);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${TEAM_OWNER_ID}`,
      },
      payload: { token_budget: 50_000 },
    });
    expect(res.statusCode).toBe(201);
  });

  it('Teams member-launch: a NON-admin (role=member) launching under the owner → 403 (never 201) — only admins launch on the team', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    fx.authRepo.setTeamMemberships(fx.accountId, [
      { membershipId: TEAM_MEMBERSHIP_ID, ownerAccountId: TEAM_OWNER_ID, role: 'member' },
    ]);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${TEAM_OWNER_ID}`,
      },
      payload: { token_budget: 50_000 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.statusCode).not.toBe(201);
  });

  it('Teams member-launch (DEK owner-only boundary): an admin launching under the owner with a well-formed profile_id the OWNER does NOT own → 404 (owner-scoped profile validation rejects before any DEK reach)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    fx.authRepo.setTeamMemberships(fx.accountId, [
      { membershipId: TEAM_MEMBERSHIP_ID, ownerAccountId: TEAM_OWNER_ID, role: 'admin' },
    ]);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${TEAM_OWNER_ID}`,
      },
      payload: { token_budget: 50_000, profile_id: 'prof_00000000-0000-4000-8000-0000000000ff' },
    });
    expect(res.statusCode).toBe(404);
  });

  // audit wxzlp9yiz #4 — the session-scoped routes (GET/page-state/transcript/
  // gui-control-key/input-event/mode/takeover/handback/message/DELETE/resume)
  // compared ownership against ctx.account.id ONLY, so a team admin who launched
  // a session UNDER the owner (X-Driftstack-Account, which the GUI/SDK/dashboard
  // send for workspace switching) was LOCKED OUT of reading/controlling/deleting
  // their own launch. callerCanAccessAgentSession() now grants access to the
  // session owner OR an admin member of it (membership resolved server-side from
  // ctx.teams — the header can't forge it). This pins the end-to-end positive
  // (admin in: READ + DELETE); the negative branches (non-admin out, non-member
  // out) are pinned in the helper unit test (agent-sessions-caller-access) — an
  // integration 404 can't distinguish "blocked" from "not found" (same
  // anti-enumeration message) and the auth-cache defeats mid-test role-switching.
  it('Teams #4: an ADMIN member can READ + DELETE the session they launched under the owner (was 404-locked-out)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    // S42 — the tier gate reads the owner's account row; see seedTeamOwnerAccount.
    seedTeamOwnerAccount(fx);
    fx.authRepo.setTeamMemberships(fx.accountId, [
      { membershipId: TEAM_MEMBERSHIP_ID, ownerAccountId: TEAM_OWNER_ID, role: 'admin' },
    ]);
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${TEAM_OWNER_ID}`,
      },
      payload: { token_budget: 50_000 },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json<{ id: string; account_id: string }>();
    // Precondition: the session is owned by the OWNER, not the calling member.
    expect(body.account_id).toBe(TEAM_OWNER_ID);
    expect(body.account_id).not.toBe(fx.accountId);
    // READ — was 404 before the fix.
    const got = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${body.id}`,
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${TEAM_OWNER_ID}`,
      },
    });
    expect(got.statusCode).toBe(200);
    // DELETE — the admin can also end the session they launched.
    const del = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/agent-sessions/${body.id}`,
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${TEAM_OWNER_ID}`,
      },
    });
    expect(del.statusCode).toBe(204);
  });

  it('W393 POST /:id/resume → 202 for an owned active session; 404 unknown; 409 terminal', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000 },
    });
    const { id } = create.json<{ id: string }>();

    // Owned session → 202 (dispatch is inert without a fleet node, but the route accepts).
    const ok = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/resume`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { challenge_id: 'chl_1' },
    });
    expect(ok.statusCode).toBe(202);
    expect(ok.json<{ status: string }>().status).toBe('resume_requested');

    // Unknown / not-owned session id → 404 (ownership-scoped repo.get).
    const missing = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_inmem_does_not_exist/resume',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(missing.statusCode).toBe(404);

    // Terminal (closed) session → 409 (resume requires an active session).
    await fx.app.inject({
      method: 'DELETE',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const closed = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/resume`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(closed.statusCode).toBe(409);
  });

  it('full lifecycle: create → message (plan) → get → close', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });

    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000 },
    });
    expect(create.statusCode).toBe(201);
    const sessionCreate = create.json<{
      id: string;
      status: string;
      token_budget_remaining: number;
    }>();
    expect(sessionCreate.id).toMatch(/^agt_inmem_/);
    expect(sessionCreate.status).toBe('active');
    expect(sessionCreate.token_budget_remaining).toBe(50_000);

    const message = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${sessionCreate.id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'open https://example.com and capture' },
    });
    expect(message.statusCode).toBe(200);
    const msgBody = message.json<{
      kind: string;
      intents?: unknown[];
      ok?: boolean;
    }>();
    expect(msgBody.kind).toBe('plan-executed');
    expect(msgBody.ok).toBe(true);
    expect(Array.isArray(msgBody.intents)).toBe(true);

    const read = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${sessionCreate.id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(read.statusCode).toBe(200);
    const readBody = read.json<{ transcript_length: number; token_budget_remaining: number }>();
    expect(readBody.transcript_length).toBe(2); // user turn + agent run-result
    expect(readBody.token_budget_remaining).toBeLessThan(50_000);

    const close = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/agent-sessions/${sessionCreate.id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(close.statusCode).toBe(204);

    // Subsequent message on a closed session → 409 Conflict.
    const post = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${sessionCreate.id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'anything' },
    });
    expect(post.statusCode).toBe(409);
  });

  it('message Idempotency-Key replays one exact JSON/SSE terminal and never executes the browser turn twice', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000 },
    });
    const id = create.json<{ id: string }>().id;
    const headers = {
      authorization: `Bearer ${fx.plaintext}`,
      'idempotency-key': 'logical-turn-1',
    };
    const payload = { user_message: 'open https://example.com and capture' };

    const first = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers,
      payload,
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();

    const replay = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers,
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(firstBody);

    const streamReplay = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { ...headers, accept: 'text/event-stream' },
      payload,
    });
    const dataLine = streamReplay.body.split('\n').find((line) => line.startsWith('data: {'));
    expect(JSON.parse(dataLine!.slice('data: '.length))).toEqual({
      status: 200,
      body: firstBody,
    });

    const read = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(read.json<{ transcript_length: number }>().transcript_length).toBe(2);
  });

  it('message Idempotency-Key rejects body/session reuse and an unresolved in-progress receipt without dispatch', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const createSession = async (): Promise<string> => {
      const response = await fx.app.inject({
        method: 'POST',
        url: '/v1/agent-sessions',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { token_budget: 50_000 },
      });
      return response.json<{ id: string }>().id;
    };
    const id = await createSession();
    const otherId = await createSession();
    const headers = {
      authorization: `Bearer ${fx.plaintext}`,
      'idempotency-key': 'logical-turn-reuse',
    };
    const first = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers,
      payload: { user_message: 'first task' },
    });
    expect(first.statusCode).toBe(200);

    for (const [sessionId, userMessage] of [
      [id, 'different task'],
      [otherId, 'first task'],
    ] as const) {
      const mismatch = await fx.app.inject({
        method: 'POST',
        url: `/v1/agent-sessions/${sessionId}/message`,
        headers,
        payload: { user_message: userMessage },
      });
      expect(mismatch.statusCode).toBe(409);
      expect(mismatch.json()).toMatchObject({ idempotency_status: 'mismatch' });
    }

    const pendingKey = 'logical-turn-pending';
    await fx.agentTurnReceiptsRepo!.reserve({
      accountId: fx.accountId,
      agentSessionId: otherId,
      idempotencyKey: pendingKey,
      requestHash: hashAgentTurnRequest({
        agentSessionId: otherId,
        userMessage: 'must not dispatch',
      }),
    });
    const pending = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${otherId}/message`,
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'idempotency-key': pendingKey,
      },
      payload: { user_message: 'must not dispatch' },
    });
    expect(pending.statusCode).toBe(409);
    expect(pending.json()).toMatchObject({ idempotency_status: 'in_progress' });
    expect((await fx.agentSessionsRepo!.get(otherId))?.transcript).toHaveLength(0);
  });

  it('message Idempotency-Key persists and replays a typed terminal problem', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    await fx.app.inject({
      method: 'DELETE',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const request = {
      method: 'POST' as const,
      url: `/v1/agent-sessions/${id}/message`,
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'idempotency-key': 'closed-turn-problem',
      },
      payload: { user_message: 'will fail once' },
    };
    const first = await fx.app.inject(request);
    const replay = await fx.app.inject(request);
    expect(first.statusCode).toBe(409);
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toEqual(first.json());
  });

  it('message rejects malformed keys before dispatch and fails closed when durable receipt storage is unavailable', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, disableAgentTurnReceipts: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    const malformed = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'idempotency-key': 'contains whitespace',
      },
      payload: { user_message: 'must not dispatch' },
    });
    expect(malformed.statusCode).toBe(400);

    const unavailable = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'idempotency-key': 'valid-but-no-receipt-store',
      },
      payload: { user_message: 'must not dispatch' },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({
      type: 'https://errors.driftstack.dev/feature-unavailable',
    });
    expect((await fx.agentSessionsRepo!.get(id))?.transcript).toHaveLength(0);
  });

  it('message SSE representation opens immediately, emits bounded heartbeats, then one terminal success envelope', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;

    // Trigger one interval callback immediately while preserving the real timer
    // handle (`unref` + clearInterval semantics). This proves the representation
    // can send a heartbeat while handleAgentMessage is still the awaited work.
    const realSetInterval = globalThis.setInterval;
    const intervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      callback: (...callbackArgs: unknown[]) => void,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (timeout === 15_000) callback(...args);
      return realSetInterval(callback, timeout, ...args);
    }) as typeof globalThis.setInterval);
    let response;
    try {
      response = await fx.app.inject({
        method: 'POST',
        url: `/v1/agent-sessions/${id}/message`,
        headers: {
          authorization: `Bearer ${fx.plaintext}`,
          accept: 'text/event-stream',
        },
        payload: { user_message: 'open https://example.com and capture' },
      });
    } finally {
      intervalSpy.mockRestore();
    }

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toContain(': stream open\n\n');
    expect(response.body).toContain(': heartbeat ');
    expect(response.body.match(/event: response/g)).toHaveLength(1);
    const dataLine = response.body.split('\n').find((line) => line.startsWith('data: {'));
    expect(dataLine).toBeDefined();
    const terminal = JSON.parse(dataLine!.slice('data: '.length)) as {
      status: number;
      body: { kind?: string; ok?: boolean };
    };
    expect(terminal).toMatchObject({
      status: 200,
      body: { kind: 'plan-executed', ok: true },
    });
  });

  it('message SSE negotiation rejects prefix-like media types and preserves JSON errors', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const response = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_inmem_99999999/message',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        accept: 'text/event-streaming',
      },
      payload: { user_message: 'anything' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ type: PROBLEM_TYPES.NotFound, status: 404 });
  });

  it('message SSE representation carries the ordinary typed Problem as its terminal envelope', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const response = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_inmem_99999999/message',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        accept: 'text/event-stream',
      },
      payload: { user_message: 'anything' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    const dataLine = response.body.split('\n').find((line) => line.startsWith('data: {'));
    const terminal = JSON.parse(dataLine!.slice('data: '.length)) as {
      status: number;
      body: { type?: string; status?: number };
    };
    expect(terminal).toEqual({
      status: 404,
      body: expect.objectContaining({ type: PROBLEM_TYPES.NotFound, status: 404 }),
    });
  });

  it('DELETE is idempotent — a second DELETE on an already-closed session → 204, no error (W2820 #1)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;

    const first = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(first.statusCode).toBe(204);

    // Second DELETE on the already-'closed' row short-circuits to 204 WITHOUT re-closing
    // (which would clobber closedReason + emit a duplicate destroy audit + re-dispatch
    // sessionEnd). It must not 404 or 500.
    const second = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(second.statusCode).toBe(204);

    // The session is still readable + still closed (the idempotent path didn't error it out).
    const read = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json<{ status: string }>().status).toBe('closed');
  });

  it('five concurrent DELETEs all return 204 while exactly one close winner emits the destroy audit', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    const repo = fx.agentSessionsRepo!;
    const realGet = repo.get.bind(repo);
    const realClose = repo.closeWithReasonOutcome.bind(repo);
    const outcomeKinds: string[] = [];
    let preReads = 0;
    let releasePreReads!: () => void;
    const allPreReads = new Promise<void>((resolve) => {
      releasePreReads = resolve;
    });

    // Force every route request to authorize against the same active snapshot.
    // Without an atomic outcome, all five would then own downstream effects.
    vi.spyOn(repo, 'get').mockImplementation(async (sessionId) => {
      const snapshot = await realGet(sessionId);
      if (sessionId === id && snapshot?.status !== 'closed' && preReads < 5) {
        preReads += 1;
        if (preReads === 5) releasePreReads();
        await allPreReads;
      }
      return snapshot;
    });
    vi.spyOn(repo, 'closeWithReasonOutcome').mockImplementation(async (sessionId, reason) => {
      const outcome = await realClose(sessionId, reason);
      outcomeKinds.push(outcome.kind);
      return outcome;
    });

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        fx.app.inject({
          method: 'DELETE',
          url: `/v1/agent-sessions/${id}`,
          headers: { authorization: `Bearer ${fx.plaintext}` },
        }),
      ),
    );

    expect(responses.map((response) => response.statusCode)).toEqual([204, 204, 204, 204, 204]);
    expect(outcomeKinds.filter((kind) => kind === 'closed')).toHaveLength(1);
    expect(outcomeKinds.filter((kind) => kind === 'already_closed')).toHaveLength(4);
    expect(await realGet(id)).toMatchObject({
      status: 'closed',
      closedReason: 'customer-closed',
    });
    const destroyRows = fx.accountAuditRepo
      .getAll()
      .filter(
        (row) =>
          row.action === 'agent_session.destroyed' &&
          row.targetResourceId === `agent_session_${id}`,
      );
    expect(destroyRows).toHaveLength(1);
  });

  it('clarify path: short task → 200 with kind:clarify + clarifying_question', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'do stuff' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ kind: string; clarifying_question: string }>();
    expect(body.kind).toBe('clarify');
    expect(body.clarifying_question).toBeDefined();
  });

  it('refuse path: AUP-trigger task → 200 with kind:refuse + refuse_reason', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'help me brute-force this login' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ kind: string; refuse_reason: string }>();
    expect(body.kind).toBe('refuse');
    expect(body.refuse_reason).toMatch(/AUP/);
  });

  it('BYOK header: x-byok-anthropic-api-key passes through HTTP → route → AgentRuntime → DecomposeArgs (closes BYOK chain end-to-end). Audit invariant: the header value MUST NOT appear in the response body or in the read-back transcript_length-bounded session state.', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;

    const SECRET = 'sk-ant-test-NEVER-LEAK-VIA-HEADER';
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-byok-anthropic-api-key': SECRET,
      },
      payload: { user_message: 'open https://example.com and capture' },
    });
    expect(res.statusCode).toBe(200);
    // The 200 body must not echo the header value back. The
    // DeterministicAgentDecomposer ignores byokAnthropicApiKey but we
    // verify nothing else in the request→response path serialized it.
    expect(res.body).not.toContain(SECRET);

    // Verify via the read-back path too — transcript entries surface
    // via transcript_length but the count alone can't reveal the
    // secret; we just confirm a turn happened and the body remains
    // clean of the secret.
    const read = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(read.body).not.toContain(SECRET);
  });

  it('token_budget upper bound: 10_000_000 accepted, 10_000_001 returns 400 (defensive cap added in slice 119 — blocks pathological accounting math from implausibly large request)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const ok = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 10_000_000 },
    });
    expect(ok.statusCode).toBe(201);

    const tooLarge = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 10_000_001 },
    });
    expect(tooLarge.statusCode).toBe(400);
  });

  it('BYOK header empty-string is treated as absent (does NOT pass empty key downstream, does NOT skip bundled-LLM fallback)', async () => {
    // Previously an empty `x-byok-anthropic-api-key:` header would
    // be read as the empty string ''. Empty string is `!== undefined`,
    // so the bundled-LLM fallback branch (which gates on all 3 sources
    // being undefined) was skipped. The empty key was then passed
    // downstream where it 401s at Anthropic with a cryptic "invalid
    // API key" — a hostile UX far from the actual cause.
    //
    // Fix at apps/server/src/routes/agent-sessions.ts: normalise the
    // raw header to undefined when it's an empty string. This test
    // pins that normalisation by sending the header empty + asserting
    // the request still succeeds (DeterministicAgentDecomposer
    // ignores the BYOK key, so 200 = the route didn't fast-fail on
    // an "invalid empty key").
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        // Empty header value — would have been read as `""` before
        // the fix; now normalised to undefined.
        'x-byok-anthropic-api-key': '',
      },
      payload: { user_message: 'open https://example.com' },
    });
    // 200 = the route resolved a key (or skipped key requirement via
    // DeterministicAgentDecomposer). The load-bearing assertion is
    // "didn't 4xx with 'invalid API key' on an empty string".
    expect(res.statusCode).toBe(200);
  });

  it('not-found: GET on a never-existed id → 404 (NOT 503 — 503 is for activation-gate-off only)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/agent-sessions/agt_inmem_99999999',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('not-found: DELETE on a never-existed id → 404', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/agent-sessions/agt_inmem_99999999',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('not-found: POST /:id/message on a never-existed id → 404 (cross-account guard fires before runtime.runTurn)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_inmem_99999999/message',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'anything' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('SSE transcript stream: GET /:id/transcript on a non-owned/never-existed id → 404 from the ownership gate BEFORE the event-stream opens (cross-tenant-leak guard — a regression that subscribed/streamed before checking session.accountId === ctx.account.id would leak another tenant’s transcript)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/agent-sessions/agt_inmem_99999999/transcript',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    // The gate (`session === null || !callerCanAccessAgentSession(ctx, session.accountId)`)
    // throws NotFoundError BEFORE reply.raw.writeHead, so this is a normal
    // problem+json 404 — not an opened text/event-stream.
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type'] ?? '').not.toContain('text/event-stream');
    // Body carries the gate's own "AgentSession ... not found" message — this
    // distinguishes a GATE rejection (route registered, ownership enforced)
    // from a route-not-found 404 (which would prove nothing about the gate).
    expect(JSON.stringify(res.json())).toContain('AgentSession');
  });

  it('v2-#19 idempotency: POST /v1/agent-sessions with `Idempotency-Key` header replays the same 201 on retry (Stripe-pattern). Second call MUST NOT mint a new row — same id returned, transcript_length unchanged.', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });

    const first = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'idempotency-key': 'idem-test-v2-19',
      },
      payload: { token_budget: 25_000 },
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<{ id: string; token_budget_total: number; closed_at: null }>();
    expect(firstBody.id).toMatch(/^agt_inmem_/);
    expect(firstBody.closed_at).toBeNull();

    const second = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'idempotency-key': 'idem-test-v2-19',
      },
      // Even with a different body, the replay returns the original
      // record — that's the Stripe contract.
      payload: { token_budget: 999_999 },
    });
    expect(second.statusCode).toBe(201);
    const secondBody = second.json<{ id: string; token_budget_total: number }>();
    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.token_budget_total).toBe(firstBody.token_budget_total);
  });

  it('v2-#19 idempotency: POST without the header still mints a fresh row each call (header is opt-in, NOT default-on)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const a = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const b = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json<{ id: string }>().id).not.toBe(b.json<{ id: string }>().id);
  });

  it('v2-#19 idempotency: invalid `Idempotency-Key` (whitespace inside the value) returns 400 ValidationError per the /docs/idempotency-keys contract (added in slice 108 — shared parser now enforces the contract on this route, not just billing-crypto)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'idempotency-key': 'has space' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    // ValidationError stuffs the custom message into extensions.issues;
    // body.detail stays as the boilerplate "One or more fields failed
    // validation." (matches billing-crypto's invalid-key 400 behavior).
    const body = res.json<{ issues?: { formErrors?: string[] } }>();
    expect(body.issues?.formErrors).toBeDefined();
    expect(body.issues?.formErrors?.[0]).toMatch(/Idempotency-Key/);
  });

  it('v2-#19 idempotency: `Idempotency-Key` longer than 255 chars returns 400 (length-cap enforced post-slice-108)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'idempotency-key': 'a'.repeat(256) },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('v2-#19 idempotency: `Idempotency-Key` with non-ASCII bytes returns 400 (ASCII-only enforced post-slice-108)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'idempotency-key': 'kéy' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('v2-#19 idempotency: empty-string `Idempotency-Key` is treated as absent (stray proxy header MUST NOT collapse every session onto a phantom row)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const a = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'idempotency-key': '' },
      payload: {},
    });
    const b = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'idempotency-key': '' },
      payload: {},
    });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json<{ id: string }>().id).not.toBe(b.json<{ id: string }>().id);
  });

  it('v2-#35 created_by_user_id surfaces on the read shape — NULL today (account-scoped auth) but the field is always present so dashboard UI can wire against a stable schema', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(create.statusCode).toBe(201);
    const createBody = create.json<{ created_by_user_id: string | null }>();
    expect(createBody).toHaveProperty('created_by_user_id');
    // Account-scoped auth — no V-298 team-membership context yet, so
    // the field stays null. Schema-stable presence is the point.
    expect(createBody.created_by_user_id).toBeNull();

    const id = create.json<{ id: string }>().id;
    const read = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const readBody = read.json<{ created_by_user_id: string | null }>();
    expect(readBody).toHaveProperty('created_by_user_id');
    expect(readBody.created_by_user_id).toBeNull();
  });

  it("v2-#8 sub-slice 8.6 manual-mode pass-through — POST /:id/message in mode='manual' records actor='operator' transcript entry; returns kind:'logged-manual'; no token debit", async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'manual', token_budget: 10_000 },
    });
    const id = create.json<{ id: string }>().id;
    const msg = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'tap login button' },
    });
    expect(msg.statusCode).toBe(200);
    const body = msg.json<{ kind: string; session: { token_budget_remaining: number } }>();
    expect(body.kind).toBe('logged-manual');
    // No token debit on manual turns.
    expect(body.session.token_budget_remaining).toBe(10_000);

    // The transcript now has exactly one entry (the operator log).
    const read = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(read.json<{ transcript_length: number }>().transcript_length).toBe(1);
  });

  it("v2-#8 sub-slice 8.5 SDK mode parameter — POST body { mode: 'manual' } persists; GET echoes it back", async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'manual' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json<{ mode: string }>().mode).toBe('manual');
    const id = create.json<{ id: string }>().id;
    const read = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(read.json<{ mode: string }>().mode).toBe('manual');
  });

  it("v2-#8 sub-slice 8.5 default mode='ai' when omitted (backward-compat)", async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(create.json<{ mode: string }>().mode).toBe('ai');
  });

  it('v2-#8 sub-slice 8.5 invalid mode rejected with 400 (enum guard)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'autopilot' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('Slice 3 (Wave 29-NNN ARC 3) POST /:id/mode ai → pair → manual round-trip; pair_mode_state surfaces on GET; idempotent same-mode call preserves state', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(create.statusCode).toBe(201);
    const created = create.json<{
      id: string;
      mode: string;
      pair_mode_state: { kind: string } | null;
    }>();
    expect(created.mode).toBe('ai');
    expect(created.pair_mode_state).toBeNull();

    // ai → pair
    const toPair = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${created.id}/mode`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'pair' },
    });
    expect(toPair.statusCode).toBe(200);
    const pairBody = toPair.json<{ mode: string; pair_mode_state: { kind: string } | null }>();
    expect(pairBody.mode).toBe('pair');
    expect(pairBody.pair_mode_state).toEqual({ kind: 'ai-driving' });

    // GET round-trips the new mode + pair_mode_state.
    const read = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${created.id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(read.statusCode).toBe(200);
    const readBody = read.json<{ mode: string; pair_mode_state: { kind: string } | null }>();
    expect(readBody.mode).toBe('pair');
    expect(readBody.pair_mode_state).toEqual({ kind: 'ai-driving' });

    // idempotent pair → pair (same target).
    const idem = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${created.id}/mode`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'pair' },
    });
    expect(idem.statusCode).toBe(200);
    const idemBody = idem.json<{ mode: string; pair_mode_state: { kind: string } | null }>();
    expect(idemBody.mode).toBe('pair');
    // Idempotent path preserves whatever pair_mode_state the row had — here, still ai-driving.
    expect(idemBody.pair_mode_state).toEqual({ kind: 'ai-driving' });

    // pair → manual: clears state.
    const toManual = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${created.id}/mode`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'manual' },
    });
    expect(toManual.statusCode).toBe(200);
    const manualBody = toManual.json<{ mode: string; pair_mode_state: { kind: string } | null }>();
    expect(manualBody.mode).toBe('manual');
    expect(manualBody.pair_mode_state).toBeNull();
  });

  it('Slice 3 POST /:id/mode invalid body returns 400 ValidationError', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/mode`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'autopilot' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.ValidationFailed);
  });

  it('Slice 3 POST /:id/mode on a closed session returns 409 Conflict (mode can only change while active)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    await fx.app.inject({
      method: 'DELETE',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/mode`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'pair' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('Slice 3 POST /:id/mode on never-existed id returns 404 (cross-account guard rejects before setMode)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_inmem_99999999/mode',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'pair' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('Slice 4 (Wave 29-NNN ARC 3) POST /:id/input-event with mode=manual → 503 FeatureUnavailable (pre-harness; Mac fleet Swift work pending per Tier-3 Option A 2026-05-19)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'manual' },
    });
    const id = create.json<{ id: string }>().id;
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/input-event`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { event: { type: 'mouseMove', x: 100, y: 200 } },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });

  it('Slice 4 POST /:id/input-event on mode=ai session returns 409 ConflictError (mode-rejects-input-event)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    // Default mode is 'ai'; sending input-event should reject with 409
    // BEFORE the FeatureUnavailable 503 (mode guard fires first).
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/input-event`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { event: { type: 'mouseMove', x: 100, y: 200 } },
    });
    expect(res.statusCode).toBe(409);
  });

  it('Slice 4 POST /:id/input-event on closed session returns 409 Conflict (status guard fires before mode guard)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'manual' },
    });
    const id = create.json<{ id: string }>().id;
    await fx.app.inject({
      method: 'DELETE',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/input-event`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { event: { type: 'mouseMove', x: 100, y: 200 } },
    });
    expect(res.statusCode).toBe(409);
  });

  it('Slice 4 POST /:id/input-event with malformed event body returns 400 ValidationFailed', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'manual' },
    });
    const id = create.json<{ id: string }>().id;
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/input-event`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { event: { type: 'mouseDown', x: 100, y: 200, button: 5 } }, // button 5 not in [0,1,2]
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.ValidationFailed);
  });

  it('Slice 5 (Wave 29-NNN ARC 3) POST /:id/input-event on mode=pair + ai-driving fires takeover-request transition → 200 with kind:"pair-mode-takeover-fired" + pair_mode_state', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'pair' },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json<{ id: string; pair_mode_state: { kind: string } | null }>().id;
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/input-event`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        event: { type: 'mouseDown', x: 100, y: 200, button: 0 },
        client_id: 'cli_tab_a',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      kind: string;
      pair_mode_state: { kind: string; requestedByClientId?: string };
    }>();
    expect(body.kind).toBe('pair-mode-takeover-fired');
    expect(body.pair_mode_state.kind).toBe('takeover-pending');
    expect(body.pair_mode_state.requestedByClientId).toBe('cli_tab_a');
    // GET /:id should reflect the new pair_mode_state.
    const read = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(read.json<{ pair_mode_state: { kind: string } }>().pair_mode_state.kind).toBe(
      'takeover-pending',
    );
    // The input-event takeover MUST register a heartbeat (like the explicit
    // /takeover route) so the sweep can auto-revert a stalled takeover-pending.
    // Without it the session would be invisible to findStaleSessions and
    // stranded in takeover-pending forever. ttlMs:0 → any recorded entry counts.
    expect(
      fx.pairModeHeartbeatTracker.findStaleSessions({
        now: new Date(Date.now() + 60_000),
        ttlMs: 0,
      }),
    ).toContain(id);
  });

  it('Slice 5 POST /:id/input-event on mode=pair + ai-driving WITHOUT client_id → 400 ValidationFailed (client_id required for takeover-trigger)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'pair' },
    });
    const id = create.json<{ id: string }>().id;
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/input-event`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { event: { type: 'mouseMove', x: 100, y: 200 } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.ValidationFailed);
  });

  it('input-event takeover CAS preserves an already-committed sibling winner', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'pair' },
    });
    const id = create.json<{ id: string }>().id;
    const repo = fx.agentSessionsRepo!;
    const original = repo.compareAndSetPairModeState.bind(repo);
    const winner = {
      kind: 'takeover-pending',
      requestedByClientId: 'cli_winner',
      requestedAt: '2026-07-13T12:00:00.000Z',
    };
    vi.spyOn(repo, 'compareAndSetPairModeState').mockImplementationOnce(
      async (sessionId, expected, next) => {
        await repo.setPairModeState(sessionId, winner);
        return original(sessionId, expected, next);
      },
    );

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/input-event`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        event: { type: 'touchStart', x: 100, y: 200, touchId: 0 },
        client_id: 'cli_delayed',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ winner_client_id: string }>().winner_client_id).toBe('cli_winner');
    expect((await repo.get(id))?.pairModeState).toEqual(winner);
  });

  it('pair human-driving input requires the exact controlling client_id', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'pair' },
    });
    const id = create.json<{ id: string }>().id;
    await fx.agentSessionsRepo!.setPairModeState(id, {
      kind: 'human-driving',
      clientId: 'cli_owner',
      sinceAt: '2026-07-12T19:00:00.000Z',
    });
    const event = { type: 'mouseMove' as const, x: 100, y: 200 };

    const missing = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/input-event`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { event },
    });
    expect(missing.statusCode).toBe(400);

    const sibling = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/input-event`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { event, client_id: 'cli_sibling' },
    });
    expect(sibling.statusCode).toBe(409);
    expect(sibling.json<{ winner_client_id: string }>().winner_client_id).toBe('cli_owner');

    const heartbeat = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/input-event`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { event: { type: 'ping', timestamp: Date.now() }, client_id: 'cli_owner' },
    });
    expect(heartbeat.statusCode).toBe(200);
    expect(heartbeat.json<{ kind: string; duration_ms: number }>()).toEqual({
      kind: 'forwarded',
      duration_ms: 0,
    });
    expect(
      fx.pairModeHeartbeatTracker.findStaleSessions({
        now: new Date(Date.now() + 29_000),
        ttlMs: 30_000,
      }),
    ).not.toContain(id);

    const owner = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/input-event`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { event, client_id: 'cli_owner' },
    });
    expect(owner.statusCode).toBe(503); // auth/ownership passed; harness stub is next
  });

  it('Slice 5 POST /:id/input-event on mode=pair + takeover-pending → 409 Conflict (mid-transition; wait for settle)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'pair' },
    });
    const id = create.json<{ id: string }>().id;
    // First input-event fires takeover; second one in takeover-pending
    // is rejected.
    await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/input-event`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        event: { type: 'mouseDown', x: 50, y: 50, button: 0 },
        client_id: 'cli_tab_a',
      },
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/input-event`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        event: { type: 'mouseMove', x: 60, y: 60 },
        client_id: 'cli_tab_a',
      },
    });
    expect(res.statusCode).toBe(409);
  });

  it('Slice 4 POST /:id/input-event cross-account / unknown id → 404', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_inmem_99999999/input-event',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { event: { type: 'mouseMove', x: 0, y: 0 } },
    });
    expect(res.statusCode).toBe(404);
  });

  it('v2-#19 closed_at: NULL while active; ISO timestamp set on DELETE → close', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string; closed_at: string | null }>().id;
    expect(create.json<{ closed_at: string | null }>().closed_at).toBeNull();

    const close = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(close.statusCode).toBe(204);

    const read = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(read.statusCode).toBe(200);
    const body = read.json<{ closed_at: string | null; status: string }>();
    expect(body.status).toBe('closed');
    expect(body.closed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe('AI-D /v1/agent-sessions — driftstack_session_id strict FK (2026-06-16)', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('links an OWNED session (ses_<uuid>) → 201, response echoes the canonical ses_<uuid>', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const seeded = fx.sessionsRepo.seedSession({ accountId: fx.accountId, createdAt: new Date() });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, driftstack_session_id: `ses_${seeded.id}` },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ driftstack_session_id: string }>().driftstack_session_id).toBe(
      `ses_${seeded.id}`,
    );
  });

  it('also accepts a bare uuid (backward-compatible) for an owned session → 201', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const seeded = fx.sessionsRepo.seedSession({ accountId: fx.accountId, createdAt: new Date() });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, driftstack_session_id: seeded.id },
    });
    expect(res.statusCode).toBe(201);
  });

  it('404s on an UNKNOWN session id (never silently stores a dangling pointer)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        token_budget: 50_000,
        driftstack_session_id: 'ses_00000000-0000-4000-8000-0000000000ff',
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("CROSS-ACCOUNT: a session owned by ANOTHER account → 404 (not 201, not 403) — can't point at someone else's session", async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const foreign = fx.sessionsRepo.seedSession({
      accountId: '00000000-0000-4000-8000-0000000000aa',
      createdAt: new Date(),
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, driftstack_session_id: `ses_${foreign.id}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('400s on a malformed driftstack_session_id', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, driftstack_session_id: 'not-a-session' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// gui_control_key control-auth — the SEPARATE "Driftstack Simulator"
// macOS app can't read the main app's keychain, so it can't present an
// account API key. It presents the per-session gui_control_key in the
// `x-driftstack-gui-control-key` header instead. These pin the auth
// boundary the human reviewer reads line-by-line: a control key
// authorizes ONLY the one session it was minted for, grants NO
// account-wide access, and a missing/wrong/expired key 401s (never
// falls through to account data).
const GCK_HEADER = 'x-driftstack-gui-control-key';

describe('AI-D /v1/agent-sessions/* gui_control_key control-auth', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  /** Create an agent session in the given mode and return its id. */
  async function createSession(mode?: 'ai' | 'manual' | 'pair'): Promise<string> {
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, ...(mode !== undefined ? { mode } : {}) },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  }

  /** Mint (account-auth) the per-session gui_control_key plaintext. */
  async function mintKey(sessionId: string): Promise<string> {
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${sessionId}/gui-control-key`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ gui_control_key: string }>().gui_control_key;
  }

  it('control key reads its OWN session (GET /:id) — NO account Authorization header', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession();
    const key = await mintKey(id);
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
      headers: { [GCK_HEADER]: key },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ id: string }>().id).toBe(id);
  });

  it('control key sets the mode on its OWN session (POST /:id/mode) — NO account Authorization header', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession('ai');
    const key = await mintKey(id);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/mode`,
      headers: { [GCK_HEADER]: key },
      payload: { mode: 'manual' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ mode: string }>().mode).toBe('manual');
  });

  it('control key drives takeover on its OWN pair session — NO account Authorization header', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession('pair');
    const key = await mintKey(id);
    const takeover = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/takeover`,
      headers: { [GCK_HEADER]: key },
      payload: { client_id: 'sim_client_1' },
    });
    expect(takeover.statusCode).toBe(200);
  });

  it('control-key handback requires the exact human-driving controller', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession('pair');
    const key = await mintKey(id);
    // handback is only valid from human-driving; that state is reached
    // via a harness takeover-grant (not a customer route), so seed it
    // directly on the repo to exercise the handback auth path.
    const repo = fx.agentSessionsRepo;
    expect(repo).toBeDefined();
    await repo!.setPairModeState(id, {
      kind: 'human-driving',
      clientId: 'sim_client_1',
      sinceAt: new Date().toISOString(),
    });
    const missingOwner = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/handback`,
      headers: { [GCK_HEADER]: key },
      payload: {},
    });
    expect(missingOwner.statusCode).toBe(400);

    const sibling = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/handback`,
      headers: { [GCK_HEADER]: key },
      payload: { client_id: 'sim_client_2' },
    });
    expect(sibling.statusCode).toBe(409);
    expect(sibling.json<{ winner_client_id: string }>().winner_client_id).toBe('sim_client_1');

    const handback = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/handback`,
      headers: { [GCK_HEADER]: key },
      payload: { client_id: 'sim_client_1' },
    });
    expect(handback.statusCode).toBe(200);
  });

  it('handback CAS cannot resurrect pair state after a concurrent mode change', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession('pair');
    const repo = fx.agentSessionsRepo!;
    await repo.setPairModeState(id, {
      kind: 'human-driving',
      clientId: 'cli_owner',
      sinceAt: '2026-07-13T12:00:00.000Z',
    });
    const original = repo.compareAndSetPairModeState.bind(repo);
    vi.spyOn(repo, 'compareAndSetPairModeState').mockImplementationOnce(
      async (sessionId, expected, next) => {
        await repo.setMode(sessionId, 'manual', null);
        return original(sessionId, expected, next);
      },
    );

    const handback = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/handback`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { client_id: 'cli_owner' },
    });
    expect(handback.statusCode).toBe(409);
    expect(await repo.get(id)).toMatchObject({ mode: 'manual', pairModeState: null });
  });

  it('control key reaches the input-event route on its OWN session (auth passes; 503/409 is the harness/mode gate, NOT auth)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession('manual');
    const key = await mintKey(id);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/input-event`,
      headers: { [GCK_HEADER]: key },
      payload: { event: { type: 'mouseMove', x: 10, y: 20 } },
    });
    // Auth + ownership cleared; the pre-harness stub returns 503
    // FeatureUnavailable (NOT 401/404 — those would mean the control
    // key failed auth or ownership).
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(404);
    expect(res.statusCode).toBe(503);
  });

  it('control key sends a message on its OWN session (POST /:id/message) — NO account Authorization header', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession('ai');
    const key = await mintKey(id);
    // Deterministic runtime: a short task resolves to kind:'clarify'
    // (200) without any BYOK key. The point of this test is that the
    // control key alone authorizes the "tell the agent" composer.
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { [GCK_HEADER]: key },
      payload: { user_message: 'do stuff' },
    });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(404);
    expect(res.statusCode).toBe(200);
  });

  it('control key ENDS (DELETE /:id) its OWN session — NO account Authorization header; the window-close tears down the session', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession();
    const key = await mintKey(id);
    const del = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/agent-sessions/${id}`,
      headers: { [GCK_HEADER]: key },
    });
    expect(del.statusCode).toBe(204);
    // The session is now closed (account-auth read confirms the
    // control-key DELETE really tore it down).
    const read = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json<{ status: string }>().status).toBe('closed');
  });

  it('CRITICAL: a key minted for session A is REJECTED (401) on session B — the key authorizes ONLY its own session', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const idA = await createSession();
    const idB = await createSession();
    const keyA = await mintKey(idA);
    // GET B's read with A's key → 401 (decrypt of B's stored key never
    // equals A's plaintext). Never 200, never B's data.
    const readB = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${idB}`,
      headers: { [GCK_HEADER]: keyA },
    });
    expect(readB.statusCode).toBe(401);
    // And A's key can't change B's mode either.
    const modeB = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${idB}/mode`,
      headers: { [GCK_HEADER]: keyA },
      payload: { mode: 'manual' },
    });
    expect(modeB.statusCode).toBe(401);
  });

  it('P0: transplanting session A ciphertext onto session B cannot relocate A control authority', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const idA = await createSession();
    const idB = await createSession();
    const keyA = await mintKey(idA);
    const repo = fx.agentSessionsRepo!;
    const recA = await repo.get(idA);
    expect(recA?.guiControlKeyCiphertext).not.toBeNull();

    // Model a datastore-write attacker copying their known ciphertext into a
    // victim row. Before v2 AAD, this made keyA authorize session B.
    await repo.setGuiControlKey({
      id: idB,
      ciphertext: recA!.guiControlKeyCiphertext!,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const relocatedRead = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${idB}`,
      headers: { [GCK_HEADER]: keyA },
    });
    expect(relocatedRead.statusCode).toBe(401);

    // Only account auth may recover the mismatched record. It remints a key
    // bound to B, while A's key remains unusable on B.
    const recovered = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${idB}/gui-control-key`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(recovered.statusCode).toBe(200);
    const recoveredBody = recovered.json<{ gui_control_key: string; minted: boolean }>();
    expect(recoveredBody.minted).toBe(true);
    expect(recoveredBody.gui_control_key).not.toBe(keyA);

    const boundRead = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${idB}`,
      headers: { [GCK_HEADER]: recoveredBody.gui_control_key },
    });
    expect(boundRead.statusCode).toBe(200);
    expect(boundRead.json<{ id: string }>().id).toBe(idB);
  });

  it('CRITICAL (destructive): a key minted for session A can NOT DELETE session B — 401 (control-key DELETE is bound to its ONE session)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const idA = await createSession();
    const idB = await createSession();
    const keyA = await mintKey(idA);
    // A's key on B's DELETE → 401. B must NOT be torn down by A's key.
    const delB = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/agent-sessions/${idB}`,
      headers: { [GCK_HEADER]: keyA },
    });
    expect(delB.statusCode).toBe(401);
    // Confirm B is still alive (account-auth read → active, not closed).
    const readB = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${idB}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(readB.statusCode).toBe(200);
    expect(readB.json<{ status: string }>().status).toBe('active');
  });

  it('CRITICAL: a key minted for session A can NOT message session B — 401', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const idA = await createSession();
    const idB = await createSession();
    const keyA = await mintKey(idA);
    const msgB = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${idB}/message`,
      headers: { [GCK_HEADER]: keyA },
      payload: { user_message: 'do stuff' },
    });
    expect(msgB.statusCode).toBe(401);
  });

  it('CRITICAL: a WRONG / never-minted control key → 401 on DELETE and message (no fallthrough to account data)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession();
    await mintKey(id); // a real (different) key exists at rest
    const badDel = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/agent-sessions/${id}`,
      headers: { [GCK_HEADER]: 'gck_thisisnotthekeythisisnotthekey' },
    });
    expect(badDel.statusCode).toBe(401);
    const badMsg = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { [GCK_HEADER]: 'gck_thisisnotthekeythisisnotthekey' },
      payload: { user_message: 'do stuff' },
    });
    expect(badMsg.statusCode).toBe(401);
  });

  it('CRITICAL: an EXPIRED control key → 401 on DELETE and message (24h TTL enforced on the destructive + composer routes too)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession();
    const key = await mintKey(id);
    const repo = fx.agentSessionsRepo;
    expect(repo).toBeDefined();
    const rec = await repo!.get(id);
    expect(rec?.guiControlKeyCiphertext).not.toBeNull();
    await repo!.setGuiControlKey({
      id,
      ciphertext: rec!.guiControlKeyCiphertext!,
      expiresAt: new Date(Date.now() - 60_000), // 1 minute ago
    });
    const expDel = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/agent-sessions/${id}`,
      headers: { [GCK_HEADER]: key },
    });
    expect(expDel.statusCode).toBe(401);
    const expMsg = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { [GCK_HEADER]: key },
      payload: { user_message: 'do stuff' },
    });
    expect(expMsg.statusCode).toBe(401);
  });

  it('CRITICAL: a WRONG control-key value → 401 (no fallthrough to account data)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession();
    await mintKey(id); // mint so a real (different) key exists at rest
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
      headers: { [GCK_HEADER]: 'gck_thisisnotthekeythisisnotthekey' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('CRITICAL: a control key for a session whose key was NEVER minted → 401', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession(); // no mintKey → no key at rest
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
      headers: { [GCK_HEADER]: 'gck_somethingsomethingsomethingxx' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('CRITICAL: an EXPIRED control key → 401 (the 24h TTL is enforced)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession();
    const key = await mintKey(id);
    // Re-stamp the stored key's expiry into the PAST (the ciphertext
    // still decrypts to `key`, but it's expired). Requires the repo
    // handle the fixture exposes when the runtime is wired.
    const repo = fx.agentSessionsRepo;
    expect(repo).toBeDefined();
    const rec = await repo!.get(id);
    expect(rec?.guiControlKeyCiphertext).not.toBeNull();
    await repo!.setGuiControlKey({
      id,
      ciphertext: rec!.guiControlKeyCiphertext!,
      expiresAt: new Date(Date.now() - 60_000), // 1 minute ago
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
      headers: { [GCK_HEADER]: key },
    });
    expect(res.statusCode).toBe(401);
  });

  it('CRITICAL: the control key grants NO account-wide access — the account-scoped list route ignores it and 401s', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession();
    const key = await mintKey(id);
    // GET /v1/agent-sessions (account list) is NOT a control endpoint;
    // presenting the control key there must NOT authorize a
    // account-wide list — it falls to requireAuth and 401s with no
    // Authorization header.
    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/agent-sessions',
      headers: { [GCK_HEADER]: key },
    });
    expect(list.statusCode).toBe(401);
  });

  it('CROSS-ACCOUNT: a control key never authorizes against a DIFFERENT account’s session', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    // Account A session + key.
    const idA = await createSession();
    const keyA = await mintKey(idA);
    // Seed a foreign session id directly in the repo under another
    // account, mint+expire nothing — A's key must not validate.
    const repo = fx.agentSessionsRepo;
    expect(repo).toBeDefined();
    const foreign = await repo!.create({
      accountId: '00000000-0000-4000-8000-0000000000aa',
      tokenBudgetTotal: 50_000,
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${foreign.id}`,
      headers: { [GCK_HEADER]: keyA },
    });
    expect(res.statusCode).toBe(401);
  });

  it('the account path is UNCHANGED — account auth still reads/sets its own session', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession('ai');
    // GET with account auth (no control key) → 200.
    const read = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(read.statusCode).toBe(200);
    // Mode set with account auth → 200.
    const mode = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/mode`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'manual' },
    });
    expect(mode.statusCode).toBe(200);
  });

  it('the account path is UNCHANGED for message + DELETE — account auth still messages then ends its own session', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession('ai');
    // Message with account auth (no control key) → 200.
    const msg = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'do stuff' },
    });
    expect(msg.statusCode).toBe(200);
    // DELETE with account auth → 204.
    const del = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/agent-sessions/${id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(del.statusCode).toBe(204);
  });

  it('the account path still 401s with NO credentials at all (no control key, no Authorization)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession();
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
    });
    expect(res.statusCode).toBe(401);
  });
});

// doc-150 item 6 — the SAME per-account storage-quota gate that POST /v1/sessions
// enforces ALSO runs on POST /v1/agent-sessions when the create is profile-backed.
// Without it, an over-cap account could keep minting profile-backed agent sessions
// (each dispatch writes the R2 sealed blob → grows size_bytes) via this path,
// bypassing the gate that only /v1/sessions had. Mirrors the
// 'POST /v1/sessions storage quota (doc-150 item 6)' block in sessions.test.ts.
describe('POST /v1/agent-sessions storage quota (doc-150 item 6)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  // Create a profile via the API, then seed its sealed-store size directly on the
  // repo (the harness emits size_bytes post-save; recordSave is that path).
  async function createProfileWithSize(
    fixture: TestAppFixture,
    name: string,
    sizeBytes: number,
  ): Promise<string> {
    const res = await fixture.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fixture.plaintext}` },
      payload: { name },
    });
    if (res.statusCode !== 200)
      throw new Error(`profile create failed ${String(res.statusCode)}: ${res.body}`);
    const prefixed = res.json<{ id: string }>().id; // prof_<uuid>
    const bareId = prefixed.replace(/^prof_/, '');
    await fixture.profilesRepo.recordSave({
      id: bareId,
      accountId: fixture.accountId,
      at: new Date(),
      sizeBytes,
    });
    return prefixed;
  }

  // S42 2026-07-07 (founder-approved) — these quota tests run on solo_manual
  // (small tier cap) and now create with mode:'manual': the aiAgent tier gate
  // refuses ai/pair on solo_manual before the quota gate is ever reached, and
  // manual launches are exactly what this tier CAN run (the GUI profile-launch
  // path). The quota gate itself is mode-independent.
  it('409 storage_quota_exceeded when the account is at its hard cap + a profile is bound', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, tier: 'solo_manual' });
    const profileId = await createProfileWithSize(
      fx,
      'fat-profile',
      TIER_STORAGE_BYTES_CAP.solo_manual, // exactly at the cap → hard
    );
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, profile_id: profileId, mode: 'manual' },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json<Record<string, unknown>>();
    expect(body.type).toBe(PROBLEM_TYPES.StorageQuotaExceeded);
    expect(body.used_bytes).toBe(TIER_STORAGE_BYTES_CAP.solo_manual);
    expect(body.cap_bytes).toBe(TIER_STORAGE_BYTES_CAP.solo_manual);
  });

  it('201 when the account is UNDER the cap + a profile is bound', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, tier: 'solo_manual' });
    const profileId = await createProfileWithSize(fx, 'lean-profile', 1024);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, profile_id: profileId, mode: 'manual' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('201 for enterprise over its cap — enterprise is soft-only (no hard block)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, tier: 'enterprise' });
    const profileId = await createProfileWithSize(
      fx,
      'huge-profile',
      TIER_STORAGE_BYTES_CAP.enterprise + 1, // over the soft floor
    );
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, profile_id: profileId },
    });
    expect(res.statusCode).toBe(201);
  });

  it('201 with NO profile_id even when the account is over what would be its cap — no-profile is never gated', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, tier: 'solo_manual' });
    // A fat profile on the account, but the create binds NO profile → the quota
    // gate only applies to profile-backed launches, so it's never consulted.
    await createProfileWithSize(fx, 'fat-profile', TIER_STORAGE_BYTES_CAP.solo_manual);
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000, mode: 'manual' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('#79 idempotent retry REPLAYS the original 201 even after the account exceeds its storage cap (the quota gate must NOT re-run on a replay — idempotency always replays success)', async () => {
    // Regression for commit 9026682ce: the per-account storage-quota gate
    // (assertWithinStorageQuotaForLaunch) used to run BEFORE the idempotency
    // replay short-circuit, so a RETRY of an already-succeeded profile-backed
    // create newly 409'd once the account crossed its tier cap between calls —
    // a non-idempotent retry. The gate now sits AFTER the replay (beside the
    // proxy probe + active-session cap), so the retry replays the cached 201.
    fx = await buildTestApp({ enableAgentRuntime: true, tier: 'solo_manual' });
    const cap = TIER_STORAGE_BYTES_CAP.solo_manual;

    // 1. Seed the profile JUST UNDER the cap so the FIRST create passes the gate.
    const profileId = await createProfileWithSize(fx, 'borderline-profile', cap - 1);
    const bareId = profileId.replace(/^prof_/, '');

    // 2. First create with an Idempotency-Key → 201 (under cap). Capture the id.
    const key = 'idem-key-quota-replay-1';
    const first = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'idempotency-key': key },
      payload: { token_budget: 50_000, profile_id: profileId, mode: 'manual' },
    });
    expect(first.statusCode).toBe(201);
    const firstId = first.json<{ id: string }>().id;

    // 3. The account's aggregate size_bytes now crosses the cap (>= cap → hard
    //    block for any GENUINELY-NEW profile-backed create).
    await fx.profilesRepo.recordSave({
      id: bareId,
      accountId: fx.accountId,
      at: new Date(),
      sizeBytes: cap + 1,
    });

    // 4. Retry the SAME key + SAME profile → MUST replay the original 201 with the
    //    SAME id (pre-fix: this 409'd storage_quota_exceeded because the gate ran
    //    before the replay).
    const replay = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'idempotency-key': key },
      payload: { token_budget: 50_000, profile_id: profileId, mode: 'manual' },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json<{ id: string }>().id).toBe(firstId);
    // The replay did not mint a second session — exactly one active row.
    expect(await fx.agentSessionsRepo!.countActive(fx.accountId)).toBe(1);

    // 5. Sibling proof the gate STILL works for a genuinely-new create: a FRESH
    //    idempotency-key, same over-cap account → 409 (only the replay bypasses).
    const fresh = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'idempotency-key': 'idem-key-quota-replay-2-fresh',
      },
      payload: { token_budget: 50_000, profile_id: profileId, mode: 'manual' },
    });
    expect(fresh.statusCode).toBe(409);
    expect(fresh.json<{ type: string }>().type).toBe(PROBLEM_TYPES.StorageQuotaExceeded);
    // The rejected new create added no row — still exactly one active.
    expect(await fx.agentSessionsRepo!.countActive(fx.accountId)).toBe(1);
  });
});

// #122 — read:sessions floor on GET /v1/agent-sessions (list). This list
// route had NO scope gate at either the route OR repo layer (the repo's
// listPageByAccount is a pure data method), so any authenticated key —
// including a narrow write:sessions-only or gui_control key — could
// enumerate an account's full AI-session history. Now gated read:sessions
// at the route layer, mirroring the driver-session list route + the
// single-agent-session reads. The 3-way contract: (a) broad `read` passes,
// (b) granular read:sessions passes, (c) a different-resource granular
// scope (read:webhooks) is blocked with 403.
describe('#122 — read:sessions floor on GET /v1/agent-sessions (list)', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  const list = (fxArg: TestAppFixture) =>
    fxArg.app.inject({
      method: 'GET',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fxArg.plaintext}` },
    });

  it('403 for a write:sessions-only key, naming the required scope', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, scopes: ['write:sessions'] });
    const res = await list(fx);
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toContain('read:sessions');
  });

  it('403 for a cross-resource granular key (read:webhooks does NOT satisfy read:sessions)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, scopes: ['read:webhooks'] });
    const res = await list(fx);
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toContain('read:sessions');
  });

  it('200 for a granular read:sessions key', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, scopes: ['read:sessions'] });
    expect((await list(fx)).statusCode).toBe(200);
  });

  it('200 for a broad read key and an account_owner key (V-481)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, scopes: ['read'] });
    expect((await list(fx)).statusCode).toBe(200);
    await fx.cleanup();
    fx = await buildTestApp({ enableAgentRuntime: true, scopes: ['account_owner'] });
    expect((await list(fx)).statusCode).toBe(200);
  });
});

// Transcript entries include customer/operator free text and structured plans.
// Authentication alone is insufficient: a key scoped only to another resource
// must not become an account-wide transcript reader. Use a missing id so an
// authorized request terminates as a normal 404 before the SSE socket opens.
describe('read:sessions floor on GET /v1/agent-sessions/:id/transcript', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  const missingTranscript = (fxArg: TestAppFixture, queryToken = false) =>
    fxArg.app.inject({
      method: 'GET',
      url: queryToken
        ? `/v1/agent-sessions/agt_inmem_99999999/transcript?ds_token=${encodeURIComponent(fxArg.plaintext)}`
        : '/v1/agent-sessions/agt_inmem_99999999/transcript',
      ...(queryToken ? {} : { headers: { authorization: `Bearer ${fxArg.plaintext}` } }),
    });

  it.each(['read:webhooks', 'write:sessions'] as const)(
    '403 for unrelated/insufficient scope %s before opening SSE',
    async (scope) => {
      fx = await buildTestApp({ enableAgentRuntime: true, scopes: [scope] });
      const res = await missingTranscript(fx);
      expect(res.statusCode).toBe(403);
      expect(res.headers['content-type'] ?? '').not.toContain('text/event-stream');
      expect(res.json<{ detail: string }>().detail).toContain('read:sessions');
    },
  );

  it('applies the same scope floor to the EventSource ds_token fallback', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, scopes: ['read:webhooks'] });
    const res = await missingTranscript(fx, true);
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toContain('read:sessions');
  });

  it.each(['read:sessions', 'read', 'account_owner'] as const)(
    'allows scope %s through to the ownership/not-found gate',
    async (scope) => {
      fx = await buildTestApp({ enableAgentRuntime: true, scopes: [scope] });
      const res = await missingTranscript(fx);
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type'] ?? '').not.toContain('text/event-stream');
    },
  );
});
