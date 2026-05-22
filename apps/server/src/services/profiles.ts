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
import { profileLimitFor } from './sessions.js';
import type { AccountAuditService } from './account-audit.js';

export interface ProfileRecord {
  id: string;
  accountId: string;
  name: string;
  archetype: string;
  description: string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewProfileInput {
  accountId: string;
  name: string;
  archetype: string;
  description: string | null;
}

export interface ProfileUpdates {
  name?: string;
  description?: string | null;
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
  countByAccount(accountId: string): Promise<number>;
  findById(args: { id: string; accountId: string }): Promise<ProfileRecord | null>;
  findByAccountAndName(args: { accountId: string; name: string }): Promise<ProfileRecord | null>;
  list(args: ListProfilesArgs): Promise<ListProfilesPage>;
  update(args: { id: string; accountId: string; updates: ProfileUpdates }): Promise<ProfileRecord>;
  /** Returns true if a row was deleted, false if not found / wrong account. */
  delete(args: { id: string; accountId: string }): Promise<boolean>;
  /** Mark `last_used_at` — fire-and-forget from sessions service. */
  touch(args: { id: string; accountId: string; at: Date }): Promise<void>;
}

const DEFAULT_ARCHETYPE = LOCKED_ARCHETYPE_ID;

export interface CreateProfileArgs {
  accountId: string;
  tier: AccountTier;
  name: string;
  archetype?: string;
  description?: string;
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
  ) {}

  private async emitAuditBestEffort(
    accountId: string,
    action: 'profile.created' | 'profile.deleted' | 'profile.exported' | 'profile.imported',
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

    const row = await this.repo.insert({
      accountId: args.accountId,
      name: args.name,
      archetype: args.archetype ?? DEFAULT_ARCHETYPE,
      description: args.description ?? null,
    });
    await this.emitAuditBestEffort(args.accountId, 'profile.created', `profile_${row.id}`, {
      name: row.name,
      archetype: row.archetype,
    });
    return row;
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
    return this.repo.update(args);
  }

  async delete(args: { id: string; accountId: string }): Promise<void> {
    const before = await this.repo.findById(args);
    const ok = await this.repo.delete(args);
    if (!ok) throw new NotFoundError('Profile not found.');
    await this.emitAuditBestEffort(args.accountId, 'profile.deleted', `profile_${args.id}`, {
      name: before?.name ?? null,
    });
  }

  async touch(args: { id: string; accountId: string; at: Date }): Promise<void> {
    return this.repo.touch(args);
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

    const row = await this.repo.insert({
      accountId: args.accountId,
      name: cloneName,
      archetype: source.archetype,
      description: source.description,
    });
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

    const row = await this.repo.insert({
      accountId: args.accountId,
      name: targetName,
      archetype: args.payload.archetype,
      description: args.payload.description,
    });
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

    const newProfile = await this.repo.insert({
      accountId: args.recipientAccountId,
      name: targetName,
      archetype: source.archetype,
      description: source.description,
    });

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
