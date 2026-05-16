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
    expect(body.detail).toMatch(/docs\.driftstack\.dev\/sessions\/proxy/);
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
});
