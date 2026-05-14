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

  it('CRITICAL frontmatter title + description pinned. Matches W760 /api index "$2.99 trial pack, Stripe Customer Portal redirect, billing-state read" framing.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: Billing\n/);
    expect(p).toMatch(
      /description: Subscriptions, the \$2\.99 trial pack, the Stripe Customer Portal redirect, and reading your current billing state\./,
    );
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

  it('CRITICAL GET /v1/billing response shape pinned — subscription + trial_pack. Matches W751 dashboard /billing live-fetch + W748 dashboard-home index trial-pack credit display.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/"subscription": \{/);
    expect(p).toMatch(/"tier": "api_builder"/);
    expect(p).toMatch(/"status": "active"/);
    expect(p).toMatch(/"billing_period": "monthly"/);
    expect(p).toMatch(/"current_period_start":/);
    expect(p).toMatch(/"current_period_end":/);
    expect(p).toMatch(/"cancel_at_period_end": false/);
    expect(p).toMatch(/"trial_pack": \{/);
    expect(p).toMatch(/"active": false/);
    expect(p).toMatch(/"credit_cents_remaining": 0/);
    expect(p).toMatch(/"expires_at": null/);
    expect(p).toMatch(/"redeemed": false/);
  });

  it("CRITICAL subscription-null-on-never-subscribed framing pinned. The 'subscription is null when the account has never subscribed' wording is the load-bearing customer-state framing — drift would let SDK consumers crash on null.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/`subscription` is `null` when the account has never subscribed\./);
  });

  it("CRITICAL trial_pack.active 14-day window framing pinned. The 'trial_pack.active is true while the customer has unspent credit and the 14-day window hasn\\'t elapsed' wording is the canonical 14-day trial TTL.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`trial_pack\.active` is `true` while the customer has unspent\s*\n?credit and the 14-day window hasn't elapsed\./,
    );
  });

  it('CRITICAL POST /v1/billing/checkout-session body shape pinned — tier + billing_period + success_url + cancel_url. Drift to dropping a field would break the SDK flow.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/"tier": "api_builder",/);
    expect(p).toMatch(/"billing_period": "monthly",/);
    expect(p).toMatch(/"success_url":/);
    expect(p).toMatch(/"cancel_url":/);
  });

  it("CRITICAL success_url + cancel_url allowlist framing pinned. The 'success_url and cancel_url are validated against an allowlist' + 'Customers self-hosting Driftstack configure the allowlist in their deployment env' wording is the load-bearing CSRF/redirect defense.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/`success_url` and `cancel_url` are validated against an allowlist/);
    expect(p).toMatch(/Customers self-hosting Driftstack configure the allowlist/);
  });

  it('CRITICAL trial-pack $2.99 + 299¢ + $0.18-per-concurrent-hour + ~16-hours pinned. The math is the load-bearing customer-pricing framing — drift would mismatch W751 dashboard $2.99 once-per-account copy.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The trial pack is a one-time \$2\.99 charge that credits 299¢ of\s*\n?session-time at the API Starter overage rate \(\$0\.18 \/ concurrent-\s*\n?hour\); ~16 hours of use\. Once-per-account\./,
    );
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

  it('CRITICAL planned subscription.changed / subscription.cancelled webhook events framing pinned. The "today the subscription.tier_changed audit row is the source of truth for programmatic consumers" wording sets the right SDK-consumer expectation.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /the planned\s*\n?`subscription\.changed` \/ `subscription\.cancelled` events; today\s*\n?the `subscription\.tier_changed` audit row is the source of truth/,
    );
  });

  it("CRITICAL billing-never-honors-X-Driftstack-Account team-RBAC framing pinned. The 'All /v1/billing/* endpoints are bearer-authenticated and scoped to the calling account. They do NOT honor the team-RBAC X-Driftstack-Account header — billing is always per-account, not per-team-context' wording is the load-bearing isolation framing. Team owners manage their own billing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /All `\/v1\/billing\/\*` endpoints are bearer-authenticated and scoped\s*\n?to the calling account\. They do NOT honor the team-RBAC\s*\n?`X-Driftstack-Account` header — billing is always per-account, not\s*\n?per-team-context\. Team owners manage their own billing; team\s*\n?members never see the owner's billing state\./,
    );
  });

  it('CRITICAL 4-endpoint canonical action set pinned — GET /v1/billing + POST /v1/billing/checkout-session + POST /v1/billing/trial-pack + POST /v1/billing/portal-session.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`GET \/v1\/billing`/);
    expect(p).toMatch(/`POST \/v1\/billing\/checkout-session`/);
    expect(p).toMatch(/`POST \/v1\/billing\/trial-pack`/);
    expect(p).toMatch(/`POST \/v1\/billing\/portal-session`/);
  });

  it('CRITICAL checkout response shape — { checkout_url, checkout_session_id } pinned. Drift would mismatch SDK consumer expectations.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Returns `\{ checkout_url, checkout_session_id \}`/);
  });

  it('CRITICAL TS SDK example uses client.billing.getState() + client.billing.startPortalSession() method names. Drift to a different SDK method name would force documentation/typedef-regen mismatches.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/const state = await client\.billing\.getState\(\);/);
    expect(p).toMatch(/const \{ portal_url \} = await client\.billing\.startPortalSession\(\);/);
  });

  it("CRITICAL Stripe-handles-card-collection-3DS-tax framing pinned. The 'Stripe handles card collection + 3DS + tax compliance and posts the result back to your success_url' wording is the load-bearing PCI/compliance attribution.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Stripe handles card collection \+\s*\n?3DS \+ tax compliance and posts the result back to your\s*\n?`success_url`\./,
    );
  });

  it("CRITICAL webhook-events cross-reference pinned. The '[Webhook events catalog](/webhooks/events/)' link routes SDK consumers to the inbound-Stripe→Driftstack mapping.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/\[Webhook events catalog\]\(\/webhooks\/events\/\)/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/docs-pages-api-billing-content-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
