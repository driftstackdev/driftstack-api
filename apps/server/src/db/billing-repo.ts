// Drizzle-backed BillingRepo (V-082).

import { desc, eq } from 'drizzle-orm';
import type {
  BillingAccountSnapshot,
  BillingRepo,
  SubscriptionMirror,
} from '../services/billing.js';
import type { Database } from './client.js';
import { accounts, subscriptions } from './schema.js';

function toAccount(r: typeof accounts.$inferSelect): BillingAccountSnapshot {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    tier: r.tier,
    stripeCustomerId: r.stripeCustomerId,
    trialPackPurchasedAt: r.trialPackPurchasedAt,
    trialPackCreditCents: r.trialPackCreditCents,
    trialPackExpiresAt: r.trialPackExpiresAt,
    trialPackRedeemed: r.trialPackRedeemed,
  };
}

function toSubscription(r: typeof subscriptions.$inferSelect): SubscriptionMirror {
  return {
    id: r.id,
    accountId: r.accountId,
    stripeSubscriptionId: r.stripeSubscriptionId,
    stripePriceId: r.stripePriceId,
    tier: r.tier,
    status: r.status,
    currentPeriodEnd: r.currentPeriodEnd,
    cancelAtPeriodEnd: r.cancelAtPeriodEnd,
    canceledAt: r.canceledAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// W197 — only the `db` handle is read; narrow the dependency to make
// e2e fixtures composable without the full Database envelope
// (`{ client, db, close }`).
export class DrizzleBillingRepo implements BillingRepo {
  constructor(private readonly database: Pick<Database, 'db'>) {}

  async getAccount(accountId: string): Promise<BillingAccountSnapshot | null> {
    const [row] = await this.database.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    return row ? toAccount(row) : null;
  }

  async setStripeCustomerId(args: { accountId: string; customerId: string }): Promise<void> {
    await this.database.db
      .update(accounts)
      .set({ stripeCustomerId: args.customerId, updatedAt: new Date() })
      .where(eq(accounts.id, args.accountId));
  }

  async findCurrentSubscription(accountId: string): Promise<SubscriptionMirror | null> {
    // Most-recent first by created_at; route layer can filter to active
    // statuses if it cares. We don't filter here so the dashboard can
    // surface "your last subscription was canceled on X" without an
    // extra query.
    const [row] = await this.database.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.accountId, accountId))
      .orderBy(desc(subscriptions.createdAt))
      .limit(1);
    return row ? toSubscription(row) : null;
  }
}
