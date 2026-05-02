// Drizzle-backed AccountsAdminRepo. Updates accounts.tier / accounts.status.

import { eq } from 'drizzle-orm';
import type { AccountTier } from '@driftstack/api-types';
import type { AccountsAdminRepo } from '../services/admin-accounts.js';
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
}

function toRow(r: typeof accounts.$inferSelect): AccountRow {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    tier: r.tier,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
