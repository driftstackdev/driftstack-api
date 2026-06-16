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

import { LOCKED_ARCHETYPE_ID, type AccountTier } from '@driftstack/api-types';
import { ConflictError, NotFoundError, TierLimitError } from '../lib/errors.js';
import { isUniqueViolation } from '../lib/pg-error.js';
import { profileLimitFor } from './sessions.js';
import type { AccountAuditService } from './account-audit.js';
import { mintWrappedProfileDek, unwrapProfileDek } from '../lib/profile-key-hierarchy.js';

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
  lastUsedAt: Date | null;
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
  accountId: string;
  name: string;
  archetype: string;
  description: string | null;
  /** Organization metadata — omitted/undefined → unfiled / no tags. */
  folder?: string | null;
  tags?: string[];
  /**
   * Profile-backed sessions (file 57): the per-profile DEK wrapped under the
   * account TMK (base64[iv|tag|ct]). Optional — absent/undefined → stored NULL
   * (profiles created without PROFILE_MASTER_KEY set, or via paths that don't
   * mint a DEK). Never exposed back to the customer.
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
  countByAccount(accountId: string): Promise<number>;
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
   */
  restore(args: {
    id: string;
    accountId: string;
  }): Promise<'restored' | 'not_found' | 'name_conflict'>;
  /** Mark `last_used_at` — fire-and-forget from sessions service. */
  touch(args: { id: string; accountId: string; at: Date }): Promise<void>;
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
  ) {}

  private async emitAuditBestEffort(
    accountId: string,
    action:
      | 'profile.created'
      | 'profile.deleted'
      | 'profile.restored'
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
    const wrappedDek =
      this.profileMasterKey !== null
        ? mintWrappedProfileDek(this.profileMasterKey, args.accountId).wrappedDek
        : undefined;

    let result: Awaited<ReturnType<typeof this.repo.insertWithLimit>>;
    try {
      result = await this.repo.insertWithLimit(
        {
          accountId: args.accountId,
          name: args.name,
          archetype: args.archetype ?? DEFAULT_ARCHETYPE,
          description: args.description ?? null,
          folder: args.folder ?? null,
          tags: args.tags ?? [],
          wrappedDek,
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
   * account-scoped wrapped DEK and unwraps it under the account's TMK. Returns
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
    return unwrapProfileDek(this.profileMasterKey, args.accountId, wrappedDek);
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

    // V-714 — atomic limit-check + insert (count above is the fast-fail
    // pre-check; insertWithLimit re-checks under an account-row lock).
    let result: Awaited<ReturnType<typeof this.repo.insertWithLimit>>;
    try {
      result = await this.repo.insertWithLimit(
        {
          accountId: args.accountId,
          name: cloneName,
          archetype: source.archetype,
          description: source.description,
          // Clone is an in-account copy — organization metadata rides along
          // (unlike V-480 import / V-666 transfer, which cross accounts and
          // deliberately leave folder/tags at their defaults).
          folder: source.folder,
          tags: source.tags,
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
    await this.emitAuditBestEffort(args.accountId, 'profile.exported', `profile_${row.id}`, {
      name: row.name,
      archetype: row.archetype,
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

    // V-714 — atomic limit-check + insert (count above is the fast-fail
    // pre-check; insertWithLimit re-checks under an account-row lock).
    let result: Awaited<ReturnType<typeof this.repo.insertWithLimit>>;
    try {
      result = await this.repo.insertWithLimit(
        {
          accountId: args.accountId,
          name: targetName,
          archetype: args.payload.archetype,
          description: args.payload.description,
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

    // V-714 — atomic limit-check + insert on the RECIPIENT account (count
    // above is the fast-fail pre-check; insertWithLimit re-checks under the
    // recipient's account-row lock). Both the cap refusal and the name-race
    // 409 throw BEFORE the source delete below, so a refused transfer leaves
    // the source profile intact (the transfer simply didn't happen).
    let result: Awaited<ReturnType<typeof this.repo.insertWithLimit>>;
    try {
      result = await this.repo.insertWithLimit(
        {
          accountId: args.recipientAccountId,
          name: targetName,
          archetype: source.archetype,
          description: source.description,
        },
        limit,
      );
    } catch (err) {
      // Concurrent race: the recipient acquired `targetName` between the
      // pre-check rename above and this insert. Fail with a clean 409 — we
      // throw before the source delete, so the source profile is preserved
      // (the transfer simply didn't happen) rather than surfacing a 500.
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
    const newProfile = result.record;

    await this.repo.delete({ id: args.sourceProfileId, accountId: args.sourceAccountId });

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
