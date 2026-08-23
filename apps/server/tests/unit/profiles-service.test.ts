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
import { InMemoryProfilesRepo } from '../integration/_helpers/in-memory-profiles-repo.js';
// V-1305 — the page default has one home in the repo; this stub restated it.
import { DEFAULT_PAGE } from '../../src/db/profiles-repo.js';

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
    // Mirrors the prod transaction: cap-check, CLAIM the source (only a live
    // row can be claimed), then insert. A double that skipped the claim would
    // let the concurrent-transfer bug pass here.
    transferAtomic: (args: {
      source: { id: string; accountId: string };
      insert: NewProfileInput;
      limit: number | null;
    }) => {
      if (args.limit !== null) {
        const current = rows.filter((r) => r.accountId === args.insert.accountId).length;
        if (current >= args.limit) {
          return Promise.resolve({ limitExceeded: true as const, current });
        }
      }
      const src = rows.find(
        (r) => r.id === args.source.id && r.accountId === args.source.accountId && !r.deletedAt,
      );
      if (!src) return Promise.resolve({ sourceAlreadyRetired: true as const });
      src.deletedAt = new Date();
      return repo.insertWithLimit(args.insert, null);
    },
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
        data: rows.filter((r) => r.accountId === accountId).slice(0, limit ?? DEFAULT_PAGE),
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
  calls: Array<{
    action: string;
    payload: Record<string, unknown> | null | undefined;
    // Captured so a test can tell the INTERNAL id form on the target apart from the PUBLIC
    // form in the payload. profile.exported deliberately uses both: `profile_<uuid>` as the
    // target, `prof_<uuid>` in the lineage keys, because the latter is what the export
    // envelope carries and therefore what a later profile.imported echoes back.
    targetResourceId: string | null | undefined;
  }>;
} {
  const calls: Array<{
    action: string;
    payload: Record<string, unknown> | null | undefined;
    targetResourceId: string | null | undefined;
  }> = [];
  const audit = {
    record: (args: {
      action: string;
      payload?: Record<string, unknown> | null;
      targetResourceId?: string | null;
    }) => {
      calls.push({
        action: args.action,
        payload: args.payload,
        targetResourceId: args.targetResourceId,
      });
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
/** V-1377 — 200 profiles; the copy-name bound needs 101 rows to be reachable at all. */
const AGENCY: AccountTier = 'agency_manual';

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

  it('CRITICAL two concurrent same-name creates: one wins, the LOSER gets a 409 from the unique-index race branch rather than an uncaught 500. Both requests pass the findByAccountAndName pre-check before either insert commits — the double-click case — so the pre-check cannot be what refuses the second. Until the fixture enforced `profiles_account_name_unique` this branch was unreachable in any double-backed test, and its only coverage was a content-parity pin asserting the source TEXT contains the catch.', async () => {
    // The SHARED double, not this file's local stub: the stub models no unique index, so the
    // branch under test cannot fire against it. That is the gap this arm exists to close — the
    // guards hardened `_helpers/in-memory-*`, and a file-local stub implementing the same
    // interface inherits none of it.
    const repo = new InMemoryProfilesRepo();
    const svc = new ProfilesService(repo);

    const settled = await Promise.allSettled([
      svc.create({ accountId: 'acc_1', tier: SOLO, name: 'double-click' }),
      svc.create({ accountId: 'acc_1', tier: SOLO, name: 'double-click' }),
    ]);

    const won = settled.filter((r) => r.status === 'fulfilled');
    const lost = settled.filter((r) => r.status === 'rejected');
    expect(won, 'both concurrent creates were refused — nobody got the profile').toHaveLength(1);
    expect(
      lost,
      'both concurrent creates succeeded — the account holds two live profiles ' +
        'with one name, which the partial unique index forbids',
    ).toHaveLength(1);

    const reason = (lost[0] as PromiseRejectedResult).reason;
    expect(
      reason,
      'the race loser saw a raw unique violation rather than the translated conflict — a 500 ' +
        'where the customer should get a 409',
    ).toBeInstanceOf(ConflictError);
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

  // V-1377 — the copy-name search is a bounded loop, and coverage put its exhaustion
  // refusal in the never-executed set. The arm above proves the loop ADVANCES; nothing
  // proved where it stops. A bound nobody has crossed is a bound nobody has checked: off
  // by one in the generous direction it hands back a name that already exists (and the
  // insert then races the unique index), and in the strict direction it refuses a clone
  // the customer could have had.
  function copyNames(upTo: number): string[] {
    return Array.from({ length: upTo }, (_, i) => (i === 0 ? 'src (copy)' : `src (copy ${i + 1})`));
  }

  it('CRITICAL with every copy name taken the clone is REFUSED rather than colliding. The loop tries 99 candidates and then stops; without the refusal the caller would either loop forever or be handed a name that is already in use.', async () => {
    const taken = copyNames(99);
    const { repo } = makeRepo([
      makeProfile({ id: 'p1', accountId: 'acc_1', name: 'src' }),
      ...taken.map((name, i) => makeProfile({ id: `pc${String(i)}`, accountId: 'acc_1', name })),
    ]);
    const svc = new ProfilesService(repo);

    await expect(svc.clone({ id: 'p1', accountId: 'acc_1', tier: AGENCY })).rejects.toThrow(
      /Too many copies of this profile already exist/,
    );
    await expect(svc.clone({ id: 'p1', accountId: 'acc_1', tier: AGENCY })).rejects.toMatchObject({
      status: 409,
      extensions: { resource: 'profile', field: 'name' },
    });
  });

  it('CRITICAL and the bound is exactly 99, not 98: with the last candidate still free the clone takes it. Asserting only the refusal above would pass just as well against a loop that gave up early, which is the failure a customer actually notices.', async () => {
    const taken = copyNames(98);
    const { repo } = makeRepo([
      makeProfile({ id: 'p1', accountId: 'acc_1', name: 'src' }),
      ...taken.map((name, i) => makeProfile({ id: `pc${String(i)}`, accountId: 'acc_1', name })),
    ]);
    const svc = new ProfilesService(repo);

    const row = await svc.clone({ id: 'p1', accountId: 'acc_1', tier: AGENCY });
    expect(row.name, 'the last free candidate must be used, not refused').toBe('src (copy 99)');
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

  it('CRITICAL profile.exported carries the documented lineage keys, in the PUBLIC `prof_` form the export envelope uses — the form is what makes an export joinable to the import that consumed it', async () => {
    const { repo } = makeRepo([makeProfile({ id: 'p1', accountId: 'acc_1', name: 'exp' })]);
    const { audit, calls } = makeAudit();
    const svc = new ProfilesService(repo, audit);
    await svc.exportProfile({ id: 'p1', accountId: 'acc_1' });

    const payload = calls[0]?.payload as Record<string, unknown> | undefined;
    // Documented at apps/docs/src/pages/api/audit-log.md as "Payload carries
    // source_profile_id + source_account_id for portability lineage". Before this, a
    // compliance consumer reading either key got undefined in the list JSON, the JSON export
    // and the CSV payload column.
    expect(payload?.source_profile_id, 'must match the envelope, not the internal id').toBe(
      'prof_p1',
    );
    expect(payload?.source_account_id).toBe('acc_1');
    // The internal `profile_` prefix stays on targetResourceId; mixing the two is what would
    // break the join against profile.imported.
    expect(calls[0]?.targetResourceId).toBe('profile_p1');
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

  // ─── recipient tier caps ──────────────────────────────────────────────
  //
  // Added 2026-08-15. `transferProfile` carries THREE TierLimitError refusals
  // and none had executed. `create`, `clone` and `importProfile` each had a
  // cap arm; transfer did not — so profile transfer, which is the one path that
  // moves a profile INTO an account the caller does not own, was the only
  // tier-cap boundary nothing watched.
  //
  // The pin that names this control cannot see it either: its anchor is
  // `/throw new TierLimitError\(/`, which matches 10 places in profiles.ts, so
  // deleting any single cap check leaves it green (assessment item 5h).
  //
  // All three refusals measure the RECIPIENT, never the caller — that is the
  // whole point of the check and the easiest thing to get backwards.
  //
  // MUTATION-PROVED against profiles.ts — control 61/61 here, 19/19 on the pin:
  //
  //                                                     here   tier pin
  //   the recipient profile-cap pre-check removed      1 red    green
  //   the cap measured against the SENDER              1 red    green
  //   the monthly import cap removed                   1 red    green
  //   the race-safe limitExceeded branch removed       1 red    green
  //
  // The pin is green on all four while its own anchor is `/throw new
  // TierLimitError\(/` — which matches 10 sites in profiles.ts, so no single
  // cap check being deleted can move it. That is item 5h stated concretely.
  //
  // ⚠️ The pre-check needed a SECOND look. With the obvious fixture — a
  // recipient at cap — removing it changed nothing, because the atomic insert's
  // `limitExceeded` catches the same condition and still throws TierLimitError.
  // That is not a hole in the arm: the pre-check is a fast path over an
  // authoritative check, and in production the two read the same count, so
  // removing it does not weaken enforcement. What it DOES decide is which limit
  // the customer is named — profile cap or import cap — and only one of those
  // tells them something they can act on. The arm that discriminates it asserts
  // exactly that, rather than a contrived fixture where the double disagrees
  // with itself.

  it('CRITICAL refuses a transfer that would put the RECIPIENT over their profile cap. This is the only path that adds a profile to an account the caller does not own, so without it a customer on any tier can be pushed past the cap they are billed against — by someone else, and without their involvement.', async () => {
    const { repo, state } = makeRepo(
      [makeProfile({ id: 'p1', accountId: 'acc_src', name: 'movable' })],
      { countOverride: 10 }, // solo_manual permits exactly 10
    );
    const svc = new ProfilesService(repo);
    await expect(
      svc.transferProfile({
        sourceProfileId: 'p1',
        sourceAccountId: 'acc_src',
        recipientAccountId: 'acc_dst',
        recipientTier: SOLO,
      }),
    ).rejects.toThrow(TierLimitError);
    // Refused BEFORE any mutation — the source profile is untouched.
    expect(
      state.rows.find((r) => r.id === 'p1'),
      'source preserved on refusal',
    ).toBeDefined();
  });

  it('CRITICAL an account at BOTH caps is told about the profile cap, not the import cap. Which limit is named decides what the customer does next — delete a profile, or wait for the cycle to roll — and only one of those resolves the block. This is also the arm that gives the pre-check its own behaviour: with it removed, an at-cap recipient still gets a TierLimitError from the atomic insert, so every other arm here stays green (measured) and only the RESOURCE in the error changes.', async () => {
    const { repo } = makeRepo([makeProfile({ id: 'p1', accountId: 'acc_src', name: 'movable' })], {
      countOverride: 10, // at the solo_manual profile cap
    });
    const audit = {
      record: () => Promise.resolve(),
      countActionsSince: () => Promise.resolve(20), // and at the import cap
    };
    const svc = new ProfilesService(repo, audit as never);
    await expect(
      svc.transferProfile({
        sourceProfileId: 'p1',
        sourceAccountId: 'acc_src',
        recipientAccountId: 'acc_dst',
        recipientTier: SOLO,
      }),
    ).rejects.toMatchObject({ extensions: { resource: 'profile' } });
  });

  it("CRITICAL the cap is measured against the RECIPIENT, not the sender. A sender at their own limit is exactly the account most likely to be transferring a profile away, and reading the wrong side would block the transfer that resolves their overage while permitting the one that creates someone else's.", async () => {
    const { repo } = makeRepo([makeProfile({ id: 'p1', accountId: 'acc_src', name: 'movable' })]);
    // The sender holds far more than the recipient tier allows; the recipient
    // is empty. countByAccount answers per-account so the two differ.
    repo.countByAccount = (accountId: string) =>
      Promise.resolve(accountId === 'acc_src' ? 9_999 : 0);
    const svc = new ProfilesService(repo);
    const { newProfile } = await svc.transferProfile({
      sourceProfileId: 'p1',
      sourceAccountId: 'acc_src',
      recipientAccountId: 'acc_dst',
      recipientTier: SOLO,
    });
    expect(newProfile.accountId, 'transfer completed into the recipient').toBe('acc_dst');
  });

  it('CRITICAL refuses when the recipient has exhausted their monthly import allowance, which is a SEPARATE cap from the profile count. It is limit*2 per cycle and it exists so a transfer cannot be used as an unmetered drip into an account that stays under its profile cap by deleting as it receives — the profile count alone would never notice that.', async () => {
    const { repo } = makeRepo([makeProfile({ id: 'p1', accountId: 'acc_src', name: 'movable' })]);
    const audit = {
      record: () => Promise.resolve(),
      // solo_manual = 10 profiles, so the import cap is 20 per cycle.
      countActionsSince: () => Promise.resolve(20),
    };
    const svc = new ProfilesService(repo, audit as never);
    await expect(
      svc.transferProfile({
        sourceProfileId: 'p1',
        sourceAccountId: 'acc_src',
        recipientAccountId: 'acc_dst',
        recipientTier: SOLO,
      }),
    ).rejects.toThrow(TierLimitError);
  });

  // V-1340 — the same race backstop on CLONE and IMPORT, which the transfer arm
  // below covers for transfer alone. Coverage said both were never executed:
  // four paths create a profile, each carries its own pre-check AND its own
  // conditional-insert branch, and only two of the four conditional branches had
  // ever run. A cap enforced on three paths out of four is not a cap.
  it('CRITICAL CLONE refuses when the atomic insert reports the account at cap, even though the pre-check passed. Cloning is the cheapest way to add a profile — one call, no payload — so it is the likeliest path to win the race that puts an account over the allowance it is billed for.', async () => {
    const { repo } = makeRepo([makeProfile({ id: 'p1', accountId: 'acc_1', name: 'source' })]);
    // Pre-check sees room; the conditional insert disagrees, which is what a
    // concurrent create looks like from inside this call.
    repo.countByAccount = () => Promise.resolve(0);
    repo.insertWithLimit = () => Promise.resolve({ limitExceeded: true as const, current: 10 });
    const svc = new ProfilesService(repo);
    await expect(svc.clone({ id: 'p1', accountId: 'acc_1', tier: SOLO })).rejects.toThrow(
      TierLimitError,
    );
  });

  it('CRITICAL IMPORT refuses when the atomic insert reports the account at cap, even though the pre-check passed. Import is the path a customer reaches for when moving profiles in bulk, so it is the one where several calls land close enough together for the pre-check to be stale on all of them.', async () => {
    const { repo } = makeRepo([]);
    repo.countByAccount = () => Promise.resolve(0);
    repo.insertWithLimit = () => Promise.resolve({ limitExceeded: true as const, current: 10 });
    const svc = new ProfilesService(repo);
    await expect(
      svc.importProfile({
        accountId: 'acc_1',
        tier: SOLO,
        sourceProfileId: 'prof_00000000-0000-4000-8000-000000000001',
        sourceAccountId: 'acc_src',
        payload: {
          name: 'imported-at-the-cap',
          archetype: 'iphone17_ios18_7_safari26_4',
          description: null,
        },
      }),
    ).rejects.toThrow(TierLimitError);
  });

  it('CRITICAL refuses when the ATOMIC INSERT reports the recipient at cap, even though the pre-check passed. That is the race: two transfers into the same recipient both read a count under the limit, and only the conditional insert can settle it. Without this branch the loser of that race is written anyway and the recipient ends up over the cap they are billed against — the pre-check alone cannot prevent it, which is why both exist.', async () => {
    const { repo, state } = makeRepo([
      makeProfile({ id: 'p1', accountId: 'acc_src', name: 'movable' }),
    ]);
    // Pre-check sees room; the conditional insert disagrees, which is exactly
    // what a concurrent transfer looks like from inside this call.
    repo.countByAccount = () => Promise.resolve(0);
    repo.insertWithLimit = () => Promise.resolve({ limitExceeded: true as const, current: 10 });
    const svc = new ProfilesService(repo);
    await expect(
      svc.transferProfile({
        sourceProfileId: 'p1',
        sourceAccountId: 'acc_src',
        recipientAccountId: 'acc_dst',
        recipientTier: SOLO,
      }),
    ).rejects.toThrow(TierLimitError);
    expect(
      state.rows.find((r) => r.id === 'p1'),
      'source preserved on refusal',
    ).toBeDefined();
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
    // The source is RETIRED, not erased: prod soft-deletes (sets deleted_at) and
    // transferAtomic models that. This previously expected the row to vanish,
    // which only held because this fake's `delete` splices the array — an
    // inaccuracy in the double rather than a property of the system.
    const retired = state.rows.find((r) => r.id === 'p1');
    expect(retired, 'the source row still exists').toBeDefined();
    expect(retired?.deletedAt, 'and is retired, exactly once').toBeInstanceOf(Date);
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
