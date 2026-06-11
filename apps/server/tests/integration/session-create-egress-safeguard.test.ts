// EG-API-1.4 — egress safeguard at API layer (defense-in-depth
// layer 1 of 3 per planning 133 §"Egress safeguard enforcement").
//
// When the sessionEgressService is wired in this deployment (which
// signals a SOCKS5/OpenVPN/WireGuard backend is reachable), POST
// /v1/sessions refuses any request body that lacks a `proxy` field.
// This enforces CLAUDE.md's non-negotiable "sessions cannot egress
// without proxy" at the API entry point, so the harness + WebKit
// fork layers don't have to be the only safety net.
//
// Posture verified here:
//   1. Default deployment (no backend wired) → session-create with no
//      proxy proceeds (current prod posture).
//   2. Wired deployment (sessionEgressService stub injected) →
//      session-create without proxy → 400 BadRequest with docs pointer.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

describe('EG-API-1.4 — egress safeguard at API layer', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('default posture (no backend wired): POST /v1/sessions with no proxy → 201 (current prod behavior preserved)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
  });

  it('wired posture: POST /v1/sessions without proxy → 400 BadRequest with planning-133 docs pointer', async () => {
    fx = await buildTestApp({ enableEgressSafeguard: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toMatch(/proxy configuration is required/);
    // 2026-05-20 — docs pointer landed on docs.driftstack.dev/api/sessions/
    // (egress section in the sessions reference) rather than a separate
    // /sessions/proxy page; matches the routes/sessions.ts source string.
    expect(body.detail).toMatch(/docs\.driftstack\.dev\/api\/sessions/);
  });

  it('wired posture: POST /v1/sessions WITH proxy → 201 (safeguard passes through to service)', async () => {
    fx = await buildTestApp({ enableEgressSafeguard: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        proxy: { type: 'socks5', socks5: { host: 'proxy.example.com', port: 1080 } },
      },
    });
    expect(res.statusCode).toBe(201);
  });

  // W615 — SESSION_PROXY_REQUIRED explicit override (founder verdict
  // 2026-06-11): self-hosted/testing deployments egress from the
  // operator's own machine, so a wired egress backend must not force a
  // proxy on every session. The override is tri-state; these pin the two
  // explicit states (the three tests above pin the inferred default).

  it('W615 wired + SESSION_PROXY_REQUIRED=false: POST /v1/sessions with no proxy → 201 (self-hosted posture)', async () => {
    fx = await buildTestApp({ enableEgressSafeguard: true, sessionProxyRequired: false });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
  });

  it('W615 NOT wired + SESSION_PROXY_REQUIRED=true: POST /v1/sessions with no proxy → 400 (force-required posture)', async () => {
    fx = await buildTestApp({ sessionProxyRequired: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ detail: string }>().detail).toMatch(/proxy configuration is required/);
  });
});
