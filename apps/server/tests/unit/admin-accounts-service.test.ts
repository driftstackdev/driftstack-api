// V-553.B-15 — unit tests for AccountsAdminService (admin tier/status
// mutations with auth-cache invalidation).
//
// Surface under test:
//   - getAccount / list / countByStatus: scope gate + repo pass-through
//   - changeTier / suspend / unsuspend: scope gate, NotFound on
//     unknown id, success path bumps cache, cache failures swallowed
//   - all five mutators require driftstack_internal_admin

import { describe, expect, it, vi } from 'vitest';
import type { AccountTier, ApiKeyScope } from '@driftstack/api-types';
import {
  AccountsAdminService,
  type AccountsAdminRepo,
  type ListAccountsArgs,
  type ListAccountsPage,
} from '../../src/services/admin-accounts.js';
import type { AccountContext, AccountRow } from '../../src/services/auth.js';
import type { AuthCache } from '../../src/services/auth-cache.js';

function ctxWith(scopes: ApiKeyScope[]): AccountContext {
  return {
    account: { id: 'acc_admin' },
    apiKey: { id: 'key_admin', scopes },
  } as unknown as AccountContext;
}

function baseAccount(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 'acc_1',
    email: 'a@b.test',
    tier: 'solo_manual',
    status: 'active',
    createdAt: new Date('2026-05-01Z'),
    updatedAt: new Date('2026-05-01Z'),
    ...overrides,
  } as AccountRow;
}

function makeRepo(initial: AccountRow[] = []): {
  repo: AccountsAdminRepo;
  rows: AccountRow[];
} {
  const rows: AccountRow[] = [...initial];
  const repo: AccountsAdminRepo = {
    findById: (id) => Promise.resolve(rows.find((r) => r.id === id) ?? null),
    setTier: (id, tier, at) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return Promise.resolve(null);
      row.tier = tier;
      row.updatedAt = at;
      return Promise.resolve(row);
    },
    setStatus: (id, status, at) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return Promise.resolve(null);
      (row as AccountRow & { status: string }).status = status;
      row.updatedAt = at;
      return Promise.resolve(row);
    },
    list: (args: ListAccountsArgs) => {
      const limit = args.limit ?? 50;
      let filtered = rows;
      if (args.status !== undefined) {
        filtered = filtered.filter(
          (r) => (r as AccountRow & { status: string }).status === args.status,
        );
      }
      if (args.tier !== undefined) filtered = filtered.filter((r) => r.tier === args.tier);
      if (args.emailContains !== undefined) {
        const needle = args.emailContains.toLowerCase();
        filtered = filtered.filter((r) => r.email.toLowerCase().includes(needle));
      }
      const page = filtered.slice(0, limit);
      const result: ListAccountsPage = {
        data: page,
        hasMore: filtered.length > limit,
        nextCursor: filtered.length > limit ? (page[page.length - 1]?.id ?? null) : null,
      };
      return Promise.resolve(result);
    },
    countByStatus: (status) =>
      Promise.resolve(
        rows.filter((r) => (r as AccountRow & { status: string }).status === status).length,
      ),
  };
  return { repo, rows };
}

function makeCache(): { cache: AuthCache; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(() => Promise.resolve());
  const cache = { invalidateAccount: spy } as unknown as AuthCache;
  return { cache, spy };
}

describe('V-553.B-15 AccountsAdminService — scope gates', () => {
  it('every public method requires driftstack_internal_admin', async () => {
    const { repo } = makeRepo([baseAccount()]);
    const svc = new AccountsAdminService(repo);
    const unscoped = ctxWith(['account_owner']);
    await expect(svc.getAccount(unscoped, 'acc_1')).rejects.toThrow(/driftstack_internal_admin/);
    await expect(svc.list(unscoped, {})).rejects.toThrow(/driftstack_internal_admin/);
    await expect(svc.countByStatus(unscoped, 'active')).rejects.toThrow(
      /driftstack_internal_admin/,
    );
    await expect(svc.changeTier(unscoped, 'acc_1', 'team_manual')).rejects.toThrow(
      /driftstack_internal_admin/,
    );
    await expect(svc.suspend(unscoped, 'acc_1')).rejects.toThrow(/driftstack_internal_admin/);
    await expect(svc.unsuspend(unscoped, 'acc_1')).rejects.toThrow(/driftstack_internal_admin/);
  });

  it('admin scope satisfies internal-admin via V-174 alias', async () => {
    const { repo } = makeRepo([baseAccount()]);
    const svc = new AccountsAdminService(repo);
    await expect(svc.getAccount(ctxWith(['admin']), 'acc_1')).resolves.toBeDefined();
  });
});

describe('V-553.B-15 AccountsAdminService.getAccount', () => {
  it('returns the row when found', async () => {
    const { repo } = makeRepo([baseAccount({ id: 'acc_42', email: 'who@e.test' })]);
    const svc = new AccountsAdminService(repo);
    const row = await svc.getAccount(ctxWith(['driftstack_internal_admin']), 'acc_42');
    expect(row.email).toBe('who@e.test');
  });

  it('throws NotFound for unknown id', async () => {
    const { repo } = makeRepo();
    const svc = new AccountsAdminService(repo);
    await expect(
      svc.getAccount(ctxWith(['driftstack_internal_admin']), 'acc_missing'),
    ).rejects.toThrow(/not found/);
  });
});

describe('V-553.B-15 AccountsAdminService.list + countByStatus', () => {
  it('list forwards filters to the repo', async () => {
    const { repo } = makeRepo([
      baseAccount({ id: 'a1', email: 'alpha@e.test', tier: 'solo_manual' as AccountTier }),
      baseAccount({ id: 'a2', email: 'bravo@e.test', tier: 'team_manual' as AccountTier }),
      baseAccount({ id: 'a3', email: 'charlie@e.test', tier: 'solo_manual' as AccountTier }),
    ]);
    const svc = new AccountsAdminService(repo);
    const page = await svc.list(ctxWith(['driftstack_internal_admin']), {
      tier: 'solo_manual',
    });
    expect(page.data.map((r) => r.id)).toEqual(['a1', 'a3']);
  });

  it('countByStatus passes through to the repo', async () => {
    const { repo } = makeRepo([
      baseAccount({ id: 'a1' }),
      { ...baseAccount({ id: 'a2' }), status: 'suspended' } as unknown as AccountRow,
    ]);
    const svc = new AccountsAdminService(repo);
    const n = await svc.countByStatus(ctxWith(['driftstack_internal_admin']), 'active');
    expect(n).toBe(1);
  });
});

describe('V-553.B-15 AccountsAdminService.changeTier', () => {
  it('updates the tier + invalidates auth cache on success', async () => {
    const { repo, rows } = makeRepo([baseAccount()]);
    const { cache, spy } = makeCache();
    const svc = new AccountsAdminService(repo, cache);
    const updated = await svc.changeTier(
      ctxWith(['driftstack_internal_admin']),
      'acc_1',
      'team_manual',
    );
    expect(updated.tier).toBe('team_manual');
    expect(rows[0]?.tier).toBe('team_manual');
    expect(spy).toHaveBeenCalledWith('acc_1');
  });

  it('throws NotFound when account does not exist', async () => {
    const { repo } = makeRepo();
    const svc = new AccountsAdminService(repo);
    await expect(
      svc.changeTier(ctxWith(['driftstack_internal_admin']), 'acc_missing', 'team_manual'),
    ).rejects.toThrow(/not found/);
  });

  it('swallows cache-invalidation failures — mutation succeeds anyway', async () => {
    const { repo } = makeRepo([baseAccount()]);
    const invalidateSpy = vi.fn(() => Promise.reject(new Error('cache down')));
    const cache = { invalidateAccount: invalidateSpy } as unknown as AuthCache;
    const svc = new AccountsAdminService(repo, cache);
    const result = await svc.changeTier(
      ctxWith(['driftstack_internal_admin']),
      'acc_1',
      'team_manual',
    );
    expect(result.tier).toBe('team_manual');
  });
});

describe('V-553.B-15 AccountsAdminService.suspend / unsuspend', () => {
  it('suspend flips status + invalidates cache', async () => {
    const { repo, rows } = makeRepo([baseAccount()]);
    const { cache, spy } = makeCache();
    const svc = new AccountsAdminService(repo, cache);
    await svc.suspend(ctxWith(['driftstack_internal_admin']), 'acc_1');
    expect((rows[0] as AccountRow & { status: string }).status).toBe('suspended');
    expect(spy).toHaveBeenCalledWith('acc_1');
  });

  it('unsuspend flips back + invalidates cache', async () => {
    const { repo, rows } = makeRepo([
      { ...baseAccount(), status: 'suspended' } as unknown as AccountRow,
    ]);
    const { cache, spy } = makeCache();
    const svc = new AccountsAdminService(repo, cache);
    await svc.unsuspend(ctxWith(['driftstack_internal_admin']), 'acc_1');
    expect((rows[0] as AccountRow & { status: string }).status).toBe('active');
    expect(spy).toHaveBeenCalledWith('acc_1');
  });

  it('suspend NotFound on missing account', async () => {
    const { repo } = makeRepo();
    const svc = new AccountsAdminService(repo);
    await expect(
      svc.suspend(ctxWith(['driftstack_internal_admin']), 'acc_missing'),
    ).rejects.toThrow(/not found/);
  });

  it('unsuspend NotFound on missing account', async () => {
    const { repo } = makeRepo();
    const svc = new AccountsAdminService(repo);
    await expect(
      svc.unsuspend(ctxWith(['driftstack_internal_admin']), 'acc_missing'),
    ).rejects.toThrow(/not found/);
  });

  it('suspend reclaims the account running sessions via the injected reclaimer', async () => {
    const { repo } = makeRepo([baseAccount()]);
    const calls: string[] = [];
    const svc = new AccountsAdminService(repo, null, {
      destroyAllForAccount: (id: string) => {
        calls.push(id);
        return Promise.resolve(2);
      },
    });
    await svc.suspend(ctxWith(['driftstack_internal_admin']), 'acc_1');
    expect(calls).toEqual(['acc_1']);
  });

  it('suspend succeeds even when the session reclaim throws (best-effort)', async () => {
    const { repo } = makeRepo([baseAccount()]);
    const svc = new AccountsAdminService(repo, null, {
      destroyAllForAccount: () => Promise.reject(new Error('reclaim boom')),
    });
    await expect(
      svc.suspend(ctxWith(['driftstack_internal_admin']), 'acc_1'),
    ).resolves.toBeDefined();
  });
});
