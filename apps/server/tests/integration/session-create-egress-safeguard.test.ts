// Direct-session egress safety boundary. These routes have no typed proxy
// transport, so raw `proxy` is always rejected instead of being stripped and
// deployments that require egress disable the entire direct-create surface.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

describe('EG-API-1.4 — egress safeguard at API layer', () => {
  let fx: TestAppFixture;

  async function expectNoSessionRows(fixture: TestAppFixture): Promise<void> {
    const counts = await fixture.sessionsRepo.countAllByStatus();
    expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(0);
    expect(await fixture.sessionsRepo.listActiveByAccount(fixture.accountId)).toHaveLength(0);
  }

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

  it('default posture rejects an explicit raw proxy before creating a row or driver session', async () => {
    fx = await buildTestApp();
    const createSpy = vi.spyOn(fx.driver, 'createSession');
    const insertSpy = vi.spyOn(fx.sessionsRepo, 'insertSessionIfUnderLimit');
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { proxy: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ detail: string }>().detail).toMatch(
      /raw proxy field is not supported.*owned saved proxy_id/i,
    );
    expect(createSpy).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
    expect(fx.sessionsRepo.getEvents()).toHaveLength(0);
    await expectNoSessionRows(fx);
  });

  it('wired posture: POST /v1/sessions without proxy fails the whole direct surface closed', async () => {
    fx = await buildTestApp({ enableEgressSafeguard: true });
    const createSpy = vi.spyOn(fx.driver, 'createSession');
    const insertSpy = vi.spyOn(fx.sessionsRepo, 'insertSessionIfUnderLimit');
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toMatch(/Direct session creation is disabled/);
    expect(body.detail).toMatch(/owned saved proxy_id/);
    expect(createSpy).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
    expect(fx.sessionsRepo.getEvents()).toHaveLength(0);
    await expectNoSessionRows(fx);
  });

  it('wired posture cannot be bypassed by a valid-looking raw proxy shape', async () => {
    fx = await buildTestApp({ enableEgressSafeguard: true });
    const createSpy = vi.spyOn(fx.driver, 'createSession');
    const insertSpy = vi.spyOn(fx.sessionsRepo, 'insertSessionIfUnderLimit');
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        proxy: { type: 'socks5', socks5: { host: 'proxy.example.com', port: 1080 } },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ detail: string }>().detail).toMatch(/Direct session creation is disabled/);
    expect(createSpy).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
    expect(fx.sessionsRepo.getEvents()).toHaveLength(0);
    await expectNoSessionRows(fx);
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

  it('W615 NOT wired + SESSION_PROXY_REQUIRED=true disables direct creation', async () => {
    fx = await buildTestApp({ sessionProxyRequired: true });
    const createSpy = vi.spyOn(fx.driver, 'createSession');
    const insertSpy = vi.spyOn(fx.sessionsRepo, 'insertSessionIfUnderLimit');
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ detail: string }>().detail).toMatch(/Direct session creation is disabled/);
    expect(createSpy).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
    expect(fx.sessionsRepo.getEvents()).toHaveLength(0);
    await expectNoSessionRows(fx);
  });
});
