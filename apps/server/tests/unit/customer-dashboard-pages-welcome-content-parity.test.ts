// W491.B (R6-refreshed) — drift guard for apps/customer-dashboard/src/pages/welcome.astro.
// R6 simplified the copy for non-technical readers and dropped the
// V-NNN internal tracking IDs from customer-visible text. This guard
// pins the load-bearing claims on the rewritten page.

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

  it('R6 onboarding-step-3 framing comment pinned', () => {
    expect(body).toMatch(/Onboarding step 3 — brief intro \+ CTA to tier-select\. R6 polish/);
  });

  it("Brand intro (R6 + 2026-05-16 honesty pass): 'iPhone Safari sessions on real WebKit — the same engine every iPhone uses, so your sessions look indistinguishable from a physical phone.' Aligned with the homepage hero rewrite at 2d0deca0 — 'real WebKit' (engine, which we DO build from Apple's source) rather than 'real iPhone Safari' (binary, which we don't run literally).", () => {
    expect(body).toMatch(
      /Driftstack runs iPhone Safari sessions on real WebKit — the same\s*\n?\s*engine every iPhone uses, so your sessions look indistinguishable\s*\n?\s*from a physical phone\./,
    );
    expect(body).not.toMatch(/Driftstack runs real iPhone Safari sessions/);
  });

  it('Start-free card framing pinned: $0 · no card + already-on-free-plan + create-first-session CTA', () => {
    expect(body).toMatch(
      /<span class="font-mono text-sm text-glow-red-soft">\$0 · no card<\/span>/,
    );
    expect(body).toMatch(
      /Your account is already on the free plan: 1 profile, 1 concurrent\s*\n?\s*session, manual-only\. No subscription, no expiry — the best way to\s*\n?\s*try Driftstack before committing\./,
    );
    expect(body).toMatch(
      /<a href="\/first-session" class="btn-primary mt-4 inline-flex">\s*\n?\s*Create your first session\s*\n?\s*<\/a>/,
    );
  });

  it("Monthly-tiers framing (R6 plain language): '$79–$1,499 / mo' + Solo Manual for hand-driven sessions / API Scale", () => {
    expect(body).toMatch(
      /<span class="font-mono text-sm text-ink-muted">\$79–\$1,499 \/ mo<\/span>/,
    );
    expect(body).toMatch(
      /Upgrade to a paid plan for more concurrency, more profiles, and API\s*\n?\s*access — Solo Manual for hand-\s*\n?\s*driven sessions, all the way up to API Scale for high-volume\s*\n?\s*automation\. Cancel anytime\./,
    );
    expect(body).toMatch(
      /<a href="\/select-tier" class="btn-secondary mt-4 inline-flex">View tiers<\/a>/,
    );
  });

  it("'What happens next' 3-step framing pinned (R6 numbered-circle visual + simpler copy)", () => {
    expect(body).toMatch(/aria-label="What happens next"/);
    // Step 1 — start-free-or-pick-paid + Stripe redirect + "we never see them" reassurance.
    expect(body).toMatch(
      /Start free with no card — or pick a paid tier and we'll send you\s*\n?\s*to Stripe to confirm payment\./,
    );
    expect(body).toMatch(
      /Your card details stay between you\s*\n?\s*and Stripe — we never see them\./,
    );
    // Step 2 — first session = iPhone Safari instance with optional
    // proxy/VPN egress. 2026-05-16 honesty pass dropped "real"; 2026-
    // 05-22 EU-fleet phrasing replaced with proxy-capability claim
    // per founder direction.
    expect(body).toMatch(
      /Back here, you'll create your first session — an iPhone\s*\n?\s*Safari instance with optional SOCKS5 \/ OpenVPN \/ WireGuard\s*\n?\s*egress per profile\./,
    );
    // Step 3 — first API key auto-created + revocable.
    expect(body).toMatch(
      /We'll create your first API key automatically\. You can revoke\s*\n?\s*or rotate it any time on the API keys page\./,
    );
    // The numbered-circle visual treatment: glow-red bordered round badges 1/2/3.
    expect(body).toMatch(/rounded-full border border-glow-red\/40 bg-glow-red\/10/);
  });

  it("Defensive redirect: localStorage.getItem('ds_web_session_token') === null → window.location.replace('/signup')", () => {
    expect(body).toMatch(
      /\/\/ Defensive redirect: if user lands here without a token, send to\s*\n?\s*\/\/ \/signup\. \(Direct nav to \/welcome shouldn't normally happen\.\)\s*\n?\s*\(function \(\) \{\s*\n?\s*const token = localStorage\.getItem\('ds_web_session_token'\);\s*\n?\s*if \(!token\) window\.location\.replace\('\/signup'\);\s*\n?\s*\}\)\(\);/,
    );
  });

  it("Skip-to-dashboard escape: 'Already know what you want? Skip to dashboard' link to '/'", () => {
    expect(body).toMatch(/Already know what you want\?/);
    expect(body).toMatch(
      /<a\s*\n?\s*href="\/"\s*\n?\s*class="text-glow-red[^"]*"\s*\n?\s*>\s*Skip to dashboard\s*<\/a>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
