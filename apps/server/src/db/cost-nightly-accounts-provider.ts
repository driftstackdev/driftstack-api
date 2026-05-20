// Drizzle-backed AccountIdProvider for the V-541.E nightly cost-
// recompute scheduled-job (cost-nightly-job.ts). Returns the full set
// of `status = 'active'` account ids each tick; suspended + deleted
// accounts are skipped because their cost summaries would be stale /
// already-resolved.
//
// Kept small + separate from `admin-accounts-repo` so the cost path
// doesn't depend on the admin RBAC surface (CostNightlyJob runs as a
// server-side scheduled job, no actor scope).

import { eq } from 'drizzle-orm';
import type { AccountIdProvider } from '../services/cost-nightly-job.js';
import type { Database } from './client.js';
import { accounts } from './schema.js';

export class DrizzleCostNightlyAccountIdProvider implements AccountIdProvider {
  constructor(private readonly database: Database) {}

  async listAllAccountIds(): Promise<readonly string[]> {
    const rows = await this.database.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.status, 'active'));
    return rows.map((r) => r.id);
  }
}
