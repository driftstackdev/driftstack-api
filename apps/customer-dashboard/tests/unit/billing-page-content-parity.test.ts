// W360.B — drift guard for customer-dashboard /billing page
// content. V-183 progressive-enhancement against /v1/billing +
// /v1/billing/portal-session. The existing endpoint + route
// parity tests cover where the page calls the server; this guard
// pins the page's STATUS_BADGE map, current-plan display, and
// Stripe-portal posture against the source-of-truth schemas +
// route registrations.
//
// 2026-05-27 — the one-time trial-pack purchase flow was removed
// (POST /v1/billing/trial-pack deleted; entry tier is now the
// perpetual free tier, no purchase). The page no longer renders
// any trial-pack card, copy, or checkout wiring — those pins were
// dropped here in lockstep with the source.
//
// Pinned:
//   • STATUS_BADGE_CLASS keys cover SubscriptionStatusSchema's 8
//     real values + the page's 'no_subscription' synthetic state.
//   • Current-plan display: subscribed tier vs the free-tier
//     upgrade CTA framing stays pinned.
//   • Stripe-portal-only payment posture pinned ("all payment
//     changes redirect to Stripe's secure portal").
//   • Action button wired to POST /v1/billing/portal-session —
//     registered server-side.
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

  it('current-plan display pinned (free-tier upgrade CTA + subscribed tier)', () => {
    // Free accounts (the default, no subscription) see an upgrade CTA;
    // subscribed accounts see their tier. No trial-pack purchase UI.
    expect(body).toMatch(/Upgrade to a paid tier to unlock concurrent caps/);
    expect(body).toMatch(/No active subscription/);
    expect(body).toMatch(/href="\/select-tier\/"/);
    // The deleted endpoint must not reappear in any form.
    expect(body).not.toContain('/v1/billing/trial-pack');
    expect(body).not.toMatch(/trial pack/i);
  });

  it('Stripe-portal-only payment posture pinned', () => {
    expect(body).toMatch(/All payment changes redirect to Stripe's secure portal/);
    expect(body).toMatch(/Manage in Stripe portal/);
  });

  it('no-subscription state hides the portal/cancel actions (no dead Stripe call for a free account) + relabels the plan CTA to "Choose a plan"', () => {
    // A free account has no Stripe customer/portal and nothing to cancel.
    expect(body).toMatch(/if \(portalBtn\) portalBtn\.classList\.add\('hidden'\)/);
    expect(body).toMatch(/if \(cancelBtn\) cancelBtn\.classList\.add\('hidden'\)/);
    expect(body).toMatch(/setText\('plan-cta', 'Choose a plan'\)/);
    // …and the paid branch re-shows the portal + restores "Change plan".
    expect(body).toMatch(/if \(portalBtn\) portalBtn\.classList\.remove\('hidden'\)/);
    expect(body).toMatch(/setText\('plan-cta', 'Change plan'\)/);
  });

  it('action button wired to POST /v1/billing/portal-session (registered)', () => {
    expect(body).toContain("authedFetch('/v1/billing/portal-session'");
    expect(route).toContain("'/v1/billing/portal-session'");
    expect(route).toContain("'/v1/billing'");
    // The /billing page no longer cites the retired trial-pack endpoint.
    expect(body).not.toContain('/v1/billing/trial-pack');
  });

  it('GET /v1/billing state-fetch wiring pinned (the canonical /v1/billing endpoint)', () => {
    // The page fetches /v1/billing for live state. A rename would
    // leave the page stuck on SSG mock data forever.
    expect(body).toMatch(/V-183[^\n]*?\/v1\/billing/);
  });

  it('localStorage key ds_web_session_token (customer-dashboard convention)', () => {
    expect(body).toContain('ds_web_session_token');
    expect(body).toMatch(/try\s*\{\s*return localStorage\.getItem\('ds_web_session_token'\);/);
    expect(body).toMatch(/catch\s*\{\s*return null;/);
    expect(body).toMatch(
      /if \(!token\)[\s\S]*?showBanner\('Sign in to see live billing state\.'\)[\s\S]*?window\.dashboardHydrated\(\);[\s\S]*?return;/,
    );
  });

  it('cancel-subscription button hidden when cancel_at_period_end (avoid double-cancel)', () => {
    expect(body).toMatch(
      /if \(sub\.cancel_at_period_end\) cancelBtn\.classList\.add\('hidden'\);\s*else cancelBtn\.classList\.remove\('hidden'\);/,
    );
  });

  it('no residual trial-pack purchase UI (flow removed 2026-05-27)', () => {
    // The trial-pack 3-state card + checkout success/cancel URLs were
    // removed alongside the deleted endpoint. Guard against any
    // reintroduction of the purchase surface.
    expect(body).not.toContain('MOCK_TRIAL_PACK_STATE');
    expect(body).not.toMatch(/\$2\.99/);
    expect(body).not.toMatch(/16 hours/);
    expect(body).not.toMatch(/trial=cancel/);
  });
});
