// V-553.B-19 — unit tests for ProfileSnapshotsService (V-312).
//
// Surface under test:
//   - capture(): 404 when parent profile missing / cross-account,
//     happy path snapshots metadata with empty state_blob
//   - list(): repo pass-through
//   - get(): 404 on missing, returns row on hit
//   - restore(): 404 on missing snapshot, TierLimitError when at cap,
//     ConflictError on duplicate name, happy path creates new profile
//     + records audit
//   - delete(): 404 when not found, returns void on success

import { describe, expect, it } from 'vitest';
import {
  ProfileSnapshotsService,
  type ProfileSnapshotRecord,
  type ProfileSnapshotsRepo,
} from '../../src/services/profile-snapshots.js';
import type { NewProfileInput, ProfileRecord, ProfilesRepo } from '../../src/services/profiles.js';
import type { AccountAuditService } from '../../src/services/account-audit.js';
import { ConflictError, NotFoundError, TierLimitError } from '../../src/lib/errors.js';
import { PROFILE_DEK_V2_PREFIX, unwrapProfileDek } from '../../src/lib/profile-key-hierarchy.js';

const CRYPTO_ACCOUNT_A = '00000000-0000-4000-8000-0000000000a1';
const CRYPTO_ACCOUNT_B = '00000000-0000-4000-8000-0000000000b2';
const OTHER_PROFILE_ID = '00000000-0000-4000-8000-0000000000c3';

function makeProfile(overrides: Partial<ProfileRecord> = {}): ProfileRecord {
  return {
    id: 'prof_1',
    accountId: 'acc_1',
    name: 'p1',
    archetype: 'default',
    description: null,
    folder: null,
    tags: [],
    lastUsedAt: null,
    sizeBytes: null,
    lastSavedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    icon: null,
    note: null,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<ProfileSnapshotRecord> = {}): ProfileSnapshotRecord {
  return {
    id: 'psnap_1',
    accountId: 'acc_1',
    parentProfileId: 'prof_1',
    label: 'before-update',
    description: null,
    parentArchetype: 'default',
    parentName: 'p1',
    stateBlob: {},
    capturedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

function makeRepos(
  opts: {
    profiles?: ProfileRecord[];
    snapshots?: ProfileSnapshotRecord[];
    countOverride?: number;
  } = {},
): {
  snapshotsRepo: ProfileSnapshotsRepo;
  profilesRepo: ProfilesRepo;
  state: {
    profiles: ProfileRecord[];
    snapshots: ProfileSnapshotRecord[];
  };
} {
  const profiles = [...(opts.profiles ?? [])];
  const snapshots = [...(opts.snapshots ?? [])];
  let snapshotCounter = snapshots.length;
  let profileCounter = profiles.length;
  const snapshotsRepo: ProfileSnapshotsRepo = {
    insert: (input) => {
      snapshotCounter += 1;
      const row: ProfileSnapshotRecord = {
        id: `psnap_${snapshotCounter.toString()}`,
        accountId: input.accountId,
        parentProfileId: input.parentProfileId,
        label: input.label,
        description: input.description,
        parentArchetype: input.parentArchetype,
        parentName: input.parentName,
        stateBlob: input.stateBlob,
        capturedAt: new Date(),
        createdAt: new Date(),
      };
      snapshots.push(row);
      return Promise.resolve(row);
    },
    list: ({ accountId, parentProfileId, limit }) =>
      Promise.resolve({
        data: snapshots
          .filter((s) => s.accountId === accountId)
          .filter((s) => parentProfileId === undefined || s.parentProfileId === parentProfileId)
          .slice(0, limit ?? 50),
        hasMore: false,
        nextCursor: null,
      }),
    findById: ({ id, accountId }) =>
      Promise.resolve(snapshots.find((s) => s.id === id && s.accountId === accountId) ?? null),
    delete: ({ id, accountId }) => {
      const idx = snapshots.findIndex((s) => s.id === id && s.accountId === accountId);
      if (idx < 0) return Promise.resolve(false);
      snapshots.splice(idx, 1);
      return Promise.resolve(true);
    },
  };
  const profilesRepo: ProfilesRepo = {
    // Mirrors the prod transaction: cap-check, CLAIM the source (only a live row
    // can be claimed), then insert. This fake exists for snapshot tests, but the
    // claim is modelled anyway — a double that skips it would let the
    // concurrent-transfer bug pass wherever it is used.
    transferAtomic: (args) => {
      const src = profiles.find(
        (r: ProfileRecord) =>
          r.id === args.source.id && r.accountId === args.source.accountId && !r.deletedAt,
      );
      if (!src) return Promise.resolve({ sourceAlreadyRetired: true as const });
      src.deletedAt = new Date();
      return profilesRepo.insertWithLimit(args.insert, null);
    },
    insert: (input) => {
      profileCounter += 1;
      const row: ProfileRecord = {
        id: input.id ?? `prof_${profileCounter.toString()}`,
        accountId: input.accountId,
        name: input.name,
        archetype: input.archetype,
        description: input.description,
        folder: null,
        tags: [],
        lastUsedAt: null,
        sizeBytes: null,
        lastSavedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        icon: null,
        note: null,
      };
      profiles.push(row);
      return Promise.resolve(row);
    },
    insertWithLimit: (input, limit) => {
      if (limit !== null) {
        const current =
          opts.countOverride ?? profiles.filter((p) => p.accountId === input.accountId).length;
        if (current >= limit) return Promise.resolve({ limitExceeded: true as const, current });
      }
      profileCounter += 1;
      const row: ProfileRecord = {
        id: input.id ?? `prof_${profileCounter.toString()}`,
        accountId: input.accountId,
        name: input.name,
        archetype: input.archetype,
        description: input.description,
        folder: null,
        tags: [],
        lastUsedAt: null,
        sizeBytes: null,
        lastSavedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        icon: null,
        note: null,
      };
      profiles.push(row);
      return Promise.resolve({ record: row });
    },
    countByAccount: (accountId) =>
      Promise.resolve(
        opts.countOverride ?? profiles.filter((p) => p.accountId === accountId).length,
      ),
    sumSizeBytesByAccount: (accountId) =>
      Promise.resolve(
        profiles
          .filter((p) => p.accountId === accountId && p.deletedAt === null)
          .reduce((sum, p) => sum + (typeof p.sizeBytes === 'number' ? p.sizeBytes : 0), 0),
      ),
    findById: ({ id, accountId }) =>
      Promise.resolve(profiles.find((p) => p.id === id && p.accountId === accountId) ?? null),
    findByAccountAndName: ({ accountId, name }) =>
      Promise.resolve(profiles.find((p) => p.accountId === accountId && p.name === name) ?? null),
    list: () => Promise.resolve({ data: profiles, hasMore: false, nextCursor: null }),
    update: ({ id }) => Promise.resolve(profiles.find((p) => p.id === id) as ProfileRecord),
    delete: () => Promise.resolve(true),
    listTrashed: ({ accountId }) =>
      Promise.resolve(profiles.filter((p) => p.accountId === accountId && p.deletedAt !== null)),
    restore: () => Promise.resolve('not_found' as const),
    purgeTrashedBefore: () => Promise.resolve([]),
    purgeTrashed: () => Promise.resolve(false),
    findExistingProfileIds: (ids) =>
      Promise.resolve(new Set(ids.filter((id) => profiles.some((p) => p.id === id)))),
    touch: () => Promise.resolve(),
    recordSave: () => Promise.resolve(),
    getWrappedDek: () => Promise.resolve(null),
  };
  return { snapshotsRepo, profilesRepo, state: { profiles, snapshots } };
}

function makeAudit(): { audit: AccountAuditService; calls: { action: string }[] } {
  const calls: { action: string }[] = [];
  const audit = {
    record: (args: { action: string }) => {
      calls.push(args);
      return Promise.resolve();
    },
  } as unknown as AccountAuditService;
  return { audit, calls };
}

describe('V-553.B-19 ProfileSnapshotsService.capture', () => {
  it('throws NotFound when parent profile does not exist', async () => {
    const { snapshotsRepo, profilesRepo } = makeRepos();
    const svc = new ProfileSnapshotsService(snapshotsRepo, profilesRepo);
    await expect(
      svc.capture({ accountId: 'acc_1', profileId: 'prof_missing', label: 'l' }),
    ).rejects.toThrow(NotFoundError);
  });

  it('throws NotFound for cross-account profile (404, not 403)', async () => {
    const { snapshotsRepo, profilesRepo } = makeRepos({
      profiles: [makeProfile({ id: 'prof_other', accountId: 'acc_other' })],
    });
    const svc = new ProfileSnapshotsService(snapshotsRepo, profilesRepo);
    await expect(
      svc.capture({ accountId: 'acc_1', profileId: 'prof_other', label: 'l' }),
    ).rejects.toThrow(NotFoundError);
  });

  it('captures parent archetype + name + empty state_blob', async () => {
    const { snapshotsRepo, profilesRepo, state } = makeRepos({
      profiles: [makeProfile({ id: 'prof_1', name: 'sales-bot', archetype: 'mobile_ios' })],
    });
    const svc = new ProfileSnapshotsService(snapshotsRepo, profilesRepo);
    const snap = await svc.capture({
      accountId: 'acc_1',
      profileId: 'prof_1',
      label: 'pre-update',
      description: 'before tweaking viewport',
    });
    expect(snap.parentName).toBe('sales-bot');
    expect(snap.parentArchetype).toBe('mobile_ios');
    expect(snap.label).toBe('pre-update');
    expect(snap.description).toBe('before tweaking viewport');
    expect(snap.stateBlob).toEqual({});
    expect(state.snapshots).toHaveLength(1);
  });
});

describe('V-553.B-19 ProfileSnapshotsService.list', () => {
  it('forwards filters to the repo', async () => {
    const snaps = [
      makeSnapshot({ id: 'psnap_a', parentProfileId: 'prof_1' }),
      makeSnapshot({ id: 'psnap_b', parentProfileId: 'prof_2' }),
    ];
    // The parent must exist for this case to be about FILTERING. Listing under
    // a profile that is not there is now a 404, so without this the test would
    // pass or fail for the wrong reason.
    const { snapshotsRepo, profilesRepo } = makeRepos({
      profiles: [makeProfile({ id: 'prof_1' })],
      snapshots: snaps,
    });
    const svc = new ProfileSnapshotsService(snapshotsRepo, profilesRepo);
    const page = await svc.list({ accountId: 'acc_1', parentProfileId: 'prof_1' });
    expect(page.data.map((s) => s.id)).toEqual(['psnap_a']);
  });

  it('CRITICAL throws NotFound when the parent profile does not exist, instead of an empty page. An empty 200 asserts the parent is real and simply has nothing — so a mistyped id read as "no snapshots" rather than "no such profile", and the route contradicted the 404 its own contract documents.', async () => {
    const { snapshotsRepo, profilesRepo } = makeRepos({
      snapshots: [makeSnapshot({ id: 'psnap_a', parentProfileId: 'prof_1' })],
    });
    const svc = new ProfileSnapshotsService(snapshotsRepo, profilesRepo);
    await expect(svc.list({ accountId: 'acc_1', parentProfileId: 'prof_absent' })).rejects.toThrow(
      NotFoundError,
    );
  });

  it('CRITICAL a parent owned by ANOTHER account is not found either. The lookup is account-scoped, so a foreign id cannot be used to prove a profile exists.', async () => {
    const { snapshotsRepo, profilesRepo } = makeRepos({
      profiles: [makeProfile({ id: 'prof_other', accountId: 'acc_other' })],
    });
    const svc = new ProfileSnapshotsService(snapshotsRepo, profilesRepo);
    await expect(svc.list({ accountId: 'acc_1', parentProfileId: 'prof_other' })).rejects.toThrow(
      NotFoundError,
    );
  });

  it('the account-wide listing has no parent to verify and still returns rows', async () => {
    const { snapshotsRepo, profilesRepo } = makeRepos({
      snapshots: [makeSnapshot({ id: 'psnap_a', parentProfileId: 'prof_1' })],
    });
    const svc = new ProfileSnapshotsService(snapshotsRepo, profilesRepo);
    const page = await svc.list({ accountId: 'acc_1' });
    expect(page.data.map((s) => s.id)).toEqual(['psnap_a']);
  });
});

describe('V-553.B-19 ProfileSnapshotsService.get', () => {
  it('throws NotFound when the snapshot is missing or cross-account', async () => {
    const { snapshotsRepo, profilesRepo } = makeRepos({
      snapshots: [makeSnapshot({ id: 'psnap_other', accountId: 'acc_other' })],
    });
    const svc = new ProfileSnapshotsService(snapshotsRepo, profilesRepo);
    await expect(svc.get({ id: 'psnap_other', accountId: 'acc_1' })).rejects.toThrow(NotFoundError);
  });

  it('returns the row when found', async () => {
    const { snapshotsRepo, profilesRepo } = makeRepos({
      snapshots: [makeSnapshot({ id: 'psnap_42', label: 'good' })],
    });
    const svc = new ProfileSnapshotsService(snapshotsRepo, profilesRepo);
    const row = await svc.get({ id: 'psnap_42', accountId: 'acc_1' });
    expect(row.label).toBe('good');
  });
});

describe('V-553.B-19 ProfileSnapshotsService.restore', () => {
  it('throws NotFound when snapshot is missing', async () => {
    const { snapshotsRepo, profilesRepo } = makeRepos();
    const svc = new ProfileSnapshotsService(snapshotsRepo, profilesRepo);
    await expect(
      svc.restore({
        accountId: 'acc_1',
        snapshotId: 'psnap_missing',
        tier: 'solo_manual',
        name: 'restored',
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it('throws TierLimitError when at the tier cap', async () => {
    const { snapshotsRepo, profilesRepo } = makeRepos({
      snapshots: [makeSnapshot()],
      countOverride: 1_000_000, // way over any tier cap
    });
    const svc = new ProfileSnapshotsService(snapshotsRepo, profilesRepo);
    await expect(
      svc.restore({
        accountId: 'acc_1',
        snapshotId: 'psnap_1',
        tier: 'solo_manual',
        name: 'restored',
      }),
    ).rejects.toThrow(TierLimitError);
  });

  it('throws ConflictError when the new name already exists', async () => {
    const { snapshotsRepo, profilesRepo } = makeRepos({
      profiles: [makeProfile({ name: 'taken' })],
      snapshots: [makeSnapshot()],
    });
    const svc = new ProfileSnapshotsService(snapshotsRepo, profilesRepo);
    await expect(
      svc.restore({
        accountId: 'acc_1',
        snapshotId: 'psnap_1',
        tier: 'solo_manual',
        name: 'taken',
      }),
    ).rejects.toThrow(ConflictError);
  });

  it('creates a new profile from the snapshot archetype + records audit', async () => {
    const { snapshotsRepo, profilesRepo, state } = makeRepos({
      snapshots: [makeSnapshot({ parentArchetype: 'mobile_ios' })],
    });
    const { audit, calls } = makeAudit();
    const svc = new ProfileSnapshotsService(snapshotsRepo, profilesRepo, audit);
    const restored = await svc.restore({
      accountId: 'acc_1',
      snapshotId: 'psnap_1',
      tier: 'team_manual',
      name: 'mobile-bot-v2',
    });
    expect(restored.name).toBe('mobile-bot-v2');
    expect(restored.archetype).toBe('mobile_ios');
    expect(state.profiles).toHaveLength(1);
    expect(calls.map((c) => c.action)).toEqual(['profile.created']);
  });

  it('preallocates the restored UUID and stores a fresh account+profile-bound v2 DEK', async () => {
    const { snapshotsRepo, profilesRepo } = makeRepos({
      snapshots: [makeSnapshot({ accountId: CRYPTO_ACCOUNT_A, parentArchetype: 'mobile_ios' })],
    });
    const originalInsert = profilesRepo.insertWithLimit.bind(profilesRepo);
    let captured: NewProfileInput | undefined;
    profilesRepo.insertWithLimit = (input, limit) => {
      captured = input;
      return originalInsert(input, limit);
    };
    const masterKey = Buffer.alloc(32, 29);
    const svc = new ProfileSnapshotsService(snapshotsRepo, profilesRepo, null, masterKey);

    const restored = await svc.restore({
      accountId: CRYPTO_ACCOUNT_A,
      snapshotId: 'psnap_1',
      tier: 'team_manual',
      name: 'state-capable-restore',
    });

    expect(captured?.id).toBe(restored.id);
    expect(restored.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(captured?.wrappedDek?.startsWith(PROFILE_DEK_V2_PREFIX)).toBe(true);
    const wrappedDek = captured?.wrappedDek ?? '';
    expect(unwrapProfileDek(masterKey, CRYPTO_ACCOUNT_A, restored.id, wrappedDek)).toHaveLength(32);
    expect(() => unwrapProfileDek(masterKey, CRYPTO_ACCOUNT_B, restored.id, wrappedDek)).toThrow();
    expect(() =>
      unwrapProfileDek(masterKey, CRYPTO_ACCOUNT_A, OTHER_PROFILE_ID, wrappedDek),
    ).toThrow();
  });

  it('preallocates the restored UUID but stores no DEK when the master key is absent', async () => {
    const { snapshotsRepo, profilesRepo } = makeRepos({ snapshots: [makeSnapshot()] });
    const originalInsert = profilesRepo.insertWithLimit.bind(profilesRepo);
    let captured: NewProfileInput | undefined;
    profilesRepo.insertWithLimit = (input, limit) => {
      captured = input;
      return originalInsert(input, limit);
    };
    const svc = new ProfileSnapshotsService(snapshotsRepo, profilesRepo);

    const restored = await svc.restore({
      accountId: 'acc_1',
      snapshotId: 'psnap_1',
      tier: 'team_manual',
      name: 'stateless-restore',
    });

    expect(captured?.id).toBe(restored.id);
    expect(restored.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(captured?.wrappedDek).toBeUndefined();
  });

  it('translates a concurrent same-name 23505 (race loser) into ConflictError, not a 500', async () => {
    // findByAccountAndName('fresh') misses the pre-check, but a sibling
    // create/restore took it before this insert commits → the
    // profiles_account_name_unique index fires on the loser.
    const { snapshotsRepo, profilesRepo } = makeRepos({ snapshots: [makeSnapshot()] });
    // restore now inserts via the atomic insertWithLimit (the count-TOCTOU
    // fix); the same-name 23505 surfaces from there.
    profilesRepo.insertWithLimit = () =>
      Promise.reject(
        Object.assign(
          new Error(
            'duplicate key value violates unique constraint "profiles_account_name_unique"',
          ),
          { code: '23505', constraint_name: 'profiles_account_name_unique' },
        ),
      );
    const svc = new ProfileSnapshotsService(snapshotsRepo, profilesRepo);
    await expect(
      svc.restore({
        accountId: 'acc_1',
        snapshotId: 'psnap_1',
        tier: 'team_manual',
        name: 'fresh',
      }),
    ).rejects.toThrow(ConflictError);
  });

  it('re-throws a non-constraint restore insert error (the catch is precise)', async () => {
    const { snapshotsRepo, profilesRepo } = makeRepos({ snapshots: [makeSnapshot()] });
    profilesRepo.insertWithLimit = () => Promise.reject(new Error('db exploded'));
    const svc = new ProfileSnapshotsService(snapshotsRepo, profilesRepo);
    await expect(
      svc.restore({
        accountId: 'acc_1',
        snapshotId: 'psnap_1',
        tier: 'team_manual',
        name: 'fresh',
      }),
    ).rejects.toThrow('db exploded');
  });

  it('restore closes the count-TOCTOU: under-lock insertWithLimit limitExceeded → TierLimitError', async () => {
    // The fast pre-check passes (under the cap), but a concurrent create/restore
    // wins the under-lock re-check → insertWithLimit returns limitExceeded. Restore
    // must surface a TierLimitError, not insert past the cap (the 5th profile-
    // creation path, now on the same atomic guard as create/clone/import/transfer).
    const { snapshotsRepo, profilesRepo, state } = makeRepos({
      snapshots: [makeSnapshot({ accountId: CRYPTO_ACCOUNT_A })],
    });
    const { audit, calls } = makeAudit();
    profilesRepo.insertWithLimit = () => Promise.resolve({ limitExceeded: true, current: 5 });
    const svc = new ProfileSnapshotsService(
      snapshotsRepo,
      profilesRepo,
      audit,
      Buffer.alloc(32, 7),
    );
    await expect(
      svc.restore({
        accountId: CRYPTO_ACCOUNT_A,
        snapshotId: 'psnap_1',
        tier: 'team_manual',
        name: 'fresh',
      }),
    ).rejects.toThrow(TierLimitError);
    expect(state.profiles).toHaveLength(0);
    expect(calls).toEqual([]);
  });
});

describe('V-553.B-19 ProfileSnapshotsService.delete', () => {
  it('throws NotFound when the snapshot does not exist', async () => {
    const { snapshotsRepo, profilesRepo } = makeRepos();
    const svc = new ProfileSnapshotsService(snapshotsRepo, profilesRepo);
    await expect(svc.delete({ id: 'psnap_missing', accountId: 'acc_1' })).rejects.toThrow(
      NotFoundError,
    );
  });

  it('removes the row from the repo on success', async () => {
    const { snapshotsRepo, profilesRepo, state } = makeRepos({
      snapshots: [makeSnapshot()],
    });
    const svc = new ProfileSnapshotsService(snapshotsRepo, profilesRepo);
    await svc.delete({ id: 'psnap_1', accountId: 'acc_1' });
    expect(state.snapshots).toHaveLength(0);
  });
});
