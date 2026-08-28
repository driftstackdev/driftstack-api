// In-memory BillingRepo + BillingProvider for integration tests.

import { randomUUID } from 'node:crypto';
import type {
  BillingAccountSnapshot,
  BillingProvider,
  BillingRepo,
  SubscriptionMirror,
} from '../../../src/services/billing.js';
import {
  ACTIVE_SUBSCRIPTION_STATUSES,
  COLLECTING_SUBSCRIPTION_STATUSES,
} from '../../../src/db/subscription-status-sets.js';

/**
 * V-2131 — mirrors the SQL `ORDER BY created_at DESC, id DESC`: newer wins, and a
 * created_at tie goes to the greater id. Before this the double kept the FIRST
 * inserted row on a tie while Postgres returned whichever the scan reached, so the
 * two halves of the contract could disagree on identical data.
 */
function newerThan(
  a: { createdAt: Date; id: string },
  b: { createdAt: Date; id: string },
): boolean {
  const dt = a.createdAt.getTime() - b.createdAt.getTime();
  return dt > 0 || (dt === 0 && a.id > b.id);
}

export class InMemoryBillingRepo implements BillingRepo {
  private readonly accounts = new Map<string, BillingAccountSnapshot>();
  private readonly subscriptions = new Map<string, SubscriptionMirror>();

  /** Test seam: register or update an account snapshot. */
  upsertAccount(snap: BillingAccountSnapshot): void {
    this.accounts.set(snap.id, snap);
  }

  /** Test seam: record a subscription mirror row. */
  upsertSubscription(s: SubscriptionMirror): void {
    this.subscriptions.set(s.id, s);
  }

  getAccount(accountId: string): Promise<BillingAccountSnapshot | null> {
    const snap = this.accounts.get(accountId);
    return Promise.resolve(snap ? { ...snap } : null);
  }

  setStripeCustomerId(args: { accountId: string; customerId: string }): Promise<void> {
    const a = this.accounts.get(args.accountId);
    if (a) this.accounts.set(args.accountId, { ...a, stripeCustomerId: args.customerId });
    return Promise.resolve();
  }

  /** V-741 — filters the SET, mirroring the Drizzle sibling. The old guard read
   *  the newest ROW regardless of status, so a canceled row sorting newer than a
   *  live one let a second concurrently-billed subscription through. This twin
   *  also picked max createdAt, which is why no existing test could catch it. */
  findActiveSubscription(accountId: string): Promise<SubscriptionMirror | null> {
    let found: SubscriptionMirror | null = null;
    for (const s of this.subscriptions.values()) {
      if (s.accountId !== accountId) continue;
      if (!(ACTIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(s.status)) continue;
      if (found === null || newerThan(s, found)) found = s;
    }
    return Promise.resolve(found);
  }

  /** V-767 twin — the set whose collection is still running. Mirrors the SQL exactly:
   *  filters status FIRST, then picks the newest of what survives, so a canceled row
   *  sorting newer than a live one cannot win. */
  findCollectingSubscription(accountId: string): Promise<SubscriptionMirror | null> {
    let found: SubscriptionMirror | null = null;
    for (const s of this.subscriptions.values()) {
      if (s.accountId !== accountId) continue;
      if (!(COLLECTING_SUBSCRIPTION_STATUSES as readonly string[]).includes(s.status)) continue;
      if (found === null || newerThan(s, found)) found = s;
    }
    return Promise.resolve(found);
  }

  findCurrentSubscription(accountId: string): Promise<SubscriptionMirror | null> {
    let latest: SubscriptionMirror | null = null;
    for (const s of this.subscriptions.values()) {
      if (s.accountId !== accountId) continue;
      if (latest === null || newerThan(s, latest)) latest = s;
    }
    return Promise.resolve(latest);
  }
}

export interface InMemoryProviderState {
  customers: Map<string, { id: string; accountId: string; email: string; name: string | null }>;
  checkoutSessions: Array<{
    id: string;
    customerId: string;
    accountId: string;
    priceId: string;
    idempotencyKey: string | null;
    kind: 'subscription';
  }>;
  portalSessions: Array<{ id: string; customerId: string }>;
  /** V-758 — subscription ids currently pause_collection'd, for suspension assertions. */
  pausedSubscriptions: Set<string>;
}

export class InMemoryBillingProvider implements BillingProvider {
  readonly state: InMemoryProviderState = {
    customers: new Map(),
    checkoutSessions: [],
    portalSessions: [],
    pausedSubscriptions: new Set(),
  };

  ensureCustomer(args: { accountId: string; email: string; name: string | null }): Promise<string> {
    // Look up existing customer by accountId (1:1 in this stub).
    for (const c of this.state.customers.values()) {
      if (c.accountId === args.accountId) return Promise.resolve(c.id);
    }
    const id = `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    this.state.customers.set(id, {
      id,
      accountId: args.accountId,
      email: args.email,
      name: args.name,
    });
    return Promise.resolve(id);
  }

  createSubscriptionCheckout(args: {
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    accountId: string;
    idempotencyKey?: string;
  }): Promise<{ url: string; sessionId: string }> {
    const sessionId = `cs_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    this.state.checkoutSessions.push({
      id: sessionId,
      customerId: args.customerId,
      accountId: args.accountId,
      priceId: args.priceId,
      idempotencyKey: args.idempotencyKey ?? null,
      kind: 'subscription',
    });
    void args.successUrl;
    void args.cancelUrl;
    return Promise.resolve({
      url: `https://checkout.stripe.example/${sessionId}`,
      sessionId,
    });
  }

  createPortalSession(args: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
    const id = `bps_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    this.state.portalSessions.push({ id, customerId: args.customerId });
    void args.returnUrl;
    return Promise.resolve({
      url: `https://billing.stripe.example/p/${id}`,
    });
  }

  // V-758 — mirrors the Stripe provider's pause/resume. Idempotent in both directions,
  // matching the real API: re-pausing an already-paused sub and clearing an unpaused one
  // are both no-ops server-side.
  pauseSubscriptionCollection(args: { subscriptionId: string }): Promise<void> {
    this.state.pausedSubscriptions.add(args.subscriptionId);
    return Promise.resolve();
  }

  resumeSubscriptionCollection(args: { subscriptionId: string }): Promise<void> {
    this.state.pausedSubscriptions.delete(args.subscriptionId);
    return Promise.resolve();
  }
}
