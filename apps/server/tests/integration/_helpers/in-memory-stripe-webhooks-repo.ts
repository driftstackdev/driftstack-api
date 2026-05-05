// In-memory StripeWebhooksRepo for integration tests (V-080 + V-089).

import { randomUUID } from 'node:crypto';
import type { AccountTier } from '@driftstack/api-types';
import type { StripeWebhooksRepo } from '../../../src/services/stripe-webhooks.js';

interface LedgerRow {
  eventId: string;
  eventType: string;
  payloadHash: string;
  result: string;
  receivedAt: Date;
}

interface SubscriptionMirrorRow {
  id: string;
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
  createdAt: Date;
  updatedAt: Date;
}

interface AccountFacet {
  id: string;
  stripeCustomerId: string | null;
  tier: AccountTier;
  trialPackPurchasedAt: Date | null;
  trialPackCreditCents: number | null;
  trialPackExpiresAt: Date | null;
  trialPackRedeemed: boolean;
}

export class InMemoryStripeWebhooksRepo implements StripeWebhooksRepo {
  private readonly events = new Map<string, LedgerRow>();
  private readonly subs = new Map<string, SubscriptionMirrorRow>();
  private readonly accounts = new Map<string, AccountFacet>();

  /** Test seam: register account ↔ Stripe customer link. */
  registerAccount(args: {
    accountId: string;
    stripeCustomerId: string | null;
    tier?: AccountTier;
  }): void {
    this.accounts.set(args.accountId, {
      id: args.accountId,
      stripeCustomerId: args.stripeCustomerId,
      tier: args.tier ?? 'trial_pack',
      trialPackPurchasedAt: null,
      trialPackCreditCents: null,
      trialPackExpiresAt: null,
      trialPackRedeemed: false,
    });
  }

  /** Test seam: read the current account facet. */
  readAccount(accountId: string): AccountFacet | null {
    return this.accounts.get(accountId) ?? null;
  }

  /** Test seam: read all subscription mirror rows. */
  listSubscriptions(): SubscriptionMirrorRow[] {
    return Array.from(this.subs.values());
  }

  hasEvent(eventId: string): Promise<boolean> {
    return Promise.resolve(this.events.has(eventId));
  }

  recordEvent(args: LedgerRow): Promise<{ inserted: boolean }> {
    if (this.events.has(args.eventId)) {
      return Promise.resolve({ inserted: false });
    }
    this.events.set(args.eventId, args);
    return Promise.resolve({ inserted: true });
  }

  /** Test inspection — list all recorded events in insertion order. */
  list(): LedgerRow[] {
    return Array.from(this.events.values());
  }

  findAccountIdFromCustomerOrRef(args: {
    stripeCustomerId: string | null;
    clientReferenceId: string | null;
  }): Promise<string | null> {
    if (args.clientReferenceId !== null && this.accounts.has(args.clientReferenceId)) {
      return Promise.resolve(args.clientReferenceId);
    }
    if (args.stripeCustomerId !== null) {
      for (const a of this.accounts.values()) {
        if (a.stripeCustomerId === args.stripeCustomerId) return Promise.resolve(a.id);
      }
    }
    return Promise.resolve(null);
  }

  upsertSubscription(args: {
    accountId: string;
    stripeSubscriptionId: string;
    stripePriceId: string;
    tier: AccountTier;
    status: SubscriptionMirrorRow['status'];
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
    canceledAt: Date | null;
    at: Date;
  }): Promise<void> {
    const existing = Array.from(this.subs.values()).find(
      (s) => s.stripeSubscriptionId === args.stripeSubscriptionId,
    );
    if (existing) {
      this.subs.set(existing.id, {
        ...existing,
        accountId: args.accountId,
        stripePriceId: args.stripePriceId,
        tier: args.tier,
        status: args.status,
        currentPeriodEnd: args.currentPeriodEnd,
        cancelAtPeriodEnd: args.cancelAtPeriodEnd,
        canceledAt: args.canceledAt,
        updatedAt: args.at,
      });
    } else {
      const id = randomUUID();
      this.subs.set(id, {
        id,
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
      });
    }
    return Promise.resolve();
  }

  setAccountTier(args: {
    accountId: string;
    tier: AccountTier;
    at: Date;
  }): Promise<{ previousTier: AccountTier | null }> {
    const a = this.accounts.get(args.accountId);
    if (!a) return Promise.resolve({ previousTier: null });
    const previousTier = a.tier;
    this.accounts.set(args.accountId, { ...a, tier: args.tier });
    return Promise.resolve({ previousTier });
  }

  applyTrialPackPurchase(args: {
    accountId: string;
    creditCents: number;
    expiresAt: Date;
    at: Date;
  }): Promise<{ applied: boolean }> {
    const a = this.accounts.get(args.accountId);
    if (!a) return Promise.resolve({ applied: false });
    if (a.trialPackPurchasedAt !== null) return Promise.resolve({ applied: false });
    this.accounts.set(args.accountId, {
      ...a,
      trialPackPurchasedAt: args.at,
      trialPackCreditCents: args.creditCents,
      trialPackExpiresAt: args.expiresAt,
      trialPackRedeemed: false,
    });
    return Promise.resolve({ applied: true });
  }
}
