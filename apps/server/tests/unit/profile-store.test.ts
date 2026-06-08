// Unit tests for makeProfileSavedPersister — the profileSaved → R2 persistence
// handler wired into FleetControlRegistry. Covers: inline blob → putObject under
// profileSealedBlobKey with the base64-decoded bytes; large (stored:true) → no
// write; a putObject rejection is logged, never thrown (the receive loop must
// not crash).

import { describe, expect, it, vi } from 'vitest';
import { makeProfileSavedPersister } from '../../src/services/profile-store.js';
import { profileSealedBlobKey, type R2 } from '../../src/lib/r2.js';
import {
  HarnessOutboundSchema,
  type ProfileSaved,
} from '../../src/schemas/harness-control-protocol.js';

function fakeR2(putObject: R2['putObject']): R2 {
  return {
    bucket: 'test-bucket',
    putObject,
    headObject: vi.fn(),
    presignPut: vi.fn(),
    presignGet: vi.fn(),
  };
}

function fakeLogger() {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
}

describe('makeProfileSavedPersister', () => {
  it('inline shape: writes the base64-decoded sealed_blob to R2 under profileSealedBlobKey', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined);
    const logger = fakeLogger();
    const persist = makeProfileSavedPersister(fakeR2(putObject), logger);

    const frame: ProfileSaved = {
      type: 'profileSaved',
      sessionId: 'ses_x',
      profile_id: 'p1',
      sealed_blob: Buffer.from('opaque-sealed-bytes').toString('base64'),
    };
    persist(frame);
    // fire-and-forget → flush microtasks
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1));

    const arg = putObject.mock.calls[0]![0] as { key: string; body: Buffer; contentType: string };
    expect(arg.key).toBe(profileSealedBlobKey('p1'));
    expect(arg.contentType).toBe('application/octet-stream');
    expect(Buffer.isBuffer(arg.body)).toBe(true);
    expect(arg.body.toString('utf8')).toBe('opaque-sealed-bytes');
    expect((logger as unknown as { error: ReturnType<typeof vi.fn> }).error).not.toHaveBeenCalled();
  });

  it('large shape (stored:true, no inline blob): does NOT write to R2 (harness already PUT)', () => {
    const putObject = vi.fn().mockResolvedValue(undefined);
    const persist = makeProfileSavedPersister(fakeR2(putObject), fakeLogger());
    persist({ type: 'profileSaved', sessionId: 'ses_y', profile_id: 'p2', stored: true });
    expect(putObject).not.toHaveBeenCalled();
  });

  // A3 W421 — the daemon's EXACT emitted profileSaved frames (verified, not
  // hand-written; pinned harness-side by testProfileSavedEmittedFrameForA2Consumer).
  // Bind the FULL decode→persist path against these verbatim so the cross-service
  // contract can't silently drift (the ws_url silent-nil lesson). Critical
  // property: nil optionals are OMITTED, not null — absence is the discriminator.
  const A3_INLINE_FRAME =
    '{"profile_id":"prof_abc","sealed_blob":"c2VhbGVk","sessionId":"sess_42","type":"profileSaved"}';
  const A3_LARGE_ACK_FRAME =
    '{"profile_id":"prof_xyz","sessionId":"sess_99","stored":true,"type":"profileSaved"}';

  it("A3 W421 verbatim inline frame: decodes via HarnessOutbound union → persister writes to R2 (no 'stored' key present)", async () => {
    const decoded = HarnessOutboundSchema.parse(JSON.parse(A3_INLINE_FRAME));
    expect(decoded.type).toBe('profileSaved');
    const frame = decoded as ProfileSaved;
    expect(frame.stored).toBeUndefined(); // omitted, not null
    expect(frame.sealed_blob).toBe('c2VhbGVk');

    const putObject = vi.fn().mockResolvedValue(undefined);
    makeProfileSavedPersister(fakeR2(putObject), fakeLogger())(frame);
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1));
    const arg = putObject.mock.calls[0]![0] as { key: string; body: Buffer };
    expect(arg.key).toBe(profileSealedBlobKey('prof_abc'));
    expect(arg.body.toString('utf8')).toBe('sealed'); // base64 'c2VhbGVk' → 'sealed'
  });

  it("A3 W421 verbatim large-ack frame: decodes via HarnessOutbound union → persister no-ops (no 'sealed_blob' key present)", () => {
    const decoded = HarnessOutboundSchema.parse(JSON.parse(A3_LARGE_ACK_FRAME));
    expect(decoded.type).toBe('profileSaved');
    const frame = decoded as ProfileSaved;
    expect(frame.sealed_blob).toBeUndefined(); // omitted, not null
    expect(frame.stored).toBe(true);

    const putObject = vi.fn().mockResolvedValue(undefined);
    makeProfileSavedPersister(fakeR2(putObject), fakeLogger())(frame);
    expect(putObject).not.toHaveBeenCalled();
  });

  it('a putObject rejection is logged, not thrown (receive loop must not crash)', async () => {
    const putObject = vi.fn().mockRejectedValue(new Error('r2 down'));
    const logger = fakeLogger();
    const persist = makeProfileSavedPersister(fakeR2(putObject), logger);

    expect(() =>
      persist({
        type: 'profileSaved',
        sessionId: 'ses_z',
        profile_id: 'p3',
        sealed_blob: 'YmxvYg==',
      }),
    ).not.toThrow();

    const errSpy = (logger as unknown as { error: ReturnType<typeof vi.fn> }).error;
    await vi.waitFor(() => expect(errSpy).toHaveBeenCalledTimes(1));
    expect(errSpy.mock.calls[0]![1]).toMatch(/failed to persist profile sealed-blob/);
  });
});
