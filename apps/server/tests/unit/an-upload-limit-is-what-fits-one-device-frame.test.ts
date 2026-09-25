// An upload limit is what fits one device frame.
//
// Pins the arithmetic in services/device-frame-guard.ts and checks it against a
// real `uploadFile` frame built by the codec that sends it:
//
//   - the device default (4 MiB), the margin (64 KiB) and the clamp (256 MiB);
//   - a file of exactly the computed maximum fits one frame whatever its name
//     and type, and the next base64 quantum does not when both are at their
//     worst — so the limit is neither unsafe nor needlessly low;
//   - the rounded figures the upload reference quotes are the computed ones.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEVICE_DEFAULT_MAX_INBOUND_FRAME_BYTES,
  DEVICE_FRAME_SAFETY_MARGIN_BYTES,
  DEVICE_MAX_ADVERTISED_INBOUND_FRAME_BYTES,
  UPLOAD_NAME_MAX_LENGTH,
  deviceFrameBytes,
  deviceFrameLimitBytes,
  maxUploadFileBytesForFrame,
} from '../../src/services/device-frame-guard.js';
import { serializeUploadFile } from '../../src/services/harness-control-codec.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const ROUTE = resolve(REPO, 'apps/server/src/routes/agent-sessions.ts');
const DOC = resolve(REPO, 'apps/docs/src/pages/api/agent-sessions.md');

const MIB = 1024 * 1024;
const SESSION = 'agt_00000000-0000-4000-8000-00000000abcd';
const REQUEST = '11111111-1111-4111-8111-111111111111';

function uploadFrameBytes(fileBytes: number, name: string, mime: string): number {
  return deviceFrameBytes(
    serializeUploadFile({
      requestId: REQUEST,
      sessionId: SESSION,
      name,
      mime,
      dataB64: Buffer.alloc(fileBytes, 0x41).toString('base64'),
    }),
  );
}

describe('an upload limit is what fits one device frame', () => {
  it('CRITICAL the device default, the margin and the clamp', () => {
    expect(DEVICE_DEFAULT_MAX_INBOUND_FRAME_BYTES).toBe(4_194_304);
    expect(DEVICE_FRAME_SAFETY_MARGIN_BYTES).toBe(65_536);
    expect(DEVICE_MAX_ADVERTISED_INBOUND_FRAME_BYTES).toBe(268_435_456);
    expect(deviceFrameLimitBytes(undefined)).toBe(4_128_768);
    expect(deviceFrameLimitBytes(100_663_296)).toBe(100_597_760);
    expect(deviceFrameLimitBytes(2 ** 40)).toBe(268_369_920);
    expect(deviceFrameLimitBytes(65_536)).toBe(0);
    expect(deviceFrameLimitBytes(1)).toBe(0);
  });

  it('CRITICAL a file of the computed maximum fits one frame with any name and type up to their limit', () => {
    const limit = deviceFrameLimitBytes(undefined);
    const max = maxUploadFileBytesForFrame(limit, SESSION);
    const cases: Array<[string, string]> = [
      ['a.pdf', 'application/pdf'],
      ['\u0000'.repeat(UPLOAD_NAME_MAX_LENGTH), '\u001f'.repeat(UPLOAD_NAME_MAX_LENGTH)],
      ['😀'.repeat(UPLOAD_NAME_MAX_LENGTH >> 1), 'é'.repeat(UPLOAD_NAME_MAX_LENGTH)],
      ['"'.repeat(UPLOAD_NAME_MAX_LENGTH), '\\'.repeat(UPLOAD_NAME_MAX_LENGTH)],
      ['\ud800'.repeat(UPLOAD_NAME_MAX_LENGTH), '\u2028'.repeat(UPLOAD_NAME_MAX_LENGTH)],
    ];
    for (const [name, mime] of cases) {
      expect(
        uploadFrameBytes(max, name, mime),
        `name ${JSON.stringify(name.slice(0, 4))}…`,
      ).toBeLessThanOrEqual(limit);
    }
  });

  it('CRITICAL the next base64 quantum does not fit with the worst name and type — the limit is tight, not arbitrary', () => {
    const limit = deviceFrameLimitBytes(undefined);
    const max = maxUploadFileBytesForFrame(limit, SESSION);
    const worst = '\u0000'.repeat(UPLOAD_NAME_MAX_LENGTH);
    expect(uploadFrameBytes(max + 3, worst, worst)).toBeGreaterThan(limit);
  });

  it('CRITICAL a limit with no room for the envelope allows no file at all', () => {
    expect(maxUploadFileBytesForFrame(0, SESSION)).toBe(0);
    expect(maxUploadFileBytesForFrame(1_000, SESSION)).toBe(0);
  });

  it('CRITICAL the worst-case name and type are the route’s own bounds', () => {
    // The limit assumes names and types of at most UPLOAD_NAME_MAX_LENGTH; a
    // longer one would be a frame the computation did not allow for.
    const route = readFileSync(ROUTE, 'utf8');
    const schema = /const UploadFileBodySchema = z\.object\(\{([\s\S]*?)\}\);/.exec(route)?.[1];
    expect(schema, 'UploadFileBodySchema not found in the route').toBeDefined();
    expect(schema).toContain(`name: z.string().min(1).max(${UPLOAD_NAME_MAX_LENGTH}),`);
    expect(schema).toContain(`mime: z.string().min(1).max(${UPLOAD_NAME_MAX_LENGTH}),`);
  });

  it('CRITICAL the rounded figures the upload reference quotes are the computed defaults', () => {
    const doc = readFileSync(DOC, 'utf8');
    const oneDecimal = (bytes: number): string => (Math.floor((bytes / MIB) * 10) / 10).toFixed(1);
    const frame = deviceFrameLimitBytes(undefined);
    const file = maxUploadFileBytesForFrame(frame, SESSION);
    expect(doc).toContain(`about ${oneDecimal(frame)} MiB unless the device takes more`);
    expect(doc).toContain(`about ${oneDecimal(file)} MiB unless the device takes more`);
  });
});
