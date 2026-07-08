// V-202c — in-memory AccountLifecycleRepo for integration tests.
// V-304a — extended with firstSuccessEmailSentAt parallel column.

import type {
  AccountLifecycleRepo,
  AccountLifecycleRow,
} from '../../../src/services/account-lifecycle.js';

interface InMemoryRow {
  id: string;
  email: string;
  firstFailureEmailSentAt: Date | null;
  firstSuccessEmailSentAt: Date | null;
}

export class InMemoryAccountLifecycleRepo implements AccountLifecycleRepo {
  private readonly rows = new Map<string, InMemoryRow>();
  /** C6 — claimed (stripeEventId:kind) pairs; mirrors the DB composite PK. */
  private readonly billingClaims = new Set<string>();

  /** Test seam — seed an account row into the lifecycle view. */
  upsert(row: {
    id: string;
    email: string;
    firstFailureEmailSentAt?: Date | null;
    firstSuccessEmailSentAt?: Date | null;
  }): void {
    this.rows.set(row.id, {
      id: row.id,
      email: row.email,
      firstFailureEmailSentAt: row.firstFailureEmailSentAt ?? null,
      firstSuccessEmailSentAt: row.firstSuccessEmailSentAt ?? null,
    });
  }

  /** Test seam — read the dedup flag without going through the contract. */
  read(accountId: string): InMemoryRow | undefined {
    return this.rows.get(accountId);
  }

  findForLifecycle(accountId: string): Promise<AccountLifecycleRow | null> {
    const r = this.rows.get(accountId);
    return Promise.resolve(r ? { ...r } : null);
  }

  markFirstFailureEmailSent(accountId: string, at: Date): Promise<boolean> {
    const r = this.rows.get(accountId);
    if (!r) return Promise.resolve(false);
    if (r.firstFailureEmailSentAt !== null) return Promise.resolve(false);
    this.rows.set(accountId, { ...r, firstFailureEmailSentAt: at });
    return Promise.resolve(true);
  }

  markFirstSuccessEmailSent(accountId: string, at: Date): Promise<boolean> {
    const r = this.rows.get(accountId);
    if (!r) return Promise.resolve(false);
    if (r.firstSuccessEmailSentAt !== null) return Promise.resolve(false);
    this.rows.set(accountId, { ...r, firstSuccessEmailSentAt: at });
    return Promise.resolve(true);
  }

  claimBillingEmail(args: {
    stripeEventId: string;
    kind: 'billing-receipt' | 'billing-failure' | 'billing-renewal-reminder';
    accountId: string;
    at: Date;
  }): Promise<boolean> {
    const key = `${args.stripeEventId}:${args.kind}`;
    if (this.billingClaims.has(key)) return Promise.resolve(false);
    this.billingClaims.add(key);
    return Promise.resolve(true);
  }
}
