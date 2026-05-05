// Drizzle-backed StripeWebhooksRepo (V-080 + V-089). Idempotency
// ledger + subscription mirror writes + account tier / trial-pack
// mutations triggered by inbound Stripe events.

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AccountTier } from '@driftstack/api-types';
import type { StripeWebhooksRepo } from '../services/stripe-webhooks.js';
import type { Database } from './client.js';
import { accounts, processedStripeEvents, subscriptions } from './schema.js';

export class DrizzleStripeWebhooksRepo implements StripeWebhooksRepo {
  constructor(private readonly database: Database) {}

  async hasEvent(eventId: string): Promise<boolean> {
    const [row] = await this.database.db
      .select({ eventId: processedStripeEvents.eventId })
      .from(processedStripeEvents)
      .where(eq(processedStripeEvents.eventId, eventId))
      .limit(1);
    return row !== undefined;
  }

  async recordEvent(args: {
    eventId: string;
    eventType: string;
    payloadHash: string;
    result: string;
    receivedAt: Date;
  }): Promise<{ inserted: boolean }> {
    const result = await this.database.db
      .insert(processedStripeEvents)
      .values({
        eventId: args.eventId,
        eventType: args.eventType,
        payloadHash: args.payloadHash,
        result: args.result,
        receivedAt: args.receivedAt,
      })
      .onConflictDoNothing({ target: processedStripeEvents.eventId })
      .returning({ eventId: processedStripeEvents.eventId });
    return { inserted: result.length > 0 };
  }

  async findAccountIdFromCustomerOrRef(args: {
    stripeCustomerId: string | null;
    clientReferenceId: string | null;
  }): Promise<string | null> {
    if (args.clientReferenceId !== null) {
      const [row] = await this.database.db
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.id, args.clientReferenceId))
        .limit(1);
      if (row !== undefined) return row.id;
    }
    if (args.stripeCustomerId !== null) {
      const [row] = await this.database.db
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.stripeCustomerId, args.stripeCustomerId))
        .limit(1);
      if (row !== undefined) return row.id;
    }
    return null;
  }

  async upsertSubscription(args: {
    accountId: string;
    stripeSubscriptionId: string;
    stripePriceId: string;
    tier: AccountTier;
    status:
      | 'incomplete'
      | 'incomplete_expired'
      | 'trialing'
      | 'active'
      | 'past_due'
      | 'canceled'
      | 'unpaid'
      | 'paused';
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
    canceledAt: Date | null;
    at: Date;
  }): Promise<void> {
    await this.database.db
      .insert(subscriptions)
      .values({
        accountId: args.accountId,
        stripeSubscriptionId: args.stripeSubscriptionId,
        stripePriceId: args.stripePriceId,
        tier: args.tier,
        status: args.status,
        currentPeriodEnd: args.currentPeriodEnd,
        cancelAtPeriodEnd: args.cancelAtPeriodEnd,
        canceledAt: args.canceledAt,
        createdAt: args.at,
        updatedAt: args.at,
      })
      .onConflictDoUpdate({
        target: subscriptions.stripeSubscriptionId,
        set: {
          accountId: args.accountId,
          stripePriceId: args.stripePriceId,
          tier: args.tier,
          status: args.status,
          currentPeriodEnd: args.currentPeriodEnd,
          cancelAtPeriodEnd: args.cancelAtPeriodEnd,
          canceledAt: args.canceledAt,
          updatedAt: args.at,
        },
      });
  }

  async setAccountTier(args: {
    accountId: string;
    tier: AccountTier;
    at: Date;
  }): Promise<{ previousTier: AccountTier | null }> {
    const before = await this.database.db
      .select({ tier: accounts.tier })
      .from(accounts)
      .where(eq(accounts.id, args.accountId))
      .limit(1);
    const previousTier = before[0]?.tier ?? null;
    await this.database.db
      .update(accounts)
      .set({ tier: args.tier, updatedAt: args.at })
      .where(eq(accounts.id, args.accountId));
    return { previousTier };
  }

  async applyTrialPackPurchase(args: {
    accountId: string;
    creditCents: number;
    expiresAt: Date;
    at: Date;
  }): Promise<{ applied: boolean }> {
    // Conditional update: only set trial-pack fields if not already
    // set (`trial_pack_purchased_at IS NULL`). Returning + length tells
    // us whether the row was actually mutated.
    const result = await this.database.db
      .update(accounts)
      .set({
        trialPackPurchasedAt: args.at,
        trialPackCreditCents: args.creditCents,
        trialPackExpiresAt: args.expiresAt,
        trialPackRedeemed: false,
        updatedAt: args.at,
      })
      .where(and(eq(accounts.id, args.accountId), isNull(accounts.trialPackPurchasedAt)))
      .returning({ id: accounts.id });
    return { applied: result.length > 0 };
  }
}

// Reference sql to keep the import live for any future raw-SQL needs.
void sql;
