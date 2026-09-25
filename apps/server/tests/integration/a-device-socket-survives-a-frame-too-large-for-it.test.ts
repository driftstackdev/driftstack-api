// A device's control socket survives a frame too large for it — end to end.
//
// The device reads its control WebSocket with a maximum message size and has no
// way to refuse one message: a larger one closes the whole socket with 1009, and
// every session on the device loses its control link with it. The client below
// is a real `ws` socket given the same `maxPayload`, so it fails exactly the way
// the device does, and the server under test is the real /v1/fleet/events route.
//
//   - A device that advertises nothing (every device before the field) is never
//     sent a 5 MiB frame: the request is refused, the socket stays open, and the
//     next small frame still arrives.
//   - A device that advertises 100,663,296 bytes on its heartbeat is sent a
//     ~50 MiB upload frame and answers it.

import { randomUUID, webcrypto } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { serializeSessionEnd } from '../../src/services/harness-control-codec.js';

const subtle = webcrypto.subtle;
const MIB = 1024 * 1024;
const NODE_ID = '00000000-0000-4000-8000-00000000f4a3';
const FLEET_NODE_ID_HEADER = 'x-driftstack-mac-node-id';

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

type EdKey = Awaited<ReturnType<typeof subtle.importKey>>;

async function makeKeyPair(): Promise<{ publicKey: string; privateKey: EdKey }> {
  const pair = (await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as {
    publicKey: EdKey;
    privateKey: EdKey;
  };
  const pub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return { publicKey: base64Url(pub), privateKey: pair.privateKey };
}

async function signJwt(privateKey: EdKey, claims: Record<string, unknown>): Promise<string> {
  const enc = (v: unknown): string => base64Url(new TextEncoder().encode(JSON.stringify(v)));
  const signingInput = `${enc({ alg: 'EdDSA', typ: 'JWT' })}.${enc(claims)}`;
  const sig = new Uint8Array(
    await subtle.sign('Ed25519', privateKey, new TextEncoder().encode(signingInput)),
  );
  return `${signingInput}.${base64Url(sig)}`;
}

function rawToString(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function heartbeat(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'heartbeat',
    macNodeId: NODE_ID,
    timestamp: new Date().toISOString(),
    cpuPercent: 1,
    memoryPercent: 1,
    activeSessionCount: 1,
    ...extra,
  });
}

/** Resolve once the server has handled everything this socket sent before the
 *  ping: the route reads one socket in order, so the pong comes after. */
function roundTrip(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.once('pong', () => resolve());
    ws.ping();
  });
}

describe('a device socket survives a frame too large for it', () => {
  let fx: TestAppFixture;
  let url: string;
  let privateKey: EdKey;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    fx = await buildTestApp({ enableFleetControlPlane: true });
    await fx.app.listen({ port: 0, host: '127.0.0.1' });
    url = `ws://127.0.0.1:${(fx.app.server.address() as AddressInfo).port}/v1/fleet/events`;
    const keys = await makeKeyPair();
    privateKey = keys.privateKey;
    fx.fleetNodesRepo.register(NODE_ID, keys.publicKey);
  });

  afterEach(async () => {
    for (const s of sockets.splice(0)) {
      try {
        s.terminate();
      } catch {
        /* already closed */
      }
    }
    if (fx) await fx.cleanup();
  });

  /** Connect as the device, reading with the device's own maximum message size. */
  async function connectDevice(maxPayload: number): Promise<WebSocket> {
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signJwt(privateKey, {
      iss: NODE_ID,
      sub: NODE_ID,
      iat: now,
      exp: now + 60,
      nonce: randomUUID(),
    });
    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { authorization: `Bearer ${jwt}`, [FLEET_NODE_ID_HEADER]: NODE_ID },
        maxPayload,
      });
      sockets.push(ws);
      ws.once('open', () => resolve(ws));
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once('error', reject);
    });
  }

  it('CRITICAL a 5 MiB frame is never sent to a device that advertises no limit — the request is refused and the socket stays open', async () => {
    const ws = await connectDevice(4 * MIB);
    const received: string[] = [];
    let closeCode: number | null = null;
    ws.on('message', (data) =>
      received.push((JSON.parse(rawToString(data)) as { type: string }).type),
    );
    ws.on('close', (code) => {
      closeCode = code;
    });
    ws.on('error', () => {
      /* recorded through the close code */
    });
    // Today's device: its first beat carries no limit.
    ws.send(heartbeat());
    await roundTrip(ws);
    const conn = fx.fleetControlRegistry.get(NODE_ID);
    expect(conn).toBeDefined();

    const outcome = await conn!.requestUpload(
      randomUUID(),
      'agt_e2e',
      'big.bin',
      'application/octet-stream',
      'A'.repeat(5 * MIB),
    );
    // Give a delivered frame every chance to land and close the socket. (Not a
    // ping round trip: after a 1009 the socket can no longer be pinged.)
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(closeCode, 'the device closed its control socket').toBeNull();
    expect(received, 'the oversized frame reached the device').toEqual([]);
    expect(outcome.status).toBe('error');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(fx.fleetControlRegistry.get(NODE_ID)).toBe(conn);

    conn!.sendSessionEnd(serializeSessionEnd('agt_e2e'));
    await expect.poll(() => received, { timeout: 2_000 }).toEqual(['sessionEnd']);
    expect(closeCode).toBeNull();
  });

  it('CRITICAL a device that advertises 100,663,296 bytes is sent a ~50 MiB upload frame and answers it', async () => {
    const ws = await connectDevice(100_663_296);
    ws.on('error', () => {
      /* a failure shows as the outcome below */
    });
    let frameBytes = 0;
    ws.on('message', (data) => {
      const text = rawToString(data);
      const frame = JSON.parse(text) as { type: string; requestId: string; sessionId: string };
      if (frame.type !== 'uploadFile') return;
      frameBytes = Buffer.byteLength(text, 'utf8');
      ws.send(
        JSON.stringify({
          type: 'uploadResult',
          requestId: frame.requestId,
          sessionId: frame.sessionId,
          handle: { id: 'up_50', name: 'fifty.bin', mime: 'application/octet-stream', size: 1 },
        }),
      );
    });
    ws.send(heartbeat({ maxInboundFrameBytes: 100_663_296 }));
    await roundTrip(ws);
    const conn = fx.fleetControlRegistry.get(NODE_ID);
    expect(conn).toBeDefined();

    const outcome = await conn!.requestUpload(
      randomUUID(),
      'agt_e2e',
      'fifty.bin',
      'application/octet-stream',
      Buffer.alloc(50 * MIB, 0x5a).toString('base64'),
    );

    expect(outcome.status).toBe('ok');
    expect(frameBytes).toBeGreaterThan(66 * MIB);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  }, 60_000);
});
