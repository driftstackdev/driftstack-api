// V-553.B-21 — unit tests for ProfilesService.
//
// Surface under test:
//   - create(): TierLimitError at cap, ConflictError on name dup,
//     happy path + audit emission
//   - get(): NotFound on missing
//   - update(): name-conflict against a DIFFERENT id, NotFound,
//     happy path
//   - delete(): NotFound, happy path + audit
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
  type ProfileUpdates,
  type NewProfileInput,
} from '../../src/services/profiles.js';
import type { AccountAuditService } from '../../src/services/account-audit.js';
import { ConflictError, NotFoundError, TierLimitError } from '../../src/lib/errors.js';

function makeProfile(overrides: Partial<ProfileRecord> = {}): ProfileRecord {
  return {
    id: 'p1',
    accountId: 'acc_1',
    name: 'starter',
    archetype: 'default',
    description: null,
    lastUsedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
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
        id: `p_new_${counter.toString()}`,
        accountId: input.accountId,
        name: input.name,
        archetype: input.archetype,
        description: input.description,
        lastUsedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      rows.push(row);
      return Promise.resolve(row);
    },
    countByAccount: (accountId) =>
      Promise.resolve(opts.countOverride ?? rows.filter((r) => r.accountId === accountId).length),
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
    touch: () => Promise.resolve(),
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

  it('translates a concurrent same-name 23505 (race loser) into ConflictError, not a 500', async () => {
    // The findByAccountAndName pre-check misses (empty store), but a sibling
    // request committed first → insert hits profiles_account_name_unique.
    const { repo } = makeRepo();
    repo.insert = () => Promise.reject(nameRace23505());
    const svc = new ProfilesService(repo);
    await expect(svc.create({ accountId: 'acc_1', tier: SOLO, name: 'racy' })).rejects.toThrow(
      ConflictError,
    );
  });

  it('re-throws a non-constraint insert error (the race catch is precise, not a catch-all)', async () => {
    const { repo } = makeRepo();
    repo.insert = () => Promise.reject(new Error('db exploded'));
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
      archetype: 'mobile_ios',
      description: 'first one',
    });
    expect(row.name).toBe('fresh');
    expect(row.archetype).toBe('mobile_ios');
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
});

describe('V-553.B-21 ProfilesService.delete', () => {
  it('throws NotFound when row is missing', async () => {
    const { repo } = makeRepo();
    const svc = new ProfilesService(repo);
    await expect(svc.delete({ id: 'p_missing', accountId: 'acc_1' })).rejects.toThrow(
      NotFoundError,
    );
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

  it('translates a concurrent explicit-name 23505 (race loser) into ConflictError', async () => {
    // findByAccountAndName('fresh') misses, but a sibling took it before the
    // insert commits → profiles_account_name_unique fires.
    const { repo } = makeRepo([makeProfile({ id: 'p1', accountId: 'acc_1', name: 'src' })]);
    repo.insert = () => Promise.reject(nameRace23505());
    const svc = new ProfilesService(repo);
    await expect(
      svc.clone({ id: 'p1', accountId: 'acc_1', tier: TEAM, name: 'fresh' }),
    ).rejects.toThrow(ConflictError);
  });

  it('re-throws a non-constraint clone insert error (the catch is precise)', async () => {
    const { repo } = makeRepo([makeProfile({ id: 'p1', accountId: 'acc_1', name: 'src' })]);
    repo.insert = () => Promise.reject(new Error('db exploded'));
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
  it('throws TierLimitError when at cap', async () => {
    const { repo } = makeRepo([], { countOverride: 1_000_000 });
    const svc = new ProfilesService(repo);
    await expect(
      svc.importProfile({
        accountId: 'acc_1',
        tier: SOLO,
        sourceProfileId: 'p_src',
        sourceAccountId: 'acc_src',
        payload: { name: 'imported', archetype: 'default', description: null },
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
        payload: { name: 'imported', archetype: 'default', description: null },
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
      payload: { name: 'imported', archetype: 'mobile_ios', description: 'note' },
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
    repo.insert = () => Promise.reject(nameRace23505());
    const svc = new ProfilesService(repo);
    await expect(
      svc.importProfile({
        accountId: 'acc_1',
        tier: TEAM,
        sourceProfileId: 'p_src',
        sourceAccountId: 'acc_src',
        payload: { name: 'fresh', archetype: 'default', description: null },
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
    repo.insert = () => Promise.reject(nameRace23505());
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
