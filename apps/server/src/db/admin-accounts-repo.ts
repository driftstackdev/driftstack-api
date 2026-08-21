// Drizzle-backed AccountsAdminRepo. Updates accounts.tier / accounts.status.

import { type SQL, and, desc, eq, gte, ilike, lt, or, sql } from 'drizzle-orm';
import { AccountTierSchema, type AccountTier } from '@driftstack/api-types';
import type {
  AccountsAdminRepo,
  ListAccountsArgs,
  ListAccountsPage,
} from '../services/admin-accounts.js';
import type { AccountRow } from '../services/auth.js';
import type { Database } from './client.js';
import { accounts } from './schema.js';
import { parseUuidCursor } from '../lib/keyset-cursor.js';

// V-1245 — the staff account browser's page size, named and exported so the in-memory
// double reads THESE numbers instead of keeping its own `Math.min(args.limit ?? 50, 100)`.
// Both sides carried the literal, so the two agreed only until somebody edited one, and
// every test standing on the double would have gone on asserting the old cap.
//
// Its own constants, NOT shared with the customer profile listing or the snapshot listing,
// which carry the same two numbers today. Those are separate product limits that merely
// coincide; one constant across all three would mean raising the staff page size silently
// raised what customers get too.
export const ADMIN_ACCOUNTS_PAGE_DEFAULT = 50;
export const ADMIN_ACCOUNTS_PAGE_MAX = 100;

export class DrizzleAccountsAdminRepo implements AccountsAdminRepo {
  constructor(private readonly database: Database) {}

  async findById(id: string): Promise<AccountRow | null> {
    const [row] = await this.database.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, id))
      .limit(1);
    return row ? toRow(row) : null;
  }

  async setTier(id: string, tier: AccountTier, at: Date): Promise<AccountRow | null> {
    const [row] = await this.database.db
      .update(accounts)
      .set({ tier, updatedAt: at })
      .where(eq(accounts.id, id))
      .returning();
    return row ? toRow(row) : null;
  }

  async setStatus(
    id: string,
    status: 'active' | 'suspended' | 'deleted',
    at: Date,
  ): Promise<AccountRow | null> {
    // GDPR Article 17 — stamp deleted_at when transitioning to 'deleted' so
    // the account-deletion-purge-sweeper can compute a 30-day retention
    // cutoff. There is no "undelete" flow, so deleted_at is never cleared
    // once set; active/suspended transitions never touch it.
    const [row] = await this.database.db
      .update(accounts)
      .set({ status, updatedAt: at, ...(status === 'deleted' ? { deletedAt: at } : {}) })
      .where(eq(accounts.id, id))
      .returning();
    return row ? toRow(row) : null;
  }

  async list(args: ListAccountsArgs): Promise<ListAccountsPage> {
    const limit = Math.min(args.limit ?? ADMIN_ACCOUNTS_PAGE_DEFAULT, ADMIN_ACCOUNTS_PAGE_MAX);

    const filters: SQL[] = [];
    if (args.status !== undefined) filters.push(eq(accounts.status, args.status));
    if (args.tier !== undefined) filters.push(eq(accounts.tier, args.tier));
    if (args.emailContains !== undefined && args.emailContains.length > 0) {
      filters.push(ilike(accounts.email, `%${args.emailContains.toLowerCase()}%`));
    }

    if (args.cursor !== undefined && parseUuidCursor(args.cursor) !== undefined) {
      const [cursorRow] = await this.database.db
        .select({ createdAt: accounts.createdAt, id: accounts.id })
        .from(accounts)
        .where(eq(accounts.id, args.cursor))
        .limit(1);
      if (cursorRow !== undefined) {
        const cursorClause = or(
          lt(accounts.createdAt, cursorRow.createdAt),
          and(eq(accounts.createdAt, cursorRow.createdAt), lt(accounts.id, cursorRow.id)),
        );
        if (cursorClause !== undefined) filters.push(cursorClause);
      }
    }

    const whereClause = filters.length === 0 ? undefined : and(...filters);

    const rows = await this.database.db
      .select()
      .from(accounts)
      .where(whereClause)
      .orderBy(desc(accounts.createdAt), desc(accounts.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map(toRow);
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;
    return { data, hasMore, nextCursor };
  }

  async countByStatus(status: 'active' | 'suspended' | 'deleted'): Promise<number> {
    const [row] = await this.database.db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(accounts)
      .where(eq(accounts.status, status));
    return row?.cnt ?? 0;
  }

  // One GROUP BY query rather than one count per tier — keeps the overview
  // endpoint single-roundtrip. Zero-fill from AccountTierSchema.options so
  // every tier is present (no hardcoded list to drift from the enum).
  async countByTier(): Promise<Record<AccountTier, number>> {
    const rows = await this.database.db
      .select({ tier: accounts.tier, cnt: sql<number>`count(*)::int` })
      .from(accounts)
      .groupBy(accounts.tier);
    const out = emptyTierCounts();
    for (const row of rows) out[row.tier] = row.cnt;
    return out;
  }

  async countCreatedSince(since: Date): Promise<number> {
    const [row] = await this.database.db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(accounts)
      .where(gte(accounts.createdAt, since));
    return row?.cnt ?? 0;
  }
}

/** Zero-filled count record over every AccountTier (canonical enum order). */
function emptyTierCounts(): Record<AccountTier, number> {
  const out = {} as Record<AccountTier, number>;
  for (const tier of AccountTierSchema.options) out[tier] = 0;
  return out;
}

function toRow(r: typeof accounts.$inferSelect): AccountRow {
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
