// Drift guard for apps/server/src/lib/oauth-client-exchange.ts. Pins
// the V-667.C OAuth-CLIENT code-exchange + userinfo-fetch — Step 4-5
// of the auth flow, fetch-seam pattern, per-provider parse, 5-variant
// tagged-union results, and the unverified-email rejection for
// Verdict-1-trust.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/oauth-client-exchange.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('lib/oauth-client-exchange content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("V-667.C module-level framing pinned: 'OAuth-CLIENT code-exchange + userinfo-fetch helpers. Step 4-5 of the auth flow: server-side POST to the IDP token endpoint to exchange code for access_token, then GET the userinfo endpoint to read the IDP's idea of the user. Both providers' responses are normalized to NormalizedUserInfo (see oauth-client-providers.ts) before the route layer touches them.' — pinned so the V-667.C anchor + step-4-5-anchor + NormalizedUserInfo cross-reference all stay documented", () => {
    expect(body).toMatch(/\/\/ V-667\.C — OAuth-CLIENT code-exchange \+ userinfo-fetch helpers\./);
    expect(body).toMatch(
      /\/\/ Step 4-5 of the auth flow: server-side POST to the IDP token\s*\/\/ endpoint to exchange `code` for `access_token`, then GET the\s*\/\/ userinfo endpoint to read the IDP's idea of the user\. Both\s*\/\/ providers' responses are normalized to NormalizedUserInfo \(see\s*\/\/ oauth-client-providers\.ts\) before the route layer touches them\./,
    );
  });

  it("Fetch-seam framing pinned: 'every IDP-bound HTTP call routes through deps.fetch, allowing tests to mock both happy + error paths. Default is the global fetch in Node 22+.' — pinned so the test-injectable-fetch pattern + Node-22+-global-fetch baseline stays documented (drift to hardcoding global fetch would defeat the test-mock pattern)", () => {
    expect(body).toMatch(
      /\/\/ fetch seam — every IDP-bound HTTP call routes through `deps\.fetch`,\s*\/\/ allowing tests to mock both happy \+ error paths\. Default is the\s*\/\/ global fetch in Node 22\+\./,
    );
  });

  it("ExchangeCodeOpts 7-field shape pinned: provider + clientId + clientSecret + callbackUrl + code + codeVerifier (PKCE) + optional fetch (test seam). + 'PKCE code_verifier matching the challenge in the authorize URL.' framing — pinned so the PKCE verifier-matches-challenge contract stay documented", () => {
    expect(body).toMatch(/export interface ExchangeCodeOpts \{/);
    expect(body).toMatch(/provider: OAuthClientProvider;/);
    expect(body).toMatch(/clientId: string;/);
    expect(body).toMatch(/clientSecret: string;/);
    expect(body).toMatch(/callbackUrl: string;/);
    expect(body).toMatch(/code: string;/);
    expect(body).toMatch(
      /\/\*\* PKCE code_verifier matching the challenge in the authorize URL\. \*\/\s*codeVerifier: string;/,
    );
    expect(body).toMatch(/fetch\?: typeof fetch;/);
  });

  it("ExchangedTokens 5-field shape pinned: accessToken + idToken (Google only) + expiresIn + refreshToken + scope. + JSDoc framing for each. Drift to dropping idToken would lose Google's sub claim without an extra userinfo round-trip", () => {
    expect(body).toMatch(/export interface ExchangedTokens \{/);
    expect(body).toMatch(/accessToken: string;/);
    expect(body).toMatch(
      /\/\*\* Google returns this; GitHub doesn't\. The route uses it to read\s*\*\s+the sub claim without an extra userinfo round-trip\. \*\/\s*idToken: string \| null;/,
    );
    expect(body).toMatch(
      /\/\*\* Seconds until access_token expires\. \*\/\s*expiresIn: number \| null;/,
    );
    expect(body).toMatch(/refreshToken: string \| null;/);
    expect(body).toMatch(
      /\/\*\* IDP-returned scope string\. Used as a sanity check vs requested\. \*\/\s*scope: string \| null;/,
    );
  });

  it("ExchangeCodeResult 5-variant tagged-union pinned: ok (with tokens) + invalid-grant (expired/already-used code) + invalid-client (mismatched id/secret) + idp-error (status + body) + network-error (message). Drift to dropping a variant would force callers to handle 'all the rest' as a fall-through", () => {
    expect(body).toMatch(/export type ExchangeCodeResult =/);
    expect(body).toMatch(/\| \{ kind: 'ok'; tokens: ExchangedTokens \}/);
    expect(body).toMatch(/\| \{ kind: 'invalid-grant' \/\* expired or already-used code \*\/ \}/);
    expect(body).toMatch(/\| \{ kind: 'invalid-client' \/\* mismatched client_id\/secret \*\/ \}/);
    expect(body).toMatch(/\| \{ kind: 'idp-error'; status: number; body: string \}/);
    expect(body).toMatch(/\| \{ kind: 'network-error'; message: string \};/);
  });

  it("exchangeCodeForTokens 6-form-field POST pinned: grant_type=authorization_code + code + redirect_uri + client_id + client_secret + code_verifier (PKCE). + per-provider framing 'Google: standard form-encoded POST...' + 'GitHub: same shape but accepts Accept: application/json header (without it, GitHub returns x-www-form-urlencoded body)'. — pinned so the OAuth2 standard 6-field form-POST + GitHub-needs-Accept-json contract stay documented (drift to dropping Accept:json would let GitHub return form-encoded response body which JSON.parse would reject)", () => {
    expect(body).toMatch(
      /Exchange an authorization code for tokens against the IDP\. Per-provider\s*\*\s+body shape:\s*\*\s+- Google: standard form-encoded POST with grant_type, code,\s*\*\s+redirect_uri, client_id, client_secret, code_verifier\s*\*\s+- GitHub: same shape but accepts Accept: application\/json header\s*\*\s+\(without it, GitHub returns x-www-form-urlencoded body\)/,
    );
    expect(body).toMatch(
      /const body = new URLSearchParams\(\{\s*grant_type: 'authorization_code',\s*code: opts\.code,\s*redirect_uri: opts\.callbackUrl,\s*client_id: opts\.clientId,\s*client_secret: opts\.clientSecret,\s*code_verifier: opts\.codeVerifier,\s*\}\);/,
    );
  });

  it('invalid_grant + invalid_client error-code routing pinned: HTTP 4xx with error=invalid_grant → invalid-grant variant + HTTP 4xx with error=invalid_client → invalid-client variant + any other 4xx → idp-error. + 200-with-error-body handling (GitHub legacy without Accept:json header) + bad_verification_code → invalid-grant. Drift would let invalid-credential responses fall into the generic idp-error bucket, losing the Verdict-2 fork', () => {
    expect(body).toMatch(
      /if \(!res\.ok\) \{\s*const errCode = typeof parsed\.error === 'string' \? parsed\.error : '';\s*if \(errCode === 'invalid_grant'\) return \{ kind: 'invalid-grant' \};\s*if \(errCode === 'invalid_client'\) return \{ kind: 'invalid-client' \};/,
    );
    expect(body).toMatch(
      /\/\/ Some providers \(notably GitHub before sending Accept: json\) return a\s*\/\/ 200 with `error=\.\.\.` body when the code is bad\. Treat that same as\s*\/\/ an HTTP-error response\./,
    );
    expect(body).toMatch(
      /if \(parsed\.error === 'invalid_grant' \|\| parsed\.error === 'bad_verification_code'\) \{\s*return \{ kind: 'invalid-grant' \};\s*\}/,
    );
  });

  it("FetchUserInfoResult 5-variant tagged-union pinned: ok (with user) + unauthorized (access_token rejected) + unverified-email (Verdict-1 trust gate) + idp-error + network-error. + unverified-email-rejects-on-Verdict-1 framing 'The function rejects unverified emails — the Verdict 1 (merge-with-verification) collision-flow depends on a trustworthy IDP-asserted email, so we don't proceed unless the IDP says the email is verified.' — pinned so the 5-variant catalog + Verdict-1-trust-contract stay documented", () => {
    expect(body).toMatch(/export type FetchUserInfoResult =/);
    expect(body).toMatch(
      /\| \{ kind: 'unauthorized' \/\* access_token rejected or revoked \*\/ \}/,
    );
    expect(body).toMatch(
      /\| \{ kind: 'unverified-email' \/\* IDP returned no verified email \*\/ \}/,
    );
    expect(body).toMatch(
      /\* Fetch \+ normalize the user profile from the IDP\. Returns\s*\*\s+NormalizedUserInfo on success\. The function rejects unverified\s*\*\s+emails — the Verdict 1 \(merge-with-verification\) collision-flow\s*\*\s+depends on a trustworthy IDP-asserted email, so we don't proceed\s*\*\s+unless the IDP says the email is verified\./,
    );
  });

  it("fetchUserInfo Bearer + user-agent framing pinned: 'authorization: Bearer ${accessToken}' + 'GitHub requires a User-Agent on api.github.com requests.' user-agent: 'driftstack-api'. Drift to dropping User-Agent would cause GitHub to reject the userinfo call with 403. The userinfo call is bounded by fetchWithTimeout (V-667.C resilience). Short focused pins — not one long backtracking-prone chain.", () => {
    expect(body).toMatch(/fetchWithTimeout\(\s*fetchImpl,\s*provider\.userinfoUrl,/);
    expect(body).toMatch(/authorization: `Bearer \$\{opts\.accessToken\}`,/);
    expect(body).toMatch(/\/\/ GitHub requires a User-Agent on api\.github\.com requests\./);
    expect(body).toMatch(/'user-agent': 'driftstack-api',/);
  });

  it('V-667.C IDP-fetch TIMEOUT hardening pinned: every IDP-bound fetch (token + userinfo + /user/emails) is wrapped by fetchWithTimeout (AbortController + setTimeout(abort) + clearTimeout finally), bounding the login-path request so a hung IDP cannot hang the Fastify worker (no Fastify requestTimeout is set). Drift to a bare unbounded fetchImpl(provider.*) call would reintroduce the hang.', () => {
    expect(body).toMatch(/const DEFAULT_OAUTH_FETCH_TIMEOUT_MS = 10_000;/);
    expect(body).toMatch(/async function fetchWithTimeout\(/);
    expect(body).toMatch(/const ac = new AbortController\(\);/);
    expect(body).toMatch(/const timer = setTimeout\(\(\) => ac\.abort\(\), timeoutMs\);/);
    expect(body).toMatch(
      /const res = await fetchImpl\(url, \{ \.\.\.init, redirect: 'error', signal: ac\.signal \}\);/,
    );
    // The bounded body read is INSIDE the timer scope (bug-class fix bc72ff48 —
    // clearTimeout-after-fetch left body reads unbounded). Helper returns text.
    expect(body).toMatch(/const text = await readBoundedResponseBody\(res\);/);
    expect(body).toMatch(/return \{ status: res\.status, ok: res\.ok, text \};/);
    expect(body).toMatch(/clearTimeout\(timer\);/);
    expect(body).toMatch(/fetchWithTimeout\(\s*fetchImpl,\s*provider\.tokenUrl,/);
    expect(body).toMatch(/timeoutMs\?: number;/);
    // No bare unbounded IDP fetch remains — all routed through the helper.
    expect(body).not.toMatch(/await fetchImpl\(provider\./);
  });

  it('IDP body size is bounded before parse for declared and chunked responses', () => {
    expect(body).toMatch(/const MAX_OAUTH_RESPONSE_BODY_BYTES = 256 \* 1024;/);
    expect(body).toMatch(/res\.headers\.get\('content-length'\)/);
    expect(body).toMatch(/bytesRead \+= value\.byteLength;/);
    expect(body).toMatch(/if \(bytesRead > MAX_OAUTH_RESPONSE_BODY_BYTES\)/);
    expect(body).toMatch(/await reader\.cancel\(\)\.catch\(\(\) => \{\}\);/);
    expect(body).not.toMatch(/await res\.text\(\)/);
  });

  it('Google parse pinned: { sub, email, email_verified, name, picture } + Google sub/email-missing → idp-error + emailVerified-false → unverified-email + Verdict-3-avatar from picture. Drift to dropping email_verified check would let unverified Google emails reach the Verdict-1 collision flow', () => {
    expect(body).toMatch(
      /if \(opts\.provider === 'google'\) \{\s*\/\/ Google openid userinfo response: \{ sub, email, email_verified, name, picture \}/,
    );
    expect(body).toMatch(
      /const sub = typeof parsed\.sub === 'string' \? parsed\.sub : '';\s*const email = typeof parsed\.email === 'string' \? parsed\.email : '';\s*const emailVerified = parsed\.email_verified === true;\s*if \(sub\.length === 0 \|\| email\.length === 0\) \{\s*return \{ kind: 'idp-error', status: 200, body: 'missing sub\/email' \};\s*\}\s*if \(!emailVerified\) return \{ kind: 'unverified-email' \};/,
    );
    expect(body).toMatch(
      /avatarUrl: typeof parsed\.picture === 'string' \? parsed\.picture : null,/,
    );
  });

  it("GitHub parse + /user/emails fallback framing pinned (2026-05-20 — earlier comment claimed the fallback was the caller's responsibility but no caller actually did it, so private-email customers hit 'Userinfo fetch failed: unverified-email'; the fallback now lives inline here)", () => {
    expect(body).toMatch(
      /\/\/ GitHub: \/user returns \{ id: number, login, name, avatar_url \}\. Email\s*\/\/ is null on \/user when the customer has "Keep my email addresses\s*\/\/ private" enabled in GitHub settings/,
    );
    expect(body).toMatch(
      /\/\/ accounts\)\. Fall back to \/user\/emails \(requires the user:email\s*\/\/ scope which we always request\) to find the primary \+ verified\s*\/\/ address\./,
    );
    expect(body).toMatch(
      /\/\/ GitHub's \/user doesn't carry a per-user email_verified flag;\s*\/\/ the \/user\/emails endpoint does\. Caller cross-checks if needed\.\s*\/\/ Treat the primary email as verified for the V-667\.C trust\s*\/\/ contract since GitHub only exposes primary emails on verified\s*\/\/ accounts\./,
    );
    expect(body).toMatch(
      /const githubId = typeof id === 'number' \? String\(id\) : typeof id === 'string' \? id : '';/,
    );
    // /user/emails fallback inline (bounded by fetchWithTimeout).
    expect(body).toMatch(
      /await fetchWithTimeout\(\s*fetchImpl,\s*'https:\/\/api\.github\.com\/user\/emails',/,
    );
    expect(body).toMatch(
      /const primary = emailsParsed\.find\(\s*\(e\) => e\.primary === true && e\.verified === true && typeof e\.email === 'string',\s*\);/,
    );
  });

  it('idp-error body-truncation pinned: text.slice(0, 500) cap on idp-error body to keep error responses bounded. Drift to including the full body would let IDP-generated multi-KB error pages flood logs', () => {
    expect(body).toMatch(
      /return \{ kind: 'idp-error', status: res\.status, body: text\.slice\(0, 500\) \};/,
    );
  });
});
