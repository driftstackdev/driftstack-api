// W367.B — drift guard for customer-dashboard /welcome page
// content. V-184a + V-501. The first surface a verified customer
// sees post-signup. Existing welcome-page-parity + welcome-cta-
// consistency tests pin structural shape; this guard pins the
// load-bearing onboarding claims:
//
//   • Free-tier "Start free" $0 / no-card framing pinned (the
//     perpetual free tier replaced the one-time trial pack
//     2026-05-27; primary CTA goes to /first-session, no purchase).
//   • Tier range "$79–$1,499 / mo" pinned to match pricing
//     ladder bounds (Solo Manual → API Scale).
//   • "What happens next" 3-step pinned (Stripe / first session
//     / API key auto-mint) — the contract for the first 10
//     minutes of paid use.
//   • "We never see your card details" Stripe-PCI-shielding
//     claim pinned — load-bearing trust claim.
//   • Defensive redirect: no ds_web_session_token → /signup
//     (catches direct-nav to /welcome without auth).
//   • CTAs go to /first-session (free start) + /select-tier
//     (upgrade); the select-tier destination page must exist.
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

  it('free-tier figures pinned: Start free / $0 · no card / 1 profile / manual-only / no expiry', () => {
    expect(body).toMatch(/Start free/);
    expect(body).toMatch(/\$0 · no card/);
    expect(body).toMatch(/1 profile, 1 concurrent/);
    expect(body).toMatch(/No subscription, no expiry/);
    // No residual trial-pack purchase figures.
    expect(body).not.toMatch(/\$2\.99/);
  });

  it('tier-range hint "$79–$1,499 / mo" pinned (matches pricing ladder bounds)', () => {
    // A pricing change must update this hint too — otherwise
    // /welcome under-promises or over-promises.
    expect(body).toMatch(/\$79–\$1,499 \/ mo/);
    // "Solo Manual" + "API Scale" tier names also pinned.
    expect(body).toMatch(
      /Solo Manual for hand-\s*\n?\s*driven sessions, all the way up to API Scale/,
    );
  });

  it('"What happens next" 3-step contract pinned (Stripe / session / API key)', () => {
    expect(body).toContain('What happens next');
    // Step 1 — free-start (no card) OR paid Stripe redirect + card-
    // detail reassurance.
    expect(body).toMatch(
      /Start free with no card — or pick a paid tier and we'll send you\s+to Stripe to confirm payment\. Your card details stay between you\s+and Stripe — we never see them/,
    );
    // Step 2 — first session = iPhone Safari instance with optional
    // proxy/VPN egress. 2026-05-16 honesty pass dropped "real"; 2026-
    // 05-22 EU-fleet phrasing replaced with SOCKS5/OpenVPN/WireGuard
    // capability claim (founder direction: customers care about proxy
    // capabilities, not data-center location).
    expect(body).toMatch(
      /you'll create your first session — an iPhone\s+Safari instance with optional SOCKS5 \/ OpenVPN \/ WireGuard\s+egress per profile/,
    );
    // Step 3 — first API key auto-created + revocable.
    expect(body).toMatch(
      /We'll create your first API key automatically\. You can revoke\s+or rotate it any time on the API keys page/,
    );
  });

  it('defensive redirect: no ds_web_session_token → /signup (no orphan landings)', () => {
    expect(body).toMatch(
      /const token = localStorage\.getItem\('ds_web_session_token'\);\s*\n?\s*if \(!token\) window\.location\.replace\('\/signup'\);/,
    );
  });

  it('CTAs go to /first-session (free start) + /select-tier (upgrade) — destinations exist', () => {
    expect(body).toMatch(/href="\/first-session"/);
    expect(body).toMatch(/href="\/select-tier"/);
    expect(existsSync(SELECT_TIER)).toBe(true);
  });

  it('"Skip to dashboard" escape hatch points at root (/), not /sessions', () => {
    // Load-bearing routing decision — onboarding redirects logged-in
    // customers via the dashboard home, not a session-specific page.
    expect(body).toMatch(/Skip to dashboard\s*<\/a>/);
    expect(body).toMatch(/<a\s*\n?\s*href="\/"\s*\n?\s*class="text-glow-red[^"]*"\s*\n?\s*>/);
  });

  it('localStorage key ds_web_session_token (customer-dashboard convention)', () => {
    expect(body).toContain('ds_web_session_token');
  });

  it('R6 onboarding step 3 framing comment pinned', () => {
    expect(body).toMatch(/Onboarding step 3 — brief intro \+ CTA to tier-select/);
    expect(body).toMatch(/R6 polish/);
  });

  it('hero claim (R6 + 2026-05-16 honesty pass): iPhone Safari sessions on real WebKit + same engine + indistinguishable from a physical phone (was "real iPhone Safari sessions" — reframed to "real WebKit" since we build the WebKit engine, not the literal Safari binary; matches the homepage hero at 2d0deca0)', () => {
    expect(body).toMatch(
      /Driftstack runs iPhone Safari sessions on real WebKit — the same\s+engine every iPhone uses, so your sessions look indistinguishable\s+from a physical phone/,
    );
    expect(body).not.toMatch(/Driftstack runs real iPhone Safari sessions/);
  });

  it('layout uses withSidebar={false} (welcome surface is pre-tier-selection)', () => {
    // Pre-tier customers don't have the sidebar yet — pin so a
    // future layout default-on doesn't accidentally expose
    // sidebar items that need an active subscription.
    expect(body).toMatch(/<DashboardLayout title="Welcome" withSidebar=\{false\}/);
  });
});
