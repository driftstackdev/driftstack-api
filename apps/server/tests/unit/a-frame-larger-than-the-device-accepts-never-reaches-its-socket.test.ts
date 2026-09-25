// A frame larger than the device accepts never reaches its socket.
//
// The device reads its control socket with a fixed maximum message size, and it
// cannot refuse one message: a larger inbound message makes it close the WHOLE
// socket with 1009. That socket carries every session on the device, so one
// oversized upload or cookie import dropped all of them, and nothing said why.
//
// So the server must never send a frame the device cannot take. These arms drive
// FleetControlConnection with a recording socket and check what reaches it:
//
//   - a 5 MiB frame to a device that has not advertised a limit is refused before
//     the socket, the caller learns why, and the socket stays usable;
//   - a device that advertises a larger limit gets a ~50 MiB upload frame;
//   - every frame kind the server sends to a device passes the same check;
//   - a refusal is logged once, at WARN, with the frame's type and size;
//   - the size is the UTF-8 byte length of the exact string sent.
//
// ⛔ This file imports nothing the fix added, so an unfixed tree fails on the
// behaviour (a frame reaching the socket), not on a missing import. The limits
// are written out as numbers here on purpose: they are the device's contract,
// and a change to them should have to change this file.

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/lib/logger.js';
import { FleetControlConnection } from '../../src/services/fleet-control-registry.js';
import {
  encodeWireData,
  serializeControlCommand,
  serializePauseSession,
  serializeResumeSession,
  serializeSessionEnd,
} from '../../src/services/harness-control-codec.js';
import type { SessionAssign } from '../../src/schemas/harness-control-protocol.js';

const NODE = 'node-frame-guard-1';
const MIB = 1024 * 1024;
/** 4 MiB, the device default, minus the 64 KiB framing margin. */
const DEFAULT_LIMIT = 4 * MIB - 64 * 1024;

interface Harness {
  conn: FleetControlConnection;
  sent: string[];
  terminate: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
}

function connect(): Harness {
  const sent: string[] = [];
  const terminate = vi.fn();
  const warn = vi.fn();
  const info = vi.fn();
  const logger = { warn, info, error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  const conn = new FleetControlConnection(
    NODE,
    (data) => sent.push(data),
    undefined, // onProfileSaved
    undefined, // onChallengeDetected
    undefined, // onPageState
    undefined, // onProfileSaveFailed
    undefined, // onHeartbeat
    undefined, // onSessionStatus
    logger,
    terminate,
  );
  return { conn, sent, terminate, warn };
}

function heartbeat(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'heartbeat',
    macNodeId: NODE,
    timestamp: '2026-09-24T00:00:00Z',
    cpuPercent: 1,
    memoryPercent: 1,
    activeSessionCount: 0,
    ...extra,
  });
}

/** A sessionAssign whose serialised form is about `bytes` long. The guard is on
 *  the send path, so the frame only has to be the right size and type. */
function bigAssign(bytes: number): SessionAssign {
  return {
    type: 'sessionAssign',
    sessionId: 'agt_big',
    archetype: 'iphone',
    behaviorProfile: 'default',
    initialUrl: `https://example.com/?q=${'a'.repeat(bytes)}`,
  } as unknown as SessionAssign;
}

function thrownBy(fn: () => void): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('a frame larger than the device accepts never reaches its socket', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('CRITICAL a 5 MiB frame to a device that has not advertised a limit is refused before the socket, and the socket stays open and usable', async () => {
    const { conn, sent, terminate } = connect();
    const dataB64 = 'A'.repeat(5 * MIB);

    const pending = conn.requestUpload('req-1', 'agt_1', 'big.bin', 'x/y', dataB64);

    expect(sent, 'the oversized uploadFile frame reached the socket').toEqual([]);
    // Settled at once — the refusal does not wait for a reply that cannot come.
    const outcome = await pending;
    expect(outcome.status).toBe('error');
    // Nothing closed the socket and the connection still routes frames.
    expect(terminate).not.toHaveBeenCalled();
    conn.sendSessionEnd(serializeSessionEnd('agt_1'));
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toMatchObject({ type: 'sessionEnd', sessionId: 'agt_1' });
  });

  it('CRITICAL a fire-and-forget send of an oversized frame throws a typed error naming the frame type, its size and the limit', () => {
    const { conn, sent } = connect();
    const assign = bigAssign(5 * MIB);
    const expectedBytes = Buffer.byteLength(JSON.stringify(assign), 'utf8');

    const err = thrownBy(() => conn.sendSessionAssign(assign)) as
      | (Error & { frameType?: string; frameBytes?: number; limitBytes?: number })
      | undefined;

    expect(sent).toEqual([]);
    expect(err, 'an oversized sessionAssign was sent without complaint').toBeInstanceOf(Error);
    expect(err?.name).toBe('DeviceFrameTooLargeError');
    expect(err?.frameType).toBe('sessionAssign');
    expect(err?.frameBytes).toBe(expectedBytes);
    expect(err?.limitBytes).toBe(DEFAULT_LIMIT);
  });

  it('CRITICAL a device advertising 100,663,296 bytes is sent a ~50 MiB upload frame', () => {
    const { conn, sent } = connect();
    conn.handleInbound(heartbeat({ maxInboundFrameBytes: 100_663_296 }));
    const decoded = Buffer.alloc(50 * MIB, 0x5a);

    void conn.requestUpload('req-50', 'agt_1', 'fifty.bin', 'x/y', decoded.toString('base64'));

    expect(sent).toHaveLength(1);
    const frameBytes = Buffer.byteLength(sent[0]!, 'utf8');
    expect(frameBytes).toBeGreaterThan(66 * MIB);
    expect(frameBytes).toBeLessThanOrEqual(100_663_296 - 64 * 1024);
    expect(JSON.parse(sent[0]!)).toMatchObject({ type: 'uploadFile', requestId: 'req-50' });
    conn.close('test over');
  });

  it('CRITICAL every kind of frame the server sends a device passes the same check — none reaches a device whose limit it exceeds', async () => {
    const { conn, sent } = connect();
    // 65,536 advertised, minus the 64 KiB margin, leaves room for nothing.
    conn.handleInbound(heartbeat({ maxInboundFrameBytes: 65_536 }));

    const proxy = {
      host: 'proxy.example',
      port: 1080,
      udp_associate: true,
      require_remote_dns: true,
    };
    const requests: Array<Promise<unknown>> = [
      conn.correlator.dispatch({
        type: 'intentDispatch',
        sessionId: 'agt_1',
        intentId: 'int_1',
        intentName: 'navigate',
        inputParams: encodeWireData({ url: 'https://example.com' }),
      }),
      conn.requestCookies(randomUUID(), 'agt_1'),
      conn.setCookies(randomUUID(), 'agt_1', [{ domain: 'example.com', name: 'a', value: 'b' }]),
      conn.navigateHistory(randomUUID(), 'agt_1', 'back'),
      conn.requestUpload(randomUUID(), 'agt_1', 'a.txt', 'text/plain', 'aGVsbG8='),
      conn.requestDownloadList(randomUUID(), 'agt_1'),
      conn.requestDownloadFetch(randomUUID(), 'agt_1', 'a.txt'),
      conn.requestTrim({
        requestId: randomUUID(),
        profileId: 'prof_1',
        dek: 'ZGVr',
        sealedBlobPutURL: 'https://blob.example/put',
      }),
      conn.setEgress(
        randomUUID(),
        'agt_1',
        proxy,
        {
          ip: '203.0.113.9',
          country: 'US',
          region: null,
          city: null,
          timezone: null,
          quic_ok: false,
          probed_at: '2026-09-24T00:00:00Z',
        },
        'next_navigation',
      ),
      conn.probeEgress({
        requestId: randomUUID(),
        inlineProxyConfig: proxy,
        target: { host: 'example.com', port: 443 },
      }),
    ];
    let settled = 0;
    for (const request of requests) void request.then(() => (settled += 1));
    await vi.advanceTimersByTimeAsync(0);

    expect(
      sent.map((s) => (JSON.parse(s) as { type: string }).type),
      'a request frame reached a device whose advertised limit it exceeds',
    ).toEqual([]);
    // Every request/reply call settles at once (never rejects) with a non-ok outcome.
    expect(settled, 'a refused request waited for a reply instead of settling').toBe(
      requests.length,
    );
    for (const outcome of await Promise.all(requests)) {
      expect(outcome).not.toBeInstanceOf(Error);
      const o = outcome as { status?: string; success?: boolean };
      expect(o.status === 'ok' || o.success === true, JSON.stringify(outcome)).toBe(false);
    }

    const fireAndForget: Array<[string, () => void]> = [
      ['sessionAssign', () => conn.sendSessionAssign(bigAssign(1))],
      ['sessionEnd', () => conn.sendSessionEnd(serializeSessionEnd('agt_1'))],
      ['pauseSession', () => conn.sendPauseSession(serializePauseSession('agt_1'))],
      [
        'resumeSession',
        () => conn.sendResumeSession(serializeResumeSession({ sessionId: 'agt_1' })),
      ],
      [
        'controlCommand',
        () => conn.sendControlCommand(serializeControlCommand({ command: 'cordon' })),
      ],
    ];
    for (const [type, send] of fireAndForget) {
      const err = thrownBy(send) as (Error & { frameType?: string }) | undefined;
      expect(err?.name, `${type} was not refused`).toBe('DeviceFrameTooLargeError');
      expect(err?.frameType).toBe(type);
    }

    expect(
      sent.map((s) => (JSON.parse(s) as { type: string }).type),
      'a frame reached a device whose advertised limit it exceeds',
    ).toEqual([]);
  });

  it('CRITICAL a refused frame is logged once at WARN with its type and size — and never its content', async () => {
    const { conn, warn } = connect();
    const marker = 'CUSTOMER-FILE-CONTENT';
    const dataB64 = `${Buffer.from(marker).toString('base64')}${'A'.repeat(5 * MIB)}`;

    const pending = conn.requestUpload('req-log', 'agt_1', 'big.bin', 'x/y', dataB64);
    conn.close('test over');
    await pending;

    const refusals = warn.mock.calls.filter(
      ([fields]) => (fields as { frameType?: string }).frameType === 'uploadFile',
    );
    expect(refusals, 'the refusal was not logged exactly once').toHaveLength(1);
    const [fields] = refusals[0]! as [Record<string, unknown>, string];
    expect(fields).toMatchObject({
      nodeId: NODE,
      frameType: 'uploadFile',
      limitBytes: DEFAULT_LIMIT,
    });
    expect(fields.frameBytes).toBeGreaterThan(5 * MIB);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(marker);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(Buffer.from(marker).toString('base64'));
  });

  it('CRITICAL a frame is measured in UTF-8 bytes of the exact string sent, not in characters', async () => {
    const { conn, sent } = connect();
    // 1.5 M characters of "€" is 1.5 M in `.length` and 4.5 MB in UTF-8.
    const value = '€'.repeat(1_500_000);
    expect(value.length).toBeLessThan(DEFAULT_LIMIT);
    expect(Buffer.byteLength(value, 'utf8')).toBeGreaterThan(DEFAULT_LIMIT);

    const pending = conn.setCookies('r-utf8', 'agt_1', [
      { domain: 'example.com', name: 'wide', value: value.slice(0, 4096) },
      ...Array.from({ length: 366 }, (_, i) => ({
        domain: 'example.com',
        name: `w${i}`,
        value: value.slice(0, 4096),
      })),
    ]);

    expect(sent, 'a frame over the byte limit but under it in characters was sent').toEqual([]);
    conn.close('test over');
    expect((await pending).status).toBe('error');
  });
});
