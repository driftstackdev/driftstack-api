// V-553.B-21 — unit tests for ProfilesService.
//
// Surface under test:
//   - create(): TierLimitError at cap, ConflictError on name dup,
//     happy path + audit emission
//   - get(): NotFound on missing
//   - update(): name-conflict against a DIFFERENT id, NotFound,
//     happy path
//   - delete(): idempotent no-op on missing, happy path + audit
//   - clone(): NotFound source, tier cap, name override conflict,
//     auto-derives "(copy)" / "(copy 2)" when source name + first copy
//     are taken
//   - exportProfile(): NotFound, returns row + emits profile.exported
//   - importProfile(): tier cap, name conflict (no override), happy
//     path emits profile.imported carrying source ids + renamed flag

import { describe, expect, it } from 'vitest';
import type { AccountTier } from '@driftstack/api-types';
import {
  ProfilesService,
  type ProfileRecord,
  type ProfilesRepo,
  type ProfileSessionGuard,
  type ProfileUpdates,
  type NewProfileInput,
} from '../../src/services/profiles.js';
import type { AccountAuditService } from '../../src/services/account-audit.js';
import type { R2 } from '../../src/lib/r2.js';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  StorageQuotaExceededError,
  TierLimitError,
} from '../../src/lib/errors.js';
import { TIER_STORAGE_BYTES_CAP } from '@driftstack/api-types';
import { mintWrappedProfileDek, unwrapProfileDek } from '../../src/lib/profile-key-hierarchy.js';

const CRYPTO_ACCOUNT_A = '11111111-1111-4111-8111-111111111111';
const CRYPTO_ACCOUNT_B = '22222222-2222-4222-8222-222222222222';
const CRYPTO_PROFILE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SELECTABLE_ARCHETYPE = 'iphone17_ios18_7_safari26_4';

function makeProfile(overrides: Partial<ProfileRecord> = {}): ProfileRecord {
  return {
    id: 'p1',
    accountId: 'acc_1',
    name: 'starter',
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

function makeRepo(
  initial: ProfileRecord[] = [],
  opts: { countOverride?: number } = {},
): {
  repo: ProfilesRepo;
  state: { rows: ProfileRecord[] };
} {
  const rows = [...initial];
  let counter = rows.length;
  const repo: ProfilesRepo = {
    insert: (input: NewProfileInput) => {
      counter += 1;
      const row: ProfileRecord = {
        id: input.id ?? `p_new_${counter.toString()}`,
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
      rows.push(row);
      return Promise.resolve(row);
    },
    insertWithLimit: (input: NewProfileInput, limit: number | null) => {
      if (limit !== null) {
        const current =
          opts.countOverride ?? rows.filter((r) => r.accountId === input.accountId).length;
        if (current >= limit) return Promise.resolve({ limitExceeded: true as const, current });
      }
      counter += 1;
      const row: ProfileRecord = {
        id: input.id ?? `p_new_${counter.toString()}`,
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
      rows.push(row);
      return Promise.resolve({ record: row });
    },
    countByAccount: (accountId) =>
      Promise.resolve(opts.countOverride ?? rows.filter((r) => r.accountId === accountId).length),
    sumSizeBytesByAccount: (accountId) =>
      Promise.resolve(
        rows
          .filter((r) => r.accountId === accountId && r.deletedAt === null)
          .reduce((sum, r) => sum + (typeof r.sizeBytes === 'number' ? r.sizeBytes : 0), 0),
      ),
    findById: ({ id, accountId }) =>
      Promise.resolve(rows.find((r) => r.id === id && r.accountId === accountId) ?? null),
    findByAccountAndName: ({ accountId, name }) =>
      Promise.resolve(rows.find((r) => r.accountId === accountId && r.name === name) ?? null),
    list: ({ accountId, limit }) =>
      Promise.resolve({
        data: rows.filter((r) => r.accountId === accountId).slice(0, limit ?? 50),
        hasMore: false,
        nextCursor: null,
      }),
    update: ({
      id,
      accountId,
      updates,
    }: {
      id: string;
      accountId: string;
      updates: ProfileUpdates;
    }) => {
      const r = rows.find((row) => row.id === id && row.accountId === accountId);
      if (!r) throw new NotFoundError('Profile not found.');
      if (updates.name !== undefined) r.name = updates.name;
      if (updates.description !== undefined) r.description = updates.description;
      r.updatedAt = new Date();
      return Promise.resolve(r);
    },
    delete: ({ id, accountId }) => {
      const idx = rows.findIndex((r) => r.id === id && r.accountId === accountId);
      if (idx < 0) return Promise.resolve(false);
      rows.splice(idx, 1);
      return Promise.resolve(true);
    },
    listTrashed: ({ accountId }) =>
      Promise.resolve(rows.filter((r) => r.accountId === accountId && r.deletedAt !== null)),
    restore: ({ id, accountId }) => {
      const r = rows.find((row) => row.id === id && row.accountId === accountId);
      if (!r || r.deletedAt === null) return Promise.resolve('not_found' as const);
      if (
        rows.some((o) => o.accountId === accountId && o.name === r.name && o.deletedAt === null)
      ) {
        return Promise.resolve('name_conflict' as const);
      }
      r.deletedAt = null;
      return Promise.resolve('restored' as const);
    },
    purgeTrashedBefore: (cutoff) => {
      const purgedIds: string[] = [];
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i]!;
        if (r.deletedAt !== null && r.deletedAt.getTime() < cutoff.getTime()) {
          purgedIds.push(r.id);
          rows.splice(i, 1);
        }
      }
      return Promise.resolve(purgedIds);
    },
    purgeTrashed: ({ id, accountId }) => {
      const i = rows.findIndex(
        (r) => r.id === id && r.accountId === accountId && r.deletedAt !== null,
      );
      if (i < 0) return Promise.resolve(false);
      rows.splice(i, 1);
      return Promise.resolve(true);
    },
    findExistingProfileIds: (ids) =>
      Promise.resolve(new Set(ids.filter((id) => rows.some((r) => r.id === id)))),
    touch: () => Promise.resolve(),
    recordSave: () => Promise.resolve(),
    getWrappedDek: () => Promise.resolve(null),
  };
  return { repo, state: { rows } };
}

function makeAudit(): {
  audit: AccountAuditService;
  calls: Array<{ action: string; payload: Record<string, unknown> | null | undefined }>;
} {
  const calls: Array<{ action: string; payload: Record<string, unknown> | null | undefined }> = [];
  const audit = {
    record: (args: { action: string; payload?: Record<string, unknown> | null }) => {
      calls.push({ action: args.action, payload: args.payload });
      return Promise.resolve();
    },
    // 2026-05-22 — V-666 import-cycle quota guard. Mock returns 0 so
    // the cap check never triggers in unit tests; integration tests
    // can stub a real count if they want to assert the cap behavior.
    countActionsSince: () => Promise.resolve(0),
  } as unknown as AccountAuditService;
  return { audit, calls };
}

const SOLO: AccountTier = 'solo_manual';
const TEAM: AccountTier = 'team_manual';

// A Postgres unique-violation (23505) on the profiles_account_name_unique
// index — what a concurrent same-name insert raises on the race loser after
// both requests pass the findByAccountAndName pre-check.
function nameRace23505(): Error {
  return Object.assign(
    new Error('duplicate key value violates unique constraint "profiles_account_name_unique"'),
    { code: '23505', constraint_name: 'profiles_account_name_unique' },
  );
}

describe('V-553.B-21 ProfilesService.create', () => {
  it('rejects a non-selectable archetype before any repository read or write', async () => {
    const { repo } = makeRepo();
    repo.countByAccount = () => Promise.reject(new Error('repository must not be called'));
    const svc = new ProfilesService(repo);
    await expect(
      svc.create({
        accountId: 'acc_1',
        tier: SOLO,
        name: 'invalid',
        archetype: 'unknown_ios18_7_safari26_4',
      }),
    ).rejects.toThrow(BadRequestError);
  });

  it('throws TierLimitError when at the tier cap', async () => {
    const { repo } = makeRepo([], { countOverride: 1_000_000 });
    const svc = new ProfilesService(repo);
    await expect(svc.create({ accountId: 'acc_1', tier: SOLO, name: 'new' })).rejects.toThrow(
      TierLimitError,
    );
  });

  it('throws ConflictError on duplicate name', async () => {
    const { repo } = makeRepo([makeProfile({ name: 'taken' })]);
    const svc = new ProfilesService(repo);
    await expect(svc.create({ accountId: 'acc_1', tier: SOLO, name: 'taken' })).rejects.toThrow(
      ConflictError,
    );
  });

  it('mints + stores a wrapped DEK on create when PROFILE_MASTER_KEY is set (file 57)', async () => {
    const { repo } = makeRepo();
    const orig = repo.insertWithLimit.bind(repo);
    let captured: NewProfileInput | undefined;
    repo.insertWithLimit = (input, limit) => {
      captured = input;
      return orig(input, limit);
    };
    const master = Buffer.alloc(32, 4);
    const svc = new ProfilesService(repo, null, master);
    const row = await svc.create({ accountId: CRYPTO_ACCOUNT_A, tier: SOLO, name: 'p' });
    expect(typeof captured?.wrappedDek).toBe('string');
    expect(captured?.id).toBe(row.id);
    // round-trips: unwraps back to a 32-byte DEK under the SAME account's TMK.
    const dek = unwrapProfileDek(master, CRYPTO_ACCOUNT_A, row.id, captured?.wrappedDek ?? '');
    expect(dek.length).toBe(32);
  });

  it('preallocates distinct UUIDs and binds each new wrapped DEK to its returned profile identity', async () => {
    const { repo } = makeRepo();
    const orig = repo.insertWithLimit.bind(repo);
    const captured: NewProfileInput[] = [];
    repo.insertWithLimit = (input, limit) => {
      captured.push(input);
      return orig(input, limit);
    };
    const master = Buffer.alloc(32, 6);
    const svc = new ProfilesService(repo, null, master);
    const first = await svc.create({ accountId: CRYPTO_ACCOUNT_A, tier: TEAM, name: 'first' });
    const second = await svc.create({ accountId: CRYPTO_ACCOUNT_A, tier: TEAM, name: 'second' });
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.id).not.toBe(second.id);
    expect(captured.map((input) => input.id)).toEqual([first.id, second.id]);
    expect(
      unwrapProfileDek(master, CRYPTO_ACCOUNT_A, first.id, captured[0]!.wrappedDek ?? '').length,
    ).toBe(32);
    expect(() =>
      unwrapProfileDek(master, CRYPTO_ACCOUNT_A, second.id, captured[0]!.wrappedDek ?? ''),
    ).toThrow();
  });

  it('stores no DEK on create when the master key is absent (feature inert)', async () => {
    const { repo } = makeRepo();
    const orig = repo.insertWithLimit.bind(repo);
    let captured: NewProfileInput | undefined;
    repo.insertWithLimit = (input, limit) => {
      captured = input;
      return orig(input, limit);
    };
    const svc = new ProfilesService(repo); // no master key
    await svc.create({ accountId: 'acc_nodek', tier: SOLO, name: 'p' });
    expect(captured?.wrappedDek).toBeUndefined();
  });

  it('getProfileDek: unwraps the stored wrapped DEK under the account TMK when the key is set', async () => {
    const master = Buffer.alloc(32, 8);
    const { wrappedDek, dek } = mintWrappedProfileDek(master, CRYPTO_ACCOUNT_A, CRYPTO_PROFILE_A);
    const { repo } = makeRepo();
    repo.getWrappedDek = () => Promise.resolve(wrappedDek);
    const svc = new ProfilesService(repo, null, master);
    const got = await svc.getProfileDek({
      profileId: CRYPTO_PROFILE_A,
      accountId: CRYPTO_ACCOUNT_A,
    });
    expect(got?.equals(dek)).toBe(true);
  });

  it('getProfileDek: null when the master key is absent', async () => {
    const { repo } = makeRepo();
    repo.getWrappedDek = () => Promise.resolve('whatever');
    const svc = new ProfilesService(repo); // no master key
    expect(await svc.getProfileDek({ profileId: 'p1', accountId: 'acc_g' })).toBeNull();
  });

  it('getProfileDek: null when the profile has no stored DEK', async () => {
    const { repo } = makeRepo();
    repo.getWrappedDek = () => Promise.resolve(null);
    const svc = new ProfilesService(repo, null, Buffer.alloc(32, 8));
    expect(await svc.getProfileDek({ profileId: 'p1', accountId: 'acc_g' })).toBeNull();
  });

  it('translates a concurrent same-name 23505 (race loser) into ConflictError, not a 500', async () => {
    // The findByAccountAndName pre-check misses (empty store), but a sibling
    // request committed first → insert hits profiles_account_name_unique.
    const { repo } = makeRepo();
    repo.insertWithLimit = () => Promise.reject(nameRace23505());
    const svc = new ProfilesService(repo);
    await expect(svc.create({ accountId: 'acc_1', tier: SOLO, name: 'racy' })).rejects.toThrow(
      ConflictError,
    );
  });

  it('re-throws a non-constraint insert error (the race catch is precise, not a catch-all)', async () => {
    const { repo } = makeRepo();
    repo.insertWithLimit = () => Promise.reject(new Error('db exploded'));
    const svc = new ProfilesService(repo);
    await expect(svc.create({ accountId: 'acc_1', tier: SOLO, name: 'boom' })).rejects.toThrow(
      'db exploded',
    );
  });

  it('inserts a row and emits profile.created audit on happy path', async () => {
    const { repo, state } = makeRepo();
    const { audit, calls } = makeAudit();
    const svc = new ProfilesService(repo, audit);
    const row = await svc.create({
      accountId: 'acc_1',
      tier: TEAM,
      name: 'fresh',
      archetype: SELECTABLE_ARCHETYPE,
      description: 'first one',
    });
    expect(row.name).toBe('fresh');
    expect(row.archetype).toBe(SELECTABLE_ARCHETYPE);
    expect(state.rows).toHaveLength(1);
    expect(calls[0]?.action).toBe('profile.created');
  });
});

describe('V-553.B-21 ProfilesService.get', () => {
  it('throws NotFound when row is missing or wrong account', async () => {
    const { repo } = makeRepo([makeProfile({ id: 'p1', accountId: 'acc_other' })]);
    const svc = new ProfilesService(repo);
    await expect(svc.get({ id: 'p1', accountId: 'acc_1' })).rejects.toThrow(NotFoundError);
  });

  it('returns the row when account scope matches', async () => {
    const { repo } = makeRepo([makeProfile({ id: 'p1', accountId: 'acc_1' })]);
    const svc = new ProfilesService(repo);
    const r = await svc.get({ id: 'p1', accountId: 'acc_1' });
    expect(r.id).toBe('p1');
  });
});

describe('V-553.B-21 ProfilesService.update', () => {
  it('throws ConflictError if rename collides with a different profile', async () => {
    const { repo } = makeRepo([
      makeProfile({ id: 'p1', accountId: 'acc_1', name: 'a' }),
      makeProfile({ id: 'p2', accountId: 'acc_1', name: 'b' }),
    ]);
    const svc = new ProfilesService(repo);
    await expect(
      svc.update({ id: 'p1', accountId: 'acc_1', updates: { name: 'b' } }),
    ).rejects.toThrow(ConflictError);
  });

  it('allows updating with the same name (idempotent)', async () => {
    const { repo } = makeRepo([makeProfile({ id: 'p1', accountId: 'acc_1', name: 'keep' })]);
    const svc = new ProfilesService(repo);
    const r = await svc.update({ id: 'p1', accountId: 'acc_1', updates: { name: 'keep' } });
    expect(r.name).toBe('keep');
  });

  it('throws NotFound when the row is missing', async () => {
    const { repo } = makeRepo();
    const svc = new ProfilesService(repo);
    await expect(
      svc.update({ id: 'p_missing', accountId: 'acc_1', updates: { description: 'x' } }),
    ).rejects.toThrow(NotFoundError);
  });

  it('translates a concurrent rename 23505 (race loser) into ConflictError', async () => {
    // findByAccountAndName('fresh') misses the pre-check, but a sibling rename
    // took it before this update commits → profiles_account_name_unique.
    const { repo } = makeRepo([makeProfile({ id: 'p1', accountId: 'acc_1', name: 'keep' })]);
    repo.update = () => Promise.reject(nameRace23505());
    const svc = new ProfilesService(repo);
    await expect(
      svc.update({ id: 'p1', accountId: 'acc_1', updates: { name: 'fresh' } }),
    ).rejects.toThrow(ConflictError);
  });

  it('does NOT translate a 23505 on a description-only update (no rename → raw error surfaces)', async () => {
    // A description-only update can't trip the name index; the name guard keeps
    // the catch from masking an unrelated 23505 as a name conflict.
    const { repo } = makeRepo([makeProfile({ id: 'p1', accountId: 'acc_1', name: 'keep' })]);
    repo.update = () => Promise.reject(nameRace23505());
    const svc = new ProfilesService(repo);
    await expect(
      svc.update({ id: 'p1', accountId: 'acc_1', updates: { description: 'x' } }),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('V-553.B-21 ProfilesService.delete', () => {
  it('is an idempotent no-op when the row is missing (resolves, no audit)', async () => {
    const { repo } = makeRepo();
    const { audit, calls } = makeAudit();
    const svc = new ProfilesService(repo, audit);
    await expect(svc.delete({ id: 'p_missing', accountId: 'acc_1' })).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('removes the row and emits profile.deleted audit', async () => {
    const { repo, state } = makeRepo([makeProfile({ id: 'p1', accountId: 'acc_1', name: 'dead' })]);
    const { audit, calls } = makeAudit();
    const svc = new ProfilesService(repo, audit);
    await svc.delete({ id: 'p1', accountId: 'acc_1' });
    expect(state.rows).toHaveLength(0);
    expect(calls[0]?.action).toBe('profile.deleted');
  });
});

describe('V-553.B-21 ProfilesService.clone', () => {
  it('throws NotFound when source is missing', async () => {
    const { repo } = makeRepo();
    const svc = new ProfilesService(repo);
    await expect(svc.clone({ id: 'p_missing', accountId: 'acc_1', tier: SOLO })).rejects.toThrow(
      NotFoundError,
    );
  });

  it('throws TierLimitError when at cap', async () => {
    const { repo } = makeRepo([makeProfile({ id: 'p1', accountId: 'acc_1' })], {
      countOverride: 1_000_000,
    });
    const svc = new ProfilesService(repo);
    await expect(svc.clone({ id: 'p1', accountId: 'acc_1', tier: SOLO })).rejects.toThrow(
      TierLimitError,
    );
  });

  it('rejects explicit name override that already exists', async () => {
    const { repo } = makeRepo([
      makeProfile({ id: 'p1', accountId: 'acc_1', name: 'src' }),
      makeProfile({ id: 'p2', accountId: 'acc_1', name: 'taken' }),
    ]);
    const svc = new ProfilesService(repo);
    await expect(
      svc.clone({ id: 'p1', accountId: 'acc_1', tier: TEAM, name: 'taken' }),
    ).rejects.toThrow(ConflictError);
  });

  it('auto-derives "(copy)" when source name is taken, "(copy 2)" when the first copy exists too', async () => {
    const { repo } = makeRepo([
      makeProfile({ id: 'p1', accountId: 'acc_1', name: 'src', archetype: 'mobile_ios' }),
      makeProfile({ id: 'p2', accountId: 'acc_1', name: 'src (copy)' }),
    ]);
    const svc = new ProfilesService(repo);
    const row = await svc.clone({ id: 'p1', accountId: 'acc_1', tier: TEAM });
    expect(row.name).toBe('src (copy 2)');
    expect(row.archetype).toBe('mobile_ios');
  });

  it('copies the source icon + note into the clone insert (organization metadata rides along)', async () => {
    const { repo } = makeRepo([
      makeProfile({
        id: 'p1',
        accountId: 'acc_1',
        name: 'src',
        folder: 'Work',
        tags: ['a', 'b'],
        icon: '🦊',
        note: 'keep me',
      }),
    ]);
    let captured: NewProfileInput | undefined;
    const inner = repo.insertWithLimit.bind(repo);
    repo.insertWithLimit = (input: NewProfileInput, limit: number | null) => {
      captured = input;
      return inner(input, limit);
    };
    const svc = new ProfilesService(repo);
    await svc.clone({ id: 'p1', accountId: 'acc_1', tier: TEAM });
    expect(captured?.icon).toBe('🦊');
    expect(captured?.note).toBe('keep me');
    expect(captured?.folder).toBe('Work');
    expect(captured?.tags).toEqual(['a', 'b']);
  });

  it('translates a concurrent explicit-name 23505 (race loser) into ConflictError', async () => {
    // findByAccountAndName('fresh') misses, but a sibling took it before the
    // insert commits → profiles_account_name_unique fires.
    const { repo } = makeRepo([makeProfile({ id: 'p1', accountId: 'acc_1', name: 'src' })]);
    repo.insertWithLimit = () => Promise.reject(nameRace23505());
    const svc = new ProfilesService(repo);
    await expect(
      svc.clone({ id: 'p1', accountId: 'acc_1', tier: TEAM, name: 'fresh' }),
    ).rejects.toThrow(ConflictError);
  });

  it('re-throws a non-constraint clone insert error (the catch is precise)', async () => {
    const { repo } = makeRepo([makeProfile({ id: 'p1', accountId: 'acc_1', name: 'src' })]);
    repo.insertWithLimit = () => Promise.reject(new Error('db exploded'));
    const svc = new ProfilesService(repo);
    await expect(
      svc.clone({ id: 'p1', accountId: 'acc_1', tier: TEAM, name: 'fresh' }),
    ).rejects.toThrow('db exploded');
  });
});

describe('V-553.B-21 ProfilesService.exportProfile', () => {
  it('throws NotFound when row missing', async () => {
    const { repo } = makeRepo();
    const svc = new ProfilesService(repo);
    await expect(svc.exportProfile({ id: 'p_missing', accountId: 'acc_1' })).rejects.toThrow(
      NotFoundError,
    );
  });

  it('returns the row and emits profile.exported', async () => {
    const { repo } = makeRepo([makeProfile({ id: 'p1', accountId: 'acc_1', name: 'exp' })]);
    const { audit, calls } = makeAudit();
    const svc = new ProfilesService(repo, audit);
    const row = await svc.exportProfile({ id: 'p1', accountId: 'acc_1' });
    expect(row.name).toBe('exp');
    expect(calls[0]?.action).toBe('profile.exported');
  });
});

describe('V-553.B-21 ProfilesService.importProfile', () => {
  it('rejects a reference/non-selectable archetype before quota or repository work', async () => {
    const { repo } = makeRepo();
    repo.countByAccount = () => Promise.reject(new Error('repository must not be called'));
    const svc = new ProfilesService(repo);
    await expect(
      svc.importProfile({
        accountId: 'acc_1',
        tier: SOLO,
        sourceProfileId: 'prof_source',
        sourceAccountId: 'acc_source',
        payload: {
          name: 'legacy',
          archetype: 'iphone15pro_ios17_5_safari17_5',
          description: null,
        },
      }),
    ).rejects.toThrow(BadRequestError);
  });

  it('throws TierLimitError when at cap', async () => {
    const { repo } = makeRepo([], { countOverride: 1_000_000 });
    const svc = new ProfilesService(repo);
    await expect(
      svc.importProfile({
        accountId: 'acc_1',
        tier: SOLO,
        sourceProfileId: 'p_src',
        sourceAccountId: 'acc_src',
        payload: { name: 'imported', archetype: SELECTABLE_ARCHETYPE, description: null },
      }),
    ).rejects.toThrow(TierLimitError);
  });

  it('throws ConflictError on name collision (no override)', async () => {
    const { repo } = makeRepo([makeProfile({ name: 'imported' })]);
    const svc = new ProfilesService(repo);
    await expect(
      svc.importProfile({
        accountId: 'acc_1',
        tier: TEAM,
        sourceProfileId: 'p_src',
        sourceAccountId: 'acc_src',
        payload: { name: 'imported', archetype: SELECTABLE_ARCHETYPE, description: null },
      }),
    ).rejects.toThrow(ConflictError);
  });

  it('inserts + emits profile.imported with source ids + renamed flag', async () => {
    const { repo, state } = makeRepo([makeProfile({ name: 'imported' })]);
    const { audit, calls } = makeAudit();
    const svc = new ProfilesService(repo, audit);
    const row = await svc.importProfile({
      accountId: 'acc_1',
      tier: TEAM,
      sourceProfileId: 'p_src',
      sourceAccountId: 'acc_src',
      payload: { name: 'imported', archetype: SELECTABLE_ARCHETYPE, description: 'note' },
      nameOverride: 'imported-renamed',
    });
    expect(row.name).toBe('imported-renamed');
    expect(state.rows).toHaveLength(2);
    expect(calls[0]?.action).toBe('profile.imported');
    expect(calls[0]?.payload?.source_profile_id).toBe('p_src');
    expect(calls[0]?.payload?.source_account_id).toBe('acc_src');
    expect(calls[0]?.payload?.renamed).toBe(true);
  });

  it('translates a concurrent import-name 23505 (race loser) into ConflictError', async () => {
    const { repo } = makeRepo();
    repo.insertWithLimit = () => Promise.reject(nameRace23505());
    const svc = new ProfilesService(repo);
    await expect(
      svc.importProfile({
        accountId: 'acc_1',
        tier: TEAM,
        sourceProfileId: 'p_src',
        sourceAccountId: 'acc_src',
        payload: { name: 'fresh', archetype: SELECTABLE_ARCHETYPE, description: null },
      }),
    ).rejects.toThrow(ConflictError);
  });
});

describe('V-553.B-21 ProfilesService.transferProfile', () => {
  it('translates a concurrent 23505 (race loser) into ConflictError and preserves the source', async () => {
    // findById finds the source; findByAccountAndName on the recipient misses
    // so no pre-check rename; the insert then races the recipient's name.
    const { repo, state } = makeRepo([
      makeProfile({ id: 'p1', accountId: 'acc_src', name: 'movable' }),
    ]);
    repo.insertWithLimit = () => Promise.reject(nameRace23505());
    const svc = new ProfilesService(repo);
    await expect(
      svc.transferProfile({
        sourceProfileId: 'p1',
        sourceAccountId: 'acc_src',
        recipientAccountId: 'acc_dst',
        recipientTier: TEAM,
      }),
    ).rejects.toThrow(ConflictError);
    // The source delete runs only after a successful insert — a race failure
    // must leave the source profile intact.
    expect(state.rows.find((r) => r.id === 'p1')).toBeDefined();
  });
});

// file 57 — clone/import/transfer must mint a FRESH wrapped DEK (not run
// stateless). A DEK-less profile is stateless at session-assign (no restore /
// save-back URL) → sealed-state persistence silently breaks. Each path mints
// its OWN fresh DEK bound to the OWNING account's TMK.
describe('ProfilesService DEK mint on clone/import/transfer (file 57)', () => {
  function captureInsert(repo: ProfilesRepo): { get: () => NewProfileInput | undefined } {
    let captured: NewProfileInput | undefined;
    const inner = repo.insertWithLimit.bind(repo);
    repo.insertWithLimit = (input, limit) => {
      captured = input;
      return inner(input, limit);
    };
    return { get: () => captured };
  }

  it('clone mints a fresh wrapped DEK (round-trips under the account TMK) when the master key is set', async () => {
    const { repo } = makeRepo([
      makeProfile({ id: 'p1', accountId: CRYPTO_ACCOUNT_A, name: 'src' }),
    ]);
    const cap = captureInsert(repo);
    const master = Buffer.alloc(32, 4);
    const svc = new ProfilesService(repo, null, master);
    const row = await svc.clone({ id: 'p1', accountId: CRYPTO_ACCOUNT_A, tier: TEAM });
    expect(typeof cap.get()?.wrappedDek).toBe('string');
    expect(cap.get()?.id).toBe(row.id);
    const dek = unwrapProfileDek(master, CRYPTO_ACCOUNT_A, row.id, cap.get()?.wrappedDek ?? '');
    expect(dek.length).toBe(32);
  });

  it('import mints a fresh wrapped DEK bound to the importing account when the master key is set', async () => {
    const { repo } = makeRepo();
    const cap = captureInsert(repo);
    const master = Buffer.alloc(32, 7);
    const svc = new ProfilesService(repo, null, master);
    await svc.importProfile({
      accountId: CRYPTO_ACCOUNT_A,
      tier: TEAM,
      sourceProfileId: 'p_src',
      sourceAccountId: 'acc_src',
      payload: { name: 'imported', archetype: SELECTABLE_ARCHETYPE, description: null },
    });
    expect(typeof cap.get()?.wrappedDek).toBe('string');
    const profileId = cap.get()?.id ?? '';
    const dek = unwrapProfileDek(master, CRYPTO_ACCOUNT_A, profileId, cap.get()?.wrappedDek ?? '');
    expect(dek.length).toBe(32);
  });

  it('transfer mints a fresh wrapped DEK bound to the RECIPIENT account when the master key is set', async () => {
    const { repo } = makeRepo([
      makeProfile({ id: 'p1', accountId: CRYPTO_ACCOUNT_A, name: 'movable' }),
    ]);
    const cap = captureInsert(repo);
    const master = Buffer.alloc(32, 9);
    const svc = new ProfilesService(repo, null, master);
    await svc.transferProfile({
      sourceProfileId: 'p1',
      sourceAccountId: CRYPTO_ACCOUNT_A,
      recipientAccountId: CRYPTO_ACCOUNT_B,
      recipientTier: TEAM,
    });
    expect(typeof cap.get()?.wrappedDek).toBe('string');
    // Bound to the recipient's TMK + profile-id context, not the source tuple.
    const profileId = cap.get()?.id ?? '';
    const dek = unwrapProfileDek(master, CRYPTO_ACCOUNT_B, profileId, cap.get()?.wrappedDek ?? '');
    expect(dek.length).toBe(32);
  });

  it('clone/import/transfer store NO DEK when the master key is absent (feature inert)', async () => {
    // clone
    {
      const { repo } = makeRepo([makeProfile({ id: 'p1', accountId: 'acc_c', name: 'src' })]);
      const cap = captureInsert(repo);
      const svc = new ProfilesService(repo); // no master key
      await svc.clone({ id: 'p1', accountId: 'acc_c', tier: TEAM });
      expect(cap.get()?.wrappedDek).toBeUndefined();
    }
    // import
    {
      const { repo } = makeRepo();
      const cap = captureInsert(repo);
      const svc = new ProfilesService(repo);
      await svc.importProfile({
        accountId: 'acc_i',
        tier: TEAM,
        sourceProfileId: 'p_src',
        sourceAccountId: 'acc_src',
        payload: { name: 'imported', archetype: SELECTABLE_ARCHETYPE, description: null },
      });
      expect(cap.get()?.wrappedDek).toBeUndefined();
    }
    // transfer
    {
      const { repo } = makeRepo([makeProfile({ id: 'p1', accountId: 'acc_src', name: 'movable' })]);
      const cap = captureInsert(repo);
      const svc = new ProfilesService(repo);
      await svc.transferProfile({
        sourceProfileId: 'p1',
        sourceAccountId: 'acc_src',
        recipientAccountId: 'acc_dst',
        recipientTier: TEAM,
      });
      expect(cap.get()?.wrappedDek).toBeUndefined();
    }
  });
});

// FIX 2 — a manual purge (DELETE /:id/purge) must best-effort delete the purged
// profile's R2 sealed blob so the encrypted bytes don't orphan forever.
describe('ProfilesService.purge — R2 sealed-blob cleanup (FIX 2)', () => {
  function stubR2(opts: { fail?: boolean } = {}): {
    r2: R2;
    deleted: string[];
  } {
    const deleted: string[] = [];
    const r2 = {
      deleteObject: (key: string) => {
        if (opts.fail === true) return Promise.reject(new Error('r2 down'));
        deleted.push(key);
        return Promise.resolve();
      },
    } as unknown as R2;
    return { r2, deleted };
  }

  it('deletes the purged profile blob from R2 (profiles/<id>.sealed) when R2 is wired', async () => {
    const { repo } = makeRepo([
      makeProfile({ id: 'p1', accountId: 'acc_1', name: 'gone', deletedAt: new Date() }),
    ]);
    const { r2, deleted } = stubR2();
    const svc = new ProfilesService(repo, null, null, r2);
    await svc.purge({ id: 'p1', accountId: 'acc_1' });
    expect(deleted).toEqual(['profiles/p1.sealed']);
  });

  it('still resolves (purge succeeds) when the R2 delete fails — best-effort, never throws', async () => {
    const { repo } = makeRepo([
      makeProfile({ id: 'p1', accountId: 'acc_1', name: 'gone', deletedAt: new Date() }),
    ]);
    const { r2 } = stubR2({ fail: true });
    const svc = new ProfilesService(repo, null, null, r2);
    await expect(svc.purge({ id: 'p1', accountId: 'acc_1' })).resolves.toBeUndefined();
  });

  it('NotFound (no row purged) never touches R2', async () => {
    const { repo } = makeRepo();
    const { r2, deleted } = stubR2();
    const svc = new ProfilesService(repo, null, null, r2);
    await expect(svc.purge({ id: 'p_missing', accountId: 'acc_1' })).rejects.toThrow(NotFoundError);
    expect(deleted).toHaveLength(0);
  });

  it('R2 not wired → purge is DB-only (no crash)', async () => {
    const { repo } = makeRepo([
      makeProfile({ id: 'p1', accountId: 'acc_1', name: 'gone', deletedAt: new Date() }),
    ]);
    const svc = new ProfilesService(repo); // no R2
    await expect(svc.purge({ id: 'p1', accountId: 'acc_1' })).resolves.toBeUndefined();
  });
});

// #1 (2026-06-30) — purge() must refuse to hard-delete a profile that still
// has a live session bound to it: the harness holds a long-TTL presigned
// save-back URL minted independently of the DB row and will resurrect a
// permanently-orphaned R2 blob at session-end otherwise. Mirrors the #14
// trim guard (routes/profiles.ts) at the service layer.
function stubAgentSessions(active: Record<string, number> = {}): {
  agentSessions: ProfileSessionGuard;
  calls: string[];
} {
  const calls: string[] = [];
  const agentSessions: ProfileSessionGuard = {
    countActiveForProfile: (profileId: string) => {
      calls.push(profileId);
      return Promise.resolve(active[profileId] ?? 0);
    },
  };
  return { agentSessions, calls };
}

describe('ProfilesService.purge — live-session guard (FIX #1)', () => {
  it('refuses to purge a trashed profile with a live session bound to it, leaving the row intact', async () => {
    const { repo, state } = makeRepo([
      makeProfile({ id: 'p1', accountId: 'acc_1', name: 'gone', deletedAt: new Date() }),
    ]);
    const { agentSessions } = stubAgentSessions({ p1: 1 });
    const svc = new ProfilesService(repo, null, null, null, null, agentSessions);
    await expect(svc.purge({ id: 'p1', accountId: 'acc_1' })).rejects.toThrow(ConflictError);
    expect(state.rows.find((r) => r.id === 'p1')).toBeDefined();
  });

  it('purges normally once the profile has no active session bound to it', async () => {
    const { repo, state } = makeRepo([
      makeProfile({ id: 'p1', accountId: 'acc_1', name: 'gone', deletedAt: new Date() }),
    ]);
    const { agentSessions } = stubAgentSessions({ p1: 0 });
    const svc = new ProfilesService(repo, null, null, null, null, agentSessions);
    await expect(svc.purge({ id: 'p1', accountId: 'acc_1' })).resolves.toBeUndefined();
    expect(state.rows.find((r) => r.id === 'p1')).toBeUndefined();
  });

  it('purge still works when agentSessions is not wired (fail-open, no behavior change)', async () => {
    const { repo, state } = makeRepo([
      makeProfile({ id: 'p1', accountId: 'acc_1', name: 'gone', deletedAt: new Date() }),
    ]);
    const svc = new ProfilesService(repo); // no agentSessions checker
    await expect(svc.purge({ id: 'p1', accountId: 'acc_1' })).resolves.toBeUndefined();
    expect(state.rows.find((r) => r.id === 'p1')).toBeUndefined();
  });

  it("404s on an unowned/non-trashed id WITHOUT ever calling the active-session checker (never confirms another account's profile)", async () => {
    const { repo } = makeRepo([
      // Live (not trashed) profile owned by a DIFFERENT account, with an
      // active session — purge must 404 on ownership/trashed-state first.
      makeProfile({ id: 'p_other', accountId: 'acc_other', name: 'live' }),
    ]);
    const { agentSessions, calls } = stubAgentSessions({ p_other: 1 });
    const svc = new ProfilesService(repo, null, null, null, null, agentSessions);
    await expect(svc.purge({ id: 'p_other', accountId: 'acc_1' })).rejects.toThrow(NotFoundError);
    expect(calls).toHaveLength(0);
  });
});

// #3 (2026-06-30) — transferProfile() must refuse to soft-delete the source
// profile while a live session is still bound to it: touch()/recordSave()
// are notDeleted-scoped, so the session's final save-back would silently
// no-op against the now-trashed row. Same guard as #1's purge fix.
describe('ProfilesService.transferProfile — live-session guard (FIX #3)', () => {
  it('refuses the transfer when the source profile has a live session bound to it, leaving the source intact and minting nothing for the recipient', async () => {
    const { repo, state } = makeRepo([
      makeProfile({ id: 'p1', accountId: 'acc_src', name: 'movable' }),
    ]);
    const { agentSessions } = stubAgentSessions({ p1: 1 });
    const svc = new ProfilesService(repo, null, null, null, null, agentSessions);
    await expect(
      svc.transferProfile({
        sourceProfileId: 'p1',
        sourceAccountId: 'acc_src',
        recipientAccountId: 'acc_dst',
        recipientTier: TEAM,
      }),
    ).rejects.toThrow(ConflictError);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.accountId).toBe('acc_src');
  });

  it('transfers normally once the source profile has no active session bound to it', async () => {
    const { repo, state } = makeRepo([
      makeProfile({ id: 'p1', accountId: 'acc_src', name: 'movable' }),
    ]);
    const { agentSessions } = stubAgentSessions({ p1: 0 });
    const svc = new ProfilesService(repo, null, null, null, null, agentSessions);
    const { newProfile } = await svc.transferProfile({
      sourceProfileId: 'p1',
      sourceAccountId: 'acc_src',
      recipientAccountId: 'acc_dst',
      recipientTier: TEAM,
    });
    expect(newProfile.accountId).toBe('acc_dst');
    expect(state.rows.find((r) => r.id === 'p1')).toBeUndefined();
  });
});

// doc-150 item 6 — per-account storage-quota state + the session-launch gate.
describe('ProfilesService storage quota (doc-150 item 6)', () => {
  const SOLO_CAP = TIER_STORAGE_BYTES_CAP.solo_manual; // 5 GiB

  it('getStorageState sums LIVE profiles + reports ok under the soft threshold', async () => {
    const { repo } = makeRepo([
      makeProfile({ id: 'p1', accountId: 'acc_1', name: 'a', sizeBytes: 1024 }),
      makeProfile({ id: 'p2', accountId: 'acc_1', name: 'b', sizeBytes: 2048 }),
    ]);
    const svc = new ProfilesService(repo);
    const state = await svc.getStorageState({ accountId: 'acc_1', tier: 'solo_manual' });
    expect(state.usedBytes).toBe(3072);
    expect(state.capBytes).toBe(SOLO_CAP);
    expect(state.state).toBe('ok');
  });

  it('getStorageState excludes trashed profiles from the sum', async () => {
    const { repo } = makeRepo([
      makeProfile({ id: 'p1', accountId: 'acc_1', name: 'live', sizeBytes: 100 }),
      makeProfile({
        id: 'p2',
        accountId: 'acc_1',
        name: 'trashed',
        sizeBytes: 999,
        deletedAt: new Date(),
      }),
    ]);
    const svc = new ProfilesService(repo);
    const state = await svc.getStorageState({ accountId: 'acc_1', tier: 'solo_manual' });
    expect(state.usedBytes).toBe(100);
  });

  it('assertWithinStorageQuotaForLaunch passes when under the hard cap', async () => {
    const { repo } = makeRepo([
      makeProfile({ id: 'p1', accountId: 'acc_1', name: 'a', sizeBytes: SOLO_CAP - 1 }),
    ]);
    const svc = new ProfilesService(repo);
    await expect(
      svc.assertWithinStorageQuotaForLaunch({ accountId: 'acc_1', tier: 'solo_manual' }),
    ).resolves.toBeUndefined();
  });

  it('assertWithinStorageQuotaForLaunch throws StorageQuotaExceededError at/over the hard cap', async () => {
    const { repo } = makeRepo([
      makeProfile({ id: 'p1', accountId: 'acc_1', name: 'a', sizeBytes: SOLO_CAP }),
    ]);
    const svc = new ProfilesService(repo);
    await expect(
      svc.assertWithinStorageQuotaForLaunch({ accountId: 'acc_1', tier: 'solo_manual' }),
    ).rejects.toThrow(StorageQuotaExceededError);
  });

  it('enterprise is soft-only — never blocks even far over its cap', async () => {
    const ENT_CAP = TIER_STORAGE_BYTES_CAP.enterprise;
    const { repo } = makeRepo([
      makeProfile({ id: 'p1', accountId: 'acc_1', name: 'a', sizeBytes: ENT_CAP * 2 }),
    ]);
    const svc = new ProfilesService(repo);
    const state = await svc.getStorageState({ accountId: 'acc_1', tier: 'enterprise' });
    expect(state.state).toBe('soft');
    await expect(
      svc.assertWithinStorageQuotaForLaunch({ accountId: 'acc_1', tier: 'enterprise' }),
    ).resolves.toBeUndefined();
  });
});
