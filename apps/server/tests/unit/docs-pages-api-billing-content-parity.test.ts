// W765 — apps/docs api/billing.md content parity. Ninety-first in
// the cross-SDK drift-guard series.
//
// /api/billing is the canonical reference for the Stripe-thin-layer
// billing model + the $2.99 trial pack. Drift to the once-per-account
// or to the no-team-RBAC framing would mismatch W751 dashboard
// /billing customer-comms + the V-326e team-roles taxonomy.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/billing.md');

describe('W765 docs /api/billing content parity', () => {
  it('api/billing.md file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL frontmatter title + description pinned. Matches W760 /api index "Subscriptions, Stripe Customer Portal redirect, billing-state read" framing (trial pack retired 2026-05-27).', () => {
    const p = read(PAGE);

    expect(p).toMatch(/^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: Billing\n/);
    expect(p).toMatch(
      /description: Subscriptions, the Stripe Customer Portal redirect, and reading your current billing state\./,
    );
    expect(p).not.toMatch(/trial pack/);
  });

  it("CRITICAL thin-layer-over-Stripe framing pinned. The 'All Driftstack billing is a thin layer over Stripe. The Driftstack API mints checkout sessions + portal URLs; the customer interacts with the Stripe-hosted UI directly' wording is the load-bearing PCI-out-of-scope architecture framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/All Driftstack billing is a thin layer over Stripe\./);
    expect(p).toMatch(
      /The Driftstack\s*\n?API mints checkout sessions \+ portal URLs; the customer interacts\s*\n?with the Stripe-hosted UI directly\./,
    );
  });

  it('CRITICAL Stripe-webhook-events-reflected framing pinned. The "Driftstack receives webhook events from Stripe (`invoice.paid`, `customer.subscription.updated`, etc.) and reflects them into the account\'s subscription row + audit-log + email notifications" wording explains the inbound webhook flow.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Driftstack receives webhook/);
    expect(p).toMatch(
      /events from Stripe \(`invoice\.paid`, `customer\.subscription\.updated`,\s*\n?etc\.\) and reflects them into the account's `subscription` row \+/,
    );
    expect(p).toMatch(/audit-log \+ email notifications\./);
  });

  it('CRITICAL GET /v1/billing response shape pinned — subscription only (trial_pack envelope removed 2026-05-27). Matches publicSubscription() in apps/server/src/routes/billing.ts and SubscriptionSchema in packages/api-types/src/billing.ts. The previous pin asserted fictional fields (`id`, `billing_period`, `current_period_start`) that the route never returns + omitted real fields (`stripe_subscription_id`, `canceled_at`, `created_at`, `updated_at`). Refreshed against the source-of-truth.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/"subscription": \{/);
    expect(p).toMatch(/"tier": "api_builder"/);
    expect(p).toMatch(/"status": "active"/);
    // Real fields per publicSubscription() at billing.ts:66.
    expect(p).toMatch(/"stripe_subscription_id":/);
    expect(p).toMatch(/"current_period_end":/);
    expect(p).toMatch(/"cancel_at_period_end": false/);
    expect(p).toMatch(/"canceled_at": null/);
    expect(p).toMatch(/"created_at":/);
    expect(p).toMatch(/"updated_at":/);
    // Fictional fields must NOT appear in the GET /v1/billing response
    // shape — drift-guard-reinforces-wrong failure mode (same pattern
    // as marketing hero / archetype slug / dashboard /usage claim
    // earlier this session). Scope the negatives to just the response
    // block (billing_period IS legitimately a field on the SEPARATE
    // CreateCheckoutSessionRequest, so a page-wide not-match would
    // wrongly fire on that block).
    const responseBlockStart = p.indexOf('"subscription": {');
    const responseBlockEnd = p.indexOf('## Start a subscription', responseBlockStart);
    const responseBlock = p.slice(responseBlockStart, responseBlockEnd);
    expect(responseBlock).not.toMatch(/"id": "sub_<uuid>"/);
    expect(responseBlock).not.toMatch(/"billing_period":/);
    expect(responseBlock).not.toMatch(/"current_period_start":/);
    // trial_pack envelope removed 2026-05-27 — the GET /v1/billing
    // response no longer carries it (the route returns subscription only).
    expect(p).not.toMatch(/"trial_pack": \{/);
  });

  it("CRITICAL subscription-null-on-never-subscribed framing pinned. The 'subscription is null when the account has never subscribed' wording is the load-bearing customer-state framing — drift would let SDK consumers crash on null.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/`subscription` is `null` when the account has never subscribed\./);
  });

  it('CRITICAL trial_pack billing-state framing fully removed 2026-05-27 — the doc no longer documents a trial_pack.active / 14-day-window field (the GET /v1/billing response carries subscription only).', () => {
    const p = read(PAGE);

    expect(p).not.toMatch(/trial_pack\.active/);
    expect(p).not.toMatch(/14-day window/);
  });

  it('CRITICAL POST /v1/billing/checkout-session body shape pinned — tier + billing_period + success_url + cancel_url. Drift to dropping a field would break the SDK flow.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/"tier": "api_builder",/);
    expect(p).toMatch(/"billing_period": "monthly",/);
    expect(p).toMatch(/"success_url":/);
    expect(p).toMatch(/"cancel_url":/);
  });

  it("CRITICAL return-URL allowlist framing pinned. V-754 removed 'Customers self-hosting Driftstack configure the allowlist in their deployment env' — ALLOWED_RETURN_ORIGINS is a hardcoded 3-origin constant whose own comment refuses env-driving, because a typo in env config would silently re-open the redirect hole. The page now documents the hardcoded list AND the omit-the-fields path that actually works for a self-hoster.", () => {
    const p = read(PAGE);

    // The real defense: hardcoded, not env-configurable.
    expect(p).toMatch(/validated against a \*\*hardcoded\*\* allowlist/);
    expect(p).toMatch(/deliberately not env-driven/);
    // The working path a self-hoster needs, which the old text hid behind a
    // non-existent env var: both fields are optional and the server substitutes
    // its own configured return URLs, bypassing the check entirely.
    expect(p).toMatch(/Both URL fields are optional/);
    expect(p).toMatch(/STRIPE_SUCCESS_URL/);
    // The false instruction must not return.
    expect(p).not.toMatch(/self-hosting Driftstack configure the allowlist/);
  });

  it('CRITICAL trial-pack pricing section fully removed 2026-05-27 — the doc no longer documents a one-time $2.99 / 299¢ trial pack (replaced by the perpetual free tier).', () => {
    const p = read(PAGE);

    expect(p).not.toMatch(/\$2\.99/);
    expect(p).not.toMatch(/299¢/);
    expect(p).not.toMatch(/Start the trial pack/);
  });

  it("CRITICAL portal-URL single-use + short-lived + no-cache framing pinned. The 'The portal URL is single-use and short-lived. Mint a fresh one each time the customer clicks \"Manage subscription\" — don\\'t cache' wording is the load-bearing SDK-consumer guidance.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The portal URL is single-use and short-lived\. Mint a fresh one\s*\n?each time the customer clicks "Manage subscription" — don't cache\./,
    );
  });

  it("CRITICAL Stripe-customer-portal capabilities-list pinned — 'manages their payment method, downloads invoices, cancels, or upgrades / downgrades'. Matches W758 /subscription page 'Open Stripe portal' CTA + W751 dashboard /billing 'cancellation goes through Stripe portal' framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The customer manages their payment method, downloads\s*\n?invoices, cancels, or upgrades \/ downgrades from the portal\./,
    );
  });

  it('CRITICAL subscription.tier_changed audit-log payload framing pinned. Matches W755 /audit-log V-399 subscription.tier_changed `from → to` payload hint.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /records the change in the account's audit log\s*\n?\(`subscription\.tier_changed` with `payload\.from` \+ `payload\.to`\)/,
    );
  });

  it('CRITICAL current subscription-change programmatic source is the audit-log API', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /That audit row is the source of truth for programmatic subscription-change\s*\n?consumers; it is available through the account audit-log API\./,
    );
    expect(p).not.toMatch(/planned|subscription\.changed|subscription\.cancelled/i);
  });

  it("CRITICAL billing act-as framing pinned — GET /v1/billing DOES honor X-Driftstack-Account (V-326c), mutations do NOT. S36 2026-07-07 (fable-truth-audit): the old blanket 'they do NOT honor the header / team members never see the owner's billing state' claim was FALSE — routes/billing.ts GET /v1/billing calls resolveEffectiveAccount(readEffectiveAccountHeader(req)) and returns the OWNER's subscription state to an acting-as team member; only checkout-session / portal-session / billing-portal ignore the header.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /with one read exception: `GET \/v1\/billing`\s*\n?honors the team-RBAC `X-Driftstack-Account` header, so a team\s*\n?member acting as the owner reads the OWNER's subscription state/,
    );
    expect(p).toMatch(
      /The mutation endpoints \(checkout-session,\s*\n?portal-session, billing-portal\) do NOT honor the header — only the\s*\n?owner manages the owner's billing\./,
    );
    // S46 2026-07-07 (founder-approved) — GET /v1/billing now enforces the
    // read:billing scope floor (was the V-481 residual: declared in the enum,
    // enforced nowhere). Broad read / account_owner satisfy per V-481.
    expect(p).toMatch(
      /Reading billing state \(`GET \/v1\/billing`\) requires the\s*\n?`read:billing` scope — a broad `read` or `account_owner` key\s*\n?\(the dashboard's web-session scope set\) also satisfies it, but a\s*\n?write-only key is refused with 403/,
    );
    // Negative pin — the pre-S46 "no scope" claim must not come back.
    expect(p).not.toMatch(/requires no specific\s*\n?API-key scope/);
    // Mutation endpoints require admin:billing (broad admin / account_owner satisfy).
    expect(p).toMatch(
      /mutation endpoints \(checkout,\s*\n?manage-portal\) require the `admin:billing` scope \(a broad `admin`\s*\n?or `account_owner` key also satisfies it\)\./,
    );
    // Negative pin — the retired blanket no-act-as claim must not come back.
    expect(p).not.toMatch(/billing is always per-account/);
    expect(p).not.toMatch(/members never see the owner's billing state/);
  });

  it('CRITICAL 3-endpoint canonical action set pinned — GET /v1/billing + POST /v1/billing/checkout-session + POST /v1/billing/portal-session (trial-pack endpoint retired 2026-05-27).', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`GET \/v1\/billing`/);
    expect(p).toMatch(/`POST \/v1\/billing\/checkout-session`/);
    expect(p).toMatch(/`POST \/v1\/billing\/portal-session`/);
    expect(p).not.toMatch(/`POST \/v1\/billing\/trial-pack`/);
  });

  it('CRITICAL checkout response shape — { checkout_url, checkout_session_id } pinned. Drift would mismatch SDK consumer expectations.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Returns `\{ checkout_url, checkout_session_id \}`/);
  });

  it('CRITICAL TS SDK example uses client.billing.getState() + client.billing.createPortalSession() method names — matching BillingResource (the SDK has no startPortalSession; createPortalSession is the real method). Drift to a different SDK method name would force documentation/typedef-regen mismatches.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/const state = await client\.billing\.getState\(\);/);
    expect(p).toMatch(/const \{ portal_url \} = await client\.billing\.createPortalSession\(\);/);
  });

  it("CRITICAL Stripe-handles-card-collection-3DS-tax framing pinned. The 'Stripe handles card collection + 3DS + tax compliance and posts the result back to your success_url' wording is the load-bearing PCI/compliance attribution.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Stripe handles card collection \+\s*\n?3DS \+ tax compliance and posts the result back to your\s*\n?`success_url`\./,
    );
  });

  it('CRITICAL Stripe-to-Driftstack lifecycle section points consumers to the account audit-log API', () => {
    const p = read(PAGE);

    expect(p).toMatch(/## Webhook events from Stripe → Driftstack → Customer/);
    expect(p).toMatch(/available through the account audit-log API/);
    expect(p).not.toMatch(/\[Webhook events catalog\]\(\/webhooks\/events\/\)/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/docs-pages-api-billing-content-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
