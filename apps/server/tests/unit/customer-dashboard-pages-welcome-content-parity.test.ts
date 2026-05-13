// W491.B — drift guard for apps/customer-dashboard/src/pages/welcome.astro.
// V-184a + V-501 onboarding step 3 (after signup + verify). Drift
// here either drops the no-token defensive redirect (customers
// landing here without auth would see the page but the next step
// /select-tier would fail) or breaks the trial-pack 'most first-
// time customers start here' framing (would push customers into
// the higher-cost monthly tiers).
//
//   • V-184a + V-501 framing pinned.
//   • Trial pack '$2.99 · one-time' + 16-hour + 14-day-window
//     framing.
//   • Monthly tiers '$79–$1,499 / mo' range (Solo Manual → API
//     Scale).
//   • 3-step 'What happens next' (Stripe → first session → API
//     key auto-mint).
//   • Defensive redirect: no ds_web_session_token → /signup.
//   • aria-label='What happens next' on the steps section.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/welcome.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W491.B apps/customer-dashboard/src/pages/welcome.astro content parity', () => {
  const body = read(LIB);

  it("V-184a + V-501 framing pinned: 'onboarding step 3. Brief intro + CTA to tier-select.' + 'copy polish + What happens next 3-step within Tier-1 bounds.' + 'Tier 3 visual UX (full brand intro + animated diagrams) lands in V-184b draft.' — pinned so the onboarding-step framing + the V-184b deferral note survive", () => {
    expect(body).toMatch(
      /\/\/ V-184a — onboarding step 3\. Brief intro \+ CTA to tier-select\.\s*\n?\s*\/\/ V-501 — copy polish \+ "what happens next" 3-step within Tier-1 bounds\.\s*\n?\s*\/\/ Tier 3 visual UX \(full brand intro \+ animated diagrams\) lands in\s*\n?\s*\/\/ V-184b draft\./,
    );
  });

  it("Brand intro framing pinned: 'Driftstack runs real iPhone Safari sessions — same WebKit C++ engine, same fingerprint surface as a physical iPhone. Pick how you want to start:' — pinned so the value-prop framing on the post-signup welcome stays explicit (drift would weaken the customer's understanding that they're getting REAL Safari, not a simulator)", () => {
    expect(body).toMatch(
      /Driftstack runs real iPhone Safari sessions — same WebKit C\+\+ engine,\s*\n?\s*same fingerprint surface as a physical iPhone\. Pick how you want to\s*\n?\s*start:/,
    );
  });

  it("Trial pack framing pinned: '$2.99 · one-time' price + '16 hours of session time. No subscription, no auto-renewal. 14-day window. Best path to evaluate before committing — most first-time customers start here.' — pinned so the trial-pack positioning as the recommended first step survives + the price ($2.99) + duration (16h) + window (14d) stay accurate", () => {
    expect(body).toMatch(
      /<span class="font-mono text-sm text-slate-700">\$2\.99 · one-time<\/span>/,
    );
    expect(body).toMatch(
      /16 hours of session time\. No subscription, no auto-renewal\.\s*\n?\s*14-day window\. Best path to evaluate before committing — most\s*\n?\s*first-time customers start here\./,
    );
    expect(body).toMatch(
      /<a href="\/select-tier\?focus=trial" class="btn-primary mt-4 inline-flex">\s*\n?\s*Start trial pack\s*\n?\s*<\/a>/,
    );
  });

  it("Monthly-tiers framing pinned: '$79–$1,499 / mo' range + 'Skip the trial and go straight to a monthly subscription — Solo Manual for human-driven sessions through to API Scale for high-volume automation. Cancel anytime.' — pinned so the price range + tier-purpose vocabulary (manual = human, API = automation) survives", () => {
    expect(body).toMatch(
      /<span class="font-mono text-sm text-slate-500">\$79–\$1,499 \/ mo<\/span>/,
    );
    expect(body).toMatch(
      /Skip the trial and go straight to a monthly subscription — Solo\s*\n?\s*Manual for human-driven sessions through to API Scale for\s*\n?\s*high-volume automation\. Cancel anytime\./,
    );
    expect(body).toMatch(
      /<a href="\/select-tier" class="btn-secondary mt-4 inline-flex">View tiers<\/a>/,
    );
  });

  it("'What happens next' 3-step framing pinned: (1) Stripe redirect 'We never see your card details.' (2) First session 'a real iPhone Safari that runs on our fleet.' (3) API key auto-mint 'You can revoke or rotate it any time on the API keys page.' — pinned so the post-payment expectations stay explicit (drift to dropping the 'we never see your card' clause would weaken the security trust signal)", () => {
    expect(body).toMatch(
      /You'll be redirected to Stripe to confirm payment\. We never see\s*\n?\s*your card details\./,
    );
    expect(body).toMatch(
      /Back here, you'll create your first session — a real iPhone\s*\n?\s*Safari that runs on our fleet\./,
    );
    expect(body).toMatch(
      /We'll mint your first API key automatically\. You can revoke or\s*\n?\s*rotate it any time on the API keys page\./,
    );
    expect(body).toMatch(/aria-label="What happens next"/);
  });

  it("Defensive redirect: localStorage.getItem('ds_web_session_token') === null → window.location.replace('/signup') — pinned so direct navigation to /welcome without auth doesn't show the page with broken downstream actions (use replace() to avoid a back-button loop)", () => {
    expect(body).toMatch(
      /\/\/ Defensive redirect: if user lands here without a token, send to\s*\n?\s*\/\/ \/signup\. \(Direct nav to \/welcome shouldn't normally happen\.\)\s*\n?\s*\(function \(\) \{\s*\n?\s*const token = localStorage\.getItem\('ds_web_session_token'\);\s*\n?\s*if \(!token\) window\.location\.replace\('\/signup'\);\s*\n?\s*\}\)\(\);/,
    );
  });

  it("Skip-to-dashboard escape: 'Already know what you want? Skip to dashboard' link to '/' — pinned so customers who already know they want to configure manually (not via tier-select wizard) have a path out (drift to dropping this would force every customer through the tier-select funnel)", () => {
    expect(body).toMatch(
      /Already know what you want\? <a href="\/" class="text-oxblood-700 underline">\s*\n?\s*Skip to dashboard\s*\n?\s*<\/a>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
