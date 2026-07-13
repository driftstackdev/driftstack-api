// W494.A — drift guard for apps/customer-dashboard/src/pages/select-tier.astro.
// V-184a + V-501 tier-picker page. Drift here either drops the
// PROFILES_PER_TIER / TIER_CONCURRENT_SESSION_LIMITS import
// (tier limits would diverge from server enforcement) or breaks
// the V-501 double-checkout guard (double-clicks would mint two
// Stripe sessions on the same account).
//
//   • V-184a + V-501 framing pinned.
//   • Tier catalogue 6-entry: solo_manual / team_manual /
//     agency_manual / api_starter / api_builder / api_scale.
//   • Imports from @driftstack/api-types: PROFILES_PER_TIER +
//     TIER_CONCURRENT_SESSION_LIMITS + AccountTier type.
//   • Free-plan note: $0 perpetual / 1 profile / 1 concurrent /
//     manual-only / no card / never expires.
//   • V-501 withBusy wrapper: disable button + 'Redirecting…'
//     label + restore on error.
//   • POST /v1/billing/checkout-session contract with success_url +
//     cancel_url (the one-time trial-pack checkout was retired).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/select-tier.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W494.A apps/customer-dashboard/src/pages/select-tier.astro content parity', () => {
  const body = read(LIB);

  it("V-184a + V-501 framing pinned: 'onboarding step 4. Tier picker. Tier 1 minimal placeholder surface — full Tier 3 visual (feature comparison table, tier highlights, AI-agent gating row, etc.) lands in V-184b draft.' + 'Change plan reuse: this same page is reachable from /billing Change plan link (post-onboarding). Every account starts on the perpetual free tier; the cards below upgrade to a paid tier.' + 'disabled-while-pending guards on checkout buttons; copy micro-polish (cancel-anytime line, clearer what changes framing).' — pinned so the dual use-case (onboarding + post-billing change-plan) + V-501 anti-double-click framing survive", () => {
    expect(body).toMatch(
      /\/\/ V-184a — onboarding step 4\. Tier picker\. Tier 1 minimal placeholder\s*\n?\s*\/\/ surface — full Tier 3 visual \(feature comparison table, tier\s*\n?\s*\/\/ highlights, AI-agent gating row, etc\.\) lands in V-184b draft\./,
    );
    expect(body).toMatch(
      /\/\/ "Change plan" reuse: this same page is reachable from \/billing\s*\n?\s*\/\/ "Change plan" link \(post-onboarding\)\. Every account starts on the\s*\n?\s*\/\/ perpetual free tier; the cards below upgrade to a paid tier\./,
    );
    expect(body).toMatch(
      /\/\/ V-501 — disabled-while-pending guards on checkout buttons; copy\s*\n?\s*\/\/ micro-polish \(cancel-anytime line, clearer "what changes" framing\)\./,
    );
  });

  it('@driftstack/api-types imports: PROFILES_PER_TIER + TIER_CONCURRENT_SESSION_LIMITS + AccountTier type — pinned so the displayed limits stay sourced from the shared package (drift to hardcoded numbers here would diverge from server-side enforcement when caps change)', () => {
    expect(body).toMatch(
      /import \{\s*\n?\s*PROFILES_PER_TIER,\s*\n?\s*TIER_CONCURRENT_SESSION_LIMITS,\s*\n?\s*type AccountTier,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
  });

  it("TIERS 6-entry catalogue with ladder taxonomy (Manual vs API): solo_manual $79/mo / team_manual $249/mo / agency_manual $699/mo / api_starter $149/mo / api_builder $499/mo / api_scale $1,499/mo — pinned so the price points + ladder categorization stay in sync with marketing-site pricing (drift to a 5-tier catalogue or swapping ladder labels would break the customer's recognition of what they signed up for). 2026-05-21 — `priceCents` field added (optional in regex) to thread the exact amount through the V-666.D crypto checkout body; values must match the dollar price.", () => {
    expect(body).toMatch(
      /\{ id: 'solo_manual', label: 'Personal', price: '\$79\/mo', ladder: 'Manual'(?:, priceCents: 7900)? \},/,
    );
    expect(body).toMatch(
      /\{ id: 'team_manual', label: 'Team', price: '\$249\/mo', ladder: 'Manual'(?:, priceCents: 24900)? \},/,
    );
    expect(body).toMatch(
      /\{ id: 'agency_manual', label: 'Agency', price: '\$699\/mo', ladder: 'Manual'(?:, priceCents: 69900)? \},/,
    );
    expect(body).toMatch(
      /\{ id: 'api_starter', label: 'API Starter', price: '\$149\/mo', ladder: 'API'(?:, priceCents: 14900)? \},/,
    );
    expect(body).toMatch(
      /\{ id: 'api_builder', label: 'API Builder', price: '\$499\/mo', ladder: 'API'(?:, priceCents: 49900)? \},/,
    );
    expect(body).toMatch(
      /\{ id: 'api_scale', label: 'API Scale', price: '\$1,499\/mo', ladder: 'API'(?:, priceCents: 149900)? \},/,
    );
  });

  it("Free-plan note pinned: 'You're on the free plan' + '1 profile, 1 concurrent session, and sessions up to 20 minutes each — no card required, and it never expires' — pinned so the perpetual free-tier framing (1 profile / 1 concurrent / 20-min sessions / no card / no expiry) survives on the tier picker. The 20-min cap (6.g) is the enforced free-tier session-duration limit.", () => {
    expect(body).toMatch(/You're on the free plan/);
    expect(body).toMatch(
      /Free includes 1 profile, 1 concurrent session, and sessions up\s+to 20 minutes each/,
    );
  });

  it("Hero framing + legal-grounded refund-honesty rewrite: 'no feature gating' value-prop preserved + the false '14-day pro-rated refund' promise (no automated refund mechanism exists; refunds are admin-manual only) replaced with the legally-grounded copy — plan stays active through the paid period, no automatic refunds for unused time, EU/UK 14-day withdrawal handled case-by-case via support@driftstack.dev (NOT an outright waiver — CRD Art 14(4)(b) makes an invalid waiver claim worse than none), crypto non-refundable.", () => {
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(
      /All tiers run the same engine\. Only concurrent caps and profile\s*\n?\s*counts change between them — there's no fingerprint or feature\s*\n?\s*gating\. Cancel or downgrade anytime — your plan stays active\s*\n?\s*through the end of the period you've already paid for\. We don't\s*\n?\s*provide automatic refunds for unused time\. If you're an EU\/UK\s*\n?\s*consumer and want to cancel within 14 days of first subscribing,\s*\n?\s*contact <a href="mailto:support@driftstack\.dev" class="text-tk-accent-text underline">support@driftstack\.dev<\/a>\s*\n?\s*and we'll handle it case by case\. Crypto payments are non-refundable\./,
    );
    // The old (false) automated pro-rated-refund promises must be gone —
    // both the original vague wording and the 2026-05-16 "mechanism-
    // clear" rewrite that still incorrectly promised an automated
    // pro-rated refund the system never implemented (refunds are
    // admin-manual only; see admin-accounts.ts refund-record).
    expect(body).not.toMatch(/Cancel anytime; pro-rated refunds within the first 14 days\./);
    expect(body).not.toMatch(
      /if you cancel within the\s*\n?\s*first 14 days of a billing cycle we refund the unused remainder/,
    );
  });

  it("V-501 withBusy wrapper: WeakSet single-flight + Redirecting label + finally restoration — pinned so double-clicks don't fire two POST /v1/billing/* calls", () => {
    expect(body).toMatch(/if \(busyCheckoutButtons\.has\(btn\)\) return Promise\.resolve\(\);/);
    expect(body).toMatch(/busyCheckoutButtons\.add\(btn\);/);
    expect(body).toMatch(/btn\.textContent = 'Redirecting…';/);
    expect(body).toMatch(/\.finally\(\(\) => \{/);
    expect(body).toMatch(/busyCheckoutButtons\.delete\(btn\);/);
    expect(body).toMatch(/btn\.disabled = false;/);
    expect(body).toMatch(/btn\.textContent = original;/);
  });

  it("POST /v1/billing/checkout-session contract: tier + billing_period:'monthly' + success_url with ?subscribed={tier} + cancel_url → /select-tier — pinned so the post-checkout landing URL signals which tier was purchased (for the dashboard home to read; 2026-07-02 the landing moved from /first-session to / with the account-portal IA) and billing_period stays 'monthly' (drift to dropping would silently default server-side, which may or may not match customer intent)", () => {
    expect(body).toMatch(/authedFetch\('\/v1\/billing\/checkout-session'/);
    expect(body).toMatch(/headers: \{ 'idempotency-key': checkoutKey \}/);
    expect(body).toMatch(/tier,\s*\n?\s*billing_period: 'monthly'/);
    expect(body).toMatch(/success_url: window\.location\.origin \+ '\/\?subscribed=' \+ tier/);
    expect(body).toMatch(/cancel_url: window\.location\.origin \+ '\/select-tier'/);
  });

  it('Concurrent + Profiles display via TIER_CONCURRENT_SESSION_LIMITS[t.id].toString() + String(PROFILES_PER_TIER[t.id]) — pinned so the per-tier cap display is sourced from the canonical api-types tables (drift to hardcoded numbers in the JSX would diverge from server-side limits when caps change)', () => {
    expect(body).toMatch(/\{TIER_CONCURRENT_SESSION_LIMITS\[t\.id\]\.toString\(\)\}/);
    expect(body).toMatch(/\{String\(PROFILES_PER_TIER\[t\.id\]\)\}/);
  });

  it("Enterprise framing: 'Enterprise tier (~$4,000/mo, custom) — contact sales' with mailto:sales@driftstack.dev — pinned so the enterprise tier surfaces as a sales-only path (no self-serve checkout for ~$4k/mo) and the contact email stays canonical", () => {
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(
      /Enterprise tier \(~\$4,000\/mo, custom\) — <a href="mailto:sales@driftstack\.dev" class="text-tk-accent-text underline">contact sales<\/a>\./,
    );
  });

  it("No-token guard: !token → showBanner('Sign up first.') + early-bail on the tier checkout buttons — pinned so customers landing on /select-tier from a deep-link without auth see a clear 'sign up first' message instead of an unhelpful 401 (drift would surface the raw server error)", () => {
    expect(body).toMatch(
      /if \(!token\) \{\s*\n?\s*showBanner\('Sign up first\.'\);\s*\n?\s*return;\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
