// Drizzle-backed AccountsAdminRepo. Updates accounts.tier / accounts.status.

import { type SQL, and, desc, eq, ilike, lt, or, sql } from 'drizzle-orm';
import type { AccountTier } from '@driftstack/api-types';
import type {
  AccountsAdminRepo,
  ListAccountsArgs,
  ListAccountsPage,
} from '../services/admin-accounts.js';
import type { AccountRow } from '../services/auth.js';
import type { Database } from './client.js';
import { accounts } from './schema.js';

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
    const [row] = await this.database.db
      .update(accounts)
      .set({ status, updatedAt: at })
      .where(eq(accounts.id, id))
      .returning();
    return row ? toRow(row) : null;
  }

  async list(args: ListAccountsArgs): Promise<ListAccountsPage> {
    const limit = Math.min(args.limit ?? 50, 100);

    const filters: SQL[] = [];
    if (args.status !== undefined) filters.push(eq(accounts.status, args.status));
    if (args.tier !== undefined) filters.push(eq(accounts.tier, args.tier));
    if (args.emailContains !== undefined && args.emailContains.length > 0) {
      filters.push(ilike(accounts.email, `%${args.emailContains.toLowerCase()}%`));
    }

    if (args.cursor !== undefined) {
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
}

function toRow(r: typeof accounts.$inferSelect): AccountRow {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    tier: r.tier,
    status: r.status,
    timezone: r.timezone,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
