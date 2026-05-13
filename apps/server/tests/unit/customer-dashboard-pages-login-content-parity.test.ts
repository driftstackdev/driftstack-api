// W493.A — drift guard for apps/customer-dashboard/src/pages/login.astro.
// V-269 sign-in page. Drift here either drops the V-267 next=
// round-trip preservation (CLI deep-links would lose continuation
// after sign-in) or breaks the V-353d MFA-required branch handling
// (MFA-enrolled users would silently fail to sign in with no
// indication of what went wrong).
//
//   • V-269 framing pinned + ?next= round-trip.
//   • V-267 + V-269 cross-link preservation (next= → /signup
//     fallback link).
//   • V-353d MFA discriminated union: {session} vs {mfa_required}.
//   • POST /v1/auth/login + ds_web_session_token storage.
//   • autocomplete='current-password' (NOT new-password — distinct
//     from signup/reset).
//   • Forgot-password cross-link + signup fallback link.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/login.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W493.A apps/customer-dashboard/src/pages/login.astro content parity', () => {
  const body = read(LIB);

  it("V-269 framing pinned: 'Sign-in page for returning customers. Pairs with the V-184a signup flow + the V-267 cli/authorize deep-link round-trip.' + 'POSTs to /v1/auth/login (V-079) which returns a web session token. The token lands in localStorage under ds_web_session_token — identical key to signup → verify-email so cross-page reads just work.' — pinned so the cross-page token-key contract + the V-269/V-267/V-184a/V-079 lineage stays documented", () => {
    expect(body).toMatch(
      /\/\/ V-269 — Sign-in page for returning customers\. Pairs with the V-184a\s*\n?\s*\/\/ signup flow \+ the V-267 cli\/authorize deep-link round-trip\./,
    );
    expect(body).toMatch(
      /\/\/ POSTs to \/v1\/auth\/login \(V-079\) which returns a web session token\.\s*\n?\s*\/\/ The token lands in localStorage under `ds_web_session_token` —\s*\n?\s*\/\/ identical key to signup → verify-email so cross-page reads\s*\n?\s*\/\/ "just work"/,
    );
  });

  it("?next= round-trip framing pinned: 'Honors ?next= for deep-link round-trip from /cli/authorize and any future deep-link entry points; falls back to / for the typical I came here from the marketing site path.' — pinned so the post-login landing fallback ('/') stays the canonical home for marketing-site → login round-trips", () => {
    expect(body).toMatch(
      /\/\/ Honors `\?next=` for deep-link round-trip from \/cli\/authorize and\s*\n?\s*\/\/ any future deep-link entry points; falls back to "\/" for the typical\s*\n?\s*\/\/ "I came here from the marketing site" path\./,
    );
  });

  it("V-269 next= preservation on /signup fallback link: 'preserve ?next= when bouncing the user to /signup so a returning user who clicks Create one doesn't lose their deep-link target.' — pinned so the cross-flow continuity stays explicit + the framing comment doesn't get reduced to a generic 'preserve next='", () => {
    expect(body).toMatch(
      /\/\/ V-269 — preserve \?next= when bouncing the user to \/signup so a\s*\n?\s*\/\/ returning user who clicks "Create one" doesn't lose their deep-\s*\n?\s*\/\/ link target\./,
    );
    expect(body).toMatch(
      /if \(next && signupLink\) \{\s*\n?\s*signupLink\.setAttribute\('href', '\/signup\?next=' \+ encodeURIComponent\(next\)\);\s*\n?\s*\}/,
    );
  });

  it("V-353d MFA-required branch framing pinned: '/v1/auth/login returns a discriminated union: either { session: ... } (no MFA enrolled) or { mfa_required: true, challenge_token, ... }. Until the MFA challenge UI lands, surface the second branch as a clear banner so MFA-enrolled users aren't silently redirected to / with no session set (which would bounce straight back to /login).' — pinned so the temporary 'MFA UI not yet built' banner doesn't disappear before the actual UI lands (drift to dropping would silently regress MFA-enrolled users)", () => {
    expect(body).toMatch(
      /\/\/ V-353d — \/v1\/auth\/login returns a discriminated union:\s*\n?\s*\/\/ either `\{ session: \.\.\. \}` \(no MFA enrolled\) or\s*\n?\s*\/\/ `\{ mfa_required: true, challenge_token, \.\.\. \}`\. Until\s*\n?\s*\/\/ the MFA challenge UI lands, surface the second branch\s*\n?\s*\/\/ as a clear banner so MFA-enrolled users aren't silently\s*\n?\s*\/\/ redirected to \/ with no session set \(which would bounce\s*\n?\s*\/\/ straight back to \/login\)\./,
    );
    expect(body).toMatch(
      /if \(body && body\.mfa_required === true\) \{\s*\n?\s*showBanner\(\s*\n?\s*'This account has MFA enabled\. The web-based MFA challenge ' \+\s*\n?\s*'UI is not available yet — please sign in via the API or ' \+\s*\n?\s*'temporarily disable MFA from the CLI \(see \/docs\/api-keys\)\.',\s*\n?\s*\);\s*\n?\s*return;\s*\n?\s*\}/,
    );
  });

  it("autocomplete='current-password' on password input (NOT new-password — distinct from signup/reset) — pinned so browsers + password managers correctly auto-fill from the customer's vault on sign-in (drift to new-password would prompt the customer to CREATE a new password instead of using the existing one)", () => {
    expect(body).toMatch(
      /<input\s*\n?\s*id="login-password"\s*\n?\s*name="password"\s*\n?\s*type="password"\s*\n?\s*required\s*\n?\s*autocomplete="current-password"/,
    );
  });

  it('POST /v1/auth/login contract: payload {email, password} (no name, no MFA challenge fields — the MFA path comes back in the discriminated-union response, not in the request) + content-type:application/json — pinned so the request shape stays minimal (drift to adding mfa_token in request would break the V-353d flow that decides server-side whether MFA is needed)', () => {
    expect(body).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/auth\/login', \{\s*\n?\s*method: 'POST',\s*\n?\s*headers: \{ 'content-type': 'application\/json' \},\s*\n?\s*body: JSON\.stringify\(payload\),\s*\n?\s*\}\)/,
    );
  });

  it("Success path: session.token → localStorage.setItem('ds_web_session_token', session.token) + window.location.href = next ? next : '/' — pinned so the post-login redirect honors next= but falls back to dashboard root (drift to forcing /welcome would break returning-user flow + drift to dropping localStorage write would not persist the session)", () => {
    expect(body).toMatch(
      /const session = body\.session \|\| \{\};\s*\n?\s*if \(session\.token\) \{\s*\n?\s*localStorage\.setItem\('ds_web_session_token', session\.token\);\s*\n?\s*\}\s*\n?\s*\/\/ Honor \?next= round-trip; fall back to \/ for the typical\s*\n?\s*\/\/ post-login landing\.\s*\n?\s*window\.location\.href = next \? next : '\/';/,
    );
  });

  it("problem+json error surfacing on login: r.json().then((b) => Promise.reject(new Error(b.detail || 'HTTP N'))) — pinned so server-returned auth-specific error messages (like 'Email or password is incorrect' or rate-limit detail) reach the customer banner (drift to bare 'HTTP 401' would hide whether it was a bad password vs a rate-limit hit)", () => {
    expect(body).toMatch(
      /r\.ok\s*\n?\s*\? r\.json\(\)\s*\n?\s*: r\s*\n?\s*\.json\(\)\s*\n?\s*\.then\(\(b\) =>\s*\n?\s*Promise\.reject\(new Error\(b\.detail \|\| 'HTTP ' \+ r\.status\.toString\(\)\)\),\s*\n?\s*\),/,
    );
  });

  it("Forgot-password + Create-one fallback links: 'Forgot your password?' → /forgot-password + 'No account yet? Create one' → /signup (with data-signup-link for the V-269 next= rewrite hook) — pinned so the dual escape hatches (recover password / sign up instead) stay visible on every sign-in attempt", () => {
    expect(body).toMatch(
      /<a\s*\n?\s*href="\/forgot-password"\s*\n?\s*class="text-glow-red[^"]*"\s*\n?\s*>\s*Forgot your password\?\s*<\/a\s*\n?\s*>/,
    );
    expect(body).toMatch(
      /No account yet\? <a\s*\n?\s*data-signup-link\s*\n?\s*href="\/signup"\s*\n?\s*class="text-glow-red[^"]*"\s*\n?\s*>\s*Create one\s*<\/a/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
