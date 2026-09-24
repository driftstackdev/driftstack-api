// Inbound Stripe webhook handler.
//
// Stripe-signed events arrive at POST /v1/webhooks/stripe. This service
// owns:
//
//   1. Idempotency — `processed_stripe_events` records each handled
//      `event.id`. Duplicates short-circuit at 200 OK without re-running
//      the handler. Stripe re-delivers within 3 days; the table is the
//      durable record of "we've already seen this."
//
//   2. Event dispatch — async per-type handlers that mutate the local
//      mirror (subscriptions table, accounts.tier, accounts.trial_pack_*)
//      based on Stripe event payloads.
//
//   3. The paid-invoice record — `invoice.payment_succeeded` and
//      `invoice.paid` write one `billing_invoice_payments` row per invoice,
//      BEFORE anything a customer can see (the receipt email), so a failed
//      write aborts the event and Stripe's retry does both, once each.
//
//   4. Monthly AI credits — ONLY while AI credits are switched on
//      (`creditsRefresher` is wired). An applied subscription event and a
//      recorded paid invoice are what change an account's paid coverage, so
//      each ends by refreshing that account's credits. It is the LAST thing the
//      handler does, after every write and email above is done, and it is
//      idempotent: a transient failure is rethrown so Stripe retries, and the
//      retry repeats nothing (the receipt is claimed once per event, the paid
//      invoice is recorded once, a month is granted once).
//
// Signature verification is the route's job (it has the raw body); this
// service receives a verified, parsed event.

import { createHash } from 'node:crypto';
import type { AccountTier } from '@driftstack/api-types';
import { isTransientInfraError } from '../lib/transient-error.js';
import type { Logger } from '../lib/logger.js';
import type { InvoicePaymentOutcome, InvoicePaymentRecord } from '../lib/invoice-payment-record.js';
import {
  reportUnlinkableInvoice,
  type UnlinkableInvoiceReason,
} from '../lib/report-unlinkable-invoice.js';
import type { SentryClient } from '../lib/sentry.js';
import {
  invoiceSaysItIsNotPaid,
  readInvoiceSubscriptionId,
  readPaidInvoice,
  readSubscriptionPeriodEnd,
  readSubscriptionPeriodStart,
  type BillingInterval,
  type PaidInvoiceFacts,
  type PaidInvoiceLine,
  type PeriodStartSource,
} from '../lib/stripe-billing-facts.js';
import type { AccountLifecycleService } from './account-lifecycle.js';
import type { AuthCache } from './auth-cache.js';
import { refreshCreditsAfter, type CreditsRefresher } from './credit-grants.js';
import {
  isCreditReversalAwaitingPayment,
  REVERSAL_AWAITS_PAYMENT_FOR_MS,
  type CreditClawbacks,
} from './credit-clawbacks.js';

/**
 * Minimal parsed-Stripe-event shape. We don't depend on the `stripe`
 * package's TypeScript types — they're vast and most of the runtime
 * shape we touch lives under `data.object` which is an open object.
 */
export interface StripeEvent {
  id: string;
  type: string;
  api_version?: string;
  created?: number;
  data: { object: Record<string, unknown> };
  livemode?: boolean;
  request?: { id: string | null; idempotency_key: string | null } | null;
}

export interface StripeWebhooksRepo {
  /** Returns `true` if this is a fresh insert; `false` if `event_id` was already present. */
  recordEvent(args: {
    eventId: string;
    eventType: string;
    payloadHash: string;
    result: string;
    receivedAt: Date;
  }): Promise<{ inserted: boolean }>;
  /** True if `event_id` is already in the ledger (used for short-circuit before handler runs). */
  hasEvent(eventId: string): Promise<boolean>;

  // ── V-089 mutation methods ──────────────────────────────────────────

  /**
   * Resolve the local account id from a Stripe event's customer +
   * client_reference_id fields. Returns null when neither resolves
   * (event references an account we don't track — should never happen
   * in practice but the handler logs + returns 'ignored' rather than
   * throwing).
   */
  findAccountIdFromCustomerOrRef(args: {
    stripeCustomerId: string | null;
    clientReferenceId: string | null;
  }): Promise<string | null>;

  /**
   * V-742 — the account's current tier, used as the NOT-NULL filler for a
   * subscription whose Stripe price id is absent from `priceToTier`.
   */
  getAccountTier(accountId: string): Promise<AccountTier | null>;

  /**
   * Live-billing audits #11, #4 and #3 — the STORED mirror row of one subscription,
   * or null when none is stored. Read before a subscription event's upsert
   * overwrites it: its plan is what an unmapped price falls back to (#11), and its
   * status says whether the event is the subscription's first move into collecting
   * (#4). The payment-failure notice reads when a past_due spell began (#3).
   */
  findSubscription(stripeSubscriptionId: string): Promise<StoredSubscription | null>;

  /**
   * Live-billing audit #4 — the account's subscriptions still collecting (`active` |
   * `trialing` | `past_due`), oldest first by when the mirror first saw them.
   */
  listCollectingSubscriptions(accountId: string): Promise<
    Array<{
      stripeSubscriptionId: string;
      status: LocalStatus;
      /** When the mirror first saw the subscription (its first event's time). */
      createdAt: Date;
    }>
  >;

  /**
   * Live-billing audit #3 — the past-due sweep's read: past_due subscriptions whose
   * spell began at least PAST_DUE_GRACE_DAYS before `asOf` and that the sweep has
   * not yet processed. Oldest spell first, capped. A row with no recorded start
   * (past_due before migration 0141) is never listed.
   */
  listPastDueGraceEnded(args: {
    asOf: Date;
    limit: number;
  }): Promise<Array<{ id: string; accountId: string; pastDueSince: Date }>>;

  /**
   * Live-billing audit #3 — mark rows processed by the past-due sweep. A row is
   * marked only while it is STILL in the spell that was listed (past_due, the
   * grace over at `asOf`, not yet marked), so a subscription that recovered, or
   * fell behind again, in between is left for what it is now.
   */
  markPastDueGraceEnded(args: { ids: string[]; asOf: Date }): Promise<void>;

  /**
   * Upsert a subscription mirror row keyed on `stripeSubscriptionId`.
   * If a row with that id exists, UPDATE its mutable fields ONLY when the
   * incoming event is newer than the stored row (event-recency guard —
   * Stripe does not guarantee delivery order and re-delivers for up to 3
   * days, so an out-of-order / retried-old event must not revert a fresher
   * mirror). `args.at` carries the EVENT time (event.created), not the
   * processing time, and is the recency signal. Returns `{ applied }`:
   * `true` on a fresh INSERT or a newer-event UPDATE; `false` when a
   * conflicting row already holds a strictly-newer event (write skipped).
   * Callers gate the account-tier mutation on `applied` so a stale event
   * touches neither the mirror nor the tier.
   *
   * Live-billing audit #3 — the row also records when a past_due spell began: an
   * applied move INTO past_due stamps `past_due_since` with `at`; staying past_due
   * keeps the stamp (and the sweep's mark); any other status clears both.
   */
  upsertSubscription(args: {
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
    /**
     * When the current period began, as the event said; null or omitted when it
     * said nothing. Written as read (a null clears a stored start: the period may
     * have rolled, and a stale start beside a new end would describe a period
     * that never existed). A non-null start is recorded as read from Stripe.
     */
    currentPeriodStart?: Date | null;
    /** 'month' | 'year' for a configured price; null or omitted for any other. */
    billingInterval?: BillingInterval | null;
  }): Promise<{ applied: boolean }>;

  /**
   * Record one PAID invoice, keyed on the invoice id. Idempotent: a second
   * sighting of the same invoice (the sibling event, a Stripe retry, the
   * backfill) never writes a second row and never rewrites a known fact. It may
   * only COMPLETE the record — tie a row that named no line to its line, add a
   * payment reference that was absent — and says so in the outcome:
   *   'inserted'          first sighting, row written
   *   'completed'         the stored row gained a fact it lacked
   *   'unchanged'         nothing to add, nothing written
   *   'account_mismatch'  the invoice is recorded against ANOTHER account;
   *                       nothing written (a payment is never re-attributed)
   * `linked` says whether the STORED row names a subscription line once this
   * call is done — which an earlier sighting may have supplied.
   */
  upsertInvoicePayment(
    args: InvoicePaymentRecord,
  ): Promise<{ outcome: InvoicePaymentOutcome; linked: boolean }>;

  /**
   * Period backfill read: subscription mirror rows with no stored period start,
   * in `stripeSubscriptionId` order, after `afterStripeSubscriptionId` (null =
   * from the beginning). The id order makes a walk resumable from any row.
   */
  listSubscriptionsMissingPeriodStart(args: {
    afterStripeSubscriptionId: string | null;
    limit: number;
  }): Promise<
    Array<{
      stripeSubscriptionId: string;
      stripePriceId: string;
      currentPeriodEnd: Date | null;
    }>
  >;

  /**
   * Period backfill write: store a period start ONLY where none is stored, and
   * only one that precedes the stored period end. Never overwrites a start a
   * webhook wrote. `billingInterval` fills an unknown interval and never
   * replaces a known one. Returns `{ filled }`: false when the row already had a
   * start, is gone, or the start would not precede its end.
   */
  fillSubscriptionPeriodStart(args: {
    stripeSubscriptionId: string;
    currentPeriodStart: Date;
    source: PeriodStartSource;
    billingInterval: BillingInterval | null;
  }): Promise<{ filled: boolean }>;

  /**
   * Set the account's `tier` column. Used when subscription state
   * transitions imply a tier change (e.g. subscription.created →
   * upgrade from free to api_builder; subscription.deleted →
   * downgrade to free).
   *
   * Returns the previous tier so callers can detect a real change
   * (V-226 audit emit only fires when previousTier !== new tier).
   * Returns null when the account is not found (should never happen
   * in practice — the caller resolves accountId before calling).
   */
  setAccountTier(args: {
    accountId: string;
    tier: AccountTier;
    at: Date;
  }): Promise<{ previousTier: AccountTier | null }>;
  /**
   * S41 2026-07-07 (founder-approved: wire crypto activation) — conditional
   * variant of setAccountTier, shared with the crypto paid-order activation
   * path (CryptoTierActivationService reuses this repo's account-tier
   * machinery instead of inventing its own). Applies `tier` ONLY when it is
   * a strict upgrade over the account's current tier per isCryptoTierUpgrade
   * (price-rank strict-greater: `free` ranks lowest so a free account always
   * upgrades; `enterprise`/unpriced tiers rank highest so a custom contract
   * is never overwritten; the same tier is a no-op). The compare runs INSIDE
   * the same FOR UPDATE row-lock transaction as the write, so a concurrent
   * Stripe-driven tier change and a crypto activation serialize — a stale
   * crypto order can never clobber a tier a fresher event just granted.
   * Returns `{ previousTier, applied }`; on applied=false nothing was
   * written and previousTier disambiguates why (null = account missing,
   * === tier = already held, otherwise = would-downgrade skip).
   */
  setAccountTierIfUpgrade(args: {
    accountId: string;
    tier: AccountTier;
    at: Date;
  }): Promise<{ previousTier: AccountTier | null; applied: boolean }>;
  /**
   * After a subscription goes terminal (`canceled`) or past_due/unpaid, set the
   * account's tier from its BEST remaining active/trialing subscription — or
   * `fallbackTier` if none remain — in ONE locked transaction (mirrors
   * setAccountTier's FOR UPDATE serialization). Prevents a SUPERSEDED
   * subscription's cancel/past_due event from downgrading an account that still
   * holds another active subscription: an account can hold multiple subscription
   * rows (only stripe_subscription_id is unique, and re-checkout is permitted
   * while an existing subscription is past_due), so keying the account tier off
   * whichever single subscription's event was processed last silently strands a
   * paying customer on the free tier. Returns the previous + applied tier so the
   * caller can gate the cache-invalidate + tier_changed emit on a real change.
   *
   * C1 — the applied tier ALSO floors against the highest-ranked UNEXPIRED
   * crypto entitlement (crypto_entitlements.expires_at > at): a Stripe
   * cancel/past_due never downgrades below a still-valid non-refundable
   * crypto-paid tier. With no entitlement rows this is byte-identical to the
   * pure-Stripe computation (the crypto side is a rank comparison bolted on
   * after the unchanged Stripe candidate selection).
   *
   * Live-billing audit #3 — "remaining" also counts a `past_due` subscription
   * inside its grace: fewer than PAST_DUE_GRACE_DAYS since its spell began,
   * judged at the later of the database clock and `at`, and not yet processed by
   * the past-due sweep. So the first failed renewal keeps the paid plan (ToS 8.5),
   * and the recompute that runs once the grace is over — a later event, or the
   * sweep — takes it away. A past_due row with no recorded start never counts.
   */
  downgradeAccountTierToBestRemaining(args: {
    accountId: string;
    fallbackTier: AccountTier;
    at: Date;
  }): Promise<{ previousTier: AccountTier | null; appliedTier: AccountTier }>;
  /**
   * Fable last-hours audit 2026-07-07 (C4) — the active/trialing counterpart
   * of downgradeAccountTierToBestRemaining. After an active/trialing upsert,
   * set the account tier to the HIGHEST-RANKED active/trialing subscription
   * (by tierActivationRank), NOT blindly the event's own tier. An account can
   * hold multiple active subscriptions (re-checkout is permitted while
   * past_due), so a routine `customer.subscription.updated` on a LOWER sub
   * must not downgrade an account that still holds a HIGHER active sub. Unlike
   * the downgrade helper's most-recently-updated tie-break, this is rank-aware:
   * an upgrade must never lose to a lower sub merely because it was touched
   * more recently. Same FOR UPDATE serialization as the sibling writers. The
   * caller upserts the current sub active BEFORE calling, so the active set is
   * non-empty here; `appliedTier` is null only when the account row is gone
   * (unchanged → no emit). Single-active-subscription accounts are unaffected:
   * the best-active tier is exactly the event's tier, identical to the prior
   * unconditional setAccountTier.
   *
   * C1 — the rank loop also includes the account's UNEXPIRED crypto entitlement
   * tiers, so a routine active/trialing upsert on a LOWER Stripe sub never wipes
   * a still-valid higher crypto-paid tier. With no entitlement rows the result
   * is byte-identical to the pure-Stripe computation.
   */
  setAccountTierToBestActive(args: {
    accountId: string;
    at: Date;
  }): Promise<{ previousTier: AccountTier | null; appliedTier: AccountTier | null }>;
  /**
   * C1 — record (or extend) the crypto tier entitlement for a paid order in one
   * locked transaction, then apply accounts.tier if the entitlement is an
   * upgrade (the existing compare-gated setAccountTierIfUpgrade semantics).
   * Idempotent on orderId: a replay returns the ORIGINAL grant's window and
   * inserts nothing. A same-tier re-purchase STACKS (startsAt = max(paidAt, the
   * account's latest unexpired same-tier expiry)) instead of being a paid-for-
   * nothing no-op. `applied` reflects the tier write (gate cache-invalidate +
   * emit on it); `entitlementInserted` is false on a replay.
   */
  activateCryptoEntitlement(args: {
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
  }>;
  /**
   * C3 — refund/chargeback clawback: bring an order's crypto entitlement expiry
   * forward to `at` so the best-remaining reconcile no longer floors the account
   * tier on the refunded grant. Only affects a still-valid row (expires_at > at);
   * a replayed refund IPN finds the row already expired and matches nothing.
   * Leaves expired_processed_at NULL so the expiry sweeper can also pick the row
   * up as a backstop. Returns `{ revoked }` (true iff a row was updated) so the
   * caller can gate the immediate best-remaining reconcile + emit on a real
   * revocation and no-op on a replay.
   */
  revokeCryptoEntitlementByOrderId(args: {
    orderId: string;
    at: Date;
  }): Promise<{ revoked: boolean }>;
  /**
   * C1 — sweeper read: entitlements past expiry that the sweeper hasn't yet
   * processed (expired_processed_at IS NULL). Ordered by expires_at, capped.
   */
  listExpiredUnprocessedCryptoEntitlements(args: {
    asOf: Date;
    limit: number;
  }): Promise<
    Array<{ id: string; accountId: string; orderId: string; tier: AccountTier; expiresAt: Date }>
  >;
  /** C1 — mark the given entitlement rows expiry-processed (sweeper, after the
   *  downgrade recompute). Idempotent (last write wins). */
  markCryptoEntitlementsProcessed(args: { ids: string[]; at: Date }): Promise<void>;
}

export type DispatchOutcome = 'handled' | 'ignored' | `error:${string}`;

/**
 * Live-billing audit #3 — how many days a `past_due` subscription keeps its plan
 * after its spell began: the published terms (8.5) promise at least seven days'
 * written notice before a suspension for non-payment, and the payment-failure
 * email sent at the first failure is that notice. The Drizzle recompute, the
 * past-due sweep and the email's "until" date all read this one number.
 */
export const PAST_DUE_GRACE_DAYS = 7;

const PAST_DUE_GRACE_MS = PAST_DUE_GRACE_DAYS * 24 * 60 * 60 * 1000;

/** What recording a paid invoice did, and the paid line it read (live-billing audit #12). */
interface RecordedPaidInvoice {
  recorded: boolean;
  line: PaidInvoiceLine | null;
}

/** A subscription's stored mirror row, as the webhook reads it back (see `findSubscription`). */
export interface StoredSubscription {
  accountId: string;
  tier: AccountTier;
  status: LocalStatus;
  /** When the mirror first saw the subscription. */
  createdAt: Date;
  /** When its current past_due spell began; null when it is not past_due (or it began before 0141). */
  pastDueSince: Date | null;
}

export interface StripeWebhooksServiceConfig {
  logger: Logger;
  /**
   * Reverse map from Stripe price id to local AccountTier. Used by
   * `customer.subscription.{created,updated}` to determine which tier
   * to set on the account based on the subscription's price. When a
   * price id is absent from this map (e.g. an enterprise custom-billed
   * subscription), the handler logs a warning and skips the tier
   * change — the subscription mirror still gets written.
   */
  priceToTier: Record<string, AccountTier>;
  /**
   * What tier the account drops to when a subscription is canceled
   * (status='canceled' / event 'customer.subscription.deleted').
   * Default 'free' (loses paid-tier privileges, lands on the perpetual
   * free tier).
   */
  cancelDowngradeTier?: AccountTier;
  /**
   * Stripe price id → how often it bills. Built beside `priceToTier` from the
   * same configuration. A price absent from it (a custom contract) records no
   * interval. Optional: absent means no price is known to bill by any interval.
   */
  priceToInterval?: Record<string, BillingInterval>;
  /**
   * Reads one invoice from Stripe. Used only when a paid-invoice event names no
   * subscription line this server can read: the same invoice, fetched at the
   * API version this server pins, may. Optional — without it such an invoice is
   * recorded with no period and the alert below fires.
   */
  invoiceFetcher?: {
    getInvoice(invoiceId: string): Promise<Record<string, unknown>>;
    /** S17 — the charge a dispute names, read for the invoice it paid when the event does not say. */
    getCharge?(chargeId: string): Promise<Record<string, unknown>>;
  };
  /** Where the "paid invoice tied to no period" alert goes. Optional. */
  sentry?: Pick<SentryClient, 'captureMessage'>;
  /**
   * Grants monthly AI credits from paid coverage. Null or absent while AI
   * credits are switched off, and then no event does anything more than it did.
   */
  creditsRefresher?: CreditsRefresher | null;
  /**
   * S17 — takes credits back when a payment is refunded or disputed, and puts
   * them back when a dispute is won. Null or absent while AI credits are off,
   * and then those events are logged and nothing more.
   */
  creditClawbacks?: CreditClawbacks | null;
  /**
   * S17 re-audit #14 — the clock a reversal's age is judged on (a reversal
   * naming an invoice not on record is retried for two days, then kept for
   * review). Injectable for tests; the wall clock otherwise.
   */
  now?: () => Date;
  /**
   * Live-billing audit #4 — cancels a subscription at once (the Stripe billing
   * provider's `cancelSubscriptionNow`). Used when a customer's NEW plan
   * subscription starts collecting while an older one still is: the older one is
   * cancelled so the customer is not billed twice. Absent or null: nothing can be
   * cancelled, so that case is logged and alerted as not cancelled.
   *
   * Security sweep #11 — `prorate` is decided per subscription: `false` for one
   * that is past_due (its current period was never paid, so there is no unused
   * paid time to credit), `true` for one that is paid up.
   */
  subscriptionCanceller?: {
    cancelSubscriptionNow(args: { subscriptionId: string; prorate: boolean }): Promise<void>;
  } | null;
}

export class StripeWebhooksService {
  constructor(
    private readonly repo: StripeWebhooksRepo,
    private readonly config: StripeWebhooksServiceConfig,
    /**
     * V-226 / V-202b — optional account-lifecycle dispatcher. When wired,
     * Stripe handler points emit lifecycle events
     * (`subscription.tier_changed`)
     * which fan out into audit log + transactional email at one call
     * site. V-226 originally did the audit emit directly here; V-202b
     * relocated the emit into `AccountLifecycleService.handleTierChanged`
     * per founder verdict (single abstraction for paired audit+email
     * outputs). Best-effort; failures never block the Stripe handler.
     */
    private readonly accountLifecycle: AccountLifecycleService | null = null,
    /**
     * Auth-cache handle so a Stripe-driven tier change invalidates the
     * account's cached AccountContext immediately (mirrors
     * AdminAccountsService.changeTier). Without it the cached tier — and
     * its derived rate-limit capacity — would lag the CACHE_TTL_SEC (30s)
     * window after a subscription upgrade/downgrade/cancel. Optional +
     * best-effort: a cache failure never blocks the Stripe handler.
     */
    private readonly authCache: AuthCache | null = null,
  ) {}

  /**
   * Invalidate the account's auth-cache entry so a tier change takes effect
   * on the very next authenticated request rather than lagging the 30s cache
   * TTL. Best-effort — mirrors AdminAccountsService.invalidateCache: the tier
   * mutation is already committed and a stale entry TTLs out within
   * CACHE_TTL_SEC as the fallback, so a cache error must never fail the
   * Stripe handler.
   */
  private async invalidateAuthCache(accountId: string): Promise<void> {
    if (this.authCache === null) return;
    try {
      await this.authCache.invalidateAccount(accountId);
    } catch {
      // Swallow — see method doc.
    }
  }

  /**
   * Refresh the account's monthly AI credits after an event that may have
   * changed what it has paid for. Nothing while AI credits are off.
   *
   * ⛔ CALLED LAST, after the handler's own writes and emails. A transient
   * failure is rethrown: dispatch() lets it through, no ledger row is written,
   * and Stripe redelivers the event — which then repeats nothing, because every
   * step before this one applies once. Any other failure is logged, alerted and
   * swallowed (see `refreshCreditsAfter`): it must not turn a handled event into
   * a failed one, and the coverage sweep retries the account.
   *
   * TWO RACING DELIVERIES GRANT ONCE. dispatch() runs before the idempotency
   * insert, so both deliveries reach here. The refresh takes the account's
   * credit lock, so they run one after the other, and the second finds the
   * first's window over now() and has nothing to grant; behind the lock the
   * database refuses a second window over the same time (an exclusion
   * constraint) and a second funding row for the same lot. Proved as a race in
   * two-refreshes-of-one-account-at-once-grant-the-month-exactly-once.
   */
  private refreshCredits(accountId: string): Promise<void> {
    return refreshCreditsAfter(this.config.creditsRefresher, accountId, {
      trigger: 'stripe_webhook',
      rethrowTransient: true,
      logger: this.config.logger,
      sentry: this.config.sentry ?? null,
    });
  }

  /**
   * Process a verified Stripe event. Idempotent — repeated calls with
   * the same `event.id` return immediately as `'duplicate'`.
   */
  async handle(event: StripeEvent, rawBody: string): Promise<'duplicate' | DispatchOutcome> {
    if (await this.repo.hasEvent(event.id)) {
      this.config.logger.info(
        { component: 'stripe-webhooks', eventId: event.id, eventType: event.type },
        'duplicate Stripe event — short-circuit',
      );
      return 'duplicate';
    }

    const outcome = await this.dispatch(event);
    const payloadHash = createHash('sha256').update(rawBody).digest('hex');

    // Race: a concurrent delivery could insert the same row between our
    // hasEvent check above and this insert. recordEvent's `inserted` flag
    // resolves the race — if false, the other delivery handled it first.
    const { inserted } = await this.repo.recordEvent({
      eventId: event.id,
      eventType: event.type,
      payloadHash,
      result: outcome,
      receivedAt: new Date(),
    });

    if (!inserted) {
      this.config.logger.info(
        { component: 'stripe-webhooks', eventId: event.id },
        'concurrent duplicate — other delivery won the race',
      );
      return 'duplicate';
    }
    return outcome;
  }

  /**
   * Route the event to its handler. Returns `'handled' | 'ignored' |
   * 'error:<short>'`. Errors are split by cause (C5):
   *   - TRANSIENT infra errors (Postgres connectivity/contention, network
   *     timeouts) are RE-THROWN — no ledger row is written (recordEvent runs
   *     after dispatch), the route returns non-2xx, and Stripe re-delivers
   *     within its ~3-day window. Re-processing is idempotent (recency-guarded
   *     upserts, FOR UPDATE tier writers, lifecycle no-op guard), so the retry
   *     cleanly heals a paying customer left un-upgraded by a one-second blip.
   *   - PERMANENT errors are swallowed and surfaced as the `error:` outcome —
   *     the ledger row is written and Stripe gets a 200, because retrying a
   *     deterministic code bug won't help and would risk a multi-day retry
   *     storm / Stripe disabling the endpoint.
   */
  private async dispatch(event: StripeEvent): Promise<DispatchOutcome> {
    try {
      switch (event.type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
          return await this.handleSubscriptionUpsert(event);
        case 'customer.subscription.deleted':
          return await this.handleSubscriptionDeleted(event);
        case 'checkout.session.completed':
          return await this.handleCheckoutCompleted(event);
        case 'invoice.payment_succeeded':
          // S44 2026-07-07 (founder-approved) — Driftstack-branded
          // billing receipt, the TD-001 revival. The original V-202b
          // decision (founder verdict 2026-05-05) deferred this wire-in
          // in favour of Stripe's own receipts; S44 lands it via the
          // lifecycle dispatcher (augment posture — Stripe's processor
          // receipt settings are untouched). The receipt honors the
          // V-204 `billing-receipt` opt-out; dedup rides the
          // processed_stripe_events ledger (duplicate event.id
          // short-circuits in handle() before dispatch).
          await this.handleInvoicePaymentSucceeded(event);
          return 'handled';
        case 'invoice.paid':
          // The sibling of invoice.payment_succeeded: Stripe sends both for a
          // paid invoice, and this one ALSO for an invoice settled outside a
          // card payment. It records the payment and nothing else — the receipt
          // belongs to payment_succeeded alone, because the send-once claim is
          // keyed on the event id and these are two events.
          await this.handleInvoicePaid(event);
          return 'handled';
        case 'invoice.payment_failed':
          // S44 2026-07-07 (founder-approved) — payment-failure notice.
          // NEVER opt-outable (billing-failure is deliberately absent
          // from OptOutableEmailEventSchema); same ledger-backed dedup.
          await this.handleInvoicePaymentFailed(event);
          return 'handled';
        case 'charge.refunded':
          // S17 — a refund takes back the AI credits the payment no longer
          // pays for, measured on the cumulative `amount_refunded` (deliveries
          // repeat and arrive out of order). Logged and nothing more while AI
          // credits are off. A failure is recorded as an `error:` outcome.
          return await this.handleChargeReversal(event, 'refund');
        case 'charge.dispute.created':
        case 'charge.dispute.funds_withdrawn':
          // S17 — a dispute is a reversal of the disputed amount until it is
          // decided; the same clawback as a refund, keyed on the dispute. An
          // inquiry (`warning_*`) takes nothing: no funds have moved. When an
          // inquiry escalates, Stripe withdraws the funds on the SAME dispute
          // (`funds_withdrawn`) — applied exactly as `created` is, and once per
          // dispute id, so a normal dispute's `funds_withdrawn` after its
          // `created` changes nothing (re-audit #9).
          return await this.handleChargeReversal(event, 'dispute');
        case 'charge.dispute.updated':
          // S17 re-audit #9 — an escalated inquiry also arrives as an update
          // whose status is no longer `warning_*`. Applied as `created` is, once
          // per dispute id; any other update (evidence, an inquiry still an
          // inquiry) changes nothing.
          return await this.handleDisputeUpdated(event);
        case 'charge.dispute.closed':
        case 'charge.dispute.funds_reinstated':
          // S17 — a dispute WON puts its credits back (the clawback is
          // reversed, its claim cancelled, the debt it made forgiven, the
          // credits re-granted for the window they came from, the invoice and
          // the level put back). A dispute lost changes nothing: its clawback
          // already stands from `created`. An inquiry closed changes nothing:
          // it took nothing.
          return await this.handleDisputeDecided(event);
        case 'invoice.finalized':
          // Informational only — the S44 receipt fires on
          // payment_succeeded, not at finalization (a finalized-but-
          // unpaid invoice is not a charge).
          this.logEvent(event, 'invoice');
          return 'handled';
        case 'invoice.upcoming':
          // V-327 — Stripe fires `invoice.upcoming` ~7 days before the
          // invoice is generated. Decode amount + currency + customer
          // from the invoice payload, look up the account, and dispatch
          // the renewal_reminder lifecycle event. Email send is
          // opt-out-aware via EmailPreferencesService.
          await this.handleInvoiceUpcoming(event);
          return 'handled';
        case 'customer.created':
        case 'customer.updated':
        case 'customer.deleted':
        case 'payment_method.attached':
        case 'payment_method.detached':
          this.logEvent(event, event.type);
          return 'handled';
        default:
          this.config.logger.info(
            { component: 'stripe-webhooks', eventId: event.id, eventType: event.type },
            'ignored Stripe event type',
          );
          return 'ignored';
      }
    } catch (err) {
      // S17 — a refund or dispute that arrived before `invoice.paid` recorded
      // its payment must NOT be recorded as processed either: Stripe's
      // redelivery, once the payment is on record, is what applies it (audit
      // #8). Rethrown exactly like a transient failure below.
      if (isCreditReversalAwaitingPayment(err)) {
        this.config.logger.warn(
          { component: 'stripe-webhooks', eventId: event.id, eventType: event.type },
          'a reversal arrived before its payment was recorded — rethrowing so Stripe redelivers it',
        );
        throw err;
      }
      // C5 — a transient infra failure must NOT be recorded as processed:
      // rethrow so handle() never writes a ledger row and Stripe retries.
      if (isTransientInfraError(err)) {
        this.config.logger.warn(
          {
            component: 'stripe-webhooks',
            eventId: event.id,
            eventType: event.type,
            err: err instanceof Error ? { name: err.name, message: err.message } : { value: err },
          },
          'transient infra error handling Stripe event — rethrowing so Stripe retries',
        );
        throw err;
      }
      const code = err instanceof Error ? err.name.toLowerCase() : 'unknown';
      this.config.logger.error(
        {
          component: 'stripe-webhooks',
          eventId: event.id,
          eventType: event.type,
          err:
            err instanceof Error
              ? { name: err.name, message: err.message, stack: err.stack, cause: err.cause }
              : { value: err },
        },
        'Stripe event handler threw',
      );
      return `error:${code}`;
    }
  }

  // ── handlers ────────────────────────────────────────────────────────

  private async handleSubscriptionUpsert(event: StripeEvent): Promise<DispatchOutcome> {
    const sub = event.data.object;
    const stripeSubscriptionId = readString(sub, 'id');
    const stripeCustomerId = readString(sub, 'customer');
    const status = readString(sub, 'status');
    const cancelAtPeriodEnd = readBool(sub, 'cancel_at_period_end');
    // Live-billing audit #13 — in either payload shape, as the start is read.
    const currentPeriodEnd = readSubscriptionPeriodEnd(sub);
    const canceledAt = readUnixTimestamp(sub, 'canceled_at');

    if (stripeSubscriptionId === null || stripeCustomerId === null || status === null) {
      this.config.logger.warn(
        { component: 'stripe-webhooks', eventId: event.id, eventType: event.type },
        'subscription event missing required fields',
      );
      return 'ignored';
    }

    const priceId = readSubscriptionPriceId(sub);
    if (priceId === null) {
      this.config.logger.warn(
        { component: 'stripe-webhooks', eventId: event.id, stripeSubscriptionId },
        'subscription has no resolvable price id; skipping tier update',
      );
      return 'ignored';
    }

    const accountId = await this.repo.findAccountIdFromCustomerOrRef({
      stripeCustomerId,
      clientReferenceId: null,
    });
    if (accountId === null) {
      this.config.logger.warn(
        { component: 'stripe-webhooks', eventId: event.id, stripeCustomerId },
        'subscription event references unknown customer; ignoring',
      );
      return 'ignored';
    }

    const mappedTier = this.config.priceToTier[priceId];
    // The stored row, read BEFORE this event's upsert overwrites it (#11, #4).
    const stored = await this.repo.findSubscription(stripeSubscriptionId);
    // Live-billing audit #11 — a price the configuration no longer names (a
    // grandfathered subscriber after the price ids changed) keeps the plan the
    // mirror already holds for THIS subscription. It used to grant nothing and
    // store the account's current tier as filler, so a subscriber downgraded by a
    // failed payment was left on free for good after paying. A subscription the
    // mirror has never seen (or one stored against another account) still gets
    // the V-742 filler below and no grant.
    const storedTier =
      mappedTier === undefined && stored !== null && stored.accountId === accountId
        ? stored.tier
        : undefined;
    const tier = mappedTier ?? storedTier;
    // V-742 — when the price is unmapped the mirror row still needs a tier to
    // satisfy the NOT NULL column, and that filler used to be 'enterprise'. It
    // was inert when written (the grant on this event is gated on
    // `tier !== undefined`) and became load-bearing once the rank-aware recompute
    // started reading `subscriptions.tier` back out: tierActivationRank derives
    // from TIER_MONTHLY_PRICE_CENTS, which has no enterprise entry, so it falls
    // to POSITIVE_INFINITY and the placeholder outranks every real tier
    // unconditionally. setAccountTierToBestActive would then write
    // accounts.tier = 'enterprise' — 32 concurrent fleet browsers against
    // api_starter's 2, unlimited session minutes, and profile-storage-quota
    // clamps enterprise to 'soft' so the launch gate's hard block never fires at
    // all. Nothing recomputes accounts.tier from Stripe truth afterwards.
    //
    // The filler is now the account's CURRENT tier, which makes this log line
    // literally true: it cannot move the account in either direction, through the
    // max-rank path OR through downgradeAccountTierToBestRemaining (which takes
    // the most-recently-updated remaining row, not the highest-ranked — so a
    // 'free' filler would have been unsafe there in the opposite direction).
    const unmappedFillerTier =
      tier === undefined ? await this.repo.getAccountTier(accountId) : null;
    if (tier === undefined) {
      this.config.logger.warn(
        { component: 'stripe-webhooks', eventId: event.id, priceId },
        'subscription price id not in priceToTier map; mirror written without tier change',
      );
    } else if (mappedTier === undefined) {
      this.config.logger.warn(
        { component: 'stripe-webhooks', eventId: event.id, priceId, stripeSubscriptionId },
        'subscription price id not in priceToTier map; the subscription keeps the plan its mirror row holds',
      );
    }

    // Use the EVENT time (event.created) — not the processing time — as
    // the recency signal so the upsert can reject a stale / out-of-order
    // re-delivery (Stripe gives no ordering guarantee and retries for 3
    // days). Falls back to processing time when `created` is absent (rare)
    // so behaviour never regresses below the prior blind-write.
    const at = eventTime(event);
    const { applied } = await this.repo.upsertSubscription({
      accountId,
      stripeSubscriptionId,
      stripePriceId: priceId,
      tier: tier ?? unmappedFillerTier ?? 'free',
      status: stripeStatusToLocal(status),
      currentPeriodEnd,
      cancelAtPeriodEnd,
      canceledAt,
      at,
      currentPeriodStart: this.readPeriodStart(event, sub, currentPeriodEnd),
      billingInterval: this.intervalOf(priceId),
    });

    // A stale event (an older one processed after a newer one) is skipped
    // by the recency guard — it neither rewrote the mirror nor may it
    // touch the account tier (which would revert the customer to the stale
    // tier until the next in-order event). Ack as handled (idempotent, no
    // Stripe retry) but mutate nothing further.
    if (!applied) {
      this.logEvent(event, `subscription ${status} (stale event — skipped)`);
      return 'handled';
    }

    // Live-billing audit #4 — a NEW plan subscription that has just started
    // collecting replaces any older one the account still pays: re-checkout is
    // allowed while a subscription is past_due, and when the old card recovered
    // both billed. "New" is this event being the subscription's FIRST move into
    // active/trialing — its `created` event, or the update that completes the
    // first payment of one Checkout created as incomplete — so a redelivery, or
    // any later event of the same subscription, reads the stored row as already
    // collecting and does nothing. It runs straight after the upsert, before any
    // step that could fail and send Stripe round again (a retry would not see the
    // first move a second time), and it never throws: what it could not do is
    // logged and alerted. Only a subscription on a configured plan price replaces
    // anything, so a custom subscription made by hand in Stripe cancels nothing.
    if (
      (status === 'active' || status === 'trialing') &&
      mappedTier !== undefined &&
      (stored === null || stored.status === 'incomplete')
    ) {
      await this.cancelReplacedSubscriptions(event, accountId, stripeSubscriptionId);
    }

    // Tier change only when the subscription is in an active-paying
    // state. Trialing counts as active for our purposes (the customer
    // gets the tier; Stripe handles the dunning). `tier` is the configured
    // plan of the price, or — for a price the configuration no longer names —
    // the plan the mirror row held (live-billing audit #11).
    if (tier !== undefined && (status === 'active' || status === 'trialing')) {
      // Fable last-hours audit 2026-07-07 (C4) — set the account to its BEST
      // active/trialing entitlement, not blindly this event's tier. The sub
      // was already mirrored active by the upsert above, so the reconcile sees
      // it; for a single-active-subscription account best-active === this
      // event's tier (behaviour identical to the prior setAccountTier), and for
      // a multi-active account a routine update on a lower sub no longer
      // downgrades a paying higher-tier customer.
      const { previousTier, appliedTier } = await this.repo.setAccountTierToBestActive({
        accountId,
        at,
      });
      // Invalidate the cached AccountContext only on a real tier change
      // (same condition as the audit emit below) so a no-op subscription
      // update — e.g. a payment-method swap that re-sets the same tier —
      // doesn't needlessly evict the cache.
      if (appliedTier !== null && previousTier !== appliedTier) {
        await this.invalidateAuthCache(accountId);
      }
      // V-202b — lifecycle dispatcher fans this out into audit emit +
      // tier-changed email at one call site. Short-circuits internally
      // when previousTier === newTier (no-op transition).
      if (this.accountLifecycle !== null && appliedTier !== null && previousTier !== appliedTier) {
        await this.accountLifecycle.emit(accountId, {
          kind: 'subscription.tier_changed',
          fromTier: previousTier,
          toTier: appliedTier,
          effectiveAt: at,
          stripeEventType: event.type,
          stripeEventId: event.id,
        });
      }
    } else if (status === 'past_due' || status === 'unpaid' || status === 'paused') {
      // C7 — `paused` (a trial that ended with no payment method attached,
      // trial_settings end_behavior='pause') is downgraded alongside the
      // dunning states: the customer has never paid and Stripe will never
      // bill the paused sub, so it must not retain the trial-granted tier
      // (an unbounded entitlement leak — paused subs persist indefinitely).
      // Resuming emits status='active' and the branch above re-upgrades.
      // pause_collection on a genuinely-paying sub keeps status='active' and
      // is unaffected. downgradeAccountTierToBestRemaining excludes 'paused'
      // from the remaining-active set, so the just-mirrored paused sub can't
      // re-select itself and an account holding another active sub keeps it.
      //
      // Dunning: Stripe keeps the subscription object alive (no
      // `customer.subscription.deleted` fires while it merely cycles
      // through past_due, and Stripe's "mark unpaid" dunning policy
      // leaves it parked at `unpaid` forever) but payment has stopped
      // succeeding. Recompute using the SAME target + mechanism as an
      // explicit cancellation (handleSubscriptionDeleted below). The
      // subscription MIRROR already recorded the real status (past_due/unpaid,
      // not 'canceled') via the upsertSubscription call above, so the
      // distinction from a true cancel survives in the DB; if Stripe's
      // retry later succeeds, the event arrives as status === 'active'
      // and the branch above naturally re-upgrades on the next in-order
      // event — no separate recovery path needed.
      //
      // Live-billing audit #3 — `past_due` no longer downgrades AT ONCE. The
      // recompute counts a past_due subscription as still granting its plan for
      // PAST_DUE_GRACE_DAYS from when the spell began (ToS 8.5: at least seven
      // days' written notice — the payment-failure email — before a suspension
      // for non-payment), so this call leaves the paid plan in place. Once the
      // grace is over, a later event lands here and takes it away, and the
      // past-due sweep does so when no event comes. `unpaid` and `paused` still
      // downgrade at once, as `deleted` does.
      const downgradeTier = this.config.cancelDowngradeTier ?? 'free';
      // Recompute from the account's remaining active subscriptions (and a
      // past_due one inside its grace) — a past_due on a SUPERSEDED
      // subscription must not downgrade an account that still holds another
      // active subscription (an account can hold multiple subscription rows;
      // re-checkout is allowed while past_due).
      const { previousTier, appliedTier } = await this.repo.downgradeAccountTierToBestRemaining({
        accountId,
        fallbackTier: downgradeTier,
        at,
      });
      if (previousTier !== appliedTier) await this.invalidateAuthCache(accountId);
      if (this.accountLifecycle !== null && previousTier !== appliedTier) {
        await this.accountLifecycle.emit(accountId, {
          kind: 'subscription.tier_changed',
          fromTier: previousTier,
          toTier: appliedTier,
          effectiveAt: at,
          stripeEventType: event.type,
          stripeEventId: event.id,
        });
      }
    }

    this.logEvent(event, `subscription ${status}`);
    await this.refreshCredits(accountId);
    return 'handled';
  }

  private async handleSubscriptionDeleted(event: StripeEvent): Promise<DispatchOutcome> {
    const sub = event.data.object;
    const stripeSubscriptionId = readString(sub, 'id');
    const stripeCustomerId = readString(sub, 'customer');
    if (stripeSubscriptionId === null || stripeCustomerId === null) return 'ignored';

    const accountId = await this.repo.findAccountIdFromCustomerOrRef({
      stripeCustomerId,
      clientReferenceId: null,
    });
    if (accountId === null) return 'ignored';

    // Event time (event.created) drives the recency guard so a stale
    // re-delivered cancel can't clobber a fresher mirror / re-downgrade an
    // account that has since been re-subscribed by a newer event.
    const at = eventTime(event);
    const priceId = readSubscriptionPriceId(sub);
    const mappedCancelTier = priceId !== null ? this.config.priceToTier[priceId] : undefined;
    const cancelFillerTier =
      mappedCancelTier === undefined
        ? ((await this.repo.getAccountTier(accountId)) ?? 'free')
        : 'free';
    // Live-billing audit #13 — in either payload shape, as the start is read.
    const canceledPeriodEnd = readSubscriptionPeriodEnd(sub);
    const { applied } = await this.repo.upsertSubscription({
      accountId,
      stripeSubscriptionId,
      stripePriceId: priceId ?? '',
      // V-742 — same filler rule as the upsert path above: never 'enterprise',
      // which outranks every real tier in tierActivationRank and would be read
      // back out by the tier recompute as a genuine entitlement.
      tier: mappedCancelTier ?? cancelFillerTier,
      status: 'canceled',
      currentPeriodEnd: canceledPeriodEnd,
      cancelAtPeriodEnd: false,
      canceledAt: at,
      at,
      currentPeriodStart: this.readPeriodStart(event, sub, canceledPeriodEnd),
      billingInterval: this.intervalOf(priceId),
    });
    // Stale cancel (a newer event already moved the row past this one) —
    // skip the downgrade so the customer keeps the tier the latest event
    // granted. Ack handled; mutate nothing further.
    if (!applied) {
      this.logEvent(event, 'subscription canceled (stale event — skipped)');
      return 'handled';
    }
    const downgradeTier = this.config.cancelDowngradeTier ?? 'free';
    // Recompute from the account's remaining active subscriptions — a cancel of
    // a SUPERSEDED subscription must not downgrade an account that still holds
    // another active subscription (the recency guard above is per-subscription-
    // row, not per-account, so it doesn't catch a stale sub's cancel landing
    // after a newer sub is active).
    const { previousTier, appliedTier } = await this.repo.downgradeAccountTierToBestRemaining({
      accountId,
      fallbackTier: downgradeTier,
      at,
    });
    // Invalidate on a real tier change only — same condition as the emit below.
    if (previousTier !== appliedTier) await this.invalidateAuthCache(accountId);
    if (this.accountLifecycle !== null && previousTier !== appliedTier) {
      await this.accountLifecycle.emit(accountId, {
        kind: 'subscription.tier_changed',
        fromTier: previousTier,
        toTier: appliedTier,
        effectiveAt: at,
        stripeEventType: event.type,
        stripeEventId: event.id,
      });
    }

    this.logEvent(event, 'subscription canceled');
    return 'handled';
  }

  /**
   * V-327 — `invoice.upcoming` handler. Decodes the invoice, resolves
   * the customer to a local account, and dispatches the renewal_
   * reminder lifecycle event. Bails silently on missing fields /
   * unknown customer (Stripe dashboard may fire test events for
   * customers we don't have).
   */
  private async handleInvoiceUpcoming(event: StripeEvent): Promise<void> {
    const invoice = event.data.object;
    const stripeCustomerId = readString(invoice, 'customer');
    const amountDue = readNumber(invoice, 'amount_due');
    const currency = readString(invoice, 'currency');
    const renewalUnix = readUnixTimestamp(invoice, 'next_payment_attempt');
    const stripeInvoiceId = readString(invoice, 'id');

    if (
      stripeCustomerId === null ||
      amountDue === null ||
      currency === null ||
      renewalUnix === null ||
      stripeInvoiceId === null
    ) {
      this.config.logger.warn(
        { component: 'stripe-webhooks', eventId: event.id },
        'invoice.upcoming missing required fields; skipping renewal reminder',
      );
      this.logEvent(event, 'invoice.upcoming (missing-fields)');
      return;
    }

    const accountId = await this.repo.findAccountIdFromCustomerOrRef({
      stripeCustomerId,
      clientReferenceId: null,
    });
    if (accountId === null) {
      this.config.logger.warn(
        { component: 'stripe-webhooks', eventId: event.id, stripeCustomerId },
        'invoice.upcoming references unknown customer; ignoring',
      );
      this.logEvent(event, 'invoice.upcoming (unknown-customer)');
      return;
    }

    if (this.accountLifecycle !== null) {
      await this.accountLifecycle.emit(accountId, {
        kind: 'subscription.renewal_reminder',
        amountCents: amountDue,
        currency,
        renewalDate: renewalUnix,
        stripeEventId: event.id,
        stripeInvoiceId,
      });
    }

    this.logEvent(event, 'invoice.upcoming → renewal_reminder dispatched');
  }

  /**
   * S44 2026-07-07 (founder-approved) — `invoice.payment_succeeded`
   * handler. Decodes the paid invoice, resolves the customer to a
   * local account, and dispatches the `billing.payment_succeeded`
   * lifecycle event (→ billing-receipt email, V-204 opt-out-aware).
   * Bails silently on missing fields / unknown customer, mirroring
   * handleInvoiceUpcoming. Zero-amount invoices (trial starts, 100%
   * discounts) are skipped — a "$0.00 payment was successful" receipt
   * is noise, not a record of a charge.
   */
  private async handleInvoicePaymentSucceeded(event: StripeEvent): Promise<void> {
    const invoice = event.data.object;
    const stripeCustomerId = readString(invoice, 'customer');
    const amountPaid = readNumber(invoice, 'amount_paid');
    const currency = readString(invoice, 'currency');
    const stripeInvoiceId = readString(invoice, 'id');
    // Optional — the lifecycle handler falls back to the portal. (The period is
    // the paid line's, read below with the payment record: live-billing audit #12.)
    const hostedInvoiceUrl = readString(invoice, 'hosted_invoice_url');

    if (
      stripeCustomerId === null ||
      amountPaid === null ||
      currency === null ||
      stripeInvoiceId === null
    ) {
      this.config.logger.warn(
        { component: 'stripe-webhooks', eventId: event.id },
        'invoice.payment_succeeded missing required fields; skipping billing receipt',
      );
      this.logEvent(event, 'invoice.payment_succeeded (missing-fields)');
      return;
    }

    // ⛔ ORDER IS THE GUARANTEE. The paid-invoice row is written HERE: before the
    // zero-amount return (a $0 invoice was paid too) and before the receipt. If
    // the write throws, nothing a customer can see has happened yet; a transient
    // failure is rethrown by dispatch(), no ledger row is written, and Stripe's
    // retry records the payment and sends the receipt, once each. Moving this
    // below the emit would let a receipt go out for a payment that was never
    // recorded, and the retry would then be deduped as already-sent.
    const accountId = await this.repo.findAccountIdFromCustomerOrRef({
      stripeCustomerId,
      clientReferenceId: null,
    });
    const record =
      accountId !== null ? await this.recordPaidInvoice(event, invoice, accountId) : null;
    const recorded = record !== null && record.recorded;

    if (amountPaid === 0) {
      this.logEvent(event, 'invoice.payment_succeeded (zero-amount — no receipt)');
      // A $0 invoice was paid too, and covers its period like any other.
      if (accountId !== null && recorded) await this.refreshCredits(accountId);
      return;
    }

    if (accountId === null) {
      this.config.logger.warn(
        { component: 'stripe-webhooks', eventId: event.id, stripeCustomerId },
        'invoice.payment_succeeded references unknown customer; ignoring',
      );
      this.logEvent(event, 'invoice.payment_succeeded (unknown-customer)');
      return;
    }

    // Live-billing audit #12 — the receipt names the period the PAID LINE covers
    // (the same line, in either payload shape, the payment record was written
    // from — fetched again from Stripe when the payload named none). It used to
    // name the invoice's own top-level period, which on a renewal is the period
    // that just ENDED ("for February" on March's payment) and on a first invoice
    // is zero-length. With no line it falls back to the charge date, as before.
    const paidLine = record?.line ?? null;
    if (this.accountLifecycle !== null) {
      await this.accountLifecycle.emit(accountId, {
        kind: 'billing.payment_succeeded',
        amountCents: amountPaid,
        currency,
        periodStart: paidLine?.periodStart ?? null,
        periodEnd: paidLine?.periodEnd ?? null,
        hostedInvoiceUrl,
        stripeEventId: event.id,
        stripeInvoiceId,
      });
    }

    this.logEvent(event, 'invoice.payment_succeeded → billing receipt dispatched');
    // After the receipt, never before it: see `refreshCredits`.
    if (recorded) await this.refreshCredits(accountId);
  }

  /**
   * `invoice.paid` handler. Records the paid invoice and sends NOTHING: the
   * receipt is `invoice.payment_succeeded`'s alone. Bails on missing fields or
   * an unknown customer, as that handler does.
   */
  private async handleInvoicePaid(event: StripeEvent): Promise<void> {
    const invoice = event.data.object;
    const stripeCustomerId = readString(invoice, 'customer');
    const amountPaid = readNumber(invoice, 'amount_paid');
    const currency = readString(invoice, 'currency');
    const stripeInvoiceId = readString(invoice, 'id');

    if (
      stripeCustomerId === null ||
      amountPaid === null ||
      currency === null ||
      stripeInvoiceId === null
    ) {
      this.config.logger.warn(
        { component: 'stripe-webhooks', eventId: event.id },
        'invoice.paid missing required fields; payment not recorded',
      );
      this.logEvent(event, 'invoice.paid (missing-fields)');
      return;
    }

    const accountId = await this.repo.findAccountIdFromCustomerOrRef({
      stripeCustomerId,
      clientReferenceId: null,
    });
    if (accountId === null) {
      this.config.logger.warn(
        { component: 'stripe-webhooks', eventId: event.id, stripeCustomerId },
        'invoice.paid references unknown customer; ignoring',
      );
      this.logEvent(event, 'invoice.paid (unknown-customer)');
      return;
    }

    // The log line says what happened, not what was meant to: an invoice that was
    // refused (it says it is not paid, its amount is unreadable, it is on record
    // for another account) raises an alert that sends a person to this log, and
    // "payment recorded" beside it would be a lie at the worst possible moment.
    const { recorded } = await this.recordPaidInvoice(event, invoice, accountId);
    this.logEvent(
      event,
      recorded ? 'invoice.paid → payment recorded' : 'invoice.paid (payment not recorded)',
    );
    if (recorded) await this.refreshCredits(accountId);
  }

  /**
   * Write the `billing_invoice_payments` row for a paid invoice. Shared by both
   * paid-invoice events; idempotent on the invoice id, so whichever arrives
   * second (or a Stripe retry) writes nothing twice.
   *
   * The period comes from the invoice's subscription LINE, in either payload
   * shape — never from the invoice's own top-level period. When the payload
   * names no line this server can read, the invoice is fetched once and read
   * again. Still nothing: the payment is recorded with no period, the invoice id
   * is logged at error, and an alert goes out.
   *
   * Throws only what the caller must see: a transient failure (of the write, or
   * of the fetch), which dispatch() rethrows so Stripe retries the whole event.
   * A fetch that fails for any other reason is not a reason to lose the record.
   *
   * Resolves true when the invoice is on record for this account once the call
   * returns (written now, completed, or already there); false when it was
   * refused and nothing was written.
   */
  private async recordPaidInvoice(
    event: StripeEvent,
    invoice: Record<string, unknown>,
    accountId: string,
  ): Promise<RecordedPaidInvoice> {
    const maps = {
      priceToTier: this.config.priceToTier,
      priceToInterval: this.config.priceToInterval ?? {},
    };
    let facts = readPaidInvoice(invoice, maps);
    const { stripeInvoiceId, currency } = facts;
    // Both callers have already required these two; this keeps the types honest.
    if (stripeInvoiceId === null || currency === null) return { recorded: false, line: facts.line };

    // The event's TYPE is this handler's evidence that the invoice was paid, so a
    // payload with no status is recorded. One whose own invoice says 'open',
    // 'void', … contradicts its event: nothing is recorded (a row here is what
    // credits are granted from, and a $0 one counts as covered), and a person is
    // told. Checked before Stripe is asked anything about it.
    if (invoiceSaysItIsNotPaid(facts)) {
      this.alertUnlinkableInvoice(event, stripeInvoiceId, 'not_paid');
      return { recorded: false, line: facts.line };
    }

    const amountPaidMinor = facts.amountPaidMinor;
    if (amountPaidMinor === null) {
      this.alertUnlinkableInvoice(event, stripeInvoiceId, 'invalid_amount');
      return { recorded: false, line: facts.line };
    }

    if (facts.line === null) {
      facts = await this.readInvoiceAgainFromStripe(event, stripeInvoiceId, facts, maps);
      // A payload that said nothing about its status may have been answered by
      // Stripe: the same contradiction, found one step later, is refused the same way.
      if (invoiceSaysItIsNotPaid(facts)) {
        this.alertUnlinkableInvoice(event, stripeInvoiceId, 'not_paid');
        return { recorded: false, line: facts.line };
      }
    }

    const { outcome, linked } = await this.repo.upsertInvoicePayment({
      stripeInvoiceId,
      accountId,
      stripeSubscriptionId: facts.stripeSubscriptionId,
      billingReason: facts.billingReason,
      amountPaidMinor,
      currency,
      stripePaymentIntentId: facts.stripePaymentIntentId,
      stripeChargeId: facts.stripeChargeId,
      line: facts.line,
      paidAt: facts.paidAt ?? eventTime(event),
    });

    if (outcome === 'account_mismatch') {
      this.alertUnlinkableInvoice(event, stripeInvoiceId, 'account_mismatch');
      return { recorded: false, line: facts.line };
    }
    // `linked` is the STORED row: an earlier sighting may already have tied this
    // invoice to its line, and then there is nothing to raise.
    if (!linked) {
      this.alertUnlinkableInvoice(
        event,
        stripeInvoiceId,
        facts.unlinkedReason ?? 'no_subscription_line',
      );
    } else if (facts.line !== null && facts.line.tier === null) {
      this.config.logger.warn(
        { component: 'stripe-webhooks', eventId: event.id, stripeInvoiceId },
        'paid invoice line price not in priceToTier map; recorded without a plan',
      );
    }
    return { recorded: true, line: facts.line };
  }

  private async readInvoiceAgainFromStripe(
    event: StripeEvent,
    stripeInvoiceId: string,
    facts: PaidInvoiceFacts,
    maps: Parameters<typeof readPaidInvoice>[1],
  ): Promise<PaidInvoiceFacts> {
    const fetcher = this.config.invoiceFetcher;
    if (fetcher === undefined) return facts;
    try {
      const again = readPaidInvoice(await fetcher.getInvoice(stripeInvoiceId), maps);
      if (again.stripeInvoiceId !== stripeInvoiceId) return facts;
      return {
        ...facts,
        stripeSubscriptionId: facts.stripeSubscriptionId ?? again.stripeSubscriptionId,
        billingReason: facts.billingReason ?? again.billingReason,
        status: facts.status ?? again.status,
        stripePaymentIntentId: facts.stripePaymentIntentId ?? again.stripePaymentIntentId,
        stripeChargeId: facts.stripeChargeId ?? again.stripeChargeId,
        paidAt: facts.paidAt ?? again.paidAt,
        line: again.line,
        unlinkedReason: again.unlinkedReason,
      };
    } catch (err) {
      if (isTransientInfraError(err)) throw err;
      this.config.logger.warn(
        {
          component: 'stripe-webhooks',
          eventId: event.id,
          stripeInvoiceId,
          err: err instanceof Error ? { name: err.name } : { value: 'non-error' },
        },
        'could not read the invoice from Stripe; recording it as delivered',
      );
      return facts;
    }
  }

  /** The error log carries the invoice id; the alert carries no identifier at all. */
  private alertUnlinkableInvoice(
    event: StripeEvent,
    stripeInvoiceId: string,
    reason: UnlinkableInvoiceReason,
  ): void {
    this.config.logger.error(
      { component: 'stripe-webhooks', eventId: event.id, stripeInvoiceId, reason },
      'paid invoice is tied to no billing period',
    );
    reportUnlinkableInvoice(this.config.sentry, { reason, source: 'webhook' });
  }

  /**
   * The subscription's period start, in either payload shape. A start that is
   * not before the period's end is dropped rather than stored: the database
   * refuses that pair, and a refused mirror write would take the tier update of
   * the same event down with it.
   */
  private readPeriodStart(
    event: StripeEvent,
    subscription: Record<string, unknown>,
    currentPeriodEnd: Date | null,
  ): Date | null {
    const start = readSubscriptionPeriodStart(subscription);
    if (start === null || currentPeriodEnd === null) return start;
    if (start.getTime() < currentPeriodEnd.getTime()) return start;
    this.config.logger.warn(
      { component: 'stripe-webhooks', eventId: event.id },
      'subscription period start is not before its end; start not stored',
    );
    return null;
  }

  private intervalOf(priceId: string | null): BillingInterval | null {
    const map = this.config.priceToInterval;
    if (priceId === null || map === undefined || !Object.hasOwn(map, priceId)) return null;
    return map[priceId] ?? null;
  }

  /**
   * S44 2026-07-07 (founder-approved) — `invoice.payment_failed`
   * handler. Dispatches the `billing.payment_failed` lifecycle event
   * (→ billing-failure email, sent unconditionally to the account
   * email — the template is critical-path and not opt-outable).
   * `next_payment_attempt` is legitimately null on the final dunning
   * attempt; the email copy adapts (see email.ts retryLine).
   */
  private async handleInvoicePaymentFailed(event: StripeEvent): Promise<void> {
    const invoice = event.data.object;
    const stripeCustomerId = readString(invoice, 'customer');
    const amountDue = readNumber(invoice, 'amount_due');
    const currency = readString(invoice, 'currency');
    const stripeInvoiceId = readString(invoice, 'id');
    const retryAt = readUnixTimestamp(invoice, 'next_payment_attempt');

    if (
      stripeCustomerId === null ||
      amountDue === null ||
      currency === null ||
      stripeInvoiceId === null
    ) {
      this.config.logger.warn(
        { component: 'stripe-webhooks', eventId: event.id },
        'invoice.payment_failed missing required fields; skipping billing-failure notice',
      );
      this.logEvent(event, 'invoice.payment_failed (missing-fields)');
      return;
    }

    const accountId = await this.repo.findAccountIdFromCustomerOrRef({
      stripeCustomerId,
      clientReferenceId: null,
    });
    if (accountId === null) {
      this.config.logger.warn(
        { component: 'stripe-webhooks', eventId: event.id, stripeCustomerId },
        'invoice.payment_failed references unknown customer; ignoring',
      );
      this.logEvent(event, 'invoice.payment_failed (unknown-customer)');
      return;
    }

    if (this.accountLifecycle !== null) {
      // Live-billing audit #3 — the notice says until when the paid plan stays
      // (the grace ToS 8.5 promises), or when it ended if the grace is over.
      const accessEndsAt = await this.accessEndsAfterFailedPayment(event, invoice, accountId);
      await this.accountLifecycle.emit(accountId, {
        kind: 'billing.payment_failed',
        amountCents: amountDue,
        currency,
        retryAt,
        stripeEventId: event.id,
        stripeInvoiceId,
        ...(accessEndsAt !== null ? { accessEndsAt } : {}),
      });
    }

    this.logEvent(event, 'invoice.payment_failed → billing-failure notice dispatched');
  }

  /**
   * Live-billing audit #3 — when the paid plan of the subscription whose payment
   * just failed stops, for the payment-failure notice to say: PAST_DUE_GRACE_DAYS
   * after its past_due spell began. That spell's start is on the mirror once the
   * subscription's own past_due event has been processed; the invoice event and
   * that one arrive in the same second in either order, so a subscription still
   * mirrored as active or trialing is about to go past_due at this event's time.
   *
   * Null — and the notice says nothing about it — when the invoice belongs to no
   * subscription, the mirror has no row for it (or has it against another
   * account), or the subscription is in no grace: a first payment (incomplete),
   * one already ended (unpaid, canceled, paused), or a spell that began before
   * migration 0141 recorded starts. A failed read never costs the notice: a
   * transient one is rethrown before anything is sent (Stripe redelivers), any
   * other is logged and the notice goes without the date.
   */
  private async accessEndsAfterFailedPayment(
    event: StripeEvent,
    invoice: Record<string, unknown>,
    accountId: string,
  ): Promise<Date | null> {
    const stripeSubscriptionId = readInvoiceSubscriptionId(invoice);
    if (stripeSubscriptionId === null) return null;
    let sub: StoredSubscription | null;
    try {
      sub = await this.repo.findSubscription(stripeSubscriptionId);
    } catch (err) {
      if (isTransientInfraError(err)) throw err;
      this.config.logger.warn(
        {
          component: 'stripe-webhooks',
          eventId: event.id,
          stripeSubscriptionId,
          err: err instanceof Error ? { name: err.name, message: err.message } : { value: err },
        },
        'could not read the subscription for the payment-failure notice; it goes without an end date',
      );
      return null;
    }
    if (sub === null || sub.accountId !== accountId) return null;
    if (sub.status === 'past_due') {
      return sub.pastDueSince === null
        ? null
        : new Date(sub.pastDueSince.getTime() + PAST_DUE_GRACE_MS);
    }
    if (sub.status === 'active' || sub.status === 'trialing') {
      return new Date(eventTime(event).getTime() + PAST_DUE_GRACE_MS);
    }
    return null;
  }

  /**
   * Live-billing audit #4 — the account's NEW plan subscription `newSubscriptionId`
   * has just started collecting: cancel every OLDER subscription the account still
   * collects on (active, trialing or past_due), at once, so the customer is not
   * billed twice. A paid-up one is cancelled prorated (its unused paid time is
   * credited); a past_due one WITHOUT proration (security sweep #11) — its current
   * period was never paid, and prorating it credited that unpaid period. Never the new one, and never one the mirror saw
   * after it — that one is the newer purchase, so it is left alone and staff are
   * told (two checkouts whose events arrived out of order).
   *
   * NEVER THROWS. The caller runs it once, on the subscription's first move into
   * collecting; a retry would not run it again, so rethrowing would lose it rather
   * than retry it. A cancel Stripe refuses, a canceller that is not configured, or
   * a read that fails is logged with the ids and alerted without them; a cancel
   * that went through is alerted too, so staff can decide whether a refund is
   * owed for the older subscription.
   */
  private async cancelReplacedSubscriptions(
    event: StripeEvent,
    accountId: string,
    newSubscriptionId: string,
  ): Promise<void> {
    const cancelled: string[] = [];
    /** The subset of `cancelled` that was past due, so cancelled without proration. */
    const cancelledUnpaid: string[] = [];
    const notCancelled: string[] = [];
    try {
      const collecting = await this.repo.listCollectingSubscriptions(accountId);
      const self = collecting.find((s) => s.stripeSubscriptionId === newSubscriptionId);
      if (self === undefined) return;
      const others = collecting.filter((s) => s.stripeSubscriptionId !== newSubscriptionId);
      if (others.length === 0) return;
      const older = others.filter((s) => s.createdAt.getTime() < self.createdAt.getTime());
      const newer = others.filter((s) => s.createdAt.getTime() >= self.createdAt.getTime());
      if (newer.length > 0) {
        this.config.logger.warn(
          {
            component: 'stripe-webhooks',
            eventId: event.id,
            accountId,
            stripeSubscriptionId: newSubscriptionId,
            kept: newer.map((s) => s.stripeSubscriptionId),
          },
          'a new plan subscription started collecting beside one the mirror saw no earlier; neither was cancelled',
        );
        this.alertBilling(
          'duplicate_subscription_kept',
          'warning',
          'An account holds two plan subscriptions still collecting, and the newer one was ' +
            'not cancelled automatically. Find the account in the server log and cancel the ' +
            'one it should not be billed for in Stripe.',
        );
      }
      const canceller = this.config.subscriptionCanceller ?? null;
      for (const s of older) {
        if (canceller === null) {
          notCancelled.push(s.stripeSubscriptionId);
          continue;
        }
        const unpaid = s.status === 'past_due';
        try {
          await canceller.cancelSubscriptionNow({
            subscriptionId: s.stripeSubscriptionId,
            prorate: !unpaid,
          });
          cancelled.push(s.stripeSubscriptionId);
          if (unpaid) cancelledUnpaid.push(s.stripeSubscriptionId);
        } catch (err) {
          notCancelled.push(s.stripeSubscriptionId);
          this.config.logger.error(
            {
              component: 'stripe-webhooks',
              eventId: event.id,
              accountId,
              stripeSubscriptionId: s.stripeSubscriptionId,
              err: err instanceof Error ? { name: err.name, message: err.message } : { value: err },
            },
            'Stripe refused to cancel a subscription a new plan replaced',
          );
        }
      }
    } catch (err) {
      this.config.logger.error(
        {
          component: 'stripe-webhooks',
          eventId: event.id,
          accountId,
          stripeSubscriptionId: newSubscriptionId,
          err: err instanceof Error ? { name: err.name, message: err.message } : { value: err },
        },
        'could not check for a subscription a new plan replaced',
      );
      this.alertBilling(
        'replaced_subscription_not_checked',
        'error',
        'A customer started a new plan subscription and it could not be checked whether an ' +
          'older one is still billing them. Find the account in the server log and check it in Stripe.',
      );
      return;
    }
    if (cancelled.length > 0) {
      this.config.logger.warn(
        {
          component: 'stripe-webhooks',
          eventId: event.id,
          accountId,
          stripeSubscriptionId: newSubscriptionId,
          cancelled,
          cancelledWithoutProration: cancelledUnpaid,
        },
        'a new plan subscription replaced older ones still collecting; they were cancelled now (prorated unless past due)',
      );
      const allUnpaid = cancelledUnpaid.length === cancelled.length;
      this.alertBilling(
        'replaced_subscription_cancelled',
        'warning',
        allUnpaid
          ? 'A customer started a new plan subscription while an older one was past due; ' +
              'the older one was cancelled at once without proration, so no credit was given ' +
              'for its unpaid period, and its open invoice was left as it was. Find the account ' +
              'in the server log and decide in Stripe whether that invoice should be voided.'
          : 'A customer started a new plan subscription while an older one was still billing ' +
              'them; the older one was cancelled at once, with the unused time credited in Stripe ' +
              '(a past due one, if any, without proration). Find the account in the server log ' +
              'and check whether a refund is owed.',
      );
    }
    if (notCancelled.length > 0) {
      this.config.logger.error(
        {
          component: 'stripe-webhooks',
          eventId: event.id,
          accountId,
          stripeSubscriptionId: newSubscriptionId,
          notCancelled,
          cancellerConfigured: this.config.subscriptionCanceller != null,
        },
        'a new plan subscription replaced older ones still collecting, and they could NOT be cancelled — the customer may be billed twice',
      );
      this.alertBilling(
        'replaced_subscription_not_cancelled',
        'error',
        'A customer started a new plan subscription while an older one was still billing ' +
          'them, and the older one could not be cancelled, so they may be billed twice. Find ' +
          'the account in the server log and cancel the older subscription in Stripe.',
      );
    }
  }

  /** An id-free billing alert (live-billing audit #4); the log line beside it is the record. */
  private alertBilling(
    kind:
      | 'replaced_subscription_cancelled'
      | 'replaced_subscription_not_cancelled'
      | 'replaced_subscription_not_checked'
      | 'duplicate_subscription_kept',
    level: 'warning' | 'error',
    message: string,
  ): void {
    try {
      this.config.sentry?.captureMessage({
        message,
        level,
        fingerprint: ['billing', kind],
        tags: { kind },
      });
    } catch {
      /* the log line is the record */
    }
  }

  private handleCheckoutCompleted(event: StripeEvent): Promise<DispatchOutcome> {
    const session = event.data.object;
    const mode = readString(session, 'mode');

    // The one-time trial_pack (payment-mode checkout) was retired
    // 2026-05-27 in favour of the perpetual free tier; all checkouts are
    // now subscriptions. Subscription mode is informational here —
    // customer.subscription.created does the actual mirror write — and
    // any other mode is a no-op ack. No await needed; kept Promise-typed
    // so the per-type dispatch switch can uniformly `await` every handler.
    if (mode === 'subscription') {
      this.logEvent(event, 'checkout subscription completed (informational)');
    } else {
      this.logEvent(event, `checkout completed (mode=${mode ?? 'unknown'}, no-op)`);
    }
    return Promise.resolve<DispatchOutcome>('handled');
  }

  /**
   * S17 — a refund (`charge.refunded`, the object is the CHARGE) or a dispute
   * (`charge.dispute.created`, or an escalated inquiry's `funds_withdrawn` /
   * `updated`; the object is the DISPUTE, naming its charge).
   * The invoice the charge paid is read from the object when it says; a
   * dispute object never does, so the recorded payment is found by the charge
   * id first, and the charge is fetched from Stripe only when nothing on record
   * names it.
   *
   *   · An INQUIRY (`warning_*`) takes nothing: no funds have left, and its
   *     close (`warning_closed`) is neither won nor lost (audit #9).
   *   · A reversal whose invoice has no payment on record yet — it arrived
   *     before `invoice.paid` — is rethrown, so the delivery fails and Stripe
   *     redelivers it once the payment is recorded (audit #8); from 48 hours
   *     after Stripe sent it (its `created`), it is recorded as handled and
   *     kept for review instead — logged with the charge, alerted without it
   *     (re-audit #14).
   *   · A transient failure is rethrown so the delivery is retried whole.
   *   · Any other failure is logged with the charge, alerted without it, and
   *     recorded as `error:ai_credits_reversal_failed`, so the processed-events
   *     ledger shows the event failed rather than handled (audit #15).
   */
  private async handleChargeReversal(
    event: StripeEvent,
    what: 'refund' | 'dispute',
  ): Promise<DispatchOutcome> {
    const clawbacks = this.config.creditClawbacks;
    if (clawbacks === null || clawbacks === undefined) {
      this.logEvent(event, `${event.type} (AI credits off; nothing to take back)`);
      return 'handled';
    }
    const object = event.data.object;
    const chargeId = what === 'refund' ? readString(object, 'id') : readString(object, 'charge');
    const amount =
      what === 'refund' ? readNumber(object, 'amount_refunded') : readNumber(object, 'amount');
    const disputeId = what === 'dispute' ? readString(object, 'id') : null;
    if (chargeId === null || amount === null || (what === 'dispute' && disputeId === null)) {
      this.config.logger.warn(
        { component: 'stripe-webhooks', eventId: event.id, eventType: event.type },
        `${event.type} missing required fields; credits not taken back`,
      );
      this.logEvent(event, `${event.type} (missing-fields)`);
      return 'handled';
    }
    const status = readString(object, 'status');
    if (what === 'dispute' && isInquiry(status)) {
      this.logEvent(event, `${event.type} (${status ?? 'inquiry'}; an inquiry takes nothing)`);
      return 'handled';
    }
    let invoiceId = what === 'refund' ? readString(object, 'invoice') : null;
    const apply = (stripeInvoiceId: string | null) =>
      what === 'refund'
        ? clawbacks.applyStripeRefund({
            chargeId,
            stripeInvoiceId,
            cumulativeRefundedMinor: amount,
          })
        : clawbacks.applyStripeDispute({
            disputeId: disputeId ?? '',
            chargeId,
            stripeInvoiceId,
            amountMinor: amount,
          });
    try {
      let outcome = await apply(invoiceId);
      if (outcome.kind === 'unmatched' && invoiceId === null) {
        // Nothing on record names the charge: ask Stripe which invoice it paid,
        // once, and try again with that. A charge with no invoice (a one-off
        // payment) stays unmatched, which is the truth about it.
        invoiceId = await this.invoiceOfCharge(event, chargeId);
        if (invoiceId !== null) outcome = await apply(invoiceId);
      }
      this.logEvent(event, `${event.type} → credits ${outcome.kind}`);
      return 'handled';
    } catch (err) {
      if (isCreditReversalAwaitingPayment(err)) {
        // ⛔ RETRIED FOR TWO DAYS, THEN KEPT FOR REVIEW (re-audit #14). An
        // invoice that will never be recorded — its customer unknown, the
        // invoice refused, or paid before payments were recorded at all —
        // would otherwise fail every delivery until Stripe stopped retrying
        // (about three days) and then vanish with no processed-events row and
        // no alert.
        if (this.reversalIsYoung(event)) throw err;
        return this.keptForReview(event, what, chargeId);
      }
      if (isTransientInfraError(err)) throw err;
      this.config.logger.error(
        {
          component: 'stripe-webhooks',
          eventId: event.id,
          eventType: event.type,
          chargeId,
          err: { message: err instanceof Error ? err.message : String(err) },
        },
        'taking AI credits back for a reversed payment failed; review the charge by hand',
      );
      this.alertCreditsFailure(
        'ai_credits_reversal_failed',
        what,
        'Taking AI credits back for a reversed payment failed. ' +
          'Find the charge id in the server log and review the account by hand.',
      );
      this.logEvent(event, `${event.type} (credits not taken back)`);
      return 'error:ai_credits_reversal_failed';
    }
  }

  /**
   * S17 — `charge.dispute.closed` / `funds_reinstated`: only a WON dispute
   * acts. `funds_reinstated` is always a win; `closed` is one when its status
   * says `won`. `lost` leaves the clawback standing, and `warning_closed` is an
   * inquiry that took nothing (audit #9).
   *
   * The reinstatement is handed the dispute's charge and amount, so the invoice
   * is put back even when the dispute took nothing from the credits (audit #2);
   * when neither the dispute's rows nor the charge find the payment, Stripe is
   * asked once which invoice the charge paid. Failures are handled as a
   * reversal's are, recorded as `error:ai_credits_reinstate_failed` and alerted
   * without ids (audit #15).
   */
  private async handleDisputeDecided(event: StripeEvent): Promise<DispatchOutcome> {
    const clawbacks = this.config.creditClawbacks;
    const dispute = event.data.object;
    const disputeId = readString(dispute, 'id');
    const status = readString(dispute, 'status');
    if (clawbacks === null || clawbacks === undefined || disputeId === null) {
      this.logEvent(event, `${event.type} (nothing to do)`);
      return 'handled';
    }
    const won = event.type === 'charge.dispute.funds_reinstated' || status === 'won';
    if (!won) {
      this.logEvent(
        event,
        isInquiry(status)
          ? `${event.type} (${status ?? 'inquiry'}; an inquiry took nothing)`
          : `${event.type} (${status ?? 'unknown'}; clawback stands)`,
      );
      return 'handled';
    }
    const chargeId = readString(dispute, 'charge');
    const amountMinor = readNumber(dispute, 'amount');
    const reinstate = (stripeInvoiceId: string | null) =>
      clawbacks.reinstateDispute({ disputeId, chargeId, stripeInvoiceId, amountMinor });
    try {
      let outcome = await reinstate(null);
      if (outcome.kind === 'nothing_to_reinstate' && chargeId !== null) {
        const invoiceId = await this.invoiceOfCharge(event, chargeId);
        if (invoiceId !== null) outcome = await reinstate(invoiceId);
      }
      this.logEvent(event, `${event.type} → credits ${outcome.kind}`);
      return 'handled';
    } catch (err) {
      if (isTransientInfraError(err)) throw err;
      this.config.logger.error(
        {
          component: 'stripe-webhooks',
          eventId: event.id,
          eventType: event.type,
          disputeId,
          err: { message: err instanceof Error ? err.message : String(err) },
        },
        'putting AI credits back for a won dispute failed; review the account by hand',
      );
      this.alertCreditsFailure(
        'ai_credits_reinstate_failed',
        'dispute',
        'Putting AI credits back for a won dispute failed. ' +
          'Find the dispute id in the server log and review the account by hand.',
      );
      this.logEvent(event, `${event.type} (credits not put back)`);
      return 'error:ai_credits_reinstate_failed';
    }
  }

  /**
   * S17 re-audit #9 — `charge.dispute.updated`: an inquiry that ESCALATED to a
   * chargeback (its status is a chargeback's now) is applied exactly as
   * `charge.dispute.created` is — and, being the same dispute id, at most once
   * whichever of the two arrives. Every other update — evidence submitted, an
   * inquiry still under review, a decision (which `closed` carries) — changes
   * nothing here.
   */
  private async handleDisputeUpdated(event: StripeEvent): Promise<DispatchOutcome> {
    const status = readString(event.data.object, 'status');
    if (status !== null && ESCALATED_DISPUTE_STATUSES.has(status)) {
      return this.handleChargeReversal(event, 'dispute');
    }
    this.logEvent(event, `${event.type} (${status ?? 'unknown'}; nothing to take back)`);
    return 'handled';
  }

  /** Whether a reversal event is still inside the two days it is retried for (re-audit #14). */
  private reversalIsYoung(event: StripeEvent): boolean {
    if (event.created === undefined) return false;
    const now = this.config.now?.() ?? new Date();
    return now.getTime() - event.created * 1000 < REVERSAL_AWAITS_PAYMENT_FOR_MS;
  }

  /**
   * A reversal whose invoice is still not on record two days after Stripe sent
   * it: recorded as handled and kept for review — logged at error with the
   * charge, alerted without it — exactly as a charge with no invoice is.
   */
  private keptForReview(
    event: StripeEvent,
    what: 'refund' | 'dispute',
    chargeId: string,
  ): DispatchOutcome {
    this.config.logger.error(
      {
        component: 'stripe-webhooks',
        eventId: event.id,
        eventType: event.type,
        chargeId,
      },
      'a reversal names an invoice still not on record after two days; kept for review',
    );
    try {
      this.config.sentry?.captureMessage({
        message:
          `A payment ${what} matched no recorded payment, so nothing was taken back from AI credits. ` +
          'Find the charge id in the server log and review it by hand.',
        level: 'error',
        fingerprint: ['billing', 'ai_credits_reversal_unmatched', what],
        tags: { kind: 'ai_credits_reversal_unmatched', what },
      });
    } catch {
      /* the log line is the record */
    }
    this.logEvent(event, `${event.type} → credits unmatched (kept for review)`);
    return 'handled';
  }

  /** S17 — the id-free alert both reversal paths raise when the credits could not be moved. */
  private alertCreditsFailure(
    kind: 'ai_credits_reversal_failed' | 'ai_credits_reinstate_failed',
    what: 'refund' | 'dispute',
    message: string,
  ): void {
    try {
      this.config.sentry?.captureMessage({
        message,
        level: 'error',
        fingerprint: ['billing', kind, what],
        tags: { kind, what },
      });
    } catch {
      /* the log line is the record */
    }
  }

  /** The invoice a charge paid, asked of Stripe once; null when there is none or nothing to ask. */
  private async invoiceOfCharge(event: StripeEvent, chargeId: string): Promise<string | null> {
    const fetcher = this.config.invoiceFetcher;
    if (fetcher === undefined || fetcher.getCharge === undefined) return null;
    try {
      const charge = await fetcher.getCharge(chargeId);
      return readString(charge, 'invoice');
    } catch (err) {
      if (isTransientInfraError(err)) throw err;
      this.config.logger.warn(
        {
          component: 'stripe-webhooks',
          eventId: event.id,
          chargeId,
          err: { message: err instanceof Error ? err.message : String(err) },
        },
        'the charge could not be read from Stripe; the reversal stays unmatched',
      );
      return null;
    }
  }

  private logEvent(event: StripeEvent, kind: string): void {
    this.config.logger.info(
      {
        component: 'stripe-webhooks',
        eventId: event.id,
        eventType: event.type,
        kind,
        livemode: event.livemode === true,
      },
      'handled Stripe event',
    );
  }
}

// ─── helpers ─────────────────────────────────────────────────────────

/**
 * Canonical event time for the recency guard. Stripe's `event.created`
 * (unix seconds) is the authoritative ordering signal across deliveries
 * of different events; the subscription mirror stamps it as `updated_at`
 * so an out-of-order / retried-old event can be rejected. When `created`
 * is absent (should never happen for a real Stripe event, but the field
 * is optional in our minimal shape) fall back to processing time so the
 * guard degrades to the prior last-processed-wins behaviour rather than
 * dropping the write.
 */
function eventTime(event: StripeEvent): Date {
  return event.created !== undefined ? new Date(event.created * 1000) : new Date();
}

/**
 * S17 — a dispute that is an INQUIRY, not a chargeback: Stripe gives it a
 * `warning_*` status (`warning_needs_response`, `warning_under_review`,
 * `warning_closed`). No funds leave for an inquiry, so it takes no credits.
 */
function isInquiry(status: string | null): boolean {
  return status !== null && status.startsWith('warning_');
}

/**
 * S17 re-audit #9 — the statuses of a dispute that is a CHARGEBACK and has not
 * been decided in the merchant's favour: funds have left. A
 * `charge.dispute.updated` carrying one applies the dispute (once per id).
 * `won` is not here — a win is `closed` / `funds_reinstated` — nor are the
 * inquiry (`warning_*`) and `prevented` statuses, which move no funds.
 */
const ESCALATED_DISPUTE_STATUSES: ReadonlySet<string> = new Set([
  'needs_response',
  'under_review',
  'lost',
]);

function readString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function readBool(obj: Record<string, unknown>, key: string): boolean {
  const v = obj[key];
  return v === true;
}

function readNumber(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function readUnixTimestamp(obj: Record<string, unknown>, key: string): Date | null {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return new Date(v * 1000);
}

/**
 * Subscription price id lives at `subscription.items.data[0].price.id`
 * in the Stripe object. We don't validate the array shape strictly —
 * Stripe guarantees at least one item on a non-empty subscription.
 */
function readSubscriptionPriceId(sub: Record<string, unknown>): string | null {
  const items = sub.items as { data?: unknown } | undefined;
  if (!items || !Array.isArray(items.data) || items.data.length === 0) return null;
  const first = items.data[0] as { price?: { id?: unknown } };
  if (!first.price || typeof first.price.id !== 'string') return null;
  return first.price.id;
}

const STATUS_VALUES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
] as const;
type LocalStatus = (typeof STATUS_VALUES)[number];

function stripeStatusToLocal(s: string): LocalStatus {
  return (STATUS_VALUES as readonly string[]).includes(s) ? (s as LocalStatus) : 'incomplete';
}
