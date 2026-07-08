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
// Signature verification is the route's job (it has the raw body); this
// service receives a verified, parsed event.

import { createHash } from 'node:crypto';
import type { AccountTier } from '@driftstack/api-types';
import { isTransientInfraError } from '../lib/transient-error.js';
import type { Logger } from '../lib/logger.js';
import type { AccountLifecycleService } from './account-lifecycle.js';
import type { AuthCache } from './auth-cache.js';

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
  }): Promise<{ applied: boolean }>;

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
   */
  setAccountTierToBestActive(args: {
    accountId: string;
    at: Date;
  }): Promise<{ previousTier: AccountTier | null; appliedTier: AccountTier | null }>;
}

export type DispatchOutcome = 'handled' | 'ignored' | `error:${string}`;

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
        case 'invoice.payment_failed':
          // S44 2026-07-07 (founder-approved) — payment-failure notice.
          // NEVER opt-outable (billing-failure is deliberately absent
          // from OptOutableEmailEventSchema); same ledger-backed dedup.
          await this.handleInvoicePaymentFailed(event);
          return 'handled';
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
    const currentPeriodEnd = readUnixTimestamp(sub, 'current_period_end');
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

    const tier = this.config.priceToTier[priceId];
    if (tier === undefined) {
      this.config.logger.warn(
        { component: 'stripe-webhooks', eventId: event.id, priceId },
        'subscription price id not in priceToTier map; mirror written without tier change',
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
      tier: tier ?? 'enterprise',
      status: stripeStatusToLocal(status),
      currentPeriodEnd,
      cancelAtPeriodEnd,
      canceledAt,
      at,
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

    // Tier change only when the subscription is in an active-paying
    // state. Trialing counts as active for our purposes (the customer
    // gets the tier; Stripe handles the dunning).
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
      // succeeding. Downgrade using the SAME target + mechanism as an
      // explicit cancellation (handleSubscriptionDeleted below) — an
      // account that isn't being billed doesn't keep paid-tier access
      // for the full multi-week dunning window. The subscription MIRROR
      // already recorded the real status (past_due/unpaid, not
      // 'canceled') via the upsertSubscription call above, so the
      // distinction from a true cancel survives in the DB; if Stripe's
      // retry later succeeds, the event arrives as status === 'active'
      // and the branch above naturally re-upgrades on the next in-order
      // event — no separate recovery path needed.
      const downgradeTier = this.config.cancelDowngradeTier ?? 'free';
      // Recompute from the account's remaining active subscriptions — a
      // past_due on a SUPERSEDED subscription must not downgrade an account
      // that still holds another active subscription (an account can hold
      // multiple subscription rows; re-checkout is allowed while past_due).
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
    const { applied } = await this.repo.upsertSubscription({
      accountId,
      stripeSubscriptionId,
      stripePriceId: priceId ?? '',
      tier: priceId !== null ? (this.config.priceToTier[priceId] ?? 'enterprise') : 'enterprise',
      status: 'canceled',
      currentPeriodEnd: readUnixTimestamp(sub, 'current_period_end'),
      cancelAtPeriodEnd: false,
      canceledAt: at,
      at,
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
    // Optional fields — the lifecycle handler has fallbacks for each.
    const periodStart = readUnixTimestamp(invoice, 'period_start');
    const periodEnd = readUnixTimestamp(invoice, 'period_end');
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

    if (amountPaid === 0) {
      this.logEvent(event, 'invoice.payment_succeeded (zero-amount — no receipt)');
      return;
    }

    const accountId = await this.repo.findAccountIdFromCustomerOrRef({
      stripeCustomerId,
      clientReferenceId: null,
    });
    if (accountId === null) {
      this.config.logger.warn(
        { component: 'stripe-webhooks', eventId: event.id, stripeCustomerId },
        'invoice.payment_succeeded references unknown customer; ignoring',
      );
      this.logEvent(event, 'invoice.payment_succeeded (unknown-customer)');
      return;
    }

    if (this.accountLifecycle !== null) {
      await this.accountLifecycle.emit(accountId, {
        kind: 'billing.payment_succeeded',
        amountCents: amountPaid,
        currency,
        periodStart,
        periodEnd,
        hostedInvoiceUrl,
        stripeEventId: event.id,
        stripeInvoiceId,
      });
    }

    this.logEvent(event, 'invoice.payment_succeeded → billing receipt dispatched');
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
      await this.accountLifecycle.emit(accountId, {
        kind: 'billing.payment_failed',
        amountCents: amountDue,
        currency,
        retryAt,
        stripeEventId: event.id,
        stripeInvoiceId,
      });
    }

    this.logEvent(event, 'invoice.payment_failed → billing-failure notice dispatched');
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
