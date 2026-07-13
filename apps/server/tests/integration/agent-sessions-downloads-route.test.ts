// File-control download (A3 W2856 / founder "control files") — integration tests
// for GET /v1/agent-sessions/:id/downloads (list) + GET /:id/downloads/content?name=
// (fetch). Pins the discriminated body contract the GUI download bar relies on (200
// in every relay case, never an HTTP error for an expected-inert state), the gated
// 503, ownership 404, and the live round-trip through the connection's
// DownloadRequestCorrelator. Mirrors the cookies + files route tests.

import { afterEach, describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

interface ListBody {
  status: 'ok' | 'unavailable' | 'timeout' | 'error';
  files: { name: string; size: number; mime?: string }[] | null;
  reason?: string;
}
interface FetchBody {
  status: 'ok' | 'unavailable' | 'timeout' | 'error';
  file: { name: string; mime: string; dataB64: string } | null;
  reason?: string;
}

const FILES = [
  { name: 'report.pdf', size: 1024, mime: 'application/pdf' },
  { name: 'data.csv', size: 42 },
];
// "hello" → base64.
const DATA_B64 = 'aGVsbG8=';

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

/** Register a node whose socket echoes a downloadsList for listDownloads and a
 *  downloadData for fetchDownload — exactly what A3's harness will do live. */
function registerEchoNode(fx: TestAppFixture, nodeId: string): void {
  const conn = fx.fleetControlRegistry.register(nodeId, (data) => {
    const frame = JSON.parse(data) as {
      type?: string;
      requestId?: string;
      sessionId?: string;
      name?: string;
    };
    if (frame.type === 'listDownloads') {
      conn.handleInbound(
        JSON.stringify({
          type: 'downloadsList',
          requestId: frame.requestId,
          sessionId: frame.sessionId,
          files: FILES,
        }),
      );
    } else if (frame.type === 'fetchDownload') {
      conn.handleInbound(
        JSON.stringify({
          type: 'downloadData',
          requestId: frame.requestId,
          sessionId: frame.sessionId,
          name: frame.name,
          mime: 'application/pdf',
          dataB64: DATA_B64,
        }),
      );
    }
  });
}

async function waitFor(cond: () => boolean, label: string, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('GET /v1/agent-sessions/:id/downloads (activation gate off)', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('list → 503 FeatureUnavailable (gated, not a bare 404)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/agent-sessions/agt_xxx/downloads',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });

  it('fetch → 503 FeatureUnavailable', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/agent-sessions/agt_xxx/downloads/content?name=x.pdf',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(503);
  });
});

describe('GET /v1/agent-sessions/:id/downloads (wired)', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('unknown/foreign session → 404', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/agent-sessions/agt_00000000-0000-4000-8000-0000000000ff/downloads',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('session with no assigned node → 200 { status:"unavailable" }', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/downloads`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListBody>();
    expect(body).toMatchObject({ status: 'unavailable', files: null });
    expect(body.reason).toMatch(/not live on a node/);
  });

  it('connected node lists files → 200 { status:"ok", files:[…] }', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const nodeId = 'node-dl-1';
    await fx.agentSessionsRepo!.setNodeId(id, nodeId);
    registerEchoNode(fx, nodeId);
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/downloads`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListBody>();
    expect(body.status).toBe('ok');
    expect(body.files).toEqual(FILES);
  });

  it('connected node fetches one file → 200 { status:"ok", file:{name,mime,dataB64} }', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const nodeId = 'node-dl-2';
    await fx.agentSessionsRepo!.setNodeId(id, nodeId);
    registerEchoNode(fx, nodeId);
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/downloads/content?name=report.pdf`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<FetchBody>();
    expect(body.status).toBe('ok');
    expect(body.file).toEqual({ name: 'report.pdf', mime: 'application/pdf', dataB64: DATA_B64 });
  });

  it('format=binary returns the exact raw bytes without a base64 JSON envelope', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const nodeId = 'node-dl-binary';
    await fx.agentSessionsRepo!.setNodeId(id, nodeId);
    registerEchoNode(fx, nodeId);
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/downloads/content?name=report.pdf&format=binary`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/octet-stream/);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.rawPayload).toEqual(Buffer.from('hello'));
    expect(res.body).not.toContain(DATA_B64);
  });

  it('admits only one large download fetch per account and releases the slot on settle', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const nodeId = 'node-dl-account-memory-cap';
    const relayed: string[] = [];
    fx.fleetControlRegistry.register(nodeId, (data) => {
      const frame = JSON.parse(data) as { type?: string };
      if (frame.type !== undefined) relayed.push(frame.type);
      // Keep the first fetch pending so its account reservation remains held.
    });
    await fx.agentSessionsRepo!.setNodeId(id, nodeId);

    const first = fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/downloads/content?name=first.bin`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    await waitFor(
      () => relayed.filter((type) => type === 'fetchDownload').length === 1,
      'first download fetch relayed',
    );

    const second = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/downloads/content?name=second.bin`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<FetchBody>()).toMatchObject({
      status: 'error',
      file: null,
      reason: expect.stringMatching(/another file download is already in progress/i),
    });
    expect(relayed.filter((type) => type === 'fetchDownload')).toHaveLength(1);

    // Closing settles the correlator and runs the route's finally, which must
    // release both its ordinary relay slot and its dedicated large-fetch slot.
    fx.fleetControlRegistry.get(nodeId)!.close('test release');
    await first;

    const replacementNodeId = 'node-dl-account-memory-cap-replacement';
    await fx.agentSessionsRepo!.setNodeId(id, replacementNodeId);
    registerEchoNode(fx, replacementNodeId);
    const afterRelease = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/downloads/content?name=after.bin`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(afterRelease.statusCode).toBe(200);
    expect(afterRelease.json<FetchBody>().status).toBe('ok');
  });

  it('fetch with no ?name= → 400/422', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/downloads/content`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect([400, 422]).toContain(res.statusCode);
  });

  it('node reports an error → 200 { status:"error", reason }', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const nodeId = 'node-dl-err';
    await fx.agentSessionsRepo!.setNodeId(id, nodeId);
    const conn = fx.fleetControlRegistry.register(nodeId, (data) => {
      const frame = JSON.parse(data) as { type?: string; requestId?: string; sessionId?: string };
      if (frame.type === 'fetchDownload') {
        conn.handleInbound(
          JSON.stringify({
            type: 'downloadData',
            requestId: frame.requestId,
            sessionId: frame.sessionId,
            name: 'gone.pdf',
            error: 'file not found',
          }),
        );
      }
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/downloads/content?name=gone.pdf&format=binary`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<FetchBody>();
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(body).toMatchObject({ status: 'error', file: null });
    expect(body.reason).toMatch(/not found/);
  });
});

describe('GET /v1/agent-sessions/:id/downloads gui_control_key auth', () => {
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

  it('a control key lists its OWN session (no account header) → reaches handler (200)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const key = await mintKey(id);
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/downloads`,
      headers: { [GCK_HEADER]: key },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<ListBody>().status).toBe('unavailable');
  });

  it('a control key minted for session A is REJECTED on session B (401)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const idA = await createSession(fx);
    const idB = await createSession(fx);
    const keyA = await mintKey(idA);
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${idB}/downloads`,
      headers: { [GCK_HEADER]: keyA },
    });
    expect(res.statusCode).toBe(401);
  });
});
