// A session that did not start from its profile's stored state must never
// replace that state at teardown.
//
// The data-loss path this pins: session create dispatches a profile-backed
// sessionAssign. When minting the profile's R2 restore/save-back URLs fails, the
// dispatch used to degrade to a DEK-only block — the device got the profile id
// and the DEK but no restore URL, so it started from an EMPTY profile. At teardown
// it sealed that fresh state and sent an inline `profileSaved`, and the consumer
// wrote it to R2 over the customer's real stored profile (cookies, logins, site
// data). The comment said the session "won't restore/persist profile state this
// run"; only the first half was true.
//
// The fix records, on the session row, that save-back is refused whenever the
// dispatch could not give the device the profile's existing state, and the
// profileSaved consumer refuses (and tells the customer) for such a session. The
// two controls matter as much as the refusals: a normal restore saves, and a
// first-ever profile with nothing stored yet saves — that first save is how a
// profile gets any state at all.
//
// Everything here goes through the real dispatch, the real in-memory session
// repo and the real consumer; only the device and R2 are fakes. The R2 fake is a
// real byte store, so "the stored blob is unchanged" is a comparison of bytes,
// not an assertion that some spy was not called.

import { describe, expect, it, vi } from 'vitest';
import {
  dispatchSessionAssignOnCreate,
  type SessionDispatchConfig,
} from '../../src/routes/agent-sessions.js';
import { FleetControlRegistry } from '../../src/services/fleet-control-registry.js';
import { encryptLivekitSecret } from '../../src/lib/livekit-secret-encryption.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import { makeProfileSavedPersister } from '../../src/services/profile-store.js';
import { makeProfileSaveFailedRelay } from '../../src/services/profile-save-failed-relay.js';
import { profileSealedBlobKey, type R2 } from '../../src/lib/r2.js';
import type { DrizzleFleetNodesRepo } from '../../src/db/fleet-nodes-repo.js';
import type { ProfilesService } from '../../src/services/profiles.js';
import type { WebhookEventType } from '../../src/services/webhooks.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const NODE_ID = 'local-mac-dev-001';
const NODE_UUID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = 'acc_owner';
const PROFILE = '22222222-2222-4222-8222-222222222222';
const DEK = Buffer.alloc(32, 1);

const DISPATCH: SessionDispatchConfig = {
  archetype: 'iphone16pro_ios18_6_safari18_6',
  behaviorProfile: 'regular',
  initialUrl: 'https://example.com',
};

const STORED = Buffer.from('the customer profile: cookies, logins, site data');
const FRESH = Buffer.from('an empty profile sealed at teardown');

function fleetNodes(): DrizzleFleetNodesRepo {
  const apiKey = 'devkey';
  const wsUrl = 'ws://localhost:7880';
  const mac = {
    id: NODE_UUID,
    nodeId: NODE_ID,
    publicKeyBase64Url: 'pk',
    registeredAt: new Date(),
    revokedAt: null,
    livekit: {
      apiKey,
      apiSecretCiphertextBase64: encryptLivekitSecret('secret', KEY, {
        nodeId: NODE_UUID,
        apiKey,
        wsUrl,
      }),
      wsUrl,
      registeredAt: new Date(),
    },
  };
  return {
    findAnyWithLivekit: () => Promise.resolve(mac),
    findNearestWithLivekit: () => Promise.resolve(mac),
  } as unknown as DrizzleFleetNodesRepo;
}

/** An R2 that really stores bytes. `mintFails` makes the URL mint reject, which
 *  is the failure buildAssignProfileBlock turns into the dispatch degrade. */
function byteStoreR2(opts: { stored?: Buffer; mintFails?: boolean } = {}) {
  const objects = new Map<string, Buffer>();
  if (opts.stored !== undefined) objects.set(profileSealedBlobKey(PROFILE), opts.stored);
  const putObject = vi.fn((args: { key: string; body: Buffer }) => {
    objects.set(args.key, Buffer.from(args.body));
    return Promise.resolve();
  });
  const r2 = {
    bucket: 'test-bucket',
    putObject,
    deleteObject: vi.fn(),
    headObject: vi.fn((key: string) =>
      opts.mintFails === true
        ? Promise.reject(new Error('r2 unavailable'))
        : Promise.resolve({ exists: objects.has(key) }),
    ),
    presignPut: vi.fn(() =>
      opts.mintFails === true
        ? Promise.reject(new Error('r2 unavailable'))
        : Promise.resolve('https://r2.test/put'),
    ),
    presignGet: vi.fn(() => Promise.resolve('https://r2.test/get')),
    listObjects: vi.fn(),
  } as unknown as R2;
  return { r2, putObject, stored: () => objects.get(profileSealedBlobKey(PROFILE)) };
}

function profilesService(dek: 'ok' | 'unwrap-fails' = 'ok'): ProfilesService {
  return {
    get: () => Promise.resolve({ archetype: DISPATCH.archetype }),
    getProfileDek: () =>
      dek === 'ok'
        ? Promise.resolve(DEK)
        : Promise.reject(new Error('unsupported state or unable to authenticate data')),
  } as unknown as ProfilesService;
}

function quietLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

interface Launched {
  sessionId: string;
  sessions: InMemoryAgentSessionsRepo;
  assign: Record<string, unknown>;
}

async function launch(args: {
  r2?: R2;
  dek?: 'ok' | 'unwrap-fails';
  sessions?: InMemoryAgentSessionsRepo | null;
}): Promise<Launched> {
  const sent: string[] = [];
  const registry = new FleetControlRegistry();
  registry.register(NODE_ID, (d) => sent.push(d));
  const sessions =
    args.sessions === null ? null : (args.sessions ?? new InMemoryAgentSessionsRepo());
  const holder = new InMemoryAgentSessionsRepo();
  const created = await (sessions ?? holder).create({
    accountId: ACCOUNT,
    tokenBudgetTotal: 100_000,
    profileId: PROFILE,
  });
  await dispatchSessionAssignOnCreate({
    ownerTier: 'api_builder',
    sessionId: created.id,
    fleetControlRegistry: registry,
    fleetNodesRepo: fleetNodes(),
    livekitSecretEncryptionKey: KEY,
    sessionDispatch: DISPATCH,
    accountId: ACCOUNT,
    profileId: PROFILE,
    profilesService: profilesService(args.dek),
    ...(args.r2 !== undefined ? { r2: args.r2 } : {}),
    ...(sessions !== null ? { agentSessions: sessions } : {}),
    logger: quietLogger(),
  });
  expect(sent, 'the dispatch must still start the session').toHaveLength(1);
  return {
    sessionId: created.id,
    sessions: sessions ?? holder,
    assign: JSON.parse(sent[0]!) as Record<string, unknown>,
  };
}

function consumer(r2: R2, sessions: InMemoryAgentSessionsRepo) {
  const logger = quietLogger();
  const recordSave = vi.fn().mockResolvedValue(undefined);
  const enqueueEvent = vi.fn(
    (_accountId: string, _type: WebhookEventType, _data: Record<string, unknown>) =>
      Promise.resolve(1),
  );
  const persist = makeProfileSavedPersister(r2, logger as never, {
    agentSessions: sessions,
    profiles: {
      findById: vi.fn().mockResolvedValue({ id: PROFILE, accountId: ACCOUNT }),
      recordSave,
    },
    webhooks: { enqueueEvent },
  });
  return { persist, logger, recordSave, enqueueEvent };
}

/** The consumer is fire-and-forget: wait until it has either saved or refused. */
async function settled(c: ReturnType<typeof consumer>): Promise<void> {
  await vi.waitFor(() =>
    expect(c.recordSave.mock.calls.length + c.enqueueEvent.mock.calls.length).toBe(1),
  );
}

const REFUSAL = {
  reason: 'profile_not_loaded',
  detail:
    "The profile could not be loaded when this session started, so this session's changes were not saved to it.",
};

describe('a session that did not start from its stored profile cannot save over it', () => {
  it('CRITICAL url-mint failure, then an inline profileSaved: the stored blob is unchanged and the customer is told why', async () => {
    const store = byteStoreR2({ stored: STORED, mintFails: true });
    const { sessionId, sessions, assign } = await launch({ r2: store.r2 });

    // The device was given no way to write R2 itself: no save-back PUT URL.
    const profile = assign.profile as Record<string, unknown> | undefined;
    expect(profile?.sealed_blob_url).toBeUndefined();
    expect(profile?.sealed_blob_put_url).toBeUndefined();

    const c = consumer(store.r2, sessions);
    c.persist(
      {
        type: 'profileSaved',
        sessionId,
        profile_id: PROFILE,
        sealed_blob: FRESH.toString('base64'),
        size_bytes: FRESH.length,
      },
      NODE_ID,
    );
    await settled(c);

    expect(store.stored()?.equals(STORED), 'the stored profile was replaced').toBe(true);
    expect(store.putObject).not.toHaveBeenCalled();
    expect((await sessions.get(sessionId))?.profileSaveBackRefused).toBe(true);
    expect(c.recordSave).not.toHaveBeenCalled();
    expect(c.enqueueEvent).toHaveBeenCalledWith(ACCOUNT, 'session.profile_save_failed', {
      session_id: sessionId,
      profile_id: PROFILE,
      ...REFUSAL,
    });
    // One WARN, naming the session and the profile, and never the content.
    expect(c.logger.warn).toHaveBeenCalledTimes(1);
    const [fields] = c.logger.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({ sessionId, profileId: PROFILE });
    expect(JSON.stringify(c.logger.warn.mock.calls)).not.toContain(FRESH.toString('base64'));
  });

  it('CRITICAL url-mint failure, then a presigned stored:true ack: no save is recorded and the customer is told why', async () => {
    // No PUT URL was minted for this session, so a contract-following device
    // cannot send this. It is refused anyway: a PUT through some OTHER URL for
    // this profile must not be recorded as this session's save.
    const store = byteStoreR2({ stored: STORED, mintFails: true });
    const { sessionId, sessions } = await launch({ r2: store.r2 });
    const c = consumer(store.r2, sessions);
    c.persist(
      { type: 'profileSaved', sessionId, profile_id: PROFILE, stored: true, size_bytes: 99 },
      NODE_ID,
    );
    await vi.waitFor(() => expect(c.enqueueEvent).toHaveBeenCalledTimes(1));
    expect(c.recordSave).not.toHaveBeenCalled();
    expect(c.enqueueEvent.mock.calls[0]?.[2]).toMatchObject(REFUSAL);
    expect(c.logger.warn).toHaveBeenCalledTimes(1);
  });

  it('CRITICAL DEK-unwrap failure: the device gets no profile block, and a save for the session is refused', async () => {
    const store = byteStoreR2({ stored: STORED });
    const { sessionId, sessions, assign } = await launch({ r2: store.r2, dek: 'unwrap-fails' });
    expect(assign.profile).toBeUndefined();

    const c = consumer(store.r2, sessions);
    c.persist(
      {
        type: 'profileSaved',
        sessionId,
        profile_id: PROFILE,
        sealed_blob: FRESH.toString('base64'),
      },
      NODE_ID,
    );
    await settled(c);
    expect(store.stored()?.equals(STORED), 'the stored profile was replaced').toBe(true);
    expect(c.recordSave).not.toHaveBeenCalled();
    expect(c.enqueueEvent).toHaveBeenCalledTimes(1);
    expect((await sessions.get(sessionId))?.profileSaveBackRefused).toBe(true);
  });

  it('control: a session that restored the stored profile saves back over it', async () => {
    const store = byteStoreR2({ stored: STORED });
    const { sessionId, sessions, assign } = await launch({ r2: store.r2 });
    const profile = assign.profile as Record<string, unknown>;
    expect(profile.sealed_blob_url).toBe('https://r2.test/get');
    expect(profile.sealed_blob_put_url).toBe('https://r2.test/put');
    expect((await sessions.get(sessionId))?.profileSaveBackRefused).toBe(false);

    const c = consumer(store.r2, sessions);
    c.persist(
      {
        type: 'profileSaved',
        sessionId,
        profile_id: PROFILE,
        sealed_blob: FRESH.toString('base64'),
      },
      NODE_ID,
    );
    await vi.waitFor(() => expect(c.recordSave).toHaveBeenCalledTimes(1));
    expect(store.stored()?.equals(FRESH)).toBe(true);
    expect(c.enqueueEvent).not.toHaveBeenCalled();
    expect(c.logger.warn).not.toHaveBeenCalled();
  });

  it('control: a first-ever profile with nothing stored yet saves its first state', async () => {
    const store = byteStoreR2();
    const { sessionId, sessions, assign } = await launch({ r2: store.r2 });
    const profile = assign.profile as Record<string, unknown>;
    expect(profile.sealed_blob_url).toBeUndefined();
    expect(profile.sealed_blob_put_url).toBe('https://r2.test/put');
    expect((await sessions.get(sessionId))?.profileSaveBackRefused).toBe(false);

    const c = consumer(store.r2, sessions);
    c.persist(
      {
        type: 'profileSaved',
        sessionId,
        profile_id: PROFILE,
        sealed_blob: FRESH.toString('base64'),
      },
      NODE_ID,
    );
    await vi.waitFor(() => expect(c.recordSave).toHaveBeenCalledTimes(1));
    expect(store.stored()?.equals(FRESH)).toBe(true);
    expect(c.enqueueEvent).not.toHaveBeenCalled();
  });

  it('with no R2 at dispatch nothing could be restored, so save-back is refused for the session', async () => {
    // Whether a stored blob exists cannot be known without R2. A save queued on
    // the device must not land later, after a restart that brought R2 back.
    const { sessionId, sessions } = await launch({});
    expect((await sessions.get(sessionId))?.profileSaveBackRefused).toBe(true);
  });

  it('a degrade with nowhere to record the refusal sends the device no DEK at all', async () => {
    const store = byteStoreR2({ stored: STORED, mintFails: true });
    const { assign } = await launch({ r2: store.r2, sessions: null });
    expect(assign.profile).toBeUndefined();
  });

  it('a profileSaveFailed from a session that did not load its profile is reported as that, not as the device failure', async () => {
    const store = byteStoreR2({ stored: STORED, mintFails: true });
    const { sessionId, sessions } = await launch({ r2: store.r2 });
    const enqueueEvent = vi.fn().mockResolvedValue(1);
    const relay = makeProfileSaveFailedRelay(sessions, { enqueueEvent }, quietLogger() as never);
    relay(
      {
        type: 'profileSaveFailed',
        sessionId,
        profile_id: PROFILE,
        reason: 'upload_failed',
        detail: 'no save-back URL',
      },
      NODE_ID,
    );
    await vi.waitFor(() => expect(enqueueEvent).toHaveBeenCalledTimes(1));
    expect(enqueueEvent).toHaveBeenCalledWith(ACCOUNT, 'session.profile_save_failed', {
      session_id: sessionId,
      profile_id: PROFILE,
      ...REFUSAL,
    });
  });

  it('control: a profileSaveFailed from a session that restored its profile keeps the device reason', async () => {
    const store = byteStoreR2({ stored: STORED });
    const { sessionId, sessions } = await launch({ r2: store.r2 });
    const enqueueEvent = vi.fn().mockResolvedValue(1);
    const relay = makeProfileSaveFailedRelay(sessions, { enqueueEvent }, quietLogger() as never);
    relay(
      { type: 'profileSaveFailed', sessionId, profile_id: PROFILE, reason: 'too_large' },
      NODE_ID,
    );
    await vi.waitFor(() => expect(enqueueEvent).toHaveBeenCalledTimes(1));
    expect(enqueueEvent.mock.calls[0]?.[2]).toEqual({
      session_id: sessionId,
      profile_id: PROFILE,
      reason: 'too_large',
    });
  });
});
