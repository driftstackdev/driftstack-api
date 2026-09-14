// Drift guard for apps/server/src/routes/auth-oauth-client.ts. Pins
// the V-667.C OAuth-client (sign-in-with-Google/GitHub) route surface
// at structural + security-contract level (the file is large enough
// that pinning every handler body would over-couple to refactor;
// these tests pin the 4-route roster + 4-verdict semantics + the
// cookie-free flow's storage/binding contract + Path-A IDP redirect_uri
// pattern). The v1 cookie path was retired 2026-09-14: the pins that
// held its cookie helpers now hold their absence.

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

  it("V-667.C module-level framing pinned: 'OAuth-client (sign-in-with-Google/GitHub) routes. POST /v1/auth/oauth-client/start — issue authorize URL + GET /v1/auth/oauth/:provider/callback — IDP returns here; token exchange, then 302 to the SPA with a fragment + POST /v1/auth/oauth-client/redeem — hand-off code + flow secret → session + POST /v1/auth/oauth-client/confirm-merge — Verdict 1 collision-flow completion.' — pinned so the V-667.C anchor + 4-route roster + per-route purpose + Verdict-1-collision-flow cross-reference contract all stay documented", () => {
    expect(body).toMatch(/\/\/ V-667\.C — OAuth-client \(sign-in-with-Google\/GitHub\) routes\./);
    expect(body).toMatch(
      /\/\/\s+POST \/v1\/auth\/oauth-client\/start\s+— issue authorize URL\s*\/\/\s+GET\s+\/v1\/auth\/oauth\/:provider\/callback\s+— IDP returns here; token\s*\/\/\s+exchange, then 302 to\s*\/\/\s+the SPA with a fragment/,
    );
    expect(body).toMatch(
      /\/\/\s+POST \/v1\/auth\/oauth-client\/redeem\s+— hand-off code \+ flow\s*\/\/\s+secret → session\s*\/\/\s+POST \/v1\/auth\/oauth-client\/confirm-merge\s+— Verdict 1 collision-\s*\/\/\s+flow completion/,
    );
  });

  it("Path A 2026-05-16 redirect_uri framing pinned: 'the IDP redirect target is the API per-provider path (${callbackUrlBase}/${provider}/callback), so the redirect_uri Google + GitHub Consoles registered is exactly what the IDP sees at authorize AND at token exchange (callbackUrlFor).' — pinned so the IDP-Console-registers-API-URL + same-value-at-both-legs contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ Path A \(2026-05-16\): the IDP redirect target is the API per-provider\s*\/\/ path \(`\$\{callbackUrlBase\}\/\$\{provider\}\/callback`\), so the `redirect_uri`\s*\/\/ Google \+ GitHub Consoles registered is exactly what the IDP sees at\s*\/\/ authorize AND at token exchange \(`callbackUrlFor`\)\./,
    );
  });

  it('cookie-free flow framing pinned: NO browser state on the API host, the three-step design, the D2 flow_secret↔state.bind binding checked BEFORE any DB write, and the closing "Nothing here reads or sets a cookie."', () => {
    expect(body).toMatch(
      /different registrable domains, so NO\s*\/\/ browser state is kept on the API host at all:/,
    );
    expect(body).toMatch(
      /\/\/ {3}1\. the dashboard mints a random flow_secret in its OWN first-party/,
    );
    expect(body).toMatch(
      /\/\/ {3}2\. the IDP returns top-level to \/v1\/auth\/oauth\/:provider\/callback,/,
    );
    expect(body).toMatch(
      /\/\/ {3}3\. the page POSTs \{code, flow_secret\} to \/redeem \(no credentials\);/,
    );
    expect(body).toMatch(
      /\/\/ D2 \(login-CSRF\): the flow_secret↔state\.bind binding is checked BEFORE\s*\/\/ any DB write or session mint/,
    );
    expect(body).toMatch(/Nothing\s*\/\/ here reads or sets a cookie\./);
  });

  it('server-side storage contract pinned: caller-prefixed store keys, VERIFIER_TTL_SECONDS = 300 (matches the state TTL), HANDOFF_TTL_SECONDS = 60, and the shared 43-char base64url shape', () => {
    expect(body).toMatch(/const VERIFIER_KEY_PREFIX = 'oauth-client-verifier:';/);
    expect(body).toMatch(/const HANDOFF_KEY_PREFIX = 'oauth-client-handoff:';/);
    expect(body).toMatch(/const VERIFIER_TTL_SECONDS = 300; \/\/ 5 min — matches state TTL/);
    expect(body).toMatch(/const HANDOFF_TTL_SECONDS = 60;/);
    expect(body).toMatch(/const BASE64URL_256_BIT_RE = \/\^\[A-Za-z0-9_-\]\{43\}\$\/;/);
    expect(body).toMatch(
      /function verifierKey\(nonce: string\): string \{\s*return `\$\{VERIFIER_KEY_PREFIX\}\$\{sha256Hex\(nonce\)\}`;\s*\}/,
    );
    expect(body).toMatch(
      /function handoffKey\(code: string\): string \{\s*return `\$\{HANDOFF_KEY_PREFIX\}\$\{sha256Hex\(code\)\}`;\s*\}/,
    );
  });

  it('StartBodySchema 3-field (binding_hash REQUIRED) + ConfirmMergeBodySchema 1-field shape pinned, and the stale-page 400: provider enum google/github + redirect_to url + binding_hash 43-char base64url; token string min 32 max 128. Drift to an optional binding_hash would reopen a start no browser can finish; drift on the token range would reject legitimate confirm tokens or accept arbitrary blobs', () => {
    expect(body).toMatch(
      /const StartBodySchema = z\.object\(\{\s*provider: z\.enum\(\['google', 'github'\]\),\s*redirect_to: z\.string\(\)\.url\(\),\s*binding_hash: z\.string\(\)\.regex\(BASE64URL_256_BIT_RE\),\s*\}\);/,
    );
    expect(body).toMatch(
      /const ConfirmMergeBodySchema = z\.object\(\{\s*token: z\.string\(\)\.min\(32\)\.max\(128\),\s*\}\);/,
    );
    expect(body).toMatch(
      /const STALE_SIGN_IN_PAGE_DETAIL =\s*'This sign-in page is out of date\. Reload the sign-in page and try again\.';/,
    );
    expect(body).toMatch(/const STALE_SIGN_IN_PAGE_REASON = 'stale_sign_in_page';/);
    expect(body).toMatch(
      /if \(bindingHashIsAbsent\(req\.body\)\) \{\s*throw new BadRequestError\(STALE_SIGN_IN_PAGE_DETAIL, \{\s*reason: STALE_SIGN_IN_PAGE_REASON,\s*\}\);\s*\}\s*throw new ValidationError\(parsed\.error\.flatten\(\)\);/,
    );
    // The stale message is for the ABSENT field only; a non-object body
    // (null, string, ARRAY — `typeof [] === 'object'`) is not read as a
    // stale page.
    expect(body).toMatch(
      /function bindingHashIsAbsent\(body: unknown\): boolean \{\s*if \(body === null \|\| typeof body !== 'object' \|\| Array\.isArray\(body\)\) return false;\s*return \(body as Record<string, unknown>\)\.binding_hash === undefined;\s*\}/,
    );
  });

  it('/start redirect_to open-redirect guard pinned: redirect_to must be on the dashboard origin (a CLOSED allow-list: the configured dashboardOrigin, widened to BOTH first-party dashboard hosts only when the configured origin is itself one of them — T-3 host move 2026-09-05, when a single origin answered 400 to every sign-in from app.driftstack.io; else BadRequestError). Drift to dropping this would let a forged /start mint an authorize URL whose redirect_to bounces a just-signed-in user off-site — /redeem echoes redirect_to back and the SPA navigates it. Source-level defense paired with the SPA-side safeNextPath sanitizer.', () => {
    expect(body).toMatch(
      /const configuredOrigin = new URL\(deps\.dashboardOrigin\)\.origin;\s*const allowedOrigins = new Set\(\[configuredOrigin\]\);\s*if \(FIRST_PARTY_DASHBOARD_ORIGINS\.includes\(configuredOrigin\)\) \{\s*for \(const origin of FIRST_PARTY_DASHBOARD_ORIGINS\) allowedOrigins\.add\(origin\);\s*\}\s*if \(!allowedOrigins\.has\(new URL\(parsed\.data\.redirect_to\)\.origin\)\) \{\s*throw new BadRequestError\('redirect_to must be on the dashboard origin\.'\);\s*\}/,
    );
    // The list itself is pinned where it lives (lib/cors-allow.ts): exactly the two
    // first-party dashboard hosts, never derived from the request.
    expect(body).toMatch(
      /import \{ FIRST_PARTY_DASHBOARD_ORIGINS \} from '\.\.\/lib\/cors-allow\.js';/,
    );
  });

  it('/start signs `bind` into the state and stores the verifier server-side under the nonce — the only two places the flow is anchored', () => {
    expect(body).toMatch(
      /const state = signOauthClientState\(\{\s*provider,\s*redirectTo: parsed\.data\.redirect_to,\s*signingSecret: deps\.signingSecret,\s*nowMs: now\(\),\s*nonce,\s*bind: parsed\.data\.binding_hash,\s*\}\);/,
    );
    expect(body).toMatch(
      /await deps\.flowStore\.set\(verifierKey\(nonce\), verifier, VERIFIER_TTL_SECONDS\);\s*return reply\.code\(200\)\.send\(\{ authorize_url: authorizeUrl, flow_id: flowIdFor\(nonce\) \}\);/,
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

  it('top-level IDP callback pinned: per-provider loop registration with NO automatic HEAD twin, the state verified FIRST, and ONE refusal shape (a bounded #oauth_error on the CONFIGURED origin) for an unverifiable state (state_invalid; state_replayed when it is ours but expired), a bind-less or malformed-bind state and an off-list origin — nothing from the query is ever forwarded', () => {
    expect(body).toMatch(
      /for \(const provider of \['google', 'github'\] as const\) \{\s*app\.get<\{ Querystring: Record<string, string> \}>\(\s*`\/v1\/auth\/oauth\/\$\{provider\}\/callback`,\s*\{ preHandler: \[topLevelGate\], exposeHeadRoute: false \},/,
    );
    expect(body).toMatch(
      /const configuredOrigin = new URL\(deps\.dashboardOrigin\)\.origin;\s*const refuse = \(code: OauthFragmentError = 'state_invalid'\) =>\s*reply\.redirect\(fragmentErrorUrl\(configuredOrigin, code\), 302\);/,
    );
    expect(body).toMatch(
      /if \(stateRes === null \|\| stateRes\.kind !== 'ok'\) \{[\s\S]{0,600}?return refuse\(stateRes\?\.kind === 'expired' \? 'state_replayed' : 'state_invalid'\);\s*\}\s*const payload = stateRes\.payload;\s*const bind = payload\.bind;\s*if \(bind === undefined \|\| !BASE64URL_256_BIT_RE\.test\(bind\)\) \{[\s\S]{0,600}?return refuse\(\);\s*\}/,
    );
    expect(body).toMatch(
      /const origin = redirectOriginFor\(payload\.redirectTo, deps\.dashboardOrigin\);\s*if \(origin === null\) return refuse\(\);/,
    );
    // Three refusal sites; only the unverifiable one passes a code (the
    // expired mapping), the other two take the state_invalid default.
    expect(body.match(/return refuse\(/g)).toHaveLength(3);
    expect(body.match(/return refuse\(\);/g)).toHaveLength(2);
    // The HEAD twin is disabled on this route and nowhere else in the file.
    expect(body.match(/exposeHeadRoute: false/g)).toHaveLength(1);
    // The verbatim forward is gone: no redirect carries a query string, and
    // the IDP's free-text error is never interpolated anywhere.
    expect(body).not.toMatch(/oauth-client\/callback\?/);
    expect(body).not.toMatch(/URLSearchParams/);
    expect(body).not.toMatch(/IDP returned error/);
    expect(body).toMatch(
      /if \(typeof req\.query\.error === 'string' && req\.query\.error\.length > 0\) \{[\s\S]{0,200}?return fail\('idp_denied'\);\s*\}/,
    );
    expect(body).toMatch(
      /function fragmentErrorUrl\(origin: string, code: OauthFragmentError\): string \{\s*return `\$\{origin\}\/auth\/oauth-client\/callback\/#oauth_error=\$\{code\}`;\s*\}/,
    );
  });

  it('/redeem D2 binding pinned: consume the hand-off BEFORE the compare, sha256(flow_secret) against the digest signed into the state, length-guarded timingSafeEqual, and the fixed refusal — drift to a non-constant-time compare would invite timing attacks; moving the consume below the compare would give a stolen fragment unlimited guesses', () => {
    expect(body).toMatch(
      /const raw = await deps\.flowStore\.consume\(handoffKey\(body\.code\)\);\s*if \(raw === null\) \{\s*throw new BadRequestError\('Hand-off code invalid, expired, or already used\.'\);\s*\}/,
    );
    expect(body).toMatch(
      /const presented = createHash\('sha256'\)\.update\(body\.flow_secret\)\.digest\(\);\s*const expected = Buffer\.from\(record\.bind, 'base64url'\);\s*if \(expected\.length !== presented\.length \|\| !timingSafeEqual\(expected, presented\)\) \{\s*throw new BadRequestError\('Sign-in was not started by this browser\.'\);\s*\}/,
    );
    const consumeAt = body.indexOf('deps.flowStore.consume(handoffKey(body.code))');
    const compareAt = body.indexOf('timingSafeEqual(expected, presented)');
    expect(consumeAt).toBeGreaterThan(0);
    expect(compareAt).toBeGreaterThan(consumeAt);
  });

  it('the cookie machinery is gone and stays gone: no Set-Cookie written, no Cookie read, no HMAC-signed cookie value, no legacy XHR exchange route — while the routes still set cache-control: no-store (positive control that the file is read)', () => {
    expect(body).not.toMatch(/reply\.header\(\s*'set-cookie'/i);
    expect(body).not.toMatch(/req\.headers\.cookie/);
    expect(body).not.toMatch(/Pkce|pkceCookie|COOKIE_NAME_PREFIX|COOKIE_TTL_SECONDS|ds_oauth_pkce/);
    expect(body).not.toMatch(/createHmac/);
    expect(body).not.toMatch(/Max-Age|HttpOnly|SameSite/);
    expect(body).not.toMatch(/'\/v1\/auth\/oauth-client\/callback'/);
    // The only mentions of Set-Cookie are the negative statements.
    expect(body.match(/Set-Cookie/g) ?? []).toHaveLength(2);
    expect(body.match(/NO Set-Cookie/g) ?? []).toHaveLength(2);
    expect(
      (body.match(/reply\.header\('cache-control', 'no-store'\);/g) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
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

  it('completeSignIn runs at /redeem only (never on the top-level navigation), so a session is minted into the request of the browser that proved the flow secret', () => {
    expect(body.match(/completeSignIn\(/g)).toHaveLength(2); // the declaration + the /redeem call
    expect(body).toMatch(
      /return reply\s*\.code\(200\)\s*\.send\(await completeSignIn\(req, record\.provider, record\.user, record\.redirectTo\)\);/,
    );
  });

  it('returns an explicit OAuth MFA challenge instead of session plaintext for enrolled accounts', () => {
    expect(body).toMatch(/session\?\.kind === 'mfa_required'/);
    expect(body).toMatch(/mfa_required: true as const/);
    expect(body).toMatch(/challenge_token: mfaChallenge\.challengeToken/);
    expect(body).toMatch(/challenge_expires_at: mfaChallenge\.challengeExpiresAt\.toISOString\(\)/);
  });
});
