// W373.C — drift guard for customer-dashboard /select-tier page
// content. V-184a + V-501. Existing select-tier-{card-coverage,
// endpoints, pricing, route}-parity tests cover route + tier-
// data shape. This guard pins the load-bearing checkout-flow
// claims for the onboarding-step-4 surface:
//
//   • V-184a + V-501 framing comments pinned (placeholder
//     surface + disabled-while-pending double-checkout guard).
//   • Every displayed cap/feature table imported from
//     @driftstack/api-types (schema-driven comparison rendering).
//   • TIERS array pinned: 6 paid tiers (Solo / Team / Agency
//     Manual + API Starter / Builder / Scale) with exact prices.
//   • Enterprise mailto:sales@driftstack.dev fallback ("~$4,000/
//     mo, custom" floor matches /faq + /pricing).
//   • Free-tier note pinned ("You're on the free plan" / $0 / no
//     card / never expires) — the one-time trial pack was retired
//     2026-05-27, so the page has no trial purchase card.
//   • POST /v1/billing/checkout-session wired with success_url +
//     cancel_url shapes.
//   • V-501 withBusy disabled-while-pending double-checkout
//     guard (no double-Stripe-session).
//   • Honest shared-engine framing plus operational and optional-
//     capability differences.
//   • Refund-honesty copy (legal-grounded rewrite, replaces the old
//     false automated "pro-rated refund within 14 days" promise —
//     refunds are admin-manual only): plan stays active through the
//     paid period, no automatic refunds, EU/UK 14-day withdrawal
//     handled case-by-case via support@driftstack.dev, crypto
//     non-refundable.
//   • Change-plan-reuse comment (page reachable from /billing too).
//   • withSidebar={false} pre-subscribed layout.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/select-tier.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W373.C customer-dashboard /select-tier page content parity', () => {
  const body = read(PAGE);

  it('V-184a + V-501 framing comments pinned (placeholder surface + double-checkout guard)', () => {
    expect(body).toMatch(/V-184a — onboarding step 4 and the post-onboarding plan picker/);
    expect(body).toMatch(/comparison rows below are derived from the same api-types tables/);
    expect(body).toMatch(
      /V-501 — disabled-while-pending guards on checkout buttons; copy\s*\n?\s*\/\/\s*micro-polish/,
    );
  });

  it('every displayed cap/feature table is imported from @driftstack/api-types', () => {
    expect(body).toMatch(
      /import \{[\s\S]*?MAX_SESSION_MINUTES_PER_TIER,[\s\S]*?PROFILES_PER_TIER,[\s\S]*?PROXIES_PER_TIER,[\s\S]*?TIER_CONCURRENT_SESSION_LIMITS,[\s\S]*?TIER_FEATURES,[\s\S]*?TIER_STORAGE_BYTES_CAP,[\s\S]*?type AccountTier,[\s\S]*?\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/TIER_CONCURRENT_SESSION_LIMITS\[t\.id\]/);
    expect(body).toMatch(/PROFILES_PER_TIER\[t\.id\]/);
  });

  it('TIERS array pinned: 6 paid tiers verbatim (Solo/Team/Agency + API Starter/Builder/Scale)', () => {
    const tiers = body.match(/const TIERS:[\s\S]*?\] = \[([\s\S]*?)\];/);
    expect(tiers).not.toBeNull();
    const ids = Array.from(tiers![1]!.matchAll(/id: '([a-z_]+)'/g)).map((m) => m[1] as string);
    expect(ids).toEqual([
      'solo_manual',
      'team_manual',
      'agency_manual',
      'api_starter',
      'api_builder',
      'api_scale',
    ]);
    // Exact prices pinned.
    for (const price of ['$79/mo', '$249/mo', '$699/mo', '$149/mo', '$499/mo', '$1,499/mo']) {
      expect(body, `tier price missing: ${price}`).toContain(`price: '${price}'`);
    }
  });

  it('Enterprise mailto:sales@driftstack.dev fallback pinned (~$4,000/mo floor matches /faq + /pricing)', () => {
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(
      /Enterprise tier \(~\$4,000\/mo, custom\) — <a href="mailto:sales@driftstack\.dev" class="text-tk-accent-text underline">contact sales<\/a>\./,
    );
  });

  it('free-tier note pinned (no trial-pack purchase card)', () => {
    expect(body).toMatch(/You're on the free plan/);
    expect(body).toMatch(
      /Free includes 1 profile, 1 concurrent session, and sessions up\s+to 20 minutes each/,
    );
    // The retired trial-pack purchase surface must be gone.
    expect(body).not.toMatch(/data-action="buy-trial-pack"/);
    expect(body).not.toMatch(/\$2\.99/);
    expect(body).not.toContain('/v1/billing/trial-pack');
  });

  it('POST /v1/billing/checkout-session wired with tier + billing_period + success/cancel URLs', () => {
    expect(body).toMatch(/authedFetch\('\/v1\/billing\/checkout-session'/);
    expect(body).toMatch(/tier,\s*\n?\s*billing_period: 'monthly'/);
    expect(body).toMatch(/success_url: window\.location\.origin \+ '\/\?subscribed=' \+ tier/);
  });

  it('V-501 withBusy double-checkout guard pinned (no double-Stripe-session)', () => {
    expect(body).toMatch(/V-501 — disable a button while its checkout-session call is in/);
    expect(body).toMatch(/if \(busyCheckoutButtons\.has\(btn\)\) return Promise\.resolve\(\);/);
    expect(body).toContain('const CHECKOUT_TIMEOUT_MS = 15_000;');
    expect(body).toMatch(/busyCheckoutButtons\.add\(btn\)/);
    expect(body).toMatch(/work\(controller\.signal\)/);
    expect(body).toMatch(/window\.clearTimeout\(timeout\)/);
    expect(body).toMatch(/btn\.textContent = 'Redirecting…';/);
    expect(body).toContain(
      'The billing request took too long. Check your connection and try again.',
    );
  });

  it('bounds authenticated response bodies without replacing mutation-owned signals', () => {
    expect(body).toContain('const AUTHED_REQUEST_TIMEOUT_MS = 15_000;');
    expect(body).toContain('const ownsController = !init.signal;');
    expect(body).toMatch(/signal = init\.signal \|\| controller\.signal/);
    expect(body).toContain("['arrayBuffer', 'blob', 'formData', 'json', 'text']");
    expect(body).toMatch(/Promise\.resolve\(decoded\)\.finally\(cleanupOwnedRequest\)/);
    expect(body).toMatch(
      /ownedRequestControllers\.forEach\(\(controller\) => controller\.abort\(\)\)/,
    );
    expect(body).toMatch(/window\.addEventListener\('pagehide'/);
  });

  it('bounds crypto address minting while preserving its explicit lease', () => {
    expect(body).toContain('let cryptoRequestInFlight = false;');
    expect(body).toContain('const CRYPTO_TIMEOUT_MS = 15_000;');
    expect(body).toMatch(/if \(cryptoRequestInFlight\) return;/);
    expect(body).toMatch(/signal: controller\.signal/);
    expect(body).toContain(
      'Minting the payment address took too long. Check your connection and try again.',
    );
  });

  it('owns one exact crypto intent across storage, tabs, retries, and terminal rotation', () => {
    expect(body).toMatch(/function cryptoIntentScope\(tier\)/);
    expect(body).toContain(
      "storageKey: 'ds_crypto_idem_v2:' + authoritativeSelfAccountId + ':' + tier",
    );
    expect(body).toContain(
      "lockName: 'driftstack:crypto-checkout:' + authoritativeSelfAccountId + ':' + tier",
    );
    expect(body).toMatch(/function readOrCreateCryptoIntentKey\(tier\)/);
    expect(body).toMatch(/parsed\.account_id !== scope\.accountId/);
    expect(body).toMatch(/parsed\.product !== scope\.tier/);
    expect(body).toMatch(/function compareRetireCryptoIntentKey\(tier, expectedKey\)/);
    expect(body).toMatch(/parsed\.idempotency_key !== expectedKey/);
    expect(body).toMatch(/navigator\.locks\.request\([\s\S]*mode: 'exclusive'/);
    expect(body).toMatch(/for \(let attempt = 0; attempt < 2; attempt \+= 1\)/);
    expect(body).toMatch(/CRYPTO_TERMINAL_STATUSES\.has\(body\.status\)/);
    expect(body).toMatch(/body\.status === 'confirming' \|\| body\.status === 'partial'/);
    expect(body).toMatch(/if \(!idempotencyKey\) \{[\s\S]*prevent duplicate payment orders/);
  });

  it('never trusts the in-page address cache without live status authority', () => {
    expect(body).toMatch(/function startCryptoOrderPolling\(entry, initialExpiresAtMs\)/);
    expect(body).toMatch(/const generation = cryptoPollGeneration/);
    expect(body).toMatch(/generation !== cryptoPollGeneration/);
    expect(body).toMatch(/\/v1\/billing\/crypto-orders\/.*encodeURIComponent\(entry\.orderId\)/);
    expect(body).toMatch(/body\.order_id !== entry\.orderId/);
    expect(body).toMatch(/body\.product !== entry\.tier/);
    expect(body).toMatch(/expiresAtMs <= Date\.now\(\)/);
    expect(body).toMatch(/await readCryptoOrderAuthority\(cacheEntry, controller\.signal\)/);
    expect(body).toMatch(/armCryptoExpiryDeadline\(entry, initialExpiresAtMs, generation\)/);
    expect(body).toMatch(/hideCryptoPaymentAddress\(cryptoStatusMessage/);
    expect(body).not.toMatch(/const cached = cryptoOrderCache\.get\(tier\);\s*if \(cached\)/);
  });

  it('fails plan purchase closed outside Self and crypto closed without Web Locks', () => {
    expect(body).toMatch(
      /const cryptoWorkspaceSupported = selectedWorkspaceAccountId\.length === 0/,
    );
    expect(body).toContain(
      'Plan purchases are self-workspace only. Switch the workspace picker to Self before starting a payment.',
    );
    expect(body).toContain('Secure crypto checkout needs browser cross-tab locking support.');
    expect(body).toMatch(/authedFetch\('\/v1\/account\/me'/);
    expect(body).toMatch(/SELF_ACCOUNT_ID_RE\.test\(body\.id \|\| ''\)/);
  });

  it('strictly binds candidate payment fields and checkout product before enabling copy', () => {
    expect(body).toMatch(/body\.product !== expectedTier/);
    expect(body).toMatch(/\^\[\\x21-\\x7e\]\{1,256\}\$/);
    expect(body).toMatch(/\^\[A-Za-z0-9_-\]\{2,32\}\$/);
    expect(body).toMatch(/Number\.isFinite\(numeric\) && numeric > 0/);
    expect(body).toMatch(/const candidate = validateCryptoPaymentCandidate\(body\)/);
    expect(
      body.indexOf('await readCryptoOrderAuthority(cacheEntry, controller.signal)'),
    ).toBeLessThan(body.indexOf('setCryptoCopyTarget(cacheEntry.paymentAddress)'));
  });

  it('shared-engine framing accurately distinguishes operational and optional-capability differences', () => {
    expect(body).toMatch(
      /Every tier runs the same verified browser engine and can use every\s*\n?\s*currently available archetype\. Operational limits and optional capabilities\s*\n?\s*differ — compare concurrency, profiles, storage, saved proxies, access,\s*\n?\s*and AI billing below/,
    );
    expect(body).not.toMatch(/Only concurrent caps and profile\s+counts change/);
  });

  it("Cancel + refund-honesty framing pinned (legal-grounded rewrite: the old automated '14-day pro-rated refund' promise — refunds are admin-manual only, no automated mechanism exists — replaced with 'plan stays active through the paid period, no automatic refunds for unused time, EU/UK 14-day withdrawal handled case-by-case via support@driftstack.dev, crypto non-refundable')", () => {
    expect(body).toMatch(
      /Cancel or downgrade anytime — your plan stays active\s+through the end of the period you've already paid for\. We don't\s+provide automatic refunds for unused time\./,
    );
    expect(body).toMatch(
      /If you're an EU\/UK\s+consumer and want to cancel within 14 days of first subscribing,\s+contact <a href="mailto:support@driftstack\.dev"[^>]*>support@driftstack\.dev<\/a>\s+and we'll handle it case by case\. Crypto payments are non-refundable\./,
    );
    expect(body).not.toMatch(/Cancel anytime; pro-rated refunds within the first 14 days\./);
    expect(body).not.toMatch(/we refund the unused remainder\s+pro-rated to the day\./);
  });

  it("change-plan-reuse comment pinned (page reachable from /billing 'Change plan' too)", () => {
    expect(body).toMatch(
      /"Change plan" reuse: this same page is reachable from \/billing\s*\n?\s*\/\/\s*"Change plan" link \(post-onboarding\)/,
    );
    expect(body).toMatch(/Every account starts on the/);
  });

  it('withSidebar={false} pre-subscribed layout', () => {
    expect(body).toMatch(/<DashboardLayout title="Select tier" withSidebar=\{false\}/);
  });

  it('localStorage ds_web_session_token gate (anonymous redirect to "Sign up first")', () => {
    expect(body).toMatch(/try \{\s*return localStorage\.getItem\('ds_web_session_token'\)/);
    expect(body).toMatch(/showBanner\('Sign up first\.'\);/);
  });

  it('requires a current billing snapshot before exposing either payment path', () => {
    for (const selector of ['data-action="buy-tier"', 'data-action="buy-tier-crypto"']) {
      const start = body.indexOf(selector);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(body.slice(start, body.indexOf('>', start))).toMatch(/disabled/);
    }
    expect(body).toMatch(/let billingDataAvailable = false/);
    expect(body).toMatch(/if \(!billingDataAvailable\) \{[\s\S]*?Wait for live billing to load/);
    expect(body).toMatch(/setBillingAuthority\(true\);\s*applySubscriptionState/);
    expect(body).toMatch(/Use the Stripe billing portal to change an active plan/);
    expect(body).toMatch(/if \(typeof window\.dashboardHydrated === 'function'\)/);
  });

  it('data-action="buy-tier" buttons carry data-tier attribute (router knows which tier checkout to start)', () => {
    expect(body).toMatch(/data-action="buy-tier"\s*\n?\s*data-tier=\{t\.id\}/);
  });
});
