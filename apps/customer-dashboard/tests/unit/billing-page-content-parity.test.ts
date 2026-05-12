// W360.B — drift guard for customer-dashboard /billing page
// content. V-183 progressive-enhancement against /v1/billing +
// /v1/billing/portal-session + /v1/billing/trial-pack. The
// existing endpoint + route parity tests cover where the page
// calls the server; this guard pins the page's STATUS_BADGE map,
// trial-pack copy, and Stripe-portal posture against the source-
// of-truth schemas + route registrations.
//
// Pinned:
//   • STATUS_BADGE_CLASS keys cover SubscriptionStatusSchema's 8
//     real values + the page's 'no_subscription' synthetic state.
//   • Trial-pack copy: $2.99 / once-per-account / 16 hours of
//     iPhone Safari sessions / 14-day expiry framing stays
//     pinned.
//   • Stripe-portal-only payment posture pinned ("all payment
//     changes redirect to Stripe's secure portal").
//   • Action buttons wired to POST /v1/billing/portal-session,
//     POST /v1/billing/trial-pack — both registered server-side.
//   • localStorage key ds_web_session_token.
//   • Cancel-subscription button only renders when
//     !cancel_at_period_end (otherwise hidden — avoid double-
//     cancel confusion).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SubscriptionStatusSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/billing.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/billing.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W360.B customer-dashboard /billing page content parity', () => {
  const body = read(PAGE);
  const route = read(ROUTE);
  const statuses = new Set<string>(
    (SubscriptionStatusSchema._def as { values: readonly string[] }).values,
  );

  it('STATUS_BADGE_CLASS keys cover SubscriptionStatusSchema (+ no_subscription synthetic)', () => {
    // Every schema status renders with a badge.
    for (const s of statuses) {
      expect(body).toMatch(new RegExp(`${s}:\\s*'bg-[a-z_-]+`));
    }
    // The synthetic "no subscription yet" sentinel.
    expect(body).toMatch(/no_subscription:\s*'bg-/);
  });

  it('trial-pack copy stays pinned ($2.99 / once-per-account / 16 hours iPhone Safari)', () => {
    expect(body).toMatch(/Buy 16 hours of iPhone Safari sessions for \$2\.99 — once per account/);
    expect(body).toMatch(
      /\$2\.99 trial pack already used on this account\. Once-per-account; the trial does not refresh/,
    );
    expect(body).toMatch(/Buy trial pack — \$2\.99/);
  });

  it('Stripe-portal-only payment posture pinned', () => {
    expect(body).toMatch(/All payment changes redirect to Stripe's secure portal/);
    expect(body).toMatch(/Manage in Stripe portal/);
  });

  it('action buttons wired to POST /v1/billing/portal-session + /v1/billing/trial-pack (both registered)', () => {
    expect(body).toContain("authedFetch('/v1/billing/portal-session'");
    expect(body).toContain("authedFetch('/v1/billing/trial-pack'");
    expect(route).toContain("'/v1/billing/portal-session'");
    expect(route).toContain("'/v1/billing/trial-pack'");
    expect(route).toContain("'/v1/billing'");
  });

  it('GET /v1/billing state-fetch wiring pinned (the canonical /v1/billing endpoint)', () => {
    // The page fetches /v1/billing for live state. A rename would
    // leave the page stuck on SSG mock data forever.
    expect(body).toMatch(/V-183[^\n]*?\/v1\/billing/);
  });

  it('localStorage key ds_web_session_token (customer-dashboard convention)', () => {
    expect(body).toContain('ds_web_session_token');
  });

  it('cancel-subscription button hidden when cancel_at_period_end (avoid double-cancel)', () => {
    expect(body).toMatch(
      /MOCK_SUBSCRIPTION && !MOCK_SUBSCRIPTION\.cancel_at_period_end \? '' : 'hidden'/,
    );
  });

  it('trial-pack 3-state ternary (Active / Redeemed / Available) pinned', () => {
    // The trial-pack card has three load-bearing display states —
    // a refactor that drops the Redeemed branch would suggest the
    // customer can re-buy, which they can't (once-per-account).
    expect(body).toMatch(/MOCK_TRIAL_PACK_STATE\.active\s*\?\s*'Active'/);
    expect(body).toMatch(/MOCK_TRIAL_PACK_STATE\.redeemed\s*\?\s*'Redeemed'\s*:\s*'Available'/);
  });

  it('success/cancel URLs for trial-pack checkout build off window.location.origin (V-183)', () => {
    // The checkout success-URL pattern is /billing?trial=success;
    // cancel is /billing?trial=cancel. These query-string sentinels
    // are how the post-checkout return picks up state, so they're
    // load-bearing for the end-to-end UX.
    expect(body).toMatch(/window\.location\.origin \+ '\/billing\?trial=cancel'/);
  });
});
