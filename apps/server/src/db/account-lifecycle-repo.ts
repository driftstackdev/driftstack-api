// V-202c — Drizzle implementation of AccountLifecycleRepo.

import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from './client.js';
import { accounts, billingEmailSends } from './schema.js';
import type { AccountLifecycleRepo, AccountLifecycleRow } from '../services/account-lifecycle.js';

export class DrizzleAccountLifecycleRepo implements AccountLifecycleRepo {
  constructor(private readonly database: Database) {}

  async findForLifecycle(accountId: string): Promise<AccountLifecycleRow | null> {
    const rows = await this.database.db
      .select({
        id: accounts.id,
        email: accounts.email,
        firstFailureEmailSentAt: accounts.firstFailureEmailSentAt,
        firstSuccessEmailSentAt: accounts.firstSuccessEmailSentAt,
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

  async markFirstSuccessEmailSent(accountId: string, at: Date): Promise<boolean> {
    // V-304a — same pattern as markFirstFailureEmailSent. Different column.
    const result = await this.database.db
      .update(accounts)
      .set({ firstSuccessEmailSentAt: at, updatedAt: at })
      .where(and(eq(accounts.id, accountId), isNull(accounts.firstSuccessEmailSentAt)))
      .returning({ id: accounts.id });
    return result.length > 0;
  }

  async claimBillingEmail(args: {
    stripeEventId: string;
    kind: 'billing-receipt' | 'billing-failure' | 'billing-renewal-reminder';
    accountId: string;
    at: Date;
  }): Promise<boolean> {
    // C6 — INSERT ... ON CONFLICT (stripe_event_id, kind) DO NOTHING; the row
    // is returned only when THIS insert won → this caller sends the email.
    const rows = await this.database.db
      .insert(billingEmailSends)
      .values({
        stripeEventId: args.stripeEventId,
        kind: args.kind,
        accountId: args.accountId,
        claimedAt: args.at,
      })
      .onConflictDoNothing({ target: [billingEmailSends.stripeEventId, billingEmailSends.kind] })
      .returning({ stripeEventId: billingEmailSends.stripeEventId });
    return rows.length > 0;
  }
}
