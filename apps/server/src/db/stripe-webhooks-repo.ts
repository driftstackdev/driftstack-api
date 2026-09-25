// Drizzle-backed StripeWebhooksRepo (V-080 + V-089). Idempotency
// ledger + subscription mirror writes + account tier / trial-pack
// mutations triggered by inbound Stripe events.

import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { AccountTier } from '@driftstack/api-types';
import {
  PAST_DUE_GRACE_DAYS,
  type StoredSubscription,
  type StripeWebhooksRepo,
} from '../services/stripe-webhooks.js';
import { isCryptoTierUpgrade, tierActivationRank } from '../services/crypto-tier-activation.js';
import {
  completeInvoicePayment,
  type InvoicePaymentOutcome,
  type InvoicePaymentRecord,
} from '../lib/invoice-payment-record.js';
import {
  BILLING_INTERVALS,
  BILLING_INVOICE_LINE_KINDS,
  type BillingInterval,
  type BillingInvoiceLineKind,
  type PaidInvoiceLine,
  type PeriodStartSource,
} from '../lib/stripe-billing-facts.js';
import type { Database } from './client.js';
import {
  accounts,
  billingInvoicePayments,
  cryptoEntitlements,
  processedStripeEvents,
  subscriptions,
  type BillingInvoicePaymentRow,
} from './schema.js';
import {
  ACTIVE_SUBSCRIPTION_STATUSES,
  COLLECTING_SUBSCRIPTION_STATUSES,
} from './subscription-status-sets.js';

/**
 * Live-billing audit #2 — the order in which a subscription's statuses follow one
 * another, used ONLY to settle two events of one subscription stamped with the
 * SAME second. Stripe's `created` is whole seconds and Stripe does not deliver in
 * order, so "last processed wins" let Checkout's `created(incomplete)`, processed
 * after its same-second `updated(active)`, put a paying subscription back to
 * incomplete — reopening checkout (a second subscription, double billing) — and
 * let a same-second `updated(active)` processed after `deleted` bring a canceled
 * subscription and its tier back.
 *
 * At an equal second the LATER status here wins; `canceled` is last, so nothing
 * replaces it. An equal status still applies, so a redelivered event repeats its
 * own tier step. A strictly newer event wins whatever its status, as before.
 *
 * ⛔ `storedStatusRankSql` below spells this order out in SQL. The two must agree; the
 * arm "every same-second pair is settled the same way" in
 * a-same-second-subscription-event-cannot-reopen-checkout-or-revive-a-canceled-plan
 * drives all 64 pairs through Postgres and through this list.
 */
export const SAME_SECOND_STATUS_ORDER = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'paused',
  'canceled',
] as const;

/** The STORED row's position in SAME_SECOND_STATUS_ORDER (0 = incomplete … 7 = canceled). */
const storedStatusRankSql = sql`(CASE ${subscriptions.status} WHEN 'incomplete' THEN 0 WHEN 'incomplete_expired' THEN 1 WHEN 'trialing' THEN 2 WHEN 'active' THEN 3 WHEN 'past_due' THEN 4 WHEN 'unpaid' THEN 5 WHEN 'paused' THEN 6 WHEN 'canceled' THEN 7 END)`;

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

  /**
   * V-742 — the account's CURRENT tier, used as the NOT-NULL filler when a
   * subscription's Stripe price id is not in `priceToTier`. The handler's own log
   * line says the mirror is "written without tier change", and this is what makes
   * that literally true: a filler equal to the current tier cannot move the
   * account in either direction through the rank recompute or the downgrade path.
   */
  async getAccountTier(accountId: string): Promise<AccountTier | null> {
    const [row] = await this.database.db
      .select({ tier: accounts.tier })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    return row?.tier ?? null;
  }

  async findSubscription(stripeSubscriptionId: string): Promise<StoredSubscription | null> {
    const [row] = await this.database.db
      .select({
        accountId: subscriptions.accountId,
        tier: subscriptions.tier,
        status: subscriptions.status,
        createdAt: subscriptions.createdAt,
        pastDueSince: subscriptions.pastDueSince,
      })
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId))
      .limit(1);
    return row ?? null;
  }

  async listCollectingSubscriptions(accountId: string): Promise<
    Array<{
      stripeSubscriptionId: string;
      status: StoredSubscription['status'];
      createdAt: Date;
    }>
  > {
    return this.database.db
      .select({
        stripeSubscriptionId: subscriptions.stripeSubscriptionId,
        status: subscriptions.status,
        createdAt: subscriptions.createdAt,
      })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.accountId, accountId),
          inArray(subscriptions.status, [...COLLECTING_SUBSCRIPTION_STATUSES]),
        ),
      )
      .orderBy(asc(subscriptions.createdAt), asc(subscriptions.id));
  }

  async listPastDueGraceEnded(args: {
    asOf: Date;
    limit: number;
  }): Promise<Array<{ id: string; accountId: string; pastDueSince: Date }>> {
    const rows = await this.database.db
      .select({
        id: subscriptions.id,
        accountId: subscriptions.accountId,
        pastDueSince: subscriptions.pastDueSince,
      })
      .from(subscriptions)
      .where(pastDueGraceEndedBy(args.asOf))
      .orderBy(asc(subscriptions.pastDueSince), asc(subscriptions.id))
      .limit(args.limit);
    // The WHERE requires a start; this narrows the type to say so.
    return rows.flatMap((r) =>
      r.pastDueSince === null
        ? []
        : [{ id: r.id, accountId: r.accountId, pastDueSince: r.pastDueSince }],
    );
  }

  async markPastDueGraceEnded(args: { ids: string[]; asOf: Date }): Promise<void> {
    if (args.ids.length === 0) return;
    await this.database.db
      .update(subscriptions)
      .set({ pastDueGraceEndedAt: args.asOf })
      .where(and(inArray(subscriptions.id, args.ids), pastDueGraceEndedBy(args.asOf)));
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
    currentPeriodStart?: Date | null;
    billingInterval?: BillingInterval | null;
  }): Promise<{ applied: boolean }> {
    // The period start is written as the event gave it, and a start read from an
    // event is by definition read from Stripe. `tier_since` is the event time of
    // the last plan CHANGE: set on insert, and on conflict moved only when the
    // stored plan differs from the incoming one — so an unrelated update (a
    // payment-method swap, a renewal) leaves it alone. The comparison reads the
    // STORED row, which is why it is SQL and not a value computed here.
    const currentPeriodStart = args.currentPeriodStart ?? null;
    const periodStartSource: PeriodStartSource | null =
      currentPeriodStart === null ? null : 'stripe';
    const billingInterval = args.billingInterval ?? null;
    // Event-recency guard. `args.at` is the EVENT time (event.created), the
    // canonical ordering signal — Stripe does not guarantee delivery order
    // and re-delivers failed events for up to 3 days, so a stale / out-of-
    // order event must not overwrite a fresher mirror row. On INSERT (no
    // conflict) the row always applies. On CONFLICT the UPDATE applies when
    // the incoming event is STRICTLY NEWER than the stored row, and when it
    // carries the SAME second and a status no earlier in
    // SAME_SECOND_STATUS_ORDER than the stored one (live-billing audit #2 —
    // event.created is whole seconds, so two distinct events can share one,
    // and "last processed wins" let a reordered Checkout burst or a late
    // update after a cancel rewind the subscription). A strictly-older event,
    // or a same-second one that would move the lifecycle backwards, is
    // rejected. A skipped UPDATE matches the conflict target but fails the
    // WHERE, so Postgres writes nothing and `.returning()` yields no row:
    // `applied = result.length > 0` distinguishes "wrote" from "skipped".
    // Callers gate the tier mutation on it.
    const incomingStatusRank = SAME_SECOND_STATUS_ORDER.indexOf(args.status);
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
        currentPeriodStart,
        periodStartSource,
        billingInterval,
        tierSince: args.at,
        pastDueSince: args.status === 'past_due' ? args.at : null,
        pastDueGraceEndedAt: null,
      })
      .onConflictDoUpdate({
        target: subscriptions.stripeSubscriptionId,
        setWhere: sql`${subscriptions.updatedAt} < excluded.updated_at OR (${subscriptions.updatedAt} = excluded.updated_at AND ${storedStatusRankSql} <= ${incomingStatusRank})`,
        set: {
          accountId: args.accountId,
          stripePriceId: args.stripePriceId,
          tier: args.tier,
          status: args.status,
          currentPeriodEnd: args.currentPeriodEnd,
          cancelAtPeriodEnd: args.cancelAtPeriodEnd,
          canceledAt: args.canceledAt,
          updatedAt: args.at,
          currentPeriodStart,
          periodStartSource,
          billingInterval,
          tierSince: sql`CASE WHEN ${subscriptions.tier} IS DISTINCT FROM excluded.tier THEN excluded.updated_at ELSE ${subscriptions.tierSince} END`,
          // Live-billing audit #3 — a move INTO past_due stamps the spell's start
          // (the incoming row carries this event's time there); staying past_due
          // keeps the stored start and the sweep's mark; leaving clears both.
          pastDueSince: sql`CASE WHEN excluded.status <> 'past_due' THEN NULL WHEN ${subscriptions.status} = 'past_due' THEN ${subscriptions.pastDueSince} ELSE excluded.past_due_since END`,
          pastDueGraceEndedAt: sql`CASE WHEN excluded.status = 'past_due' AND ${subscriptions.status} = 'past_due' THEN ${subscriptions.pastDueGraceEndedAt} ELSE NULL END`,
        },
      })
      .returning({ id: subscriptions.id });
    return { applied: result.length > 0 };
  }

  async upsertInvoicePayment(
    args: InvoicePaymentRecord,
  ): Promise<{ outcome: InvoicePaymentOutcome; linked: boolean }> {
    // INSERT first, and let the primary key arbitrate: two deliveries of one
    // invoice racing here both try, one row lands, and the loser's DO NOTHING
    // waits for the winner to commit. Only then is the stored row read — under a
    // row lock, so two completions cannot interleave — and completed by the one
    // shared rule. A sighting that adds nothing writes nothing.
    type Result = { outcome: InvoicePaymentOutcome; linked: boolean };
    return this.database.db.transaction(async (tx): Promise<Result> => {
      const inserted = await tx
        .insert(billingInvoicePayments)
        .values({
          stripeInvoiceId: args.stripeInvoiceId,
          accountId: args.accountId,
          stripeSubscriptionId: args.stripeSubscriptionId,
          billingReason: args.billingReason,
          amountPaidMinor: args.amountPaidMinor,
          currency: args.currency,
          stripePaymentIntentId: args.stripePaymentIntentId,
          stripeChargeId: args.stripeChargeId,
          ...lineColumns(args.line),
          paidAt: args.paidAt,
        })
        .onConflictDoNothing({ target: billingInvoicePayments.stripeInvoiceId })
        .returning({ stripeInvoiceId: billingInvoicePayments.stripeInvoiceId });
      if (inserted.length > 0) return { outcome: 'inserted', linked: args.line !== null };

      const [row] = await tx
        .select()
        .from(billingInvoicePayments)
        .where(eq(billingInvoicePayments.stripeInvoiceId, args.stripeInvoiceId))
        .for('update')
        .limit(1);
      if (row === undefined) {
        // The conflicting row was removed between the two statements; only an
        // account deletion does that. Say so rather than report a write.
        throw new Error('billing_invoice_payments row vanished while it was being recorded');
      }
      if (row.accountId !== args.accountId) return { outcome: 'account_mismatch', linked: false };

      const stored = recordOf(row);
      const completed = completeInvoicePayment(stored, args);
      if (completed === null) return { outcome: 'unchanged', linked: stored.line !== null };
      await tx
        .update(billingInvoicePayments)
        .set({
          stripeSubscriptionId: completed.stripeSubscriptionId,
          billingReason: completed.billingReason,
          amountPaidMinor: completed.amountPaidMinor,
          stripePaymentIntentId: completed.stripePaymentIntentId,
          stripeChargeId: completed.stripeChargeId,
          ...lineColumns(completed.line),
        })
        .where(eq(billingInvoicePayments.stripeInvoiceId, args.stripeInvoiceId));
      return { outcome: 'completed', linked: completed.line !== null };
    });
  }

  async listSubscriptionsMissingPeriodStart(args: {
    afterStripeSubscriptionId: string | null;
    limit: number;
  }): Promise<
    Array<{ stripeSubscriptionId: string; stripePriceId: string; currentPeriodEnd: Date | null }>
  > {
    return this.database.db
      .select({
        stripeSubscriptionId: subscriptions.stripeSubscriptionId,
        stripePriceId: subscriptions.stripePriceId,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
      })
      .from(subscriptions)
      .where(
        and(
          isNull(subscriptions.currentPeriodStart),
          args.afterStripeSubscriptionId === null
            ? undefined
            : gt(subscriptions.stripeSubscriptionId, args.afterStripeSubscriptionId),
        ),
      )
      .orderBy(subscriptions.stripeSubscriptionId)
      .limit(args.limit);
  }

  async fillSubscriptionPeriodStart(args: {
    stripeSubscriptionId: string;
    currentPeriodStart: Date;
    source: PeriodStartSource;
    billingInterval: BillingInterval | null;
  }): Promise<{ filled: boolean }> {
    // Only where no start is stored (a webhook's start is never overwritten),
    // and only a start the period-order CHECK will accept. The interval fills an
    // unknown one and never replaces a known one.
    const result = await this.database.db
      .update(subscriptions)
      .set({
        currentPeriodStart: args.currentPeriodStart,
        periodStartSource: args.source,
        billingInterval: sql`COALESCE(${subscriptions.billingInterval}, ${args.billingInterval})`,
      })
      .where(
        and(
          eq(subscriptions.stripeSubscriptionId, args.stripeSubscriptionId),
          isNull(subscriptions.currentPeriodStart),
          or(
            isNull(subscriptions.currentPeriodEnd),
            gt(subscriptions.currentPeriodEnd, args.currentPeriodStart),
          ),
        ),
      )
      .returning({ id: subscriptions.id });
    return { filled: result.length > 0 };
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
      // updated wins in the pathological multi-active case; `id DESC` breaks a
      // same-transaction tie, since now() is transaction-start time — V-2131). Its tier is the true
      // entitlement; only when NONE remain do we drop to the fallback (free).
      // Live-billing audit #3 — a past_due subscription inside its grace still
      // counts (see subscriptionStillGrantsAt), so its first failed renewal keeps
      // the plan and the recompute after the grace takes it away.
      const remaining = await tx
        .select({ tier: subscriptions.tier })
        .from(subscriptions)
        .where(and(eq(subscriptions.accountId, args.accountId), subscriptionStillGrantsAt(args.at)))
        .orderBy(desc(subscriptions.updatedAt), desc(subscriptions.id))
        .limit(1);
      const stripeCandidate = remaining[0]?.tier ?? args.fallbackTier;
      // C1 — floor against the highest-ranked UNEXPIRED crypto entitlement, so a
      // Stripe cancel/past_due never wipes a still-valid crypto-paid tier. With
      // no entitlement rows this loop is a no-op and appliedTier === the Stripe
      // candidate (byte-identical to the prior behaviour). "Unexpired" is judged
      // when this runs, never at an earlier event time — see cryptoTermRunningAt.
      const entRows = await tx
        .select({ tier: cryptoEntitlements.tier })
        .from(cryptoEntitlements)
        .where(
          and(
            eq(cryptoEntitlements.accountId, args.accountId),
            gt(cryptoEntitlements.expiresAt, cryptoTermRunningAt(args.at)),
          ),
        );
      let appliedTier = stripeCandidate;
      for (const r of entRows) {
        if (tierActivationRank(r.tier) > tierActivationRank(appliedTier)) appliedTier = r.tier;
      }
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
    // Last-hours audit 2026-07-07 (C4) — same FOR UPDATE serialization as
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
            inArray(subscriptions.status, [...ACTIVE_SUBSCRIPTION_STATUSES]),
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
      // C1 — also rank in the account's UNEXPIRED crypto entitlements, so an
      // active/trialing upsert on a LOWER Stripe sub never wipes a higher
      // crypto-paid tier. No rows → the loop is a no-op (identical to before).
      // "Unexpired" is judged when this runs — see cryptoTermRunningAt.
      const entRows = await tx
        .select({ tier: cryptoEntitlements.tier })
        .from(cryptoEntitlements)
        .where(
          and(
            eq(cryptoEntitlements.accountId, args.accountId),
            gt(cryptoEntitlements.expiresAt, cryptoTermRunningAt(args.at)),
          ),
        );
      for (const r of entRows) {
        if (appliedTier === null || tierActivationRank(r.tier) > tierActivationRank(appliedTier)) {
          appliedTier = r.tier;
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

  async activateCryptoEntitlement(args: {
    accountId: string;
    orderId: string;
    tier: AccountTier;
    paidAt: Date;
    termDays: number;
  }): Promise<{
    previousTier: AccountTier | null;
    applied: boolean;
    entitlementInserted: boolean;
    startsAt: Date;
    expiresAt: Date;
  }> {
    // C1 — one locked transaction. Lock the accounts row FIRST (same lock order
    // as every sibling tier writer → no deadlock pair with a concurrent Stripe
    // event). Stack a same-tier re-purchase off the account's latest unexpired
    // same-tier expiry; insert idempotently on order_id (a replay returns the
    // ORIGINAL grant verbatim, no double-extend); then apply accounts.tier if
    // it's an upgrade (the compare-gated setAccountTierIfUpgrade semantics).
    return this.database.db.transaction(async (tx) => {
      const before = await tx
        .select({ tier: accounts.tier })
        .from(accounts)
        .where(eq(accounts.id, args.accountId))
        .for('update')
        .limit(1);
      const previousTier = before[0]?.tier ?? null;
      if (previousTier === null) {
        // Account gone — an entitlement can't FK-reference a missing account,
        // so skip the insert cleanly (the caller alarms on the missing account).
        return {
          previousTier: null,
          applied: false,
          entitlementInserted: false,
          startsAt: args.paidAt,
          expiresAt: new Date(args.paidAt.getTime() + args.termDays * 24 * 60 * 60 * 1000),
        };
      }

      const sameTier = await tx
        .select({ expiresAt: cryptoEntitlements.expiresAt })
        .from(cryptoEntitlements)
        .where(
          and(
            eq(cryptoEntitlements.accountId, args.accountId),
            eq(cryptoEntitlements.tier, args.tier),
            gt(cryptoEntitlements.expiresAt, args.paidAt),
          ),
        )
        .orderBy(desc(cryptoEntitlements.expiresAt))
        .limit(1);
      const stackFrom = sameTier[0]?.expiresAt ?? null;
      const startsAt =
        stackFrom !== null && stackFrom.getTime() > args.paidAt.getTime() ? stackFrom : args.paidAt;
      const expiresAt = new Date(startsAt.getTime() + args.termDays * 24 * 60 * 60 * 1000);

      const inserted = await tx
        .insert(cryptoEntitlements)
        .values({
          accountId: args.accountId,
          orderId: args.orderId,
          tier: args.tier,
          startsAt,
          expiresAt,
        })
        .onConflictDoNothing({ target: cryptoEntitlements.orderId })
        .returning({ id: cryptoEntitlements.id });

      if (inserted.length === 0) {
        // Replay — return the ORIGINAL grant's window; the original activation
        // already applied any tier change, so apply nothing now.
        const existing = await tx
          .select({
            startsAt: cryptoEntitlements.startsAt,
            expiresAt: cryptoEntitlements.expiresAt,
          })
          .from(cryptoEntitlements)
          .where(eq(cryptoEntitlements.orderId, args.orderId))
          .limit(1);
        return {
          previousTier,
          applied: false,
          entitlementInserted: false,
          startsAt: existing[0]?.startsAt ?? startsAt,
          expiresAt: existing[0]?.expiresAt ?? expiresAt,
        };
      }

      let applied = false;
      if (previousTier !== null && isCryptoTierUpgrade(previousTier, args.tier)) {
        await tx
          .update(accounts)
          .set({ tier: args.tier, updatedAt: args.paidAt })
          .where(eq(accounts.id, args.accountId));
        applied = true;
      }
      return { previousTier, applied, entitlementInserted: true, startsAt, expiresAt };
    });
  }

  async revokeCryptoEntitlementByOrderId(args: {
    orderId: string;
    at: Date;
  }): Promise<{ revoked: boolean }> {
    // C3 — refund/chargeback clawback: expire the still-valid entitlement this
    // order granted so the best-remaining reconcile no longer floors the tier on
    // it. Bring expires_at forward to `at` (the refund moment) ONLY when the row
    // is still unexpired (expires_at > at) — so a replayed refund IPN finds the
    // row already expired, matches 0 rows, and returns revoked:false (idempotent,
    // no second downgrade/emit). expired_processed_at is deliberately left NULL:
    // the account tier is reconciled immediately by the activator, but leaving it
    // unprocessed lets the 15-min expiry sweeper also pick the row up as a
    // belt-and-braces backstop should the immediate reconcile have failed.
    const result = await this.database.db
      .update(cryptoEntitlements)
      .set({ expiresAt: args.at, updatedAt: sql`now()` })
      .where(
        and(
          eq(cryptoEntitlements.orderId, args.orderId),
          gt(cryptoEntitlements.expiresAt, args.at),
        ),
      )
      .returning({ id: cryptoEntitlements.id });
    return { revoked: result.length > 0 };
  }

  async listExpiredUnprocessedCryptoEntitlements(args: {
    asOf: Date;
    limit: number;
  }): Promise<
    Array<{ id: string; accountId: string; orderId: string; tier: AccountTier; expiresAt: Date }>
  > {
    return this.database.db
      .select({
        id: cryptoEntitlements.id,
        accountId: cryptoEntitlements.accountId,
        orderId: cryptoEntitlements.orderId,
        tier: cryptoEntitlements.tier,
        expiresAt: cryptoEntitlements.expiresAt,
      })
      .from(cryptoEntitlements)
      .where(
        and(
          lte(cryptoEntitlements.expiresAt, args.asOf),
          isNull(cryptoEntitlements.expiredProcessedAt),
        ),
      )
      .orderBy(cryptoEntitlements.expiresAt)
      .limit(args.limit);
  }

  async markCryptoEntitlementsProcessed(args: { ids: string[]; at: Date }): Promise<void> {
    if (args.ids.length === 0) return;
    await this.database.db
      .update(cryptoEntitlements)
      .set({ expiredProcessedAt: args.at, updatedAt: args.at })
      .where(inArray(cryptoEntitlements.id, args.ids));
  }
}

/**
 * Live-billing audit #3 — the start after which a past_due spell is still inside
 * its PAST_DUE_GRACE_DAYS when judged at `at`: the grace is judged at the LATER of
 * the database clock and `at`, as a crypto term is (cryptoTermRunningAt below), so
 * a Stripe event created inside the grace but delivered after it — a retry, three
 * days on — cannot hand back a plan the grace has already ended.
 */
function pastDueGraceStartsAfter(at: Date): SQL {
  return sql`GREATEST(now(), ${at.toISOString()}::timestamptz) - make_interval(days => ${PAST_DUE_GRACE_DAYS})`;
}

/**
 * Live-billing audit #3 — the subscriptions that still give the account their plan
 * when a recompute runs at `at`: `active` and `trialing` (the billed set, as
 * before), and a `past_due` one whose spell began within PAST_DUE_GRACE_DAYS and
 * that the past-due sweep has not processed. The published terms (8.5) promise
 * seven days' written notice before a suspension for non-payment, and the
 * payment-failure email is that notice, so the first failed renewal no longer
 * takes the plan away. A past_due row with no recorded start (one that fell
 * behind before migration 0141) never counts, which is what the code did then.
 */
function subscriptionStillGrantsAt(at: Date): SQL {
  return (
    or(
      inArray(subscriptions.status, [...ACTIVE_SUBSCRIPTION_STATUSES]),
      and(
        eq(subscriptions.status, 'past_due'),
        isNull(subscriptions.pastDueGraceEndedAt),
        gt(subscriptions.pastDueSince, pastDueGraceStartsAfter(at)),
      ),
    ) ?? sql`false`
  );
}

/**
 * Live-billing audit #3 — past_due spells whose grace was over by `asOf` and that
 * the past-due sweep has not yet processed: the sweep's read, and the condition
 * its mark re-checks so a subscription that recovered, or fell behind again,
 * since the read is left alone.
 */
function pastDueGraceEndedBy(asOf: Date): SQL {
  return (
    and(
      eq(subscriptions.status, 'past_due'),
      isNull(subscriptions.pastDueGraceEndedAt),
      lte(
        subscriptions.pastDueSince,
        sql`${asOf.toISOString()}::timestamptz - make_interval(days => ${PAST_DUE_GRACE_DAYS})`,
      ),
    ) ?? sql`false`
  );
}

/**
 * Live-billing audit #9 — the instant a crypto term must still be running at to
 * floor the tier: the LATER of the database's now() and the caller's `at`.
 *
 * Both recomputes used to judge a term at `at` alone, and a Stripe handler passes
 * its EVENT time there. Stripe retries a failed delivery for three days, so an
 * event created before a term ended could arrive after the expiry sweep had
 * taken that term's tier away — and the recompute saw the term as live and gave
 * the tier back. The sweep had already marked the term processed, so nothing
 * ever took it away again. A term now floors only while it is unexpired at the
 * moment the recompute runs.
 *
 * `at` still counts when it is LATER than now(): the sweep and the refund
 * reconcile pass their own processing clock, and a term they have just ended
 * (a refund brings `expires_at` forward to `at`) must not count as running
 * because the database clock is a moment behind theirs.
 */
function cryptoTermRunningAt(at: Date): SQL {
  return sql`GREATEST(now(), ${at.toISOString()}::timestamptz)`;
}

/**
 * The six line columns of a paid-invoice row. With no line, all six are null.
 * With one, its kind and its period are always set; its price, plan and interval
 * may each be unknown (a price the configuration does not name).
 */
function lineColumns(line: PaidInvoiceLine | null): {
  lineKind: BillingInvoiceLineKind | null;
  lineStripePriceId: string | null;
  lineTier: AccountTier | null;
  lineInterval: BillingInterval | null;
  linePeriodStart: Date | null;
  linePeriodEnd: Date | null;
} {
  return {
    lineKind: line?.kind ?? null,
    lineStripePriceId: line?.stripePriceId ?? null,
    lineTier: line?.tier ?? null,
    lineInterval: line?.interval ?? null,
    linePeriodStart: line?.periodStart ?? null,
    linePeriodEnd: line?.periodEnd ?? null,
  };
}

/**
 * A stored row as the record the merge rule speaks. The two text columns are
 * held to their value sets by CHECK constraints; a value outside them cannot be
 * stored, and is refused here rather than cast if one ever is.
 */
function recordOf(row: BillingInvoicePaymentRow): InvoicePaymentRecord {
  const kind = BILLING_INVOICE_LINE_KINDS.find((k) => k === row.lineKind) ?? null;
  if (row.lineKind !== null && kind === null) {
    throw new Error('billing_invoice_payments.line_kind holds a value outside its set');
  }
  const interval = BILLING_INTERVALS.find((i) => i === row.lineInterval) ?? null;
  if (row.lineInterval !== null && interval === null) {
    throw new Error('billing_invoice_payments.line_interval holds a value outside its set');
  }
  const line: PaidInvoiceLine | null =
    kind === null || row.linePeriodStart === null || row.linePeriodEnd === null
      ? null
      : {
          kind,
          stripePriceId: row.lineStripePriceId,
          tier: row.lineTier,
          interval,
          periodStart: row.linePeriodStart,
          periodEnd: row.linePeriodEnd,
        };
  return {
    stripeInvoiceId: row.stripeInvoiceId,
    accountId: row.accountId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    billingReason: row.billingReason,
    amountPaidMinor: row.amountPaidMinor,
    currency: row.currency,
    stripePaymentIntentId: row.stripePaymentIntentId,
    stripeChargeId: row.stripeChargeId,
    line,
    paidAt: row.paidAt,
  };
}

// Reference sql to keep the import live for any future raw-SQL needs.
void sql;
