// V-553.B-15 — unit tests for AccountsAdminService (admin tier/status
// mutations with auth-cache invalidation).
//
// Surface under test:
//   - getAccount / list / countByStatus: scope gate + repo pass-through
//   - changeTier / suspend / unsuspend: scope gate, NotFound on
//     unknown id, success path bumps cache, cache failures swallowed
//   - all five mutators require driftstack_internal_admin

import { describe, expect, it, vi } from 'vitest';
import { AccountTierSchema, type AccountTier, type ApiKeyScope } from '@driftstack/api-types';
import {
  AccountsAdminService,
  type AccountsAdminRepo,
  type ListAccountsArgs,
  type ListAccountsPage,
} from '../../src/services/admin-accounts.js';
import type { AccountContext, AccountRow } from '../../src/services/auth.js';
import type { AuthCache } from '../../src/services/auth-cache.js';
import { SessionsService } from '../../src/services/sessions.js';
import { InMemorySessionsRepo } from '../integration/_helpers/in-memory-sessions-repo.js';
import type { Driver } from '../../src/drivers/types.js';
// V-1305 — the page default has one home in the repo; this stub restated it.
import { ADMIN_ACCOUNTS_PAGE_DEFAULT } from '../../src/db/admin-accounts-repo.js';

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
      const limit = args.limit ?? ADMIN_ACCOUNTS_PAGE_DEFAULT;
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
    countByTier: () => {
      const out = {} as Record<AccountTier, number>;
      for (const tier of AccountTierSchema.options) out[tier] = 0;
      for (const r of rows) out[r.tier] += 1;
      return Promise.resolve(out);
    },
    countCreatedSince: (since) =>
      Promise.resolve(rows.filter((r) => r.createdAt.getTime() >= since.getTime()).length),
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
    await expect(svc.countByTier(unscoped)).rejects.toThrow(/driftstack_internal_admin/);
    await expect(svc.signupCounts(unscoped, new Date())).rejects.toThrow(
      /driftstack_internal_admin/,
    );
    await expect(svc.changeTier(unscoped, 'acc_1', 'team_manual')).rejects.toThrow(
      /driftstack_internal_admin/,
    );
    await expect(svc.suspend(unscoped, 'acc_1')).rejects.toThrow(/driftstack_internal_admin/);
    await expect(svc.unsuspend(unscoped, 'acc_1')).rejects.toThrow(/driftstack_internal_admin/);
  });

  it('legacy customer admin cannot satisfy staff authority; exact internal-admin can', async () => {
    const { repo } = makeRepo([baseAccount()]);
    const svc = new AccountsAdminService(repo);
    await expect(svc.getAccount(ctxWith(['admin']), 'acc_1')).rejects.toThrow(
      /driftstack_internal_admin/,
    );
    await expect(
      svc.getAccount(ctxWith(['driftstack_internal_admin']), 'acc_1'),
    ).resolves.toBeDefined();
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

  it('countByTier returns a zero-filled distribution over every tier', async () => {
    const { repo } = makeRepo([
      baseAccount({ id: 'a1', tier: 'solo_manual' as AccountTier }),
      baseAccount({ id: 'a2', tier: 'solo_manual' as AccountTier }),
      baseAccount({ id: 'a3', tier: 'team_manual' as AccountTier }),
    ]);
    const svc = new AccountsAdminService(repo);
    const dist = await svc.countByTier(ctxWith(['driftstack_internal_admin']));
    expect(dist.solo_manual).toBe(2);
    expect(dist.team_manual).toBe(1);
    expect(dist.enterprise).toBe(0); // present even with no accounts
    // Every canonical tier key is present and the distribution sums to the row count.
    expect(Object.keys(dist).sort()).toEqual([...AccountTierSchema.options].sort());
    expect(Object.values(dist).reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('signupCounts buckets accounts by created-at into today / 7d / 30d windows', async () => {
    const now = new Date('2026-06-02T12:00:00.000Z');
    const { repo } = makeRepo([
      baseAccount({ id: 'd0', createdAt: new Date('2026-06-02T01:00:00.000Z') }), // today
      baseAccount({ id: 'd3', createdAt: new Date('2026-05-30T12:00:00.000Z') }), // 3d ago
      baseAccount({ id: 'd20', createdAt: new Date('2026-05-13T12:00:00.000Z') }), // 20d ago
      baseAccount({ id: 'd60', createdAt: new Date('2026-04-03T12:00:00.000Z') }), // 60d ago
    ]);
    const svc = new AccountsAdminService(repo);
    const s = await svc.signupCounts(ctxWith(['driftstack_internal_admin']), now);
    expect(s.today).toBe(1); // only d0
    expect(s.last_7d).toBe(2); // d0 + d3
    expect(s.last_30d).toBe(3); // d0 + d3 + d20 (not d60)
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

  it('suspend drives a REAL SessionsService.destroyAllForAccount end-to-end (full chain → repo + driver)', async () => {
    const { repo } = makeRepo([baseAccount()]);
    const sessionsRepo = new InMemorySessionsRepo();
    const destroyed: string[] = [];
    const driver = {
      destroy: (id: string) => {
        destroyed.push(id);
        return Promise.resolve();
      },
    } as unknown as Driver;
    const sessionsService = new SessionsService({ repo: sessionsRepo, driver });
    sessionsRepo.seedSession({
      accountId: 'acc_1',
      status: 'ready',
      createdAt: new Date('2026-05-31Z'),
      driverSessionId: 'drv-1',
    });
    const svc = new AccountsAdminService(repo, null, sessionsService);
    await svc.suspend(ctxWith(['driftstack_internal_admin']), 'acc_1');
    expect(destroyed).toEqual(['drv-1']);
  });
});

describe('GDPR Article 17 AccountsAdminService.deleteAccount', () => {
  it('requires driftstack_internal_admin', async () => {
    const { repo } = makeRepo([baseAccount()]);
    const svc = new AccountsAdminService(repo);
    await expect(svc.deleteAccount(ctxWith(['account_owner']), 'acc_1')).rejects.toThrow(
      /driftstack_internal_admin/,
    );
  });

  it('flips status to deleted + invalidates cache', async () => {
    const { repo, rows } = makeRepo([baseAccount()]);
    const { cache, spy } = makeCache();
    const svc = new AccountsAdminService(repo, cache);
    const updated = await svc.deleteAccount(ctxWith(['driftstack_internal_admin']), 'acc_1');
    expect(updated.status).toBe('deleted');
    expect((rows[0] as AccountRow & { status: string }).status).toBe('deleted');
    expect(spy).toHaveBeenCalledWith('acc_1');
  });

  it('NotFound on missing account', async () => {
    const { repo } = makeRepo();
    const svc = new AccountsAdminService(repo);
    await expect(
      svc.deleteAccount(ctxWith(['driftstack_internal_admin']), 'acc_missing'),
    ).rejects.toThrow(/not found/);
  });

  // Mutation-check surface: each of the 4 reclaim steps below is
  // independently asserted. Temporarily commenting out any ONE of the
  // corresponding `if (this.x) { ... }` blocks in
  // AccountsAdminService.deleteAccount would fail exactly the matching
  // test here (verified manually — see the task's mutation-test report).

  it('reclaims running sessions via the injected sessions reclaimer', async () => {
    const { repo } = makeRepo([baseAccount()]);
    const calls: string[] = [];
    const svc = new AccountsAdminService(repo, null, {
      destroyAllForAccount: (id: string) => {
        calls.push(id);
        return Promise.resolve(2);
      },
    });
    await svc.deleteAccount(ctxWith(['driftstack_internal_admin']), 'acc_1');
    expect(calls).toEqual(['acc_1']);
  });

  it('reclaims web sessions via the injected web-session reclaimer', async () => {
    const { repo } = makeRepo([baseAccount()]);
    const calls: string[] = [];
    const svc = new AccountsAdminService(repo, null, null, {
      revokeAllWebSessionsForAccount: (id: string) => {
        calls.push(id);
        return Promise.resolve(3);
      },
    });
    await svc.deleteAccount(ctxWith(['driftstack_internal_admin']), 'acc_1');
    expect(calls).toEqual(['acc_1']);
  });

  it('reclaims API keys via the injected api-key reclaimer', async () => {
    const { repo } = makeRepo([baseAccount()]);
    const calls: string[] = [];
    const svc = new AccountsAdminService(repo, null, null, null, {
      // V-727 — the delete path now also revokes keys this account minted on
      // OTHER accounts; record it under a distinct label so the existing
      // by-account assertion stays exact.
      revokeAllMintedByAccount: (_ctx: AccountContext, id: string) => {
        calls.push(`minted-by:${id}`);
        return Promise.resolve(0);
      },
      revokeAllForAccount: (_ctx, id: string) => {
        calls.push(id);
        return Promise.resolve(1);
      },
    });
    await svc.deleteAccount(ctxWith(['driftstack_internal_admin']), 'acc_1');
    // V-727 — BOTH reclaims run: the keys ON the account, and the keys the
    // account minted on OTHER accounts. The second is not redundant — it is the
    // only one that can reach a team member's keys, which live on the owner's
    // account and authenticate as the owner.
    expect([...calls].sort()).toEqual(['acc_1', 'minted-by:acc_1']);
  });

  it('reclaims webhook endpoints via the injected webhook reclaimer', async () => {
    const { repo } = makeRepo([baseAccount()]);
    const calls: string[] = [];
    const svc = new AccountsAdminService(repo, null, null, null, null, {
      deleteAllForAccount: (_ctx, id: string) => {
        calls.push(id);
        return Promise.resolve(1);
      },
    });
    await svc.deleteAccount(ctxWith(['driftstack_internal_admin']), 'acc_1');
    expect(calls).toEqual(['acc_1']);
  });

  it('succeeds even when every reclaim step throws (best-effort — status mutation already committed)', async () => {
    const { repo, rows } = makeRepo([baseAccount()]);
    const svc = new AccountsAdminService(
      repo,
      null,
      { destroyAllForAccount: () => Promise.reject(new Error('sessions boom')) },
      { revokeAllWebSessionsForAccount: () => Promise.reject(new Error('web sessions boom')) },
      {
        revokeAllForAccount: () => Promise.reject(new Error('api keys boom')),
        // V-727 — must ALSO not fail the delete when it throws.
        revokeAllMintedByAccount: () => Promise.reject(new Error('minted-by boom')),
      },
      { deleteAllForAccount: () => Promise.reject(new Error('webhooks boom')) },
    );
    const result = await svc.deleteAccount(ctxWith(['driftstack_internal_admin']), 'acc_1');
    expect(result.status).toBe('deleted');
    expect((rows[0] as AccountRow & { status: string }).status).toBe('deleted');
  });
});

describe('GDPR Article 17 AccountsAdminService — a reclaim that fails is recorded', () => {
  // The existing reclaim tests inject a stub reclaimer, so they prove the call
  // is MADE. None of them could fail if the call THREW: every step is wrapped
  // best-effort so the termination still returns success. That is the correct
  // behaviour and it is also how a termination could report success having
  // reclaimed nothing at all.
  function loggerSpy(): {
    logger: { error: (obj: Record<string, unknown>, msg: string) => void };
    entries: Array<{ obj: Record<string, unknown>; msg: string }>;
  } {
    const entries: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    return {
      logger: {
        error: (obj: Record<string, unknown>, msg: string): void => {
          entries.push({ obj, msg });
        },
      },
      entries,
    };
  }

  it('a throwing reclaim completes the termination and names the surface left unreclaimed', async () => {
    const { repo, rows } = makeRepo([baseAccount()]);
    const { logger, entries } = loggerSpy();
    const svc = new AccountsAdminService(
      repo,
      null,
      null,
      null,
      {
        revokeAllForAccount: () => Promise.resolve(0),
        revokeAllMintedByAccount: () => Promise.reject(new Error('revoke failed')),
      },
      null,
      logger,
    );

    const updated = await svc.deleteAccount(ctxWith(['driftstack_internal_admin']), 'acc_1');

    // The failure must not fail the delete — the status mutation is committed.
    expect(updated.status).toBe('deleted');
    expect((rows[0] as AccountRow & { status: string }).status).toBe('deleted');

    // ...and the surface that was NOT reclaimed is named. This particular step
    // is the one whose failure is NOT masked by the auth-path 'deleted' check:
    // those keys live on another, still-active account and keep authenticating.
    const failed = entries.filter((e) => e.obj.event === 'account_reclaim_failed');
    expect(failed, 'a failed credential reclaim must not be silent').toHaveLength(1);
    expect(failed[0]?.obj.step).toBe('api_keys_minted_elsewhere');
    expect(failed[0]?.obj.account_id).toBe('acc_1');
    expect(failed[0]?.msg).toContain('needs reconciling');
  });

  it('a termination whose reclaims all succeed records nothing', async () => {
    const { repo } = makeRepo([baseAccount()]);
    const { logger, entries } = loggerSpy();
    const svc = new AccountsAdminService(
      repo,
      null,
      { destroyAllForAccount: () => Promise.resolve(1) },
      { revokeAllWebSessionsForAccount: () => Promise.resolve(1) },
      {
        revokeAllForAccount: () => Promise.resolve(1),
        revokeAllMintedByAccount: () => Promise.resolve(1),
      },
      { deleteAllForAccount: () => Promise.resolve(1) },
      logger,
    );

    await svc.deleteAccount(ctxWith(['driftstack_internal_admin']), 'acc_1');
    expect(
      entries.filter((e) => e.obj.event === 'account_reclaim_failed'),
      'a clean termination must stay quiet or the signal is noise',
    ).toEqual([]);
  });

  it('every failing step is reported, so one failure does not hide the next', async () => {
    const { repo } = makeRepo([baseAccount()]);
    const { logger, entries } = loggerSpy();
    const svc = new AccountsAdminService(
      repo,
      null,
      { destroyAllForAccount: () => Promise.reject(new Error('sessions')) },
      { revokeAllWebSessionsForAccount: () => Promise.reject(new Error('web sessions')) },
      {
        revokeAllForAccount: () => Promise.reject(new Error('api keys')),
        revokeAllMintedByAccount: () => Promise.reject(new Error('minted elsewhere')),
      },
      { deleteAllForAccount: () => Promise.reject(new Error('webhooks')) },
      logger,
    );

    await svc.deleteAccount(ctxWith(['driftstack_internal_admin']), 'acc_1');
    expect(
      entries.filter((e) => e.obj.event === 'account_reclaim_failed').map((e) => e.obj.step),
    ).toEqual(['sessions', 'web_sessions', 'api_keys', 'api_keys_minted_elsewhere', 'webhooks']);
  });

  it('suspend reports a failed session reclaim without failing the suspend', async () => {
    const { repo } = makeRepo([baseAccount()]);
    const { logger, entries } = loggerSpy();
    const svc = new AccountsAdminService(
      repo,
      null,
      { destroyAllForAccount: () => Promise.reject(new Error('driver unreachable')) },
      null,
      null,
      null,
      logger,
    );

    const updated = await svc.suspend(ctxWith(['driftstack_internal_admin']), 'acc_1');
    expect(updated.status).toBe('suspended');
    const failed = entries.filter((e) => e.obj.event === 'account_reclaim_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.obj.step).toBe('sessions');
  });
});
