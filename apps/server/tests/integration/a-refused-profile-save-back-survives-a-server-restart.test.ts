// The refusal to save a profile back is durable: a server restart between
// dispatch and save-back does not lose it.
//
// A session dispatched without its profile's stored state (the R2 url-mint
// degrade here) starts from an empty profile. The device queues its teardown
// `profileSaved` across disconnects, so the frame can arrive at a DIFFERENT
// process from the one that dispatched — after a deploy, a crash, a restart. If
// the refusal lived only in that first process's memory, the second would accept
// the frame and write the empty profile over the customer's stored one.
//
// So this runs the real dispatch against a real Postgres, closes that database
// handle and every repo built on it, opens fresh ones as a restarted process
// would, and hands the frame to a consumer built only from the fresh handles.
// The control is a session that DID restore its profile: through the same
// restart, its save lands and stamps last_saved_at.

import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleAgentSessionsRepo } from '../../src/db/agent-sessions-repo.js';
import { DrizzleProfilesRepo } from '../../src/db/profiles-repo.js';
import type { DrizzleFleetNodesRepo } from '../../src/db/fleet-nodes-repo.js';
import {
  dispatchSessionAssignOnCreate,
  type SessionDispatchConfig,
} from '../../src/routes/agent-sessions.js';
import { FleetControlRegistry } from '../../src/services/fleet-control-registry.js';
import { encryptLivekitSecret } from '../../src/lib/livekit-secret-encryption.js';
import { makeProfileSavedPersister } from '../../src/services/profile-store.js';
import type { ProfilesService } from '../../src/services/profiles.js';
import { profileSealedBlobKey, type R2 } from '../../src/lib/r2.js';

const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const DB_URL =
  process.env.DATABASE_URL ?? 'postgres://driftstack:driftstack@localhost:5432/driftstack';

const KEY = Buffer.alloc(32, 7).toString('base64');
const TRANSCRIPT_KEY = randomBytes(32).toString('base64');
const NODE_ID = 'restart-test-node';
const NODE_UUID = '33333333-3333-4333-8333-333333333333';
const DISPATCH: SessionDispatchConfig = {
  archetype: 'iphone16pro_ios18_6_safari18_6',
  behaviorProfile: 'regular',
  initialUrl: 'https://example.com',
};
const STORED = Buffer.from('the customer profile as it was stored');
const FRESH = Buffer.from('an empty profile sealed at teardown');

let raw: postgres.Sql | null = null;
const seededAccounts: string[] = [];

function sql(): postgres.Sql {
  if (raw === null) throw new Error('database unreachable');
  return raw;
}

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  raw = postgres(DB_URL, { max: 2, onnotice: () => {} });
  await raw`SELECT profile_save_back_refused FROM agent_sessions LIMIT 0`;
});

afterAll(async () => {
  if (raw === null) return;
  for (const accountId of seededAccounts) {
    await raw`DELETE FROM agent_sessions WHERE account_id = ${accountId}`.catch(() => {});
    await raw`DELETE FROM profiles WHERE account_id = ${accountId}`.catch(() => {});
    await raw`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
  }
  await raw.end({ timeout: 5 });
});

async function seedAccountAndProfile(): Promise<{ accountId: string; profileId: string }> {
  const accountId = randomUUID();
  seededAccounts.push(accountId);
  await sql()`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`save-back-${accountId}@test.local`})`;
  const profileId = randomUUID();
  await sql()`INSERT INTO profiles (id, account_id, name) VALUES (${profileId}, ${accountId}, ${`p-${profileId.slice(0, 8)}`})`;
  return { accountId, profileId };
}

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

/** R2 that stores bytes; `mintFails` makes the dispatch's URL mint reject. */
function byteStoreR2(profileId: string, mintFails: boolean) {
  const objects = new Map<string, Buffer>([[profileSealedBlobKey(profileId), STORED]]);
  const r2 = {
    bucket: 'test-bucket',
    putObject: vi.fn((args: { key: string; body: Buffer }) => {
      objects.set(args.key, Buffer.from(args.body));
      return Promise.resolve();
    }),
    deleteObject: vi.fn(),
    headObject: vi.fn((key: string) =>
      mintFails
        ? Promise.reject(new Error('r2 unavailable'))
        : Promise.resolve({ exists: objects.has(key) }),
    ),
    presignPut: vi.fn(() =>
      mintFails
        ? Promise.reject(new Error('r2 unavailable'))
        : Promise.resolve('https://r2.test/put'),
    ),
    presignGet: vi.fn(() => Promise.resolve('https://r2.test/get')),
    listObjects: vi.fn(),
  } as unknown as R2;
  return { r2, stored: () => objects.get(profileSealedBlobKey(profileId)) };
}

/** Process ONE: create the session and dispatch it, then shut the handle down. */
async function dispatchThenStop(args: {
  accountId: string;
  profileId: string;
  r2: R2;
}): Promise<string> {
  const database: Database = createDb(DB_URL, { max: 2 });
  try {
    const sessions = new DrizzleAgentSessionsRepo(database, {
      transcriptEncryptionKeyBase64: TRANSCRIPT_KEY,
    });
    const created = await sessions.create({
      accountId: args.accountId,
      tokenBudgetTotal: 100_000,
      profileId: args.profileId,
    });
    const sent: string[] = [];
    const registry = new FleetControlRegistry();
    registry.register(NODE_ID, (d) => sent.push(d));
    await dispatchSessionAssignOnCreate({
      ownerTier: 'api_builder',
      sessionId: created.id,
      fleetControlRegistry: registry,
      fleetNodesRepo: fleetNodes(),
      livekitSecretEncryptionKey: KEY,
      sessionDispatch: DISPATCH,
      accountId: args.accountId,
      profileId: args.profileId,
      profilesService: {
        get: () => Promise.resolve({ archetype: DISPATCH.archetype }),
        getProfileDek: () => Promise.resolve(Buffer.alloc(32, 1)),
      } as unknown as ProfilesService,
      r2: args.r2,
      agentSessions: sessions,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    expect(sent).toHaveLength(1);
    return created.id;
  } finally {
    await database.close();
  }
}

/** Process TWO: a fresh handle and fresh repos receive the queued save-back. */
async function restartThenReceive(args: {
  sessionId: string;
  profileId: string;
  r2: R2;
}): Promise<{ enqueueEvent: ReturnType<typeof vi.fn> }> {
  const database: Database = createDb(DB_URL, { max: 2 });
  const enqueueEvent = vi.fn().mockResolvedValue(1);
  const recordSave = vi.fn();
  try {
    const profiles = new DrizzleProfilesRepo(database);
    recordSave.mockImplementation((a: Parameters<DrizzleProfilesRepo['recordSave']>[0]) =>
      profiles.recordSave(a),
    );
    const persist = makeProfileSavedPersister(
      args.r2,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      {
        agentSessions: new DrizzleAgentSessionsRepo(database, {
          transcriptEncryptionKeyBase64: TRANSCRIPT_KEY,
        }),
        profiles: { findById: (a) => profiles.findById(a), recordSave },
        webhooks: { enqueueEvent },
      },
    );
    persist(
      {
        type: 'profileSaved',
        sessionId: args.sessionId,
        profile_id: args.profileId,
        sealed_blob: FRESH.toString('base64'),
        size_bytes: FRESH.length,
      },
      NODE_ID,
    );
    await vi.waitFor(
      () => expect(recordSave.mock.calls.length + enqueueEvent.mock.calls.length).toBe(1),
      { timeout: 5_000 },
    );
    // Let a recordSave that was called finish its UPDATE before the handle closes.
    await Promise.all(recordSave.mock.results.map((r) => r.value as Promise<void>));
  } finally {
    await database.close();
  }
  return { enqueueEvent };
}

async function lastSavedAt(profileId: string): Promise<Date | null> {
  const rows = await sql()<{ last_saved_at: Date | null }[]>`
    SELECT last_saved_at FROM profiles WHERE id = ${profileId}`;
  return rows[0]?.last_saved_at ?? null;
}

describe.skipIf(!RUN_DB_TESTS)('a refused profile save-back survives a server restart', () => {
  it('CRITICAL a url-mint-degraded session is still refused by a restarted process: the stored profile is unchanged', async () => {
    const { accountId, profileId } = await seedAccountAndProfile();
    const store = byteStoreR2(profileId, true);
    const sessionId = await dispatchThenStop({ accountId, profileId, r2: store.r2 });

    const rows = await sql()<{ refused: boolean }[]>`
      SELECT profile_save_back_refused AS refused FROM agent_sessions WHERE id = ${sessionId}`;
    expect(rows[0]?.refused).toBe(true);

    const { enqueueEvent } = await restartThenReceive({ sessionId, profileId, r2: store.r2 });
    expect(store.stored()?.equals(STORED), 'the stored profile was replaced').toBe(true);
    expect(await lastSavedAt(profileId)).toBeNull();
    expect(enqueueEvent).toHaveBeenCalledWith(accountId, 'session.profile_save_failed', {
      session_id: sessionId,
      profile_id: profileId,
      reason: 'profile_not_loaded',
      detail:
        "The profile could not be loaded when this session started, so this session's changes were not saved to it.",
    });
  });

  it('control: a session that restored its profile saves back through the same restart', async () => {
    const { accountId, profileId } = await seedAccountAndProfile();
    const store = byteStoreR2(profileId, false);
    const sessionId = await dispatchThenStop({ accountId, profileId, r2: store.r2 });

    const rows = await sql()<{ refused: boolean }[]>`
      SELECT profile_save_back_refused AS refused FROM agent_sessions WHERE id = ${sessionId}`;
    expect(rows[0]?.refused).toBe(false);

    const { enqueueEvent } = await restartThenReceive({ sessionId, profileId, r2: store.r2 });
    expect(store.stored()?.equals(FRESH)).toBe(true);
    expect(await lastSavedAt(profileId)).not.toBeNull();
    expect(enqueueEvent).not.toHaveBeenCalled();
  });
});
