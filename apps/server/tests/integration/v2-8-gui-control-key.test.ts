// Arc 2 sub-slice 8.4 (v2-#8) — gui_control_key auto-mint integration.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

describe('Arc 2 v2-#8 sub-slice 8.4 GET /v1/agent-sessions/:id/gui-control-key', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('first GET mints fresh — returns plaintext + ISO expires_at + minted:true', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/gui-control-key`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ gui_control_key: string; expires_at: string; minted: boolean }>();
    expect(body.gui_control_key).toMatch(/^gck_[a-z2-7]+$/);
    expect(body.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.minted).toBe(true);
  });

  it('second GET within TTL returns the SAME plaintext + minted:false (idempotent within window)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    const r1 = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/gui-control-key`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const r2 = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/gui-control-key`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(r1.json<{ gui_control_key: string }>().gui_control_key).toBe(
      r2.json<{ gui_control_key: string }>().gui_control_key,
    );
    expect(r1.json<{ minted: boolean }>().minted).toBe(true);
    expect(r2.json<{ minted: boolean }>().minted).toBe(false);
  });

  it('cross-account guard — 404 when caller does not own the session', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/agent-sessions/agt_other_account_owned/gui-control-key',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
