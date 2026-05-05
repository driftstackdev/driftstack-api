// V-202c — Drizzle implementation of AccountLifecycleRepo.

import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from './client.js';
import { accounts } from './schema.js';
import type { AccountLifecycleRepo, AccountLifecycleRow } from '../services/account-lifecycle.js';

export class DrizzleAccountLifecycleRepo implements AccountLifecycleRepo {
  constructor(private readonly database: Database) {}

  async findForLifecycle(accountId: string): Promise<AccountLifecycleRow | null> {
    const rows = await this.database.db
      .select({
        id: accounts.id,
        email: accounts.email,
        firstFailureEmailSentAt: accounts.firstFailureEmailSentAt,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    return rows[0] ?? null;
  }

  async markFirstFailureEmailSent(accountId: string, at: Date): Promise<boolean> {
    // Conditional UPDATE ... WHERE first_failure_email_sent_at IS NULL.
    // Drizzle's update returns affected rows; we set updatedAt so the
    // row's mutation timestamp reflects the lifecycle state change.
    const result = await this.database.db
      .update(accounts)
      .set({ firstFailureEmailSentAt: at, updatedAt: at })
      .where(and(eq(accounts.id, accountId), isNull(accounts.firstFailureEmailSentAt)))
      .returning({ id: accounts.id });
    return result.length > 0;
  }
}
