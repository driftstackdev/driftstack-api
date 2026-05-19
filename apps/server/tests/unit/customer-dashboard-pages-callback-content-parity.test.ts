// Drift guard for apps/customer-dashboard/src/pages/auth/oauth-client/
// callback.astro. Pins the V-667.C OAuth-client callback landing page
// + 3-outcome routing (signed-in/created → /; collision-pending → show
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

  it('V-667.C module-level framing pinned: \'OAuth-client callback landing page. The IDP redirects the user here with ?code=...&state=... after they approve consent. This page POSTs the same query params back to /v1/auth/oauth-client/callback (server-side; the GET endpoint surfaces outcome via JSON) and routes based on the outcome: signed-in-existing-link / created-new-account → / + collision-pending-verification → /auth/oauth-client/check-email + existing-link-revoked → /login with "re-link or password" prompt. PKCE verifier cookie round-trip is automatic via credentials:include.\' — pinned so the V-667.C anchor + 3-outcome routing + PKCE-cookie-credentials:include contract all stay documented', () => {
    expect(body).toMatch(/\/\/ V-667\.C — OAuth-client callback landing page\./);
    expect(body).toMatch(
      /\/\/\s+signed-in-existing-link \/ created-new-account → \/\s*\n?\s*\/\/\s+collision-pending-verification → \/auth\/oauth-client\/check-email\s*\n?\s*\/\/\s+existing-link-revoked → \/login with "re-link or password" prompt/,
    );
    expect(body).toMatch(
      /\/\/ PKCE verifier cookie round-trip is automatic via credentials:'include'\./,
    );
  });

  it('data-page="oauth-callback" + Signing-you-in-headline + check-inbox + 5-data-attribute pinned: data-banner + data-field="intro" + data-success-merge + data-merge-email + data-merge-provider + data-merge-window. Drift would break the page-script\'s root.querySelector hooks', () => {
    expect(body).toMatch(/data-page="oauth-callback"/);
    expect(body).toMatch(/Signing you in…/);
    expect(body).toMatch(/data-banner/);
    expect(body).toMatch(/data-field="intro"/);
    expect(body).toMatch(/data-success-merge/);
    expect(body).toMatch(/data-merge-email/);
    expect(body).toMatch(/data-merge-provider/);
    expect(body).toMatch(/data-merge-window/);
  });

  it("Check-your-inbox copy pinned: 'We sent a confirmation link to <span data-merge-email…> to verify both accounts belong to you. Click the link in that email to finish linking your <span data-merge-provider…>IDP</span> account. The link expires in <span data-merge-window…>60 minutes</span>.' — pinned so the 60-minute-default expiry text + 'finish linking your IDP' copy contract stays documented", () => {
    expect(body).toMatch(
      /We sent a confirmation link to <span data-merge-email class="font-mono text-glow-red-soft"><\/span>\s*\n?\s*to verify both accounts belong to you\. Click the link in that email to finish linking your\s*\n?\s*<span data-merge-provider class="font-mono">IDP<\/span> account\./,
    );
    expect(body).toMatch(
      /The link expires in <span data-merge-window class="font-mono">60 minutes<\/span>\./,
    );
  });

  it("fetch GET /v1/auth/oauth-client/callback + credentials:'include' + 'PKCE cookie round-trip' comment pinned. Drift to credentials:'omit' would break the PKCE cookie carrying the verifier back to the server — token exchange would fail with 'PKCE verifier cookie missing or invalid'", () => {
    expect(body).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/auth\/oauth-client\/callback' \+ qs, \{\s*\n?\s*method: 'GET',\s*\n?\s*credentials: 'include', \/\/ PKCE cookie round-trip\s*\n?\s*\}\)/,
    );
  });

  it("3-outcome branching pinned: signed-in-existing-link OR created-new-account → window.location.href = body.redirect_to || '/' + collision-pending-verification → render check-inbox card with provider+window + existing-link-revoked → showBanner('This identity-provider link was previously revoked. Sign in with your password, or click the IDP button on the login page to re-link.') — pinned so the 3-outcome routing + revoked-recovery-guidance contract all stay documented", () => {
    expect(body).toMatch(
      /if \(body\.outcome === 'signed-in-existing-link' \|\| body\.outcome === 'created-new-account'\) \{/,
    );
    expect(body).toMatch(/window\.location\.href = body\.redirect_to \|\| '\/';/);
    expect(body).toMatch(/if \(body\.outcome === 'collision-pending-verification'\) \{/);
    expect(body).toMatch(/if \(body\.outcome === 'existing-link-revoked'\) \{/);
    expect(body).toMatch(
      /showBanner\(\s*\n?\s*'This identity-provider link was previously revoked\. Sign in with your password, or click the IDP button on the login page to re-link\.',\s*\n?\s*\);/,
    );
  });

  it("Provider-from-query-string heuristic pinned: qs.indexOf('provider=github') >= 0 → 'GitHub' / else 'Google' for the data-merge-provider text. Drift to a different heuristic would mismatch the provider-name in the check-inbox card on edge-case query strings", () => {
    expect(body).toMatch(
      /if \(mergeProvider && qs\.indexOf\('provider=github'\) >= 0\) \{\s*\n?\s*mergeProvider\.textContent = 'GitHub';\s*\n?\s*\} else if \(mergeProvider\) \{\s*\n?\s*mergeProvider\.textContent = 'Google';\s*\n?\s*\}/,
    );
  });

  it('Dynamic-minutes-from-expires_at framing pinned: Math.max(1, Math.round((new Date(body.expires_at).getTime() - Date.now()) / 60000)) + mergeWindow.textContent = minutes + " minutes". Drift to dropping the Math.max(1, …) floor would let "0 minutes" surface for sub-30s windows', () => {
    expect(body).toMatch(
      /const minutes = Math\.max\(\s*\n?\s*1,\s*\n?\s*Math\.round\(\(new Date\(body\.expires_at\)\.getTime\(\) - Date\.now\(\)\) \/ 60000\),\s*\n?\s*\);\s*\n?\s*if \(mergeWindow\) mergeWindow\.textContent = minutes \+ ' minutes';/,
    );
  });
});
