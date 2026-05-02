// Account-state mutations (admin-only).
//
// These services back the admin endpoints under /v1/admin/accounts/:id
// (tier change, suspend, unsuspend). Each mutation invalidates the auth
// cache for the target account so cached AccountContext reads pick up
// the new state on the next request (D-020 + D-025 cache invalidation
// pattern).
//
// Audit logging is the route's responsibility — the route writes the
// audit row in the same handler that calls the service. The service
// stays focused on the mutation; the route owns the request/response
// envelope.

import type { AccountTier } from '@driftstack/api-types';
import type { AccountContext } from './auth.js';
import type { AccountRow } from './auth.js';
import type { AuthCache } from './auth-cache.js';
import { NotFoundError, requireScope as throwIfMissingScope } from '../lib/errors-helpers.js';

export interface AccountsAdminRepo {
  findById(id: string): Promise<AccountRow | null>;
  setTier(id: string, tier: AccountTier, at: Date): Promise<AccountRow | null>;
  setStatus(
    id: string,
    status: 'active' | 'suspended' | 'deleted',
    at: Date,
  ): Promise<AccountRow | null>;
}

export class AccountsAdminService {
  constructor(
    private readonly repo: AccountsAdminRepo,
    private readonly authCache: AuthCache | null = null,
  ) {}

  async getAccount(ctx: AccountContext, accountId: string): Promise<AccountRow> {
    throwIfMissingScope(ctx, 'admin');
    const row = await this.repo.findById(accountId);
    if (!row) throw new NotFoundError(`Account "${accountId}" not found.`);
    return row;
  }

  async changeTier(
    ctx: AccountContext,
    accountId: string,
    newTier: AccountTier,
  ): Promise<AccountRow> {
    throwIfMissingScope(ctx, 'admin');
    const updated = await this.repo.setTier(accountId, newTier, new Date());
    if (!updated) throw new NotFoundError(`Account "${accountId}" not found.`);
    await this.invalidateCache(accountId);
    return updated;
  }

  async suspend(ctx: AccountContext, accountId: string): Promise<AccountRow> {
    throwIfMissingScope(ctx, 'admin');
    const updated = await this.repo.setStatus(accountId, 'suspended', new Date());
    if (!updated) throw new NotFoundError(`Account "${accountId}" not found.`);
    await this.invalidateCache(accountId);
    return updated;
  }

  async unsuspend(ctx: AccountContext, accountId: string): Promise<AccountRow> {
    throwIfMissingScope(ctx, 'admin');
    const updated = await this.repo.setStatus(accountId, 'active', new Date());
    if (!updated) throw new NotFoundError(`Account "${accountId}" not found.`);
    await this.invalidateCache(accountId);
    return updated;
  }

  private async invalidateCache(accountId: string): Promise<void> {
    if (!this.authCache) return;
    try {
      await this.authCache.invalidateAccount(accountId);
    } catch {
      // Cache failures must not propagate as admin-action failures —
      // the underlying mutation is committed. The next auth-path read
      // will TTL out the stale entry within 30s in the worst case.
    }
  }
}
