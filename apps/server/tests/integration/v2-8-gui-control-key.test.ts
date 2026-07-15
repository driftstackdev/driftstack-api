// Arc 2 sub-slice 8.4 (v2-#8) — gui_control_key auto-mint integration.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7);

function encryptLegacyUnbound(plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', TEST_ENCRYPTION_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

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

  it('closed sessions reject an existing-key echo without returning the credential', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    const minted = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/gui-control-key`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(minted.statusCode).toBe(200);
    expect(minted.json<{ gui_control_key: string }>().gui_control_key).toMatch(/^gck_/);

    await fx.agentSessionsRepo!.closeWithReason(id, 'customer-closed');
    const rejected = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/gui-control-key`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json<Record<string, unknown>>()).not.toHaveProperty('gui_control_key');
  });

  it('a close winner during mint returns 409 and never discloses or persists the generated key', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    const repo = fx.agentSessionsRepo!;
    const original = repo.setGuiControlKeyIfActive.bind(repo);
    vi.spyOn(repo, 'setGuiControlKeyIfActive').mockImplementationOnce(async (args) => {
      await repo.closeWithReason(args.id, 'customer-closed');
      return original(args);
    });

    const rejected = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/gui-control-key`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json<Record<string, unknown>>()).not.toHaveProperty('gui_control_key');
    expect(await repo.get(id)).toMatchObject({
      status: 'closed',
      closedReason: 'customer-closed',
      guiControlKeyCiphertext: null,
      guiControlKeyExpiresAt: null,
    });
  });

  it('account-authenticated GET replaces a non-expired legacy unbound key, then remains idempotent', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    const legacyPlaintext = 'gck_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    await fx.agentSessionsRepo!.setGuiControlKey({
      id,
      ciphertext: encryptLegacyUnbound(legacyPlaintext),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const rejectedLegacy = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
      headers: { 'x-driftstack-gui-control-key': legacyPlaintext },
    });
    expect(rejectedLegacy.statusCode).toBe(401);

    const recovered = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/gui-control-key`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(recovered.statusCode).toBe(200);
    const recoveredBody = recovered.json<{
      gui_control_key: string;
      expires_at: string;
      minted: boolean;
    }>();
    expect(recoveredBody.minted).toBe(true);
    expect(recoveredBody.gui_control_key).not.toBe(legacyPlaintext);

    const echo = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/gui-control-key`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(echo.statusCode).toBe(200);
    expect(echo.json<{ gui_control_key: string; minted: boolean }>()).toMatchObject({
      gui_control_key: recoveredBody.gui_control_key,
      minted: false,
    });
  });

  it('account-authenticated GET replaces a corrupt non-expired blob instead of returning 500', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    await fx.agentSessionsRepo!.setGuiControlKey({
      id,
      ciphertext: Buffer.alloc(64, 0),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const recovered = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/gui-control-key`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json<{ gui_control_key: string; minted: boolean }>()).toMatchObject({
      minted: true,
    });
    expect(recovered.json<{ gui_control_key: string }>().gui_control_key).toMatch(
      /^gck_[a-z2-7]{32}$/,
    );
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
