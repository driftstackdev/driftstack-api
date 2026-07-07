// Drizzle-backed StripeWebhooksRepo (V-080 + V-089). Idempotency
// ledger + subscription mirror writes + account tier / trial-pack
// mutations triggered by inbound Stripe events.

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { AccountTier } from '@driftstack/api-types';
import type { StripeWebhooksRepo } from '../services/stripe-webhooks.js';
import { isCryptoTierUpgrade, tierActivationRank } from '../services/crypto-tier-activation.js';
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
  }): Promise<{ applied: boolean }> {
    // Event-recency guard. `args.at` is the EVENT time (event.created), the
    // canonical ordering signal — Stripe does not guarantee delivery order
    // and re-delivers failed events for up to 3 days, so a stale / out-of-
    // order event must not overwrite a fresher mirror row. On INSERT (no
    // conflict) the row always applies. On CONFLICT we skip the UPDATE only
    // when the incoming event is STRICTLY OLDER than the stored row, i.e.
    // we apply when `stored.updated_at <= excluded.updated_at` (setWhere).
    // `<=` (not `<`) is deliberate: event.created is second-granularity, so
    // two genuinely-distinct ordered events (e.g. a created immediately
    // followed by an updated) can share a second — equal-time events must
    // still apply (last-processed-wins, matching the prior behaviour, the
    // best we can do without sub-second ordering). Only a strictly-older
    // event is rejected. A skipped UPDATE matches the conflict target but
    // fails the WHERE, so Postgres writes nothing and `.returning()` yields
    // no row: `applied = result.length > 0` distinguishes "wrote (fresh
    // insert or newer/equal update)" from "skipped (stale event)". Callers
    // gate the tier mutation on it.
    const result = await this.database.db
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
        setWhere: sql`${subscriptions.updatedAt} <= excluded.updated_at`,
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
      })
      .returning({ id: subscriptions.id });
    return { applied: result.length > 0 };
  }

  async setAccountTier(args: {
    accountId: string;
    tier: AccountTier;
    at: Date;
  }): Promise<{ previousTier: AccountTier | null }> {
    // Atomic read-then-write under a row lock so the returned previousTier
    // reflects the value as of THIS update even under concurrent same-event
    // Stripe deliveries. Without FOR UPDATE both deliveries could read the
    // same old tier and each emit a duplicate tier-changed email/audit; the
    // lock serializes them, so the loser reads previousTier === args.tier and
    // the lifecycle no-op guard (fromTier === toTier) suppresses the dup.
    // Claim-first was rejected — it can lose an event if the process dies
    // after claiming but before dispatch.
    return this.database.db.transaction(async (tx) => {
      const before = await tx
        .select({ tier: accounts.tier })
        .from(accounts)
        .where(eq(accounts.id, args.accountId))
        .for('update')
        .limit(1);
      const previousTier = before[0]?.tier ?? null;
      await tx
        .update(accounts)
        .set({ tier: args.tier, updatedAt: args.at })
        .where(eq(accounts.id, args.accountId));
      return { previousTier };
    });
  }

  async setAccountTierIfUpgrade(args: {
    accountId: string;
    tier: AccountTier;
    at: Date;
  }): Promise<{ previousTier: AccountTier | null; applied: boolean }> {
    // S41 2026-07-07 (founder-approved: wire crypto activation) — same FOR
    // UPDATE row-lock transaction as setAccountTier above (the Stripe
    // account-tier mechanism this reuses). The upgrade-only decision
    // (isCryptoTierUpgrade — the single shared rule, also used by the
    // in-memory test twin) is evaluated against the LOCKED committed tier,
    // so a concurrent Stripe subscription event and a crypto activation
    // serialize: a stale crypto order can never downgrade a tier a fresher
    // event just granted, and two racing activations can't double-apply.
    return this.database.db.transaction(async (tx) => {
      const before = await tx
        .select({ tier: accounts.tier })
        .from(accounts)
        .where(eq(accounts.id, args.accountId))
        .for('update')
        .limit(1);
      const previousTier = before[0]?.tier ?? null;
      if (previousTier === null || !isCryptoTierUpgrade(previousTier, args.tier)) {
        // Account missing, same tier already held, or would-downgrade —
        // write nothing; the caller logs/derives the exact outcome.
        return { previousTier, applied: false };
      }
      await tx
        .update(accounts)
        .set({ tier: args.tier, updatedAt: args.at })
        .where(eq(accounts.id, args.accountId));
      return { previousTier, applied: true };
    });
  }

  async downgradeAccountTierToBestRemaining(args: {
    accountId: string;
    fallbackTier: AccountTier;
    at: Date;
  }): Promise<{ previousTier: AccountTier | null; appliedTier: AccountTier }> {
    // Same FOR UPDATE serialization as setAccountTier — lock the accounts row so
    // the read-of-remaining-subs → write-tier is atomic against a concurrent
    // same-account delivery. The current subscription's terminal/past_due status
    // was already committed by the upsertSubscription call before this, so it is
    // (correctly) excluded from the active/trialing set below.
    return this.database.db.transaction(async (tx) => {
      const before = await tx
        .select({ tier: accounts.tier })
        .from(accounts)
        .where(eq(accounts.id, args.accountId))
        .for('update')
        .limit(1);
      const previousTier = before[0]?.tier ?? null;
      // The account's best remaining active/trialing subscription (most-recently
      // updated wins in the pathological multi-active case). Its tier is the true
      // entitlement; only when NONE remain do we drop to the fallback (free).
      const remaining = await tx
        .select({ tier: subscriptions.tier })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.accountId, args.accountId),
            inArray(subscriptions.status, ['active', 'trialing']),
          ),
        )
        .orderBy(desc(subscriptions.updatedAt))
        .limit(1);
      const appliedTier = remaining[0]?.tier ?? args.fallbackTier;
      await tx
        .update(accounts)
        .set({ tier: appliedTier, updatedAt: args.at })
        .where(eq(accounts.id, args.accountId));
      return { previousTier, appliedTier };
    });
  }

  async setAccountTierToBestActive(args: {
    accountId: string;
    at: Date;
  }): Promise<{ previousTier: AccountTier | null; appliedTier: AccountTier | null }> {
    // Fable last-hours audit 2026-07-07 (C4) — same FOR UPDATE serialization as
    // the sibling account-tier writers. Set the account to its HIGHEST-RANKED
    // active/trialing subscription so a routine update on a superseded LOWER
    // subscription can't downgrade an account that still holds a HIGHER active
    // one. Rank-aware (not most-recently-updated like the downgrade helper): an
    // upgrade must win over a lower sub regardless of which row was touched last.
    // The caller upserts the current sub active first, so the active set is
    // non-empty in practice; when it is (or the account row is gone) we leave
    // the tier untouched — this method never downgrades to a fallback.
    return this.database.db.transaction(async (tx) => {
      const before = await tx
        .select({ tier: accounts.tier })
        .from(accounts)
        .where(eq(accounts.id, args.accountId))
        .for('update')
        .limit(1);
      const previousTier = before[0]?.tier ?? null;
      if (previousTier === null) return { previousTier: null, appliedTier: null };
      const active = await tx
        .select({ tier: subscriptions.tier })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.accountId, args.accountId),
            inArray(subscriptions.status, ['active', 'trialing']),
          ),
        );
      // Highest-RANKED active/trialing tier — seeded from the active set only
      // (never previousTier), so a genuine single-subscription downgrade still
      // lowers the account. null only when the set is empty, handled above.
      let appliedTier: AccountTier | null = null;
      for (const row of active) {
        if (
          appliedTier === null ||
          tierActivationRank(row.tier) > tierActivationRank(appliedTier)
        ) {
          appliedTier = row.tier;
        }
      }
      if (appliedTier === null) return { previousTier, appliedTier: previousTier };
      await tx
        .update(accounts)
        .set({ tier: appliedTier, updatedAt: args.at })
        .where(eq(accounts.id, args.accountId));
      return { previousTier, appliedTier };
    });
  }
}

// Reference sql to keep the import live for any future raw-SQL needs.
void sql;
