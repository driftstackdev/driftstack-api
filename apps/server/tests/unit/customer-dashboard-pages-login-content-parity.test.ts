// W493.A — drift guard for apps/customer-dashboard/src/pages/login.astro.
// V-269 sign-in page. Drift here either drops the V-267 next=
// round-trip preservation (CLI deep-links would lose continuation
// after sign-in) or breaks the V-353d MFA-required branch handling
// (MFA-enrolled users would silently fail to sign in with no
// indication of what went wrong).
//
//   • V-269 framing pinned + ?next= round-trip.
//   • V-267 + V-269 cross-link preservation (next= → /signup/
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

  it("?next= round-trip framing pins same-origin deep links and the canonical '/' fallback", () => {
    expect(body).toMatch(
      /\/\/ Honors `\?next=` for deep-link round-trip from \/cli\/authorize and\s*\n?\s*\/\/ other same-origin deep-link entry points; falls back to "\/" for the typical\s*\n?\s*\/\/ "I came here from the marketing site" path\./,
    );
  });

  it('V-269 next= preservation on canonical /signup/ fallback link + open-redirect guard: ?next= is sanitized before every use', () => {
    expect(body).toMatch(
      /\/\/ V-269 — preserve \?next= when bouncing the user to \/signup so a\s*\n?\s*\/\/ returning user who clicks "Create one" doesn't lose their deep-\s*\n?\s*\/\/ link target\./,
    );
    // Open-redirect guard (inline copy of src/lib/safe-next.ts, unit-tested in
    // safe-next.test.ts). Without it, /login?next=https://evil.com bounces a
    // signed-in user off-site. Pin: the fn exists, the same-origin check is
    // present, and ?next= is sanitized via it before use.
    expect(body).toMatch(/function safeNextPath\(next, origin\) \{/);
    expect(body).toMatch(/if \(u\.origin !== origin\) return '\/';/);
    expect(body).toMatch(/const next = safeNextPath\(rawNext, window\.location\.origin\);/);
    expect(body).toMatch(
      /if \(rawNext && signupLink\) \{\s*\n?\s*signupLink\.setAttribute\('href', '\/signup\/\?next=' \+ encodeURIComponent\(next\)\);\s*\n?\s*\}/,
    );
  });

  it("V-353d/W528 MFA-required branch pinned: the login union's mfa_required variant opens the MFA challenge step (startMfaChallenge) — W528 replaced the temporary 'UI not available yet' dead-end banner that locked MFA-enrolled customers out of the dashboard", () => {
    expect(body).toMatch(
      /if \(body && body\.mfa_required === true\) \{\s*\n?\s*startMfaChallenge\(body\.challenge_token\);\s*\n?\s*return;\s*\n?\s*\}/,
    );
    expect(body).toMatch(/data-form="mfa"/);
    expect(body).toMatch(/\/v1\/auth\/mfa\/challenge/);
    expect(body).toMatch(/recovery_code: recovery/);
    expect(body).not.toMatch(/not available yet/);
  });

  it("autocomplete='current-password' on password input (NOT new-password — distinct from signup/reset) — pinned so browsers + password managers correctly auto-fill from the customer's vault on sign-in (drift to new-password would prompt the customer to CREATE a new password instead of using the existing one)", () => {
    expect(body).toMatch(
      /<input\s*\n?\s*id="login-password"\s*\n?\s*name="password"\s*\n?\s*type="password"\s*\n?\s*required\s*\n?\s*autocomplete="current-password"/,
    );
  });

  it('POST /v1/auth/login contract: payload {email, password} (no name, no MFA challenge fields — the MFA path comes back in the discriminated-union response, not in the request) + content-type:application/json — pinned so the request shape stays minimal (drift to adding mfa_token in request would break the V-353d flow that decides server-side whether MFA is needed)', () => {
    expect(body).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/auth\/login', \{\s*\n?\s*method: 'POST',\s*\n?\s*headers: \{ 'content-type': 'application\/json' \},\s*\n?\s*body: JSON\.stringify\(payload\),\s*\n?\s*signal: controller\.signal,\s*\n?\s*\}\)/,
    );
  });

  it("Success path (W528: shared completeSession for plain login + MFA challenge): the hardened persistence helper writes session.token, clears stale authority, then redirects to next ? next : '/'", () => {
    expect(body).toMatch(
      /function persistWebSession\(body\) \{[\s\S]*?const session = \(body && body\.session\) \|\| \{\};[\s\S]*?const staleKeys = \['ds_act_as_account', 'ds_is_team_user', 'ds_is_staff_user'\];[\s\S]*?localStorage\.removeItem\(key\);[\s\S]*?localStorage\.setItem\('ds_web_session_token', session\.token\);[\s\S]*?localStorage\.getItem\('ds_web_session_token'\) !== session\.token[\s\S]*?function completeSession/,
    );
    expect(body).toMatch(
      /function completeSession\(body\) \{\s*persistWebSession\(body\);[\s\S]*?window\.location\.href = next \? next : '\/';\s*\}/,
    );
    expect(body.replace('persistWebSession(body);', '')).not.toMatch(
      /function completeSession\(body\) \{\s*persistWebSession\(body\);/,
    );
    expect(
      body.replace("localStorage.setItem('ds_web_session_token', session.token);", ''),
    ).not.toMatch(
      /function persistWebSession\(body\) \{[\s\S]*?localStorage\.setItem\('ds_web_session_token', session\.token\);[\s\S]*?function completeSession/,
    );
  });

  it('maps problem+json through fixed copy while preserving stable type/status for the email-verification recovery branch', () => {
    expect(body).toMatch(
      /const err = window\.driftstackResponseError\(r, b\);\s*\n?\s*err\.problemType = b\.type;\s*\n?\s*err\.status = r\.status;\s*\n?\s*err\.email = payload\.email;\s*\n?\s*return Promise\.reject\(err\);/,
    );
    expect(body).not.toMatch(/new Error\(b\.detail/);
  });

  it("Forgot-password + Create-one fallback links: 'Forgot your password?' → /forgot-password + 'No account yet? Create one' → /signup (with data-signup-link for the V-269 next= rewrite hook) — pinned so the dual escape hatches (recover password / sign up instead) stay visible on every sign-in attempt", () => {
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(
      /<a href="\/forgot-password\/" class="text-tk-accent-text[^"]*"\s*\n?\s*>Forgot your password\?<\/a\s*\n?\s*>/,
    );
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(
      /No account yet\? <a\s*\n?\s*data-signup-link\s*\n?\s*href="\/signup\/"\s*\n?\s*class="text-tk-accent-text[^"]*"\s*\n?\s*>Create one<\/a/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
