// W737 — customer-dashboard signup.astro + login.astro V-079 page
// parity. Sixty-third in the cross-SDK drift-guard series. Closes
// the dashboard-auth-page guard quartet (W735 verify-email + W736
// reset-password/magic-link + W737 signup/login).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const SIGNUP = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/signup.astro');
const LOGIN = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/login.astro');
const AUTH_ROUTE_PAGES = [
  SIGNUP,
  LOGIN,
  resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/verify-email.astro'),
  resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/team/accept.astro'),
  resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/cli/authorize.astro'),
];

describe('W737 dashboard signup + login pages V-079 parity', () => {
  it('both pages exist at canonical paths', () => {
    expect(existsSync(SIGNUP)).toBe(true);
    expect(existsSync(LOGIN)).toBe(true);
  });

  // --- signup.astro -----------------------------------------------

  it('CRITICAL current signup onboarding-flow framing pinned. The "signup → verify-email → welcome → select-tier → dashboard" sequence is the canonical onboarding shape.', () => {
    const s = read(SIGNUP);
    expect(s).toMatch(/\/\/ Account onboarding flow\./);
    expect(s).toMatch(/Flow: signup → verify-email → welcome → select-tier → dashboard/);
    expect(s).toMatch(/Each page uses localStorage\.ds_web_session_token for cross-page state/);
  });

  it('CRITICAL signup POST /v1/auth/signup contract pinned — body {email, password, name?}. The name field is optional; drift to making it required would break customers signing up without a display name.', () => {
    const s = read(SIGNUP);

    expect(s).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/auth\/signup'/);
    expect(s).toMatch(/email: fd\.get\('email'\)/);
    expect(s).toMatch(/password: fd\.get\('password'\)/);
    expect(s).toMatch(/const name = fd\.get\('name'\);\s*\n\s+if \(name\) payload\.name = name;/);
  });

  it('CRITICAL signup password 12-char minimum + autocomplete=new-password pinned. The 12-char minimum matches server validation + W736 reset-password.', () => {
    const s = read(SIGNUP);
    expect(s).toMatch(/minlength="12"/);
    expect(s).toMatch(/autocomplete="new-password"/);
    expect(s).toMatch(/12\+ characters\. Use a passphrase\./);
  });

  it('CRITICAL signup safely persists ds_signup_email + ds_debug_verify_token before continuing. Drift to dropping would break the W735 verify-email page email-prefill + W735 debug-token back-compat path.', () => {
    const s = read(SIGNUP);

    expect(s).toMatch(
      /function persistSignupState\(email, debugToken\) \{\s*if \(!writeSignupState\('ds_signup_email', email\)\) return false;\s*if \(typeof debugToken === 'string' && debugToken\.length > 0\) \{\s*return writeSignupState\('ds_debug_verify_token', debugToken\);\s*\}\s*return removeSignupState\('ds_debug_verify_token'\);/,
    );
    expect(s).toMatch(/if \(!persistSignupState\(payload\.email, body\.debug_token\)\) \{/);
    expect(s.replace('persistSignupState(payload.email, body.debug_token)', 'true')).not.toMatch(
      /persistSignupState\(payload\.email, body\.debug_token\)/,
    );
  });

  it('CRITICAL signup V-267 ?next= deep-link round-trip pinned. The canonical `/verify-email/?next=` redirect threads the deep-link through verify-email (next = sanitized via safeNextPath). Matches W735 verify-email ?next= consumption.', () => {
    const s = read(SIGNUP);

    expect(s).toMatch(
      /V-267 — pass through the \?next= deep link so flows that\s*\n\s+\/\/ brought the user to signup \(e\.g\. GUI activation at\s*\n\s+\/\/ \/cli\/authorize\) can resume after verify-email completes/,
    );
    expect(s).toMatch(
      /return nextRaw \? '\/verify-email\/\?next=' \+ encodeURIComponent\(next\) : '\/verify-email\/'/,
    );
    // Open-redirect guard — ?next= sanitized via inline safeNextPath() before forward.
    expect(s).toMatch(/function safeNextPath\(next, origin\) \{/);
    expect(s).toMatch(/const next = safeNextPath\(nextRaw, window\.location\.origin\)/);
  });

  it('CRITICAL signup V-269 login-link ?next= preservation pinned. The "preserve ?next= when bouncing to /login" pattern keeps GUI-activation round-trips alive when a user clicks "Sign in" instead of completing signup — now sanitized through safeNextPath() to close the open-redirect.', () => {
    const s = read(SIGNUP);
    expect(s).toMatch(/V-269 — preserve \?next= when bouncing the user to \/login/);
    expect(s).toMatch(
      /'\/login\/\?next=' \+ encodeURIComponent\(safeNextPath\(nextRaw, window\.location\.origin\)\)/,
    );
  });

  it('CRITICAL signup verify-page redirect is `/verify-email` (NOT `/auth/verify-email`). Matches V-079.C canonical path + W735 + W734 .env.example fix. Drift would re-introduce the 2026-05-12 customer-incident class of bug.', () => {
    const s = read(SIGNUP);

    expect(s).toMatch(/'\/verify-email\/\?next='/);
    expect(s).toMatch(/: '\/verify-email\/'/);

    // NO legacy /auth/verify-email path.
    expect(s).not.toMatch(/'\/auth\/verify-email'/);
  });

  // --- login.astro ------------------------------------------------

  it('CRITICAL login V-269 anchor + V-184a + V-267 framing pinned. The page pairs the V-079 backend route + V-267 deep-link round-trip + V-184a signup-flow cross-reference.', () => {
    const l = read(LOGIN);

    expect(l).toMatch(/V-269 — Sign-in page for returning customers\. Pairs with the V-184a/);
    expect(l).toMatch(/signup flow \+ the V-267 cli\/authorize deep-link round-trip/);
  });

  it("CRITICAL login POST /v1/auth/login contract pinned — body {email, password}. Drift to dropping credentials:'include' from this specific route is acceptable (no cookie round-trip on login; localStorage drives session); the W735+W736 pages DO use credentials:'include' because their flows DO need the cookie.", () => {
    const l = read(LOGIN);

    expect(l).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/auth\/login'/);
    expect(l).toMatch(/email: fd\.get\('email'\)/);
    expect(l).toMatch(/password: fd\.get\('password'\)/);
  });

  it('CRITICAL login autocomplete="current-password" pinned (NOT new-password). Drift to new-password would let password managers suggest a NEW password on every login.', () => {
    const l = read(LOGIN);
    expect(l).toMatch(/autocomplete="current-password"/);
    expect(l).toMatch(/id="login-password"/);
  });

  it('CRITICAL login V-353d/W528 MFA-required branch handler pinned. The login response is a discriminated union — `{session}` OR `{mfa_required: true, challenge_token, ...}`. W528: the second variant opens the MFA challenge form (startMfaChallenge) — the pre-W528 dead-end banner locked MFA-enrolled customers out of the dashboard.', () => {
    const l = read(LOGIN);

    expect(l).toMatch(/V-353d — \/v1\/auth\/login returns a discriminated union/);
    expect(l).toMatch(
      /either `\{ session: \.\.\. \}` \(no MFA enrolled\) or\s*\n\s+\/\/ `\{ mfa_required: true, challenge_token, \.\.\. \}`/,
    );
    expect(l).toMatch(/if \(body && body\.mfa_required === true\) \{/);
    expect(l).toMatch(/startMfaChallenge\(body\.challenge_token\);/);
  });

  it('CRITICAL login W528 MFA challenge step pinned: hidden form with one-time-code input + recovery-code toggle, POST /v1/auth/mfa/challenge, shared completeSession path. Drift to dropping would re-lock MFA-enrolled users out of the web dashboard.', () => {
    const l = read(LOGIN);
    expect(l).toMatch(/data-form="mfa"/);
    expect(l).toMatch(/autocomplete="one-time-code"/);
    expect(l).toMatch(/data-mfa-toggle-recovery/);
    expect(l).toMatch(/\/v1\/auth\/mfa\/challenge/);
    expect(l).toMatch(/function completeSession\(body\)/);
  });

  it('CRITICAL login V-269 signup-link ?next= preservation pinned (mirrors signup→login). Drift would break the cross-link deep-link continuity.', () => {
    const l = read(LOGIN);

    expect(l).toMatch(/V-269 — preserve \?next= when bouncing the user to \/signup/);
    expect(l).toMatch(
      /signupLink\.setAttribute\('href', '\/signup\/\?next=' \+ encodeURIComponent\(next\)\)/,
    );
  });

  it('CRITICAL login forgot-password link pinned. The /forgot-password page is the entry to the W736 reset-password flow.', () => {
    const l = read(LOGIN);
    expect(l).toMatch(/<a\s+href="\/forgot-password\/"/);
    expect(l).toMatch(/Forgot your password\?/);
  });

  it("CRITICAL login on-success — hardened `persistWebSession(body)` + redirect to `next ? next : '/'`. Matches W735+W736 ds_web_session_token key convention.", () => {
    const l = read(LOGIN);

    expect(l).toMatch(
      /function persistWebSession\(body\) \{[\s\S]*?localStorage\.removeItem\(key\);[\s\S]*?localStorage\.setItem\('ds_web_session_token', session\.token\);[\s\S]*?localStorage\.getItem\('ds_web_session_token'\) !== session\.token[\s\S]*?function completeSession/,
    );
    expect(l).toMatch(/function completeSession\(body\) \{\s*persistWebSession\(body\);/);
    expect(l.replace('persistWebSession(body);', '')).not.toMatch(
      /function completeSession\(body\) \{\s*persistWebSession\(body\);/,
    );
    expect(l).toMatch(/window\.location\.href = next \? next : '\/'/);
  });

  it('CRITICAL dynamic dashboard auth links use canonical trailing-slash routes without changing encoded next targets', () => {
    const slashlessAuthRoute = /['"]\/(?:login|signup|verify-email)\?next=/;
    for (const path of AUTH_ROUTE_PAGES) {
      expect(read(path), `${path} slashless dynamic auth route`).not.toMatch(slashlessAuthRoute);
    }

    const mutated = read(SIGNUP).replace('/login/?next=', '/login?next=');
    expect(mutated).toMatch(slashlessAuthRoute);
  });

  // --- Shared invariants -------------------------------------------

  it('CRITICAL both pages use resolveApiBaseUrl() multi-env helper. Drift to hardcoding would break local + staging.', () => {
    for (const path of [SIGNUP, LOGIN]) {
      const c = read(path);
      expect(c, `${path} resolveApiBaseUrl`).toMatch(
        /import \{ resolveApiBaseUrl \} from '\.\.\/lib\/api-base-url'/,
      );
      expect(c, `${path} define:vars`).toMatch(/define:vars=\{\{ apiBaseUrl \}\}/);
    }
  });

  it('CRITICAL both pages use DashboardLayout + withSidebar={false} (auth pages have NO sidebar). Same pattern as W735+W736.', () => {
    for (const path of [SIGNUP, LOGIN]) {
      const c = read(path);
      expect(c, `${path} DashboardLayout`).toMatch(/import DashboardLayout from/);
      expect(c, `${path} withSidebar={false}`).toMatch(/withSidebar=\{false\}/);
    }
  });

  it('CRITICAL both pages have data-banner role="status" for accessible error messaging.', () => {
    for (const path of [SIGNUP, LOGIN]) {
      const c = read(path);
      expect(c, `${path} data-banner role=status`).toMatch(
        /data-banner class="banner-warn mb-5 hidden" role="status"/,
      );
    }
  });

  it('CRITICAL both pages have email input with type="email" + autocomplete="email" + required. Drift to dropping autocomplete would let password managers fail to populate.', () => {
    for (const path of [SIGNUP, LOGIN]) {
      const c = read(path);
      expect(c, `${path} type="email"`).toMatch(/type="email"/);
      expect(c, `${path} autocomplete="email"`).toMatch(/autocomplete="email"/);
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/dashboard-signup-login-pages-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
