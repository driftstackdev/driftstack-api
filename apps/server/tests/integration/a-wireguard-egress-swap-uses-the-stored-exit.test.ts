// (n) N14 — POST /v1/agent-sessions/:id/egress onto a WireGuard proxy. The swap
// needs an exit identity to hand the node (the device shows it in its new-tab IP
// panel and spoofs geolocation from it). For a socks5 row that identity comes
// from the exit-identity CACHE the pre-launch probe warms. For a VPN row the
// pre-launch probe returns BEFORE dialling (the control plane cannot bring a
// tunnel up), so the cache is never warm — and the swap used to answer
// `unavailable — run POST /v1/account/me/proxies/:id/test first`, an instruction
// /test cannot satisfy for that scheme. A VPN row's exit lives on the ROW
// (`exitObserved`, written by the fleet-vantage Check and by a live session), so
// the swap reads it from there.
//
// Guard reasoning: reverting the `storedVpnExitAsSwapIdentity` fallback in
// agent-sessions.ts (back to `if (hit === undefined) return unavailable`) makes
// the CRITICAL arm's `status` read `unavailable` and `framesSent` read 0 — both
// assertions red. Reverting only the scheme-aware REASON keeps the arm green but
// reds the control arm that pins the WireGuard sentence.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

interface EgressBody {
  status: 'ok' | 'unavailable' | 'timeout' | 'error';
  apply_point?: 'next_navigation' | 'immediate' | null;
  reason?: string;
}

let fx: TestAppFixture;
afterEach(async () => {
  if (fx) await fx.cleanup();
});

const WG_PRIV = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
const WG_PUB = 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=';
const OBSERVED_AT = new Date('2026-09-01T00:00:00Z');
const STORED_EXIT = {
  ip: '203.0.113.9',
  country: 'NL',
  timezone: 'Europe/Amsterdam',
  observed_via: 'probe' as const,
};

/** A probe that connects but measures NO exit — so the cache is never the source
 *  of an identity in this file; only the row can be. */
const probeStub = (): never =>
  ({
    probe: () => Promise.resolve({ ok: true }),
    observeOs: () => Promise.resolve(undefined),
  }) as unknown as never;

async function createSession(): Promise<string> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/agent-sessions',
    headers: { authorization: `Bearer ${fx.plaintext}` },
    payload: { token_budget: 50_000 },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
}

async function createWireGuardProxy(): Promise<string> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/account/me/proxies',
    headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
    payload: {
      label: 'wg',
      scheme: 'wireguard',
      host: 'vpn.example.com',
      port: 51820,
      wireguard: {
        private_key: WG_PRIV,
        peer_public_key: WG_PUB,
        endpoint: 'vpn.example.com:51820',
        allowed_ips: '0.0.0.0/0',
        address: '10.7.0.2/32',
      },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
}

async function createSocksProxy(): Promise<string> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/account/me/proxies',
    headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
    payload: { label: 'socks', host: 'proxy.example.net', port: 1080 },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
}

async function seedExit(
  id: string,
  exit: typeof STORED_EXIT | { ip: string; country: null; timezone: string; observed_via: 'probe' },
  supersededAt: Date | null = null,
): Promise<void> {
  await fx.accountProxiesRepo.update({
    id,
    accountId: fx.accountId,
    updates: { exitObserved: exit, exitObservedAt: OBSERVED_AT, exitSupersededAt: supersededAt },
  });
}

/** One live node per app: records every setEgress frame and confirms it. */
function registerConfirmingNode(nodeId: string): {
  frames: Array<Record<string, unknown>>;
} {
  const frames: Array<Record<string, unknown>> = [];
  const conn = fx.fleetControlRegistry.register(nodeId, (data) => {
    const frame = JSON.parse(data) as Record<string, unknown>;
    if (frame.type !== 'setEgress') return;
    frames.push(frame);
    conn.handleInbound(
      JSON.stringify({
        type: 'setEgressResult',
        requestId: frame.requestId,
        sessionId: frame.sessionId,
        ok: true,
        applyPoint: 'next_navigation',
      }),
    );
  });
  return { frames };
}

async function swap(sessionId: string, proxyId: string): Promise<EgressBody> {
  const res = await fx.app.inject({
    method: 'POST',
    url: `/v1/agent-sessions/${sessionId}/egress`,
    headers: { authorization: `Bearer ${fx.plaintext}` },
    payload: { proxy_id: proxyId },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<EgressBody>();
}

async function liveApp(): Promise<void> {
  fx = await buildTestApp({
    enableAgentRuntime: true,
    enableFleetControlPlane: true,
    midSessionEgressEnabled: true, // exercise the relay path; production default is false
    proxyConnectivityProbe: probeStub(),
  });
}

describe('POST /v1/agent-sessions/:id/egress onto a WireGuard proxy (mid-session egress enabled)', () => {
  it('CRITICAL a wireguard proxy whose Check observed an exit swaps OK — the wire carries the STORED exit, dated by the observation', async () => {
    await liveApp();
    const sessionId = await createSession();
    const proxyId = await createWireGuardProxy();
    await seedExit(proxyId, STORED_EXIT);
    const nodeId = 'node-wg-swap-ok';
    await fx.agentSessionsRepo!.setNodeId(sessionId, nodeId);
    const { frames } = registerConfirmingNode(nodeId);
    const body = await swap(sessionId, proxyId);
    expect(body.status, JSON.stringify(body)).toBe('ok');
    expect(body.apply_point).toBe('next_navigation');
    expect(frames).toHaveLength(1);
    const identity = frames[0]!.exitIdentity as Record<string, unknown>;
    expect(identity.ip).toBe(STORED_EXIT.ip);
    expect(identity.country).toBe('NL');
    expect(identity.timezone).toBe(STORED_EXIT.timezone);
    // A tunnel carries UDP by nature — the same rule the cache path applies.
    expect(identity.quic_ok).toBe(true);
    // The observation's OWN date, never the reply time.
    expect(identity.probed_at).toBe(OBSERVED_AT.toISOString());
  });

  it('CONTROL — a wireguard proxy with NO observed exit is unavailable, and the instruction names the fleet Check (never the socks5 "/test first")', async () => {
    await liveApp();
    const sessionId = await createSession();
    const proxyId = await createWireGuardProxy();
    const nodeId = 'node-wg-swap-no-exit';
    await fx.agentSessionsRepo!.setNodeId(sessionId, nodeId);
    const { frames } = registerConfirmingNode(nodeId);
    const body = await swap(sessionId, proxyId);
    expect(body.status).toBe('unavailable');
    expect(body.reason).toMatch(/WireGuard/);
    expect(body.reason).toMatch(/vantage=fleet/);
    expect(body.reason).not.toMatch(/\/test first/);
    // Nothing was sent to the device — no invented identity.
    expect(frames).toHaveLength(0);
  });

  it('CRITICAL a stored exit the last Check CONTRADICTED (exit_superseded_at set) is refused — the swap never hands the device an exit behind a tunnel found down', async () => {
    await liveApp();
    const sessionId = await createSession();
    const proxyId = await createWireGuardProxy();
    await seedExit(proxyId, STORED_EXIT, new Date('2026-09-02T00:00:00Z'));
    const nodeId = 'node-wg-swap-superseded';
    await fx.agentSessionsRepo!.setNodeId(sessionId, nodeId);
    const { frames } = registerConfirmingNode(nodeId);
    const body = await swap(sessionId, proxyId);
    expect(body.status).toBe('unavailable');
    expect(body.reason).toMatch(/WireGuard/);
    expect(frames).toHaveLength(0);
  });

  it('a stored exit with NO country cannot cross the wire (the identity requires one) — refused, not sent malformed', async () => {
    await liveApp();
    const sessionId = await createSession();
    const proxyId = await createWireGuardProxy();
    await seedExit(proxyId, {
      ip: '203.0.113.9',
      country: null,
      timezone: 'Europe/Amsterdam',
      observed_via: 'probe',
    });
    const nodeId = 'node-wg-swap-no-country';
    await fx.agentSessionsRepo!.setNodeId(sessionId, nodeId);
    const { frames } = registerConfirmingNode(nodeId);
    const body = await swap(sessionId, proxyId);
    expect(body.status).toBe('unavailable');
    expect(frames).toHaveLength(0);
  });

  it('CONTROL — a socks5 proxy still reads the CACHE only: a stored row exit does not stand in for an unprobed socks5 exit', async () => {
    await liveApp();
    const sessionId = await createSession();
    const proxyId = await createSocksProxy();
    await seedExit(proxyId, STORED_EXIT);
    const nodeId = 'node-socks-swap-no-cache';
    await fx.agentSessionsRepo!.setNodeId(sessionId, nodeId);
    const { frames } = registerConfirmingNode(nodeId);
    const body = await swap(sessionId, proxyId);
    expect(body.status).toBe('unavailable');
    expect(body.reason).toMatch(/exit identity/);
    expect(body.reason).toMatch(/\/test first/);
    expect(frames).toHaveLength(0);
  });
});
