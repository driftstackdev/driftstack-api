// Profiles service — CRUD over the customer-facing profile slot
// resource, with tier-limit enforcement at create time.
//
// The Manual ladder uses profile count as the tier-defining metric
// (e.g. team_manual = 50 profiles); the API ladder also caps profiles
// to prevent unbounded growth at lower tiers. Enterprise is unlimited
// (PROFILES_PER_TIER returns null).
//
// Per-profile persistent browser state (cookies / localStorage /
// IndexedDB) lives in the WebKit driver layer — none of that flows
// through this service. We store only the metadata.

import { randomUUID } from 'node:crypto';
import {
  LOCKED_ARCHETYPE_ID,
  isSelectableArchetypeId,
  type AccountTier,
} from '@driftstack/api-types';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  StorageQuotaExceededError,
  TierLimitError,
} from '../lib/errors.js';
import { isUniqueViolation } from '../lib/pg-error.js';
import { profileLimitFor } from './sessions.js';
import type { AccountAuditService } from './account-audit.js';
import { computeAccountStorageState, type AccountStorageState } from './profile-storage-quota.js';
import { mintWrappedProfileDek, unwrapProfileDek } from '../lib/profile-key-hierarchy.js';
import { profileSealedBlobKey, type R2 } from '../lib/r2.js';
import type { Logger } from '../lib/logger.js';

export interface ProfileRecord {
  id: string;
  accountId: string;
  name: string;
  archetype: string;
  description: string | null;
  /** Organization metadata — NULL folder = unfiled. */
  folder: string | null;
  /** Organization metadata — exact tag set ([] = untagged). */
  tags: string[];
  /** UI metadata (synced per-account, 2026-06-16) — short emoji icon (NULL = monogram). */
  icon: string | null;
  /** UI metadata — short inline note, distinct from the create-time `description`. */
  note: string | null;
  lastUsedAt: Date | null;
  /**
   * doc-150 item 5 — byte size of the last saved sealed store (the opaque
   * LZFSE + AES-GCM-256 blob). NULL = never saved / pre-column row / a harness
   * that didn't emit `size_bytes`. Surfaced to the customer for per-profile
   * storage + an account-wide total; quota enforcement is item 6.
   */
  sizeBytes: number | null;
  /** doc-150 item 5 — last time the harness saved this profile's sealed store back. NULL = never saved. */
  lastSavedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /**
   * L4b recycle bin — NULL for a live profile; set to the trash timestamp for a
   * soft-deleted (trashed) profile. Live read paths only ever return rows where
   * this is NULL; the trash-list path returns trashed rows so the customer can
   * see when each was deleted and restore it.
   */
  deletedAt: Date | null;
}

export interface NewProfileInput {
  /**
   * Preallocated profile identity. Every stateful service write supplies this
   * before wrapping the DEK so the envelope can authenticate its final row ID.
   * Optional only for stateless/internal repo callers that store no wrapped DEK.
   */
  id?: string;
  accountId: string;
  name: string;
  archetype: string;
  description: string | null;
  /** Organization metadata — omitted/undefined → unfiled / no tags. */
  folder?: string | null;
  tags?: string[];
  /** UI metadata — omitted/undefined → stored NULL. */
  icon?: string | null;
  note?: string | null;
  /**
   * Profile-backed sessions (file 57): the per-profile DEK in an explicit v2
   * envelope authenticated to its account + preallocated profile UUID. Optional
   * — absent/undefined → stored NULL (PROFILE_MASTER_KEY unset). Never exposed
   * back to the customer.
   */
  wrappedDek?: string | null;
}

export interface ProfileUpdates {
  name?: string;
  description?: string | null;
  /** `null` clears the folder. */
  folder?: string | null;
  /** Exact-set replace; `[]` clears all tags. */
  tags?: string[];
  /** UI metadata — `null`/'' clears the icon (falls back to the monogram). */
  icon?: string | null;
  /** UI metadata — `null`/'' clears the note. */
  note?: string | null;
}

export interface ListProfilesArgs {
  accountId: string;
  /** Cursor is the prior page's last id (created_at desc + id desc tie-break). Omitted = first page. */
  cursor?: string;
  /** Page size, 1-100. Default 50. */
  limit?: number;
}

export interface ListProfilesPage {
  data: ProfileRecord[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface ProfilesRepo {
  insert(input: NewProfileInput): Promise<ProfileRecord>;
  /**
   * V-714 — atomic tier-limit check + insert under an account-row lock, so
   * concurrent creates can't both pass the per-tier profile cap (the plain
   * countByAccount-then-insert is a TOCTOU). `limit === null` = unmetered tier
   * (insert without count). Returns `{ limitExceeded, current }` instead of
   * the record when the cap is hit, so the service maps it to a TierLimitError.
   */
  insertWithLimit(
    input: NewProfileInput,
    limit: number | null,
  ): Promise<{ record: ProfileRecord } | { limitExceeded: true; current: number }>;
  /**
   * Transfer between accounts in ONE transaction: cap-check the recipient,
   * CLAIM the source by retiring it (the claim's result is checked), then
   * insert the recipient row.
   *
   * The two-statement version it replaces could not serialise two transfers of
   * the same source to different recipients — they take different account-row
   * locks — so both inserted and one profile became two. `sourceAlreadyRetired`
   * is the loser of that race, and it has written nothing.
   */
  transferAtomic(args: {
    source: { id: string; accountId: string };
    insert: NewProfileInput;
    limit: number | null;
  }): Promise<
    | { record: ProfileRecord }
    | { limitExceeded: true; current: number }
    | { sourceAlreadyRetired: true }
  >;
  countByAccount(accountId: string): Promise<number>;
  /**
   * doc-150 item 6 — sum of `size_bytes` (COALESCE NULL→0) over the account's
   * LIVE profiles (excludes trashed/soft-deleted, matching the list/count read
   * filter). This is the enforced per-account storage-quota numerator; the
   * session-launch gate compares it against TIER_STORAGE_BYTES_CAP[tier].
   */
  sumSizeBytesByAccount(accountId: string): Promise<number>;
  findById(args: { id: string; accountId: string }): Promise<ProfileRecord | null>;
  findByAccountAndName(args: { accountId: string; name: string }): Promise<ProfileRecord | null>;
  list(args: ListProfilesArgs): Promise<ListProfilesPage>;
  update(args: { id: string; accountId: string; updates: ProfileUpdates }): Promise<ProfileRecord>;
  /** Returns true if a row was deleted, false if not found / wrong account. */
  delete(args: { id: string; accountId: string }): Promise<boolean>;
  /**
   * L4b — list the account's TRASHED (soft-deleted) profiles, most-recently
   * trashed first. Inverse of the live read paths: returns ONLY rows where
   * deletedAt IS NOT NULL. Trash is small + ephemeral so this is unpaginated.
   */
  listTrashed(args: { accountId: string }): Promise<ProfileRecord[]>;
  /**
   * L4b — restore a trashed profile (clear deletedAt). Returns:
   *  - 'restored'      the row was trashed and is now live again;
   *  - 'not_found'     no trashed row with that id for this account;
   *  - 'name_conflict' a LIVE profile now holds the name (it was freed + reused
   *                    while trashed), so the partial unique index rejects the
   *                    restore — the caller must rename one first.
   *
   * #2 (2026-06-30) — also THROWS StorageQuotaExceededError when restoring
   * would push the account's live storage usage over its tier's hard cap
   * (the same rule assertWithinStorageQuotaForLaunch enforces at create
   * time). Without this, soft-deleting a large profile instantly (and
   * wrongly) freed reported quota — sumSizeBytesByAccount only ever summed
   * LIVE rows — and restoring it later brought the exact same bytes back
   * with zero re-check, bypassing the hard cap for the whole 30-day trash
   * window.
   */
  restore(args: {
    id: string;
    accountId: string;
  }): Promise<'restored' | 'not_found' | 'name_conflict'>;
  /**
   * L4b Step 4 — retention purge. HARD-deletes trashed profiles (the only hard
   * delete now that `delete()` is soft) whose `deletedAt` is older than
   * `cutoff`, account-wide. Removes the row + its wrapped DEK. Returns the IDs
   * of the purged rows (caller derives the count via `.length` and best-effort
   * deletes each purged profile's orphaned R2 sealed blob). Driven by the daily
   * profile-trash-purge sweep.
   */
  purgeTrashedBefore(cutoff: Date): Promise<string[]>;
  /**
   * #158 — which of `ids` still have a profiles row (ANY account), INCLUDING
   * soft-deleted / trashed rows. Only a HARD-deleted (purged) profile is truly
   * gone; a trashed profile still holds a row + DEK + sealed blob until purge,
   * so its blob must NOT be reaped. Backs the R2 orphan-blob reaper (GDPR
   * erasure backstop): a `profiles/<uuid>.sealed` object whose uuid is NOT in
   * the returned set has no DB row at all and is a genuine orphan (the
   * purge-vs-late-save-back race). Batched as a single `WHERE id IN (...)`
   * select of the id column; the returned set is exactly the ids found.
   */
  findExistingProfileIds(ids: string[]): Promise<Set<string>>;
  /** Anti-abuse — user-initiated permanent delete of ONE trashed profile (frees
   *  a cap slot immediately). Owner-scoped + trashed-only; true if purged. */
  purgeTrashed(args: { id: string; accountId: string }): Promise<boolean>;
  /** Mark `last_used_at` — fire-and-forget from sessions service. */
  touch(args: { id: string; accountId: string; at: Date }): Promise<void>;
  /**
   * doc-150 item 5 — record a sealed-store save-back: stamp `last_saved_at` and
   * (when the harness emitted it) the sealed-store `size_bytes`. Fire-and-forget
   * from the profileSaved consumer; `sizeBytes` undefined leaves the column
   * untouched (a pre-emit harness must not clobber a known size with NULL).
   */
  recordSave(args: { id: string; accountId: string; at: Date; sizeBytes?: number }): Promise<void>;
  /**
   * Read ONLY the wrapped DEK for a profile (file 57). Deliberately NOT on
   * ProfileRecord — the wrapped DEK is a secret that must never ride a record
   * returned to the customer; this account-scoped read is the only path to it,
   * used at session-assign to unwrap + ship the DEK to the harness. Returns null
   * when the profile has no DEK (created without PROFILE_MASTER_KEY) or isn't
   * found / wrong account.
   */
  getWrappedDek(args: { id: string; accountId: string }): Promise<string | null>;
}

const DEFAULT_ARCHETYPE = LOCKED_ARCHETYPE_ID;

function requireSelectableArchetype(archetype: string): string {
  if (!isSelectableArchetypeId(archetype)) {
    throw new BadRequestError(
      `Archetype "${archetype}" is not selectable. Use GET /v1/archetypes for accepted ids.`,
      { field: 'archetype' },
    );
  }
  return archetype;
}

/**
 * Detect the Postgres unique-violation (23505) raised on the
 * `profiles_account_name_unique` index. Every profile-insert path
 * (create / clone / import / transfer / snapshot-restore) does a
 * findByAccountAndName pre-check, then a raw insert; two concurrent
 * same-name requests can both pass the pre-check before either commits,
 * so the loser's insert trips this constraint. Call sites catch it and
 * translate to the same ConflictError the pre-check throws — a clean 409
 * instead of an uncaught 500. The data is already correct (the index
 * prevents the duplicate); this only fixes the status code the race
 * loser sees. Precise on the constraint name so an unrelated 23505 (or
 * any other error) still surfaces.
 */
export function isProfileNameRaceViolation(err: unknown): boolean {
  // drizzle-version-agnostic (reads top level on 0.38, err.cause on 0.45).
  return isUniqueViolation(err, 'profiles_account_name_unique');
}

export interface CreateProfileArgs {
  accountId: string;
  tier: AccountTier;
  name: string;
  archetype?: string;
  description?: string;
  folder?: string;
  tags?: string[];
  /** UI metadata — a profile created with an icon picked in the GUI. */
  icon?: string;
  note?: string;
}

/**
 * #1/#3 (2026-06-30) — minimal shape this service needs to refuse a hard-
 * delete-adjacent profile mutation (purge / transfer-out) while a session is
 * still actively bound to the profile. Matches
 * `AgentSessionsRepo.countActiveForProfile` (services/agent-sessions.ts)
 * structurally — the real repo satisfies this without an import cycle; a
 * lightweight fake suffices in tests. Mirrors the #14 trim guard
 * (routes/profiles.ts `POST /:id/trim`), which checks the identical
 * condition before an out-of-session R2 write for the identical reason.
 */
export interface ProfileSessionGuard {
  countActiveForProfile(profileId: string): Promise<number>;
}

/**
 * Preallocate the final profile UUID before minting its optional DEK wrapper so
 * the v2 envelope is authenticated to the exact account + row identity that is
 * committed. Every profile-creation path, including snapshot restore, shares
 * this factory; a missing master key deliberately preserves the stateless,
 * feature-inert posture while still using the preallocated UUID.
 */
export function mintProfileRowIdentity(
  profileMasterKey: Buffer | null,
  accountId: string,
): { id: string; wrappedDek?: string } {
  const id = randomUUID();
  return profileMasterKey !== null
    ? { id, wrappedDek: mintWrappedProfileDek(profileMasterKey, accountId, id).wrappedDek }
    : { id };
}

export class ProfilesService {
  constructor(
    private readonly repo: ProfilesRepo,
    /**
     * V-225 — optional customer-facing audit log. When wired, emits
     * profile.created / profile.deleted entries. Best-effort; emit
     * failures never break the CRUD operation. Tests that don't
     * exercise the audit log pass null.
     */
    private readonly accountAudit: AccountAuditService | null = null,
    /**
     * Profile-backed sessions master key (file 57; decoded 32-byte AES-256).
     * When non-null, a fresh per-profile DEK is minted + wrapped under the
     * account TMK at create time and stored on the row. Null (the v1.0 default,
     * PROFILE_MASTER_KEY unset) → profiles are created without a DEK (feature
     * inert).
     */
    private readonly profileMasterKey: Buffer | null = null,
    /**
     * R2 client for the profiles' sealed-blob store. When wired, a manual purge
     * (DELETE /:id/purge) best-effort deletes the purged profile's
     * `profiles/<id>.sealed` object so the encrypted bytes don't orphan in R2
     * forever (the daily sweeper does the same for the auto-purge path). Null
     * (R2 not configured) → DB-only purge, unchanged.
     */
    private readonly r2: R2 | null = null,
    private readonly logger: Logger | null = null,
    /**
     * #1/#3 (2026-06-30) — agent-sessions lookup backing the "is this
     * profile bound to a live session?" guard purge() and transferProfile()
     * run before a hard-delete-adjacent mutation (see assertNoActiveSession).
     * Null (the default — no caller currently wires this) → the guard is
     * skipped, exactly the same fail-open contract every other optional
     * dependency above uses; no behavior change until a real
     * AgentSessionsRepo is passed in at construction.
     */
    private readonly agentSessions: ProfileSessionGuard | null = null,
  ) {}

  /**
   * Profile-backed sessions (file 57) — mint a FRESH per-profile DEK wrapped
   * under the account's TMK and authenticated to the final profile UUID, or no
   * wrapper when no master key is configured (feature inert → row stores NULL).
   * Shared by EVERY profile-insert path
   * (create / clone / import / transfer): each path mints its OWN fresh DEK —
   * a clone/import/transfer starts with NO sealed blob, so it must never reuse
   * the source profile's DEK. Without a DEK the row is stateless at
   * session-assign (no restore URL, no save-back PUT URL) → sealed-state
   * persistence silently breaks for that profile.
   */
  private mintProfileIdentity(accountId: string): { id: string; wrappedDek?: string } {
    return mintProfileRowIdentity(this.profileMasterKey, accountId);
  }

  private async emitAuditBestEffort(
    accountId: string,
    action:
      | 'profile.created'
      | 'profile.deleted'
      | 'profile.restored'
      | 'profile.purged'
      | 'profile.exported'
      | 'profile.imported',
    targetResourceId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (this.accountAudit === null) return;
    try {
      await this.accountAudit.record({
        accountId,
        actorType: 'customer',
        actorAccountId: accountId,
        actorKeyId: null,
        action,
        targetResourceId,
        payload,
      });
    } catch {
      /* best-effort — audit failures don't break the CRUD path */
    }
  }

  async create(args: CreateProfileArgs): Promise<ProfileRecord> {
    const archetype = requireSelectableArchetype(args.archetype ?? DEFAULT_ARCHETYPE);
    const limit = profileLimitFor(args.tier);
    if (limit !== null) {
      const current = await this.repo.countByAccount(args.accountId);
      if (current >= limit) {
        throw new TierLimitError(
          `Tier "${args.tier}" permits at most ${limit.toString()} profiles; you have ${current.toString()}.`,
          {
            limit,
            current,
            resource: 'profile',
            tier: args.tier,
          },
        );
      }
    }

    const existing = await this.repo.findByAccountAndName({
      accountId: args.accountId,
      name: args.name,
    });
    if (existing !== null) {
      throw new ConflictError(`Profile name "${args.name}" already exists in this account.`, {
        resource: 'profile',
        field: 'name',
      });
    }

    // V-714 — the count check above is a fast-fail pre-check (preserves error
    // precedence + skips a tx when clearly over). insertWithLimit RE-checks the
    // count + inserts atomically under an account-row lock, so a concurrent
    // create that passed the pre-check still can't push the account past its
    // per-tier cap (was a count-then-insert TOCTOU).
    // Profile-backed sessions (file 57): mint + wrap a per-profile DEK under the
    // account's TMK when the master key is configured. The plaintext DEK is
    // discarded here (re-derived by unwrapping at session-assign time); only the
    // wrapped form is stored. Absent key → undefined → stored NULL (inert).
    const identity = this.mintProfileIdentity(args.accountId);

    let result: Awaited<ReturnType<typeof this.repo.insertWithLimit>>;
    try {
      result = await this.repo.insertWithLimit(
        {
          id: identity.id,
          accountId: args.accountId,
          name: args.name,
          archetype,
          description: args.description ?? null,
          folder: args.folder ?? null,
          tags: args.tags ?? [],
          icon: args.icon ?? null,
          note: args.note ?? null,
          wrappedDek: identity.wrappedDek,
        },
        limit,
      );
    } catch (err) {
      // Concurrent same-name create race (the double-click case): the loser's
      // insert trips profiles_account_name_unique → 409, not an uncaught 500.
      if (isProfileNameRaceViolation(err)) {
        throw new ConflictError(`Profile name "${args.name}" already exists in this account.`, {
          resource: 'profile',
          field: 'name',
        });
      }
      throw err;
    }
    if ('limitExceeded' in result) {
      // Lost the under-lock count re-check to a concurrent create. `limit` is
      // non-null here (insertWithLimit only refuses when limit !== null), so
      // `limit ?? 0` never coerces — it just satisfies the type narrower.
      throw new TierLimitError(
        `Tier "${args.tier}" permits at most ${(limit ?? 0).toString()} profiles; you have ${result.current.toString()}.`,
        { limit: limit ?? 0, current: result.current, resource: 'profile', tier: args.tier },
      );
    }
    const row = result.record;
    await this.emitAuditBestEffort(args.accountId, 'profile.created', `profile_${row.id}`, {
      name: row.name,
      archetype: row.archetype,
    });
    return row;
  }

  /**
   * Recover a profile's plaintext DEK (file 57) for session-assign — reads the
   * account-scoped wrapped DEK and unwraps it under the exact account/profile
   * context. Returns
   * null when the master key isn't configured or the profile has no stored DEK.
   * The plaintext DEK never persists; the caller ships it to the harness over
   * the authed WSS and discards it. Throws only if a stored DEK is corrupt /
   * wrapped under a different key (the best-effort dispatch caller catches).
   */
  async getProfileDek(args: { profileId: string; accountId: string }): Promise<Buffer | null> {
    if (this.profileMasterKey === null) return null;
    const wrappedDek = await this.repo.getWrappedDek({
      id: args.profileId,
      accountId: args.accountId,
    });
    if (wrappedDek === null) return null;
    return unwrapProfileDek(this.profileMasterKey, args.accountId, args.profileId, wrappedDek);
  }

  /**
   * doc-150 item 6 — current per-account storage-quota state. Sums the
   * account's LIVE profiles' size_bytes (the enforced numerator) and derives
   * the quota state against TIER_STORAGE_BYTES_CAP[tier]. Pure read; surfaced
   * by the dashboard (soft/80% compute-on-read) and used by the launch gate.
   */
  async getStorageState(args: {
    accountId: string;
    tier: AccountTier;
  }): Promise<AccountStorageState> {
    const usedBytes = await this.repo.sumSizeBytesByAccount(args.accountId);
    return computeAccountStorageState({ usedBytes, tier: args.tier });
  }

  /**
   * doc-150 item 6 — HARD enforcement gate for session-launch. Computes the
   * account's storage state and throws StorageQuotaExceededError (409) when it
   * has reached the tier's hard cap (`state === 'hard'`). Enterprise is
   * soft-only so it never reaches 'hard' and is never blocked here. Called
   * BEFORE the driver dispatch on a profile-backed create — the R2 blob is
   * already written by ack time, so this is the enforceable point to block
   * NEW state growth. Sessions without a profile never reach this method.
   *
   * TODO(item6-trim): gated on A3 trimProfile op — once posted, a future
   * `trimProfile` action lets a customer reclaim space in-place instead of
   * only delete/upgrade. No hook needed here yet; this stays a pure block.
   */
  async assertWithinStorageQuotaForLaunch(args: {
    accountId: string;
    tier: AccountTier;
  }): Promise<void> {
    const state = await this.getStorageState(args);
    if (state.state === 'hard') {
      throw new StorageQuotaExceededError({
        usedBytes: state.usedBytes,
        capBytes: state.capBytes,
        tier: args.tier,
      });
    }
  }

  /**
   * doc-150 §8 — persist the new sealed size after a successful out-of-session
   * trim. Reuses the SAME account-scoped `recordSave` repo path the profileSaved
   * persister uses (stamps `last_saved_at = now` + `size_bytes = newSizeBytes` on
   * the owning, non-deleted row), so the storage meter + the launch quota gate pick
   * up the reclaimed bytes immediately. Account-scoped → a foreign id is a no-op.
   * Only called on a confirmed `trimResult{ok}`; an error/timeout never reaches here.
   */
  async recordTrim(args: {
    profileId: string;
    accountId: string;
    newSizeBytes: number;
  }): Promise<void> {
    await this.repo.recordSave({
      id: args.profileId,
      accountId: args.accountId,
      at: new Date(),
      sizeBytes: args.newSizeBytes,
    });
  }

  async list(args: ListProfilesArgs): Promise<ListProfilesPage> {
    return this.repo.list(args);
  }

  async get(args: { id: string; accountId: string }): Promise<ProfileRecord> {
    const row = await this.repo.findById(args);
    if (row === null) throw new NotFoundError('Profile not found.');
    return row;
  }

  async update(args: {
    id: string;
    accountId: string;
    updates: ProfileUpdates;
  }): Promise<ProfileRecord> {
    if (args.updates.name !== undefined) {
      const conflict = await this.repo.findByAccountAndName({
        accountId: args.accountId,
        name: args.updates.name,
      });
      if (conflict !== null && conflict.id !== args.id) {
        throw new ConflictError(
          `Profile name "${args.updates.name}" already exists in this account.`,
          { resource: 'profile', field: 'name' },
        );
      }
    }
    // The repo throws NotFoundError-equivalent if the row doesn't exist.
    const before = await this.repo.findById({ id: args.id, accountId: args.accountId });
    if (before === null) throw new NotFoundError('Profile not found.');
    try {
      return await this.repo.update(args);
    } catch (err) {
      // Concurrent rename race: the pre-check above saw args.updates.name free
      // (or self), but a sibling rename took it before this update commits →
      // profiles_account_name_unique. Only a name change can trip the index,
      // so translate to the same 409 the pre-check throws just for renames;
      // anything else (incl. a 23505 on a description-only update) re-throws.
      if (args.updates.name !== undefined && isProfileNameRaceViolation(err)) {
        throw new ConflictError(
          `Profile name "${args.updates.name}" already exists in this account.`,
          { resource: 'profile', field: 'name' },
        );
      }
      throw err;
    }
  }

  async delete(args: { id: string; accountId: string }): Promise<void> {
    const before = await this.repo.findById(args);
    const ok = await this.repo.delete(args);
    // Idempotent: a re-delete (or an id that was never this account's) is a
    // no-op that still resolves to 204 — matches REST norms, the documented
    // contract, and the sibling destroy endpoints, and never leaks whether
    // the id exists for another account. No row removed → no audit event.
    if (!ok) return;
    await this.emitAuditBestEffort(args.accountId, 'profile.deleted', `profile_${args.id}`, {
      name: before?.name ?? null,
    });
  }

  async touch(args: { id: string; accountId: string; at: Date }): Promise<void> {
    return this.repo.touch(args);
  }

  /** L4b — the account's trashed profiles (recycle bin), most-recently trashed first. */
  async listTrash(args: { accountId: string }): Promise<ProfileRecord[]> {
    return this.repo.listTrashed(args);
  }

  /**
   * L4b — restore a trashed profile. 404 if there's no trashed row with that id
   * for the account; 409 if a live profile took the name while it was trashed
   * (the customer must rename one first). On success returns the now-live record
   * + emits a best-effort profile.restored audit event.
   */
  async restore(args: { id: string; accountId: string }): Promise<ProfileRecord> {
    const outcome = await this.repo.restore(args);
    if (outcome === 'not_found') throw new NotFoundError('Profile not found.');
    if (outcome === 'name_conflict') {
      throw new ConflictError(
        'A live profile already uses this name — rename it before restoring.',
        { resource: 'profile', field: 'name' },
      );
    }
    const row = await this.repo.findById(args);
    if (row === null) throw new NotFoundError('Profile not found.');
    await this.emitAuditBestEffort(args.accountId, 'profile.restored', `profile_${args.id}`, {
      name: row.name,
    });
    return row;
  }

  /**
   * #1/#3 (2026-06-30) — refuse purge()/transferProfile() against a profile
   * that still has a non-terminal session bound to it. A live session holds a
   * long-TTL presigned save-back PUT URL minted independently of the profile
   * row at session-assign (buildAssignProfileBlock, profile-store.ts) and
   * will write its sealed state back at session-end regardless of what
   * happens to the row in the meantime:
   *   - purge(): the row + R2 blob are gone by then, so the late save-back
   *     silently RECREATES a now-orphaned `profiles/<id>.sealed` object —
   *     "permanent delete" isn't permanent, and no sweep ever reaps a blob
   *     whose DB row no longer exists.
   *   - transferProfile(): touch()/recordSave() are notDeleted-scoped, so the
   *     late save-back silently no-ops against the now-trashed source row —
   *     the session's final size_bytes/last_saved_at is lost.
   * Mirrors the #14 trim guard (routes/profiles.ts, `agentSessions.
   * countActiveForProfile`). No-op when the checker isn't wired — same
   * fail-open-to-prior-behavior contract every optional dependency here uses.
   */
  private async assertNoActiveSession(profileId: string, action: string): Promise<void> {
    if (this.agentSessions === null) return;
    const activeCount = await this.agentSessions.countActiveForProfile(profileId);
    if (activeCount > 0) {
      throw new ConflictError(
        `This profile has a live session in progress — stop it before you can ${action} this profile.`,
        { resource: 'profile', field: 'session' },
      );
    }
  }

  /**
   * Anti-abuse (2026-06-17) — permanently delete ONE trashed profile so a user
   * at their cap can free a slot immediately (trashed profiles now count toward
   * the cap). Owner-scoped + trashed-only in the repo; 404 if no trashed row
   * matches. Best-effort profile.purged audit.
   *
   * #1 (2026-06-30) — owner+existence is confirmed FIRST (against the trash
   * listing) before the active-session guard runs, so the guard never
   * confirms the existence/activity of another account's profile id (the
   * same ordering rationale the #14 trim route uses).
   */
  async purge(args: { id: string; accountId: string }): Promise<void> {
    const trashed = await this.repo.listTrashed({ accountId: args.accountId });
    if (!trashed.some((row) => row.id === args.id)) {
      throw new NotFoundError('Trashed profile not found.');
    }
    await this.assertNoActiveSession(args.id, 'purge');

    const purged = await this.repo.purgeTrashed(args);
    if (!purged) throw new NotFoundError('Trashed profile not found.');
    // Best-effort R2 cleanup of the now-orphaned sealed blob. R2 DELETE is
    // idempotent (a never-saved profile has no blob → no-op 204), so we delete
    // unconditionally. A failure is logged, never thrown — the DB row is gone
    // and the blob is opaque + inert; surfacing a 500 here would wrongly tell
    // the customer the purge failed when it succeeded.
    await this.deleteSealedBlobBestEffort(args.id);
    await this.emitAuditBestEffort(args.accountId, 'profile.purged', `profile_${args.id}`, {});
  }

  /**
   * FIX 2 — best-effort delete of a purged profile's R2 sealed blob so the
   * encrypted bytes don't orphan forever. No-op when R2 isn't wired. Never
   * throws (tolerates a missing object + a transient R2 error).
   */
  private async deleteSealedBlobBestEffort(profileId: string): Promise<void> {
    if (this.r2 === null) return;
    try {
      await this.r2.deleteObject(profileSealedBlobKey(profileId));
    } catch (err) {
      this.logger?.error?.(
        { component: 'profiles', profileId, err },
        'failed to delete purged profile sealed-blob from R2 (orphan left behind)',
      );
    }
  }

  /**
   * V-313 — clone an existing profile's metadata. Reads the source row,
   * derives a non-conflicting name (`${source.name} (copy)`, `(copy 2)`,
   * `(copy 3)`, ... incrementing until unused), and inserts a new
   * profile with the same archetype + description. Same tier-cap +
   * unique-name semantics as `create`.
   *
   * Source row is found scoped to `accountId` so the cloner can't
   * duplicate another account's profile by id (404 instead).
   */
  async clone(args: {
    id: string;
    accountId: string;
    tier: AccountTier;
    /** Override the auto-derived name. Same shape constraints as create. */
    name?: string;
  }): Promise<ProfileRecord> {
    const source = await this.repo.findById({ id: args.id, accountId: args.accountId });
    if (source === null) throw new NotFoundError('Profile not found.');

    // Tier cap is shared with create — same enforcement path.
    const limit = profileLimitFor(args.tier);
    if (limit !== null) {
      const current = await this.repo.countByAccount(args.accountId);
      if (current >= limit) {
        throw new TierLimitError(
          `Tier "${args.tier}" permits at most ${limit.toString()} profiles; you have ${current.toString()}.`,
          { limit, current, resource: 'profile', tier: args.tier },
        );
      }
    }

    let cloneName: string;
    if (args.name !== undefined) {
      const conflict = await this.repo.findByAccountAndName({
        accountId: args.accountId,
        name: args.name,
      });
      if (conflict !== null) {
        throw new ConflictError(`Profile name "${args.name}" already exists in this account.`, {
          resource: 'profile',
          field: 'name',
        });
      }
      cloneName = args.name;
    } else {
      cloneName = await this.deriveNonConflictingCopyName(args.accountId, source.name);
    }

    // Profile-backed sessions (file 57): mint a FRESH per-profile DEK for the
    // clone — it starts with no sealed blob, so it must NOT reuse the source's
    // DEK (a clone is a new identity slot, not a copy of the sealed store).
    // Without a DEK the clone runs stateless at session-assign (no restore /
    // save-back) → sealed-state persistence silently breaks for it.
    const cloneIdentity = this.mintProfileIdentity(args.accountId);

    // V-714 — atomic limit-check + insert (count above is the fast-fail
    // pre-check; insertWithLimit re-checks under an account-row lock).
    let result: Awaited<ReturnType<typeof this.repo.insertWithLimit>>;
    try {
      result = await this.repo.insertWithLimit(
        {
          id: cloneIdentity.id,
          accountId: args.accountId,
          name: cloneName,
          archetype: source.archetype,
          description: source.description,
          // Clone is an in-account copy — organization metadata rides along
          // (unlike V-480 import / V-666 transfer, which cross accounts and
          // deliberately leave folder/tags at their defaults). icon + note are
          // organization metadata too, so they copy with the rest.
          folder: source.folder,
          tags: source.tags,
          icon: source.icon,
          note: source.note,
          wrappedDek: cloneIdentity.wrappedDek,
        },
        limit,
      );
    } catch (err) {
      // Concurrent same-name race on an explicit clone name (the auto-derived
      // path can't collide — deriveNonConflictingCopyName already probed).
      if (isProfileNameRaceViolation(err)) {
        throw new ConflictError(`Profile name "${cloneName}" already exists in this account.`, {
          resource: 'profile',
          field: 'name',
        });
      }
      throw err;
    }
    if ('limitExceeded' in result) {
      throw new TierLimitError(
        `Tier "${args.tier}" permits at most ${(limit ?? 0).toString()} profiles; you have ${result.current.toString()}.`,
        { limit: limit ?? 0, current: result.current, resource: 'profile', tier: args.tier },
      );
    }
    const row = result.record;
    await this.emitAuditBestEffort(args.accountId, 'profile.created', `profile_${row.id}`, {
      name: row.name,
      archetype: row.archetype,
      cloned_from: `profile_${source.id}`,
    });
    return row;
  }

  /**
   * V-480 — export a profile's metadata as an envelope payload (no
   * envelope-versioning here — that lives at the route layer where the
   * api-types schema is the canonical shape). Caller wraps in the
   * versioned envelope. Read-only; emits `profile.exported` audit so
   * customers can reconstruct file-flow lineage post-hoc.
   */
  async exportProfile(args: { id: string; accountId: string }): Promise<ProfileRecord> {
    const row = await this.repo.findById({ id: args.id, accountId: args.accountId });
    if (row === null) throw new NotFoundError('Profile not found.');
    // The lineage keys are the ENVELOPE's own values (routes/profiles.ts builds
    // `source_profile_id: `prof_${row.id}`` / `source_account_id: row.accountId`), not the
    // internal `profile_<uuid>` form used for targetResourceId. That is deliberate and it is
    // the whole point: `profile.imported` records whatever the envelope carried, so recording
    // the same string here is what lets a consumer join an export to the import that consumed
    // it. Using the internal form would satisfy the documented key names while leaving the
    // join silently broken.
    await this.emitAuditBestEffort(args.accountId, 'profile.exported', `profile_${row.id}`, {
      name: row.name,
      archetype: row.archetype,
      source_profile_id: `prof_${row.id}`,
      source_account_id: row.accountId,
    });
    return row;
  }

  /**
   * V-480 — import a profile from a metadata envelope. Mints a new
   * profile (fresh id, fresh timestamps) using the envelope's
   * name / archetype / description; emits `profile.imported` audit
   * carrying the source profile + source account ids from the
   * envelope so the customer-facing audit trail can show
   * "imported from profile_X originally minted by acc_Y".
   *
   * Tier-cap enforcement + name-conflict semantics match `create()`:
   * importing into an account at its tier cap raises TierLimitError;
   * importing a name that already exists raises ConflictError unless
   * the caller supplies `nameOverride`.
   */
  async importProfile(args: {
    accountId: string;
    tier: AccountTier;
    sourceProfileId: string;
    sourceAccountId: string;
    payload: { name: string; archetype: string; description: string | null };
    nameOverride?: string;
  }): Promise<ProfileRecord> {
    const archetype = requireSelectableArchetype(args.payload.archetype);
    const limit = profileLimitFor(args.tier);
    if (limit !== null) {
      const current = await this.repo.countByAccount(args.accountId);
      if (current >= limit) {
        throw new TierLimitError(
          `Tier "${args.tier}" permits at most ${limit.toString()} profiles; you have ${current.toString()}.`,
          { limit, current, resource: 'profile', tier: args.tier },
        );
      }
      // 2026-05-22 — V-666 per-cycle import cap. The ceiling above
      // prevents holding more than `limit` profiles at any moment,
      // but a customer could still cycle (export → delete → import
      // N) to effectively bypass the tier. Cap monthly imports at
      // 2× the tier ceiling so legit backup/restore + onboarding
      // workflows clear easily while abuse (continuous churn) hits
      // a clear wall.
      if (this.accountAudit !== null) {
        const cycleStart = new Date();
        cycleStart.setUTCDate(1);
        cycleStart.setUTCHours(0, 0, 0, 0);
        const importsThisCycle = await this.accountAudit.countActionsSince(
          args.accountId,
          'profile.imported',
          cycleStart,
        );
        const importCap = limit * 2;
        if (importsThisCycle >= importCap) {
          throw new TierLimitError(
            `Tier "${args.tier}" permits at most ${importCap.toString()} profile imports per billing cycle; you've used ${importsThisCycle.toString()}. The cycle resets on the 1st of each month UTC.`,
            {
              limit: importCap,
              current: importsThisCycle,
              resource: 'profile_import',
              tier: args.tier,
            },
          );
        }
      }
    }

    const targetName = args.nameOverride ?? args.payload.name;
    const conflict = await this.repo.findByAccountAndName({
      accountId: args.accountId,
      name: targetName,
    });
    if (conflict !== null) {
      throw new ConflictError(
        `Profile name "${targetName}" already exists in this account. Pass name_override to rename on import.`,
        { resource: 'profile', field: 'name' },
      );
    }

    // Profile-backed sessions (file 57): mint a FRESH per-profile DEK for the
    // imported profile — it's a new identity slot in THIS account starting with
    // no sealed blob, so it gets its own DEK (never the source's). Without one
    // the import runs stateless at session-assign (no restore / save-back) →
    // sealed-state persistence silently breaks for it.
    const importIdentity = this.mintProfileIdentity(args.accountId);

    // V-714 — atomic limit-check + insert (count above is the fast-fail
    // pre-check; insertWithLimit re-checks under an account-row lock).
    let result: Awaited<ReturnType<typeof this.repo.insertWithLimit>>;
    try {
      result = await this.repo.insertWithLimit(
        {
          id: importIdentity.id,
          accountId: args.accountId,
          name: targetName,
          archetype,
          description: args.payload.description,
          wrappedDek: importIdentity.wrappedDek,
        },
        limit,
      );
    } catch (err) {
      // Concurrent same-name import race — same 409 (with the name_override
      // hint) the pre-check returns, not an uncaught 500.
      if (isProfileNameRaceViolation(err)) {
        throw new ConflictError(
          `Profile name "${targetName}" already exists in this account. Pass name_override to rename on import.`,
          { resource: 'profile', field: 'name' },
        );
      }
      throw err;
    }
    if ('limitExceeded' in result) {
      throw new TierLimitError(
        `Tier "${args.tier}" permits at most ${(limit ?? 0).toString()} profiles; you have ${result.current.toString()}.`,
        { limit: limit ?? 0, current: result.current, resource: 'profile', tier: args.tier },
      );
    }
    const row = result.record;
    await this.emitAuditBestEffort(args.accountId, 'profile.imported', `profile_${row.id}`, {
      name: row.name,
      archetype: row.archetype,
      source_profile_id: args.sourceProfileId,
      source_account_id: args.sourceAccountId,
      renamed: args.nameOverride !== undefined,
    });
    return row;
  }

  /** V-313 — find an unused name in `${source} (copy)`, `(copy 2)`,
   *  `(copy 3)`, ... iteration. Caps at 99 to avoid runaway loops. */
  private async deriveNonConflictingCopyName(
    accountId: string,
    sourceName: string,
  ): Promise<string> {
    for (let n = 1; n <= 99; n++) {
      const candidate = n === 1 ? `${sourceName} (copy)` : `${sourceName} (copy ${n})`;

      const exists = await this.repo.findByAccountAndName({
        accountId,
        name: candidate,
      });
      if (exists === null) return candidate;
    }
    throw new ConflictError(
      'Too many copies of this profile already exist. Pick a fresh name explicitly.',
      { resource: 'profile', field: 'name' },
    );
  }

  /**
   * 2026-05-22 — transfer ownership of a profile to another Driftstack
   * account. Source loses the profile; recipient gains it. Use cases:
   * team handoff (leaving member's dedicated profiles → colleague),
   * sales handoff (vendor account ships pre-configured profile to
   * buyer). Tier ceiling + per-cycle import quota apply to the
   * RECIPIENT.
   *
   * Atomicity: insert into recipient first, then delete from source.
   * Reverse order would risk losing the profile if insert fails.
   * The narrow window where both rows exist is admin-recoverable
   * (delete the orphan via /admin/accounts).
   */
  async transferProfile(args: {
    sourceProfileId: string;
    sourceAccountId: string;
    recipientAccountId: string;
    recipientTier: AccountTier;
  }): Promise<{ newProfile: ProfileRecord }> {
    const source = await this.repo.findById({
      id: args.sourceProfileId,
      accountId: args.sourceAccountId,
    });
    if (source === null) throw new NotFoundError('Profile not found.');

    // #3 (2026-06-30) — refuse the transfer while the source profile still
    // has a live session bound to it (see assertNoActiveSession). findById
    // above already owner-scoped sourceProfileId to sourceAccountId, so this
    // never confirms another account's profile activity. Thrown BEFORE any
    // mutation, same as the cap/name-race checks below — a refused transfer
    // leaves the source profile untouched.
    await this.assertNoActiveSession(args.sourceProfileId, 'transfer');

    const limit = profileLimitFor(args.recipientTier);
    if (limit !== null) {
      const current = await this.repo.countByAccount(args.recipientAccountId);
      if (current >= limit) {
        throw new TierLimitError(
          `Recipient account is at tier limit (${args.recipientTier}; ${current.toString()}/${limit.toString()}).`,
          { limit, current, resource: 'profile', tier: args.recipientTier },
        );
      }
      if (this.accountAudit !== null) {
        const cycleStart = new Date();
        cycleStart.setUTCDate(1);
        cycleStart.setUTCHours(0, 0, 0, 0);
        const importsThisCycle = await this.accountAudit.countActionsSince(
          args.recipientAccountId,
          'profile.imported',
          cycleStart,
        );
        const importCap = limit * 2;
        if (importsThisCycle >= importCap) {
          throw new TierLimitError(
            `Recipient account has used ${importsThisCycle.toString()}/${importCap.toString()} profile imports this cycle.`,
            {
              limit: importCap,
              current: importsThisCycle,
              resource: 'profile_import',
              tier: args.recipientTier,
            },
          );
        }
      }
    }

    let targetName = source.name;
    const conflict = await this.repo.findByAccountAndName({
      accountId: args.recipientAccountId,
      name: targetName,
    });
    if (conflict !== null) {
      targetName = source.name + ' (transferred)';
    }

    // Profile-backed sessions (file 57): mint a FRESH per-profile DEK bound to
    // the RECIPIENT account's TMK. A transfer mints a new row (new profile_id →
    // new sealed-blob R2 key) with no sealed blob yet, and the source's wrapped
    // DEK is keyed to the SOURCE account's TMK — so the recipient row must get
    // its own freshly-minted DEK, never a copy. Without it the transferred
    // profile runs stateless at session-assign (no restore / save-back).
    const transferIdentity = this.mintProfileIdentity(args.recipientAccountId);

    // V-714 — atomic limit-check + insert on the RECIPIENT account (count
    // above is the fast-fail pre-check; insertWithLimit re-checks under the
    // recipient's account-row lock). Both the cap refusal and the name-race
    // 409 throw BEFORE the source delete below, so a refused transfer leaves
    // the source profile intact (the transfer simply didn't happen).
    // V-714 + the concurrent-transfer fix: retiring the source and creating the
    // recipient row now happen in ONE transaction, and the retire is a CLAIM
    // whose result is checked.
    //
    // Before, this was `insertWithLimit(recipient)` followed by `delete(source)`
    // with the delete's boolean discarded. Two transfers of the SAME source to
    // DIFFERENT recipients take DIFFERENT account-row locks, so nothing
    // serialised them: both inserted, both "deleted" (the second matching zero
    // rows), and one profile became two owned by two accounts — with both
    // callers told they had succeeded. Reproduced by forcing the interleave.
    //
    // Cap and name-race refusals still happen before anything is written, so a
    // refused transfer still leaves the source profile intact.
    let result: Awaited<ReturnType<typeof this.repo.transferAtomic>>;
    try {
      result = await this.repo.transferAtomic({
        source: { id: args.sourceProfileId, accountId: args.sourceAccountId },
        insert: {
          id: transferIdentity.id,
          accountId: args.recipientAccountId,
          name: targetName,
          archetype: source.archetype,
          description: source.description,
          wrappedDek: transferIdentity.wrappedDek,
        },
        limit,
      });
    } catch (err) {
      if (isProfileNameRaceViolation(err)) {
        throw new ConflictError(`Recipient account already has a profile named "${targetName}".`, {
          resource: 'profile',
          field: 'name',
        });
      }
      throw err;
    }
    if ('limitExceeded' in result) {
      throw new TierLimitError(
        `Recipient account is at tier limit (${args.recipientTier}; ${result.current.toString()}/${(limit ?? 0).toString()}).`,
        {
          limit: limit ?? 0,
          current: result.current,
          resource: 'profile',
          tier: args.recipientTier,
        },
      );
    }
    if ('sourceAlreadyRetired' in result) {
      // Another transfer (or a delete) claimed this profile first. It leaves the
      // source account exactly once, and this caller created nothing.
      throw new ConflictError('Profile was transferred or deleted by a concurrent request.', {
        resource: 'profile',
        field: 'id',
      });
    }
    const newProfile = result.record;

    await this.emitAuditBestEffort(
      args.sourceAccountId,
      'profile.deleted',
      `profile_${args.sourceProfileId}`,
      {
        name: source.name,
        archetype: source.archetype,
        reason: 'transferred_out',
        recipient_account_id: args.recipientAccountId,
      },
    );
    await this.emitAuditBestEffort(
      args.recipientAccountId,
      'profile.imported',
      `profile_${newProfile.id}`,
      {
        name: newProfile.name,
        archetype: newProfile.archetype,
        source: 'transfer',
        source_account_id: args.sourceAccountId,
        source_profile_id: args.sourceProfileId,
      },
    );
    return { newProfile };
  }
}
