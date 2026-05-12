// W367.B — drift guard for customer-dashboard /welcome page
// content. V-184a + V-501. The first surface a verified customer
// sees post-signup. Existing welcome-page-parity + welcome-cta-
// consistency tests pin structural shape; this guard pins the
// load-bearing onboarding claims:
//
//   • Trial-pack $2.99 / one-time / 16 hours / 14-day window
//     figures pinned exactly (the customer's expectation set
//     here must match the /pricing#trial-pack page and the
//     /select-tier?focus=trial flow).
//   • Tier range "$79–$1,499 / mo" pinned to match pricing
//     ladder bounds (Solo Manual → API Scale).
//   • "What happens next" 3-step pinned (Stripe / first session
//     / API key auto-mint) — the contract for the first 10
//     minutes of paid use.
//   • "We never see your card details" Stripe-PCI-shielding
//     claim pinned — load-bearing trust claim.
//   • Defensive redirect: no ds_web_session_token → /signup
//     (catches direct-nav to /welcome without auth).
//   • CTAs go to /select-tier?focus=trial + /select-tier; both
//     cross-link to the same destination page that must exist.
//   • localStorage key ds_web_session_token.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/welcome.astro');
const SELECT_TIER = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/select-tier.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W367.B customer-dashboard /welcome page content parity', () => {
  const body = read(PAGE);

  it('trial-pack figures pinned exactly: $2.99 · one-time / 16 hours / 14-day window', () => {
    expect(body).toMatch(/\$2\.99 · one-time/);
    expect(body).toMatch(/16 hours of session time/);
    expect(body).toMatch(/No subscription, no auto-renewal/);
    expect(body).toMatch(/14-day window/);
  });

  it('tier-range hint "$79–$1,499 / mo" pinned (matches pricing ladder bounds)', () => {
    // A pricing change must update this hint too — otherwise
    // /welcome under-promises or over-promises.
    expect(body).toMatch(/\$79–\$1,499 \/ mo/);
    // "Solo Manual" + "API Scale" tier names also pinned.
    expect(body).toMatch(/Solo\s+Manual for human-driven sessions through to API Scale/);
  });

  it('"What happens next" 3-step contract pinned (Stripe / session / API key)', () => {
    expect(body).toContain('What happens next');
    // Step 1 — Stripe redirect + "We never see your card details".
    expect(body).toMatch(
      /You'll be redirected to Stripe to confirm payment\. We never see\s+your card details/,
    );
    // Step 2 — first session = real iPhone Safari on the fleet.
    expect(body).toMatch(
      /you'll create your first session — a real iPhone\s+Safari that runs on our fleet/,
    );
    // Step 3 — first API key auto-minted + revocable.
    expect(body).toMatch(
      /We'll mint your first API key automatically\. You can revoke or\s+rotate it any time on the API keys page/,
    );
  });

  it('defensive redirect: no ds_web_session_token → /signup (no orphan landings)', () => {
    expect(body).toMatch(
      /const token = localStorage\.getItem\('ds_web_session_token'\);\s*\n?\s*if \(!token\) window\.location\.replace\('\/signup'\);/,
    );
  });

  it('CTAs go to /select-tier (+ ?focus=trial variant) — destination page exists', () => {
    expect(body).toMatch(/href="\/select-tier\?focus=trial"/);
    expect(body).toMatch(/href="\/select-tier"/);
    expect(existsSync(SELECT_TIER)).toBe(true);
  });

  it('"Skip to dashboard" escape hatch points at root (/), not /sessions', () => {
    // Load-bearing routing decision — V-184a redirects logged-in
    // customers via the dashboard home, not a session-specific page.
    expect(body).toMatch(/Skip to dashboard\s*<\/a>/);
    expect(body).toMatch(/<a href="\/" class="text-oxblood-700 underline">/);
  });

  it('localStorage key ds_web_session_token (customer-dashboard convention)', () => {
    expect(body).toContain('ds_web_session_token');
  });

  it('V-184a + V-501 framing comment pinned (onboarding step 3 + copy polish)', () => {
    expect(body).toMatch(/V-184a — onboarding step 3/);
    expect(body).toMatch(/V-501 — copy polish \+ "what happens next" 3-step within Tier-1 bounds/);
  });

  it('hero claim: "Driftstack runs real iPhone Safari sessions — same WebKit C++ engine"', () => {
    // First post-verification message a customer reads — pin the
    // engine framing so it stays aligned with the marketing-site
    // /security + /comparison pages.
    expect(body).toMatch(
      /Driftstack runs real iPhone Safari sessions — same WebKit C\+\+ engine,\s+same fingerprint surface as a physical iPhone/,
    );
  });

  it('layout uses withSidebar={false} (welcome surface is pre-tier-selection)', () => {
    // Pre-tier customers don't have the sidebar yet — pin so a
    // future layout default-on doesn't accidentally expose
    // sidebar items that need an active subscription.
    expect(body).toMatch(/<DashboardLayout title="Welcome" withSidebar=\{false\}/);
  });
});
