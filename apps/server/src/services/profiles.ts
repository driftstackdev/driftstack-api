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
  constructor(private readonly repo: ProfilesRepo) {}

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

    return this.repo.insert({
      accountId: args.accountId,
      name: args.name,
      archetype: args.archetype ?? DEFAULT_ARCHETYPE,
      description: args.description ?? null,
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
    return this.repo.update(args);
  }

  async delete(args: { id: string; accountId: string }): Promise<void> {
    const ok = await this.repo.delete(args);
    if (!ok) throw new NotFoundError('Profile not found.');
  }

  async touch(args: { id: string; accountId: string; at: Date }): Promise<void> {
    return this.repo.touch(args);
  }
}
