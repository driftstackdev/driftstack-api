// W517.C — drift guard for apps/marketing-site/src/pages/docs/oauth-apps.astro.
// V-678 OAuth third-party app docs + W214.B scope-table accuracy pass.
// Drift here either changes a scope name (would create marketing↔
// api_key_scope-Postgres-enum divergence) or breaks the 4-OAuth-endpoint
// surface (would mislead integrators on PKCE-S256 + revocation flow).
//
//   • V-678 doc-comment framing.
//   • Admin-gated confidential-client registration; no public-client flow.
//   • W214.B SCOPES table mirrors api_key_scope enum; account_owner +
//     gui_control + legacy read/write/admin aliases + driftstack_internal_admin
//     intentionally NOT exposed to OAuth.
//   • SCOPES: 13 verb:resource scopes.
//   • Client registration: oac_ + oas_ prefixes + secret-shown-ONCE +
//     hash-only.
//   • PKCE-S256 + 43-128 char verifier + URL-safe-base64 SHA-256
//     code_challenge.
//   • Hosted /oauth/authorize/ 6-param query: client_id + redirect_uri +
//     state + code_challenge + code_challenge_method=S256 + scope.
//   • /v1/oauth/token 5-param body + 4-field response (access_token oat_
//     + token_type Bearer + expires_in 3600 + scope[]).
//   • 1-hour TTL + no refresh tokens + intentional-consent-re-confirmation.
//   • RFC 7662 /v1/oauth/introspect + RFC 7009 /v1/oauth/revoke
//     (always 200 to prevent enumeration probes).
//   • 5-security-expectation list.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/oauth-apps.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W517.C apps/marketing-site/src/pages/docs/oauth-apps.astro content parity', () => {
  const body = read(LIB);

  it('V-678 framing and the current admin-gated confidential-client posture are pinned', () => {
    expect(body).toMatch(
      /\/\/ V-678 — developer docs page for OAuth third-party app authors\.\s*\n?\s*\/\/ Describes the V-667 family \(registration, authorize, exchange,\s*\n?\s*\/\/ introspect, revoke\) from the perspective of an integrator, NOT\s*\n?\s*\/\/ from the perspective of an internal Driftstack engineer\./,
    );
    expect(body).toMatch(
      /\/\/ Posture: OAuth client registration is admin-gated\. Integrators request a\s*\n?\s*\/\/ confidential client through support; the live flow requires client_secret\s*\n?\s*\/\/ plus PKCE-S256 and does not implement a public-client variant\./,
    );
    expect(body).not.toMatch(/pre-launch|follow-up/i);
  });

  it('paid approval and downgrade token behavior are pinned', () => {
    expect(body).toContain('Customer authorization requires an API-enabled paid tier');
    expect(body).toContain('Free remains available for interactive desktop use');
    expect(body).toContain('cannot approve an OAuth authorization');
    expect(body).toContain('rejected while an account is Free and resume after upgrade');
  });

  it("W214.B api_key_scope enum + NOT-exposed-to-OAuth framing pinned: 'scope set matches the api_key_scope Postgres enum' + 'account_owner, gui_control, the legacy read/write/admin aliases, and the driftstack_internal_admin scope are issued via the API-keys flow and are intentionally NOT exposed to OAuth clients.' — pinned so the W214.B api_key_scope-enum-anchor + 4-NOT-exposed-scope-categories (account_owner + gui_control + legacy aliases + driftstack_internal_admin) commitment survives (drift to exposing any of these to OAuth would create marketing↔server divergence)", () => {
    expect(body).toMatch(
      /\/\/ W214\.B — scope set matches the `api_key_scope` Postgres enum\s*\n?\s*\/\/ \(apps\/server\/src\/db\/schema\.ts\)\./,
    );
    expect(body).toMatch(
      /\/\/ `account_owner`, `gui_control`, the legacy `read`\/`write`\/`admin`\s*\n?\s*\/\/ aliases, and the `driftstack_internal_admin` scope are issued via\s*\n?\s*\/\/ the API-keys flow and are intentionally NOT exposed to OAuth clients\./,
    );
  });

  it('13-scope verb:resource SCOPES array pinned: read:sessions + write:sessions + read:profiles + write:profiles + admin:profiles + read:webhooks + write:webhooks + admin:webhooks + read:api-keys + admin:api-keys + read:billing + admin:billing + read:audit — pinned so the 13-OAuth-scope ladder stays consistent with the W214.B-curated subset of api_key_scope (drift to exposing a 14th scope would risk leaking a reserved scope)', () => {
    expect(body).toMatch(/name: 'read:sessions'/);
    expect(body).toMatch(/name: 'write:sessions'/);
    expect(body).toMatch(/name: 'read:profiles'/);
    expect(body).toMatch(/name: 'write:profiles'/);
    expect(body).toMatch(/name: 'admin:profiles'/);
    expect(body).toMatch(/name: 'read:webhooks'/);
    expect(body).toMatch(/name: 'write:webhooks'/);
    expect(body).toMatch(/name: 'admin:webhooks'/);
    expect(body).toMatch(/name: 'read:api-keys'/);
    expect(body).toMatch(/name: 'admin:api-keys'/);
    expect(body).toMatch(/name: 'read:billing'/);
    expect(body).toMatch(/name: 'admin:billing'/);
    expect(body).toMatch(/name: 'read:audit'/);
  });

  it("Client-registration framing pinned: developers@driftstack.dev email request + HTTPS-only redirect-URI in production + http://localhost:<port> accepted for dev + 'We turn around new client registrations within one business day. You get back a client_id (prefixed oac_) and a client_secret (prefixed oas_). The secret is shown to you ONCE — we only store the hash on our side, so we cannot recover it for you. Treat it like a Stripe secret key.' — pinned so the 1-business-day SLA + oac_/oas_ prefixes + secret-shown-ONCE + hash-only + Stripe-secret-analogy commitments survive", () => {
    expect(body).toMatch(
      /<a href="mailto:developers@driftstack\.dev">developers@driftstack\.dev<\/a>/,
    );
    expect(body).toMatch(
      /<li>Your redirect URI\(s\) — HTTPS only in production,\s*\n?\s*<code>http:\/\/localhost:&lt;port&gt;<\/code> is accepted for development<\/li>/,
    );
    expect(body).toMatch(
      /We turn around new client registrations within one business\s*\n?\s*day\. You get back a <code>client_id<\/code> \(prefixed\s*\n?\s*<code>oac_<\/code>\) and a <code>client_secret<\/code> \(prefixed\s*\n?\s*<code>oas_<\/code>\)\. The secret is shown to you ONCE — we only\s*\n?\s*store the hash on our side, so we cannot recover it for you\.\s*\n?\s*Treat it like a Stripe secret key\./,
    );
  });

  it("PKCE-S256 verifier framing pinned: 'Generate a high-entropy random string (RFC 7636 §4.1, 43–128 characters from [A-Za-z0-9-._~]). Compute the code_challenge as the URL-safe base64 of SHA-256(verifier). Keep the verifier in your app until step 3 — never send it to anyone except Driftstack at the token endpoint.' — pinned so the RFC-7636-§4.1 + 43-128-char-range + [A-Za-z0-9-._~]-charset + URL-safe-base64-SHA256 + never-send-verifier-except-to-token-endpoint commitment survives", () => {
    expect(body).toMatch(
      /Generate a high-entropy random string \(RFC 7636 §4\.1, 43–128\s*\n?\s*characters from <code>\[A-Za-z0-9-\._~\]<\/code>\)\. Compute the\s*\n?\s*<code>code_challenge<\/code> as the URL-safe base64 of\s*\n?\s*<code>SHA-256\(verifier\)<\/code>\./,
    );
    expect(body).toMatch(
      /Keep the verifier in your app\s*\n?\s*until step 3 — never send it to anyone except Driftstack at\s*\n?\s*the token endpoint\./,
    );
  });

  it('Hosted /oauth/authorize/ 6-param framing pinned: client_id (oac_) + redirect_uri + state (csrf-token) + code_challenge (sha256(verifier) base64url) + code_challenge_method=S256 + scope (space-separated) + callback outcomes + internal staging boundary', () => {
    expect(body).toMatch(/GET https:\/\/app\.driftstack\.dev\/oauth\/authorize\//);
    expect(body).toMatch(/\?client_id=oac_…/);
    expect(body).toMatch(/&redirect_uri=https:\/\/yourapp\.com\/oauth\/callback/);
    expect(body).toMatch(/&state=<csrf-token>/);
    expect(body).toMatch(/&code_challenge=<sha256\(verifier\) base64url>/);
    expect(body).toMatch(/&code_challenge_method=S256/);
    expect(body).toMatch(/&scope=read:sessions write:sessions/);
    expect(body).toMatch(
      /Verify <code>state<\/code> matches what you sent \(CSRF guard\) in\s*\n?\s*either case\./,
    );
    expect(body).toMatch(/\?error=access_denied&amp;state=…/);
    expect(body).toMatch(
      /your integration never receives or handles\s*\n?\s*the intermediate <code>authorization_id<\/code>/,
    );
    expect(body).toContain('GET /v1/oauth/authorize');
    expect(body).toContain('POST /v1/oauth/authorize/complete');
  });

  it('/v1/oauth/token 5-param body + 4-field response framing pinned: POST /v1/oauth/token body (code + code_verifier + client_id + client_secret + redirect_uri) → access_token (oat_ prefix) + token_type Bearer + expires_in 3600 + scope[] — pinned so the 5-field-body + 4-field-response + oat_-prefix + Bearer-type + 3600s = 1h TTL commitments survive', () => {
    expect(body).toMatch(/POST \/v1\/oauth\/token/);
    expect(body).toMatch(/"code": "\.\.\."/);
    expect(body).toMatch(/"code_verifier": "<your pkce verifier>"/);
    expect(body).toMatch(/"client_id": "oac_…"/);
    expect(body).toMatch(/"client_secret": "oas_…"/);
    expect(body).toMatch(/"redirect_uri": "https:\/\/yourapp\.com\/oauth\/callback"/);
    expect(body).toMatch(/"access_token": "oat_…"/);
    expect(body).toMatch(/"token_type": "Bearer"/);
    expect(body).toMatch(/"expires_in": 3600/);
    expect(body).toMatch(/"scope": \["read:sessions", "write:sessions"\]/);
  });

  it("1-hour TTL + no-refresh-tokens framing pinned: 'Tokens live for one hour. There are no refresh tokens — when the token expires, run the full authorize → exchange dance again. This is intentional: it makes consent re-confirmation a regular event rather than a forever-grant.' + scope-subset-enforcement: 'A token with read:sessions can call GET /v1/sessions but not POST /v1/sessions.' — pinned so the 1h-TTL + no-refresh-tokens + intentional-consent-re-confirmation + scope-subset-enforcement commitments survive (drift to introducing refresh tokens would invert the consent-re-confirmation posture)", () => {
    expect(body).toMatch(
      /Tokens live for <strong>one hour<\/strong>\. There are no\s*\n?\s*refresh tokens — when the token expires, run the full\s*\n?\s*authorize → exchange dance again\. This is intentional: it\s*\n?\s*makes consent re-confirmation a regular event rather than a\s*\n?\s*forever-grant\./,
    );
    expect(body).toMatch(
      /A token with\s*\n?\s*<code>read:sessions<\/code> can call <code>GET \/v1\/sessions<\/code>\s*\n?\s*but not <code>POST \/v1\/sessions<\/code>\./,
    );
  });

  it('RFC 7662/7009 examples require client credentials and bind token metadata/mutation to that client', () => {
    expect(body).toMatch(/<h2>Introspection \(RFC 7662\)<\/h2>/);
    expect(body).toMatch(/POST \/v1\/oauth\/introspect/);
    expect(body).toMatch(/"active": true/);
    expect(body).toMatch(/"client_id": "oac_…"/);
    expect(body).toMatch(/"account_id": "acc_…"/);
    expect(body).toMatch(/"scope": \["read:sessions"\]/);
    expect(body).toMatch(/"exp": 1736600000/);
    expect(body).toMatch(/"client_secret": "oas_…"/);
    expect(body).toMatch(/foreign-client token returns/);
    expect(body).toMatch(
      /Invalid or revoked client\s*\n?\s*credentials return 401 before token lookup\./,
    );
    expect(body).toMatch(/<h2>Revocation \(RFC 7009\)<\/h2>/);
    expect(body).toMatch(/POST \/v1\/oauth\/revoke/);
    expect(body).toMatch(/"token_type_hint": "access_token"/);
    expect(body).toMatch(
      /After client authentication succeeds, the endpoint returns 200\s*\n?\s*for an owned, unknown, or foreign-client token, but only a token\s*\n?\s*issued to your <code>client_id<\/code> is revoked\./,
    );
    expect(body).toMatch(/Invalid or revoked client credentials return 401\./);
  });

  it('5-security-expectation list pins confidential-client handling with no public-client flow', () => {
    expect(body).toMatch(
      /<strong>Always validate <code>state<\/code><\/strong> on the\s*\n?\s*redirect back\. Without it, your callback is wide open to CSRF\./,
    );
    expect(body).toMatch(
      /<strong>Generate a fresh PKCE verifier per authorization\s*\n?\s*flow\.<\/strong> Re-using a verifier defeats its purpose\./,
    );
    expect(body).toMatch(
      /<strong>HTTPS-only redirect_uri<\/strong> in production\.\s*\n?\s*Driftstack rejects HTTP redirect URIs that aren't localhost\./,
    );
    expect(body).toMatch(
      /<strong>Store client_secret server-side\.<\/strong> Every supported\s*\n?\s*client is confidential and the token, introspection, and revocation\s*\n?\s*endpoints require the secret\. A browser UI must exchange through its\s*\n?\s*own trusted backend; there is no public-client flow\./,
    );
    expect(body).toMatch(
      /<strong>Tokens are bearer tokens\.<\/strong> Anyone who reads\s*\n?\s*the token can act as the customer\. Treat them like passwords\./,
    );
  });

  it('account rate limits and the no-sandbox production boundary are pinned', () => {
    expect(body).toMatch(
      /Token-issued requests count against the customer's account\s*\n?\s*rate limits, not your app's\./,
    );
    expect(body).toMatch(
      /Driftstack has no separate sandbox environment\. Test with a paid dev\s*\n?\s*account on the production API and use least-privilege scopes\. Read-only\s*\n?\s*scopes cannot create sessions, but the account still uses production\s*\n?\s*data, limits, and rate-limit budgets\. The Free desktop\s*\n?\s*<code>ds_test_…<\/code> credential is not an OAuth or API sandbox key\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
