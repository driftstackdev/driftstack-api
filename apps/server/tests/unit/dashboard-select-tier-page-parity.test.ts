// W740 — customer-dashboard select-tier.astro V-184a step 4 + V-501
// page parity. Sixty-sixth in the cross-SDK drift-guard series.
//
// The select-tier page is the V-184a onboarding step 4 + post-
// onboarding "Change plan" surface. It drives the trial-pack +
// 6-paid-tier Stripe checkout funnel.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/select-tier.astro');

describe('W740 dashboard select-tier page V-184a + V-501 parity', () => {
  it('select-tier.astro file exists at the canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL V-184a onboarding-step-4 anchor + V-184b deferred-rich-comparison framing pinned. The page is Tier 1 minimal placeholder; full feature-comparison table lands in V-184b draft.', () => {
    const p = read(PAGE);
    expect(p).toMatch(/V-184a — onboarding step 4\. Tier picker\. Tier 1 minimal placeholder/);
    expect(p).toMatch(/full Tier 3 visual \(feature comparison table, tier/);
    expect(p).toMatch(/highlights, AI-agent gating row, etc\.\) lands in V-184b draft/);
  });

  it('CRITICAL "Change plan" reuse framing pinned. The page is reachable BOTH from V-184a onboarding AND from /billing "Change plan" — trial-pack CTA hidden when account has active subscription.', () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /"Change plan" reuse: this same page is reachable from \/billing\s*\n\/\/\s+"Change plan" link \(post-onboarding\) — the trial-pack CTA is\s*\n\/\/\s+hidden when the account already has an active subscription/,
    );
  });

  it('CRITICAL V-501 disabled-while-pending framing pinned. The disable-on-click guard prevents double-clicking on the Stripe-checkout-redirect buttons + creating 2 Stripe sessions. Original label restored on error.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-501 — disabled-while-pending guards on checkout buttons/);
    expect(p).toMatch(/V-501 — disable a button while its checkout-session call is in/);
    expect(p).toMatch(/flight so the customer can't double-click and create two Stripe/);
    expect(p).toMatch(/sessions\. Original label restored on error so they can retry/);

    // Implementation.
    expect(p).toMatch(/function withBusy\(btn, work\) \{/);
    expect(p).toMatch(/if \(btn\.disabled\) return Promise\.resolve\(\)/);
    expect(p).toMatch(/btn\.textContent = 'Redirecting…'/);
  });

  it('CRITICAL api-types imports pinned — PROFILES_PER_TIER + TIER_CONCURRENT_SESSION_LIMITS + AccountTier. The 3 imports are what keep dashboard tier-display synced with backend canonical records (W730 + W728). Drift to inlining would let display diverge.', () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /import \{\s*\n\s+PROFILES_PER_TIER,\s*\n\s+TIER_CONCURRENT_SESSION_LIMITS,\s*\n\s+type AccountTier,\s*\n\}\s*from\s+'@driftstack\/api-types'/,
    );
  });

  it('CRITICAL TIERS 6-paid-tier roster pinned in dashboard — solo $79/team $249/agency $699 (Manual ladder) + api_starter $149/api_builder $499/api_scale $1,499 (API ladder). 2-ladder structure matches W729 ADR-004. Drift in tier IDs/prices/ladder labels would mis-display.', () => {
    const p = read(PAGE);

    const expected: Array<[string, string, string, string]> = [
      ['solo_manual', 'Solo Manual', '$79/mo', 'Manual'],
      ['team_manual', 'Team Manual', '$249/mo', 'Manual'],
      ['agency_manual', 'Agency Manual', '$699/mo', 'Manual'],
      ['api_starter', 'API Starter', '$149/mo', 'API'],
      ['api_builder', 'API Builder', '$499/mo', 'API'],
      ['api_scale', 'API Scale', '$1,499/mo', 'API'],
    ];

    for (const [id, label, price, ladder] of expected) {
      const re = new RegExp(
        `\\{ id: '${id}', label: '${label}', price: '\\${price.replace('$', '$')}', ladder: '${ladder}' \\}`,
      );
      expect(p, `tier ${id}`).toMatch(re);
    }
  });

  it('CRITICAL trial-pack card pricing + 14-day-window + 1-concurrent + once-per-account framing pinned. Matches W729 TRIAL_PACK constants.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /<h2 class="text-xl font-semibold text-ink-primary">Trial pack — \$2\.99<\/h2>/,
    );
    expect(p).toMatch(
      /16 hours of iPhone Safari sessions\. 1 concurrent\. 14-day window\.\s*\n\s+Once per account/,
    );
  });

  it('CRITICAL "All tiers run the same engine" no-fingerprint/feature-gating framing pinned + 2026-05-16 enhancement-review C4 refund-clarity update. The "no fingerprint or feature gating" customer-facing claim is unchanged; the prior "Cancel anytime; pro-rated refunds within the first 14 days" replaced with mechanism-clear "Cancel or downgrade anytime; if you cancel within the first 14 days of a billing cycle we refund the unused remainder pro-rated to the day."', () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /All tiers run the same engine\. Only concurrent caps and profile\s*\n\s+counts change between them — there's no fingerprint or feature\s*\n\s+gating/,
    );
    expect(p).toMatch(
      /Cancel or downgrade anytime; if you cancel within the\s+first 14 days of a billing cycle we refund the unused remainder\s+pro-rated to the day/,
    );
    expect(p).not.toMatch(/Cancel anytime; pro-rated refunds within the first 14 days/);
  });

  it('CRITICAL trial-pack POST /v1/billing/trial-pack contract pinned — body {success_url, cancel_url}. success_url lands on /first-session?trial=ok; cancel_url returns to /select-tier. Drift would break the post-checkout return path.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /authedFetch\('\/v1\/billing\/trial-pack', \{\s*\n\s+method: 'POST',\s*\n\s+body: JSON\.stringify\(\{\s*\n\s+success_url: window\.location\.origin \+ '\/first-session\?trial=ok',\s*\n\s+cancel_url: window\.location\.origin \+ '\/select-tier',/,
    );
  });

  it("CRITICAL paid-tier POST /v1/billing/checkout-session contract pinned — body {tier, billing_period:'monthly', success_url, cancel_url}. success_url lands on /first-session?subscribed=<tier>; cancel_url returns to /select-tier.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /authedFetch\('\/v1\/billing\/checkout-session', \{\s*\n\s+method: 'POST',\s*\n\s+body: JSON\.stringify\(\{\s*\n\s+tier,\s*\n\s+billing_period: 'monthly',\s*\n\s+success_url: window\.location\.origin \+ '\/first-session\?subscribed=' \+ tier,\s*\n\s+cancel_url: window\.location\.origin \+ '\/select-tier',/,
    );
  });

  it('CRITICAL on-checkout-response redirect to body.checkout_url. The redirect IS the Stripe handoff; drift to dropping would leave customers stuck on /select-tier with no path forward.', () => {
    const p = read(PAGE);

    // Both trial-pack + paid-tier flows redirect to body.checkout_url.
    const redirects = (
      p.match(/if \(body\.checkout_url\) window\.location\.href = body\.checkout_url/g) ?? []
    ).length;
    expect(redirects, 'body.checkout_url redirects').toBe(2);
  });

  it("CRITICAL authedFetch helper bundles Bearer auth + content-type + credentials:'include'. Every billing-route call goes through this helper. Drift to inlining would let some calls miss the auth header.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /function authedFetch\(path, init = \{\}\) \{\s*\n\s+return fetch\(apiBaseUrl \+ path, \{\s*\n\s+\.\.\.init,\s*\n\s+headers: \{\s*\n\s+\.\.\.\(init\.headers \|\| \{\}\),\s*\n\s+authorization: 'Bearer ' \+ token,\s*\n\s+'content-type': 'application\/json',\s*\n\s+\},\s*\n\s+credentials: 'include',\s*\n\s+\}\)/,
    );
  });

  it("CRITICAL Sign-up-first guard pinned on both buttons. When localStorage.ds_web_session_token is missing, the button shows 'Sign up first.' banner instead of firing the API call. Drift to skipping would let unauthed clicks hit /v1/billing/* with no Bearer + return 401.", () => {
    const p = read(PAGE);

    const guards = (p.match(/if \(!token\) \{\s*\n\s+showBanner\('Sign up first\.'\)/g) ?? [])
      .length;
    expect(guards, 'Sign-up-first guard on trial + paid tiers').toBe(2);
  });

  it('CRITICAL Enterprise tier contact-sales mailto pinned. The Enterprise tier ($4,000/mo) is OUT of the self-service grid — customers contact sales@driftstack.dev. Matches W729 enterprise sales-only design.', () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /Enterprise tier \(~\$4,000\/mo, custom\) — <a href="mailto:sales@driftstack\.dev"/,
    );
  });

  it('CRITICAL per-tier display dl reads dynamic values from TIER_CONCURRENT_SESSION_LIMITS + PROFILES_PER_TIER. Drift to hardcoding the numbers would let tier-cap changes go unnoticed in the dashboard.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /<dd class="font-mono">\{TIER_CONCURRENT_SESSION_LIMITS\[t\.id\]\.toString\(\)\}<\/dd>/,
    );
    expect(p).toMatch(/\{String\(PROFILES_PER_TIER\[t\.id\]\)\}/);
  });

  it('CRITICAL withBusy() error-handler restores original label + re-enables button on failure. Drift to dropping would leave the button permanently disabled on transient errors.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /\.catch\(\(err\) => \{\s*\n\s+btn\.disabled = false;\s*\n\s+btn\.textContent = original;\s*\n\s+throw err;/,
    );
  });

  it('CRITICAL select-tier uses DashboardLayout + withSidebar={false}. The tier-picker is part of the onboarding flow — no sidebar (matches W735-W739 auth-page pattern).', () => {
    const p = read(PAGE);
    expect(p).toMatch(/<DashboardLayout title="Select tier" withSidebar=\{false\}>/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/dashboard-select-tier-page-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
