// Drift guard for apps/customer-dashboard/src/pages/auth/oauth-client/
// callback.astro. Pins the V-667.C OAuth-client callback landing page
// + outcome routing (signed-in/created → session or MFA; collision-pending → show
// check-email card; existing-link-revoked → /login with "re-link or
// password" prompt). Drift to dropping credentials:'include' would
// break the PKCE verifier cookie round-trip.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(
  REPO_ROOT,
  'apps/customer-dashboard/src/pages/auth/oauth-client/callback.astro',
);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('customer-dashboard/pages/auth/oauth-client/callback content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('V-667.C module-level OAuth callback framing and PKCE-cookie contract stay documented', () => {
    expect(body).toMatch(/\/\/ V-667\.C — OAuth-client callback landing page\./);
    expect(body).toMatch(
      /\/\/\s+signed-in-existing-link \/ created-new-account → session or mfa_required\s*\/\/\s+mfa_required → verify TOTP\/recovery, then continue to redirect_to\s*\/\/\s+collision-pending-verification → \/auth\/oauth-client\/check-email\s*\/\/\s+existing-link-revoked → \/login with "re-link or password" prompt/,
    );
    expect(body).toMatch(
      /\/\/ PKCE verifier cookie round-trip is automatic via credentials:'include'\./,
    );
  });

  it('data-page="oauth-callback" + Signing-you-in-headline + check-inbox + data-attribute hooks pinned: data-banner + data-field="intro" + data-success-merge + data-merge-provider + data-merge-window. (data-merge-email removed — the span was never populated, so the sentence rendered with a blank gap; reworded to neutral copy.) Drift would break the page-script\'s root.querySelector hooks', () => {
    expect(body).toMatch(/data-page="oauth-callback"/);
    expect(body).toMatch(/Signing you in…/);
    expect(body).toMatch(/data-banner/);
    expect(body).toMatch(/data-field="intro"/);
    expect(body).toMatch(/data-success-merge/);
    expect(body).toMatch(/data-merge-provider/);
    expect(body).toMatch(/data-merge-window/);
  });

  it("Check-your-inbox copy pinned: 'We sent a confirmation link to the email on your existing account to verify both accounts belong to you. Click the link in that email to finish linking your <span data-merge-provider…>IDP</span> account. The link expires in <span data-merge-window…>60 minutes</span>.' — pinned so the 60-minute-default expiry text + 'finish linking your IDP' copy contract stays documented. (The previous data-merge-email span was never populated → blank gap; reworded to neutral 'the email on your existing account'.)", () => {
    expect(body).toMatch(
      /We sent a confirmation link to the email on your existing account\s*to verify both accounts belong to you\. Click the link in that email to finish linking your\s*<span data-merge-provider class="font-mono">IDP<\/span> account\./,
    );
    expect(body).toMatch(
      /The link expires in <span data-merge-window class="font-mono">60 minutes<\/span>\./,
    );
  });

  it("fetch GET /v1/auth/oauth-client/callback + credentials:'include' + 'PKCE cookie round-trip' comment pinned. Drift to credentials:'omit' would break the PKCE cookie carrying the verifier back to the server — token exchange would fail with 'PKCE verifier cookie missing or invalid'", () => {
    expect(body).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/auth\/oauth-client\/callback' \+ qs, \{\s*method: 'GET',\s*credentials: 'include', \/\/ PKCE cookie round-trip\s*signal: controller\.signal,\s*\}\)/,
    );
  });

  it('signed-in outcomes require either a session token or the first-class MFA handoff', () => {
    expect(body).toMatch(
      /if \(body\.outcome === 'signed-in-existing-link' \|\| body\.outcome === 'created-new-account'\) \{/,
    );
    // Open-redirect guard: the server-returned redirect_to is sanitized through
    // the inline safeNextPath() (same-origin, unit-tested in safe-next.test.ts)
    // before navigating — never the raw value. Mirrors login/signup/verify-email.
    expect(body).toMatch(/function safeNextPath\(next, origin\) \{/);
    expect(body).toMatch(/if \(u\.origin !== origin\) return '\/';/);
    expect(body).toMatch(/if \(body\.mfa_required === true\)/);
    expect(body).toMatch(/startMfaChallenge\(body\)/);
    expect(body).toMatch(/if \(!body\.session_token\)/);
    expect(body).toMatch(/completeSession\(/);
    expect(body).toMatch(/if \(body\.outcome === 'collision-pending-verification'\) \{/);
    expect(body).toMatch(/if \(body\.outcome === 'existing-link-revoked'\) \{/);
    expect(body).toMatch(
      /showBanner\(\s*'This identity-provider link was previously revoked\. Sign in with your password, or click the IDP button on the login page to re-link\.',\s*\);/,
    );
  });

  it('OAuth MFA supports TOTP and recovery-code exchange with single-flight uncertainty handling', () => {
    expect(body).toMatch(/data-form="oauth-mfa"/);
    expect(body).toMatch(/challenge_token: mfaChallengeToken/);
    expect(body).toMatch(/recovery_code: recoveryCode/);
    expect(body).toContain("'/v1/auth/mfa/challenge'");
    expect(body).toMatch(
      /if \(!mfaChallengeToken \|\| mfaInFlight \|\| mfaOutcomeUnknown\) return/,
    );
    expect(body).toContain('Do not submit this code again. Start a fresh sign-in.');
  });

  it("Provider-from-query-string heuristic pinned: qs.indexOf('provider=github') >= 0 → 'GitHub' / else 'Google' for the data-merge-provider text. Drift to a different heuristic would mismatch the provider-name in the check-inbox card on edge-case query strings", () => {
    expect(body).toMatch(
      /if \(mergeProvider && qs\.indexOf\('provider=github'\) >= 0\) \{\s*mergeProvider\.textContent = 'GitHub';\s*\} else if \(mergeProvider\) \{\s*mergeProvider\.textContent = 'Google';\s*\}/,
    );
  });

  it('Dynamic-minutes-from-expires_at framing pinned: Math.max(1, Math.round((new Date(body.expires_at).getTime() - Date.now()) / 60000)) + mergeWindow.textContent = minutes + " minutes". Drift to dropping the Math.max(1, …) floor would let "0 minutes" surface for sub-30s windows', () => {
    expect(body).toMatch(
      /const minutes = Math\.max\(\s*1,\s*Math\.round\(\(new Date\(body\.expires_at\)\.getTime\(\) - Date\.now\(\)\) \/ 60000\),\s*\);\s*if \(mergeWindow\) mergeWindow\.textContent = minutes \+ ' minutes';/,
    );
  });
});
