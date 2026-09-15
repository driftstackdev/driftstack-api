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

  it("Brand intro (W501 noob-friendly + honesty pass): plain 'iPhone Safari browser running in the cloud — every website it visits sees a genuine iPhone, not a bot.' Dropped the 'WebKit engine' jargon for the new-user welcome screen; keeps the honesty-pass posture (NO 'real iPhone Safari' binary claim — says 'an iPhone Safari browser', matching first-session.astro).", () => {
    expect(body).toMatch(
      /Driftstack gives you an iPhone Safari browser running in the\s*cloud — every website it visits sees a genuine iPhone, not a bot\./,
    );
    // Honesty pass: must NOT claim to run the Safari binary ("real iPhone Safari").
    expect(body).not.toMatch(/real iPhone Safari/);
  });

  it('Start-free card framing pinned: $0 · no card + already-on-free-plan + go-to-dashboard CTA (2026-07-02: CTA moved off the deleted /first-session onto the dashboard home — sessions launch in the desktop app)', () => {
    expect(body).toMatch(
      // S21 2026-07-06: text-tk-accent-text (was text-tk-accent-soft — the
      // 13%-alpha WASH token misused as a text color; ~1.2:1, invisible).
      /<span class="font-mono text-sm text-tk-accent-text">\$0 · no card<\/span>/,
    );
    expect(body).toMatch(
      /Your account is already on the free plan: 1 profile, 1 session at a time, each\s*session of up to 20 minutes\. No subscription, no expiry/,
    );
    expect(body).toMatch(
      /<a href="\/" class="btn-primary inline-flex">\s*Go to your dashboard\s*<\/a>/,
    );
  });

  it("Monthly-tiers framing (R6 plain language): '$79–$1,499 / mo' + paid API keys / SDK from your own code", () => {
    expect(body).toMatch(
      /<span class="font-mono text-sm text-tk-ink-3">\$79–\$1,499 \/ mo<\/span>/,
    );
    expect(body).toMatch(
      /Upgrade to a paid plan to run more sessions at once, save more profiles, and\s*use API keys and the SDK from your own code — Personal for hand-\s*driven sessions, all the way up to API Scale for high-volume\s*automation\. Cancel anytime\./,
    );
    expect(body).toMatch(
      /<a href="\/select-tier\/" class="btn-secondary mt-4 inline-flex">View tiers<\/a>/,
    );
  });

  it("'What happens next' 3-step framing pinned (R6 numbered-circle visual + simpler copy)", () => {
    expect(body).toMatch(/aria-label="What happens next"/);
    // Step 1 — start-free-or-pick-paid + Stripe redirect + "we never see them" reassurance.
    expect(body).toMatch(
      /Start free with no card — or pick a paid tier and we'll send you\s*to Stripe to confirm payment\./,
    );
    expect(body).toMatch(/Your card details stay between you\s*and Stripe — we never see them\./);
    // Step 2 — the app is a PUBLIC cross-platform download; browser sign-in then
    // gives the app its own limited credential. Not signed with Apple or Microsoft
    // yet, said in customer words (2026-09-15 plain-words pass).
    expect(body).toMatch(
      /Download the desktop app for macOS, Windows or Linux, then choose\s*browser sign-in\. The app signs in with its own limited credential,\s*and that's where Free customers launch and drive iPhone Safari\s*sessions\. Your computer may show a security warning on first launch\s*because the app isn't yet signed with Apple or Microsoft; this is expected\./,
    );
    expect(body).toContain('https://github.com/driftstackdev/driftstack-api/releases/latest');
    // Step 3 — API keys / running sessions from code require a paid plan with API access.
    expect(body).toMatch(
      /On a paid plan with API access, create an API key to run sessions\s*from your own code\. Keys can be revoked or rotated any time; the\s*Free plan's desktop sign-in doesn't need one\./,
    );
    expect(body).toMatch(
      /the app gets its own limited sign-in credential, so\s+you don't need an API key/,
    );
    expect(body).not.toMatch(/API key[^.]*connect the desktop app/i);
    // The numbered-circle visual treatment: glow-red bordered round badges 1/2/3.
    expect(body).toMatch(/rounded-full border border-tk-accent\/40 bg-tk-accent\/10/);
  });

  it("Defensive redirect: localStorage.getItem('ds_web_session_token') === null → window.location.replace('/signup/')", () => {
    expect(body).toMatch(
      /\/\/ Defensive redirect: if user lands here without a token, send to\s*\/\/ \/signup\/\. \(Direct nav to \/welcome shouldn't normally happen\.\)\s*\(function \(\) \{\s*let token = null;\s*try \{\s*token = localStorage\.getItem\('ds_web_session_token'\);\s*\} catch \{\s*token = null;\s*\}\s*if \(!token\) window\.location\.replace\('\/signup\/'\);\s*\}\)\(\);/,
    );
  });

  it("Skip-to-dashboard escape: 'Already know what you want? Skip to dashboard' link to '/'", () => {
    expect(body).toMatch(/Already know what you want\?/);
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(
      /<a\s*href="\/"\s*class="text-tk-accent-text[^"]*"\s*>\s*Skip to dashboard\s*<\/a>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
