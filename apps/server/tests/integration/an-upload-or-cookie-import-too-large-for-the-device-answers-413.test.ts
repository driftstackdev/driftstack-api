// An upload or cookie import too large for the device answers 413.
//
// The device reads its control socket with a fixed maximum message size and
// closes the WHOLE socket — every session on it — on a larger message. An upload
// travels as ONE frame (the file base64-encoded inside a JSON envelope) and a
// cookie import as one frame too, so before relaying either the route checks the
// frame against the limit of the device that runs THIS session, and refuses with
// a 413 the customer can act on. Nothing is sent.
//
// The per-file 64 MiB cap stays the absolute ceiling; the effective limit is the
// smaller of that and what fits one frame after base64 and the envelope. The
// session read publishes that number so a client can check before it reads the
// file at all.
//
// The expected limit below is derived here from the stated rule rather than read
// from the implementation, so the two are checked against each other.

import { afterEach, describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { binarySizeLabel } from '../../src/lib/binary-size-label.js';

const MIB = 1024 * 1024;
const MARGIN = 64 * 1024;
/** 4 MiB, the device default, minus the 64 KiB framing margin. */
const DEFAULT_FRAME_LIMIT = 4 * MIB - MARGIN;
const UPLOAD_CEILING = 64 * MIB;

/** Largest decoded file that fits one uploadFile frame for `sessionId`, whatever
 *  its name and type: both at their 255-character maximum, every character at
 *  its worst JSON escape (six bytes). */
function expectedUploadLimit(frameLimit: number, sessionId: string): number {
  const worst = '\u0000'.repeat(255);
  const envelope = Buffer.byteLength(
    JSON.stringify({
      type: 'uploadFile',
      requestId: '00000000-0000-4000-8000-000000000000',
      sessionId,
      name: worst,
      mime: worst,
      dataB64: '',
    }),
    'utf8',
  );
  return Math.min(UPLOAD_CEILING, Math.floor((frameLimit - envelope) / 4) * 3);
}

interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  limit_bytes?: number;
  size_bytes?: number;
}

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

interface Device {
  /** The `type` of every frame the device received, in order. */
  frames: string[];
  /** Send a heartbeat advertising this inbound frame limit. */
  advertise(bytes: number): void;
}

/** A device that answers every upload and cookie import, and records every frame. */
function connectDevice(fx: TestAppFixture, nodeId: string): Device {
  const frames: string[] = [];
  const conn = fx.fleetControlRegistry.register(nodeId, (data) => {
    const frame = JSON.parse(data) as { type?: string; requestId?: string; sessionId?: string };
    frames.push(frame.type ?? '?');
    if (frame.type === 'uploadFile') {
      conn.handleInbound(
        JSON.stringify({
          type: 'uploadResult',
          requestId: frame.requestId,
          sessionId: frame.sessionId,
          handle: { id: 'up_1', name: 'f.bin', mime: 'x/y', size: 1 },
        }),
      );
    }
    if (frame.type === 'setCookies') {
      conn.handleInbound(
        JSON.stringify({
          type: 'setCookiesResult',
          requestId: frame.requestId,
          sessionId: frame.sessionId,
          ok: true,
        }),
      );
    }
  });
  return {
    frames,
    advertise(bytes: number): void {
      conn.handleInbound(
        JSON.stringify({
          type: 'heartbeat',
          macNodeId: nodeId,
          timestamp: '2026-09-24T00:00:00Z',
          cpuPercent: 1,
          memoryPercent: 1,
          activeSessionCount: 1,
          maxInboundFrameBytes: bytes,
        }),
      );
    },
  };
}

function fileOf(bytes: number): { name: string; mime: string; dataB64: string } {
  return {
    name: 'f.bin',
    mime: 'application/octet-stream',
    dataB64: Buffer.alloc(bytes, 0x41).toString('base64'),
  };
}

describe('an upload or cookie import too large for the device answers 413', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  async function upload(id: string, bytes: number) {
    return fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/files`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: fileOf(bytes),
    });
  }

  it('CRITICAL an upload over the device’s effective limit answers 413 with the limit in the copy, and nothing is sent to the device', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    await fx.agentSessionsRepo!.setNodeId(id, 'node-413-upload');
    const device = connectDevice(fx, 'node-413-upload');
    const limit = expectedUploadLimit(DEFAULT_FRAME_LIMIT, id);

    const res = await upload(id, limit + 1);

    expect(device.frames, 'the oversized upload was relayed to the device').not.toContain(
      'uploadFile',
    );
    expect(res.statusCode).toBe(413);
    const problem = res.json<Problem>();
    expect(problem.type).toBe(PROBLEM_TYPES.PayloadTooLarge);
    expect(problem.title).toBe('Payload Too Large');
    expect(problem.status).toBe(413);
    expect(problem.detail).toBe(
      `This file is too large to send to this device (limit ${binarySizeLabel(limit)}).`,
    );
    expect(problem.limit_bytes).toBe(limit);
    expect(problem.size_bytes).toBe(limit + 1);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('CRITICAL an upload exactly at the effective limit is relayed', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    await fx.agentSessionsRepo!.setNodeId(id, 'node-413-at-limit');
    const device = connectDevice(fx, 'node-413-at-limit');

    const res = await upload(id, expectedUploadLimit(DEFAULT_FRAME_LIMIT, id));

    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('ok');
    expect(device.frames).toEqual(['uploadFile']);
  });

  it('CRITICAL the limit is the TARGET device’s: a device advertising 100,663,296 bytes takes a 5 MiB file the default would refuse', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    await fx.agentSessionsRepo!.setNodeId(id, 'node-413-big');
    const device = connectDevice(fx, 'node-413-big');
    device.advertise(100_663_296);

    const res = await upload(id, 5 * MIB);

    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('ok');
    expect(device.frames).toEqual(['uploadFile']);
  });

  it('CRITICAL a cookie import over the device’s limit answers 413, and nothing is sent to the device', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    await fx.agentSessionsRepo!.setNodeId(id, 'node-413-cookies');
    const device = connectDevice(fx, 'node-413-cookies');
    // 1,100 cookies with 4,000-character values: ~4.4 MB on the wire, under the
    // route's 8 MiB body limit and over the default device frame.
    const cookies = Array.from({ length: 1_100 }, (_, i) => ({
      domain: 'example.com',
      name: `c${i}`,
      value: 'v'.repeat(4_000),
    }));

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/cookies/set`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { cookies },
    });

    expect(device.frames, 'the oversized cookie jar was relayed to the device').not.toContain(
      'setCookies',
    );
    expect(res.statusCode).toBe(413);
    const problem = res.json<Problem>();
    expect(problem.type).toBe(PROBLEM_TYPES.PayloadTooLarge);
    expect(problem.title).toBe('Payload Too Large');
    expect(problem.detail).toBe(
      `This cookie jar is too large to send to this device (limit ${binarySizeLabel(DEFAULT_FRAME_LIMIT)}).`,
    );
    expect(problem.limit_bytes).toBe(DEFAULT_FRAME_LIMIT);
    expect(problem.size_bytes).toBeGreaterThan(DEFAULT_FRAME_LIMIT);
  });

  it('CRITICAL a body over the route’s own limit is a 413 of the same type — one type for every 413', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    await fx.agentSessionsRepo!.setNodeId(id, 'node-413-body');
    const device = connectDevice(fx, 'node-413-body');

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/cookies/set`,
      headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
      // Over the route's 8 MiB body limit, so it is refused before parsing.
      payload: JSON.stringify({ cookies: [], pad: 'p'.repeat(9 * MIB) }),
    });

    expect(res.statusCode).toBe(413);
    const problem = res.json<Problem>();
    expect(problem.type).toBe(PROBLEM_TYPES.PayloadTooLarge);
    expect(problem.title).toBe('Payload Too Large');
    expect(device.frames).toEqual([]);
  });

  it('CRITICAL a cookie import that fits is still relayed', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    await fx.agentSessionsRepo!.setNodeId(id, 'node-413-cookies-ok');
    const device = connectDevice(fx, 'node-413-cookies-ok');

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/cookies/set`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { cookies: [{ domain: 'example.com', name: 'a', value: 'b' }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('ok');
    expect(device.frames).toEqual(['setCookies']);
  });

  it('CRITICAL the session read publishes the effective upload limit of the device running it, follows its heartbeat, and omits it when no device is connected', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true, enableFleetControlPlane: true });
    const id = await createSession(fx);
    const read = async (): Promise<Record<string, unknown>> => {
      const res = await fx.app.inject({
        method: 'GET',
        url: `/v1/agent-sessions/${id}`,
        headers: { authorization: `Bearer ${fx.plaintext}` },
      });
      expect(res.statusCode).toBe(200);
      return res.json<Record<string, unknown>>();
    };

    expect(await read()).not.toHaveProperty('upload_max_file_bytes');

    await fx.agentSessionsRepo!.setNodeId(id, 'node-413-read');
    expect(await read(), 'no device connected yet').not.toHaveProperty('upload_max_file_bytes');

    const device = connectDevice(fx, 'node-413-read');
    expect((await read()).upload_max_file_bytes).toBe(expectedUploadLimit(DEFAULT_FRAME_LIMIT, id));

    device.advertise(100_663_296);
    expect((await read()).upload_max_file_bytes).toBe(UPLOAD_CEILING);
  });
});
