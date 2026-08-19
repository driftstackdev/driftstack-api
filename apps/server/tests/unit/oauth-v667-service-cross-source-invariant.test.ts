// W919 — V-667 OAuth 2.0 authorization-code service cross-source
// invariant. Two-hundred-forty-fifth in the drift-guard series.
// Pins the third-party OAuth authorization-code flow contract:
//
//   V-667 anchor — 'OAuth 2.0 authorization-code flow service
//   (invite-only v1)'. Builds on V-488's PKCE primitives.
//
//   D-2026-05-10-01 decision — tokens are OPAQUE bearer strings
//   (no JWT), with dedicated client-authenticated lifecycle routes;
//   scopes are a subset of ApiKeyScope; no refresh tokens v1.
//
//   5-step flow:
//     1. Admin registers OAuth client via
//        /v1/admin/oauth/clients (invite-only — no self-service).
//     2. Third-party redirects to GET /v1/oauth/authorize with
//        client_id + redirect_uri + state + code_challenge +
//        code_challenge_method=S256 + scope.
//     3. Dashboard renders approval; POST
//        /v1/oauth/authorize/complete calls approveAuthorization.
//     4. Customer redirected back with code + state.
//     5. App POSTs /v1/oauth/token with code + code_verifier +
//        client_id + client_secret → opaque access_token.
//
//   TTLs:
//     - CODE_TTL_SECONDS = 5 * 60 (= 300 sec).
//     - TOKEN_TTL_SECONDS = 60 * 60 (= 3600 sec, 1 hour).
//
//   OAuthError 6 codes — invalid_client | invalid_request |
//     unauthorized_client | access_denied | invalid_grant |
//     invalid_scope. (RFC 6749 §5.2 error response codes.)
//
//   OAuthClient (7 fields): client_id + client_secret_hash (sha256
//     hex) + redirect_uris (exact-match) + label + account_id
//     (nullable) + created_at + revoked_at (nullable for soft-delete).
//
//   AuthorizationCode (9 fields, one-shot consumed_at gate):
//     code + client_id + redirect_uri + state + scope +
//     code_challenge + account_id + created_at + consumed_at.
//
//   AccessToken (6 fields): token + client_id + account_id +
//     scope + created_at + expires_at.
//
//   client_secret_hash framing — 'sha256 hex of the secret —
//     never the secret itself in the store'.
//
//   RegisterClientResult.client_secret framing — 'Plaintext —
//     surfaced ONCE on registration. The store keeps only the hash'.
//
//   invalid_grant returned for: 'code unknown or expired' OR 'code
//     already exchanged' OR 'code issued to a different client' OR
//     'redirect_uri mismatch'.
//
// stays in lockstep across apps/server/src/services/oauth.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W919 V-667 OAuth service cross-source invariant', () => {
  // ─── V-667 anchor + invite-only v1 framing ───────────────────

  it("CRITICAL apps/server/src/services/oauth.ts header pins V-667 anchor — 'V-667 — OAuth 2.0 authorization-code flow service (invite-only v1)'. The V-667 anchor + invite-only-v1 scope are the policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/oauth.ts'));
    expect(p).toMatch(/V-667 — OAuth 2\.0 authorization-code flow service \(invite-only v1\)/);
  });

  it("CRITICAL builds on V-488 PKCE framing — 'Builds on V-488's PKCE primitives'. The V-488 anchor is the dependency-provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/oauth.ts'));
    expect(p).toMatch(/Builds on V-488's PKCE primitives/);
  });

  // ─── D-2026-05-10-01 opaque tokens decision ──────────────────

  it("CRITICAL D-2026-05-10-01 decision framing — 'Tokens are OPAQUE bearer strings (no JWT — D-2026-05-10-01 decision)'. The opaque-tokens decision is what avoids JWT key-rotation complexity at OAuth-v1 scale.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/oauth.ts'));
    expect(p).toMatch(/Tokens are OPAQUE bearer strings \(no JWT — D-2026-05-10-01 decision\)/);
  });

  it("CRITICAL no-refresh-tokens framing — 'No refresh tokens v1 — the third-party re-prompts the customer if their access token expires'. The no-refresh design simplifies revocation (just delete the token row).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/oauth.ts'));
    expect(p).toMatch(/No refresh\s*\n?\/\/ tokens v1 — the third-party re-prompts the customer/);
    expect(p).toMatch(/if their access\s*\n?\/\/ token expires/);
  });

  it('CRITICAL tokens use dedicated client-authenticated introspection/revocation and ApiKeyScope subsets', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/oauth.ts'));
    expect(p).toMatch(/They use dedicated client-authenticated introspection and revocation/);
    expect(p).toMatch(/endpoints, and their scopes are a subset of `ApiKeyScope`/);
    expect(p).toMatch(/`ApiKeyScope`/);
  });

  // ─── 5-step OAuth flow ───────────────────────────────────────

  it('CRITICAL 5-step flow framing — 1. Admin registers client (invite-only). 2. GET /v1/oauth/authorize with code_challenge + code_challenge_method=S256. 3. Dashboard approval → POST /v1/oauth/authorize/complete. 4. Redirect with code + state. 5. POST /v1/oauth/token with code + code_verifier → opaque access_token. The 5-step pin matches RFC 6749 + RFC 7636 PKCE.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/oauth.ts'));
    expect(p).toMatch(/1\. Admin uses \/v1\/admin\/oauth\/clients to register an OAuth client/);
    expect(p).toMatch(/2\. Third-party app redirects the customer to GET \/v1\/oauth\/authorize/);
    expect(p).toMatch(/3\. The dashboard renders an approval screen/);
    expect(p).toMatch(/4\. Customer is redirected back to the third-party app with `code`/);
    expect(p).toMatch(/5\. The app POSTs \/v1\/oauth\/token with `code`, `code_verifier`/);
  });

  it("CRITICAL invite-only framing — 'invite-only — no self-service signup v1'. The invite-only scope avoids un-vetted third-party app explosion + accountability gap.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/oauth.ts'));
    expect(p).toMatch(/invite-only — no self-service signup v1/);
  });

  it("CRITICAL code_challenge_method=S256 framing pinned (PKCE RFC 7636). Drift to 'plain' would weaken the verifier-binding.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/oauth.ts'));
    expect(p).toMatch(/`code_challenge`,\s*\n\/\/\s+`code_challenge_method=S256`/);
  });

  // ─── TTLs: 5-min code + 1h token ─────────────────────────────

  it('CRITICAL CODE_TTL_SECONDS = 5 * 60 (= 300 sec). The 5-min authorization-code window is wide enough for the user to traverse the redirect-back flow but narrow enough to bound race-window attacks.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/oauth.ts'));
    expect(p).toMatch(/const CODE_TTL_SECONDS = 5 \* 60;/);
  });

  it("CRITICAL TOKEN_TTL_SECONDS = 60 * 60 (= 3600 sec, 1 hour). The 1-hour token framing pinned with '1 hour — short by design; no refresh tokens'. Short TTL + no refresh = third-party re-prompts customer hourly.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/oauth.ts'));
    expect(p).toMatch(
      /const TOKEN_TTL_SECONDS = 60 \* 60;.*1 hour — short by design; no refresh tokens/,
    );
  });

  // ─── OAuthError 6-value error codes (RFC 6749 §5.2) ──────────

  it("CRITICAL OAuthError 6 codes — 'invalid_client' | 'invalid_request' | 'unauthorized_client' | 'access_denied' | 'invalid_grant' | 'invalid_scope'. The 6-value enum matches RFC 6749 §5.2 token-error-response codes (subset; no server_error / temporarily_unavailable v1).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/oauth.ts'));
    expect(p).toMatch(/export class OAuthError extends Error \{/);
    expect(p).toMatch(/\| 'invalid_client'/);
    expect(p).toMatch(/\| 'invalid_request'/);
    expect(p).toMatch(/\| 'unauthorized_client'/);
    expect(p).toMatch(/\| 'access_denied'/);
    expect(p).toMatch(/\| 'invalid_grant'/);
    expect(p).toMatch(/\| 'invalid_scope',/);
  });

  // ─── OAuthClient 7-field shape ───────────────────────────────

  it('CRITICAL OAuthClient has 7 fields — client_id + client_secret_hash + redirect_uris (readonly[]) + label + account_id (nullable) + created_at + revoked_at (nullable). The 7-field shape carries soft-delete (revoked_at) + invite-only attribution (account_id).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/oauth.ts'));
    expect(p).toMatch(/export interface OAuthClient \{/);
    expect(p).toMatch(/client_id: string;/);
    expect(p).toMatch(/client_secret_hash: string;/);
    expect(p).toMatch(/redirect_uris: readonly string\[\];/);
    expect(p).toMatch(/label: string;/);
    expect(p).toMatch(/account_id: string \| null;/);
    expect(p).toMatch(/created_at: number;/);
    expect(p).toMatch(/revoked_at: number \| null;/);
  });

  it("CRITICAL client_secret_hash framing — 'sha256 hex of the secret — never the secret itself in the store'. The hash-not-plaintext is what makes the store safe under read-leak (constant-time-equality on hash).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/oauth.ts'));
    expect(p).toMatch(/sha256 hex of the secret — never the secret itself in the store/);
  });

  it("CRITICAL redirect_uris framing — 'Allowed redirect URIs. Exact-match check on /authorize'. The exact-match (not prefix) is the OAuth-CSRF defense against open-redirect attacks.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/oauth.ts'));
    expect(p).toMatch(/Allowed redirect URIs\. Exact-match check on \/authorize/);
  });

  it('CRITICAL revoked clients reject every provider authorization and lifecycle operation', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/oauth.ts'));
    expect(p).toMatch(
      /Soft-deleted clients reject authorize, token, introspection, and revocation/,
    );
  });

  // ─── AuthorizationCode 9-field shape ─────────────────────────

  it('CRITICAL AuthorizationCode has 9 fields — code + client_id + redirect_uri + state + scope (readonly ApiKeyScope[]) + code_challenge + account_id + created_at + consumed_at (nullable). The 9-field shape carries PKCE binding (code_challenge) + one-shot gate (consumed_at).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/oauth.ts'));
    expect(p).toMatch(/export interface AuthorizationCode \{/);
    expect(p).toMatch(/code: string;/);
    expect(p).toMatch(/redirect_uri: string;/);
    expect(p).toMatch(/state: string;/);
    expect(p).toMatch(/scope: readonly ApiKeyScope\[\];/);
    expect(p).toMatch(/code_challenge: string;/);
    expect(p).toMatch(/consumed_at: number \| null;/);
  });

  it("CRITICAL consumed_at framing — 'Once-only: set on exchange. Second exchange returns invalid_grant'. The one-shot gate is what prevents replay-after-exchange.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/oauth.ts'));
    expect(p).toMatch(/Once-only: set on exchange\. Second exchange returns invalid_grant/);
  });

  // ─── AccessToken 6-field shape ───────────────────────────────

  it('CRITICAL AccessToken has 7 fields, and this arm pins 6 of them and carries the client ownership used by introspection/revocation', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/oauth.ts'));
    expect(p).toMatch(/export interface AccessToken \{/);
    expect(p).toMatch(/token: string;/);
    expect(p).toMatch(/expires_at: number;/);
  });

  it('CRITICAL client lifecycle methods authenticate first and never disclose or mutate a foreign token', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/oauth.ts'));
    expect(p).toMatch(/async introspectForClient\(args: ClientTokenArgs\)/);
    expect(p).toMatch(/return token\?\.client_id === client\.client_id \? token : null;/);
    expect(p).toMatch(/async revokeTokenForClient\(args: ClientTokenArgs\)/);
    expect(p).toMatch(/if \(token\?\.client_id === client\.client_id\)/);
    expect(p).toMatch(/throw new OAuthError\('invalid_client', 'invalid client credentials'\)/);
  });

  // ─── RegisterClientResult plaintext-once framing ─────────────

  it("CRITICAL RegisterClientResult.client_secret framing — 'Plaintext — surfaced ONCE on registration. The store keeps only the hash'. The show-once-then-hash pattern is the same V-079 API-key creation flow.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/oauth.ts'));
    expect(p).toMatch(/Plaintext — surfaced ONCE on registration\. The store keeps only the hash/);
  });

  // ─── invalid_grant 4-cause taxonomy ──────────────────────────

  it("CRITICAL invalid_grant returned for 4 distinct causes — 'code unknown or expired' / 'code already exchanged' / 'code issued to a different client' / 'redirect_uri mismatch'. The 4-cause taxonomy is what makes invalid_grant debuggable without leaking inner mechanisms via error code splits.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/oauth.ts'));
    expect(p).toMatch(/throw new OAuthError\('invalid_grant', 'code unknown or expired'\)/);
    expect(p).toMatch(/throw new OAuthError\('invalid_grant', 'code already exchanged'\)/);
    expect(p).toMatch(
      /throw new OAuthError\('invalid_grant', 'code issued to a different client'\)/,
    );
    expect(p).toMatch(/throw new OAuthError\('invalid_grant', 'redirect_uri mismatch'\)/);
  });

  // ─── verifyS256Challenge import (V-488 PKCE) ─────────────────

  it('CRITICAL verifyS256Challenge imported from V-488 oauth-pkce. The shared PKCE primitive is what makes /v1/oauth/token verifier-binding work without duplicating SHA256-base64url logic.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/oauth.ts'));
    expect(p).toMatch(/import \{ verifyS256Challenge \} from '\.\.\/lib\/oauth-pkce\.js';/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/oauth-v667-service-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
