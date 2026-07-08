// Drizzle-backed implementation of AccountAuthRepo.

import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import type {
  AccountAuthRepo,
  AccountRow,
  ApiKeyRow,
  RateLimitOverride,
  TeamMembership,
  WebSessionAuthRow,
} from '../services/auth.js';
import type { AccountOrganization } from '@driftstack/api-types';
import type { Database } from './client.js';
import { isUniqueViolation } from '../lib/pg-error.js';
import { accounts, apiKeys, rateLimitOverrides, teamMembers, webSessions } from './schema.js';

// Throttle window for the per-request api_keys.last_used_at write — at most
// one update per key per this interval, so the hot auth path doesn't write a
// row on every authenticated request. See touchApiKeyLastUsed.
const API_KEY_LAST_USED_THROTTLE_MS = 30_000;

export class DrizzleAccountAuthRepo implements AccountAuthRepo {
  constructor(private readonly database: Database) {}

  async findApiKeyByPrefix(prefix: string): Promise<ApiKeyRow | null> {
    const [row] = await this.database.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyPrefix, prefix))
      .limit(1);
    return row ? toApiKeyRow(row) : null;
  }

  async getAccount(id: string): Promise<AccountRow | null> {
    const [row] = await this.database.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, id))
      .limit(1);
    return row ? toAccountRow(row) : null;
  }

  async findActiveRateLimitOverrides(accountId: string, now: Date): Promise<RateLimitOverride[]> {
    const rows = await this.database.db
      .select()
      .from(rateLimitOverrides)
      .where(
        and(eq(rateLimitOverrides.accountId, accountId), gt(rateLimitOverrides.expiresAt, now)),
      );
    return rows.map((r) => ({
      bucketKey: r.bucketKey,
      capacity: r.capacity,
      // Centi-rate stored as 100x; multiply back. See V-016 for the
      // quantization caveat (1/60 → 2 → 1/50 effective). Acceptable
      // until/unless an exact-match requirement emerges.
      refillPerSecond: r.refillPerSecondCenti / 100,
      expiresAt: r.expiresAt,
    }));
  }

  async touchApiKeyLastUsed(id: string, at: Date): Promise<void> {
    await this.database.db
      .update(apiKeys)
      .set({ lastUsedAt: at })
      .where(
        and(
          eq(apiKeys.id, id),
          // Skip the write if last_used_at was set within the last 30s — saves
          // a row update on every authenticated request.
          or(
            isNull(apiKeys.lastUsedAt),
            lt(apiKeys.lastUsedAt, new Date(at.getTime() - API_KEY_LAST_USED_THROTTLE_MS)),
          ),
        ),
      );
  }

  async findActiveWebSession(args: {
    tokenHash: string;
    now: Date;
  }): Promise<WebSessionAuthRow | null> {
    const [row] = await this.database.db
      .select()
      .from(webSessions)
      .where(
        and(
          eq(webSessions.tokenHash, args.tokenHash),
          gt(webSessions.expiresAt, args.now),
          isNull(webSessions.revokedAt),
        ),
      )
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      accountId: row.accountId,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      lastUsedAt: row.lastUsedAt,
      mfaSatisfiedAt: row.mfaSatisfiedAt,
      createdAt: row.createdAt,
    };
  }

  async touchWebSessionLastUsed(id: string, at: Date): Promise<void> {
    await this.database.db
      .update(webSessions)
      .set({ lastUsedAt: at })
      .where(eq(webSessions.id, id));
  }

  async findTeamMemberships(memberAccountId: string): Promise<TeamMembership[]> {
    // Join the owner account so the membership carries the owner's email + name
    // (the dashboard labels a team by who owns it, not a bare acc_<uuid>). An
    // innerJoin is correct here: a membership row always references a live owner
    // account (FK), so the join can never drop a row.
    const rows = await this.database.db
      .select({
        id: teamMembers.id,
        ownerAccountId: teamMembers.ownerAccountId,
        ownerEmail: accounts.email,
        ownerName: accounts.name,
        role: teamMembers.role,
      })
      .from(teamMembers)
      .innerJoin(accounts, eq(accounts.id, teamMembers.ownerAccountId))
      .where(eq(teamMembers.memberAccountId, memberAccountId));
    return rows.map((r) => ({
      membershipId: r.id,
      ownerAccountId: r.ownerAccountId,
      ownerEmail: r.ownerEmail,
      ownerName: r.ownerName,
      role: r.role,
    }));
  }

  async updateAccountBasics(
    id: string,
    patch: {
      name?: string | null;
      timezone?: string | null;
      avatarR2Key?: string | null;
      slug?: string | null;
      region?: 'us' | 'eu' | 'apac' | null;
    },
  ): Promise<AccountRow | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.timezone !== undefined) set.timezone = patch.timezone;
    if (patch.avatarR2Key !== undefined) set.avatarR2Key = patch.avatarR2Key;
    if (patch.slug !== undefined) set.slug = patch.slug;
    if (patch.region !== undefined) set.region = patch.region;
    try {
      const [row] = await this.database.db
        .update(accounts)
        .set(set)
        .where(eq(accounts.id, id))
        .returning();
      return row ? toAccountRow(row) : null;
    } catch (err) {
      // V-298a — translate Postgres unique-violation on the slug
      // index into a SlugTakenError so the route layer returns 409.
      // drizzle-version-agnostic (top level on 0.38, err.cause on 0.45).
      if (isUniqueViolation(err, 'accounts_slug_unique')) {
        throw new Error('SLUG_TAKEN');
      }
      throw err;
    }
  }

  // Per-account org-sync (0079) — the account-level folder/tag taxonomy.
  async getOrganization(id: string): Promise<AccountOrganization | null> {
    const [row] = await this.database.db
      .select({ organization: accounts.organization })
      .from(accounts)
      .where(eq(accounts.id, id))
      .limit(1);
    if (!row) return null;
    const org = row.organization;
    return { folders: org.folders ?? [], tags: org.tags ?? [] };
  }

  async setOrganization(id: string, org: AccountOrganization): Promise<void> {
    await this.database.db
      .update(accounts)
      .set({ organization: org, updatedAt: new Date() })
      .where(eq(accounts.id, id));
  }
}

function toApiKeyRow(r: typeof apiKeys.$inferSelect): ApiKeyRow {
  return {
    id: r.id,
    accountId: r.accountId,
    name: r.name,
    keyPrefix: r.keyPrefix,
    keyHash: r.keyHash,
    scopes: r.scopes,
    lastUsedAt: r.lastUsedAt,
    revokedAt: r.revokedAt,
    expiresAt: r.expiresAt,
    provenance: r.provenance,
    createdAt: r.createdAt,
  };
}

function toAccountRow(r: typeof accounts.$inferSelect): AccountRow {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    tier: r.tier,
    status: r.status,
    timezone: r.timezone,
    avatarR2Key: r.avatarR2Key,
    slug: r.slug,
    region: r.region,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
