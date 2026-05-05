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
import type { Logger } from '../lib/logger.js';
import type { AccountAuditService } from './account-audit.js';

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
   * If a row with that id exists, UPDATE its mutable fields; otherwise
   * INSERT new. Returns nothing — handlers don't need the returned row.
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
  }): Promise<void>;

  /**
   * Set the account's `tier` column. Used when subscription state
   * transitions imply a tier change (e.g. subscription.created →
   * upgrade from trial_pack to api_builder; subscription.deleted →
   * downgrade to trial_pack).
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
   * Provision a trial-pack purchase per ADR-003: 299¢ credit, 14-day
   * window, redeemed=false. Idempotent: if `trial_pack_purchased_at`
   * is already set, no-op.
   */
  applyTrialPackPurchase(args: {
    accountId: string;
    creditCents: number;
    expiresAt: Date;
    at: Date;
  }): Promise<{ applied: boolean }>;
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
   * Trial-pack credit cents (default 299 = $2.99 per ADR-003).
   * Override for tests.
   */
  trialPackCreditCents?: number;
  /**
   * Trial-pack window length in milliseconds (default 14 days per ADR-003).
   * Override for tests.
   */
  trialPackWindowMs?: number;
  /**
   * What tier the account drops to when a subscription is canceled
   * (status='canceled' / event 'customer.subscription.deleted').
   * Default 'trial_pack' (loses paid tier privileges; trial-pack
   * credit may still be active independently).
   */
  cancelDowngradeTier?: AccountTier;
}

const DEFAULT_TRIAL_PACK_CREDIT_CENTS = 299;
const DEFAULT_TRIAL_PACK_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export class StripeWebhooksService {
  constructor(
    private readonly repo: StripeWebhooksRepo,
    private readonly config: StripeWebhooksServiceConfig,
    /**
     * V-226 — optional customer-facing audit log. When wired, emits a
     * `subscription.tier_changed` entry whenever a Stripe subscription
     * event flips an account's tier. `actor_type: 'system'` because the
     * trigger is Stripe's webhook delivery, not a customer action.
     * Best-effort; failures never block the Stripe handler (Stripe
     * retries are idempotency-protected by the event-ledger anyway).
     */
    private readonly accountAudit: AccountAuditService | null = null,
  ) {}

  private async emitTierChangeBestEffort(args: {
    accountId: string;
    previousTier: AccountTier | null;
    newTier: AccountTier;
    eventType: string;
    eventId: string;
  }): Promise<void> {
    if (this.accountAudit === null) return;
    if (args.previousTier === args.newTier) return; // no-op transition
    try {
      await this.accountAudit.record({
        accountId: args.accountId,
        actorType: 'system',
        actorAccountId: null,
        actorKeyId: null,
        action: 'subscription.tier_changed',
        targetResourceId: null,
        payload: {
          from: args.previousTier,
          to: args.newTier,
          stripe_event_type: args.eventType,
          stripe_event_id: args.eventId,
        },
      });
    } catch (err) {
      this.config.logger.warn(
        {
          component: 'stripe-webhooks',
          eventId: args.eventId,
          err: err instanceof Error ? { name: err.name, message: err.message } : { value: err },
        },
        'subscription.tier_changed audit emit failed (best-effort, swallowed)',
      );
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
   * 'error:<short>'`. Errors from handlers are caught and surfaced as
   * the `error:` outcome — the ledger row gets written with the error
   * marker, and Stripe gets a 200 from the route (the event was
   * processed even if the handler failed; retrying via Stripe won't
   * help if it's a code bug).
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
        case 'invoice.payment_failed':
        case 'invoice.finalized':
          // Invoice events log only at scaffolding time; receipt
          // emails are fired by Stripe's own infrastructure.
          this.logEvent(event, 'invoice');
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
      const code = err instanceof Error ? err.name.toLowerCase() : 'unknown';
      this.config.logger.error(
        {
          component: 'stripe-webhooks',
          eventId: event.id,
          eventType: event.type,
          err: err instanceof Error ? { name: err.name, message: err.message } : { value: err },
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

    const at = new Date();
    await this.repo.upsertSubscription({
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

    // Tier change only when the subscription is in an active-paying
    // state. Trialing counts as active for our purposes (the customer
    // gets the tier; Stripe handles the dunning).
    if (tier !== undefined && (status === 'active' || status === 'trialing')) {
      const { previousTier } = await this.repo.setAccountTier({ accountId, tier, at });
      await this.emitTierChangeBestEffort({
        accountId,
        previousTier,
        newTier: tier,
        eventType: event.type,
        eventId: event.id,
      });
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

    const at = new Date();
    const priceId = readSubscriptionPriceId(sub);
    await this.repo.upsertSubscription({
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
    const downgradeTier = this.config.cancelDowngradeTier ?? 'trial_pack';
    const { previousTier } = await this.repo.setAccountTier({
      accountId,
      tier: downgradeTier,
      at,
    });
    await this.emitTierChangeBestEffort({
      accountId,
      previousTier,
      newTier: downgradeTier,
      eventType: event.type,
      eventId: event.id,
    });

    this.logEvent(event, 'subscription canceled');
    return 'handled';
  }

  private async handleCheckoutCompleted(event: StripeEvent): Promise<DispatchOutcome> {
    const session = event.data.object;
    const mode = readString(session, 'mode');
    const clientReferenceId = readString(session, 'client_reference_id');
    const stripeCustomerId = readString(session, 'customer');

    if (mode === 'subscription') {
      // Subscription path: customer.subscription.created arrives separately
      // and does the actual mirror write. checkout.session.completed for
      // subscription mode is informational here.
      this.logEvent(event, 'checkout subscription completed (informational)');
      return 'handled';
    }

    if (mode !== 'payment') {
      this.logEvent(event, `checkout completed (mode=${mode ?? 'unknown'})`);
      return 'handled';
    }

    // payment-mode → trial pack purchase per V-082 metadata convention.
    // We use client_reference_id as the source of truth; fall back to
    // customer lookup if absent.
    const accountId = await this.repo.findAccountIdFromCustomerOrRef({
      stripeCustomerId,
      clientReferenceId,
    });
    if (accountId === null) {
      this.config.logger.warn(
        { component: 'stripe-webhooks', eventId: event.id, stripeCustomerId, clientReferenceId },
        'checkout.session.completed (payment) for unknown account; ignoring',
      );
      return 'ignored';
    }

    const at = new Date();
    const expiresAt = new Date(
      at.getTime() + (this.config.trialPackWindowMs ?? DEFAULT_TRIAL_PACK_WINDOW_MS),
    );
    const { applied } = await this.repo.applyTrialPackPurchase({
      accountId,
      creditCents: this.config.trialPackCreditCents ?? DEFAULT_TRIAL_PACK_CREDIT_CENTS,
      expiresAt,
      at,
    });

    this.logEvent(event, applied ? 'trial-pack provisioned' : 'trial-pack already provisioned');
    return 'handled';
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

function readString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function readBool(obj: Record<string, unknown>, key: string): boolean {
  const v = obj[key];
  return v === true;
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
