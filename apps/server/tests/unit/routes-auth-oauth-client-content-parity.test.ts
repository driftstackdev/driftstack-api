// Drift guard for apps/server/src/routes/auth-oauth-client.ts. Pins
// the V-667.C OAuth-client (sign-in-with-Google/GitHub) route surface
// at structural + security-contract level (the file is large enough
// that pinning every handler body would over-couple to refactor;
// these tests pin the 4-route roster + 4-verdict semantics + PKCE
// cookie security contract + Path-A IDP-redirect-bounce pattern).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/auth-oauth-client.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('routes/auth-oauth-client content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("V-667.C module-level framing pinned: 'OAuth-client (sign-in-with-Google/GitHub) routes. POST /v1/auth/oauth-client/start — issue authorize URL + GET /v1/auth/oauth/:provider/callback — IDP redirects here; 302 to SPA callback + GET /v1/auth/oauth-client/callback — SPA-side exchange (existing flow) + POST /v1/auth/oauth-client/confirm-merge — Verdict 1 collision-flow completion.' — pinned so the V-667.C anchor + 4-route roster + per-route purpose + Verdict-1-collision-flow cross-reference contract all stay documented", () => {
    expect(body).toMatch(/\/\/ V-667\.C — OAuth-client \(sign-in-with-Google\/GitHub\) routes\./);
    expect(body).toMatch(
      /\/\/\s+POST \/v1\/auth\/oauth-client\/start\s+— issue authorize URL\s*\n?\s*\/\/\s+GET\s+\/v1\/auth\/oauth\/:provider\/callback\s+— IDP redirects here;\s*\n?\s*\/\/\s+302 to SPA callback/,
    );
    expect(body).toMatch(
      /\/\/\s+GET\s+\/v1\/auth\/oauth-client\/callback\s+— SPA-side exchange\s*\n?\s*\/\/\s+\(existing flow\)\s*\n?\s*\/\/\s+POST \/v1\/auth\/oauth-client\/confirm-merge\s+— Verdict 1 collision-\s*\n?\s*\/\/\s+flow completion/,
    );
  });

  it("Path A 2026-05-16 IDP-redirect-bounce framing pinned: 'the IDP redirect target moved from the SPA origin (${dashboardOrigin}/auth/oauth-client/callback) to the API per-provider path (${callbackUrlBase}/${provider}/callback) so the redirect_uri Google + GitHub Consoles registered actually matches what the IDP sees. The per-provider API route only does a 302 to the SPA, preserving the IDP's query string — so the existing SPA fetch flow against /v1/auth/oauth-client/callback is unchanged (PKCE cookie path scope still aligns).' — pinned so the Path-A-2026-05-16 verdict + IDP-Console-registers-API-URL + 302-bounce-preserves-PKCE-cookie-scope contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Path A \(2026-05-16\): the IDP redirect target moved from the SPA\s*\n?\s*\/\/ origin \(`\$\{dashboardOrigin\}\/auth\/oauth-client\/callback`\) to the API\s*\n?\s*\/\/ per-provider path \(`\$\{callbackUrlBase\}\/\$\{provider\}\/callback`\) so the\s*\n?\s*\/\/ `redirect_uri` Google \+ GitHub Consoles registered actually matches\s*\n?\s*\/\/ what the IDP sees\./,
    );
  });

  it('PKCE cookie security framing pinned: HTTP-only secure cookie keyed on the state nonce, HMAC-signed, restricted to /v1/auth/oauth-client, and five-minute lifetime', () => {
    expect(body).toMatch(
      /\/\/ PKCE verifier storage: HTTP-only secure cookie keyed on the state\s*\n?\s*\/\/ nonce\. The cookie is HMAC-signed via the same OAUTH_CLIENT_STATE_\s*\n?\s*\/\/ SIGNING_SECRET used to sign the state JWT; tampering is detected\./,
    );
    expect(body).toMatch(/const COOKIE_NAME_PREFIX = 'ds_oauth_pkce_';/);
    expect(body).toMatch(/const COOKIE_TTL_SECONDS = 300;/);
  });

  it('StartBodySchema 2-field + ConfirmMergeBodySchema 1-field shape pinned: provider enum google/github + redirect_to url + token string min 32 max 128. Drift to allowing other provider strings would let injection of arbitrary IDP names; drift to the 32-128 token range would either reject legitimate confirm tokens (too short) or accept arbitrary blobs (too long)', () => {
    expect(body).toMatch(
      /const StartBodySchema = z\.object\(\{\s*\n?\s*provider: z\.enum\(\['google', 'github'\]\),\s*\n?\s*redirect_to: z\.string\(\)\.url\(\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /const ConfirmMergeBodySchema = z\.object\(\{\s*\n?\s*token: z\.string\(\)\.min\(32\)\.max\(128\),\s*\n?\s*\}\);/,
    );
  });

  it('/start redirect_to open-redirect guard pinned: redirect_to must be on the dashboard origin (new URL(redirect_to).origin === new URL(dashboardOrigin).origin else BadRequestError). Drift to dropping this would let a forged /start mint an authorize URL whose redirect_to bounces a just-signed-in user off-site — the callback echoes redirect_to back and the SPA navigates it. Source-level defense paired with the SPA-side safeNextPath sanitizer.', () => {
    expect(body).toMatch(
      /if \(new URL\(parsed\.data\.redirect_to\)\.origin !== new URL\(deps\.dashboardOrigin\)\.origin\) \{\s*\n?\s*throw new BadRequestError\('redirect_to must be on the dashboard origin\.'\);\s*\n?\s*\}/,
    );
  });

  it("callbackUrlFor symmetry framing pinned: 'Derive the IDP-facing callback URL for a given provider. Both buildAuthorizeUrl (sent to IDP at authorize time) and exchangeCodeForTokens (sent to IDP at token-exchange time) MUST pass the same value — IDPs reject the token exchange if the redirect_uri differs from what they saw at authorize.' + `${base}/${provider}/callback` — pinned so the same-value-at-authorize-and-exchange contract stays documented (drift would break the IDP redirect_uri-match check + 100% of token exchanges)", () => {
    expect(body).toMatch(
      /\* Derive the IDP-facing callback URL for a given provider\. Both\s*\n?\s*\* `buildAuthorizeUrl` \(sent to IDP at authorize time\) and\s*\n?\s*\* `exchangeCodeForTokens` \(sent to IDP at token-exchange time\) MUST\s*\n?\s*\* pass the same value — IDPs reject the token exchange if the\s*\n?\s*\* `redirect_uri` differs from what they saw at authorize\./,
    );
    expect(body).toMatch(
      /function callbackUrlFor\(provider: OAuthClientProvider, base: string\): string \{\s*\n?\s*return `\$\{base\}\/\$\{provider\}\/callback`;\s*\n?\s*\}/,
    );
  });

  it("Crafted-huge-?error= body-bloat protection pinned: 'IDP may redirect with ?error=access_denied if the user cancelled the consent — surface a clean 400 in that case. Cap the error string to a sane bound before interpolating so a crafted huge ?error= value doesn't swell the problem+json body (OAuth-spec error codes are short tokens like access_denied, invalid_scope, etc.).' + .slice(0, 128) cap — pinned so the user-cancelled-clean-400 + 128-char cap + body-bloat-protection contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ IDP may redirect with \?error=access_denied if the user\s*\n?\s*\/\/ cancelled the consent — surface a clean 400 in that case\.\s*\n?\s*\/\/ Cap the error string to a sane bound before interpolating so\s*\n?\s*\/\/ a crafted huge \?error= value doesn't swell the problem\+json\s*\n?\s*\/\/ body \(OAuth-spec error codes are short tokens like\s*\n?\s*\/\/ 'access_denied', 'invalid_scope', etc\.\)\./,
    );
    expect(body).toMatch(
      /const errSlice = req\.query\.error\.slice\(0, 128\);\s*\n?\s*throw new BadRequestError\(`IDP returned error: \$\{errSlice\}`\);/,
    );
  });

  it("Per-provider 302-bounce loop framing pinned: for (const provider of ['google', 'github'] as const) + reply.redirect(target, 302) + 'Forward the IDP's entire query string verbatim. Includes code+state on success or error+error_description on consent denial — the SPA exchange route handles both.' — pinned so the iterate-IDP-list + verbatim-query-forward + handles-both-success-and-denial contract all stay documented", () => {
    expect(body).toMatch(
      /for \(const provider of \['google', 'github'\] as const\) \{\s*\n?\s*app\.get<\{ Querystring: Record<string, string> \}>\(\s*\n?\s*`\/v1\/auth\/oauth\/\$\{provider\}\/callback`,/,
    );
    expect(body).toMatch(
      /\/\/ Forward the IDP's entire query string verbatim\. Includes\s*\n?\s*\/\/ code\+state on success or error\+error_description on consent\s*\n?\s*\/\/ denial — the SPA exchange route handles both\./,
    );
    expect(body).toMatch(
      /const target = `\$\{deps\.dashboardOrigin\}\/auth\/oauth-client\/callback\?\$\{qs\.toString\(\)\}`;\s*\n?\s*return reply\.redirect\(target, 302\);/,
    );
  });

  it("readPkceCookie HMAC + length + timingSafeEqual framing pinned: D2 — HMAC over `${verifier}.${nonce}`, length-mismatch returns null + timingSafeEqual constant-time compare + try/catch on Buffer.from(sig, 'base64url'), returns {verifier, nonce}. Drift to a non-constant-time compare would invite timing attacks against the signature check", () => {
    // D2 — the HMAC now covers the state nonce, and the cookie returns both.
    expect(body).toMatch(
      /const expected = createHmac\('sha256', secret\)\.update\(`\$\{verifier\}\.\$\{nonce\}`\)\.digest\(\);/,
    );
    expect(body).toMatch(
      /if \(received\.length !== expected\.length\) return null;\s*\n?\s*if \(!timingSafeEqual\(received, expected\)\) return null;\s*\n?\s*return \{ verifier, nonce \};/,
    );
    expect(body).toMatch(
      /try \{\s*\n?\s*received = Buffer\.from\(sig, 'base64url'\);\s*\n?\s*\} catch \{\s*\n?\s*return null;\s*\n?\s*\}/,
    );
  });

  it('nonce-scoped cookies preserve independent browser flows and the five security attributes', () => {
    expect(body).toMatch(
      /function pkceCookieName\(nonce: string\): string \{\s*\n?\s*return `\$\{COOKIE_NAME_PREFIX\}\$\{createHash\('sha256'\)\.update\(nonce\)\.digest\('base64url'\)\}`;\s*\n?\s*\}/,
    );
    expect(body).toMatch(/const cookieName = pkceCookieName\(nonce\);/);
    expect(body).toMatch(
      /`\$\{cookieName\}=\$\{value\}; Path=\/v1\/auth\/oauth-client; HttpOnly; Secure; SameSite=Lax; Max-Age=\$\{COOKIE_TTL_SECONDS\.toString\(\)\}`/,
    );
    expect(body).toMatch(
      /`\$\{pkceCookieName\(nonce\)\}=; Path=\/v1\/auth\/oauth-client; HttpOnly; Secure; SameSite=Lax; Max-Age=0`/,
    );
    expect(body).toMatch(/const cookie = readPkceCookie\(req, deps\.signingSecret, stateNonce\);/);
    expect(body).toMatch(
      /const expectedName = pkceCookieName\(expectedNonce\);[\s\S]*?if \(k === expectedName\)/,
    );
    expect(body).toMatch(
      /const verifier = cookie\.verifier;\s*\n?\s*clearPkceCookie\(reply, stateNonce\);/,
    );
  });

  it("4-outcome union response shape pinned: signed-in-existing-link / created-new-account (account_id + redirect_to) + collision-pending-verification (pending_link_id + expires_at) + existing-link-revoked (account_id + hint: 'fall back to password sign-in or re-link the IDP') + ConfirmMerge outcome: 'merged' as const (account_id + link_id) — pinned so the 4-Verdict-locked outcomes + revoked-hint-text + ConfirmMerge-success-shape contract all stay documented", () => {
    expect(body).toMatch(
      /\.\.\.\(result\.kind === 'signed-in-existing-link' \|\| result\.kind === 'created-new-account'\s*\n?\s*\? \{\s*\n?\s*account_id: result\.accountId,\s*\n?\s*redirect_to: redirectTo,[\s\S]*?\}\s*\n?\s*: \{\}\),/,
    );
    expect(body).toMatch(
      /\.\.\.\(result\.kind === 'collision-pending-verification'\s*\n?\s*\? \{\s*\n?\s*pending_link_id: result\.pendingLinkId,\s*\n?\s*expires_at: result\.expiresAt\.toISOString\(\),\s*\n?\s*\}\s*\n?\s*: \{\}\),/,
    );
    expect(body).toMatch(/hint: 'fall back to password sign-in or re-link the IDP',/);
    expect(body).toMatch(
      /return reply\.code\(200\)\.send\(\{\s*\n?\s*outcome: 'merged' as const,\s*\n?\s*account_id: result\.accountId,\s*\n?\s*link_id: result\.linkId,\s*\n?\s*\}\);/,
    );
  });

  it('returns an explicit OAuth MFA challenge instead of session plaintext for enrolled accounts', () => {
    expect(body).toMatch(/session\?\.kind === 'mfa_required'/);
    expect(body).toMatch(/mfa_required: true as const/);
    expect(body).toMatch(/challenge_token: mfaChallenge\.challengeToken/);
    expect(body).toMatch(/challenge_expires_at: mfaChallenge\.challengeExpiresAt\.toISOString\(\)/);
  });
});
