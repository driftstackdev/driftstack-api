// Unit tests for makeProfileSavedPersister — the profileSaved → R2 persistence
// handler wired into FleetControlRegistry. Covers: inline blob → putObject under
// profileSealedBlobKey with the base64-decoded bytes; large (stored:true) → no
// write; a putObject rejection is logged, never thrown (the receive loop must
// not crash).

import { describe, expect, it, vi } from 'vitest';
import {
  makeProfileSavedPersister,
  buildAssignProfileBlock,
} from '../../src/services/profile-store.js';
import { profileSealedBlobKey, type R2 } from '../../src/lib/r2.js';
import { serializeSessionAssign } from '../../src/services/harness-control-codec.js';
import {
  HarnessOutboundSchema,
  SessionAssignSchema,
  type ProfileSaved,
} from '../../src/schemas/harness-control-protocol.js';
import {
  BOUNDED_NODE_LATEST_RELAY_MAX_CONCURRENT,
  BOUNDED_NODE_LATEST_RELAY_MAX_SESSIONS,
} from '../../src/services/bounded-node-latest-relay.js';

function fakeR2(putObject: R2['putObject']): R2 {
  return {
    bucket: 'test-bucket',
    putObject,
    deleteObject: vi.fn(),
    headObject: vi.fn(),
    presignPut: vi.fn(),
    presignGet: vi.fn(),
    listObjects: vi.fn(),
  };
}

function fakeLogger() {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
}

/**
 * V-2140 — ownership deps are required now. These bind `sessionId` to a node and
 * a profile the session's account owns, so the guard admits the write and the
 * arm under test sees the same R2 behaviour it saw before the door was closed.
 */
function owningDeps(
  nodeId: string,
  profileId: string,
): Parameters<typeof makeProfileSavedPersister>[2] {
  return {
    agentSessions: {
      get: vi.fn().mockResolvedValue({ accountId: 'acc_owner', nodeId, profileId }),
    },
    profiles: {
      findById: vi.fn().mockResolvedValue({ id: profileId, accountId: 'acc_owner' }),
      recordSave: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe('makeProfileSavedPersister', () => {
  it('inline shape: writes the base64-decoded sealed_blob to R2 under profileSealedBlobKey', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined);
    const logger = fakeLogger();
    const persist = makeProfileSavedPersister(
      fakeR2(putObject),
      logger,
      owningDeps('node_a', 'p1'),
    );

    const frame: ProfileSaved = {
      type: 'profileSaved',
      sessionId: 'ses_x',
      profile_id: 'p1',
      sealed_blob: Buffer.from('opaque-sealed-bytes').toString('base64'),
    };
    persist(frame, 'node_a');
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
    const persist = makeProfileSavedPersister(
      fakeR2(putObject),
      fakeLogger(),
      owningDeps('node_a', 'p2'),
    );
    persist({ type: 'profileSaved', sessionId: 'ses_y', profile_id: 'p2', stored: true }, 'node_a');
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
    makeProfileSavedPersister(
      fakeR2(putObject),
      fakeLogger(),
      owningDeps('node_a', 'prof_abc'),
    )(frame, 'node_a');
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
    makeProfileSavedPersister(
      fakeR2(putObject),
      fakeLogger(),
      owningDeps('node_a', 'prof_xyz'),
    )(frame, 'node_a');
    expect(putObject).not.toHaveBeenCalled();
  });

  it('a putObject rejection is logged, not thrown (receive loop must not crash)', async () => {
    const putObject = vi.fn().mockRejectedValue(new Error('r2 down'));
    const logger = fakeLogger();
    const persist = makeProfileSavedPersister(
      fakeR2(putObject),
      logger,
      owningDeps('node_a', 'p3'),
    );

    expect(() =>
      persist(
        {
          type: 'profileSaved',
          sessionId: 'ses_z',
          profile_id: 'p3',
          sealed_blob: 'YmxvYg==',
        },
        'node_a',
      ),
    ).not.toThrow();

    const errSpy = (logger as unknown as { error: ReturnType<typeof vi.fn> }).error;
    await vi.waitFor(() => expect(errSpy).toHaveBeenCalledTimes(1));
    expect(errSpy.mock.calls[0]![1]).toMatch(/failed to persist profile sealed-blob/);
  });
});

describe('makeProfileSavedPersister — cross-account ownership guard', () => {
  const ownerNodeId = 'node-owner';
  const frame: ProfileSaved = {
    type: 'profileSaved',
    sessionId: 'ses_x',
    profile_id: 'p1',
    sealed_blob: Buffer.from('opaque').toString('base64'),
  };

  it('writes when the session account owns the profile', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined);
    const persist = makeProfileSavedPersister(fakeR2(putObject), fakeLogger(), {
      agentSessions: {
        get: vi
          .fn()
          .mockResolvedValue({ accountId: 'acc_owner', nodeId: ownerNodeId, profileId: 'p1' }),
      },
      profiles: {
        findById: vi.fn().mockResolvedValue({ id: 'p1', accountId: 'acc_owner' }),
        recordSave: vi.fn().mockResolvedValue(undefined),
      },
    });
    persist(frame, ownerNodeId);
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1));
  });

  it('REFUSES a same-account alternate profile that is not bound to the session', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined);
    const findById = vi.fn().mockResolvedValue({ id: 'p_victim', accountId: 'acc_owner' });
    const recordSave = vi.fn().mockResolvedValue(undefined);
    const logger = fakeLogger();
    const persist = makeProfileSavedPersister(fakeR2(putObject), logger, {
      agentSessions: {
        get: vi
          .fn()
          .mockResolvedValue({ accountId: 'acc_owner', nodeId: ownerNodeId, profileId: 'p1' }),
      },
      profiles: { findById, recordSave },
    });

    persist({ ...frame, profile_id: 'p_victim' }, ownerNodeId);
    await new Promise((resolve) => setImmediate(resolve));

    expect(findById).not.toHaveBeenCalled();
    expect(putObject).not.toHaveBeenCalled();
    expect(recordSave).not.toHaveBeenCalled();
    expect((logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledWith(
      expect.objectContaining({ assignedProfileId: 'p1', reportedProfileId: 'p_victim' }),
      expect.stringContaining('does not match the session binding'),
    );
  });

  it('REFUSES an ephemeral session from writing any same-account profile', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined);
    const findById = vi.fn().mockResolvedValue({ id: 'p1', accountId: 'acc_owner' });
    const recordSave = vi.fn().mockResolvedValue(undefined);
    const persist = makeProfileSavedPersister(fakeR2(putObject), fakeLogger(), {
      agentSessions: {
        get: vi
          .fn()
          .mockResolvedValue({ accountId: 'acc_owner', nodeId: ownerNodeId, profileId: null }),
      },
      profiles: { findById, recordSave },
    });

    persist(frame, ownerNodeId);
    await new Promise((resolve) => setImmediate(resolve));

    expect(findById).not.toHaveBeenCalled();
    expect(putObject).not.toHaveBeenCalled();
    expect(recordSave).not.toHaveBeenCalled();
  });

  it('REFUSES the write when the profile is not owned by the session account (cross-account block)', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined);
    const logger = fakeLogger();
    const findById = vi.fn().mockResolvedValue(null); // profile not owned by this account
    const recordSave = vi.fn().mockResolvedValue(undefined);
    const persist = makeProfileSavedPersister(fakeR2(putObject), logger, {
      agentSessions: {
        get: vi
          .fn()
          .mockResolvedValue({ accountId: 'acc_attacker', nodeId: ownerNodeId, profileId: 'p1' }),
      },
      profiles: { findById, recordSave },
    });
    persist(frame, ownerNodeId);
    await vi.waitFor(() => expect(findById).toHaveBeenCalledTimes(1));
    expect(putObject).not.toHaveBeenCalled();
    // doc-150 item 5 — a refused (cross-account) save must NOT stamp size/time.
    expect(recordSave).not.toHaveBeenCalled();
    expect((logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalled();
  });

  it('REFUSES the write when the session is unknown', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined);
    const get = vi.fn().mockResolvedValue(null);
    const recordSave = vi.fn().mockResolvedValue(undefined);
    const persist = makeProfileSavedPersister(fakeR2(putObject), fakeLogger(), {
      agentSessions: { get },
      profiles: { findById: vi.fn(), recordSave },
    });
    persist(frame, ownerNodeId);
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    expect(putObject).not.toHaveBeenCalled();
    expect(recordSave).not.toHaveBeenCalled();
  });

  // #2 — a DB blip on the FIRST ownership await (agentSessions.get) must be
  // logged + the frame dropped, NEVER thrown out of the fire-and-forget handler
  // (an unhandled rejection would crash the control-plane process under Node 22).
  it('a rejecting agentSessions.get (DB blip) is logged, not thrown', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined);
    const logger = fakeLogger();
    const get = vi.fn().mockRejectedValue(new Error('neon compute quota exceeded'));
    const recordSave = vi.fn().mockResolvedValue(undefined);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const persist = makeProfileSavedPersister(fakeR2(putObject), logger, {
        agentSessions: { get },
        profiles: { findById: vi.fn(), recordSave },
      });
      expect(() => persist(frame, ownerNodeId)).not.toThrow();
      const errSpy = (logger as unknown as { error: ReturnType<typeof vi.fn> }).error;
      await vi.waitFor(() => expect(errSpy).toHaveBeenCalledTimes(1));
      expect(errSpy.mock.calls[0]![1]).toMatch(/ownership resolution/);
      expect(putObject).not.toHaveBeenCalled();
      expect(recordSave).not.toHaveBeenCalled();
      // No unhandled rejection escaped the persister.
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  // #2 — same for the SECOND ownership await (profiles.findById).
  it('a rejecting profiles.findById (DB blip) is logged, not thrown', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined);
    const logger = fakeLogger();
    const findById = vi.fn().mockRejectedValue(new Error('db connection reset'));
    const persist = makeProfileSavedPersister(fakeR2(putObject), logger, {
      agentSessions: {
        get: vi
          .fn()
          .mockResolvedValue({ accountId: 'acc_owner', nodeId: ownerNodeId, profileId: 'p1' }),
      },
      profiles: { findById, recordSave: vi.fn().mockResolvedValue(undefined) },
    });
    expect(() => persist(frame, ownerNodeId)).not.toThrow();
    const errSpy = (logger as unknown as { error: ReturnType<typeof vi.fn> }).error;
    await vi.waitFor(() => expect(errSpy).toHaveBeenCalledTimes(1));
    expect(errSpy.mock.calls[0]![1]).toMatch(/ownership resolution/);
    expect(putObject).not.toHaveBeenCalled();
  });

  it('REFUSES a profile save from a non-owning reporting node before profile lookup or R2', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined);
    const findById = vi.fn().mockResolvedValue({ id: 'p1', accountId: 'acc_owner' });
    const recordSave = vi.fn().mockResolvedValue(undefined);
    const persist = makeProfileSavedPersister(fakeR2(putObject), fakeLogger(), {
      agentSessions: {
        get: vi
          .fn()
          .mockResolvedValue({ accountId: 'acc_owner', nodeId: ownerNodeId, profileId: 'p1' }),
      },
      profiles: { findById, recordSave },
    });

    persist(frame, 'node-attacker');
    await new Promise((resolve) => setImmediate(resolve));

    expect(findById).not.toHaveBeenCalled();
    expect(putObject).not.toHaveBeenCalled();
    expect(recordSave).not.toHaveBeenCalled();
  });

  it('fails closed for a NULL-node session or missing reporting-node identity', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined);
    const recordSave = vi.fn().mockResolvedValue(undefined);
    const persist = makeProfileSavedPersister(fakeR2(putObject), fakeLogger(), {
      agentSessions: {
        get: vi.fn().mockResolvedValue({ accountId: 'acc_owner', nodeId: null, profileId: 'p1' }),
      },
      profiles: { findById: vi.fn(), recordSave },
    });

    persist(frame, ownerNodeId);
    persist(frame);
    await new Promise((resolve) => setImmediate(resolve));

    expect(putObject).not.toHaveBeenCalled();
    expect(recordSave).not.toHaveBeenCalled();
  });

  it('bounds unique-session DB/R2 work for one authenticated node', () => {
    const get = vi.fn(() => new Promise<never>(() => undefined));
    const logger = fakeLogger();
    const persist = makeProfileSavedPersister(fakeR2(vi.fn()), logger, {
      agentSessions: { get },
      profiles: { findById: vi.fn(), recordSave: vi.fn() },
    });

    for (let i = 0; i < BOUNDED_NODE_LATEST_RELAY_MAX_SESSIONS; i += 1) {
      persist({ ...frame, sessionId: `agt_${i}` }, ownerNodeId);
    }
    persist({ ...frame, sessionId: 'agt_overflow' }, ownerNodeId);
    persist({ ...frame, sessionId: 'agt_overflow_2' }, ownerNodeId);

    expect(get).toHaveBeenCalledTimes(BOUNDED_NODE_LATEST_RELAY_MAX_CONCURRENT);
    expect((logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledTimes(1);
    expect((logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reportingNodeId: ownerNodeId,
        sessionBudget: BOUNDED_NODE_LATEST_RELAY_MAX_SESSIONS,
        sessionId: 'agt_overflow',
      }),
      expect.stringContaining('exceeded its persistence session budget'),
    );
  });

  it('serializes a session save and coalesces pending blobs to the newest frame', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let lookups = 0;
    const putObject = vi.fn().mockResolvedValue(undefined);
    const get = vi.fn(async () => {
      lookups += 1;
      if (lookups === 1) await first;
      return { accountId: 'acc_owner', nodeId: ownerNodeId, profileId: 'p1' };
    });
    const persist = makeProfileSavedPersister(fakeR2(putObject), fakeLogger(), {
      agentSessions: { get },
      profiles: {
        findById: vi.fn().mockResolvedValue({ id: 'p1', accountId: 'acc_owner' }),
        recordSave: vi.fn().mockResolvedValue(undefined),
      },
    });

    persist({ ...frame, sealed_blob: Buffer.from('first').toString('base64') }, ownerNodeId);
    persist({ ...frame, sealed_blob: Buffer.from('superseded').toString('base64') }, ownerNodeId);
    persist({ ...frame, sealed_blob: Buffer.from('latest').toString('base64') }, ownerNodeId);
    expect(get).toHaveBeenCalledTimes(1);

    releaseFirst();
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(2));
    expect(get).toHaveBeenCalledTimes(2);
    const firstBody = (putObject.mock.calls[0]?.[0] as { body: Buffer } | undefined)?.body;
    const latestBody = (putObject.mock.calls[1]?.[0] as { body: Buffer } | undefined)?.body;
    expect(firstBody?.toString('utf8')).toBe('first');
    expect(latestBody?.toString('utf8')).toBe('latest');
  });
});

// doc-150 item 5 — the save-back metadata (size_bytes + last_saved_at) rides
// BOTH transport shapes (inline blob + presigned `stored:true` ack) and is
// recorded on the profile row via the ownership-scoped recordSave. Only wired
// when ownership deps are present (the resolved session-owner account scopes the
// write); a missing size_bytes leaves the column untouched (no clobber-with-NULL).
describe('makeProfileSavedPersister — size_bytes / last_saved_at metadata (doc-150 item 5)', () => {
  const ownerNodeId = 'node-owner';
  it('inline shape with size_bytes: records the save (size_bytes + last_saved_at) scoped to the owner account', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined);
    const recordSave = vi.fn().mockResolvedValue(undefined);
    const persist = makeProfileSavedPersister(fakeR2(putObject), fakeLogger(), {
      agentSessions: {
        get: vi
          .fn()
          .mockResolvedValue({ accountId: 'acc_owner', nodeId: ownerNodeId, profileId: 'p1' }),
      },
      profiles: {
        findById: vi.fn().mockResolvedValue({ id: 'p1', accountId: 'acc_owner' }),
        recordSave,
      },
    });
    persist(
      {
        type: 'profileSaved',
        sessionId: 'ses_x',
        profile_id: 'p1',
        sealed_blob: Buffer.from('opaque').toString('base64'),
        size_bytes: 4096,
      },
      ownerNodeId,
    );
    await vi.waitFor(() => expect(recordSave).toHaveBeenCalledTimes(1));
    const arg = recordSave.mock.calls[0]![0] as {
      id: string;
      accountId: string;
      at: Date;
      sizeBytes?: number;
    };
    expect(arg.id).toBe('p1');
    expect(arg.accountId).toBe('acc_owner');
    expect(arg.sizeBytes).toBe(4096);
    expect(arg.at).toBeInstanceOf(Date);
    expect(putObject).toHaveBeenCalledTimes(1);
  });

  it('large (stored:true) shape with size_bytes: records the save even though no R2 write happens', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined);
    const recordSave = vi.fn().mockResolvedValue(undefined);
    const persist = makeProfileSavedPersister(fakeR2(putObject), fakeLogger(), {
      agentSessions: {
        get: vi
          .fn()
          .mockResolvedValue({ accountId: 'acc_owner', nodeId: ownerNodeId, profileId: 'p2' }),
      },
      profiles: {
        findById: vi.fn().mockResolvedValue({ id: 'p2', accountId: 'acc_owner' }),
        recordSave,
      },
    });
    persist(
      {
        type: 'profileSaved',
        sessionId: 'ses_y',
        profile_id: 'p2',
        stored: true,
        size_bytes: 9_000_000_000, // multi-GiB metadata; no blob retained in this frame
      },
      ownerNodeId,
    );
    await vi.waitFor(() => expect(recordSave).toHaveBeenCalledTimes(1));
    expect(recordSave.mock.calls[0]![0]).toMatchObject({
      id: 'p2',
      accountId: 'acc_owner',
      sizeBytes: 9_000_000_000,
    });
    expect(putObject).not.toHaveBeenCalled();
  });

  it('omitted size_bytes (pre-emit harness): still stamps last_saved_at but passes no sizeBytes (no clobber-with-NULL)', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined);
    const recordSave = vi.fn().mockResolvedValue(undefined);
    const persist = makeProfileSavedPersister(fakeR2(putObject), fakeLogger(), {
      agentSessions: {
        get: vi
          .fn()
          .mockResolvedValue({ accountId: 'acc_owner', nodeId: ownerNodeId, profileId: 'p3' }),
      },
      profiles: {
        findById: vi.fn().mockResolvedValue({ id: 'p3', accountId: 'acc_owner' }),
        recordSave,
      },
    });
    persist(
      {
        type: 'profileSaved',
        sessionId: 'ses_z',
        profile_id: 'p3',
        sealed_blob: 'YmxvYg==',
      },
      ownerNodeId,
    );
    await vi.waitFor(() => expect(recordSave).toHaveBeenCalledTimes(1));
    const arg = recordSave.mock.calls[0]![0] as { sizeBytes?: number; at: Date };
    expect(arg.sizeBytes).toBeUndefined();
    expect(arg.at).toBeInstanceOf(Date);
  });

  it('a recordSave rejection is logged, not thrown (receive loop must not crash)', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined);
    const logger = fakeLogger();
    const recordSave = vi.fn().mockRejectedValue(new Error('db down'));
    const persist = makeProfileSavedPersister(fakeR2(putObject), logger, {
      agentSessions: {
        get: vi
          .fn()
          .mockResolvedValue({ accountId: 'acc_owner', nodeId: ownerNodeId, profileId: 'p1' }),
      },
      profiles: {
        findById: vi.fn().mockResolvedValue({ id: 'p1', accountId: 'acc_owner' }),
        recordSave,
      },
    });
    expect(() =>
      persist(
        {
          type: 'profileSaved',
          sessionId: 'ses_x',
          profile_id: 'p1',
          sealed_blob: 'YmxvYg==',
          size_bytes: 1,
        },
        ownerNodeId,
      ),
    ).not.toThrow();
    const errSpy = (logger as unknown as { error: ReturnType<typeof vi.fn> }).error;
    await vi.waitFor(() => expect(errSpy).toHaveBeenCalledTimes(1));
    expect(errSpy.mock.calls[0]![1]).toMatch(/failed to record profile save metadata/);
  });

  it('does not stamp save metadata when an inline R2 write fails', async () => {
    const putObject = vi.fn().mockRejectedValue(new Error('r2 down'));
    const recordSave = vi.fn().mockResolvedValue(undefined);
    const logger = fakeLogger();
    const persist = makeProfileSavedPersister(fakeR2(putObject), logger, {
      agentSessions: {
        get: vi
          .fn()
          .mockResolvedValue({ accountId: 'acc_owner', nodeId: ownerNodeId, profileId: 'p1' }),
      },
      profiles: {
        findById: vi.fn().mockResolvedValue({ id: 'p1', accountId: 'acc_owner' }),
        recordSave,
      },
    });

    persist(
      {
        type: 'profileSaved',
        sessionId: 'ses_x',
        profile_id: 'p1',
        sealed_blob: 'YmxvYg==',
      },
      ownerNodeId,
    );

    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1));
    expect(recordSave).not.toHaveBeenCalled();
  });
});

describe('buildAssignProfileBlock (step (e) restore side — crypto-free R2 half)', () => {
  function r2For(exists: boolean) {
    const headObject = vi.fn().mockResolvedValue({ exists });
    const presignPut = vi.fn().mockResolvedValue('https://r2/put?sig=PUT');
    const presignGet = vi.fn().mockResolvedValue('https://r2/get?sig=GET');
    const r2 = {
      bucket: 'test-bucket',
      putObject: vi.fn(),
      headObject,
      presignPut,
      presignGet,
    } as unknown as R2;
    return { r2, headObject, presignPut, presignGet };
  }

  it('existing profile: mints both a GET (restore) and a PUT (save-back) URL keyed by profileSealedBlobKey', async () => {
    const { r2, presignPut, presignGet } = r2For(true);
    const block = await buildAssignProfileBlock(r2, 'prof_abc', 'ZGVr');
    expect(block).toEqual({
      profileId: 'prof_abc',
      dek: 'ZGVr',
      sealedBlobUrl: 'https://r2/get?sig=GET',
      sealedBlobPutUrl: 'https://r2/put?sig=PUT',
    });
    const key = profileSealedBlobKey('prof_abc');
    expect(presignGet.mock.calls[0]![0]).toMatchObject({ key });
    expect(presignPut.mock.calls[0]![0]).toMatchObject({
      key,
      contentType: 'application/octet-stream',
    });
  });

  it('fresh profile (no prior store): mints only a PUT URL — no restore GET (harness starts stateless)', async () => {
    const { r2, presignGet } = r2For(false);
    const block = await buildAssignProfileBlock(r2, 'prof_new', 'ZGVr');
    expect(block).toEqual({
      profileId: 'prof_new',
      dek: 'ZGVr',
      sealedBlobPutUrl: 'https://r2/put?sig=PUT',
    });
    expect(block.sealedBlobUrl).toBeUndefined();
    expect(presignGet).not.toHaveBeenCalled();
  });

  it('save-back PUT URL TTL outlives the session: default ≥1800s session max; caller TTL honored + clamped to the 7-day ceiling', async () => {
    // default TTL must exceed the 1800s default max session (else the save-back
    // URL minted at assign expires mid-session → silent profile-data loss).
    const d = r2For(true);
    await buildAssignProfileBlock(d.r2, 'prof_abc', 'ZGVr');
    const defaultTtl = (d.presignPut.mock.calls[0]![0] as { expiresIn: number }).expiresIn;
    expect(defaultTtl).toBeGreaterThanOrEqual(1800);
    // both PUT + GET share the TTL
    expect((d.presignGet.mock.calls[0]![0] as { expiresIn: number }).expiresIn).toBe(defaultTtl);

    // caller override honored
    const c = r2For(true);
    await buildAssignProfileBlock(c.r2, 'prof_abc', 'ZGVr', { urlTtlSeconds: 5400 });
    expect((c.presignPut.mock.calls[0]![0] as { expiresIn: number }).expiresIn).toBe(5400);

    // clamped to the R2 7-day presign ceiling
    const big = r2For(false);
    await buildAssignProfileBlock(big.r2, 'prof_abc', 'ZGVr', { urlTtlSeconds: 99_999_999 });
    expect((big.presignPut.mock.calls[0]![0] as { expiresIn: number }).expiresIn).toBe(
      7 * 24 * 60 * 60,
    );
  });

  it('least-privilege: the restore GET TTL is capped at the 1h restore window even when the PUT TTL is longer', async () => {
    // The restore GET is consumed at session START, not teardown, so it must NOT
    // inherit the long save-back PUT TTL. With a 4.5h caller TTL, the PUT gets
    // the full value but the GET is capped at the 3600s restore window.
    const c = r2For(true);
    await buildAssignProfileBlock(c.r2, 'prof_abc', 'ZGVr', { urlTtlSeconds: 16200 });
    expect((c.presignPut.mock.calls[0]![0] as { expiresIn: number }).expiresIn).toBe(16200);
    expect((c.presignGet.mock.calls[0]![0] as { expiresIn: number }).expiresIn).toBe(3600);

    // A shorter-than-restore-window caller TTL shrinks BOTH (the GET never
    // exceeds the PUT TTL).
    const s = r2For(true);
    await buildAssignProfileBlock(s.r2, 'prof_abc', 'ZGVr', { urlTtlSeconds: 600 });
    expect((s.presignPut.mock.calls[0]![0] as { expiresIn: number }).expiresIn).toBe(600);
    expect((s.presignGet.mock.calls[0]![0] as { expiresIn: number }).expiresIn).toBe(600);
  });

  it('the block feeds serializeSessionAssign.profile → valid snake_case wire (sealed_blob_url + sealed_blob_put_url)', async () => {
    const { r2 } = r2For(true);
    const block = await buildAssignProfileBlock(r2, 'prof_abc', 'ZGVr');
    const assign = serializeSessionAssign({
      sessionId: 'ses_1',
      archetype: 'iphone17_ios18_7_safari26_4',
      behaviorProfile: 'regular',
      profile: block,
    });
    expect(SessionAssignSchema.safeParse(assign).success).toBe(true);
    expect(assign.profile).toEqual({
      profile_id: 'prof_abc',
      dek: 'ZGVr',
      sealed_blob_url: 'https://r2/get?sig=GET',
      sealed_blob_put_url: 'https://r2/put?sig=PUT',
    });
  });
});
