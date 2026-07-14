// W403.B — drift guard for apps/server/src/services/oauth.ts.
// V-667 OAuth 2.0 authorization-code flow (invite-only v1). Builds
// on V-488 PKCE. Opaque-bearer tokens per D-2026-05-10-01 (no JWT,
// no refresh). Drift here either lets a code be exchanged twice
// (token re-mint) or bypasses PKCE S256-only enforcement (PKCE
// downgrade attack surface).
//
//   • V-667 framing: 5-step flow (admin-register → /authorize →
//     dashboard-approve → redirect with code+state → /token exchange
//     with code_verifier+client_secret).
//   • D-2026-05-10-01 framing pinned: opaque bearer (no JWT) + RFC
//     7009 revoke / introspect surface + no refresh tokens v1.
//   • CODE_TTL_SECONDS = 5*60; TOKEN_TTL_SECONDS = 60*60 (1h short-
//     by-design).
//   • OAuthClient: 7 fields with client_secret_hash (sha256 hex —
//     never the secret) + redirect_uris readonly + account_id?
//     nullable + revoked_at nullable.
//   • AuthorizationCode: 9 fields with consumed_at nullable
//     (once-only second-call → invalid_grant).
//   • AccessToken: 6 fields with created_at + expires_at.
//   • InMemoryOAuthStore: in-memory test seam; getCode/getToken
//     self-evict on TTL expiry.
//   • OAuthError: 6-code RFC-shaped union (invalid_client /
//     invalid_request / unauthorized_client / access_denied /
//     invalid_grant / invalid_scope).
//   • authorize: code_challenge_method=S256 enforced (downgrade
//     reject); exact-match redirect_uri check; pendingAuthorizations
//     in-memory staging.
//   • authorize/approveAuthorization retain the exact curated third-party
//     scope allowlist; broad/deprecated/new API-key scopes fail closed.
//   • Approval: pending read + transactional replace with one code +
//     5-min TTL recheck + hierarchical scope reduction.
//   • authenticateClient: shared client_secret_hash timing-safe equality;
//     consumed_at !== null → invalid_grant; client_id-mismatch
//     guard; redirect_uri-mismatch guard; verifyS256Challenge call;
//     atomic code-consume + authority/token insert; token mint with oat_ prefix.
//   • V-667.E rotateClientSecret: invalid_client on unknown or
//     revoked; same client_id retained.
//   • RFC 7662/7009 lifecycle calls authenticate and bind the live
//     client; foreign/unknown tokens collapse to minimal responses.
//   • isAllowedRedirectUri: bounded HTTPS or localhost HTTP, with
//     fragment/userinfo refusal (RFC 6749/8252).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/oauth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W403.B apps/server/src/services/oauth.ts content parity', () => {
  const body = read(LIB);

  it('V-667 framing pinned: invite-only v1 + 5-step flow + V-488 PKCE primitives', () => {
    expect(body).toMatch(/V-667 — OAuth 2\.0 authorization-code flow service \(invite-only v1\)\./);
    expect(body).toMatch(/Builds on V-488's PKCE primitives\./);
  });

  it('D-2026-05-10-01 framing pinned: opaque bearer (no JWT) + no refresh tokens v1 + ApiKeyScope subset', () => {
    expect(body).toMatch(
      /Tokens are OPAQUE bearer strings \(no JWT — D-2026-05-10-01 decision\)\./,
    );
    expect(body).toMatch(
      /No refresh\s*\n?\s*\/\/\s*tokens v1 — the third-party re-prompts the customer if their access\s*\n?\s*\/\/\s*token expires\./,
    );
    expect(body).toMatch(/scopes are a subset of `ApiKeyScope`\./);
  });

  it('CODE_TTL_SECONDS = 5*60 + TOKEN_TTL_SECONDS = 60*60 (1h short-by-design)', () => {
    expect(body).toMatch(/const CODE_TTL_SECONDS = 5 \* 60;/);
    expect(body).toMatch(
      /const TOKEN_TTL_SECONDS = 60 \* 60; \/\/ 1 hour — short by design; no refresh tokens\./,
    );
  });

  it('OAuthClient: 7 fields with client_secret_hash framed sha256-hex-never-secret + redirect_uris readonly[] + revoked_at nullable', () => {
    expect(body).toMatch(/export interface OAuthClient \{/);
    expect(body).toMatch(/client_id: string;/);
    expect(body).toMatch(
      /\/\*\* sha256 hex of the secret — never the secret itself in the store\. \*\/\s*\n?\s*client_secret_hash: string;/,
    );
    expect(body).toMatch(
      /\/\*\* Allowed redirect URIs\. Exact-match check on \/authorize\. \*\/\s*\n?\s*redirect_uris: readonly string\[\];/,
    );
    expect(body).toMatch(/label: string;/);
    expect(body).toMatch(/account_id: string \| null;/);
    expect(body).toMatch(/created_at: number;/);
    expect(body).toMatch(
      /\/\*\* Soft-deleted clients reject authorize, token, introspection, and revocation\. \*\/\s*\n?\s*revoked_at: number \| null;/,
    );
  });

  it('AuthorizationCode: 9 fields with consumed_at once-only invariant (second-exchange → invalid_grant)', () => {
    expect(body).toMatch(/export interface AuthorizationCode \{/);
    expect(body).toMatch(/code: string;/);
    expect(body).toMatch(/code_challenge: string;/);
    expect(body).toMatch(
      /\/\*\* Once-only: set on exchange\. Second exchange returns invalid_grant\. \*\/\s*\n?\s*consumed_at: number \| null;/,
    );
  });

  it('OAuthError: 6-code union (invalid_client / invalid_request / unauthorized_client / access_denied / invalid_grant / invalid_scope)', () => {
    expect(body).toMatch(/export class OAuthError extends Error \{/);
    expect(body).toMatch(
      /public readonly code:\s*\n?\s*\| 'invalid_client'\s*\n?\s*\| 'invalid_request'\s*\n?\s*\| 'unauthorized_client'\s*\n?\s*\| 'access_denied'\s*\n?\s*\| 'invalid_grant'\s*\n?\s*\| 'invalid_scope',/,
    );
    expect(body).toMatch(/this\.name = 'OAuthError';/);
  });

  it('OAuthStore: client + persistent-consent + code + token authority methods are explicit', () => {
    expect(body).toMatch(/export interface OAuthStore \{/);
    expect(body).toMatch(/insertClient\(client: OAuthClient\): Promise<void>;/);
    expect(body).toMatch(/getClient\(client_id: string\): Promise<OAuthClient \| null>;/);
    expect(body).toMatch(/listClients\(\): Promise<readonly OAuthClient\[\]>;/);
    expect(body).toMatch(/revokeClient\(client_id: string, at: number\): Promise<void>;/);
    expect(body).toMatch(/atomically swap `client_secret_hash` only while the client/);
    expect(body).toMatch(/part of the same conditional UPDATE as the hash swap/);
    expect(body).toMatch(
      /rotateClientSecretHash\(client_id: string, new_hash: string\): Promise<boolean>;/,
    );
    expect(body).toMatch(
      /insertAuthorization\(authorization: PendingAuthorization\): Promise<void>;/,
    );
    expect(body).toMatch(
      /getAuthorization\(authorization_id: string\): Promise<PendingAuthorization \| null>;/,
    );
    expect(body).toMatch(/consumeAuthorizationForCode\(args: \{/);
    expect(body).toMatch(
      /'inserted' \| 'expired' \| 'unavailable' \| 'client_unavailable' \| 'account_mismatch'/,
    );
    expect(body).toMatch(/getCode\(code: string\): Promise<AuthorizationCode \| null>;/);
    expect(body).toMatch(/consumeCodeForToken\(args: \{/);
    expect(body).toMatch(/expectedClientSecretHash: string;/);
    expect(body).toMatch(/performs all four changes in one transaction/);
    expect(body).toMatch(/getToken\(token: string\): Promise<AccessToken \| null>;/);
    expect(body).toMatch(/revokeToken\(token: string\): Promise<void>;/);
    expect(body).toMatch(
      /findTokenForAuthentication\(token: string, now: number\): Promise<AccessToken \| null>;/,
    );
  });

  it('InMemoryOAuthStore: getCode self-evict on TTL expiry; getToken self-evict on expires_at', () => {
    expect(body).toMatch(
      /if \(Date\.now\(\) - c\.created_at > CODE_TTL_SECONDS \* 1000\) \{\s*\n?\s*this\.codes\.delete\(code\);\s*\n?\s*return null;/,
    );
    expect(body).toMatch(
      /if \(Date\.now\(\) > t\.expires_at\) \{\s*\n?\s*this\.tokens\.delete\(token\);\s*\n?\s*return null;/,
    );
  });

  it('registerClient: empty-label + empty-redirect-uris + invalid-redirect-uri all → invalid_request; client_id=oac_ + client_secret=oas_ base64url prefix', () => {
    expect(body).toMatch(
      /if \(!args\.label\.trim\(\)\) throw new OAuthError\('invalid_request', 'label required'\);/,
    );
    expect(body).toMatch(
      /if \(args\.redirect_uris\.length === 0\) \{\s*\n?\s*throw new OAuthError\('invalid_request', 'at least one redirect_uri required'\);/,
    );
    expect(body).toMatch(
      /if \(uri\.length > MAX_REDIRECT_URI_LENGTH \|\| !isAllowedRedirectUri\(uri\)\) \{[\s\S]{0,260}throw new OAuthError\('invalid_request', 'redirect_uri rejected'\);/,
    );
    expect(body).toMatch(
      /const client_id = `oac_\$\{randomBytes\(12\)\.toString\('base64url'\)\}`;/,
    );
    expect(body).toMatch(
      /const client_secret = `oas_\$\{randomBytes\(32\)\.toString\('base64url'\)\}`;/,
    );
  });

  it('authorize: S256-only enforced (downgrade reject); invalid_client on revoked; exact-match redirect_uris.includes', () => {
    expect(body).toMatch(
      /if \(args\.code_challenge_method !== 'S256'\) \{\s*\n?\s*throw new OAuthError\('invalid_request', 'only S256 PKCE is supported'\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /if \(client === null \|\| client\.revoked_at !== null\) \{\s*\n?\s*throw new OAuthError\('invalid_client', 'unknown or revoked client_id'\);/,
    );
    expect(body).toMatch(
      /if \(!client\.redirect_uris\.includes\(args\.redirect_uri\)\) \{\s*\n?\s*throw new OAuthError\('invalid_request', 'redirect_uri not registered'\);/,
    );
    expect(body).toMatch(
      /const authorization_id = `oaa_\$\{randomBytes\(16\)\.toString\('base64url'\)\}`;/,
    );
    expect(body).toMatch(/const OAUTH_ALLOWED_SCOPES: ReadonlySet<ApiKeyScope> = new Set\(\[/);
    expect(body).toMatch(
      /if \(args\.scope\.some\(\(scope\) => !OAUTH_ALLOWED_SCOPES\.has\(scope\)\)\) \{\s*\n?\s*throw new OAuthError\('invalid_scope', 'scope is not available to OAuth clients'\);/,
    );
  });

  it('approveAuthorization: atomic persistent authorization-to-code commit + TTL recheck + hierarchical scope reduction', () => {
    expect(body).toMatch(
      /const pending = await this\.store\.getAuthorization\(args\.authorization_id\);/,
    );
    expect(body).toMatch(
      /if \(pending === null\) \{\s*\n?\s*throw new OAuthError\('invalid_request', 'unknown or expired authorization_id'\);/,
    );
    expect(body).toMatch(
      /if \(this\.nowFn\(\) - pending\.created_at > CODE_TTL_SECONDS \* 1000\) \{\s*\n?\s*throw new OAuthError\('invalid_request', 'authorization expired before approval'\);/,
    );
    expect(body).toMatch(/import \{ scopesSatisfy \} from '\.\.\/lib\/errors-helpers\.js';/);
    expect(body).toMatch(
      /OAUTH_ALLOWED_SCOPES\.has\(s\) &&\s*\n?\s*\(approverScopes === undefined \|\| scopesSatisfy\(approverScopes, s\)\)/,
    );
    expect(body).toMatch(/const code = `oac_\$\{randomBytes\(32\)\.toString\('base64url'\)\}`;/);
    expect(body).toMatch(/this\.store\.consumeAuthorizationForCode\(\{/);
    expect(body).toMatch(/if \(committed === 'unavailable'\) \{/);
    expect(body).toMatch(/if \(committed === 'client_unavailable'\) \{/);
    expect(body).toMatch(
      /if \(committed === 'account_mismatch'\) \{\s*\n?\s*throw new OAuthError\('access_denied', 'client is not registered for this account'\);/,
    );
  });

  it('exchangeCode delegates shared constant-time client authentication and preserves grant invariants', () => {
    expect(body).toMatch(
      /const \{ client, presentedSecretHash \} = await this\.authenticateClient\(args\);/,
    );
    expect(body).toMatch(
      /if \(code === null\) throw new OAuthError\('invalid_grant', 'code unknown or expired'\);/,
    );
    expect(body).toMatch(
      /if \(code\.consumed_at !== null\) \{\s*\n?\s*throw new OAuthError\('invalid_grant', 'code already exchanged'\);/,
    );
    expect(body).toMatch(
      /if \(code\.client_id !== args\.client_id\) \{\s*\n?\s*throw new OAuthError\('invalid_grant', 'code issued to a different client'\);/,
    );
    expect(body).toMatch(
      /if \(code\.redirect_uri !== args\.redirect_uri\) \{\s*\n?\s*throw new OAuthError\('invalid_grant', 'redirect_uri mismatch'\);/,
    );
    expect(body).toMatch(
      /if \(!verifyS256Challenge\(\{ verifier: args\.code_verifier, challenge: code\.code_challenge \}\)\) \{\s*\n?\s*throw new OAuthError\('invalid_grant', 'PKCE verification failed'\);/,
    );
    expect(body).toMatch(/this\.store\.consumeCodeForToken\(\{/);
    expect(body).toMatch(/consumed_at: now,/);
    expect(body).toMatch(/expectedClientSecretHash: presentedSecretHash,/);
    expect(body).toMatch(
      /if \(committed === 'client_authority_changed'\) \{\s*\n?\s*throw new OAuthError\('invalid_client', 'unknown or revoked client_id'\);/,
    );
    expect(body).toMatch(/const token = `oat_\$\{randomBytes\(32\)\.toString\('base64url'\)\}`;/);
  });

  it('V-667.E rotateClientSecret: invalid_client on unknown OR revoked; client_id stays same', () => {
    expect(body).toMatch(
      /V-667\.E — rotate the client_secret in place\. Returns the NEW\s*\n?\s*\*\s*plaintext \(shown ONCE — the store keeps only the hash\)\. The\s*\n?\s*\*\s*client_id stays the same so existing redirect URIs \+ customer\s*\n?\s*\*\s*consent records carry over\./,
    );
    expect(body).toMatch(
      /const rotated = await this\.store\.rotateClientSecretHash\(\s*\n?\s*client_id,\s*\n?\s*this\.secretHasher\(client_secret\),\s*\n?\s*\);\s*\n?\s*if \(!rotated\) throw new OAuthError\('invalid_client', 'unknown or revoked client_id'\);/,
    );
  });

  it('RFC 7662/7009 authenticate before lookup, bind exact client ownership, and keep foreign/unknown responses minimal', () => {
    expect(body).toMatch(
      /async introspectForClient\(args: ClientTokenArgs\): Promise<AccessToken \| null> \{\s*const \{ client \} = await this\.authenticateClient\(args\);\s*const token = await this\.store\.getToken\(args\.token\);\s*return token\?\.client_id === client\.client_id \? token : null;/,
    );
    expect(body).toMatch(
      /async revokeTokenForClient\(args: ClientTokenArgs\): Promise<void> \{\s*const \{ client \} = await this\.authenticateClient\(args\);\s*const token = await this\.store\.getToken\(args\.token\);\s*if \(token\?\.client_id === client\.client_id\) \{\s*await this\.store\.revokeToken\(args\.token\);/,
    );
    expect(body).toMatch(
      /const expectedSecretHash = client\?\.client_secret_hash \?\? presentedSecretHash;\s*const secretMatches = constantTimeStringEqual\(expectedSecretHash, presentedSecretHash\);\s*if \(client === null \|\| client\.revoked_at !== null \|\| !secretMatches\) \{\s*throw new OAuthError\('invalid_client', 'invalid client credentials'\);/,
    );
  });

  it('isAllowedRedirectUri: bounded safe HTTPS or localhost HTTP without fragment/userinfo', () => {
    expect(body).toMatch(/const MAX_REDIRECT_URI_LENGTH = 2048;/);
    expect(body).toMatch(
      /const u = new URL\(uri\);\s*\n?\s*if \(u\.username !== '' \|\| u\.password !== '' \|\| u\.hash !== ''\) return false;\s*\n?\s*if \(u\.protocol === 'https:'\) return true;/,
    );
    expect(body).toMatch(
      /u\.protocol === 'http:' && \(u\.hostname === 'localhost' \|\| u\.hostname === '127\.0\.0\.1'\)/,
    );
  });

  it('Helpers: sha256Hex (default secretHasher) + constantTimeStringEqual (length-check + timingSafeEqual)', () => {
    expect(body).toMatch(
      /function sha256Hex\(s: string\): string \{\s*\n?\s*return createHash\('sha256'\)\.update\(s\)\.digest\('hex'\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /function constantTimeStringEqual\(a: string, b: string\): boolean \{\s*\n?\s*if \(a\.length !== b\.length\) return false;\s*\n?\s*return timingSafeEqual\(Buffer\.from\(a\), Buffer\.from\(b\)\);\s*\n?\s*\}/,
    );
  });

  it('imports: createHash+randomBytes+timingSafeEqual from node:crypto + ApiKeyScope + verifyS256Challenge from oauth-pkce', () => {
    expect(body).toMatch(
      /import \{ createHash, randomBytes, timingSafeEqual \} from 'node:crypto';/,
    );
    expect(body).toMatch(/import type \{ ApiKeyScope \} from '@driftstack\/api-types';/);
    expect(body).toMatch(/import \{ verifyS256Challenge \} from '\.\.\/lib\/oauth-pkce\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
