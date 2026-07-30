// V-820 — live WebSocket integration test for /v1/fleet/events.
//
// Unlike the other fleet-events integration tests (which exercise the
// 503 disabled stub via app.inject), this one wires the control-plane
// deps (enableFleetControlPlane) so the REAL handler registers, then
// drives it over a genuine WebSocket: light-my-request / inject can't
// perform an HTTP upgrade, so the app actually listens on an ephemeral
// port and a `ws` client connects.
//
// Covered end-to-end (the layers inject can't reach):
//   - upgrade auth: a node-signed Ed25519 Bearer JWT + matching
//     X-Driftstack-Mac-Node-Id header → the socket opens + the node
//     registers in the FleetControlRegistry; close → it unregisters.
//   - the full dispatch round-trip: server dispatches an IntentDispatch
//     down the socket → the client receives the flat {type:...} frame →
//     replies with an intentResult → the server's dispatch() promise
//     resolves with the parsed result (proves schema↔codec↔correlator↔
//     registry↔WS route are wired together correctly).
//   - rejection: an unknown-node JWT and a missing node-id header are
//     both refused at the upgrade with HTTP 401 (the socket never opens).

import { webcrypto } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { FLEET_INBOUND_LARGE_FRAME_THRESHOLD_BYTES } from '../../src/services/fleet-inbound-frame-gate.js';
import { FLEET_WS_MAX_BUFFERED_BYTES } from '../../src/routes/fleet-events.js';

const subtle = webcrypto.subtle;

function base64UrlFromBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
function base64UrlFromString(s: string): string {
  return base64UrlFromBytes(new TextEncoder().encode(s));
}
function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}
/** ws delivers a frame as Buffer | ArrayBuffer | Buffer[]; normalise to UTF-8. */
function rawToString(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

type EdKey = Awaited<ReturnType<typeof subtle.importKey>>;
interface KeyPair {
  publicKeyBase64Url: string;
  privateKey: EdKey;
}

async function makeKeyPair(): Promise<KeyPair> {
  const pair = (await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as {
    publicKey: EdKey;
    privateKey: EdKey;
  };
  const pub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return { publicKeyBase64Url: base64UrlFromBytes(pub), privateKey: pair.privateKey };
}

async function signJwt(privateKey: EdKey, claims: Record<string, unknown>): Promise<string> {
  const header = base64UrlFromString(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }));
  const payload = base64UrlFromString(JSON.stringify(claims));
  const message = new TextEncoder().encode(`${header}.${payload}`);
  const sig = new Uint8Array(await subtle.sign('Ed25519', privateKey, message));
  return `${header}.${payload}.${base64UrlFromBytes(sig)}`;
}

const NODE_ID = '00000000-0000-4000-8000-0000feedface';
const FLEET_NODE_ID_HEADER = 'x-driftstack-mac-node-id';

describe('V-820 — /v1/fleet/events live WebSocket', () => {
  let fx: TestAppFixture;
  let baseUrl: string;
  let pair: KeyPair;
  const openSockets: WebSocket[] = [];

  beforeEach(async () => {
    fx = await buildTestApp({ enableFleetControlPlane: true });
    await fx.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = fx.app.server.address() as AddressInfo;
    baseUrl = `ws://127.0.0.1:${addr.port}/v1/fleet/events`;
    pair = await makeKeyPair();
    fx.fleetNodesRepo.register(NODE_ID, pair.publicKeyBase64Url);
  });

  afterEach(async () => {
    for (const s of openSockets.splice(0)) {
      try {
        s.terminate();
      } catch {
        /* already closed */
      }
    }
    if (fx) await fx.cleanup();
  });

  /** A fresh, valid node-signed JWT (real clock — the route verifies against new Date()). */
  async function freshJwt(
    nodeId = NODE_ID,
    nonce = `n-${nodeId}-${baseUrl.length}`,
  ): Promise<string> {
    const nowS = Math.floor(Date.now() / 1000);
    return signJwt(pair.privateKey, {
      iss: nodeId,
      sub: nodeId,
      iat: nowS,
      exp: nowS + 60,
      nonce,
    });
  }

  /** Open a socket with the given headers; resolve on 'open', reject with the
   *  HTTP status on a refused upgrade ('unexpected-response') or transport error. */
  function connect(headers: Record<string, string>): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(baseUrl, { headers });
      openSockets.push(ws);
      ws.once('open', () => resolve(ws));
      ws.once('unexpected-response', (_req, res) => {
        reject(new Error(`unexpected-response ${res.statusCode ?? 'unknown'}`));
      });
      ws.once('error', (err) => reject(err));
    });
  }

  it('valid JWT + matching node-id header → socket opens + node registers; close → unregisters', async () => {
    expect(fx.fleetControlRegistry.size()).toBe(0);
    const ws = await connect({
      authorization: `Bearer ${await freshJwt()}`,
      [FLEET_NODE_ID_HEADER]: NODE_ID,
    });
    expect(fx.fleetControlRegistry.size()).toBe(1);
    expect(fx.fleetControlRegistry.get(NODE_ID)?.nodeId).toBe(NODE_ID);

    const closed = new Promise<void>((r) => ws.once('close', () => r()));
    ws.close();
    await closed;
    // The server's 'close' handler unregisters asynchronously; poll briefly.
    await expect.poll(() => fx.fleetControlRegistry.size(), { timeout: 2000 }).toBe(0);
  });

  it('full dispatch round-trip: server → IntentDispatch frame → client intentResult → dispatch() resolves', async () => {
    const ws = await connect({
      authorization: `Bearer ${await freshJwt()}`,
      [FLEET_NODE_ID_HEADER]: NODE_ID,
    });

    // Client behaviour: on receiving an intentDispatch, reply with a success
    // intentResult echoing the intentId (what a real harness node does).
    ws.on('message', (data: WebSocket.RawData) => {
      const frame = JSON.parse(rawToString(data)) as {
        type: string;
        sessionId: string;
        intentId: string;
      };
      if (frame.type !== 'intentDispatch') return;
      ws.send(
        JSON.stringify({
          type: 'intentResult',
          sessionId: frame.sessionId,
          intentId: frame.intentId,
          success: true,
          durationMs: 7,
          outputData: base64Json({ url: 'https://example.test' }),
        }),
      );
    });

    const conn = fx.fleetControlRegistry.get(NODE_ID);
    expect(conn).toBeDefined();
    const result = await conn!.correlator.dispatch({
      type: 'intentDispatch',
      sessionId: 'sess-1',
      intentId: 'intent-1',
      intentName: 'navigate',
      inputParams: base64Json({ url: 'https://example.test' }),
    });

    expect(result.success).toBe(true);
    expect(result.intentId).toBe('intent-1');
    expect(result.sessionId).toBe('sess-1');
    // The DECODED, per-intent-validated navigate payload (2962e823d): proves the
    // frame went through parseIntentResult's success branch — not a synthesized
    // failure, and not an undecoded base64 passthrough.
    expect(result.outputData).toEqual({ url: 'https://example.test' });
  });

  it('answers one non-empty protocol ping with exactly one byte-identical pong and keeps dispatch live', async () => {
    const ws = await connect({
      authorization: `Bearer ${await freshJwt()}`,
      [FLEET_NODE_ID_HEADER]: NODE_ID,
    });
    const conn = fx.fleetControlRegistry.get(NODE_ID);
    expect(conn).toBeDefined();

    const pingPayload = Buffer.from('fleet-pong-proof', 'utf8');
    const pongs: Buffer[] = [];
    ws.on('pong', (data) => pongs.push(Buffer.from(data)));
    ws.ping(pingPayload);

    await expect.poll(() => pongs.length, { timeout: 2_000 }).toBeGreaterThanOrEqual(1);
    // A duplicate auto-pong and explicit pong are emitted in the same event turn,
    // but leave a bounded window so this still catches delayed transports.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pongs).toHaveLength(1);
    expect(pongs[0]).toEqual(pingPayload);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(fx.fleetControlRegistry.get(NODE_ID)).toBe(conn);

    ws.on('message', (data: WebSocket.RawData) => {
      const frame = JSON.parse(rawToString(data)) as {
        type: string;
        sessionId: string;
        intentId: string;
      };
      if (frame.type !== 'intentDispatch') return;
      ws.send(
        JSON.stringify({
          type: 'intentResult',
          sessionId: frame.sessionId,
          intentId: frame.intentId,
          success: true,
          durationMs: 1,
          outputData: base64Json({ url: 'https://example.test/after-pong' }),
        }),
      );
    });

    const result = await conn!.correlator.dispatch({
      type: 'intentDispatch',
      sessionId: 'sess-after-pong',
      intentId: 'intent-after-pong',
      intentName: 'navigate',
      inputParams: base64Json({ url: 'https://example.test/after-pong' }),
    });
    expect(result).toMatchObject({
      success: true,
      sessionId: 'sess-after-pong',
      intentId: 'intent-after-pong',
    });
    expect(result.outputData).toEqual({ url: 'https://example.test/after-pong' });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(fx.fleetControlRegistry.get(NODE_ID)).toBe(conn);
  });

  it('refuses aggregate outbound backlog without closing the socket, clears correlation, and recovers after drain', async () => {
    const ws = await connect({
      authorization: `Bearer ${await freshJwt()}`,
      [FLEET_NODE_ID_HEADER]: NODE_ID,
    });
    const conn = fx.fleetControlRegistry.get(NODE_ID);
    expect(conn).toBeDefined();

    const bufferedAmountDescriptor = Object.getOwnPropertyDescriptor(
      WebSocket.prototype,
      'bufferedAmount',
    );
    if (bufferedAmountDescriptor?.get === undefined) {
      throw new Error('ws bufferedAmount getter is unavailable');
    }
    const readClientBufferedAmount = bufferedAmountDescriptor.get.bind(ws);
    let serverBufferedAmount = FLEET_WS_MAX_BUFFERED_BYTES;
    Object.defineProperty(WebSocket.prototype, 'bufferedAmount', {
      ...bufferedAmountDescriptor,
      get(this: WebSocket): number {
        const serverSide = (this as unknown as { _isServer: boolean })._isServer;
        return serverSide ? serverBufferedAmount : (readClientBufferedAmount() as number);
      },
    });

    let clientFrames = 0;
    ws.on('message', (data: WebSocket.RawData) => {
      clientFrames += 1;
      const frame = JSON.parse(rawToString(data)) as {
        type: string;
        sessionId: string;
        intentId: string;
      };
      if (frame.type !== 'intentDispatch') return;
      ws.send(
        JSON.stringify({
          type: 'intentResult',
          sessionId: frame.sessionId,
          intentId: frame.intentId,
          success: true,
          durationMs: 2,
          outputData: base64Json({ url: 'https://example.test/recovered' }),
        }),
      );
    });

    try {
      const refused = await conn!.correlator.dispatch({
        type: 'intentDispatch',
        sessionId: 'sess-buffered',
        intentId: 'intent-buffered',
        intentName: 'navigate',
        inputParams: base64Json({ url: 'https://example.test/full' }),
      });
      expect(refused).toMatchObject({
        success: false,
        errorCode: 'intent_dispatch_error',
        intentId: 'intent-buffered',
      });
      expect(refused.errorMessage).toContain(
        'fleet control socket outbound buffer capacity exceeded',
      );
      expect(conn!.correlator.inFlight()).toBe(0);
      expect(clientFrames).toBe(0);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      expect(fx.fleetControlRegistry.get(NODE_ID)).toBe(conn);

      serverBufferedAmount = 0;
      const recovered = await conn!.correlator.dispatch({
        type: 'intentDispatch',
        sessionId: 'sess-recovered',
        intentId: 'intent-recovered',
        intentName: 'navigate',
        inputParams: base64Json({ url: 'https://example.test/recovered' }),
      });
      expect(recovered).toMatchObject({
        success: true,
        intentId: 'intent-recovered',
        sessionId: 'sess-recovered',
      });
      expect(recovered.outputData).toEqual({ url: 'https://example.test/recovered' });
      expect(clientFrames).toBe(1);
      expect(conn!.correlator.inFlight()).toBe(0);
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      Object.defineProperty(WebSocket.prototype, 'bufferedAmount', bufferedAmountDescriptor);
    }
  });

  it('refuses fire-and-forget delivery while the server socket is CLOSING and recovers when OPEN', async () => {
    const ws = await connect({
      authorization: `Bearer ${await freshJwt()}`,
      [FLEET_NODE_ID_HEADER]: NODE_ID,
    });
    const conn = fx.fleetControlRegistry.get(NODE_ID);
    expect(conn).toBeDefined();

    const readyStateDescriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'readyState');
    if (readyStateDescriptor?.get === undefined) {
      throw new Error('ws readyState getter is unavailable');
    }
    const readClientReadyState = readyStateDescriptor.get.bind(ws);
    let serverReadyState: number = WebSocket.CLOSING;
    Object.defineProperty(WebSocket.prototype, 'readyState', {
      ...readyStateDescriptor,
      get(this: WebSocket): number {
        const serverSide = (this as unknown as { _isServer: boolean })._isServer;
        return serverSide ? serverReadyState : (readClientReadyState() as number);
      },
    });

    let clientFrames = 0;
    let resolveDelivered!: (frame: { type: string; command: string }) => void;
    const delivered = new Promise<{ type: string; command: string }>((resolve) => {
      resolveDelivered = resolve;
    });
    ws.on('message', (data: WebSocket.RawData) => {
      clientFrames += 1;
      resolveDelivered(JSON.parse(rawToString(data)) as { type: string; command: string });
    });

    try {
      expect(() => conn!.sendControlCommand({ type: 'controlCommand', command: 'cordon' })).toThrow(
        'fleet control socket is not open',
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(clientFrames).toBe(0);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      expect(fx.fleetControlRegistry.get(NODE_ID)).toBe(conn);

      serverReadyState = WebSocket.OPEN;
      conn!.sendControlCommand({ type: 'controlCommand', command: 'cordon' });
      await expect(delivered).resolves.toEqual({ type: 'controlCommand', command: 'cordon' });
      expect(clientFrames).toBe(1);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      expect(fx.fleetControlRegistry.get(NODE_ID)).toBe(conn);
    } finally {
      Object.defineProperty(WebSocket.prototype, 'readyState', readyStateDescriptor);
    }
  });

  it('an inbound frame bigger than the OLD 16 MiB cap (e.g. a large file-download reply) does not close the shared control socket or fail other in-flight correlator state', async () => {
    const ws = await connect({
      authorization: `Bearer ${await freshJwt()}`,
      [FLEET_NODE_ID_HEADER]: NODE_ID,
    });
    const conn = fx.fleetControlRegistry.get(NODE_ID);
    expect(conn).toBeDefined();

    // An UNRELATED in-flight dispatch already outstanding on this SAME shared
    // socket — stands in for another customer session's request that the bug's
    // registry-wide failAll() would wrongly kill when the socket got force-closed.
    ws.on('message', (data: WebSocket.RawData) => {
      const frame = JSON.parse(rawToString(data)) as {
        type: string;
        sessionId: string;
        intentId: string;
      };
      if (frame.type !== 'intentDispatch') return;
      ws.send(
        JSON.stringify({
          type: 'intentResult',
          sessionId: frame.sessionId,
          intentId: frame.intentId,
          success: true,
          durationMs: 3,
          outputData: base64Json({ url: 'https://example.test' }),
        }),
      );
    });
    const otherDispatch = conn!.correlator.dispatch({
      type: 'intentDispatch',
      sessionId: 'other-session',
      intentId: 'other-intent',
      intentName: 'navigate',
      inputParams: base64Json({ url: 'https://example.test' }),
    });
    const largeDownload = conn!.requestDownloadFetch('req-big', 'sess-1', 'big-file.bin');

    // Simulate the node replying to a fetchDownload with an ordinary moderately
    // large file (well under the 64 MiB per-file cap, but its dataB64 alone —
    // ~20 MiB — already exceeds the OLD 16 MiB maxPayload).
    const bigDataB64 = 'A'.repeat(20 * 1024 * 1024);
    ws.send(
      JSON.stringify({
        type: 'downloadData',
        requestId: 'req-big',
        sessionId: 'sess-1',
        name: 'big-file.bin',
        mime: 'application/octet-stream',
        dataB64: bigDataB64,
      }),
    );

    // Give the server a moment to receive + route (or, pre-fix, choke on) the
    // oversized frame before asserting on connection survival.
    await new Promise((r) => setTimeout(r, 300));

    // The shared control socket must survive: still open, still registered —
    // NOT torn down + unregistered the way an over-maxPayload frame forces ws to.
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(fx.fleetControlRegistry.size()).toBe(1);
    expect(fx.fleetControlRegistry.get(NODE_ID)).toBe(conn);

    // The unrelated in-flight dispatch must resolve normally — proof the
    // registry's close/unregister failAll() never ran on this connection.
    const result = await otherDispatch;
    expect(result.success).toBe(true);
    expect(result.intentId).toBe('other-intent');
    expect(result.outputData).toEqual({ url: 'https://example.test' });
    await expect(largeDownload).resolves.toMatchObject({
      status: 'data',
      name: 'big-file.bin',
    });
  });

  it('an uncorrelated oversized frame is policy-closed before normal parsing', async () => {
    const ws = await connect({
      authorization: `Bearer ${await freshJwt()}`,
      [FLEET_NODE_ID_HEADER]: NODE_ID,
    });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') }));
    });
    const dataB64Length = 4 * Math.ceil((FLEET_INBOUND_LARGE_FRAME_THRESHOLD_BYTES + 1024) / 4);
    ws.send(
      JSON.stringify({
        type: 'downloadData',
        requestId: 'not-pending',
        sessionId: 'sess-1',
        name: 'unsolicited.bin',
        dataB64: 'A'.repeat(dataB64Length),
      }),
    );

    await expect(closed).resolves.toEqual({
      code: 1008,
      reason: 'uncorrelated-large-frame',
    });
    await expect.poll(() => fx.fleetControlRegistry.size(), { timeout: 2000 }).toBe(0);
  });

  it('unknown-node JWT → upgrade refused with 401 (socket never opens)', async () => {
    const unknownId = '00000000-0000-4000-8000-0000deadbeef';
    const jwt = await freshJwt(unknownId); // signed by our key, but unregistered
    await expect(
      connect({ authorization: `Bearer ${jwt}`, [FLEET_NODE_ID_HEADER]: unknownId }),
    ).rejects.toThrow(/401/);
    expect(fx.fleetControlRegistry.size()).toBe(0);
  });

  it('missing node-id header → upgrade refused with 401', async () => {
    await expect(connect({ authorization: `Bearer ${await freshJwt()}` })).rejects.toThrow(/401/);
    expect(fx.fleetControlRegistry.size()).toBe(0);
  });
});
