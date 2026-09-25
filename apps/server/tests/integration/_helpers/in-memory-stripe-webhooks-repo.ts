// In-memory StripeWebhooksRepo for integration tests (V-080 + V-089).

import { randomUUID } from 'node:crypto';
import type { AccountTier } from '@driftstack/api-types';
import {
  PAST_DUE_GRACE_DAYS,
  type StoredSubscription,
  type StripeWebhooksRepo,
} from '../../../src/services/stripe-webhooks.js';
import {
  isCryptoTierUpgrade,
  tierActivationRank,
} from '../../../src/services/crypto-tier-activation.js';
import {
  ACTIVE_SUBSCRIPTION_STATUSES,
  COLLECTING_SUBSCRIPTION_STATUSES,
} from '../../../src/db/subscription-status-sets.js';
import { SAME_SECOND_STATUS_ORDER } from '../../../src/db/stripe-webhooks-repo.js';
import {
  completeInvoicePayment,
  type InvoicePaymentOutcome,
  type InvoicePaymentRecord,
} from '../../../src/lib/invoice-payment-record.js';
import type { BillingInterval, PeriodStartSource } from '../../../src/lib/stripe-billing-facts.js';

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
  // Migration 0129.
  currentPeriodStart: Date | null;
  periodStartSource: PeriodStartSource | null;
  billingInterval: BillingInterval | null;
  tierSince: Date | null;
  // Migration 0141 (live-billing audit #3).
  pastDueSince: Date | null;
  pastDueGraceEndedAt: Date | null;
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
const PAST_DUE_GRACE_MS = PAST_DUE_GRACE_DAYS * DAY_MS;

/**
 * Mirrors the Drizzle `subscriptionStillGrantsAt` (live-billing audit #3): active
 * and trialing, and a past_due spell that began within the grace — judged at the
 * later of now and `at` — and that the past-due sweep has not processed.
 */
function stillGrants(s: SubscriptionMirrorRow, at: Date): boolean {
  if (BILLED_STATUSES.includes(s.status)) return true;
  return (
    s.status === 'past_due' &&
    s.pastDueGraceEndedAt === null &&
    s.pastDueSince !== null &&
    s.pastDueSince.getTime() > Math.max(Date.now(), at.getTime()) - PAST_DUE_GRACE_MS
  );
}

/** Mirrors the Drizzle `pastDueGraceEndedBy`: the sweep's read, and its mark's re-check. */
function graceEndedBy(s: SubscriptionMirrorRow, asOf: Date): boolean {
  return (
    s.status === 'past_due' &&
    s.pastDueGraceEndedAt === null &&
    s.pastDueSince !== null &&
    s.pastDueSince.getTime() <= asOf.getTime() - PAST_DUE_GRACE_MS
  );
}

/**
 * Mirrors the Drizzle `GREATEST(now(), at)` (live-billing audit #9): a crypto
 * term floors the tier only while it is unexpired when the recompute RUNS, never
 * judged at an earlier Stripe event time.
 */
function termRunningAt(at: Date): number {
  return Math.max(Date.now(), at.getTime());
}

// V-1263 — the billed-status set is READ from the shared module, not restated. Both call sites
// below used to spell out `s.status === 'active' || s.status === 'trialing'`, which is the same
// decision the Drizzle repo makes and the same one admin-billing makes — four copies across
// three files before this. Stripe keeps charging a `past_due` subscription through its retry
// window, so a third member is a plausible edit, and it has to reach every one of them.
const BILLED_STATUSES: readonly string[] = ACTIVE_SUBSCRIPTION_STATUSES;

export class InMemoryStripeWebhooksRepo implements StripeWebhooksRepo {
  private readonly events = new Map<string, LedgerRow>();
  private readonly subs = new Map<string, SubscriptionMirrorRow>();
  private readonly accounts = new Map<string, AccountFacet>();
  private readonly entitlements = new Map<string, CryptoEntitlementRow>();
  /** billing_invoice_payments, keyed on the invoice id (its primary key). */
  private readonly invoicePayments = new Map<string, InvoicePaymentRecord>();
  /**
   * Production writes ONE `accounts.tier` column, so a Stripe/crypto
   * activation is immediately visible to the auth path. This fixture split the
   * facet into its own map, which meant an upgraded account still authenticated
   * on its OLD tier — invisible until the Free customer-API boundary started
   * refusing those requests. The mirror keeps the two stores in lockstep.
   */
  private tierMirror: ((accountId: string, tier: AccountTier) => void) | null = null;

  /** Test seam: propagate every tier write to the auth store, as prod does. */
  setTierMirror(mirror: (accountId: string, tier: AccountTier) => void): void {
    this.tierMirror = mirror;
  }

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

  /** Test seam: a COPY of every recorded paid invoice, in insertion order. */
  listInvoicePayments(): InvoicePaymentRecord[] {
    return Array.from(this.invoicePayments.values(), copyInvoicePayment);
  }

  /**
   * Test seam: stage a mirror row as it stood BEFORE migration 0129 — no period
   * start, no interval, no plan-change time — which no interface method can
   * produce any more and which the period backfill exists to repair.
   */
  seedSubscriptionWithoutPeriodStart(args: {
    accountId: string;
    stripeSubscriptionId: string;
    stripePriceId: string;
    tier: AccountTier;
    currentPeriodEnd: Date | null;
    at: Date;
  }): void {
    const id = randomUUID();
    this.subs.set(id, {
      id,
      accountId: args.accountId,
      stripeSubscriptionId: args.stripeSubscriptionId,
      stripePriceId: args.stripePriceId,
      tier: args.tier,
      status: 'active',
      currentPeriodEnd: args.currentPeriodEnd,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      createdAt: args.at,
      updatedAt: args.at,
      currentPeriodStart: null,
      periodStartSource: null,
      billingInterval: null,
      tierSince: null,
      pastDueSince: null,
      pastDueGraceEndedAt: null,
    });
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

  /** V-742 — the account's current tier, the NOT-NULL filler for a subscription
   *  whose Stripe price id is unmapped. Previously 'enterprise', which outranks
   *  every real tier in tierActivationRank and was read back out by the recompute
   *  as a genuine entitlement. */
  getAccountTier(accountId: string): Promise<AccountTier | null> {
    return Promise.resolve(this.accounts.get(accountId)?.tier ?? null);
  }

  findSubscription(stripeSubscriptionId: string): Promise<StoredSubscription | null> {
    const row = Array.from(this.subs.values()).find(
      (s) => s.stripeSubscriptionId === stripeSubscriptionId,
    );
    return Promise.resolve(
      row === undefined
        ? null
        : {
            accountId: row.accountId,
            tier: row.tier,
            status: row.status,
            createdAt: new Date(row.createdAt.getTime()),
            pastDueSince: row.pastDueSince === null ? null : new Date(row.pastDueSince.getTime()),
          },
    );
  }

  listCollectingSubscriptions(accountId: string): Promise<
    Array<{
      stripeSubscriptionId: string;
      status: SubscriptionMirrorRow['status'];
      createdAt: Date;
    }>
  > {
    const collecting: readonly string[] = COLLECTING_SUBSCRIPTION_STATUSES;
    return Promise.resolve(
      Array.from(this.subs.values())
        .filter((s) => s.accountId === accountId && collecting.includes(s.status))
        // Mirrors ORDER BY created_at, id.
        .sort(
          (x, y) =>
            x.createdAt.getTime() - y.createdAt.getTime() ||
            (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
        )
        .map((s) => ({
          stripeSubscriptionId: s.stripeSubscriptionId,
          status: s.status,
          createdAt: new Date(s.createdAt.getTime()),
        })),
    );
  }

  listPastDueGraceEnded(args: {
    asOf: Date;
    limit: number;
  }): Promise<Array<{ id: string; accountId: string; pastDueSince: Date }>> {
    return Promise.resolve(
      Array.from(this.subs.values())
        .filter((s) => graceEndedBy(s, args.asOf))
        // Mirrors ORDER BY past_due_since, id.
        .sort(
          (x, y) =>
            (x.pastDueSince?.getTime() ?? 0) - (y.pastDueSince?.getTime() ?? 0) ||
            (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
        )
        .slice(0, args.limit)
        .map((s) => ({
          id: s.id,
          accountId: s.accountId,
          pastDueSince: new Date(s.pastDueSince?.getTime() ?? 0),
        })),
    );
  }

  markPastDueGraceEnded(args: { ids: string[]; asOf: Date }): Promise<void> {
    for (const id of args.ids) {
      const s = this.subs.get(id);
      if (s !== undefined && graceEndedBy(s, args.asOf)) {
        this.subs.set(id, { ...s, pastDueGraceEndedAt: new Date(args.asOf.getTime()) });
      }
    }
    return Promise.resolve();
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
    currentPeriodStart?: Date | null;
    billingInterval?: BillingInterval | null;
    /** Test-only: a fixed id so a contract arm can stage an id-decided tie. */
    id?: string;
  }): Promise<{ applied: boolean }> {
    // Mirrors the Drizzle upsert: the start is written as the event gave it (a
    // null clears it), a start read from an event is 'stripe', and `tierSince`
    // moves only when the stored plan differs from the incoming one.
    const currentPeriodStart = args.currentPeriodStart ?? null;
    const periodStartSource: PeriodStartSource | null =
      currentPeriodStart === null ? null : 'stripe';
    const billingInterval = args.billingInterval ?? null;
    const existing = Array.from(this.subs.values()).find(
      (s) => s.stripeSubscriptionId === args.stripeSubscriptionId,
    );
    if (existing) {
      // Event-recency guard mirror (matches the Drizzle setWhere): on
      // conflict, a STRICTLY NEWER event applies; a strictly older one is
      // rejected; at the SAME second the event applies only when its status is
      // no earlier in SAME_SECOND_STATUS_ORDER than the stored one, so a
      // reordered Checkout burst cannot rewind `active` to `incomplete` and
      // nothing replaces `canceled` (live-billing audit #2).
      const dt = args.at.getTime() - existing.updatedAt.getTime();
      if (dt < 0) return Promise.resolve({ applied: false });
      if (
        dt === 0 &&
        SAME_SECOND_STATUS_ORDER.indexOf(args.status) <
          SAME_SECOND_STATUS_ORDER.indexOf(existing.status)
      ) {
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
        currentPeriodStart,
        periodStartSource,
        billingInterval,
        tierSince: existing.tier !== args.tier ? args.at : existing.tierSince,
        // Mirrors the Drizzle CASEs (live-billing audit #3): a move INTO past_due
        // stamps the start; staying keeps it and the sweep's mark; leaving clears.
        pastDueSince:
          args.status !== 'past_due'
            ? null
            : existing.status === 'past_due'
              ? existing.pastDueSince
              : args.at,
        pastDueGraceEndedAt:
          args.status === 'past_due' && existing.status === 'past_due'
            ? existing.pastDueGraceEndedAt
            : null,
      });
    } else {
      const id = args.id ?? randomUUID();
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
        currentPeriodStart,
        periodStartSource,
        billingInterval,
        tierSince: args.at,
        pastDueSince: args.status === 'past_due' ? args.at : null,
        pastDueGraceEndedAt: null,
      });
    }
    return Promise.resolve({ applied: true });
  }

  upsertInvoicePayment(
    args: InvoicePaymentRecord,
  ): Promise<{ outcome: InvoicePaymentOutcome; linked: boolean }> {
    const stored = this.invoicePayments.get(args.stripeInvoiceId);
    if (stored === undefined) {
      // The foreign key to accounts, which Postgres enforces on this insert.
      if (!this.accounts.has(args.accountId)) {
        return Promise.reject(
          Object.assign(new Error('billing_invoice_payments_account_id_fkey'), { code: '23503' }),
        );
      }
      this.invoicePayments.set(args.stripeInvoiceId, copyInvoicePayment(args));
      return Promise.resolve({ outcome: 'inserted', linked: args.line !== null });
    }
    if (stored.accountId !== args.accountId) {
      return Promise.resolve({ outcome: 'account_mismatch', linked: false });
    }
    // The SAME rule the Drizzle repo applies, imported rather than restated.
    const completed = completeInvoicePayment(stored, args);
    if (completed === null) {
      return Promise.resolve({ outcome: 'unchanged', linked: stored.line !== null });
    }
    this.invoicePayments.set(args.stripeInvoiceId, copyInvoicePayment(completed));
    return Promise.resolve({ outcome: 'completed', linked: completed.line !== null });
  }

  listSubscriptionsMissingPeriodStart(args: {
    afterStripeSubscriptionId: string | null;
    limit: number;
  }): Promise<
    Array<{ stripeSubscriptionId: string; stripePriceId: string; currentPeriodEnd: Date | null }>
  > {
    const after = args.afterStripeSubscriptionId;
    const rows = Array.from(this.subs.values())
      .filter((s) => s.currentPeriodStart === null)
      .filter((s) => after === null || s.stripeSubscriptionId > after)
      .sort((a, b) =>
        a.stripeSubscriptionId < b.stripeSubscriptionId
          ? -1
          : a.stripeSubscriptionId > b.stripeSubscriptionId
            ? 1
            : 0,
      )
      .slice(0, args.limit)
      .map((s) => ({
        stripeSubscriptionId: s.stripeSubscriptionId,
        stripePriceId: s.stripePriceId,
        currentPeriodEnd: s.currentPeriodEnd,
      }));
    return Promise.resolve(rows);
  }

  fillSubscriptionPeriodStart(args: {
    stripeSubscriptionId: string;
    currentPeriodStart: Date;
    source: PeriodStartSource;
    billingInterval: BillingInterval | null;
  }): Promise<{ filled: boolean }> {
    const existing = Array.from(this.subs.values()).find(
      (s) => s.stripeSubscriptionId === args.stripeSubscriptionId,
    );
    if (existing === undefined || existing.currentPeriodStart !== null) {
      return Promise.resolve({ filled: false });
    }
    if (
      existing.currentPeriodEnd !== null &&
      existing.currentPeriodEnd.getTime() <= args.currentPeriodStart.getTime()
    ) {
      return Promise.resolve({ filled: false });
    }
    this.subs.set(existing.id, {
      ...existing,
      currentPeriodStart: args.currentPeriodStart,
      periodStartSource: args.source,
      billingInterval: existing.billingInterval ?? args.billingInterval,
    });
    return Promise.resolve({ filled: true });
  }

  setAccountTier(args: {
    accountId: string;
    tier: AccountTier;
    at: Date;
  }): Promise<{ previousTier: AccountTier | null }> {
    const a = this.accounts.get(args.accountId);
    if (!a) return Promise.resolve({ previousTier: null });
    const previousTier = a.tier;
    this.writeTier(a, args.tier);
    return Promise.resolve({ previousTier });
  }

  private writeTier(facet: AccountFacet, tier: AccountTier): void {
    this.accounts.set(facet.id, { ...facet, tier });
    // Only a real transition mirrors: a same-tier write must not evict the
    // auth cache, because "no needless eviction" is itself a pinned contract.
    if (facet.tier !== tier) this.tierMirror?.(facet.id, tier);
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
    this.writeTier(a, args.tier);
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
    // Best remaining active/trialing subscription for the account — or past_due
    // one inside its grace (live-billing audit #3) — most-recently updated wins,
    // else the fallback. Mirrors the Drizzle query.
    const remaining = Array.from(this.subs.values())
      .filter((s) => s.accountId === args.accountId && stillGrants(s, args.at))
      // V-2131 — `id DESC` tiebreak, mirroring the Drizzle ORDER BY.
      .sort(
        (x, y) =>
          y.updatedAt.getTime() - x.updatedAt.getTime() || (y.id > x.id ? 1 : y.id < x.id ? -1 : 0),
      );
    // C1 — floor against the highest-ranked UNEXPIRED crypto entitlement (mirrors
    // the Drizzle union, judged when this runs: see termRunningAt). No rows →
    // byte-identical to before.
    let appliedTier = remaining[0]?.tier ?? args.fallbackTier;
    const runningAt = termRunningAt(args.at);
    for (const e of this.entitlements.values()) {
      if (e.accountId !== args.accountId || e.expiresAt.getTime() <= runningAt) continue;
      if (tierActivationRank(e.tier) > tierActivationRank(appliedTier)) appliedTier = e.tier;
    }
    this.writeTier(a, appliedTier);
    return Promise.resolve({ previousTier, appliedTier });
  }

  setAccountTierToBestActive(args: {
    accountId: string;
    at: Date;
  }): Promise<{ previousTier: AccountTier | null; appliedTier: AccountTier | null }> {
    // Last-hours audit 2026-07-07 (C4) — mirrors the Drizzle
    // setAccountTierToBestActive: set to the HIGHEST-RANKED active/trialing
    // subscription (rank-aware, not most-recently-updated), never downgrading
    // to a fallback. Empty active set / missing account leaves the tier as-is.
    const a = this.accounts.get(args.accountId);
    if (!a) return Promise.resolve({ previousTier: null, appliedTier: null });
    const previousTier = a.tier;
    const active = Array.from(this.subs.values()).filter(
      (s) => s.accountId === args.accountId && BILLED_STATUSES.includes(s.status),
    );
    let appliedTier: AccountTier | null = null;
    for (const row of active) {
      if (appliedTier === null || tierActivationRank(row.tier) > tierActivationRank(appliedTier)) {
        appliedTier = row.tier;
      }
    }
    // C1 — also rank in UNEXPIRED crypto entitlements (mirrors the Drizzle union),
    // so a LOWER active/trialing upsert never wipes a higher crypto-paid tier.
    const runningAt = termRunningAt(args.at);
    for (const e of this.entitlements.values()) {
      if (e.accountId !== args.accountId || e.expiresAt.getTime() <= runningAt) continue;
      if (appliedTier === null || tierActivationRank(e.tier) > tierActivationRank(appliedTier)) {
        appliedTier = e.tier;
      }
    }
    if (appliedTier === null) return Promise.resolve({ previousTier, appliedTier: previousTier });
    this.writeTier(a, appliedTier);
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
      this.writeTier(a, args.tier);
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

/** A stored paid-invoice record never leaves, or enters, the map by reference. */
function copyInvoicePayment(record: InvoicePaymentRecord): InvoicePaymentRecord {
  return { ...record, line: record.line === null ? null : { ...record.line } };
}
