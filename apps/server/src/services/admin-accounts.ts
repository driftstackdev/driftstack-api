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
 * V-758 — minimal billing surface the suspension lifecycle depends on. The AUP §5.2 tells
 * customers that suspension pauses billing; until this dep existed the promise was untrue,
 * because `suspend()` had no billing dependency of any kind and a suspended account kept
 * renewing a flat monthly subscription while every authenticated request 403'd.
 *
 * Deliberately narrow and structural, like the reclaimers above: this service should not
 * learn the whole BillingService surface to pause an invoice.
 */
export interface BillingCollectionPauser {
  pauseCollectionForAccount(accountId: string): Promise<'paused' | 'no_subscription'>;
  resumeCollectionForAccount(accountId: string): Promise<'resumed' | 'no_subscription'>;
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
    /**
     * Optional structured logger. Every reclaim below is deliberately
     * best-effort — the status mutation is already committed and the auth path
     * already blocks a suspended/deleted account — but swallowing the failure
     * SILENTLY is what let a GDPR Article 17 termination report success having
     * reclaimed nothing. Omitted ⇒ no log; the reclaims still run.
     */
    private readonly logger: {
      error?: (obj: Record<string, unknown>, msg: string) => void;
    } | null = null,
    /**
     * V-758 — optional so every existing construction site and test double keeps working;
     * when absent, suspension behaves exactly as before and the pause is simply skipped.
     * Production wires it (bootstrap.ts) — an unwired pauser would make the AUP promise
     * untrue again, silently, which is why the wiring is asserted in the tests.
     */
    private readonly billing: BillingCollectionPauser | null = null,
  ) {}

  /**
   * Run one best-effort reclaim step.
   *
   * The failure must not fail the surrounding admin action: the status
   * mutation is already committed, and `auth.ts` rejects every new request
   * from a suspended/deleted account regardless of whether a given step
   * landed. That is why these are swallowed, and it stays true here.
   *
   * What changes is that the failure is now RECORDED. A swallowed reclaim is
   * the difference between "terminated" and "terminated with live credentials
   * still authenticating on another account", and nothing else in the system
   * writes that down — the admin action returns success either way.
   */
  private async reclaim(
    step: string,
    accountId: string,
    run: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await run();
    } catch (err) {
      try {
        this.logger?.error?.(
          {
            component: 'admin-accounts',
            event: 'account_reclaim_failed',
            step,
            account_id: accountId,
            err,
          },
          `account reclaim step "${step}" failed — the status change is committed but this surface was not reclaimed and needs reconciling`,
        );
      } catch {
        // Swallow; logging is best-effort and must not fail the admin action.
      }
    }
  }

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
    const suspendSessions = this.sessions;
    if (suspendSessions) {
      // Never fails the suspend; reported so a straggling live session that
      // only the duration sweep will eventually mop up is not invisible.
      await this.reclaim('sessions', accountId, () =>
        suspendSessions.destroyAllForAccount(accountId),
      );
    }
    // V-758 — honour the AUP §5.2 "billing pauses" promise. Best-effort like every other
    // step here: the suspension itself is already committed and must not be undone by a
    // Stripe outage. But a FAILURE here is the one that costs the customer money — they
    // keep being invoiced for a service that 403s — so it goes through the same alarm,
    // which names the step, rather than being swallowed.
    const pauser = this.billing;
    if (pauser) {
      await this.reclaim('billing_pause', accountId, () =>
        pauser.pauseCollectionForAccount(accountId),
      );
    }
    return updated;
  }

  async unsuspend(ctx: AccountContext, accountId: string): Promise<AccountRow> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    const updated = await this.repo.setStatus(accountId, 'active', new Date());
    if (!updated) throw new NotFoundError(`Account "${accountId}" not found.`);
    await this.invalidateCache(accountId);
    // V-758 — symmetric resume. This is not optional politeness: pausing collection
    // without ever clearing it would leave a reinstated customer permanently unbilled,
    // which is a worse defect than the one the pause fixes. Same best-effort + named
    // alarm, so a failed resume is visible rather than becoming silent free service.
    const pauser = this.billing;
    if (pauser) {
      await this.reclaim('billing_resume', accountId, () =>
        pauser.resumeCollectionForAccount(accountId),
      );
    }
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

    // Each step never fails the delete, and each now records its own failure.
    // Naming the step matters: "the account was terminated" is true whichever
    // of these did not land, and only the step tells an operator whether live
    // API keys are still authenticating or a browser is merely still running.
    const sessions = this.sessions;
    if (sessions) {
      await this.reclaim('sessions', accountId, () => sessions.destroyAllForAccount(accountId));
    }
    const webSessions = this.webSessions;
    if (webSessions) {
      await this.reclaim('web_sessions', accountId, () =>
        webSessions.revokeAllWebSessionsForAccount(accountId, now),
      );
    }
    const apiKeys = this.apiKeys;
    if (apiKeys) {
      await this.reclaim('api_keys', accountId, () => apiKeys.revokeAllForAccount(ctx, accountId));
      // V-727 — also the keys this account minted on OTHER accounts. The call
      // above filters on account_id and so reclaims only the credentials ON
      // this account; a team member's keys live on the OWNER's account and
      // authenticate as the owner, so terminating the member left them
      // working. Same hole V-726 closed for member removal, different door.
      //
      // This is the step whose silent failure is NOT masked by the auth-path
      // 'deleted' check: those keys authenticate as a still-active account.
      await this.reclaim('api_keys_minted_elsewhere', accountId, () =>
        apiKeys.revokeAllMintedByAccount(ctx, accountId),
      );
    }
    const webhooks = this.webhooks;
    if (webhooks) {
      await this.reclaim('webhooks', accountId, () => webhooks.deleteAllForAccount(ctx, accountId));
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
