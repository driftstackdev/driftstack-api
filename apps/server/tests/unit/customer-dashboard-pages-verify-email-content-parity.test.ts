// W493.C — drift guard for apps/customer-dashboard/src/pages/verify-email.astro.
// V-184a + V-184a.B + #187 verify-email page. Drift here either
// drops the auto-submit-from-URL flow (every customer would have
// to manually paste a token they already clicked through) or
// breaks the 60s resend cooldown (would let customers burn through
// the per-IP 3/min server cap with double-clicks).
//
//   • V-184a + V-184a.B framing pinned (auto-submit when ?token=
//     is in URL).
//   • #187 resend-verification framing pinned (60s client-side
//     cooldown to avoid burning the per-IP 3/min server cap).
//   • Pre-fill priority: linkToken (?token= URL param) wins over
//     debugToken (sessionStorage from signup).
//   • V-267 next= round-trip through verify-email → next || /welcome.
//   • POST /v1/auth/verify-email + POST /v1/auth/resend-verification
//     contracts.
//   • Cleanup: sessionStorage.removeItem ds_signup_email +
//     ds_debug_verify_token after success.
//   • autocomplete='one-time-code' on token input.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/verify-email.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W493.C apps/customer-dashboard/src/pages/verify-email.astro content parity', () => {
  const body = read(LIB);

  it("V-184a framing pinned: 'onboarding step 2. Consume verification token, store resulting web-session token in localStorage, redirect to /welcome.' — pinned so the onboarding step + the destination route (/welcome) stay explicit", () => {
    expect(body).toMatch(
      /\/\/ V-184a — onboarding step 2\. Consume verification token, store\s*\n?\s*\/\/ resulting web-session token in localStorage, redirect to \/welcome\./,
    );
  });

  it("V-184a.B auto-submit framing pinned: 'when the user clicks the link in the verify email, the token is already in ?token=…. Pre-fill the form + auto-submit so they don't have to paste it. The form stays visible as a fallback for the rare case where a recipient mail client mangles the link or the page is hit without the query param.' — pinned so the auto-submit UX + the manual-paste fallback both stay documented (drift to dropping the fallback would break customers with overzealous email clients that strip query params)", () => {
    expect(body).toMatch(
      /\/\/ V-184a\.B — when the user clicks the link in the verify\s*\n?\s*\/\/ email, the token is already in `\?token=…`\. Pre-fill the\s*\n?\s*\/\/ form \+ auto-submit so they don't have to paste it\. The\s*\n?\s*\/\/ form stays visible as a fallback for the rare case where\s*\n?\s*\/\/ a recipient mail client mangles the link or the page is\s*\n?\s*\/\/ hit without the query param\./,
    );
  });

  it('Pre-fill priority: linkToken ?? debugToken — URL ?token= wins over sessionStorage ds_debug_verify_token — pinned so the email-link path takes precedence over the dev-mode paste (drift to debugToken winning would break the live email flow when AUTH_EXPOSE_DEBUG_TOKEN happens to be set)', () => {
    expect(body).toMatch(
      /\/\/ Pre-fill debug_token from signup response in test\/dev mode\s*\n?\s*\/\/ \(kept for back-compat — the URL token wins when both\s*\n?\s*\/\/ are present\)\.\s*\n?\s*const debugToken = sessionStorage\.getItem\('ds_debug_verify_token'\);\s*\n?\s*const prefill = linkToken \?\? debugToken;/,
    );
  });

  it("Auto-verifying intro swap: linkToken present → intro textContent changes to 'Verifying your email — one moment…' (so customer sees something is happening before the auto-submit fires) — pinned so the auto-flow customer isn't confused by static form copy while their submission is mid-flight", () => {
    expect(body).toMatch(
      /if \(linkToken\) \{\s*\n?\s*const intro = root\.querySelector\('\[data-field="intro"\]'\);\s*\n?\s*if \(intro\) intro\.textContent = 'Verifying your email — one moment…';\s*\n?\s*\}/,
    );
  });

  it("Auto-submit trigger: linkToken && linkToken.length > 0 → submitToken(linkToken) at module-init time — pinned so the URL-token path fires automatically (no waiting for form submit) + the length-check guards against ?token= present-but-empty (which the form's submitToken would reject anyway, but cleaner to gate it here)", () => {
    expect(body).toMatch(
      /\/\/ V-184a\.B — auto-submit when the link in the email carried\s*\n?\s*\/\/ the token\. The form stays mounted so failures show the\s*\n?\s*\/\/ banner \+ the user can correct or paste manually\.\s*\n?\s*if \(linkToken && linkToken\.length > 0\) \{\s*\n?\s*submitToken\(linkToken\);\s*\n?\s*\}/,
    );
  });

  it("POST /v1/auth/verify-email contract: body:{token} + credentials:'include' — pinned so the verify endpoint gets just the token (server returns {session, debug_token?} discriminated union) + the credentials-include enables cookie-set on the dual-cookie session pattern", () => {
    expect(body).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/auth\/verify-email', \{\s*\n?\s*method: 'POST',\s*\n?\s*headers: \{ 'content-type': 'application\/json' \},\s*\n?\s*body: JSON\.stringify\(\{ token \}\),\s*\n?\s*credentials: 'include',\s*\n?\s*\}\)/,
    );
  });

  it("Post-verify cleanup: sessionStorage.removeItem ds_signup_email + ds_debug_verify_token — pinned so the signup-stage state doesn't bleed into subsequent flows (drift to leaving them would surface stale 'Code sent to old@email' on a returning user who later does a separate signup attempt in the same browser)", () => {
    expect(body).toMatch(
      /\/\/ Cleanup signup-stage state\.\s*\n?\s*sessionStorage\.removeItem\('ds_signup_email'\);\s*\n?\s*sessionStorage\.removeItem\('ds_debug_verify_token'\);/,
    );
  });

  it("V-267 next= round-trip framing pinned: 'honor ?next= round-trip from /cli/authorize and any other deep-link entry. Falls back to /welcome for the first-time onboarding flow.' + window.location.href = next ? next : '/welcome' — pinned so the deep-link continuation works through the entire signup→verify→welcome chain (drift to forcing /welcome would orphan deep-linked customers)", () => {
    expect(body).toMatch(
      /\/\/ V-267 — honor \?next= round-trip from \/cli\/authorize and\s*\n?\s*\/\/ any other deep-link entry\. Falls back to \/welcome for the\s*\n?\s*\/\/ first-time onboarding flow\./,
    );
    expect(body).toMatch(/window\.location\.href = next \? next : '\/welcome';/);
  });

  it("#187 resend framing pinned: 'self-service resend of the signup-verification email. The signup flow stashes the user's email in sessionStorage under ds_signup_email; if it's absent we prompt for it before posting. Server is shape-stable, so the success message is identical regardless of whether the email matched.' — pinned so the anti-enumeration framing (shape-stable response) survives + the sessionStorage-or-prompt fallback for customers who lost their session", () => {
    expect(body).toMatch(
      /\/\/ #187 — self-service resend of the signup-verification email\.\s*\n?\s*\/\/ The signup flow stashes the user's email in sessionStorage\s*\n?\s*\/\/ under `ds_signup_email`; if it's absent we prompt for it\s*\n?\s*\/\/ before posting\. Server is shape-stable, so the success message\s*\n?\s*\/\/ is identical regardless of whether the email matched\./,
    );
  });

  it("60s resend cooldown framing pinned: 'Re-enable after 60s so accidental double-clicks don't burn through the per-IP 3/min cap on the server side.' + setTimeout 60_000 — pinned so the client-side cooldown matches the server's per-IP rate-limit (drift to a shorter cooldown would trip the server 429; drift to no cooldown would burn the budget on a single mis-click)", () => {
    expect(body).toMatch(
      /\/\/ Re-enable after 60s so accidental double-clicks don't\s*\n?\s*\/\/ burn through the per-IP 3\/min cap on the server side\.\s*\n?\s*window\.setTimeout\(\(\) => \{\s*\n?\s*resendBtn\.disabled = false;\s*\n?\s*\}, 60_000\);/,
    );
  });

  it("autocomplete='one-time-code' on token input — pinned so mobile browsers (especially iOS Safari) suggest the verification code from the SMS/email iCloud Keychain integration (drift to autocomplete='off' would lose this UX on iPhone where customers verify on the same device that received the email)", () => {
    expect(body).toMatch(
      /<input\s*\n?\s*id="verify-token"\s*\n?\s*name="token"\s*\n?\s*type="text"\s*\n?\s*required\s*\n?\s*autocomplete="one-time-code"/,
    );
  });

  it("Resend missing-email prompt fallback: !resendEmail → window.prompt('Email address used at signup:') + trim + bail if empty — pinned so the resend works even when sessionStorage was cleared (drift to silently bailing would leave customers with no path to resend if they cleared cookies or moved devices)", () => {
    expect(body).toMatch(
      /let resendEmail = sessionStorage\.getItem\('ds_signup_email'\);\s*\n?\s*if \(!resendEmail\) \{\s*\n?\s*resendEmail = window\.prompt\('Email address used at signup:'\) \|\| '';\s*\n?\s*resendEmail = resendEmail\.trim\(\);\s*\n?\s*if \(!resendEmail\) return;\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
