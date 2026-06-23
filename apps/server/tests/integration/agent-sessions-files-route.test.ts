// File-control (A3 W2851 / founder "control files") — integration tests for
// POST /v1/agent-sessions/:id/files (relay a customer file into the session's
// upload jail). Pins the discriminated body contract the GUI relies on (200 in
// every relay case, never an HTTP error for an expected-inert state), the gated
// 503, ownership 404, client-side 400s (empty body), and the live round-trip
// through the fleet control connection's UploadRequestCorrelator returning an
// OPAQUE handle. Mirrors the cookies route tests.

import { afterEach, describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

interface FilesBody {
  status: 'ok' | 'unavailable' | 'timeout' | 'error';
  handle: { id: string; name: string; mime: string; size: number } | null;
  reason?: string;
}

// "hello" → 5 bytes.
const UPLOAD_BODY = { name: 'doc.pdf', mime: 'application/pdf', dataB64: 'aGVsbG8=' };
const HANDLE = { id: 'up_abc123', name: 'doc.pdf', mime: 'application/pdf', size: 5 };

async function createSession(fx: TestAppFixture): Promise<string> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/agent-sessions',
    headers: { authorization: `Bearer ${fx.plaintext}` },
    payload: { token_budget: 50_000 },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

describe('POST /v1/agent-sessions/:id/files (activation gate off — runtime not wired)', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('→ 503 FeatureUnavailable (gated like the other agent-session routes, not a bare 404)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_xxx/files',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: UPLOAD_BODY,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });
});

describe('POST /v1/agent-sessions/:id/files (wired)', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('unknown/foreign session → 404 (never confirms another account’s session)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_00000000-0000-4000-8000-0000000000ff/files',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: UPLOAD_BODY,
    });
    expect(res.statusCode).toBe(404);
  });

  it('empty file (dataB64 decodes to 0 bytes) → 400 (client error, not a relay status)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/files`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { ...UPLOAD_BODY, dataB64: '==' }, // non-empty string, decodes to 0 bytes
    });
    expect(res.statusCode).toBe(400);
  });

  it('malformed body (missing name) → 422 ValidationFailed', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/files`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mime: 'application/pdf', dataB64: 'aGVsbG8=' },
    });
    expect([400, 422]).toContain(res.statusCode);
  });

  it('session with no assigned node → 200 { status:"unavailable", reason:"not live on a node" }', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/files`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: UPLOAD_BODY,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<FilesBody>();
    expect(body).toMatchObject({ status: 'unavailable', handle: null });
    expect(body.reason).toMatch(/not live on a node/);
  });

  it('node assigned but not connected → 200 { status:"unavailable", reason:"not connected" }', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    await fx.agentSessionsRepo!.setNodeId(id, 'node-not-connected');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/files`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: UPLOAD_BODY,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<FilesBody>();
    expect(body).toMatchObject({ status: 'unavailable', handle: null });
    expect(body.reason).toMatch(/not connected/);
  });

  it('connected node returns a handle → 200 { status:"ok", handle:{id,name,mime,size} }', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const nodeId = 'node-upload-1';
    await fx.agentSessionsRepo!.setNodeId(id, nodeId);
    // Register a node whose socket synchronously echoes an uploadResult for the
    // uploadFile the route sends — exactly what A3's harness will do live.
    const conn = fx.fleetControlRegistry.register(nodeId, (data) => {
      const frame = JSON.parse(data) as { type?: string; requestId?: string; sessionId?: string };
      if (frame.type === 'uploadFile') {
        conn.handleInbound(
          JSON.stringify({
            type: 'uploadResult',
            requestId: frame.requestId,
            sessionId: frame.sessionId,
            handle: HANDLE,
          }),
        );
      }
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/files`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: UPLOAD_BODY,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<FilesBody>();
    expect(body.status).toBe('ok');
    expect(body.handle).toEqual(HANDLE);
  });

  it('connected node reports an error → 200 { status:"error", reason }', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const nodeId = 'node-upload-err';
    await fx.agentSessionsRepo!.setNodeId(id, nodeId);
    const conn = fx.fleetControlRegistry.register(nodeId, (data) => {
      const frame = JSON.parse(data) as { type?: string; requestId?: string; sessionId?: string };
      if (frame.type === 'uploadFile') {
        conn.handleInbound(
          JSON.stringify({
            type: 'uploadResult',
            requestId: frame.requestId,
            sessionId: frame.sessionId,
            error: 'upload write failed',
          }),
        );
      }
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/files`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: UPLOAD_BODY,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<FilesBody>();
    expect(body).toMatchObject({ status: 'error', handle: null });
    expect(body.reason).toMatch(/write failed/);
  });
});

// The upload route mutates the session's jail, so its per-session gui_control_key
// boundary matters: a key authorizes ONLY the session it was minted for; a
// wrong/cross-session/missing key 401s. Mirrors the cookies route control-auth pins.
describe('POST /v1/agent-sessions/:id/files gui_control_key auth', () => {
  const GCK_HEADER = 'x-driftstack-gui-control-key';
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  async function mintKey(sessionId: string): Promise<string> {
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${sessionId}/gui-control-key`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ gui_control_key: string }>().gui_control_key;
  }

  it('a control key uploads to its OWN session (no account Authorization header)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const key = await mintKey(id);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/files`,
      headers: { [GCK_HEADER]: key },
      payload: UPLOAD_BODY,
    });
    // Authorized → reaches the handler → a discriminated 200 (unavailable here,
    // no node connected) rather than 401.
    expect(res.statusCode).toBe(200);
    expect(res.json<FilesBody>().status).toBe('unavailable');
  });

  it('a control key minted for session A is REJECTED on session B (401)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const idA = await createSession(fx);
    const idB = await createSession(fx);
    const keyA = await mintKey(idA);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${idB}/files`,
      headers: { [GCK_HEADER]: keyA },
      payload: UPLOAD_BODY,
    });
    expect(res.statusCode).toBe(401);
  });

  it('a missing/garbage control key with NO account auth 401s (never falls through)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/files`,
      headers: { [GCK_HEADER]: 'gck_not_a_real_key' },
      payload: UPLOAD_BODY,
    });
    expect(res.statusCode).toBe(401);
  });
});
