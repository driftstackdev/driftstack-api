// W407.C — drift guard for apps/server/src/services/billing.ts.
// V-082 billing: 3 write ops (checkout-session / trial-pack /
// portal) + 1 read (getBillingState). BillingProvider boundary
// gates Stripe SDK from tests. Drift here either lets a customer
// purchase the trial pack twice (ADR-003 one-per-account violation)
// or skips ensureCustomerId (creates orphan checkout without a
// Stripe customer record).
//
//   • V-082 framing pinned: 3-write + 1-read shape; checkout-session
//     409s on an existing active/trialing subscription (double-
//     subscribe guard — Stripe Checkout does NOT dedupe this for us).
//   • Trial pack: ADR-003 $2.99 one-time one-per-account; portal
//     requires stripe_customer_id (409 if not bootstrapped).
//   • BillingProvider boundary: ensureCustomer + createSubscription
//     Checkout + createTrialPackCheckout + createPortalSession.
//   • SubscriptionMirror.status: 8-literal Stripe enum (incomplete
//     / incomplete_expired / trialing / active / past_due /
//     canceled / unpaid / paused).
//   • createCheckoutSession: tier missing from tierPrices →
//     BadRequestError "contact sales for enterprise"; billing
//     period selects monthly | annual price id.
//   • startTrialPack: ConflictError when trialPackPurchasedAt
//     already set (one-trial-per-account).
//   • createPortalSession: ConflictError when stripe_customer_id
//     null (must complete checkout first).
//   • getBillingState: active = trialPackPurchasedAt!=null AND
//     !redeemed AND expiresAt > now AND creditCents > 0.
//   • ensureCustomerId helper: lazy provisions via
//     provider.ensureCustomer + repo.setStripeCustomerId.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/billing.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W407.C apps/server/src/services/billing.ts content parity', () => {
  const body = read(LIB);

  it('V-082 framing pinned: 2-write (checkout / portal) + 1-read (getBillingState); trial-pack op retired 2026-05-27', () => {
    expect(body).toMatch(/Billing service \(V-082\)\./);
    expect(body).toMatch(
      /1\. Checkout-session — start a paid-tier subscription\. Rejects with\s*\n?\s*\/\/\s*a 409 \(ConflictError\) when the account already has an active or\s*\n?\s*\/\/\s*trialing subscription\./,
    );
    // The double-subscribe guard rationale: Stripe Checkout does NOT
    // dedupe an existing subscription for us — this is the misconception
    // the old comment encoded (and the actual double-billing bug it
    // caused before the guard landed).
    expect(body).toMatch(
      /Stripe Checkout in `subscription` mode\s*\n?\s*\/\/\s*does NOT dedupe this on its own/,
    );
    expect(body).not.toMatch(
      /Stripe handles the\s*\n?\s*\/\/\s*"user already has a sub" path inside Checkout/,
    );
    expect(body).toMatch(
      /2\. Customer portal — open Stripe Customer Portal for self-service\s*\n?\s*\/\/\s*plan change \/ payment-method update \/ cancellation\./,
    );
    expect(body).not.toMatch(/Trial-pack/);
    expect(body).toMatch(
      /Stripe API access is gated behind `BillingProvider` so tests run\s*\n?\s*\/\/\s*against an in-memory provider without touching real Stripe\./,
    );
  });

  // V-741 — the guard now filters the SET (findActiveSubscription) instead of
  // picking the newest ROW by created_at and inspecting its status. created_at is
  // frozen at first-webhook insert, so a canceled row can sort NEWER than a live
  // one, and the old form then let Checkout mint a SECOND concurrently-billed
  // subscription. Reverting to a recency-then-inspect read is proved red by
  // tests/integration/billing.test.ts.
  it('createCheckoutSession: double-subscribe guard — findActiveSubscription + ConflictError, BEFORE the tier-price lookup (so it never reaches the provider)', () => {
    expect(body).toMatch(
      /const existingSubscription = await this\.repo\.findActiveSubscription\(args\.accountId\);\s*if \(existingSubscription !== null\) \{\s*throw new ConflictError\(\s*'Account already has an active subscription\. Use the customer portal to change plans instead of starting a new checkout\.',/,
    );
    // The guard must never go back to reading one row by recency and inspecting
    // its status — that IS the bug.
    expect(body).not.toMatch(/existingSubscription = await this\.repo\.findCurrentSubscription/);
    expect(body).toMatch(
      /resource: 'subscription',\s*\n?\s*existing_tier: existingSubscription\.tier,\s*\n?\s*existing_status: existingSubscription\.status,/,
    );
    // past_due / canceled / etc are intentionally NOT blocked — only
    // active/trialing (currently-billed) subscriptions trigger the guard.
    expect(body).toMatch(
      /past_due \/ canceled \/ incomplete subscriptions are NOT\s*\n?\s*\/\/\s*blocked here: those aren't currently being billed/,
    );
  });

  it('BillingProvider: 3-method boundary carries optional Checkout retry identity', () => {
    expect(body).toMatch(/export interface BillingProvider \{/);
    expect(body).toMatch(
      /ensureCustomer\(args: \{ accountId: string; email: string; name: string \| null \}\): Promise<string>;/,
    );
    expect(body).toMatch(
      /createSubscriptionCheckout\(args: \{\s*\n?\s*customerId: string;\s*\n?\s*priceId: string;\s*\n?\s*successUrl: string;\s*\n?\s*cancelUrl: string;\s*\n?\s*accountId: string;\s*\n?\s*idempotencyKey\?: string;\s*\n?\s*\}\): Promise<\{ url: string; sessionId: string \}>;/,
    );
    expect(body).toMatch(
      /createPortalSession\(args: \{ customerId: string; returnUrl: string \}\): Promise<\{ url: string \}>;/,
    );
  });

  it('createCheckoutSession forwards an optional retry identity without changing absent requests', () => {
    expect(body).toMatch(/idempotencyKey\?: string;/);
    expect(body).toMatch(
      /\.\.\.\(args\.idempotencyKey !== undefined \? \{ idempotencyKey: args\.idempotencyKey \} : \{\}\),/,
    );
  });

  it('BillingAccountSnapshot: 5 fields (id + email + name + tier + stripeCustomerId) — trial-pack quartet removed 2026-05-27', () => {
    expect(body).toMatch(/export interface BillingAccountSnapshot \{/);
    expect(body).toMatch(/stripeCustomerId: string \| null;/);
    expect(body).not.toMatch(/trialPackPurchasedAt/);
  });

  it('SubscriptionMirror.status: 8-literal Stripe enum (incomplete|incomplete_expired|trialing|active|past_due|canceled|unpaid|paused)', () => {
    expect(body).toMatch(
      /status:\s*\n?\s*\| 'incomplete'\s*\n?\s*\| 'incomplete_expired'\s*\n?\s*\| 'trialing'\s*\n?\s*\| 'active'\s*\n?\s*\| 'past_due'\s*\n?\s*\| 'canceled'\s*\n?\s*\| 'unpaid'\s*\n?\s*\| 'paused';/,
    );
  });

  it('createCheckoutSession: NotFoundError on missing account; BadRequestError on tier not in tierPrices (contact sales for enterprise); billingPeriod selects monthly|annual', () => {
    expect(body).toMatch(
      /const account = await this\.repo\.getAccount\(args\.accountId\);\s*\n?\s*if \(account === null\) throw new NotFoundError\('Account not found\.'\);/,
    );
    expect(body).toMatch(
      /if \(prices === undefined\) \{\s*\n?\s*throw new BadRequestError\(\s*\n?\s*`Tier "\$\{args\.tier\}" is not self-serve via Checkout\. Contact sales for enterprise\.`,/,
    );
    expect(body).toMatch(
      /const priceId = args\.billingPeriod === 'monthly' \? prices\.monthly : prices\.annual;/,
    );
  });

  it("createPortalSession: ConflictError when stripeCustomerId null (must complete checkout first); resource:'stripe_customer' metadata", () => {
    expect(body).toMatch(
      /if \(account\.stripeCustomerId === null\) \{\s*\n?\s*throw new ConflictError\(\s*\n?\s*'Account has no Stripe customer record yet\. Complete a checkout flow first\.',\s*\n?\s*\{ resource: 'stripe_customer' \},/,
    );
    expect(body).toMatch(
      /return this\.provider\.createPortalSession\(\{\s*\n?\s*customerId: account\.stripeCustomerId,\s*\n?\s*returnUrl: this\.config\.portalReturnUrl,/,
    );
  });

  it('getBillingState returns subscription only (trial-pack state removed 2026-05-27)', () => {
    expect(body).toMatch(
      /async getBillingState\(accountId: string\): Promise<\{\s*\n?\s*subscription: SubscriptionMirror \| null;\s*\n?\s*\}> \{/,
    );
    expect(body).not.toMatch(/trialPack/);
  });

  it('ensureCustomerId helper: lazy provisions via provider.ensureCustomer + repo.setStripeCustomerId (no-op if already set)', () => {
    expect(body).toMatch(
      /private async ensureCustomerId\(account: BillingAccountSnapshot\): Promise<string> \{\s*\n?\s*if \(account\.stripeCustomerId !== null\) return account\.stripeCustomerId;\s*\n?\s*const customerId = await this\.provider\.ensureCustomer\(\{\s*\n?\s*accountId: account\.id,\s*\n?\s*email: account\.email,\s*\n?\s*name: account\.name,\s*\n?\s*\}\);\s*\n?\s*await this\.repo\.setStripeCustomerId\(\{ accountId: account\.id, customerId \}\);/,
    );
  });

  it('BillingRepo: 4-method (getAccount + setStripeCustomerId + findCurrentSubscription returning the newest row + findActiveSubscription filtering the set)', () => {
    expect(body).toMatch(/export interface BillingRepo \{/);
    expect(body).toMatch(
      /getAccount\(accountId: string\): Promise<BillingAccountSnapshot \| null>;/,
    );
    expect(body).toMatch(
      /setStripeCustomerId\(args: \{ accountId: string; customerId: string \}\): Promise<void>;/,
    );
    // V-741 — the old doc said "Returns the active or most-recent subscription
    // ... 'Active' here is loose", and this pin required that sentence. The
    // implementation never did the "active" half: it is only ever most-recent,
    // which is exactly how it came to be used as a double-subscribe guard. The
    // doc now says what it does, and names the method that does the other thing.
    expect(body).toMatch(
      /Returns the MOST-RECENT subscription row for the account by `created_at`,/,
    );
    expect(body).not.toMatch(/Returns the active or most-recent subscription/);
    expect(body).toMatch(
      /findCurrentSubscription\(accountId: string\): Promise<SubscriptionMirror \| null>;/,
    );
    expect(body).toMatch(
      /findActiveSubscription\(accountId: string\): Promise<SubscriptionMirror \| null>;/,
    );
  });

  it('TierPriceMap + TierPrices: monthly + annual partial-record per tier; BillingServiceConfig URL shape (trialPackPriceId removed 2026-05-27)', () => {
    expect(body).toMatch(
      /export interface TierPrices \{\s*\n?\s*monthly: string;\s*\n?\s*annual: string;\s*\n?\s*\}/,
    );
    expect(body).toMatch(/export type TierPriceMap = Partial<Record<AccountTier, TierPrices>>;/);
    expect(body).toMatch(/export interface BillingServiceConfig \{/);
    expect(body).toMatch(
      /\/\*\* Map of self-serve paid tier to monthly \+ annual Stripe price ids\. \*\/\s*\n?\s*tierPrices: TierPriceMap;/,
    );
    expect(body).not.toMatch(/trialPackPriceId/);
    expect(body).toMatch(/defaultSuccessUrl: string;/);
    expect(body).toMatch(/defaultCancelUrl: string;/);
    expect(body).toMatch(/portalReturnUrl: string;/);
  });

  it('imports: AccountTier + BadRequestError + ConflictError + NotFoundError', () => {
    expect(body).toMatch(/import type \{ AccountTier \} from '@driftstack\/api-types';/);
    expect(body).toMatch(
      /import \{ BadRequestError, ConflictError, NotFoundError \} from '\.\.\/lib\/errors\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
