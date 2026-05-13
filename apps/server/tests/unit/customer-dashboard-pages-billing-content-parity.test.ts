// W494.C — drift guard for apps/customer-dashboard/src/pages/billing.astro.
// V-183 billing-overview page with progressive-enhancement
// against /v1/billing + Stripe-portal handoff. Drift here either
// drops the 9-state STATUS_BADGE_CLASS (a new Stripe status
// would render with no styling) or breaks the cancel→portal
// indirection (cancellation goes through Stripe portal, not a
// direct cancel endpoint, so the page can't be a self-serve
// cancel UI that bypasses Stripe's flow).
//
//   • V-183 progressive-enhancement framing pinned.
//   • STATUS_BADGE_CLASS 9-state: active / trialing / past_due /
//     canceled / unpaid / incomplete / incomplete_expired /
//     paused / no_subscription.
//   • V-331b act-as header in authedFetch.
//   • Cancel button → handlePortal (cancellation goes through
//     Stripe portal).
//   • POST /v1/billing/portal-session + POST /v1/billing/trial-
//     pack contracts.
//   • Trial-pack 3-state (active / redeemed / available).
//   • Tax framing: 'VAT/BTW added per region per applicable EU
//     rules. Stripe handles tax computation + invoicing per ADR-
//     002.'

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/billing.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W494.C apps/customer-dashboard/src/pages/billing.astro content parity', () => {
  const body = read(LIB);

  it("V-183 framing pinned: 'progressive-enhancement wiring against /v1/billing. SSG renders mock for instant paint; inline <script> fetches live state + replaces card values. Action buttons (portal / trial pack) POST to the corresponding billing endpoint + redirect to the returned Stripe URL. Mirrors V-180/V-181/V-182.' — pinned so the dual SSG-mock + live-replace pattern + the action→Stripe-redirect contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ V-183 — progressive-enhancement wiring against \/v1\/billing\.\s*\n?\s*\/\/ SSG renders mock for instant paint; inline <script> fetches live\s*\n?\s*\/\/ state \+ replaces card values\. Action buttons \(portal \/ trial pack\)\s*\n?\s*\/\/ POST to the corresponding billing endpoint \+ redirect to the\s*\n?\s*\/\/ returned Stripe URL\. Mirrors V-180\/V-181\/V-182\./,
    );
  });

  it('STATUS_BADGE_CLASS 9-state catalog: active / trialing / past_due / canceled / unpaid / incomplete / incomplete_expired / paused / no_subscription with the right colors (emerald/amber/red/slate per severity) — pinned so the Stripe lifecycle vocabulary stays complete (drift to dropping incomplete_expired would render Stripe-state-incomplete-then-expired with no styling)', () => {
    expect(body).toMatch(
      /const STATUS_BADGE_CLASS: Record<string, string> = \{\s*\n?\s*active: 'bg-emerald-50 text-emerald-700',\s*\n?\s*trialing: 'bg-amber-50 text-amber-700',\s*\n?\s*past_due: 'bg-red-50 text-red-700',\s*\n?\s*canceled: 'bg-slate-100 text-slate-600',\s*\n?\s*unpaid: 'bg-red-50 text-red-700',\s*\n?\s*incomplete: 'bg-amber-50 text-amber-700',\s*\n?\s*incomplete_expired: 'bg-slate-100 text-slate-600',\s*\n?\s*paused: 'bg-slate-100 text-slate-600',\s*\n?\s*no_subscription: 'bg-slate-100 text-slate-600',\s*\n?\s*\};/,
    );
  });

  it("V-331b act-as header in authedFetch: '...(typeof window.driftstackActAsHeaders === 'function' ? window.driftstackActAsHeaders() : {})' — pinned so the team-scoped 'view as another account' flow propagates to billing fetches AND to the portal-session POST (drift would let team managers accidentally open their OWN Stripe portal when trying to manage a team-mate's)", () => {
    expect(body).toMatch(
      /\/\/ V-331b — act-as header for team-scoped requests\.\s*\n?\s*\.\.\.\(typeof window\.driftstackActAsHeaders === 'function'\s*\n?\s*\? window\.driftstackActAsHeaders\(\)\s*\n?\s*: \{\}\),/,
    );
  });

  it("Cancel button → handlePortal indirection: 'cancellation goes through Stripe portal' inline comment + cancelBtn.addEventListener('click', handlePortal) — pinned so customers can't accidentally land on a self-serve cancel API path that bypasses Stripe's retention/save offers (Stripe portal is the canonical cancel surface, with their own UX for offering pauses/discounts)", () => {
    expect(body).toMatch(
      /if \(cancelBtn\) cancelBtn\.addEventListener\('click', handlePortal\); \/\/ cancellation goes through Stripe portal/,
    );
  });

  it("POST /v1/billing/portal-session contract: empty {} body + redirect to body.portal_url — pinned so the portal handoff stays minimal (no client-provided URLs, drift to adding params would couple the dashboard to Stripe's portal options API)", () => {
    expect(body).toMatch(
      /authedFetch\('\/v1\/billing\/portal-session', \{ method: 'POST', body: '\{\}' \}\)/,
    );
    expect(body).toMatch(/if \(body\.portal_url\) window\.location\.href = body\.portal_url;/);
  });

  it("POST /v1/billing/trial-pack contract: success_url = origin + '/billing?trial=ok' + cancel_url = origin + '/billing?trial=cancel' + redirect to body.checkout_url — pinned so the billing-page trial-pack purchase loops back to /billing (not /first-session like the onboarding select-tier path) for return-customer flow + the query-param trial=ok/cancel signals success or cancel state", () => {
    expect(body).toMatch(
      /const successUrl = window\.location\.origin \+ '\/billing\?trial=ok';\s*\n?\s*const cancelUrl = window\.location\.origin \+ '\/billing\?trial=cancel';/,
    );
    expect(body).toMatch(
      /authedFetch\('\/v1\/billing\/trial-pack', \{\s*\n?\s*method: 'POST',\s*\n?\s*body: JSON\.stringify\(\{ success_url: successUrl, cancel_url: cancelUrl \}\),\s*\n?\s*\}\)/,
    );
  });

  it("Trial-pack 3-state framing pinned: active → '$N.NN of credit remaining · expires {date}' / redeemed → '$2.99 trial pack already used on this account. Once-per-account; the trial does not refresh.' / available → 'Buy 16 hours of iPhone Safari sessions for $2.99 — once per account.' — pinned so the once-per-account uniqueness framing survives in both the redeemed AND available copy (drift to dropping would let returning customers think they can buy a second trial pack)", () => {
    expect(body).toMatch(
      /'\$2\.99 trial pack already used on this account\. Once-per-account; the trial does not refresh\.'/,
    );
    expect(body).toMatch(
      /'Buy 16 hours of iPhone Safari sessions for \$2\.99 — once per account\.'/,
    );
  });

  it("Cancel-at-period-end visibility: SSG class:list shows cancelBtn iff MOCK_SUBSCRIPTION && !MOCK_SUBSCRIPTION.cancel_at_period_end + inline sub.cancel_at_period_end → hidden / else → visible — pinned so a subscription that's already set to cancel doesn't show the cancel button again (drift would let customers re-click cancel on an already-canceling sub)", () => {
    expect(body).toMatch(
      /MOCK_SUBSCRIPTION && !MOCK_SUBSCRIPTION\.cancel_at_period_end \? '' : 'hidden',/,
    );
    expect(body).toMatch(
      /if \(cancelBtn\) \{\s*\n?\s*if \(sub\.cancel_at_period_end\) cancelBtn\.classList\.add\('hidden'\);\s*\n?\s*else cancelBtn\.classList\.remove\('hidden'\);\s*\n?\s*\}/,
    );
  });

  it("Subscription auto-renew vs cancel-at-end framing: 'Renews {date} · set to cancel at period end' vs 'Renews {date} · auto-renews' — pinned so the customer sees AT-A-GLANCE whether the subscription will renew (active by default) or end (cancellation already triggered) — drift to merging both into 'Renews {date}' would hide the cancel-at-end signal", () => {
    expect(body).toMatch(
      /sub\.cancel_at_period_end \? 'set to cancel at period end' : 'auto-renews'/,
    );
  });

  it("Tax + receipts framing pinned: 'All prices in USD. VAT/BTW added per region per applicable EU rules. Stripe handles tax computation + invoicing per ADR-002.' — pinned so the EU-VAT framing + the ADR-002 Stripe-tax delegation reference survive (drift to handling tax ourselves would violate ADR-002 + create compliance liability)", () => {
    expect(body).toMatch(
      /All prices in USD\. VAT\/BTW added per region per applicable EU rules\.\s*\n?\s*Stripe handles tax computation \+ invoicing per ADR-002\./,
    );
  });

  it("No-token preview: !token → 'Sign in to see live billing state. Showing preview data below.' + early bail (mock data already painted via SSG) — pinned so unauthenticated visitors still see meaningful UI (the mock-data preview) rather than blank cards, with a clear sign-in prompt", () => {
    expect(body).toMatch(
      /if \(!token\) \{\s*\n?\s*showBanner\('Sign in to see live billing state\. Showing preview data below\.'\);\s*\n?\s*return;\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
