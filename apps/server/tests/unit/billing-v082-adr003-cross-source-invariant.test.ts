// W939 — V-082 + ADR-003 billing service cross-source invariant.
// Two-hundred-sixty-fifth in the drift-guard series. Pins the
// customer-facing billing service:
//
//   V-082 anchor — 'Billing service (V-082)'.
//
//   3 customer-facing operations:
//     1. Checkout-session — start paid-tier subscription. Idempotent
//        from customer perspective: hitting create twice returns 2
//        valid Checkout URLs (Stripe handles "user already has sub"
//        inside Checkout).
//     2. Trial-pack — $2.99 one-time pre-paid credit per ADR-003.
//        Same Checkout shell, one-time price id (not a sub).
//     3. Customer portal — Stripe Customer Portal for self-service
//        plan change / payment-method / cancellation. Requires
//        stripe_customer_id set; 409 on missing.
//
//   Plus 1 read:
//     4. GetBillingState — subscription row + trial-pack state for
//        dashboard plan + remaining-credit render.
//
//   BillingProvider Stripe SDK boundary — gated for in-memory test
//   provider; 4 methods: ensureCustomer + createSubscriptionCheckout
//   + createTrialPackCheckout + createPortalSession.
//
//   BillingAccountSnapshot (9 fields):
//     - id + email + name (nullable) + tier + stripeCustomerId
//       (nullable) + trialPackPurchasedAt (nullable) +
//       trialPackCreditCents (nullable) + trialPackExpiresAt
//       (nullable) + trialPackRedeemed.
//
//   SubscriptionMirror (10 fields, 8-value status union):
//     - id + accountId + stripeSubscriptionId + stripePriceId + tier
//     - status: 'incomplete' | 'incomplete_expired' | 'trialing' |
//       'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused'
//     - currentPeriodEnd (nullable) + cancelAtPeriodEnd + canceledAt
//       (nullable) + createdAt + updatedAt.
//
//   BillingServiceConfig (5 fields): tierPrices (TierPriceMap) +
//     trialPackPriceId + defaultSuccessUrl + defaultCancelUrl +
//     portalReturnUrl.
//
//   TierPrices 2-period split: monthly + annual.
//
// stays in lockstep across apps/server/src/services/billing.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W939 V-082 + ADR-003 billing cross-source invariant', () => {
  // ─── V-082 anchor + 3-op + 1-read framing ────────────────────

  it("CRITICAL apps/server/src/services/billing.ts header pins V-082 anchor — 'Billing service (V-082)'. The V-082 anchor is the policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/billing.ts'));
    expect(p).toMatch(/Billing service \(V-082\)\./);
  });

  it("CRITICAL 2-operation framing — 'Two customer-facing operations: 1. Checkout-session 2. Customer portal'. The 2-op + 1-read surface is the customer-facing API (Trial-pack op removed 2026-05-27 with the trial_pack retirement).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/billing.ts'));
    expect(p).toMatch(/Two customer-facing operations:/);
    expect(p).toMatch(/1\. Checkout-session — start a paid-tier subscription/);
    expect(p).toMatch(/2\. Customer portal — open Stripe Customer Portal for self-service/);
    expect(p).toMatch(/Plus one read:/);
    expect(p).toMatch(/3\. GetBillingState — current subscription row \(if any\)/);
    expect(p).not.toMatch(/Trial-pack/);
  });

  // ─── Checkout double-subscribe guard ──────────────────────────
  //
  // The old framing here ("Idempotent ... Stripe handles the 'user
  // already has a sub' path inside Checkout") encoded a real
  // misconception: Stripe Checkout in `subscription` mode does NOT
  // dedupe against an existing subscription — it mints a second
  // concurrent one, double-billing the customer. The comment (and the
  // code) were fixed together: a 409 (ConflictError) on an existing
  // active/trialing subscription, enforced server-side in
  // createCheckoutSession, independent of dashboard UI behavior.

  it("CRITICAL checkout double-subscribe guard framing — 'Rejects with a 409 (ConflictError) when the account already has an active or trialing subscription' + 'Stripe Checkout in `subscription` mode does NOT dedupe this on its own'. Replaces the old (incorrect) 'Stripe handles the already-has-a-sub path' claim that caused a real double-billing bug.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/billing.ts'));
    expect(p).toMatch(
      /Rejects with\s*\n\/\/\s+a 409 \(ConflictError\) when the account already has an active or\s*\n\/\/\s+trialing subscription\./,
    );
    expect(p).toMatch(
      /Stripe Checkout in `subscription` mode\s*\n\/\/\s+does NOT dedupe this on its own/,
    );
    expect(p).not.toMatch(
      /Stripe handles the\s*\n\/\/\s+"user already has a sub" path inside Checkout/,
    );
  });

  // ─── ADR-003 trial-pack retired 2026-05-27 ───────────────────

  it('CRITICAL trial-pack billing op fully retired 2026-05-27 — billing.ts no longer documents a one-time $2.99 trial-pack operation (replaced by the perpetual free tier).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/billing.ts'));
    expect(p).not.toMatch(/Trial-pack/);
    expect(p).not.toMatch(/\$2\.99/);
  });

  // ─── Customer portal 409 on missing customer ─────────────────

  it("CRITICAL portal-409 framing — 'Customer portal — open Stripe Customer Portal for self-service plan change / payment-method update / cancellation. Requires the account to have a stripe_customer_id set; failure to bootstrap one before portal is a 409'. The 409-on-missing-customer-id prevents portal open without an existing customer.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/billing.ts'));
    expect(p).toMatch(/Customer portal — open Stripe Customer Portal for self-service/);
    expect(p).toMatch(/plan change \/ payment-method update \/ cancellation\. Requires/);
    expect(p).toMatch(/the account to have a `stripe_customer_id` set; failure to/);
    expect(p).toMatch(/bootstrap one before portal is a 409/);
  });

  // ─── BillingProvider Stripe SDK boundary ─────────────────────

  it("CRITICAL BillingProvider framing — 'Stripe API access is gated behind BillingProvider so tests run against an in-memory provider without touching real Stripe'. The provider-gating lets tests substitute without Stripe credentials.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/billing.ts'));
    expect(p).toMatch(/Stripe API access is gated behind `BillingProvider` so tests run/);
    expect(p).toMatch(/against an in-memory provider without touching real Stripe/);
  });

  it('CRITICAL BillingProvider has 5 methods, and this arm pins 3 of them — ensureCustomer + createSubscriptionCheckout + createPortalSession (createTrialPackCheckout removed 2026-05-27). The two it does not pin are pauseSubscriptionCollection and resumeSubscriptionCollection, added by V-758 to make the acceptable-use policy true where it says suspension pauses billing.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/billing.ts'));
    expect(p).toMatch(/export interface BillingProvider \{/);
    expect(p).toMatch(
      /ensureCustomer\(args: \{ accountId: string; email: string; name: string \| null \}\): Promise<string>;/,
    );
    expect(p).toMatch(/createSubscriptionCheckout\(args: \{/);
    expect(p).not.toMatch(/createTrialPackCheckout/);
    expect(p).toMatch(
      /createPortalSession\(args: \{ customerId: string; returnUrl: string \}\): Promise<\{ url: string \}>;/,
    );
  });

  it("CRITICAL ensureCustomer JSDoc — 'Look up or create a Stripe customer for this account. Returns the customer id (cus_...)'. The look-up-or-create idempotence + cus_-prefix return matches Stripe customer-id convention.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/billing.ts'));
    expect(p).toMatch(
      /Look up or create a Stripe customer for this account\. Returns the customer id \(cus_\.\.\.\)/,
    );
  });

  // ─── BillingAccountSnapshot 9-field shape ────────────────────

  it('CRITICAL BillingAccountSnapshot has 5 fields — id + email + name (nullable) + tier + stripeCustomerId (nullable); trial-pack quartet removed 2026-05-27.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/billing.ts'));
    expect(p).toMatch(/export interface BillingAccountSnapshot \{/);
    expect(p).toMatch(/id: string;/);
    expect(p).toMatch(/email: string;/);
    expect(p).toMatch(/name: string \| null;/);
    expect(p).toMatch(/tier: AccountTier;/);
    expect(p).toMatch(/stripeCustomerId: string \| null;/);
    expect(p).not.toMatch(/trialPackPurchasedAt/);
  });

  // ─── SubscriptionMirror 8-status enum ────────────────────────

  it("CRITICAL SubscriptionMirror.status 8-value union — 'incomplete' | 'incomplete_expired' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused'. The 8-status set mirrors Stripe subscription status enum.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/billing.ts'));
    expect(p).toMatch(/status:\s*\n\s*\| 'incomplete'/);
    expect(p).toMatch(/\| 'incomplete_expired'/);
    expect(p).toMatch(/\| 'trialing'/);
    expect(p).toMatch(/\| 'active'/);
    expect(p).toMatch(/\| 'past_due'/);
    expect(p).toMatch(/\| 'canceled'/);
    expect(p).toMatch(/\| 'unpaid'/);
    expect(p).toMatch(/\| 'paused';/);
  });

  // ─── SubscriptionMirror 11-field shape ───────────────────────

  it('CRITICAL SubscriptionMirror has 11 fields — id + accountId + stripeSubscriptionId + stripePriceId + tier + status + currentPeriodEnd (nullable) + cancelAtPeriodEnd + canceledAt (nullable) + createdAt + updatedAt. The 11-field mirror is the local read-shadow of Stripe state.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/billing.ts'));
    expect(p).toMatch(/export interface SubscriptionMirror \{/);
    expect(p).toMatch(/stripeSubscriptionId: string;/);
    expect(p).toMatch(/stripePriceId: string;/);
    expect(p).toMatch(/tier: AccountTier;/);
    expect(p).toMatch(/currentPeriodEnd: Date \| null;/);
    expect(p).toMatch(/cancelAtPeriodEnd: boolean;/);
    expect(p).toMatch(/canceledAt: Date \| null;/);
  });

  // ─── BillingRepo 3-method interface ──────────────────────────

  it('CRITICAL BillingRepo has 5 methods, and this arm pins 3 of them — getAccount + setStripeCustomerId + findCurrentSubscription. The seam also carries findCollectingSubscription and findActiveSubscription.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/billing.ts'));
    expect(p).toMatch(/export interface BillingRepo \{/);
    expect(p).toMatch(/getAccount\(accountId: string\): Promise<BillingAccountSnapshot \| null>;/);
    expect(p).toMatch(
      /setStripeCustomerId\(args: \{ accountId: string; customerId: string \}\): Promise<void>;/,
    );
    expect(p).toMatch(
      /findCurrentSubscription\(accountId: string\): Promise<SubscriptionMirror \| null>/,
    );
  });

  // V-741 — this pin previously required the JSDoc "Returns the active or
  // most-recent subscription ... 'Active' here is loose — caller filters by
  // status if needed", and its own title gave the rationale: "the active-is-loose
  // framing keeps repo-level scope wide; service layer applies status filtering."
  //
  // That rationale IS the bug. The service layer did apply status filtering — to
  // the wrong row. findCurrentSubscription returns the newest row by created_at,
  // which is frozen at first-webhook insert, so a canceled row can sort newer
  // than a live one; the guard then read 'canceled' and let Checkout mint a
  // second concurrently-billed subscription. A guard must filter the SET, not
  // inspect a row chosen by recency. The pin now requires the honest doc and the
  // set-filtering sibling.
  it('CRITICAL findCurrentSubscription JSDoc says MOST-RECENT-row only, and points at findActiveSubscription for the guard question', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/billing.ts'));
    expect(p).toMatch(/Returns the MOST-RECENT subscription row for the account by `created_at`,/);
    expect(p).toMatch(/NOT usable as a double-subscribe guard/);
    expect(p).toMatch(
      /findActiveSubscription\(accountId: string\): Promise<SubscriptionMirror \| null>;/,
    );
    // The framing that justified the flawed design must not return.
    expect(p).not.toMatch(/"Active" here is loose/);
  });

  // ─── TierPrices 2-period shape + TierPriceMap ────────────────

  it('CRITICAL TierPrices has 2 fields — monthly + annual. The 2-period split is the per-tier pricing dimensionality.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/billing.ts'));
    expect(p).toMatch(/export interface TierPrices \{/);
    expect(p).toMatch(/monthly: string;/);
    expect(p).toMatch(/annual: string;/);
  });

  it("CRITICAL TierPriceMap = Partial<Record<AccountTier, TierPrices>> — partial because not every tier is self-serve paid (e.g. 'free' tier has no Stripe prices). The Partial-by-design keeps free-tier representable.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/billing.ts'));
    expect(p).toMatch(/export type TierPriceMap = Partial<Record<AccountTier, TierPrices>>;/);
  });

  // ─── BillingServiceConfig 5-field shape ──────────────────────

  it('CRITICAL BillingServiceConfig has 4 fields — tierPrices (TierPriceMap) + defaultSuccessUrl + defaultCancelUrl + portalReturnUrl; trialPackPriceId removed 2026-05-27. The config is the boot-time billing-wiring surface.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/billing.ts'));
    expect(p).toMatch(/export interface BillingServiceConfig \{/);
    expect(p).toMatch(/Map of self-serve paid tier to monthly \+ annual Stripe price ids/);
    expect(p).toMatch(/tierPrices: TierPriceMap;/);
    expect(p).not.toMatch(/trialPackPriceId/);
    expect(p).toMatch(/Default success \/ cancel URLs \(customer dashboard\)/);
    expect(p).toMatch(/defaultSuccessUrl: string;/);
    expect(p).toMatch(/defaultCancelUrl: string;/);
    expect(p).toMatch(/URL Stripe redirects back to after the customer portal closes/);
    expect(p).toMatch(/portalReturnUrl: string;/);
  });

  // ─── 3-error class import ────────────────────────────────────

  it('CRITICAL billing imports 3 error classes — BadRequestError + ConflictError + NotFoundError. The 3-error palette covers input-validation / state-conflict / row-missing.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/billing.ts'));
    expect(p).toMatch(
      /import \{ BadRequestError, ConflictError, NotFoundError \} from '\.\.\/lib\/errors\.js';/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/billing-v082-adr003-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
