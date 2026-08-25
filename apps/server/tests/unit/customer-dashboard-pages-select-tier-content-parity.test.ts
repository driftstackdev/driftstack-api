// W494.A — drift guard for apps/customer-dashboard/src/pages/select-tier.astro.
// V-184a + V-501 tier-picker page. Drift here either drops the
// canonical tier-cap/feature imports (the display would diverge
// from server enforcement) or breaks
// the V-501 double-checkout guard (double-clicks would mint two
// Stripe sessions on the same account).
//
//   • V-184a + V-501 framing pinned.
//   • Tier catalogue 6-entry: solo_manual / team_manual /
//     agency_manual / api_starter / api_builder / api_scale.
//   • Imports the canonical cap + feature tables from api-types.
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

  it('V-184a + V-501 framing pins the dual onboarding/change-plan use case, canonical comparison rows, and anti-double-click guard without deferred placeholder copy', () => {
    expect(body).toMatch(/\/\/ V-184a — onboarding step 4 and the post-onboarding plan picker\./);
    expect(body).toMatch(/comparison rows below are derived from the same api-types tables/);
    expect(body).not.toMatch(
      /minimal placeholder|lands in V-184b|will replace with rich comparison/,
    );
    expect(body).toMatch(
      /\/\/ "Change plan" reuse: this same page is reachable from \/billing\s*\/\/ "Change plan" link \(post-onboarding\)\. Every account starts on the\s*\/\/ perpetual free tier; the cards below upgrade to a paid tier\./,
    );
    expect(body).toMatch(
      /\/\/ V-501 — disabled-while-pending guards on checkout buttons; copy\s*\/\/ micro-polish \(cancel-anytime line, clearer "what changes" framing\)\./,
    );
  });

  it('@driftstack/api-types imports every displayed cap/feature table so checkout comparison stays aligned with enforcement', () => {
    expect(body).toMatch(
      /import \{[\s\S]*?MAX_SESSION_MINUTES_PER_TIER,[\s\S]*?PROFILES_PER_TIER,[\s\S]*?PROXIES_PER_TIER,[\s\S]*?TIER_CONCURRENT_SESSION_LIMITS,[\s\S]*?TIER_FEATURES,[\s\S]*?TIER_STORAGE_BYTES_CAP,[\s\S]*?type AccountTier,[\s\S]*?\} from '@driftstack\/api-types';/,
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

  it('Hero accurately distinguishes the shared engine/archetypes from enforced operational and optional-capability differences while preserving refund honesty', () => {
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(
      /Every tier runs the same verified browser engine and can use every\s*currently available archetype\. Operational limits and optional capabilities\s*differ — compare concurrency, profiles, storage, saved proxies, access,\s*and AI billing below\. Cancel or downgrade anytime — your plan stays active/,
    );
    expect(body).not.toMatch(/Only concurrent caps and profile\s+counts change/);
    expect(body).toMatch(/We don't\s+provide automatic refunds for unused time/);
    expect(body).toMatch(/support@driftstack\.dev/);
    expect(body).toMatch(/Crypto payments are non-refundable\./);
    // The old (false) automated pro-rated-refund promises must be gone —
    // both the original vague wording and the 2026-05-16 "mechanism-
    // clear" rewrite that still incorrectly promised an automated
    // pro-rated refund the system never implemented (refunds are
    // admin-manual only; see admin-accounts.ts refund-record).
    expect(body).not.toMatch(/Cancel anytime; pro-rated refunds within the first 14 days\./);
    expect(body).not.toMatch(
      /if you cancel within the\s*first 14 days of a billing cycle we refund the unused remainder/,
    );
  });

  it("V-501 withBusy wrapper: WeakSet single-flight + Redirecting label + finally restoration — pinned so double-clicks don't fire two POST /v1/billing/* calls", () => {
    expect(body).toMatch(/if \(busyCheckoutButtons\.has\(btn\)\) return Promise\.resolve\(\);/);
    expect(body).toMatch(/busyCheckoutButtons\.add\(btn\);/);
    expect(body).toMatch(/btn\.textContent = 'Redirecting…';/);
    expect(body).toMatch(/\.finally\(\(\) => \{/);
    expect(body).toMatch(/busyCheckoutButtons\.delete\(btn\);/);
    expect(body).toMatch(/checkoutInFlightButton = null;/);
    expect(body).toMatch(/btn\.textContent = original;/);
    expect(body).toMatch(
      /buttonStates\.forEach\(\(\{ button, disabled, text, title \}\) => \{\s*button\.disabled = disabled;\s*button\.textContent = text;/,
    );
    expect(
      body.replace(
        /busyCheckoutButtons\.delete\(btn\);\s*checkoutInFlightButton = null;/,
        'busyCheckoutButtons.delete(btn);',
      ),
    ).not.toMatch(/busyCheckoutButtons\.delete\(btn\);\s*checkoutInFlightButton = null;/);
  });

  it("POST /v1/billing/checkout-session contract: tier + billing_period:'monthly' + success_url with ?subscribed={tier} + cancel_url → /select-tier — pinned so the post-checkout landing URL signals which tier was purchased (for the dashboard home to read; 2026-07-02 the landing moved from /first-session to / with the account-portal IA) and billing_period stays 'monthly' (drift to dropping would silently default server-side, which may or may not match customer intent)", () => {
    expect(body).toMatch(/authedFetch\('\/v1\/billing\/checkout-session'/);
    expect(body).toMatch(/headers: \{ 'idempotency-key': checkoutKey \}/);
    expect(body).toMatch(/tier,\s*billing_period: 'monthly'/);
    expect(body).toMatch(/success_url: window\.location\.origin \+ '\/\?subscribed=' \+ tier/);
    expect(body).toMatch(/cancel_url: window\.location\.origin \+ '\/select-tier'/);
  });

  it('crypto checkout uses a cross-tab logical-intent lease, exact terminal retirement, and live address authority', () => {
    expect(body).toMatch(/const cryptoIntentLocksAvailable =/);
    expect(body).toMatch(/navigator\.locks\.request\([\s\S]*mode: 'exclusive'/);
    expect(body).toMatch(/function cryptoIntentScope\(tier\)/);
    expect(body).toMatch(/account_id: scope\.accountId/);
    expect(body).toMatch(/product: scope\.tier/);
    expect(body).toMatch(/function compareRetireCryptoIntentKey\(tier, expectedKey\)/);
    expect(body).toMatch(/for \(let attempt = 0; attempt < 2; attempt \+= 1\)/);
    expect(body).toMatch(/CRYPTO_TERMINAL_STATUSES\.has\(body\.status\)/);
    expect(body).toMatch(/function startCryptoOrderPolling\(entry, initialExpiresAtMs\)/);
    expect(body).toMatch(/generation !== cryptoPollGeneration/);
    expect(body).toMatch(/await readCryptoOrderAuthority\(cacheEntry, controller\.signal\)/);
    expect(body).toMatch(/body\.product !== entry\.tier/);
    expect(body).toMatch(/expiresAtMs <= Date\.now\(\)/);
    expect(body).toMatch(/armCryptoExpiryDeadline\(entry, initialExpiresAtMs, generation\)/);
    expect(body).toMatch(/hideCryptoPaymentAddress\(cryptoStatusMessage/);
    expect(body).not.toMatch(/const cached = cryptoOrderCache\.get\(tier\);\s*if \(cached\)/);
  });

  it('purchase mutations fail closed when the shell is acting as a team owner', () => {
    expect(body).toMatch(
      /const cryptoWorkspaceSupported = selectedWorkspaceAccountId\.length === 0/,
    );
    expect(body).toMatch(/if \(!cryptoWorkspaceSupported\) \{[\s\S]*self-workspace only/);
    expect(body).toMatch(/authedFetch\('\/v1\/account\/me'/);
    expect(body).toMatch(/SELF_ACCOUNT_ID_RE\.test\(body\.id \|\| ''\)/);
  });

  it('never publishes malformed or cross-product provider details as payable', () => {
    expect(body).toMatch(/body\.product !== expectedTier/);
    expect(body).toMatch(/function validateCryptoPaymentCandidate\(body\)/);
    expect(body).toMatch(/\^\[\\x21-\\x7e\]\{1,256\}\$/);
    expect(body).toMatch(/Number\.isFinite\(numeric\) && numeric > 0/);
    expect(
      body.indexOf('await readCryptoOrderAuthority(cacheEntry, controller.signal)'),
    ).toBeLessThan(body.indexOf('setCryptoCopyTarget(cacheEntry.paymentAddress)'));
  });

  it('Concurrent + Profiles display via TIER_CONCURRENT_SESSION_LIMITS[t.id].toString() + String(PROFILES_PER_TIER[t.id]) — pinned so the per-tier cap display is sourced from the canonical api-types tables (drift to hardcoded numbers in the JSX would diverge from server-side limits when caps change)', () => {
    expect(body).toMatch(/\{TIER_CONCURRENT_SESSION_LIMITS\[t\.id\]\.toString\(\)\}/);
    expect(body).toMatch(/\{String\(PROFILES_PER_TIER\[t\.id\]\)\}/);
  });

  it('renders the enforced duration, storage, proxy, access, and AI billing differences from canonical helpers on every paid card', () => {
    expect(body).toMatch(/MAX_SESSION_MINUTES_PER_TIER\[tier\]/);
    expect(body).toMatch(/TIER_STORAGE_BYTES_CAP\[tier\] \/ 2 \*\* 30/);
    expect(body).toMatch(/PROXIES_PER_TIER\[tier\]/);
    expect(body).toMatch(/TIER_FEATURES\[tier\]/);
    expect(body).toMatch(/<dt>Session duration<\/dt>/);
    expect(body).toMatch(/<dt>Profile storage<\/dt>/);
    expect(body).toMatch(/<dt>Saved proxies<\/dt>/);
    expect(body).toMatch(/<dt>Access<\/dt>/);
    expect(body).toMatch(/<dt>AI agent<\/dt>/);
    expect(body).toMatch(/BYOK or \$0\.10\/turn/);
    expect(body).toMatch(/API access, VPN egress, and the AI agent require a\s+paid tier/);
    expect(body).not.toMatch(/drive them from the API or GUI/);
  });

  it('uses present-tense actionable configuration errors instead of roadmap or check-back promises', () => {
    expect(body).toMatch(
      /Card checkout is unavailable on this server\. Use crypto checkout if it is offered below, or email billing@driftstack\.dev\./,
    );
    expect(body).toMatch(
      /Crypto checkout is unavailable on this server\. Use card checkout, or email /,
    );
    expect(body).toMatch(/billing@driftstack\.dev with order_id/);
    expect(body).not.toMatch(/still in progress|Check back shortly|isn't fully live yet/i);
  });

  it("Enterprise framing: 'Enterprise tier (~$4,000/mo, custom) — contact sales' with mailto:sales@driftstack.dev — pinned so the enterprise tier surfaces as a sales-only path (no self-serve checkout for ~$4k/mo) and the contact email stays canonical", () => {
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(
      /Enterprise tier \(~\$4,000\/mo, custom\) — <a href="mailto:sales@driftstack\.dev" class="text-tk-accent-text underline">contact sales<\/a>\./,
    );
  });

  it("No-token guard: !token → showBanner('Sign up first.') + early-bail on the tier checkout buttons — pinned so customers landing on /select-tier from a deep-link without auth see a clear 'sign up first' message instead of an unhelpful 401 (drift would surface the raw server error)", () => {
    expect(body).toMatch(/if \(!token\) \{\s*showBanner\('Sign up first\.'\);\s*return;\s*\}/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
