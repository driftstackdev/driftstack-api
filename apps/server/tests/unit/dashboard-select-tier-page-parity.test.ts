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

  it('CRITICAL "Change plan" reuse framing pinned. The page is reachable BOTH from V-184a onboarding AND from /billing "Change plan" — every account starts on the perpetual free tier; cards upgrade to a paid tier.', () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /"Change plan" reuse: this same page is reachable from \/billing\s*\n\/\/\s+"Change plan" link \(post-onboarding\)\. Every account starts on the\s*\n\/\/\s+perpetual free tier; the cards below upgrade to a paid tier/,
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
    expect(p).toMatch(/if \(busyCheckoutButtons\.has\(btn\)\) return Promise\.resolve\(\)/);
    expect(p).toMatch(/busyCheckoutButtons\.add\(btn\)/);
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
      ['solo_manual', 'Personal', '$79/mo', 'Manual'],
      ['team_manual', 'Team', '$249/mo', 'Manual'],
      ['agency_manual', 'Agency', '$699/mo', 'Manual'],
      ['api_starter', 'API Starter', '$149/mo', 'API'],
      ['api_builder', 'API Builder', '$499/mo', 'API'],
      ['api_scale', 'API Scale', '$1,499/mo', 'API'],
    ];

    for (const [id, label, price, ladder] of expected) {
      // 2026-05-21 — V-666.D added optional `priceCents: <int>` after
      // the ladder field. Regex now allows the trailing comma + the
      // priceCents key so the pin survives the crypto checkout
      // addition without requiring per-tier updates.
      const re = new RegExp(
        `\\{ id: '${id}', label: '${label}', price: '\\${price.replace('$', '$')}', ladder: '${ladder}'(?:, priceCents: \\d+)? \\}`,
      );
      expect(p, `tier ${id}`).toMatch(re);
    }
  });

  it('CRITICAL free-plan note pinned — $0 perpetual / 1 profile / 1 concurrent / 20-min session cap / no card / never expires.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/You're on the free plan/);
    expect(p).toMatch(
      /Free includes 1 profile, 1 concurrent session, and sessions up\s+to 20 minutes each/,
    );
  });

  it('CRITICAL "All tiers run the same engine" no-fingerprint/feature-gating framing pinned + legal-grounded refund-honesty rewrite. The "no fingerprint or feature gating" customer-facing claim is unchanged; the false automated "14-day pro-rated refund" promise (refunds are admin-manual only — no automated mechanism exists) is replaced with: plan stays active through the paid period, no automatic refunds for unused time, EU/UK 14-day withdrawal handled case-by-case via support@driftstack.dev, crypto non-refundable.', () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /All tiers run the same engine\. Only concurrent caps and profile\s*\n\s+counts change between them — there's no fingerprint or feature\s*\n\s+gating/,
    );
    expect(p).toMatch(
      /Cancel or downgrade anytime — your plan stays active\s+through the end of the period you've already paid for\. We don't\s+provide automatic refunds for unused time\./,
    );
    expect(p).toMatch(
      /If you're an EU\/UK\s+consumer and want to cancel within 14 days of first subscribing,\s+contact <a href="mailto:support@driftstack\.dev"[^>]*>support@driftstack\.dev<\/a>\s+and we'll handle it case by case\. Crypto payments are non-refundable\./,
    );
    expect(p).not.toMatch(/Cancel anytime; pro-rated refunds within the first 14 days/);
    expect(p).not.toMatch(/we refund the unused remainder\s+pro-rated to the day/);
  });

  it("CRITICAL paid-tier POST /v1/billing/checkout-session contract pinned — body {tier, billing_period:'monthly', success_url, cancel_url}. success_url lands on /?subscribed=<tier> (2026-07-02: was /first-session, which the account-portal IA deleted — the dashboard home reads ?subscribed); cancel_url returns to /select-tier.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/authedFetch\('\/v1\/billing\/checkout-session'/);
    expect(p).toMatch(/headers: \{ 'idempotency-key': checkoutKey \}/);
    expect(p).toMatch(/tier,\s*\n\s+billing_period: 'monthly'/);
    expect(p).toMatch(/success_url: window\.location\.origin \+ '\/\?subscribed=' \+ tier/);
    expect(p).toMatch(/cancel_url: window\.location\.origin \+ '\/select-tier'/);
  });

  it('CRITICAL checkout redirects only to a validated Stripe Checkout URL; missing, malformed, or off-origin responses throw so the busy button recovers', () => {
    const p = read(PAGE);
    const trustedCheckoutRedirect =
      /const checkoutUrl = window\.driftstackTrustedRedirectUrl\(body\.checkout_url, \[\s*'https:\/\/checkout\.stripe\.com',\s*\]\);\s*if \(!checkoutUrl\) throw new Error\('No valid checkout URL returned\.'\);\s*window\.location\.href = checkoutUrl;/;

    expect(p).toMatch(trustedCheckoutRedirect);
    expect(p).not.toMatch(/window\.location\.href = body\.checkout_url/);
    expect(
      p.replace(
        /const checkoutUrl = window\.driftstackTrustedRedirectUrl\(body\.checkout_url, \[\s*'https:\/\/checkout\.stripe\.com',\s*\]\);/,
        'const checkoutUrl = body.checkout_url;',
      ),
    ).not.toMatch(trustedCheckoutRedirect);
    const redirects = (p.match(/window\.location\.href = checkoutUrl/g) ?? []).length;
    expect(redirects, 'validated Stripe checkout redirects').toBe(1);
    expect(
      p.match(/driftstackTrustedRedirectUrl\(body\.checkout_url/g) ?? [],
      'checkout response allow-list validations',
    ).toHaveLength(1);
  });

  it("CRITICAL authedFetch helper bundles Bearer auth + content-type + credentials:'include'. Every billing-route call goes through this helper. Drift to inlining would let some calls miss the auth header.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/function authedFetch\(path, init = \{\}\) \{/);
    expect(p).toMatch(/const ownsController = !init\.signal;/);
    expect(p).toMatch(/return fetch\(apiBaseUrl \+ path, \{/);
    expect(p).toMatch(/\.\.\.\(init\.headers \|\| \{\}\)/);
    expect(p).toMatch(/authorization: 'Bearer ' \+ token/);
    expect(p).toMatch(/credentials: 'include'/);
  });

  it("CRITICAL Sign-up-first guard pinned on the paid-tier checkout button. When localStorage.ds_web_session_token is missing, the button shows 'Sign up first.' banner instead of firing the API call. Drift to skipping would let unauthed clicks hit /v1/billing/* with no Bearer + return 401.", () => {
    const p = read(PAGE);

    const guards = (p.match(/if \(!token\) \{\s*\n\s+showBanner\('Sign up first\.'\)/g) ?? [])
      .length;
    expect(guards, 'Sign-up-first guard on the paid-tier checkout').toBe(1);
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

  it("CRITICAL withBusy() serializes checkout across every tier and restores each button's authoritative prior state after settlement", () => {
    const p = read(PAGE);

    expect(p).toMatch(/if \(checkoutInFlightButton !== null\) return Promise\.resolve\(\);/);
    expect(p).toMatch(
      /const buttonStates = Array\.from\(tierButtons\)\.map\(\(button\) => \(\{\s*button,\s*disabled: button\.disabled,\s*text: button\.textContent,\s*title: button\.getAttribute\('title'\),\s*\}\)\);/,
    );
    expect(p).toMatch(
      /tierButtons\.forEach\(\(button\) => \{\s*button\.disabled = true;\s*button\.setAttribute\('aria-disabled', 'true'\);/,
    );
    expect(p).toMatch(/\.finally\(\(\) => \{/);
    expect(p).toMatch(/busyCheckoutButtons\.delete\(btn\);/);
    expect(p).toMatch(/btn\.textContent = original;/);
    expect(p).toMatch(
      /buttonStates\.forEach\(\(\{ button, disabled, text, title \}\) => \{\s*button\.disabled = disabled;\s*button\.textContent = text;\s*button\.removeAttribute\('aria-disabled'\);/,
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
