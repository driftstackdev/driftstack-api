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

  it('Trial-pack framing pinned: $2.99 · one-time + 16h + 14d + recommended-first-step language', () => {
    expect(body).toMatch(
      /<span class="font-mono text-sm text-glow-red-soft">\$2\.99 · one-time<\/span>/,
    );
    expect(body).toMatch(
      /16 hours of session time\. No subscription, no auto-renewal\.\s*\n?\s*14-day window\. The best way to try Driftstack before committing —\s*\n?\s*most first-time customers start here\./,
    );
    expect(body).toMatch(
      /<a href="\/select-tier\?focus=trial" class="btn-primary mt-4 inline-flex">\s*\n?\s*Start trial pack\s*\n?\s*<\/a>/,
    );
  });

  it("Monthly-tiers framing (R6 plain language): '$79–$1,499 / mo' + Solo Manual for hand-driven sessions / API Scale", () => {
    expect(body).toMatch(
      /<span class="font-mono text-sm text-ink-muted">\$79–\$1,499 \/ mo<\/span>/,
    );
    expect(body).toMatch(
      /Skip the trial and subscribe right away — Solo Manual for hand-\s*\n?\s*driven sessions, all the way up to API Scale for high-volume\s*\n?\s*automation\. Cancel anytime\./,
    );
    expect(body).toMatch(
      /<a href="\/select-tier" class="btn-secondary mt-4 inline-flex">View tiers<\/a>/,
    );
  });

  it("'What happens next' 3-step framing pinned (R6 numbered-circle visual + simpler copy)", () => {
    expect(body).toMatch(/aria-label="What happens next"/);
    // Step 1 — Stripe redirect + "we never see them" reassurance.
    expect(body).toMatch(
      /We'll send you to Stripe to confirm payment\. Your card details\s*\n?\s*stay between you and Stripe — we never see them\./,
    );
    // Step 2 — first session = iPhone Safari instance on our EU fleet.
    // 2026-05-16 honesty pass: "a real iPhone Safari instance" → "an
    // iPhone Safari instance" (drop "real" implying literal binary;
    // surrounding context establishes WebKit-on-our-fleet posture).
    expect(body).toMatch(
      /Back here, you'll create your first session — an iPhone\s*\n?\s*Safari instance running on our EU fleet\./,
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
