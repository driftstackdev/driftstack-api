// Drift guard for apps/customer-dashboard/src/pages/auth/oauth-client/
// callback.astro. Pins the V-667.C OAuth-client callback landing page
// + outcome routing (signed-in/created → session or MFA; collision-pending →
// in-page "Check your inbox" card; existing-link-revoked → in-page banner,
// no navigation) + the cookie-free v2 redeem. The v1 PKCE-cookie
// exchange was retired 2026-09-14; drift back to a credentialed request
// would re-expose cross-site sign-ins to the Safari ITP cookie drop.

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

  it('V-667.C module-level OAuth callback framing and cookie-free v2 contract stay documented; the outcome list names what the code does (in-page card / banner), never a page that does not exist', () => {
    expect(body).toMatch(/\/\/ V-667\.C — OAuth-client callback landing page\./);
    expect(body).toMatch(
      /\/\/\s+signed-in-existing-link \/ created-new-account → session or mfa_required\s*\/\/\s+mfa_required → verify TOTP\/recovery, then continue to redirect_to\s*\/\/\s+collision-pending-verification → in-page "Check your inbox" card\s*\/\/\s+existing-link-revoked → in-page banner \(password or re-link via \/login\)/,
    );
    // src/pages/auth/oauth-client/ holds callback.astro and confirm-merge.astro only.
    expect(body).not.toMatch(/check-email/);
    expect(body).toMatch(
      /\/\/ Cookie-free v2 \(2026-09-11; the v1 cookie path was retired 2026-09-14\s*\/\/ after its 24-hour compatibility window\)\./,
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

  it("Check-your-inbox copy pinned: 'We sent a confirmation link to the email on your existing account to verify both accounts belong to you. Click the link in that email to finish linking your <span data-merge-provider…>Google or GitHub</span> account. The link expires in <span data-merge-window…>60 minutes</span>.' — pinned so the 60-minute-default expiry text + 'finish linking your Google or GitHub' copy contract stays documented (the span default is replaced by the redeem answer's provider name). (The previous data-merge-email span was never populated → blank gap; reworded to neutral 'the email on your existing account'.)", () => {
    expect(body).toMatch(
      /We sent a confirmation link to the email on your existing account\s*to verify both accounts belong to you\. Click the link in that email to finish linking your\s*<span data-merge-provider class="font-mono">Google or GitHub<\/span> account\./,
    );
    expect(body).toMatch(
      /The link expires in <span data-merge-window class="font-mono">60 minutes<\/span>\./,
    );
  });

  it("fetch POST /v1/auth/oauth-client/redeem + {code, flow_secret} body + NO credentials + 'No credentials' comment pinned; the retired v1 GET /v1/auth/oauth-client/callback + credentials:'include' + 'PKCE cookie round-trip' are gone, and a retired-v1 query arrival is scrubbed then refused without a request. Drift to a credentialed redeem would put the XHR back inside every third-party-cookie policy", () => {
    expect(body).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/auth\/oauth-client\/redeem', \{\s*method: 'POST',\s*headers: \{ 'content-type': 'application\/json' \},\s*\/\/ No credentials: v2 has no cookie to carry, and omitting them keeps\s*\/\/ this XHR outside every third-party-cookie policy by construction\.\s*body: JSON\.stringify\(\{ code: handoffCode, flow_secret: flowRecord\.secret \}\),\s*signal: redeemController\.signal,\s*\}\)/,
    );
    expect(body).not.toMatch(/credentials: 'include'/);
    expect(body).not.toMatch(/'\/v1\/auth\/oauth-client\/callback'/);
    expect(body).not.toMatch(/PKCE cookie round-trip/);
    expect(body).toMatch(
      /const qs = window\.location\.search;\s*if \(qs && qs\.length > 0\) \{\s*window\.history\.replaceState\(window\.history\.state, '', window\.location\.pathname\);\s*showBanner\('This link cannot complete a sign-in\. Return to sign-in and try again\.'\);\s*return;\s*\}/,
    );
    // No server path produces a query arrival, so the page cannot attribute it
    // to "an outdated sign-in page" and must not claim to.
    expect(body).not.toMatch(/outdated sign-in page/);
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
      /showBanner\(\s*'This Google or GitHub link was removed earlier\. Sign in with your password, or use the Google or GitHub button on the sign-in page to link it again\.',\s*\);/,
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
    expect(body).toContain("Don't enter it again — start a fresh sign-in.");
  });

  it("Provider-from-redeem-answer pinned: body.provider === 'github' → 'GitHub', anything else → 'Google' for the data-merge-provider text; the retired query-string heuristic (qs.indexOf('provider=github')) is gone — the fragment hand-off carries no query string to read it from", () => {
    expect(body).toMatch(
      /if \(mergeProvider\) \{\s*mergeProvider\.textContent = body\.provider === 'github' \? 'GitHub' : 'Google';\s*\}/,
    );
    expect(body).not.toMatch(/qs\.indexOf\('provider=github'\)/);
  });

  it('Dynamic-minutes-from-expires_at framing pinned: Math.max(1, Math.round((new Date(body.expires_at).getTime() - Date.now()) / 60000)) + mergeWindow.textContent = minutes + " minutes". Drift to dropping the Math.max(1, …) floor would let "0 minutes" surface for sub-30s windows', () => {
    expect(body).toMatch(
      /const minutes = Math\.max\(\s*1,\s*Math\.round\(\(new Date\(body\.expires_at\)\.getTime\(\) - Date\.now\(\)\) \/ 60000\),\s*\);\s*if \(mergeWindow\) mergeWindow\.textContent = minutes \+ ' minutes';/,
    );
  });
});
