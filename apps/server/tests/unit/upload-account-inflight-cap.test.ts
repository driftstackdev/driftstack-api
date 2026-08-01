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
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { registerAgentSessionsRoutes } from '../../src/routes/agent-sessions.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import type { AgentRuntime } from '../../src/services/agent-runtime.js';
import type { FleetControlRegistry } from '../../src/services/fleet-control-registry.js';

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

// ---------------------------------------------------------------------------
// Security-audit hardening (2026-06-30, MEDIUM) — SESSION-LIFETIME upload cap.
//
// The CONCURRENT in-flight caps above (both describe blocks) bound in-flight
// volume/count at any instant, but RELEASE in the `finally` the moment EACH
// individual upload settles. That means a caller issuing uploads ONE AT A TIME
// — sequentially, never overlapping, never crossing the concurrent ceiling —
// could push UNBOUNDED total volume through a single session, bounded only by
// the generic 'global' rate limiter (as low as 1 req/s on free tier, still
// ~225 GB/hour at the 64 MiB per-file cap). Since multiple customers' sessions
// share one box's disk, this is a real cross-tenant disk-exhaustion vector.
//
// The route now also tracks a SEPARATE, NEVER-released, per-SESSION (not
// per-account — distinct from the cross-session per-account profile-storage
// quota in profile-storage-quota.ts) lifetime total, incremented only on a
// successful relay and checked before every upload. These tests pin that:
//   1. sequential (never-concurrent) uploads that individually clear the
//      concurrent cap still trip the LIFETIME BYTE cap,
//   2. many tiny sequential uploads trip the LIFETIME COUNT cap even while
//      nowhere near the byte cap,
//   3. the cap is scoped PER SESSION, not per account — a second session on
//      the SAME account has its own independent lifetime total,
//   4. a FAILED relay does not consume the lifetime total (only a successful
//      upload counts against it).
//
// The new cap is injected directly via AgentSessionsRoutesDeps
// (sessionUploadMaxLifetimeBytes/Count) — it isn't yet threaded through the
// app-level config/env chain, so these tests register the routes DIRECTLY
// (registerAgentSessionsRoutes + a real InMemoryAgentSessionsRepo + a minimal
// hand-rolled FleetControlRegistry-shaped stub) rather than the full
// buildTestApp() HTTP/DB harness — mirroring the same lightweight
// direct-registration pattern already used by
// tests/unit/agent-sessions-idempotency-race.test.ts.
// ---------------------------------------------------------------------------

const LIFETIME_ACC = 'acc_upload_lifetime';

interface LifetimeCapDeps {
  fleetControlRegistry?: FleetControlRegistry;
  sessionUploadMaxLifetimeBytes?: number;
  sessionUploadMaxLifetimeCount?: number;
  uploadMaxAccountInFlightBytes?: number;
  uploadMaxAccountInFlightCount?: number;
}

/** A minimal FleetControlRegistry-shaped stub: `get(nodeId)` resolves to a conn
 *  whose `requestUpload` either succeeds (echoing a fresh handle) or fails with
 *  a fixed message, and records every relayed file name — just enough surface
 *  for the upload route, cast `as unknown as FleetControlRegistry` the same way
 *  the idempotency-race test casts its repo mock (the real class has private
 *  fields, so a plain object can't structurally satisfy it). */
function makeUploadRegistry(
  nodeId: string,
  opts: { relayed?: string[]; fail?: boolean } = {},
): FleetControlRegistry {
  const conn = {
    requestUpload: (
      _requestId: string,
      _sessionId: string,
      name: string,
      mime: string,
      dataB64: string,
    ) => {
      opts.relayed?.push(name);
      if (opts.fail === true) {
        return Promise.resolve({ status: 'error' as const, message: 'upload write failed' });
      }
      return Promise.resolve({
        status: 'ok' as const,
        handle: { id: 'up_test', name, mime, size: Buffer.from(dataB64, 'base64').length },
      });
    },
  };
  return {
    get: (id: string) => (id === nodeId ? conn : undefined),
  } as unknown as FleetControlRegistry;
}

/** Registers the agent-sessions routes directly on a bare Fastify instance: a
 *  real InMemoryAgentSessionsRepo (so session create/get/setNodeId behave
 *  exactly as the driver repo does) + a no-op auth chain that stamps every
 *  request as LIFETIME_ACC (mirrors agent-sessions-idempotency-race.test.ts). */
async function buildDirectApp(extra: LifetimeCapDeps = {}) {
  const sessions = new InMemoryAgentSessionsRepo();
  const app = Fastify({ logger: false });
  app.decorateRequest('account', null);
  app.addHook('onRequest', (req: FastifyRequest, _reply: FastifyReply, done) => {
    (req as { account: unknown }).account = {
      account: { id: LIFETIME_ACC, tier: 'starter' },
      apiKey: { id: 'key_lifetime', scopes: ['read', 'write'] },
    };
    done();
  });
  app.decorate('requireAuth', () => Promise.resolve());
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());
  registerAgentSessionsRoutes(app, {
    runtime: {} as unknown as AgentRuntime,
    sessions,
    ...extra,
  });
  await app.ready();
  return { app, sessions };
}

// Inferred from buildDirectApp's own return (mirrors TestAppFixture's
// `Awaited<ReturnType<typeof buildApp>>` pattern in build-test-app.ts) rather
// than a hand-annotated `ReturnType<typeof Fastify>`, which resolves through
// Fastify's overloaded factory signature to a shape whose `inject(...).json()`
// isn't generic (TS2347 "untyped function calls may not accept type
// arguments") — inference from the actual call site keeps the real type.
type DirectFixture = Awaited<ReturnType<typeof buildDirectApp>>;

function postDirectUpload(fx: DirectFixture, sessionId: string, name: string, dataB64: string) {
  return fx.app.inject({
    method: 'POST',
    url: `/v1/agent-sessions/${sessionId}/files`,
    payload: { name, mime: 'application/octet-stream', dataB64 },
  });
}

describe('POST /v1/agent-sessions/:id/files — per-SESSION LIFETIME cap (independent of the concurrent caps)', () => {
  const LIFETIME_CHUNK_BYTES = 4 * 1024;
  const LIFETIME_CHUNK_B64 = Buffer.alloc(LIFETIME_CHUNK_BYTES, 0x42).toString('base64');
  const CHUNKS_TO_FILL = 3;
  const LIFETIME_CAP_BYTES = LIFETIME_CHUNK_B64.length * CHUNKS_TO_FILL;
  // Generous enough that the CONCURRENT byte/count caps never trip in these
  // tests — only the lifetime cap is under test.
  const HUGE_CONCURRENT_CAP_BYTES = 1024 * 1024 * 1024;
  const HUGE_CONCURRENT_CAP_COUNT = 10_000;

  let fx: DirectFixture;
  afterEach(async () => {
    if (fx) await fx.app.close();
  });

  it('rejects an upload that would cross the LIFETIME BYTE cap even though every upload is SEQUENTIAL and never approaches the concurrent cap', async () => {
    const nodeId = 'node-lifetime-bytes';
    const relayed: string[] = [];
    fx = await buildDirectApp({
      fleetControlRegistry: makeUploadRegistry(nodeId, { relayed }),
      sessionUploadMaxLifetimeBytes: LIFETIME_CAP_BYTES,
      uploadMaxAccountInFlightBytes: HUGE_CONCURRENT_CAP_BYTES,
      uploadMaxAccountInFlightCount: HUGE_CONCURRENT_CAP_COUNT,
    });
    const rec = await fx.sessions.create({ accountId: LIFETIME_ACC, tokenBudgetTotal: 50_000 });
    await fx.sessions.setNodeId(rec.id, nodeId);

    // Fill to EXACTLY the lifetime cap with CHUNKS_TO_FILL SEQUENTIAL uploads
    // (awaited one at a time — never concurrent, so the per-account concurrent
    // cap is never even approached). Every one must succeed.
    for (let i = 0; i < CHUNKS_TO_FILL; i += 1) {
      const res = await postDirectUpload(fx, rec.id, `fill-${i}.bin`, LIFETIME_CHUNK_B64);
      expect(res.statusCode).toBe(200);
      expect(res.json<FilesBody>().status).toBe('ok');
    }
    expect(relayed.length).toBe(CHUNKS_TO_FILL);

    // The NEXT upload crosses the session's lifetime total → rejected WITHOUT
    // relay, even though it's identical in shape to the ones that just succeeded
    // (proving this is a cumulative/lifetime check, not a concurrent one).
    const relayedBefore = relayed.length;
    const res = await postDirectUpload(fx, rec.id, 'overflow.bin', LIFETIME_CHUNK_B64);
    expect(res.statusCode).toBe(200);
    const body = res.json<FilesBody>();
    expect(body.status).toBe('error');
    expect(body.handle).toBeNull();
    expect(body.reason).toMatch(/session upload limit reached/i);
    expect(relayed.length).toBe(relayedBefore); // never relayed
    expect(relayed).not.toContain('overflow.bin');
  });

  it('rejects an upload that would cross the LIFETIME COUNT cap even though every upload is far under the byte cap', async () => {
    const nodeId = 'node-lifetime-count';
    const relayed: string[] = [];
    const COUNT_CAP = 3;
    const SMALL_B64 = Buffer.from('hi').toString('base64');
    fx = await buildDirectApp({
      fleetControlRegistry: makeUploadRegistry(nodeId, { relayed }),
      sessionUploadMaxLifetimeBytes: HUGE_CONCURRENT_CAP_BYTES,
      sessionUploadMaxLifetimeCount: COUNT_CAP,
      uploadMaxAccountInFlightBytes: HUGE_CONCURRENT_CAP_BYTES,
      uploadMaxAccountInFlightCount: HUGE_CONCURRENT_CAP_COUNT,
    });
    const rec = await fx.sessions.create({ accountId: LIFETIME_ACC, tokenBudgetTotal: 50_000 });
    await fx.sessions.setNodeId(rec.id, nodeId);

    for (let i = 0; i < COUNT_CAP; i += 1) {
      const res = await postDirectUpload(fx, rec.id, `tiny-${i}.bin`, SMALL_B64);
      expect(res.statusCode).toBe(200);
      expect(res.json<FilesBody>().status).toBe('ok');
    }
    const relayedBefore = relayed.length;
    const res = await postDirectUpload(fx, rec.id, 'tiny-overflow.bin', SMALL_B64);
    expect(res.statusCode).toBe(200);
    const body = res.json<FilesBody>();
    expect(body.status).toBe('error');
    expect(body.reason).toMatch(/too many files uploaded in this session/i);
    expect(relayed.length).toBe(relayedBefore); // never relayed
  });

  it('scopes the lifetime cap PER SESSION — a second session on the SAME account has its own independent total', async () => {
    const nodeId = 'node-lifetime-iso';
    const relayed: string[] = [];
    fx = await buildDirectApp({
      fleetControlRegistry: makeUploadRegistry(nodeId, { relayed }),
      sessionUploadMaxLifetimeBytes: LIFETIME_CAP_BYTES,
      uploadMaxAccountInFlightBytes: HUGE_CONCURRENT_CAP_BYTES,
      uploadMaxAccountInFlightCount: HUGE_CONCURRENT_CAP_COUNT,
    });
    const rec1 = await fx.sessions.create({ accountId: LIFETIME_ACC, tokenBudgetTotal: 50_000 });
    const rec2 = await fx.sessions.create({ accountId: LIFETIME_ACC, tokenBudgetTotal: 50_000 });
    await fx.sessions.setNodeId(rec1.id, nodeId);
    await fx.sessions.setNodeId(rec2.id, nodeId);

    // Saturate session 1 to exactly its lifetime cap.
    for (let i = 0; i < CHUNKS_TO_FILL; i += 1) {
      const res = await postDirectUpload(fx, rec1.id, `s1-${i}.bin`, LIFETIME_CHUNK_B64);
      expect(res.json<FilesBody>().status).toBe('ok');
    }
    // Session 1 is now at cap…
    const blocked = await postDirectUpload(fx, rec1.id, 's1-overflow.bin', LIFETIME_CHUNK_B64);
    expect(blocked.json<FilesBody>().status).toBe('error');

    // …but session 2 (SAME account) uploads the exact same volume fine — its
    // lifetime total is tracked independently of session 1's.
    const other = await postDirectUpload(fx, rec2.id, 's2-0.bin', LIFETIME_CHUNK_B64);
    expect(other.statusCode).toBe(200);
    expect(other.json<FilesBody>().status).toBe('ok');
  });

  it('a FAILED relay does not consume the lifetime total (only a SUCCESSFUL upload counts against it)', async () => {
    const nodeId = 'node-lifetime-fail';
    // `opts` is passed BY REFERENCE into the registry closure, so flipping
    // `opts.fail` after construction changes behaviour for subsequent calls on
    // the SAME registry/session — letting this test prove the failed uploads
    // below don't poison the SAME session's lifetime total for the successful
    // ones that follow (rather than merely asserting on a fresh session).
    const opts: { relayed: string[]; fail: boolean } = { relayed: [], fail: true };
    fx = await buildDirectApp({
      fleetControlRegistry: makeUploadRegistry(nodeId, opts),
      sessionUploadMaxLifetimeBytes: LIFETIME_CAP_BYTES,
      uploadMaxAccountInFlightBytes: HUGE_CONCURRENT_CAP_BYTES,
      uploadMaxAccountInFlightCount: HUGE_CONCURRENT_CAP_COUNT,
    });
    const rec = await fx.sessions.create({ accountId: LIFETIME_ACC, tokenBudgetTotal: 50_000 });
    await fx.sessions.setNodeId(rec.id, nodeId);

    // More FAILING cap-sized uploads than the lifetime cap would allow if a
    // failed relay consumed it.
    for (let i = 0; i < CHUNKS_TO_FILL + 2; i += 1) {
      const res = await postDirectUpload(fx, rec.id, 'fail.bin', LIFETIME_CHUNK_B64);
      expect(res.statusCode).toBe(200);
      const body = res.json<FilesBody>();
      expect(body.status).toBe('error');
      expect(body.reason).toMatch(/write failed/);
    }
    expect(opts.relayed.length).toBe(CHUNKS_TO_FILL + 2); // every failing attempt WAS relayed

    // The lifetime total is still 0 (nothing succeeded) → THIS SAME session can
    // still take a full cap-filling batch of REAL (succeeding) uploads.
    opts.fail = false;
    for (let i = 0; i < CHUNKS_TO_FILL; i += 1) {
      const res = await postDirectUpload(fx, rec.id, `ok-${i}.bin`, LIFETIME_CHUNK_B64);
      expect(res.json<FilesBody>().status).toBe('ok');
    }
  });
});

// V-721 — every lifetime test above is SEQUENTIAL, which is exactly why the cap
// looked enforced: with one upload in flight at a time, a read-modify-write
// cannot interleave with itself.
//
// The counters were read at admission but written back only AFTER
// `await conn.requestUpload(...)`. Every upload admitted while another was in
// flight therefore read the SAME pre-relay total and wrote back its own single
// increment, so a concurrent batch registered as ONE upload. Production allows
// UPLOAD_MAX_ACCOUNT_INFLIGHT_COUNT (4) in flight per account, so a caller
// keeping the pipeline full spent the 2 GiB / 500-file per-session ceiling at
// roughly a quarter rate — defeating the cap that exists precisely to backstop
// the concurrent caps against a caller who paces itself.
describe('POST /v1/agent-sessions/:id/files — the LIFETIME cap holds under CONCURRENT uploads', () => {
  const CHUNK_BYTES = 4 * 1024;
  const CHUNK_B64 = Buffer.alloc(CHUNK_BYTES, 0x42).toString('base64');
  const HUGE = 1024 * 1024 * 1024;
  const HUGE_COUNT = 10_000;

  let fx: DirectFixture;
  afterEach(async () => {
    if (fx) await fx.app.close();
  });

  /** A registry whose relays all block on `gate`, so a whole batch is genuinely
   *  in flight at once — the only condition under which the old
   *  read-modify-write could interleave. `entered` records which uploads
   *  actually reached the node, so the test can prove a shed request was
   *  refused BEFORE the relay rather than merely reported as an error. */
  function makeGatedUploadRegistry(
    nodeId: string,
    gate: Promise<void>,
    entered: string[],
  ): FleetControlRegistry {
    const conn = {
      requestUpload: async (
        _requestId: string,
        _sessionId: string,
        name: string,
        mime: string,
        dataB64: string,
      ) => {
        entered.push(name);
        await gate;
        return {
          status: 'ok' as const,
          handle: { id: 'up_test', name, mime, size: Buffer.from(dataB64, 'base64').length },
        };
      },
    };
    return {
      get: (id: string) => (id === nodeId ? conn : undefined),
    } as unknown as FleetControlRegistry;
  }

  it('admits at most the COUNT cap when the whole batch is in flight at once', async () => {
    const nodeId = 'node-lifetime-race-count';
    const entered: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    fx = await buildDirectApp({
      fleetControlRegistry: makeGatedUploadRegistry(nodeId, gate, entered),
      sessionUploadMaxLifetimeCount: 2,
      sessionUploadMaxLifetimeBytes: HUGE,
      uploadMaxAccountInFlightBytes: HUGE,
      uploadMaxAccountInFlightCount: HUGE_COUNT,
    });
    const rec = await fx.sessions.create({ accountId: LIFETIME_ACC, tokenBudgetTotal: 50_000 });
    await fx.sessions.setNodeId(rec.id, nodeId);

    // Fire three WITHOUT awaiting, so all are admitted before any relay settles.
    const inFlight = [0, 1, 2].map((i) => postDirectUpload(fx, rec.id, `race-${i}.bin`, CHUNK_B64));
    await new Promise((r) => setTimeout(r, 50));
    release();
    const bodies = (await Promise.all(inFlight)).map((r) => r.json<FilesBody>());

    expect(bodies.filter((b) => b.status === 'ok')).toHaveLength(2);
    const shed = bodies.filter((b) => b.status === 'error');
    expect(shed).toHaveLength(1);
    expect(shed[0]!.reason).toMatch(/too many files uploaded in this session/);
    // The shed upload must never have reached the node.
    expect(entered).toHaveLength(2);
  });

  it('admits at most the BYTE cap when the whole batch is in flight at once', async () => {
    const nodeId = 'node-lifetime-race-bytes';
    const entered: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    fx = await buildDirectApp({
      fleetControlRegistry: makeGatedUploadRegistry(nodeId, gate, entered),
      // Room for exactly two of these chunks. The reservation is taken on the
      // ENCODED length, same as the sequential tests above.
      sessionUploadMaxLifetimeBytes: CHUNK_B64.length * 2,
      sessionUploadMaxLifetimeCount: HUGE_COUNT,
      uploadMaxAccountInFlightBytes: HUGE,
      uploadMaxAccountInFlightCount: HUGE_COUNT,
    });
    const rec = await fx.sessions.create({ accountId: LIFETIME_ACC, tokenBudgetTotal: 50_000 });
    await fx.sessions.setNodeId(rec.id, nodeId);

    const inFlight = [0, 1, 2].map((i) =>
      postDirectUpload(fx, rec.id, `race-b-${i}.bin`, CHUNK_B64),
    );
    await new Promise((r) => setTimeout(r, 50));
    release();
    const bodies = (await Promise.all(inFlight)).map((r) => r.json<FilesBody>());

    expect(bodies.filter((b) => b.status === 'ok')).toHaveLength(2);
    const shed = bodies.filter((b) => b.status === 'error');
    expect(shed).toHaveLength(1);
    expect(shed[0]!.reason).toMatch(/at most 2 GiB of total uploads per session/);
    expect(entered).toHaveLength(2);
  });

  it('a concurrent batch that all FAIL gives the whole reservation back', async () => {
    // The reservation must not become a silent second cap: uploads that never
    // land in the jail have to release, exactly as they did when the counter
    // was only incremented on success.
    const nodeId = 'node-lifetime-race-rollback';
    const relayed: string[] = [];
    const opts: { relayed: string[]; fail: boolean } = { relayed, fail: true };
    fx = await buildDirectApp({
      fleetControlRegistry: makeUploadRegistry(nodeId, opts),
      sessionUploadMaxLifetimeCount: 3,
      sessionUploadMaxLifetimeBytes: HUGE,
      uploadMaxAccountInFlightBytes: HUGE,
      uploadMaxAccountInFlightCount: HUGE_COUNT,
    });
    const rec = await fx.sessions.create({ accountId: LIFETIME_ACC, tokenBudgetTotal: 50_000 });
    await fx.sessions.setNodeId(rec.id, nodeId);

    // Three concurrent FAILING uploads — a full cap's worth.
    const failed = await Promise.all(
      [0, 1, 2].map((i) => postDirectUpload(fx, rec.id, `bad-${i}.bin`, CHUNK_B64)),
    );
    for (const res of failed) expect(res.json<FilesBody>().status).toBe('error');

    // The session's allowance is untouched: a full cap of REAL uploads still fits.
    opts.fail = false;
    for (let i = 0; i < 3; i += 1) {
      const res = await postDirectUpload(fx, rec.id, `good-${i}.bin`, CHUNK_B64);
      expect(res.json<FilesBody>().status).toBe('ok');
    }
  });
});
