// V-312 — profile snapshots service. Immutable point-in-time copies
// of profile metadata + state. Per founder Tier-2 verdict 2026-05-09:
// pg_dump / GitHub-commit-SHA model — parent profile keeps evolving;
// the snapshot is frozen.
//
// Lifecycle:
//   - capture: read source profile (404 if missing or wrong-account),
//     insert snapshot row carrying parent's archetype + name + state.
//   - list: per-profile or per-account.
//   - get: single by id (account-scoped; 404 cross-account).
//   - restore: create a NEW profile from the snapshot's captured
//     archetype + a customer-supplied name. Tier-cap shared with
//     ProfilesService.create (TierLimitError 429 when exceeded).
//     V-814 corrected this from 402; the class has always been 429.
//   - delete: hard-delete the snapshot row (only mutation).
//
// State-blob handling: v1 is metadata-only — browser state isn't
// surfaced through the customer API yet. The state_blob jsonb column
// exists so a future driver integration can populate it without a
// schema migration. Captures land empty {} for now.

import type { AccountTier } from '@driftstack/api-types';
import { ConflictError, NotFoundError, TierLimitError } from '../lib/errors.js';
import { profileLimitFor } from './sessions.js';
import { isProfileNameRaceViolation, mintProfileRowIdentity } from './profiles.js';
import type { ProfileRecord, ProfilesRepo } from './profiles.js';
import type { AccountAuditService } from './account-audit.js';

export interface ProfileSnapshotRecord {
  id: string;
  accountId: string;
  parentProfileId: string | null;
  label: string;
  description: string | null;
  parentArchetype: string;
  parentName: string;
  stateBlob: Record<string, unknown>;
  capturedAt: Date;
  createdAt: Date;
}

export interface NewSnapshotInput {
  accountId: string;
  parentProfileId: string;
  label: string;
  description: string | null;
  parentArchetype: string;
  parentName: string;
  stateBlob: Record<string, unknown>;
}

export interface ListSnapshotsArgs {
  accountId: string;
  /** When set, narrows to snapshots whose parent_profile_id matches.
   *  Null parent (orphaned by a deleted profile) is excluded. */
  parentProfileId?: string;
  /** Newest-first cursor: prior page's last id. Optional. */
  cursor?: string;
  limit?: number;
}

export interface ListSnapshotsPage {
  data: ProfileSnapshotRecord[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface ProfileSnapshotsRepo {
  insert(input: NewSnapshotInput): Promise<ProfileSnapshotRecord>;
  list(args: ListSnapshotsArgs): Promise<ListSnapshotsPage>;
  findById(args: { id: string; accountId: string }): Promise<ProfileSnapshotRecord | null>;
  /** Returns true if a row was deleted, false if not found / wrong account. */
  delete(args: { id: string; accountId: string }): Promise<boolean>;
}

export interface CaptureArgs {
  accountId: string;
  profileId: string;
  label: string;
  description?: string | null;
}

export interface RestoreArgs {
  accountId: string;
  snapshotId: string;
  tier: AccountTier;
  /** Required — the new profile's name. Caller validates shape via
   *  the same Zod schema used on profiles.create. */
  name: string;
}

export class ProfileSnapshotsService {
  constructor(
    private readonly snapshotsRepo: ProfileSnapshotsRepo,
    private readonly profilesRepo: ProfilesRepo,
    private readonly accountAudit: AccountAuditService | null = null,
    private readonly profileMasterKey: Buffer | null = null,
  ) {}

  private async emitAuditBestEffort(
    accountId: string,
    action: 'profile.created' | 'profile.deleted',
    targetResourceId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.accountAudit) return;
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
      /* swallow */
    }
  }

  async capture(args: CaptureArgs): Promise<ProfileSnapshotRecord> {
    const profile = await this.profilesRepo.findById({
      id: args.profileId,
      accountId: args.accountId,
    });
    if (!profile) throw new NotFoundError('Profile not found.');

    const row = await this.snapshotsRepo.insert({
      accountId: args.accountId,
      parentProfileId: profile.id,
      label: args.label,
      description: args.description ?? null,
      parentArchetype: profile.archetype,
      parentName: profile.name,
      stateBlob: {},
    });
    return row;
  }

  async list(args: ListSnapshotsArgs): Promise<ListSnapshotsPage> {
    // A sub-resource listing must not imply that its parent exists. Without
    // this check `GET /v1/profiles/{id}/snapshots` answered 200 with an empty
    // page for a profile that does not exist — indistinguishable from a real
    // profile that simply has no snapshots, so a customer who mistyped an id
    // was told "no snapshots" rather than "no such profile". It also
    // contradicted the 404 the route's own contract documents.
    //
    // `capture()` above already performs exactly this lookup before writing;
    // only the read path skipped it. The account-wide listing passes no parent
    // and has nothing to verify.
    if (args.parentProfileId !== undefined) {
      const profile = await this.profilesRepo.findById({
        id: args.parentProfileId,
        accountId: args.accountId,
      });
      if (!profile) throw new NotFoundError('Profile not found.');
    }
    return this.snapshotsRepo.list(args);
  }

  async get(args: { id: string; accountId: string }): Promise<ProfileSnapshotRecord> {
    const row = await this.snapshotsRepo.findById(args);
    if (!row) throw new NotFoundError('Snapshot not found.');
    return row;
  }

  async restore(args: RestoreArgs): Promise<ProfileRecord> {
    const snapshot = await this.snapshotsRepo.findById({
      id: args.snapshotId,
      accountId: args.accountId,
    });
    if (!snapshot) throw new NotFoundError('Snapshot not found.');

    // Tier cap shared with ProfilesService.create — same enforcement.
    const limit = profileLimitFor(args.tier);
    if (limit !== null) {
      const current = await this.profilesRepo.countByAccount(args.accountId);
      if (current >= limit) {
        throw new TierLimitError(
          `Tier "${args.tier}" permits at most ${limit.toString()} profiles; you have ${current.toString()}.`,
          { limit, current, resource: 'profile', tier: args.tier },
        );
      }
    }

    // Name uniqueness check — restore creates a fresh row, same
    // posture as create.
    const conflict = await this.profilesRepo.findByAccountAndName({
      accountId: args.accountId,
      name: args.name,
    });
    if (conflict !== null) {
      throw new ConflictError(`Profile name "${args.name}" already exists in this account.`, {
        resource: 'profile',
        field: 'name',
      });
    }

    // V-714 — the count pre-check above is a fast-fail (preserves error
    // precedence + skips a tx when clearly over). insertWithLimit RE-checks
    // the count + inserts atomically under an account-row lock, so a
    // concurrent create/restore that passed the pre-check still can't push
    // the account past its per-tier cap (was a count-then-insert TOCTOU —
    // the 5th profile-creation path, missed by the original create/clone/
    // import/transfer fix).
    // Profile-backed sessions: restore creates a fresh identity slot with no
    // copied sealed state, so it must mint its own DEK bound to the final
    // account + preallocated profile UUID. A missing master key keeps the
    // feature inert (wrappedDek omitted), matching every other insert path.
    const identity = mintProfileRowIdentity(this.profileMasterKey, args.accountId);

    let result: Awaited<ReturnType<typeof this.profilesRepo.insertWithLimit>>;
    try {
      result = await this.profilesRepo.insertWithLimit(
        {
          id: identity.id,
          accountId: args.accountId,
          name: args.name,
          archetype: snapshot.parentArchetype,
          description: snapshot.description,
          wrappedDek: identity.wrappedDek,
        },
        limit,
      );
    } catch (err) {
      // Concurrent same-name race: another create/restore took args.name
      // between the pre-check above and this insert. Translate the
      // profiles_account_name_unique 23505 to the same 409 the pre-check
      // throws, not an uncaught 500.
      if (isProfileNameRaceViolation(err)) {
        throw new ConflictError(`Profile name "${args.name}" already exists in this account.`, {
          resource: 'profile',
          field: 'name',
        });
      }
      throw err;
    }
    if ('limitExceeded' in result) {
      // Lost the under-lock count re-check to a concurrent create/restore.
      throw new TierLimitError(
        `Tier "${args.tier}" permits at most ${(limit ?? 0).toString()} profiles; you have ${result.current.toString()}.`,
        { limit: limit ?? 0, current: result.current, resource: 'profile', tier: args.tier },
      );
    }
    const restored = result.record;
    await this.emitAuditBestEffort(args.accountId, 'profile.created', `profile_${restored.id}`, {
      name: restored.name,
      archetype: restored.archetype,
      restored_from_snapshot: `psnap_${snapshot.id}`,
    });
    return restored;
  }

  async delete(args: { id: string; accountId: string }): Promise<void> {
    const ok = await this.snapshotsRepo.delete(args);
    if (!ok) throw new NotFoundError('Snapshot not found.');
  }
}
