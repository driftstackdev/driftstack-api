// 2026-07-01 — account-deletion retention purge sweeper (GDPR Article 17
// close-out).
//
// AccountsAdminService.deleteAccount() sets accounts.status = 'deleted' +
// accounts.deleted_at = now immediately, and best-effort reclaims sessions /
// web sessions / API keys / webhooks in the same call. It does NOT purge the
// account's BYOK Anthropic key at delete time — privacy-policy.md §3.5
// (Customer-Provided Secrets) + §9 (retention table) disclose a 30-day grace
// window ("Deleted within 30 days of Customer Account termination"), not
// immediate erasure. This sweeper closes that loop: once `deleted_at` is
// more than 30 days in the past, it clears the account's stored BYOK
// Anthropic key ciphertext via the SAME BYOKAnthropicService.clearKey() the
// customer-facing `DELETE /v1/account/me/byok-anthropic-key` endpoint uses —
// no duplicated null-out logic.
//
// Scope note — profile snapshots are deliberately NOT touched by this
// sweeper. As of migration 0069 / V-312, `profile_snapshots.state_blob` is
// metadata-only in v1 ("browser state isn't surfaced through the customer
// API yet" — see schema.ts's profileSnapshots comment): there is no secret /
// credential column on that table today, so there is nothing to purge there.
// If a future driver integration starts populating state_blob with real
// captured browser state, this sweeper (or a sibling) should be extended to
// purge it too.
//
// Mirrors profile-trash-purge-sweeper.ts's tickOnce / register / enqueue
// shape (same file this is modelled on).

import type { BYOKAnthropicService } from './byok-anthropic.js';
import type { ScheduledJobsService, ScheduledJobRow } from './scheduled-jobs.js';
import type { Logger } from '../lib/logger.js';

export const ACCOUNT_DELETION_PURGE_JOB_TYPE = 'account_deletion.purge';

const ACCOUNT_DELETION_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Minimal repo surface the sweeper needs: which deleted accounts are past
 * the retention cutoff and still have a live BYOK Anthropic key. The query
 * is self-limiting — once clearKey() nulls the ciphertext, the account
 * drops out of this result set on the next tick, so no separate "already
 * purged" bookkeeping column is needed.
 */
export interface AccountDeletionPurgeRepo {
  /**
   * Account ids where accounts.status = 'deleted' AND accounts.deleted_at
   * < cutoff AND accounts.byok_anthropic_api_key_ciphertext IS NOT NULL.
   */
  findDeletedAccountIdsWithByokKeyBefore(cutoff: Date): Promise<string[]>;
}

export interface AccountDeletionPurgeSweeperDeps {
  readonly repo: AccountDeletionPurgeRepo;
  readonly byok: BYOKAnthropicService;
  /** Days after deletedAt before the purge fires. Defaults to 30 (privacy-policy.md §9). */
  readonly retentionDays?: number;
  readonly logger?: Logger;
}

export interface AccountDeletionPurgeResult {
  readonly purged: number;
}

export class AccountDeletionPurgeSweeperService {
  private readonly retentionMs: number;

  constructor(private readonly deps: AccountDeletionPurgeSweeperDeps) {
    this.retentionMs = (deps.retentionDays ?? ACCOUNT_DELETION_RETENTION_DAYS) * DAY_MS;
  }

  async tickOnce(now: Date): Promise<AccountDeletionPurgeResult> {
    const cutoff = new Date(now.getTime() - this.retentionMs);
    const ids = await this.deps.repo.findDeletedAccountIdsWithByokKeyBefore(cutoff);
    let purged = 0;
    for (const accountId of ids) {
      try {
        await this.deps.byok.clearKey({ accountId, now });
        purged += 1;
      } catch (err) {
        // Never throw — a per-account clear failure is logged and retried
        // on the next sweep (the account stays in the candidate set since
        // its ciphertext was never nulled).
        this.deps.logger?.error?.(
          { component: 'account-deletion-purge', accountId, err },
          'failed to purge deleted account BYOK Anthropic key (will retry next sweep)',
        );
      }
    }
    return { purged };
  }
}

export interface RegisterAccountDeletionPurgeJobOpts {
  scheduledJobs: ScheduledJobsService;
  sweeper: AccountDeletionPurgeSweeperService;
  logger: Logger;
  /** Test seam — defaults to `Date.now`. */
  nowFn?: () => number;
}

/**
 * Chain survival: the re-arm must run even if `tickOnce` throws. If it did not,
 * a throw would leave no re-arm, the poller would retry the job, and once
 * `maxAttempts` is exhausted the job is markFailed with NO pending purge row —
 * the self-re-arming chain is then dead until a process restart and NO deleted
 * account's BYOK key is ever purged again (a live retention breach: ciphertext
 * kept past the disclosed 30-day window). We therefore SWALLOW a tick failure
 * (logging it) and re-arm exactly once. We must NOT re-throw-and-re-arm-in-
 * `finally`: the poller would retry the same job and each attempt would re-arm →
 * duplicate parallel chains (fan-out). The tick is idempotent — the next tick
 * re-lists any accounts this one missed (the candidate query self-limits: an
 * account only drops out once its ciphertext is cleared).
 */
export function registerAccountDeletionPurgeJob(opts: RegisterAccountDeletionPurgeJobOpts): void {
  const now = opts.nowFn ?? Date.now;
  opts.scheduledJobs.register(ACCOUNT_DELETION_PURGE_JOB_TYPE, async (_job: ScheduledJobRow) => {
    try {
      const result = await opts.sweeper.tickOnce(new Date(now()));
      opts.logger.info?.(
        { component: 'account-deletion-purge', purged: result.purged },
        'account-deletion purge sweep complete',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.logger.error?.(
        {
          component: 'account-deletion-purge',
          event: 'account_deletion_purge_tick_failed',
          err: { message },
        },
        'account-deletion purge sweep tick failed — re-arming; accounts retry next sweep',
      );
    }
    // Re-arm with dedup OFF — the in-flight (still-locked, not-yet-completed)
    // job would otherwise be seen as a pending duplicate and block the
    // re-enqueue, killing the chain. See the auth-tokens-sweeper JSDoc. This
    // runs OUTSIDE the try above so a thrown tick still re-arms (chain survival,
    // see the function JSDoc) — NOT in a finally+rethrow, which would fan out.
    await enqueueNextAccountDeletionPurge({
      scheduledJobs: opts.scheduledJobs,
      nowFn: now,
      dedup: false,
    });
  });
}

/**
 * Enqueue the next purge at 05:00 UTC strictly after `now` — staggered one
 * hour after the 04:00 profile-trash purge so the two don't contend.
 * dedup:true for the bootstrap enqueue (one chain across restarts);
 * dedup:false for the in-handler re-arm (the current job is still locked +
 * non-completed, so dedup:true would no-op every re-arm and kill the chain).
 */
export async function enqueueNextAccountDeletionPurge(opts: {
  scheduledJobs: ScheduledJobsService;
  nowFn?: () => number;
  dedup?: boolean;
}): Promise<{ enqueued: boolean }> {
  const now = (opts.nowFn ?? Date.now)();
  return opts.scheduledJobs.enqueue({
    jobType: ACCOUNT_DELETION_PURGE_JOB_TYPE,
    accountId: null,
    payload: {},
    runAt: nextAccountDeletionPurgeRunAt(new Date(now)),
    dedupOnAccountAndType: opts.dedup ?? true,
  });
}

/** Returns 05:00 UTC strictly after `now`. */
export function nextAccountDeletionPurgeRunAt(now: Date): Date {
  const next = new Date(now.getTime());
  next.setUTCHours(5, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}
