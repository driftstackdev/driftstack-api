// V-531.B — mintLivekitToken unit tests. Verify the JWT format matches
// LiveKit's HS256 + canonical claim shape so a real `livekit-client`
// round-trip would accept the token.

import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mintLivekitToken } from '../../src/lib/livekit-token.js';

function decodeBase64Url(s: string): Buffer {
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function decodeJwtPart(part: string): unknown {
  return JSON.parse(decodeBase64Url(part).toString('utf8'));
}

describe('V-531.B mintLivekitToken', () => {
  const baseOpts = {
    apiKey: 'APIabc123',
    apiSecret: 'secretXYZ',
    identity: 'sess_demo123',
    video: {
      room: 'session-room-1',
      roomJoin: true as const,
      canPublish: true,
      canSubscribe: true,
    },
  };

  it('produces a 3-part JWT (header.payload.signature)', () => {
    const token = mintLivekitToken({ ...baseOpts, jti: 'fixedjti' });
    expect(token.split('.').length).toBe(3);
  });

  it('header is { alg: "HS256", typ: "JWT" }', () => {
    const token = mintLivekitToken({ ...baseOpts, jti: 'fixedjti' });
    const [headerPart] = token.split('.');
    expect(headerPart).toBeDefined();
    const header = decodeJwtPart(headerPart as string);
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' });
  });

  it('payload includes iss/sub/exp/nbf/jti/video claims', () => {
    const token = mintLivekitToken({
      ...baseOpts,
      jti: 'fixedjti',
      nowMs: 1_715_000_000_000,
      ttlSeconds: 600,
    });
    const payload = decodeJwtPart(token.split('.')[1] as string) as Record<string, unknown>;
    expect(payload.iss).toBe('APIabc123');
    expect(payload.sub).toBe('sess_demo123');
    expect(payload.nbf).toBe(1_715_000_000);
    expect(payload.exp).toBe(1_715_000_600);
    expect(payload.jti).toBe('fixedjti');
    expect(payload.video).toEqual({
      room: 'session-room-1',
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });
  });

  it('signature is HMAC-SHA256 of header.payload with the apiSecret', () => {
    const token = mintLivekitToken({ ...baseOpts, jti: 'fixedjti' });
    const [h, p, sigB64] = token.split('.');
    const expected = createHmac('sha256', baseOpts.apiSecret).update(`${h}.${p}`).digest();
    expect(decodeBase64Url(sigB64 as string).equals(expected)).toBe(true);
  });

  it('default ttl is 600 seconds', () => {
    const token = mintLivekitToken({ ...baseOpts, jti: 'fixedjti', nowMs: 1_000_000_000_000 });
    const payload = decodeJwtPart(token.split('.')[1] as string) as { exp: number; nbf: number };
    expect(payload.exp - payload.nbf).toBe(600);
  });

  it('different jti each call (when not pinned)', () => {
    const t1 = mintLivekitToken(baseOpts);
    const t2 = mintLivekitToken(baseOpts);
    const j1 = (decodeJwtPart(t1.split('.')[1] as string) as Record<string, unknown>).jti;
    const j2 = (decodeJwtPart(t2.split('.')[1] as string) as Record<string, unknown>).jti;
    expect(j1).not.toBe(j2);
  });

  it('subscriber-only video grant: canPublish=false, canSubscribe=true', () => {
    const token = mintLivekitToken({
      ...baseOpts,
      jti: 'fixedjti',
      video: {
        room: 'session-room-1',
        roomJoin: true,
        canPublish: false,
        canSubscribe: true,
      },
    });
    const payload = decodeJwtPart(token.split('.')[1] as string) as {
      video: { canPublish: boolean; canSubscribe: boolean };
    };
    expect(payload.video.canPublish).toBe(false);
    expect(payload.video.canSubscribe).toBe(true);
  });

  it('publisher-only video grant: canPublish=true, canSubscribe=false', () => {
    const token = mintLivekitToken({
      ...baseOpts,
      jti: 'fixedjti',
      video: {
        room: 'session-room-1',
        roomJoin: true,
        canPublish: true,
        canSubscribe: false,
      },
    });
    const payload = decodeJwtPart(token.split('.')[1] as string) as {
      video: { canPublish: boolean; canSubscribe: boolean };
    };
    expect(payload.video.canPublish).toBe(true);
    expect(payload.video.canSubscribe).toBe(false);
  });

  it('throws TypeError on empty apiKey', () => {
    expect(() => mintLivekitToken({ ...baseOpts, apiKey: '' })).toThrow(TypeError);
  });

  it('throws TypeError on empty apiSecret', () => {
    expect(() => mintLivekitToken({ ...baseOpts, apiSecret: '' })).toThrow(TypeError);
  });

  it('throws TypeError on empty identity', () => {
    expect(() => mintLivekitToken({ ...baseOpts, identity: '' })).toThrow(TypeError);
  });

  it('base64url encoding (no padding, no + or /)', () => {
    const token = mintLivekitToken({ ...baseOpts, jti: 'fixedjti' });
    expect(token).not.toMatch(/=/);
    expect(token).not.toMatch(/\+/);
    expect(token).not.toMatch(/\//);
  });

  it('respects nowMs override (deterministic)', () => {
    const token1 = mintLivekitToken({ ...baseOpts, jti: 'fixedjti', nowMs: 1_715_000_000_000 });
    const token2 = mintLivekitToken({ ...baseOpts, jti: 'fixedjti', nowMs: 1_715_000_000_000 });
    expect(token1).toBe(token2);
  });
});
