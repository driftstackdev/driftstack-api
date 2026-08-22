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
//     ladder bounds (Personal → API Scale).
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

  it('free-tier figures pinned: Start free / $0 · no card / 1 profile / 1 concurrent / no expiry', () => {
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
    // "Personal" + "API Scale" tier names also pinned.
    expect(body).toMatch(/Personal for hand-\s*\n?\s*driven sessions, all the way up to API Scale/);
  });

  it('"What happens next" separates Free desktop credentialing from paid customer API keys', () => {
    expect(body).toContain('What happens next');
    // Step 1 — free-start (no card) OR paid Stripe redirect + card-
    // detail reassurance.
    expect(body).toMatch(
      /Start free with no card — or pick a paid tier and we'll send you\s+to Stripe to confirm payment\. Your card details stay between you\s+and Stripe — we never see them/,
    );
    // Step 2 — the app is a PUBLIC cross-platform download; Free then uses browser
    // sign-in to provision its restricted device credential. Not OS-code-signed.
    expect(body).toMatch(
      /Download the desktop app for macOS, Windows or Linux, then choose\s+browser sign-in\. Driftstack provisions a restricted device\s+credential for the app; that's where Free customers launch and drive\s+iPhone Safari sessions\. The builds are not OS-code-signed yet, so\s+macOS Gatekeeper or Windows SmartScreen warns on first launch\./,
    );
    expect(body).toContain('https://github.com/driftstackdev/driftstack-api/releases/latest');
    // Step 3 — customer keys and SDK automation are paid-tier capabilities.
    expect(body).toMatch(
      /On an API-enabled paid tier, create a customer API key for SDK\s+automation\. Customer keys can be revoked or rotated any time;\s+Free desktop sign-in does not require one/,
    );
    expect(body).toMatch(/restricted device credential for the\s+app, not a customer API key/);
    expect(body).toMatch(/customer API\s+keys, and SDK automation/);
    expect(body).not.toMatch(/API key[^.]*connect the desktop app/i);
  });

  it('defensive redirect: no ds_web_session_token → canonical /signup/ (no orphan landings or static-host redirect hop)', () => {
    expect(body).toMatch(
      /let token = null;\s*try\s*\{\s*token = localStorage\.getItem\('ds_web_session_token'\);\s*\} catch\s*\{\s*token = null;\s*\}\s*if \(!token\) window\.location\.replace\('\/signup\/'\);/,
    );
    expect(body).not.toContain("window.location.replace('/signup')");
  });

  it('CTAs go to the dashboard home (free start) + /select-tier (upgrade) — destinations exist (2026-07-02: free CTA moved off the deleted /first-session)', () => {
    expect(body).toMatch(/<a href="\/" class="btn-primary inline-flex">/);
    expect(body).toMatch(/href="\/select-tier\/"/);
    expect(existsSync(SELECT_TIER)).toBe(true);
  });

  it('"Skip to dashboard" escape hatch points at root (/), not /sessions', () => {
    // Load-bearing routing decision — onboarding redirects logged-in
    // customers via the dashboard home, not a session-specific page.
    expect(body).toMatch(/Skip to dashboard\s*<\/a>/);
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(/<a\s*\n?\s*href="\/"\s*\n?\s*class="text-tk-accent-text[^"]*"\s*\n?\s*>/);
  });

  it('localStorage key ds_web_session_token (customer-dashboard convention)', () => {
    expect(body).toContain('ds_web_session_token');
  });

  it('R6 onboarding step 3 framing comment pinned', () => {
    expect(body).toMatch(/Onboarding step 3 — brief intro \+ CTA to tier-select/);
    expect(body).toMatch(/R6 polish/);
  });

  it('hero claim (W501 noob-friendly + honesty pass): "an iPhone Safari browser running in the cloud — every website it visits sees a genuine iPhone, not a bot." De-jargoned the WebKit-engine framing for the new-user screen; honesty pass preserved — "an iPhone Safari browser" NOT "real iPhone Safari" (we run WebKit from source, not the binary).', () => {
    expect(body).toMatch(
      /Driftstack gives you an iPhone Safari browser running in the\s+cloud — every website it visits sees a genuine iPhone, not a bot/,
    );
    expect(body).not.toMatch(/real iPhone Safari/);
  });

  it('layout uses withSidebar={false} (welcome surface is pre-tier-selection)', () => {
    // Pre-tier customers don't have the sidebar yet — pin so a
    // future layout default-on doesn't accidentally expose
    // sidebar items that need an active subscription.
    expect(body).toMatch(/<DashboardLayout title="Welcome" withSidebar=\{false\}/);
  });
});
