// W739 — customer-dashboard forgot-password.astro + welcome.astro
// V-273 + onboarding-step-3 page parity. Sixty-fifth in the cross-
// SDK drift-guard series. Closes the dashboard-auth-page sextet
// (W735 verify-email + W736 reset-password/magic-link + W737
// signup/login + W738 cli/authorize + W739 forgot-password/welcome).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const FORGOT = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/forgot-password.astro');
const WELCOME = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/welcome.astro');

describe('W739 dashboard forgot-password + welcome page parity', () => {
  it('both pages exist at canonical paths', () => {
    expect(existsSync(FORGOT)).toBe(true);
    expect(existsSync(WELCOME)).toBe(true);
  });

  // --- forgot-password.astro --------------------------------------

  it('CRITICAL forgot-password V-273 anchor + V-079 backend pairing pinned. The "Password-reset request page. Pairs with V-079 backend route POST /v1/auth/password-reset/request" framing threads BOTH anchors.', () => {
    const f = read(FORGOT);
    expect(f).toMatch(/V-273 — Password-reset request page\. Pairs with the V-079 backend/);
    expect(f).toMatch(/route `POST \/v1\/auth\/password-reset\/request`/);
  });

  it('CRITICAL forgot-password 4-step canonical flow framing pinned — request → stable response shape → success message → click email link → /reset-password handles actual reset.', () => {
    const f = read(FORGOT);

    expect(f).toMatch(/1\. User enters their email \+ submits/);
    expect(f).toMatch(/2\. Server returns `\{sent: true, expires_at\}`\. The shape is stable/);
    expect(f).toMatch(/3\. Page shows "Check your inbox" message \+ the email used \+ the/);
    expect(f).toMatch(/4\. User clicks the link in the email → \/reset-password\?token=…/);
  });

  it('CRITICAL forgot-password anti-enumeration framing pinned. The wording — "The shape is stable regardless of whether the email matches an account (the server never confirms account existence via this endpoint — anti-enumeration)" — is what tells engineers the server-side guarantee.', () => {
    const f = read(FORGOT);

    expect(f).toMatch(
      /The shape is stable\s*\n\/\/\s+regardless of whether the email matches an account \(the server\s*\n\/\/\s+never confirms account existence via this endpoint — anti-\s*\n\/\/\s+enumeration\)/,
    );
  });

  it('CRITICAL forgot-password POST /v1/auth/password-reset/request contract pinned — body {email}. The 1-field body matches the V-079 request route.', () => {
    const f = read(FORGOT);
    expect(f).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/auth\/password-reset\/request'/);
    expect(f).toMatch(/JSON\.stringify\(\{ email: email \}\)/);
  });

  it('CRITICAL forgot-password debug_token dev-mode surface pinned. When server emits debug_token (AUTH_EXPOSE_DEBUG_TOKEN=true), page surfaces a clickable link to /reset-password?token=... — saves the round-trip-through-email-inbox during local development.', () => {
    const f = read(FORGOT);

    expect(f).toMatch(
      /Dev convenience: when the server returns a `debug_token` \(set when\s*\n\/\/\s+AUTH_EXPOSE_DEBUG_TOKEN=true\), the page surfaces it for paste-into-\s*\n\/\/\s+\/reset-password during local development/,
    );

    // Implementation: build the reset-password link with the token.
    expect(f).toMatch(
      /debugLink\.setAttribute\(\s*\n\s+'href',\s*\n\s+'\/reset-password\?token=' \+ encodeURIComponent\(body\.debug_token\)/,
    );
    expect(f).toMatch(/debugWrap\.classList\.remove\('hidden'\)/);
  });

  it('CRITICAL forgot-password expires_at countdown pinned. The minutes-remaining calculation gives customers a clear sense of how long they have to click the link.', () => {
    const f = read(FORGOT);

    expect(f).toMatch(
      /if \(body\.expires_at\) \{\s*\n\s+const minutes = Math\.max\(\s*\n\s+1,\s*\n\s+Math\.round\(\(new Date\(body\.expires_at\)\.getTime\(\) - Date\.now\(\)\) \/ 60000\)/,
    );
    expect(f).toMatch(/successWindow\.textContent = minutes \+ ' minutes'/);
  });

  it('CRITICAL forgot-password success message — "If <email> matches a Driftstack account, a reset link is on the way" anti-enumeration phrasing pinned. Drift to "We sent a reset link to <email>" would CONFIRM account existence — defeating the V-273 anti-enumeration design.', () => {
    const f = read(FORGOT);
    expect(f).toMatch(
      /If <span data-success-email[^>]*><\/span> matches a Driftstack\s*\n\s+account, a reset link is on the way/,
    );
  });

  it('CRITICAL forgot-password hides form + shows success on completion. Drift to keeping form visible would let users submit twice + waste rate-limit budget.', () => {
    const f = read(FORGOT);
    expect(f).toMatch(
      /form\.classList\.add\('hidden'\);\s*\n\s+success\.classList\.remove\('hidden'\)/,
    );
  });

  it('CRITICAL forgot-password back-to-login link pinned. Drift would leave users stuck on the success screen with no easy way back.', () => {
    const f = read(FORGOT);
    expect(f).toMatch(/Remembered it\? <a\s*\n\s+href="\/login\/"/);
  });

  // --- welcome.astro ----------------------------------------------

  it('CRITICAL welcome onboarding-step-3 framing pinned. The "Onboarding step 3 — brief intro + CTA to tier-select" framing threads the V-184a 4-step onboarding sequence.', () => {
    const w = read(WELCOME);
    expect(w).toMatch(/Onboarding step 3 — brief intro \+ CTA to tier-select/);
  });

  it('CRITICAL welcome 2-choice card-pair pinned — Start free ($0 · no card) + Pick a tier ($79-$1,499/mo). The perpetual free tier replaced the one-time trial pack; the free card routes to the dashboard home (2026-07-02 account-portal IA — was /first-session, now deleted), the paid card to /select-tier.', () => {
    const w = read(WELCOME);

    // Free card.
    expect(w).toMatch(/<h2 class="text-lg font-semibold text-tk-ink">Start free<\/h2>/);
    expect(w).toMatch(/\$0 · no card/);
    expect(w).toMatch(/Your account is already on the free plan: 1 profile, 1 concurrent/);
    expect(w).toMatch(/<a href="\/" class="btn-primary/);

    // Paid-tier card.
    expect(w).toMatch(/<h2 class="text-lg font-semibold text-tk-ink">Pick a tier<\/h2>/);
    expect(w).toMatch(/<a href="\/select-tier\/" class="btn-secondary/);
  });

  it('CRITICAL welcome 3-step what-happens-next ordered list pinned. The 3 steps (Stripe payment + get the desktop app + create an API key) tell customers what to expect post-tier-select (2026-07-02 account-portal IA — step 2 funnels into the desktop app instead of creating a session in the web dashboard).', () => {
    const w = read(WELCOME);

    expect(w).toMatch(
      /Start free with no card — or pick a paid tier and we'll send you\s*\n\s+to Stripe to confirm payment\. Your card details stay between you\s*\n\s+and Stripe — we never see them/,
    );
    // Step 2 — download the desktop app + sign in; that's where sessions launch.
    expect(w).toMatch(
      /Download the Driftstack desktop app and sign in from your\s*\n\s+browser — that's where you launch and drive iPhone Safari\s*\n\s+sessions, with the option to route traffic through your own\s*\n\s+proxy or VPN/,
    );
    expect(w).toMatch(
      /Create an API key on the API keys page to connect the desktop\s*\n\s+app or the SDKs\. You can revoke or rotate it any time/,
    );
  });

  it('CRITICAL welcome defensive redirect to canonical /signup/ when no ds_web_session_token. The redirect prevents direct-nav to /welcome without an active session and avoids a static-host redirect hop.', () => {
    const w = read(WELCOME);

    expect(w).toMatch(
      /Defensive redirect: if user lands here without a token, send to\s*\n\s+\/\/ \/signup\/\. \(Direct nav to \/welcome shouldn't normally happen\.\)/,
    );
    expect(w).toMatch(
      /token = localStorage\.getItem\('ds_web_session_token'\);[\s\S]*?if \(!token\) window\.location\.replace\('\/signup\/'\)/,
    );
    expect(w).not.toContain("window.location.replace('/signup')");
  });

  it('CRITICAL welcome canonical positioning pinned (W501 noob-friendly + honesty pass): "Driftstack gives you an iPhone Safari browser running in the cloud — every website it visits sees a genuine iPhone, not a bot." Plain-language for the new-user screen; honesty pass preserved — says "an iPhone Safari browser" (NOT "real iPhone Safari" — we run WebKit built from source, not the Safari binary).', () => {
    const w = read(WELCOME);
    expect(w).toMatch(
      /Driftstack gives you an iPhone Safari browser running in the\s*\n\s+cloud — every website it visits sees a genuine iPhone, not a bot/,
    );
    expect(w).not.toMatch(/real iPhone Safari/);
  });

  it('CRITICAL welcome PCI-out-of-scope framing pinned. The wording — "Your card details stay between you and Stripe — we never see them" — is the customer-facing PCI claim. Matches ADR-002 (W733) Stripe-only fiat rail.', () => {
    const w = read(WELCOME);
    expect(w).toMatch(/Your card details stay between you\s*\n\s+and Stripe — we never see them/);
  });

  it('CRITICAL welcome skip-to-dashboard escape pinned. The "Already know what you want?" link lets repeat customers bypass the onboarding cards.', () => {
    const w = read(WELCOME);
    expect(w).toMatch(/Already know what you want\? <a\s*\n\s+href="\/"/);
    expect(w).toMatch(/Skip to dashboard/);
  });

  // --- Shared invariants -------------------------------------------

  it('CRITICAL both pages use DashboardLayout + withSidebar={false} (auth/onboarding pages have NO sidebar).', () => {
    for (const path of [FORGOT, WELCOME]) {
      const c = read(path);
      expect(c, `${path} DashboardLayout`).toMatch(/import DashboardLayout from/);
      expect(c, `${path} withSidebar={false}`).toMatch(/withSidebar=\{false\}/);
    }
  });

  it('CRITICAL forgot-password uses resolveApiBaseUrl() helper. (welcome.astro has no API calls — no helper needed.) Matches W735+W736+W737+W738 multi-env pattern.', () => {
    const f = read(FORGOT);
    expect(f).toMatch(/import \{ resolveApiBaseUrl \} from '\.\.\/lib\/api-base-url'/);
    expect(f).toMatch(/define:vars=\{\{ apiBaseUrl \}\}/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/dashboard-forgot-password-welcome-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
