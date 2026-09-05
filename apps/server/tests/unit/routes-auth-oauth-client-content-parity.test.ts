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
      /\/\/\s+POST \/v1\/auth\/oauth-client\/start\s+— issue authorize URL\s*\/\/\s+GET\s+\/v1\/auth\/oauth\/:provider\/callback\s+— IDP redirects here;\s*\/\/\s+302 to SPA callback/,
    );
    expect(body).toMatch(
      /\/\/\s+GET\s+\/v1\/auth\/oauth-client\/callback\s+— SPA-side exchange\s*\/\/\s+\(existing flow\)\s*\/\/\s+POST \/v1\/auth\/oauth-client\/confirm-merge\s+— Verdict 1 collision-\s*\/\/\s+flow completion/,
    );
  });

  it("Path A 2026-05-16 IDP-redirect-bounce framing pinned: 'the IDP redirect target moved from the SPA origin (${dashboardOrigin}/auth/oauth-client/callback) to the API per-provider path (${callbackUrlBase}/${provider}/callback) so the redirect_uri Google + GitHub Consoles registered actually matches what the IDP sees. The per-provider API route only does a 302 to the SPA, preserving the IDP's query string — so the existing SPA fetch flow against /v1/auth/oauth-client/callback is unchanged (PKCE cookie path scope still aligns).' — pinned so the Path-A-2026-05-16 verdict + IDP-Console-registers-API-URL + 302-bounce-preserves-PKCE-cookie-scope contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Path A \(2026-05-16\): the IDP redirect target moved from the SPA\s*\/\/ origin \(`\$\{dashboardOrigin\}\/auth\/oauth-client\/callback`\) to the API\s*\/\/ per-provider path \(`\$\{callbackUrlBase\}\/\$\{provider\}\/callback`\) so the\s*\/\/ `redirect_uri` Google \+ GitHub Consoles registered actually matches\s*\/\/ what the IDP sees\./,
    );
  });

  it('PKCE cookie security framing pinned: HTTP-only secure cookie keyed on the state nonce, HMAC-signed, restricted to /v1/auth/oauth-client, and five-minute lifetime', () => {
    expect(body).toMatch(
      /\/\/ PKCE verifier storage: HTTP-only secure cookie keyed on the state\s*\/\/ nonce\. The cookie is HMAC-signed via the same OAUTH_CLIENT_STATE_\s*\/\/ SIGNING_SECRET used to sign the state JWT; tampering is detected\./,
    );
    expect(body).toMatch(/const COOKIE_NAME_PREFIX = 'ds_oauth_pkce_';/);
    expect(body).toMatch(/const COOKIE_TTL_SECONDS = 300;/);
  });

  it('StartBodySchema 2-field + ConfirmMergeBodySchema 1-field shape pinned: provider enum google/github + redirect_to url + token string min 32 max 128. Drift to allowing other provider strings would let injection of arbitrary IDP names; drift to the 32-128 token range would either reject legitimate confirm tokens (too short) or accept arbitrary blobs (too long)', () => {
    expect(body).toMatch(
      /const StartBodySchema = z\.object\(\{\s*provider: z\.enum\(\['google', 'github'\]\),\s*redirect_to: z\.string\(\)\.url\(\),\s*\}\);/,
    );
    expect(body).toMatch(
      /const ConfirmMergeBodySchema = z\.object\(\{\s*token: z\.string\(\)\.min\(32\)\.max\(128\),\s*\}\);/,
    );
  });

  it('/start redirect_to open-redirect guard pinned: redirect_to must be on the dashboard origin (a CLOSED allow-list: the configured dashboardOrigin, widened to BOTH first-party dashboard hosts only when the configured origin is itself one of them — T-3 host move 2026-09-05, when a single origin answered 400 to every sign-in from app.driftstack.io; else BadRequestError). Drift to dropping this would let a forged /start mint an authorize URL whose redirect_to bounces a just-signed-in user off-site — the callback echoes redirect_to back and the SPA navigates it. Source-level defense paired with the SPA-side safeNextPath sanitizer.', () => {
    expect(body).toMatch(
      /const configuredOrigin = new URL\(deps\.dashboardOrigin\)\.origin;\s*const allowedOrigins = new Set\(\[configuredOrigin\]\);\s*if \(FIRST_PARTY_DASHBOARD_ORIGINS\.includes\(configuredOrigin\)\) \{\s*for \(const origin of FIRST_PARTY_DASHBOARD_ORIGINS\) allowedOrigins\.add\(origin\);\s*\}\s*if \(!allowedOrigins\.has\(new URL\(parsed\.data\.redirect_to\)\.origin\)\) \{\s*throw new BadRequestError\('redirect_to must be on the dashboard origin\.'\);\s*\}/,
    );
    // The list itself is pinned where it lives (lib/cors-allow.ts): exactly the two
    // first-party dashboard hosts, never derived from the request.
    expect(body).toMatch(
      /import \{ FIRST_PARTY_DASHBOARD_ORIGINS \} from '\.\.\/lib\/cors-allow\.js';/,
    );
  });

  it("callbackUrlFor symmetry framing pinned: 'Derive the IDP-facing callback URL for a given provider. Both buildAuthorizeUrl (sent to IDP at authorize time) and exchangeCodeForTokens (sent to IDP at token-exchange time) MUST pass the same value — IDPs reject the token exchange if the redirect_uri differs from what they saw at authorize.' + `${base}/${provider}/callback` — pinned so the same-value-at-authorize-and-exchange contract stays documented (drift would break the IDP redirect_uri-match check + 100% of token exchanges)", () => {
    expect(body).toMatch(
      /\* Derive the IDP-facing callback URL for a given provider\. Both\s*\* `buildAuthorizeUrl` \(sent to IDP at authorize time\) and\s*\* `exchangeCodeForTokens` \(sent to IDP at token-exchange time\) MUST\s*\* pass the same value — IDPs reject the token exchange if the\s*\* `redirect_uri` differs from what they saw at authorize\./,
    );
    expect(body).toMatch(
      /function callbackUrlFor\(provider: OAuthClientProvider, base: string\): string \{\s*return `\$\{base\}\/\$\{provider\}\/callback`;\s*\}/,
    );
  });

  it("Crafted-huge-?error= body-bloat protection pinned: 'IDP may redirect with ?error=access_denied if the user cancelled the consent — surface a clean 400 in that case. Cap the error string to a sane bound before interpolating so a crafted huge ?error= value doesn't swell the problem+json body (OAuth-spec error codes are short tokens like access_denied, invalid_scope, etc.).' + .slice(0, 128) cap — pinned so the user-cancelled-clean-400 + 128-char cap + body-bloat-protection contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ IDP may redirect with \?error=access_denied if the user\s*\/\/ cancelled the consent — surface a clean 400 in that case\.\s*\/\/ Cap the error string to a sane bound before interpolating so\s*\/\/ a crafted huge \?error= value doesn't swell the problem\+json\s*\/\/ body \(OAuth-spec error codes are short tokens like\s*\/\/ 'access_denied', 'invalid_scope', etc\.\)\./,
    );
    expect(body).toMatch(
      /const errSlice = req\.query\.error\.slice\(0, 128\);\s*throw new BadRequestError\(`IDP returned error: \$\{errSlice\}`\);/,
    );
  });

  it("Per-provider 302-bounce loop framing pinned: for (const provider of ['google', 'github'] as const) + reply.redirect(target, 302) + 'Forward the IDP's entire query string verbatim. Includes code+state on success or error+error_description on consent denial — the SPA exchange route handles both.' — pinned so the iterate-IDP-list + verbatim-query-forward + handles-both-success-and-denial contract all stay documented", () => {
    expect(body).toMatch(
      /for \(const provider of \['google', 'github'\] as const\) \{\s*app\.get<\{ Querystring: Record<string, string> \}>\(\s*`\/v1\/auth\/oauth\/\$\{provider\}\/callback`,/,
    );
    expect(body).toMatch(
      /\/\/ Forward the IDP's entire query string verbatim\. Includes\s*\/\/ code\+state on success or error\+error_description on consent\s*\/\/ denial — the SPA exchange route handles both\./,
    );
    expect(body).toMatch(
      /const target = `\$\{deps\.dashboardOrigin\}\/auth\/oauth-client\/callback\?\$\{qs\.toString\(\)\}`;\s*return reply\.redirect\(target, 302\);/,
    );
  });

  it("readPkceCookie HMAC + length + timingSafeEqual framing pinned: D2 — HMAC over `${verifier}.${nonce}`, length-mismatch returns null + timingSafeEqual constant-time compare + try/catch on Buffer.from(sig, 'base64url'), returns {verifier, nonce}. Drift to a non-constant-time compare would invite timing attacks against the signature check", () => {
    // D2 — the HMAC now covers the state nonce, and the cookie returns both.
    expect(body).toMatch(
      /const expected = createHmac\('sha256', secret\)\.update\(`\$\{verifier\}\.\$\{nonce\}`\)\.digest\(\);/,
    );
    expect(body).toMatch(
      /if \(received\.length !== expected\.length\) return null;\s*if \(!timingSafeEqual\(received, expected\)\) return null;\s*return \{ verifier, nonce \};/,
    );
    expect(body).toMatch(
      /try \{\s*received = Buffer\.from\(sig, 'base64url'\);\s*\} catch \{\s*return null;\s*\}/,
    );
  });

  it('nonce-scoped cookies preserve independent browser flows and the five security attributes', () => {
    expect(body).toMatch(
      /function pkceCookieName\(nonce: string\): string \{\s*return `\$\{COOKIE_NAME_PREFIX\}\$\{createHash\('sha256'\)\.update\(nonce\)\.digest\('base64url'\)\}`;\s*\}/,
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
      /const verifier = cookie\.verifier;\s*clearPkceCookie\(reply, stateNonce\);/,
    );
  });

  it("4-outcome union response shape pinned: signed-in-existing-link / created-new-account (account_id + redirect_to) + collision-pending-verification (pending_link_id + expires_at) + existing-link-revoked (account_id + hint: 'fall back to password sign-in or re-link the IDP') + ConfirmMerge outcome: 'merged' as const (account_id + link_id) — pinned so the 4-Verdict-locked outcomes + revoked-hint-text + ConfirmMerge-success-shape contract all stay documented", () => {
    expect(body).toMatch(
      /\.\.\.\(result\.kind === 'signed-in-existing-link' \|\| result\.kind === 'created-new-account'\s*\? \{\s*account_id: result\.accountId,\s*redirect_to: redirectTo,[\s\S]*?\}\s*: \{\}\),/,
    );
    expect(body).toMatch(
      /\.\.\.\(result\.kind === 'collision-pending-verification'\s*\? \{\s*pending_link_id: result\.pendingLinkId,\s*expires_at: result\.expiresAt\.toISOString\(\),\s*\}\s*: \{\}\),/,
    );
    expect(body).toMatch(/hint: 'fall back to password sign-in or re-link the IDP',/);
    expect(body).toMatch(
      /return reply\.code\(200\)\.send\(\{\s*outcome: 'merged' as const,\s*account_id: result\.accountId,\s*link_id: result\.linkId,\s*\}\);/,
    );
  });

  it('returns an explicit OAuth MFA challenge instead of session plaintext for enrolled accounts', () => {
    expect(body).toMatch(/session\?\.kind === 'mfa_required'/);
    expect(body).toMatch(/mfa_required: true as const/);
    expect(body).toMatch(/challenge_token: mfaChallenge\.challengeToken/);
    expect(body).toMatch(/challenge_expires_at: mfaChallenge\.challengeExpiresAt\.toISOString\(\)/);
  });
});
