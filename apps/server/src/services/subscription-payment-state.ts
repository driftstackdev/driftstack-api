// Whether a subscription was paid (owner decision of 2026-09-24).
//
// "Terminating a subscription that was not paid → cancel with NO credit; paid
// subscriptions still prorate." Every cancel that chooses between a prorated and an
// unprorated cancel asks this module: account termination (billing.ts
// BillingService.cancelCollectionForAccount, from what the billing provider holds
// at the moment of the cancel) and a subscription replaced by a new plan
// (stripe-webhooks.ts cancelReplacedSubscriptions, from the stored status). It is
// pure: it reads nothing and writes nothing.

/**
 * Owner decision of 2026-09-24 — what decides whether a subscription was paid, as the
 * billing provider holds it.
 */
export interface SubscriptionPaymentState {
  /** The subscription's status (Stripe's names: active, trialing, past_due, unpaid, ...). */
  status: string;
  /** `pause_collection.behavior` (void, mark_uncollectible, keep_as_draft); null when not paused. */
  pauseCollectionBehavior?: string | null;
  /** The status of the subscription's latest invoice (draft, open, paid, void, uncollectible); null when unknown. */
  latestInvoiceStatus?: string | null;
}

/**
 * A {@link SubscriptionPaymentState} as read from the billing provider. `partlyUnread`
 * is true when part of it could not be read (the latest invoice), so the answer was
 * decided from what was read and the caller should record the subscription as not
 * fully read.
 */
export interface SubscriptionPaymentReading extends SubscriptionPaymentState {
  partlyUnread?: boolean;
}

/**
 * Owner decision of 2026-09-24 — "terminating a subscription that was not paid →
 * cancel with NO credit; paid subscriptions still prorate". The ONE definition of "not
 * paid", used by every cancel that chooses between a prorated and an unprorated cancel
 * (account termination, and a replaced subscription in stripe-webhooks.ts). A
 * subscription was not paid when:
 *
 *   - its status is `past_due` (the period's invoice failed) or `unpaid` (dunning gave
 *     up); or
 *   - its latest invoice is `draft`, `open`, `void` or `uncollectible`: the current
 *     period's invoice was not paid. A `draft` is the renewal Stripe raised at the start
 *     of the period and has not charged yet (it finalizes it about an hour later, and
 *     holds it as a draft for good while collection is paused with `keep_as_draft`), so
 *     the period it bills has not been paid; or
 *   - its collection is paused with behavior `void` or `mark_uncollectible` and its
 *     latest invoice is not known to be paid: every renewal raised while paused is
 *     voided or written off (account suspension pauses with `void`). Most such
 *     renewals already show as a `void` or `uncollectible` latest invoice; this arm
 *     decides when the latest invoice is missing or could not be read.
 *
 * Anything else is paid, and so is prorated. In particular a subscription whose latest
 * invoice is `paid` was paid for its current period even when its collection has been
 * paused since (an account suspended part-way through a period it paid for): "paid
 * subscriptions still prorate". Fields left out are unknown and count for nothing, so
 * the stored status alone decides when the provider could not be read.
 */
export function subscriptionWasNotPaid(state: SubscriptionPaymentState): boolean {
  if (state.status === 'past_due' || state.status === 'unpaid') return true;
  const invoice = state.latestInvoiceStatus ?? null;
  if (invoice === 'paid') return false;
  if (
    invoice === 'draft' ||
    invoice === 'open' ||
    invoice === 'void' ||
    invoice === 'uncollectible'
  ) {
    return true;
  }
  const pause = state.pauseCollectionBehavior ?? null;
  return pause === 'void' || pause === 'mark_uncollectible';
}
