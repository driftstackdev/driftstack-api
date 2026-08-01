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

export interface ListAccountsArgs {
  /** Cursor is the prior page's last `id` (created_at desc + id desc tie-break). */
  cursor?: string;
  limit?: number;
  /** Filter by account status. Default: no filter. */
  status?: 'active' | 'suspended' | 'deleted';
  /** Filter by tier. Default: no filter. */
  tier?: AccountTier;
  /** Substring filter on email (lowercased). Default: no filter. */
  emailContains?: string;
}

export interface ListAccountsPage {
  data: AccountRow[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface AccountsAdminRepo {
  findById(id: string): Promise<AccountRow | null>;
  setTier(id: string, tier: AccountTier, at: Date): Promise<AccountRow | null>;
  setStatus(
    id: string,
    status: 'active' | 'suspended' | 'deleted',
    at: Date,
  ): Promise<AccountRow | null>;
  list(args: ListAccountsArgs): Promise<ListAccountsPage>;
  countByStatus(status: 'active' | 'suspended' | 'deleted'): Promise<number>;
  /** Account count grouped by tier — every AccountTier present, zero-filled. Sums to the total row count (all statuses). */
  countByTier(): Promise<Record<AccountTier, number>>;
  /** Count of accounts created at or after `since` (inclusive). Used for signup-window stats. */
  countCreatedSince(since: Date): Promise<number>;
}

/** New-signup counts over rolling windows (UTC). `today` = since 00:00:00 UTC; 7d/30d are now-minus-N-days. */
export interface SignupWindowCounts {
  today: number;
  last_7d: number;
  last_30d: number;
}

/** Minimal sessions-service surface the suspend-reclaim path depends on. */
export interface SuspendSessionReclaimer {
  destroyAllForAccount(accountId: string): Promise<number>;
}

/**
 * GDPR Article 17 — minimal auth-flows-service surface the delete-
 * reclaim path depends on. Bulk-revokes every dashboard web session
 * for the account (no exclusion — contrast with the customer "sign
 * out everywhere else" flow, which keeps the calling session alive).
 */
export interface DeleteWebSessionReclaimer {
  revokeAllWebSessionsForAccount(accountId: string, now: Date): Promise<number>;
}

/** GDPR Article 17 — minimal api-keys-service surface the delete-reclaim path depends on. */
export interface DeleteApiKeyReclaimer {
  revokeAllForAccount(ctx: AccountContext, accountId: string): Promise<number>;
  /** V-727 — keys this account minted on OTHER accounts, which the by-account
   *  reclaim above cannot see. */
  revokeAllMintedByAccount(ctx: AccountContext, minterAccountId: string): Promise<number>;
}

/** GDPR Article 17 — minimal webhooks-service surface the delete-reclaim path depends on. */
export interface DeleteWebhookReclaimer {
  deleteAllForAccount(ctx: AccountContext, accountId: string): Promise<number>;
}

export class AccountsAdminService {
  constructor(
    private readonly repo: AccountsAdminRepo,
    private readonly authCache: AuthCache | null = null,
    private readonly sessions: SuspendSessionReclaimer | null = null,
    private readonly webSessions: DeleteWebSessionReclaimer | null = null,
    private readonly apiKeys: DeleteApiKeyReclaimer | null = null,
    private readonly webhooks: DeleteWebhookReclaimer | null = null,
  ) {}

  async getAccount(ctx: AccountContext, accountId: string): Promise<AccountRow> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    const row = await this.repo.findById(accountId);
    if (!row) throw new NotFoundError(`Account "${accountId}" not found.`);
    return row;
  }

  async list(ctx: AccountContext, args: ListAccountsArgs): Promise<ListAccountsPage> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    return this.repo.list(args);
  }

  async countByStatus(
    ctx: AccountContext,
    status: 'active' | 'suspended' | 'deleted',
  ): Promise<number> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    return this.repo.countByStatus(status);
  }

  async countByTier(ctx: AccountContext): Promise<Record<AccountTier, number>> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    return this.repo.countByTier();
  }

  // Signup counts over rolling windows. Windowing lives here (not the repo)
  // so the repo stays a primitive countCreatedSince(since); `now` is injected
  // by the caller for deterministic tests. `today` is from 00:00:00 UTC.
  async signupCounts(ctx: AccountContext, now: Date): Promise<SignupWindowCounts> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    const startOfToday = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const [today, last_7d, last_30d] = await Promise.all([
      this.repo.countCreatedSince(startOfToday),
      this.repo.countCreatedSince(sevenDaysAgo),
      this.repo.countCreatedSince(thirtyDaysAgo),
    ]);
    return { today, last_7d, last_30d };
  }

  async changeTier(
    ctx: AccountContext,
    accountId: string,
    newTier: AccountTier,
  ): Promise<AccountRow> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    const updated = await this.repo.setTier(accountId, newTier, new Date());
    if (!updated) throw new NotFoundError(`Account "${accountId}" not found.`);
    await this.invalidateCache(accountId);
    return updated;
  }

  async suspend(ctx: AccountContext, accountId: string): Promise<AccountRow> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    const updated = await this.repo.setStatus(accountId, 'suspended', new Date());
    if (!updated) throw new NotFoundError(`Account "${accountId}" not found.`);
    await this.invalidateCache(accountId);
    // Reclaim the account's still-running browser sessions so they stop
    // consuming the driver while suspended. Auth already blocks every new
    // request from a suspended account (auth.ts) — this frees the in-flight
    // compute. Best-effort: the suspend mutation is already committed, and
    // the duration sweep mops up any straggler if reclaim fails.
    if (this.sessions) {
      try {
        await this.sessions.destroyAllForAccount(accountId);
      } catch {
        // Never fail the suspend on a reclaim error.
      }
    }
    return updated;
  }

  async unsuspend(ctx: AccountContext, accountId: string): Promise<AccountRow> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    const updated = await this.repo.setStatus(accountId, 'active', new Date());
    if (!updated) throw new NotFoundError(`Account "${accountId}" not found.`);
    await this.invalidateCache(accountId);
    return updated;
  }

  /**
   * GDPR Article 17 — admin-triggered account termination. Mirrors
   * suspend()'s shape: set status, then best-effort reclaim every
   * live surface tied to the account. Each reclaim step is
   * independently try/caught exactly like suspend()'s session
   * reclaim — the status mutation is already committed by the time
   * any reclaim runs, and the auth-path 'deleted' checks (auth.ts
   * slowPathApiKey / slowPathWebSession) already block every new
   * request regardless of whether a given reclaim step fully lands.
   * No distributed transaction: same best-effort consistency
   * guarantee as suspend(), just extended to more surfaces.
   *
   * Order: sessions → web sessions → API keys → webhooks →
   * cache invalidation (last, so the cache is only dropped once the
   * full reclaim sweep has been attempted).
   */
  async deleteAccount(ctx: AccountContext, accountId: string): Promise<AccountRow> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    const now = new Date();
    const updated = await this.repo.setStatus(accountId, 'deleted', now);
    if (!updated) throw new NotFoundError(`Account "${accountId}" not found.`);

    if (this.sessions) {
      try {
        await this.sessions.destroyAllForAccount(accountId);
      } catch {
        // Never fail delete on a reclaim error.
      }
    }
    if (this.webSessions) {
      try {
        await this.webSessions.revokeAllWebSessionsForAccount(accountId, now);
      } catch {
        // Never fail delete on a reclaim error.
      }
    }
    if (this.apiKeys) {
      try {
        await this.apiKeys.revokeAllForAccount(ctx, accountId);
      } catch {
        // Never fail delete on a reclaim error.
      }
      try {
        // V-727 — also the keys this account minted on OTHER accounts. The call
        // above filters on account_id and so reclaims only the credentials ON
        // this account; a team member's keys live on the OWNER's account and
        // authenticate as the owner, so terminating the member left them
        // working. Same hole V-726 closed for member removal, different door.
        await this.apiKeys.revokeAllMintedByAccount(ctx, accountId);
      } catch {
        // Never fail delete on a reclaim error.
      }
    }
    if (this.webhooks) {
      try {
        await this.webhooks.deleteAllForAccount(ctx, accountId);
      } catch {
        // Never fail delete on a reclaim error.
      }
    }

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
