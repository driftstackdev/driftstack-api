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
//   2. Event dispatch — a switch over `event.type` that fans out to
//      per-type handlers. At V-080 scaffolding time the handlers are
//      stubs that log + record `result='handled-noop'`; downstream
//      V-NNN entries fill in actual subscription state mutation /
//      tier changes / invoice tracking.
//
// Signature verification is the route's job (it has the raw body); this
// service receives a verified, parsed event.

import { createHash } from 'node:crypto';
import type { Logger } from '../lib/logger.js';

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
}

export type DispatchOutcome = 'handled' | 'ignored' | `error:${string}`;

export interface StripeWebhooksServiceConfig {
  logger: Logger;
}

export class StripeWebhooksService {
  constructor(
    private readonly repo: StripeWebhooksRepo,
    private readonly config: StripeWebhooksServiceConfig,
  ) {}

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

    const outcome = this.dispatch(event);
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
   * Map an event.type to a handler. At scaffolding time every handler
   * is a logging no-op; the dispatch surface is here so downstream
   * V-NNN entries fill in actual subscription / invoice state mutation
   * one event-type at a time.
   */
  private dispatch(event: StripeEvent): DispatchOutcome {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        return this.logHandled(event, 'subscription lifecycle');
      case 'invoice.payment_succeeded':
      case 'invoice.payment_failed':
      case 'invoice.finalized':
        return this.logHandled(event, 'invoice lifecycle');
      case 'checkout.session.completed':
        return this.logHandled(event, 'checkout completed');
      case 'customer.created':
      case 'customer.updated':
      case 'customer.deleted':
        return this.logHandled(event, 'customer lifecycle');
      case 'payment_method.attached':
      case 'payment_method.detached':
        return this.logHandled(event, 'payment method');
      default:
        // Stripe sends many event types we don't care about (e.g.
        // `radar.early_fraud_warning.created`). Acknowledge with 200
        // and record `'ignored'` so admin can see what's flowing in.
        this.config.logger.info(
          { component: 'stripe-webhooks', eventId: event.id, eventType: event.type },
          'ignored Stripe event type',
        );
        return 'ignored';
    }
  }

  private logHandled(event: StripeEvent, kind: string): 'handled' {
    this.config.logger.info(
      {
        component: 'stripe-webhooks',
        eventId: event.id,
        eventType: event.type,
        kind,
        livemode: event.livemode === true,
      },
      'handled Stripe event (scaffolding no-op)',
    );
    return 'handled';
  }
}
