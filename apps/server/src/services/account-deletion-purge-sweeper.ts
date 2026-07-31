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
import { profileSealedBlobKey, type R2 } from '../lib/r2.js';
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

/**
 * The proxy half of the same retention promise.
 *
 * privacy-policy.md §3.5 defines Customer-Provided Secrets to include, in its
 * own words, "HTTP/SOCKS5 proxy credentials", and the §9 retention table
 * commits to deleting them "within 30 days of Customer Account termination".
 * The BYOK key above was the only secret this sweeper purged, so a terminated
 * account's wrapped proxy password and its wrapped OpenVPN config blob /
 * WireGuard private key were retained indefinitely: `deleteAccount` is a SOFT
 * delete (status flip) and reclaims sessions, web sessions, API keys and
 * webhooks but touches no proxy row, the accounts row is never hard-deleted so
 * the ON DELETE CASCADE never fires, and the only other retention sweeper keys
 * off a PROFILE's own deletedAt rather than the account's.
 *
 * Self-limiting exactly like the BYOK query: once the columns are nulled the
 * account drops out of the candidate set, so no bookkeeping column is needed.
 */
export interface AccountProxySecretPurgeRepo {
  /**
   * Account ids where accounts.status = 'deleted' AND accounts.deleted_at
   * < cutoff AND the account still has at least one proxy row carrying a
   * non-null wrapped_password or wrapped_secret.
   */
  findDeletedAccountIdsWithProxySecretsBefore(cutoff: Date): Promise<string[]>;
  /** Null the wrapped secret columns on every proxy row for this account. */
  clearProxySecretsForAccount(accountId: string): Promise<number>;
}

/**
 * The profile half of the same §9 retention promise: "Profile metadata +
 * Profile Snapshots ... All deleted within 30 days of Customer Account
 * termination."
 *
 * Snapshots are listed separately because deleting profiles does NOT reach
 * them — `profile_snapshots.parent_profile_id` is ON DELETE SET NULL, so a
 * purged profile leaves its snapshots behind with a null parent, still holding
 * the captured state inline.
 */
export interface TerminatedAccountProfilePurgeRepo {
  /** Hard-delete profiles of accounts terminated before `cutoff`; returns ids. */
  purgeProfilesForTerminatedAccountsBefore(cutoff: Date): Promise<string[]>;
  /** Hard-delete snapshots of accounts terminated before `cutoff`; returns the count. */
  purgeSnapshotsForTerminatedAccountsBefore(cutoff: Date): Promise<number>;
}

export interface AccountDeletionPurgeSweeperDeps {
  readonly repo: AccountDeletionPurgeRepo;
  readonly byok: BYOKAnthropicService;
  /**
   * Optional so existing constructions and service-test fixtures stay
   * source-compatible. When absent the proxy half is skipped and the sweeper
   * behaves exactly as before — it does not silently claim to have purged
   * secrets it never looked at.
   */
  readonly proxySecrets?: AccountProxySecretPurgeRepo;
  /**
   * Optional for the same reason as `proxySecrets`: absent means the profile
   * half is skipped entirely rather than half-run.
   */
  readonly profiles?: TerminatedAccountProfilePurgeRepo;
  /**
   * Sealed-blob store for purged profiles. When wired, each purged profile's
   * `profiles/<id>.sealed` object is best-effort deleted so the encrypted bytes
   * do not outlive the row they belong to — the erasure promise is about the
   * data, and a blob left in R2 is still the customer's profile. Null/undefined
   * → DB-only purge, and the leftover object is logged.
   */
  readonly r2?: R2 | null;
  /** Days after deletedAt before the purge fires. Defaults to 30 (privacy-policy.md §9). */
  readonly retentionDays?: number;
  readonly logger?: Logger;
}

export interface AccountDeletionPurgeResult {
  readonly purged: number;
  /** Accounts whose wrapped proxy secrets were cleared this tick. */
  readonly proxySecretsPurged: number;
  /** Profiles hard-deleted for terminated accounts this tick. */
  readonly profilesPurged: number;
  /** Profile snapshots hard-deleted for terminated accounts this tick. */
  readonly snapshotsPurged: number;
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
    let proxySecretsPurged = 0;
    if (this.deps.proxySecrets !== undefined) {
      const proxyIds =
        await this.deps.proxySecrets.findDeletedAccountIdsWithProxySecretsBefore(cutoff);
      for (const accountId of proxyIds) {
        try {
          await this.deps.proxySecrets.clearProxySecretsForAccount(accountId);
          proxySecretsPurged += 1;
        } catch (err) {
          // Same discipline as the BYOK arm: never throw. The account keeps its
          // non-null columns, so it stays in the candidate set and the next
          // sweep retries it.
          this.deps.logger?.error?.(
            { component: 'account-deletion-purge', accountId, err },
            'failed to purge deleted account proxy secrets (will retry next sweep)',
          );
        }
      }
    }

    let profilesPurged = 0;
    let snapshotsPurged = 0;
    if (this.deps.profiles !== undefined) {
      try {
        // Snapshots FIRST. If the profile delete succeeds and the snapshot
        // delete then throws, the snapshots are stranded with a null parent and
        // no longer reachable from a profile — still purgeable on the next tick
        // (they are selected by ACCOUNT, not by parent), but the ordering keeps
        // the more fragile row set from depending on the other having run.
        snapshotsPurged =
          await this.deps.profiles.purgeSnapshotsForTerminatedAccountsBefore(cutoff);
        const purgedProfileIds =
          await this.deps.profiles.purgeProfilesForTerminatedAccountsBefore(cutoff);
        profilesPurged = purgedProfileIds.length;

        const r2 = this.deps.r2;
        if (r2 !== undefined && r2 !== null) {
          for (const profileId of purgedProfileIds) {
            try {
              await r2.deleteObject(profileSealedBlobKey(profileId));
            } catch (err) {
              // The row is already gone and the blob is opaque + inert, so this
              // never throws — but it IS logged, because an undeleted blob is
              // the customer's data outliving the erasure we committed to.
              this.deps.logger?.error?.(
                { component: 'account-deletion-purge', profileId, err },
                'failed to delete purged profile sealed-blob from R2 (orphan left behind)',
              );
            }
          }
        }
      } catch (err) {
        this.deps.logger?.error?.(
          { component: 'account-deletion-purge', err },
          'failed to purge terminated-account profiles/snapshots (will retry next sweep)',
        );
      }
    }

    return { purged, proxySecretsPurged, profilesPurged, snapshotsPurged };
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
  opts.scheduledJobs.register(ACCOUNT_DELETION_PURGE_JOB_TYPE, async (job: ScheduledJobRow) => {
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
    // Ignore the current/older run-time cohort and collapse future successors.
    // This runs OUTSIDE the try above so a thrown tick still re-arms (chain
    // survival, see the function JSDoc) — NOT in a finally+rethrow, which would
    // fan out.
    await enqueueNextAccountDeletionPurge({
      scheduledJobs: opts.scheduledJobs,
      nowFn: now,
      currentRunAt: job.runAt,
    });
  });
}

/**
 * Enqueue the next purge at 05:00 UTC strictly after `now` — staggered one
 * hour after the 04:00 profile-trash purge so the two don't contend.
 * Bootstrap dedups all pending rows; an in-handler re-arm dedups only future
 * successors after currentRunAt.
 */
export async function enqueueNextAccountDeletionPurge(opts: {
  scheduledJobs: ScheduledJobsService;
  nowFn?: () => number;
  currentRunAt?: Date;
}): Promise<{ enqueued: boolean }> {
  const now = (opts.nowFn ?? Date.now)();
  return opts.scheduledJobs.enqueue({
    jobType: ACCOUNT_DELETION_PURGE_JOB_TYPE,
    accountId: null,
    payload: {},
    runAt: nextAccountDeletionPurgeRunAt(new Date(now)),
    dedupOnAccountAndType: true,
    ...(opts.currentRunAt === undefined ? {} : { dedupAfterRunAt: opts.currentRunAt }),
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
