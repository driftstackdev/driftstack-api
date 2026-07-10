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

// C1 — crypto entitlement mirror (crypto_entitlements). One row per paid order,
// unique on orderId; unexpired rows (expiresAt > now) floor the account tier.
interface CryptoEntitlementRow {
  id: string;
  accountId: string;
  orderId: string;
  tier: AccountTier;
  startsAt: Date;
  expiresAt: Date;
  expiredProcessedAt: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class InMemoryStripeWebhooksRepo implements StripeWebhooksRepo {
  private readonly events = new Map<string, LedgerRow>();
  private readonly subs = new Map<string, SubscriptionMirrorRow>();
  private readonly accounts = new Map<string, AccountFacet>();
  private readonly entitlements = new Map<string, CryptoEntitlementRow>();

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
    // C1 — floor against the highest-ranked UNEXPIRED crypto entitlement (mirrors
    // the Drizzle gt(expiresAt, at) union). No rows → byte-identical to before.
    let appliedTier = remaining[0]?.tier ?? args.fallbackTier;
    for (const e of this.entitlements.values()) {
      if (e.accountId !== args.accountId || e.expiresAt.getTime() <= args.at.getTime()) continue;
      if (tierActivationRank(e.tier) > tierActivationRank(appliedTier)) appliedTier = e.tier;
    }
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
    // C1 — also rank in UNEXPIRED crypto entitlements (mirrors the Drizzle union),
    // so a LOWER active/trialing upsert never wipes a higher crypto-paid tier.
    for (const e of this.entitlements.values()) {
      if (e.accountId !== args.accountId || e.expiresAt.getTime() <= args.at.getTime()) continue;
      if (appliedTier === null || tierActivationRank(e.tier) > tierActivationRank(appliedTier)) {
        appliedTier = e.tier;
      }
    }
    if (appliedTier === null) return Promise.resolve({ previousTier, appliedTier: previousTier });
    this.accounts.set(args.accountId, { ...a, tier: appliedTier });
    return Promise.resolve({ previousTier, appliedTier });
  }

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
  }> {
    // C1 — mirrors DrizzleStripeWebhooksRepo.activateCryptoEntitlement: account
    // lock, same-tier stacking, idempotent insert on orderId, compare-gated apply.
    const a = this.accounts.get(args.accountId);
    if (!a) {
      // Account gone — no FK target; skip the insert (the caller alarms).
      return Promise.resolve({
        previousTier: null,
        applied: false,
        entitlementInserted: false,
        startsAt: args.paidAt,
        expiresAt: new Date(args.paidAt.getTime() + args.termDays * DAY_MS),
      });
    }
    const previousTier = a.tier;

    // Replay — an entitlement already exists for this order. Return the ORIGINAL
    // grant's window; the original activation already applied any tier change.
    const existing = Array.from(this.entitlements.values()).find((e) => e.orderId === args.orderId);
    if (existing) {
      return Promise.resolve({
        previousTier,
        applied: false,
        entitlementInserted: false,
        startsAt: existing.startsAt,
        expiresAt: existing.expiresAt,
      });
    }

    // Stack a same-tier re-purchase off the account's latest unexpired same-tier
    // expiry (expiresAt > paidAt), else start at paidAt.
    let stackFrom: Date | null = null;
    for (const e of this.entitlements.values()) {
      if (
        e.accountId === args.accountId &&
        e.tier === args.tier &&
        e.expiresAt.getTime() > args.paidAt.getTime() &&
        (stackFrom === null || e.expiresAt.getTime() > stackFrom.getTime())
      ) {
        stackFrom = e.expiresAt;
      }
    }
    const startsAt =
      stackFrom !== null && stackFrom.getTime() > args.paidAt.getTime() ? stackFrom : args.paidAt;
    const expiresAt = new Date(startsAt.getTime() + args.termDays * DAY_MS);

    const id = randomUUID();
    this.entitlements.set(id, {
      id,
      accountId: args.accountId,
      orderId: args.orderId,
      tier: args.tier,
      startsAt,
      expiresAt,
      expiredProcessedAt: null,
    });

    let applied = false;
    if (isCryptoTierUpgrade(previousTier, args.tier)) {
      this.accounts.set(args.accountId, { ...a, tier: args.tier });
      applied = true;
    }
    return Promise.resolve({
      previousTier,
      applied,
      entitlementInserted: true,
      startsAt,
      expiresAt,
    });
  }

  revokeCryptoEntitlementByOrderId(args: {
    orderId: string;
    at: Date;
  }): Promise<{ revoked: boolean }> {
    // C3 — mirrors DrizzleStripeWebhooksRepo.revokeCryptoEntitlementByOrderId:
    // bring the order's entitlement expiry forward to `at` ONLY when still valid
    // (expiresAt > at). A replayed refund finds it already expired → 0 rows →
    // revoked:false (idempotent). expiredProcessedAt is left as-is (NULL).
    let revoked = false;
    for (const [id, e] of this.entitlements) {
      if (e.orderId === args.orderId && e.expiresAt.getTime() > args.at.getTime()) {
        this.entitlements.set(id, { ...e, expiresAt: args.at });
        revoked = true;
      }
    }
    return Promise.resolve({ revoked });
  }

  listExpiredUnprocessedCryptoEntitlements(args: {
    asOf: Date;
    limit: number;
  }): Promise<
    Array<{ id: string; accountId: string; orderId: string; tier: AccountTier; expiresAt: Date }>
  > {
    const rows = Array.from(this.entitlements.values())
      .filter((e) => e.expiresAt.getTime() <= args.asOf.getTime() && e.expiredProcessedAt === null)
      .sort((x, y) => x.expiresAt.getTime() - y.expiresAt.getTime())
      .slice(0, args.limit)
      .map((e) => ({
        id: e.id,
        accountId: e.accountId,
        orderId: e.orderId,
        tier: e.tier,
        expiresAt: e.expiresAt,
      }));
    return Promise.resolve(rows);
  }

  markCryptoEntitlementsProcessed(args: { ids: string[]; at: Date }): Promise<void> {
    for (const id of args.ids) {
      const e = this.entitlements.get(id);
      if (e) this.entitlements.set(id, { ...e, expiredProcessedAt: args.at });
    }
    return Promise.resolve();
  }

  /** Test inspection — list all crypto entitlement rows. */
  listCryptoEntitlements(): CryptoEntitlementRow[] {
    return Array.from(this.entitlements.values());
  }
}
