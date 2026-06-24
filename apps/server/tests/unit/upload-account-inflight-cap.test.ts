// File-control (founder safeguard 2026-06-24) — integration tests for the
// PER-ACCOUNT concurrent in-flight upload cap on POST /v1/agent-sessions/:id/files.
//
// The route reserves an upload's DECODED byte count against a per-account
// `Map<accountId, number>` BEFORE relaying, rejects (without reserving) any
// upload that would push the account past its in-flight cap, and RELEASES the
// reservation in a `finally` regardless of relay outcome (ok / error / timeout /
// throw). These tests pin that accounting end-to-end through the HTTP layer:
//   1. under-cap upload succeeds (status:'ok' + handle),
//   2. an upload that would cross the cap while others are in flight is rejected
//      with status:'error' + the "account upload limit reached" reason AND is
//      never relayed (the conn mock is not invoked for it),
//   3. release-on-success — many same-size uploads after each completes succeed,
//   4. release-on-failure — after a relay error / handle-less result the bytes
//      are freed (the `finally` runs on every outcome),
//   5. per-account isolation — one account at the cap does not block another.
//
// The prod cap is 512 MB (config AGENT_UPLOAD_MAX_ACCOUNT_INFLIGHT_BYTES,
// defaulted in lib/config.ts). To avoid holding ~512 MB of buffers in CI, the
// cap is injectable: buildTestApp({ uploadMaxAccountInFlightBytes }) threads a
// TINY cap into AppDeps so we trip "over-cap" with KB-sized base64 payloads.
//
// Crossing the (tiny) cap still requires CONCURRENT uploads: we hold N × CHUNK
// bytes in flight (== exactly the cap) by making those relays HANG (the send
// callback never echoes an uploadResult), then a small probe upload tips it over.
//
// Reuses the same Fastify app-injection harness as the existing files-route
// integration test (buildTestApp + enableAgentRuntime + enableFleetControlPlane
// + a registered FleetControlRegistry connection whose socket-send callback we
// drive).

import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  seedAdditionalAccount,
  type TestAppFixture,
} from '../integration/_helpers/build-test-app.js';

interface FilesBody {
  status: 'ok' | 'unavailable' | 'timeout' | 'error';
  handle: { id: string; name: string; mime: string; size: number } | null;
  reason?: string;
}

// Tiny injected cap + chunk so we cross the boundary with KB payloads, never MB.
// Hardening (2026-06-24): the route now reserves the account's in-flight BYTE cap
// against the ENCODED (base64) length BEFORE decoding (so a copy is never
// materialised for an over-cap upload). The math below is therefore in ENCODED
// terms: CHUNK_ENCODED × CHUNKS_TO_FILL == CAP exactly → the filling uploads are
// all ACCEPTED (reserve, not reject), and one more tiny upload then tips it OVER.
const CHUNK_BYTES = 4 * 1024; // 4 KiB decoded per filling upload
const CHUNKS_TO_FILL = 3; // 3 filling uploads

// base64 payloads. Buffer.alloc(CHUNK_BYTES) decodes back to exactly CHUNK_BYTES.
const CHUNK_B64 = Buffer.alloc(CHUNK_BYTES, 0x41).toString('base64'); // decodes to exactly 4 KiB
const SMALL_B64 = Buffer.from('hello').toString('base64'); // "hello" → 5 bytes (tips a full account over)
// The cap is the ENCODED length of CHUNKS_TO_FILL filling uploads — exactly what
// the route reserves (dataB64.length) for those uploads, so they fill to the cap
// and a SMALL_B64 probe then crosses it.
const CAP_BYTES = CHUNK_B64.length * CHUNKS_TO_FILL; // injected per-account cap (encoded bytes)

const HANDLE_FOR = (
  name: string,
  size: number,
): { id: string; name: string; mime: string; size: number } => ({
  id: 'up_test',
  name,
  mime: 'application/octet-stream',
  size,
});

async function createSessionWith(fx: TestAppFixture, plaintext: string): Promise<string> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/agent-sessions',
    headers: { authorization: `Bearer ${plaintext}` },
    payload: { token_budget: 50_000 },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

function uploadBodyString(name: string, dataB64: string): string {
  return JSON.stringify({ name, mime: 'application/octet-stream', dataB64 });
}

function postUpload(
  fx: TestAppFixture,
  sessionId: string,
  plaintext: string,
  name: string,
  dataB64: string,
) {
  return fx.app.inject({
    method: 'POST',
    url: `/v1/agent-sessions/${sessionId}/files`,
    headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json' },
    payload: uploadBodyString(name, dataB64),
  });
}

/** Spin until `cond()` is true or the budget elapses (the event loop needs a few
 *  ticks for N concurrent handlers to each reach their reservation point). */
async function waitFor(cond: () => boolean, label: string, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`);
    await new Promise((r) => setImmediate(r));
  }
}

/** Register a node whose socket-send callback echoes an uploadResult for every
 *  uploadFile EXCEPT those named `hangName` (which stay pending → reservation
 *  stays live). For non-hang frames it returns either a handle (ok) or, when
 *  `errorFor(name)` returns a string, an error result. Records relayed names. */
function registerEchoNode(
  fx: TestAppFixture,
  nodeId: string,
  opts: {
    hangName?: string;
    relayed?: string[];
    errorFor?: (name: string) => string | null;
  } = {},
): void {
  const conn = fx.fleetControlRegistry.register(nodeId, (data) => {
    const f = JSON.parse(data) as {
      type?: string;
      requestId?: string;
      sessionId?: string;
      name?: string;
    };
    if (f.type !== 'uploadFile') return;
    const name = f.name ?? '';
    opts.relayed?.push(name);
    if (opts.hangName !== undefined && name === opts.hangName) return; // hang: never echo
    const err = opts.errorFor?.(name) ?? null;
    conn.handleInbound(
      JSON.stringify(
        err !== null
          ? { type: 'uploadResult', requestId: f.requestId, sessionId: f.sessionId, error: err }
          : {
              type: 'uploadResult',
              requestId: f.requestId,
              sessionId: f.sessionId,
              handle: HANDLE_FOR(name, CHUNK_BYTES),
            },
      ),
    );
  });
}

describe('POST /v1/agent-sessions/:id/files — per-account in-flight cap (injectable; prod 512 MB)', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('an upload under the cap succeeds (status:"ok" with a handle)', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableFleetControlPlane: true,
      uploadMaxAccountInFlightBytes: CAP_BYTES,
    });
    const id = await createSessionWith(fx, fx.plaintext);
    registerEchoNode(fx, 'node-cap-ok');
    await fx.agentSessionsRepo!.setNodeId(id, 'node-cap-ok');

    const res = await postUpload(fx, id, fx.plaintext, 'doc.bin', CHUNK_B64);
    expect(res.statusCode).toBe(200);
    const body = res.json<FilesBody>();
    expect(body.status).toBe('ok');
    expect(body.handle).toMatchObject({ id: 'up_test', name: 'doc.bin' });
  });

  it('rejects an upload that would cross the cap in flight (status:"error", never relayed)', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableFleetControlPlane: true,
      uploadMaxAccountInFlightBytes: CAP_BYTES,
    });
    const id = await createSessionWith(fx, fx.plaintext);
    const relayed: string[] = [];
    registerEchoNode(fx, 'node-cap-hang', { hangName: 'hang.bin', relayed });
    await fx.agentSessionsRepo!.setNodeId(id, 'node-cap-hang');

    // Fill the account to EXACTLY the cap with CHUNKS_TO_FILL hanging uploads.
    const hanging = Array.from({ length: CHUNKS_TO_FILL }, () =>
      postUpload(fx, id, fx.plaintext, 'hang.bin', CHUNK_B64),
    );
    await waitFor(
      () => relayed.filter((n) => n === 'hang.bin').length === CHUNKS_TO_FILL,
      'all filling uploads relayed',
    );

    // A tiny upload now crosses the boundary → rejected WITHOUT relay.
    const relayedBefore = relayed.length;
    const res = await postUpload(fx, id, fx.plaintext, 'overflow.bin', SMALL_B64);
    expect(res.statusCode).toBe(200);
    const body = res.json<FilesBody>();
    expect(body.status).toBe('error');
    expect(body.handle).toBeNull();
    expect(body.reason).toMatch(/account upload limit reached/i);
    // The rejected upload must NOT have been relayed to the node.
    expect(relayed.length).toBe(relayedBefore);
    expect(relayed).not.toContain('overflow.bin');

    // Settle the hanging uploads so app.close() in cleanup doesn't wait on them
    // (failAll resolves each pending relay with error → the route's finally releases).
    fx.fleetControlRegistry.get('node-cap-hang')!.close('test teardown');
    const settled = await Promise.all(hanging);
    for (const r of settled) {
      expect(r.statusCode).toBe(200);
      expect(r.json<FilesBody>().status).toBe('error');
    }
  });

  it('releases on SUCCESS — many sequential cap-filling uploads all succeed (cap not permanently consumed)', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableFleetControlPlane: true,
      uploadMaxAccountInFlightBytes: CAP_BYTES,
    });
    const id = await createSessionWith(fx, fx.plaintext);
    registerEchoNode(fx, 'node-release-ok');
    await fx.agentSessionsRepo!.setNodeId(id, 'node-release-ok');

    // Far more sequential CHUNK uploads than the cap (CHUNKS_TO_FILL) would
    // permit if bytes were never released on success. Every one must succeed.
    const SEQ_COUNT = CHUNKS_TO_FILL * 4; // 12 >> 3
    for (let i = 0; i < SEQ_COUNT; i += 1) {
      const res = await postUpload(fx, id, fx.plaintext, `seq-${i}.bin`, CHUNK_B64);
      expect(res.statusCode).toBe(200);
      expect(res.json<FilesBody>().status).toBe('ok');
    }
  });

  it('releases on FAILURE — after relay errors / handle-less results the bytes are freed (the finally runs on every outcome)', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableFleetControlPlane: true,
      uploadMaxAccountInFlightBytes: CAP_BYTES,
    });
    const id = await createSessionWith(fx, fx.plaintext);
    // 'fail.bin' → an explicit error result; everything else → a handle (ok).
    registerEchoNode(fx, 'node-release-fail', {
      errorFor: (name) => (name === 'fail.bin' ? 'upload write failed' : null),
    });
    await fx.agentSessionsRepo!.setNodeId(id, 'node-release-fail');

    // More FAILING cap-sized uploads than the cap would allow if a failed upload
    // didn't release its reservation. If the finally didn't release, the
    // (CHUNKS_TO_FILL+1)-th would be rejected at-cap; here every error is freed.
    for (let i = 0; i < CHUNKS_TO_FILL + 2; i += 1) {
      const res = await postUpload(fx, id, fx.plaintext, 'fail.bin', CHUNK_B64);
      expect(res.statusCode).toBe(200);
      const body = res.json<FilesBody>();
      expect(body.status).toBe('error');
      expect(body.reason).toMatch(/write failed/);
    }
    // Bytes were released on each failure → a fresh upload still succeeds.
    const ok = await postUpload(fx, id, fx.plaintext, 'after-fail.bin', CHUNK_B64);
    expect(ok.statusCode).toBe(200);
    expect(ok.json<FilesBody>().status).toBe('ok');

    // Also exercise release on the ERROR-RESULT-SHAPE the correlator derives from
    // a success-shaped result MISSING the handle ({status:'error'}). The route's
    // finally must release the same way (this is the shape the timeout branch
    // also relies on for release).
    const connMissing = fx.fleetControlRegistry.register('node-missing-handle', (data) => {
      const f = JSON.parse(data) as {
        type?: string;
        requestId?: string;
        sessionId?: string;
        name?: string;
      };
      if (f.type !== 'uploadFile') return;
      if (f.name === 'missing.bin') {
        // success-shaped, NO handle → correlator resolves {status:'error'}.
        connMissing.handleInbound(
          JSON.stringify({ type: 'uploadResult', requestId: f.requestId, sessionId: f.sessionId }),
        );
      } else {
        connMissing.handleInbound(
          JSON.stringify({
            type: 'uploadResult',
            requestId: f.requestId,
            sessionId: f.sessionId,
            handle: HANDLE_FOR(f.name ?? 'x', CHUNK_BYTES),
          }),
        );
      }
    });
    const id2 = await createSessionWith(fx, fx.plaintext);
    await fx.agentSessionsRepo!.setNodeId(id2, 'node-missing-handle');
    for (let i = 0; i < CHUNKS_TO_FILL + 2; i += 1) {
      const res = await postUpload(fx, id2, fx.plaintext, 'missing.bin', CHUNK_B64);
      expect(res.statusCode).toBe(200);
      expect(res.json<FilesBody>().status).toBe('error');
    }
    const ok2 = await postUpload(fx, id2, fx.plaintext, 'after-missing.bin', CHUNK_B64);
    expect(ok2.statusCode).toBe(200);
    expect(ok2.json<FilesBody>().status).toBe('ok');
  });

  it('per-account isolation — one account at the cap does not block a DIFFERENT account', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableFleetControlPlane: true,
      uploadMaxAccountInFlightBytes: CAP_BYTES,
    });
    const second = await seedAdditionalAccount(fx);

    // Account 1 (fx.plaintext) + account 2 sessions, both on the same node.
    const id1 = await createSessionWith(fx, fx.plaintext);
    const id2 = await createSessionWith(fx, second.plaintext);
    const relayed: string[] = [];
    registerEchoNode(fx, 'node-isolation', { hangName: 'hang.bin', relayed });
    await fx.agentSessionsRepo!.setNodeId(id1, 'node-isolation');
    await fx.agentSessionsRepo!.setNodeId(id2, 'node-isolation');

    // Saturate account 1 to exactly the cap with hanging uploads.
    const hanging = Array.from({ length: CHUNKS_TO_FILL }, () =>
      postUpload(fx, id1, fx.plaintext, 'hang.bin', CHUNK_B64),
    );
    await waitFor(
      () => relayed.filter((n) => n === 'hang.bin').length === CHUNKS_TO_FILL,
      'account-1 saturated',
    );

    // Account 1's next upload is rejected (at cap)…
    const blocked = await postUpload(fx, id1, fx.plaintext, 'overflow.bin', SMALL_B64);
    expect(blocked.json<FilesBody>().status).toBe('error');
    expect(blocked.json<FilesBody>().reason).toMatch(/account upload limit reached/i);

    // …while account 2 (a separate accountId) uploads fine.
    const other = await postUpload(fx, id2, second.plaintext, 'account2.bin', CHUNK_B64);
    expect(other.statusCode).toBe(200);
    expect(other.json<FilesBody>().status).toBe('ok');

    fx.fleetControlRegistry.get('node-isolation')!.close('test teardown');
    await Promise.all(hanging);
  });
});

// Hardening (2026-06-24, LOW defense-in-depth) — the per-account concurrent-upload
// COUNT cap, ALONGSIDE the byte cap. A flood of small uploads (well under the 512 MB
// byte cap) can still pin many correlator slots; this bounds the NUMBER of
// simultaneous upload relays. Injectable via uploadMaxAccountInFlightCount (prod 4).
describe('POST /v1/agent-sessions/:id/files — per-account concurrent-upload COUNT cap (injectable; prod 4)', () => {
  const COUNT_CAP = 2;
  // A byte cap large enough that the COUNT cap trips FIRST (so we exercise the
  // count branch in isolation, not the byte branch).
  const BIG_BYTE_CAP = 1024 * 1024 * 1024;
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('CAP concurrent uploads are accepted; the (CAP+1)-th is shed with the count reason (never relayed)', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableFleetControlPlane: true,
      uploadMaxAccountInFlightBytes: BIG_BYTE_CAP,
      uploadMaxAccountInFlightCount: COUNT_CAP,
    });
    const id = await createSessionWith(fx, fx.plaintext);
    const relayed: string[] = [];
    registerEchoNode(fx, 'node-count-hang', { hangName: 'hang.bin', relayed });
    await fx.agentSessionsRepo!.setNodeId(id, 'node-count-hang');

    // Fill to EXACTLY the count cap with small hanging uploads (tiny bytes → the
    // byte cap is nowhere near; only the count cap matters).
    const hanging = Array.from({ length: COUNT_CAP }, () =>
      postUpload(fx, id, fx.plaintext, 'hang.bin', SMALL_B64),
    );
    await waitFor(
      () => relayed.filter((n) => n === 'hang.bin').length === COUNT_CAP,
      'count-cap saturated',
    );

    const relayedBefore = relayed.length;
    const res = await postUpload(fx, id, fx.plaintext, 'overflow.bin', SMALL_B64);
    expect(res.statusCode).toBe(200);
    const body = res.json<FilesBody>();
    expect(body.status).toBe('error');
    expect(body.handle).toBeNull();
    // The COUNT-cap reason (distinct from the 512 MB byte-cap reason).
    expect(body.reason).toMatch(/too many concurrent uploads/i);
    expect(relayed.length).toBe(relayedBefore); // never relayed
    expect(relayed).not.toContain('overflow.bin');

    fx.fleetControlRegistry.get('node-count-hang')!.close('test teardown');
    await Promise.all(hanging);
  });

  it('releases on every outcome — far more sequential uploads than the count cap all succeed', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableFleetControlPlane: true,
      uploadMaxAccountInFlightBytes: BIG_BYTE_CAP,
      uploadMaxAccountInFlightCount: COUNT_CAP,
    });
    const id = await createSessionWith(fx, fx.plaintext);
    registerEchoNode(fx, 'node-count-release');
    await fx.agentSessionsRepo!.setNodeId(id, 'node-count-release');
    // Sequential: count peaks at 1 each time → the finally must release the count.
    for (let i = 0; i < COUNT_CAP * 4; i += 1) {
      const res = await postUpload(fx, id, fx.plaintext, `seq-${i}.bin`, CHUNK_B64);
      expect(res.statusCode).toBe(200);
      expect(res.json<FilesBody>().status).toBe('ok');
    }
  });
});
