// Drizzle-backed BillingRepo (V-082).

import { and, desc, eq, inArray } from 'drizzle-orm';
import type {
  BillingAccountSnapshot,
  BillingRepo,
  SubscriptionMirror,
} from '../services/billing.js';
import type { Database } from './client.js';
import { accounts, subscriptions } from './schema.js';
import {
  ACTIVE_SUBSCRIPTION_STATUSES,
  COLLECTING_SUBSCRIPTION_STATUSES,
} from './subscription-status-sets.js';

function toAccount(r: typeof accounts.$inferSelect): BillingAccountSnapshot {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    tier: r.tier,
    stripeCustomerId: r.stripeCustomerId,
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

  /**
   * V-741 — any active|trialing subscription for the account.
   *
   * Filters the SET, unlike findCurrentSubscription below which picks the newest
   * ROW by `created_at` and leaves status to the caller. That distinction is the
   * whole point: `created_at` is frozen at first-webhook insert, so a replayed
   * event for an old canceled subscription can sort NEWER than a live one, and a
   * recency-then-inspect guard then reads 'canceled' and lets a second
   * concurrently-billed subscription be created.
   */
  async findActiveSubscription(accountId: string): Promise<SubscriptionMirror | null> {
    const [row] = await this.database.db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.accountId, accountId),
          inArray(subscriptions.status, [...ACTIVE_SUBSCRIPTION_STATUSES]),
        ),
      )
      .orderBy(desc(subscriptions.createdAt))
      .limit(1);
    return row ? toSubscription(row) : null;
  }

  /**
   * V-767 — the subscription whose COLLECTION is still running: `active`, `trialing` or
   * `past_due`. This is the set that can be paused, and the only set that should be.
   *
   * Neither existing lookup is right for a billing-pause. `findActiveSubscription` excludes
   * `past_due`, which is exactly the subscription you most want to stop dunning while an
   * account is suspended. `findCurrentSubscription` applies no status filter at all — it is a
   * DISPLAY helper ("your last subscription was canceled on X") — so it hands back `canceled`,
   * `unpaid` and `incomplete_expired` rows, and pausing one of those is a Stripe error.
   *
   * Filters the SET rather than picking by recency and inspecting, for the V-741 reason
   * recorded on findActiveSubscription: `created_at` is frozen at first-webhook insert, so a
   * replayed event for an old canceled subscription can sort NEWER than a live one.
   */
  async findCollectingSubscription(accountId: string): Promise<SubscriptionMirror | null> {
    const [row] = await this.database.db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.accountId, accountId),
          inArray(subscriptions.status, [...COLLECTING_SUBSCRIPTION_STATUSES]),
        ),
      )
      .orderBy(desc(subscriptions.createdAt))
      .limit(1);
    return row ? toSubscription(row) : null;
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
