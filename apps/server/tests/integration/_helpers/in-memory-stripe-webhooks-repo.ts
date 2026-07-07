// In-memory StripeWebhooksRepo for integration tests (V-080 + V-089).

import { randomUUID } from 'node:crypto';
import type { AccountTier } from '@driftstack/api-types';
import type { StripeWebhooksRepo } from '../../../src/services/stripe-webhooks.js';
import {
  isCryptoTierUpgrade,
  tierActivationRank,
} from '../../../src/services/crypto-tier-activation.js';

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
      tier: args.tier ?? 'free',
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
  }): Promise<{ applied: boolean }> {
    const existing = Array.from(this.subs.values()).find(
      (s) => s.stripeSubscriptionId === args.stripeSubscriptionId,
    );
    if (existing) {
      // Event-recency guard mirror (matches the Drizzle setWhere
      // `updated_at <= excluded.updated_at`): on conflict, skip only when
      // the incoming event is STRICTLY OLDER than the stored row, so an
      // out-of-order / retried-old event is rejected instead of reverting
      // the mirror. Equal-time events still apply (`<=` apply ⇒ skip iff
      // strictly older) — event.created is second-granularity so two
      // distinct ordered events can share a second.
      if (args.at.getTime() < existing.updatedAt.getTime()) {
        return Promise.resolve({ applied: false });
      }
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
    return Promise.resolve({ applied: true });
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

  setAccountTierIfUpgrade(args: {
    accountId: string;
    tier: AccountTier;
    at: Date;
  }): Promise<{ previousTier: AccountTier | null; applied: boolean }> {
    // S41 — mirrors DrizzleStripeWebhooksRepo.setAccountTierIfUpgrade:
    // decide-and-write against the current row via the SHARED
    // isCryptoTierUpgrade rule (single source; the rule can't fork).
    const a = this.accounts.get(args.accountId);
    if (!a) return Promise.resolve({ previousTier: null, applied: false });
    const previousTier = a.tier;
    if (!isCryptoTierUpgrade(previousTier, args.tier)) {
      return Promise.resolve({ previousTier, applied: false });
    }
    this.accounts.set(args.accountId, { ...a, tier: args.tier });
    return Promise.resolve({ previousTier, applied: true });
  }

  downgradeAccountTierToBestRemaining(args: {
    accountId: string;
    fallbackTier: AccountTier;
    at: Date;
  }): Promise<{ previousTier: AccountTier | null; appliedTier: AccountTier }> {
    const a = this.accounts.get(args.accountId);
    if (!a) return Promise.resolve({ previousTier: null, appliedTier: args.fallbackTier });
    const previousTier = a.tier;
    // Best remaining active/trialing subscription for the account (most-recently
    // updated wins), else the fallback — mirrors the Drizzle query.
    const remaining = Array.from(this.subs.values())
      .filter(
        (s) => s.accountId === args.accountId && (s.status === 'active' || s.status === 'trialing'),
      )
      .sort((x, y) => y.updatedAt.getTime() - x.updatedAt.getTime());
    const appliedTier = remaining[0]?.tier ?? args.fallbackTier;
    this.accounts.set(args.accountId, { ...a, tier: appliedTier });
    return Promise.resolve({ previousTier, appliedTier });
  }

  setAccountTierToBestActive(args: {
    accountId: string;
    at: Date;
  }): Promise<{ previousTier: AccountTier | null; appliedTier: AccountTier | null }> {
    // Fable last-hours audit 2026-07-07 (C4) — mirrors the Drizzle
    // setAccountTierToBestActive: set to the HIGHEST-RANKED active/trialing
    // subscription (rank-aware, not most-recently-updated), never downgrading
    // to a fallback. Empty active set / missing account leaves the tier as-is.
    const a = this.accounts.get(args.accountId);
    if (!a) return Promise.resolve({ previousTier: null, appliedTier: null });
    const previousTier = a.tier;
    const active = Array.from(this.subs.values()).filter(
      (s) => s.accountId === args.accountId && (s.status === 'active' || s.status === 'trialing'),
    );
    let appliedTier: AccountTier | null = null;
    for (const row of active) {
      if (appliedTier === null || tierActivationRank(row.tier) > tierActivationRank(appliedTier)) {
        appliedTier = row.tier;
      }
    }
    if (appliedTier === null) return Promise.resolve({ previousTier, appliedTier: previousTier });
    this.accounts.set(args.accountId, { ...a, tier: appliedTier });
    return Promise.resolve({ previousTier, appliedTier });
  }
}
