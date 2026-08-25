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
      /\/\/ V-184a — onboarding step 2\. Consume verification token, store\s*\/\/ resulting web-session token in localStorage, redirect to \/welcome\./,
    );
  });

  it("Issue 3 wave 1085+ auto-submit framing: 'when the user clicks the link in the verify email, the token is already in ?token=…. Auto-submit immediately and HIDE the form (replace with a spinner). The form is unhidden as a manual fallback only when (a) auto-submit fails OR (b) the page is reached without a token in the URL' — Founder feedback: the prior implementation pre-filled the form but kept the code-input visible, which read as a 'type your code' UX even when the link click should be the primary flow.", () => {
    expect(body).toMatch(
      /Issue 3 wave 1085\+ — when the user clicks the link in the verify\s*\/\/ email, the token is already in `\?token=…`\. Auto-submit\s*\/\/ immediately and HIDE the form/,
    );
    expect(body).toMatch(/showFallback/);
  });

  it('Pre-fill priority: linkToken ?? debugToken — URL ?token= wins over sessionStorage ds_debug_verify_token (kept for dev-mode back-compat)', () => {
    expect(body).toMatch(
      /const debugToken = readSignupState\('ds_debug_verify_token'\);\s*const prefill = linkToken \?\? debugToken;/,
    );
    expect(body).toMatch(
      /function readSignupState\(key\) \{\s*try \{\s*return sessionStorage\.getItem\(key\);\s*\} catch \{\s*return null;/,
    );
  });

  it("Issue 3 wave 1085+ auto-verifying spinner: linkToken present → spinnerEl unhidden + intro textContent changes to 'Verifying your account…' + form stays hidden. (Replaces the prior 'Verifying your email — one moment…' intro-only swap; full visual surface is the spinner now.)", () => {
    expect(body).toMatch(/if \(spinnerEl\) spinnerEl\.hidden = false;/);
    expect(body).toMatch(/if \(introEl\) introEl\.textContent = 'Verifying your account…';/);
    expect(body).toMatch(/data-field="auto-verify-spinner"/);
  });

  it("Auto-submit trigger: linkToken && linkToken.length > 0 → submitToken(linkToken) at module-init time — pinned so the URL-token path fires automatically (no waiting for form submit) + the length-check guards against ?token= present-but-empty (which the form's submitToken would reject anyway, but cleaner to gate it here)", () => {
    expect(body).toMatch(
      /\/\/ V-184a\.B — auto-submit when the link in the email carried\s*\/\/ the token\. The form stays mounted so failures show the\s*\/\/ banner \+ the user can correct or paste manually\.\s*if \(linkToken && linkToken\.length > 0\) \{\s*submitToken\(linkToken\);\s*\}/,
    );
  });

  it('POST /v1/auth/verify-email contract: body:{token}, credentials, 15s timeout signal, fixed response mapper, and outcome-unknown recovery — pinned so cookie handoff remains correct without encouraging reuse of an ambiguously consumed one-time token', () => {
    expect(body).toMatch(/const VERIFY_REQUEST_TIMEOUT_MS = 15_000;/);
    expect(body).toMatch(
      /const controller = new AbortController\(\);\s*const timeoutId = setTimeout\(\(\) => controller\.abort\(\), VERIFY_REQUEST_TIMEOUT_MS\);/,
    );
    expect(body).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/auth\/verify-email', \{\s*method: 'POST',\s*headers: \{ 'content-type': 'application\/json' \},\s*body: JSON\.stringify\(\{ token \}\),\s*credentials: 'include',\s*signal: controller\.signal,\s*\}\)/,
    );
    expect(body).toMatch(/window\.driftstackResponseError\(r, b\)/);
    expect(body).toMatch(/if \(controller\.signal\.aborted\) \{\s*verifyOutcomeUnknown = true;/);
    expect(body).toMatch(/\.finally\(\(\) => \{\s*clearTimeout\(timeoutId\);/);
  });

  it("Post-verify cleanup: sessionStorage.removeItem ds_signup_email + ds_debug_verify_token — pinned so the signup-stage state doesn't bleed into subsequent flows (drift to leaving them would surface stale 'Code sent to old@email' on a returning user who later does a separate signup attempt in the same browser)", () => {
    expect(body).toMatch(
      /\/\/ Cleanup signup-stage state\.\s*removeSignupState\('ds_signup_email'\);\s*removeSignupState\('ds_debug_verify_token'\);/,
    );
    expect(body).toMatch(
      /function removeSignupState\(key\) \{\s*try \{\s*sessionStorage\.removeItem\(key\);\s*\} catch \{/,
    );
  });

  it("V-267 next= round-trip framing pinned: 'honor ?next= round-trip from /cli/authorize and any other deep-link entry. Falls back to /welcome for the first-time onboarding flow.' + window.location.href = rawNext ? next : '/welcome' (the sanitized same-origin value via safeNextPath, gated on raw presence) — pinned so the deep-link continuation works through the entire signup→verify→welcome chain without an open-redirect (drift to forcing /welcome would orphan deep-linked customers; drift to navigating the raw value would reopen the redirect)", () => {
    expect(body).toMatch(
      /\/\/ V-267 — honor \?next= round-trip from \/cli\/authorize and\s*\/\/ any other deep-link entry\. Falls back to \/welcome for the\s*\/\/ first-time onboarding flow\./,
    );
    // Open-redirect guard: ?next= is run through the inline safeNextPath()
    // (same-origin sanitizer, unit-tested in safe-next.test.ts) before nav,
    // gated on the RAW presence to keep the /welcome onboarding fallback.
    expect(body).toMatch(/function safeNextPath\(next, origin\) \{/);
    expect(body).toMatch(/const next = safeNextPath\(rawNext, window\.location\.origin\);/);
    expect(body).toMatch(/window\.location\.href = rawNext \? next : '\/welcome';/);
  });

  it("#187 resend framing pinned: 'self-service resend of the signup-verification email. The signup flow stashes the user's email in sessionStorage under ds_signup_email; if it's absent we prompt for it before posting. Server is shape-stable, so the success message is identical regardless of whether the email matched.' — pinned so the anti-enumeration framing (shape-stable response) survives + the sessionStorage-or-prompt fallback for customers who lost their session", () => {
    expect(body).toMatch(
      /\/\/ #187 — self-service resend of the signup-verification email\.\s*\/\/ The signup flow stashes the user's email in sessionStorage\s*\/\/ under `ds_signup_email`; if it's absent we prompt for it\s*\/\/ before posting\. Server is shape-stable, so the success message\s*\/\/ is identical regardless of whether the email matched\./,
    );
  });

  it("60s resend cooldown framing pinned: 'Re-enable after 60s so accidental double-clicks don't burn through the per-IP 3/min cap on the server side.' + setTimeout 60_000 — pinned so the client-side cooldown matches the server's per-IP rate-limit (drift to a shorter cooldown would trip the server 429; drift to no cooldown would burn the budget on a single mis-click)", () => {
    expect(body).toMatch(
      /\/\/ Re-enable after 60s so accidental double-clicks don't\s*\/\/ burn through the per-IP 3\/min cap on the server side\.\s*resendBtn\.setAttribute\('aria-busy', 'false'\);\s*window\.setTimeout\(\(\) => \{\s*resendInFlight = false;\s*resendBtn\.disabled = false;\s*\}, 60_000\);/,
    );
  });

  it("autocomplete='one-time-code' on token input — pinned so mobile browsers (especially iOS Safari) suggest the verification code from the SMS/email iCloud Keychain integration (drift to autocomplete='off' would lose this UX on iPhone where customers verify on the same device that received the email)", () => {
    expect(body).toMatch(
      /<input\s*id="verify-token"\s*name="token"\s*type="text"\s*required\s*autocomplete="one-time-code"/,
    );
  });

  it("Resend missing-email prompt fallback: !resendEmail → branded window.driftstackPrompt('Email address used at signup:') + trim + bail if empty — pinned so the resend works even when sessionStorage was cleared (drift to silently bailing would leave customers with no path to resend if they cleared cookies or moved devices)", () => {
    expect(body).toMatch(/let resendEmail = readSignupState\('ds_signup_email'\);/);
    expect(body).toMatch(/\(await window\.driftstackPrompt\('Email address used at signup:', \{/);
    expect(body).toMatch(
      /resendEmail = resendEmail\.trim\(\);\s*if \(!resendEmail\) \{\s*resendInFlight = false;\s*resendBtn\.disabled = false;\s*resendBtn\.setAttribute\('aria-busy', 'false'\);\s*return;\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
