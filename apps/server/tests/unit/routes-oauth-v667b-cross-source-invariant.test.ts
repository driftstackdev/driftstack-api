// W1045 — routes/oauth V-667.B + V-667.C/D/E cross-source invariant.
// Pins the apps/server/src/routes/oauth.ts OAuth 2.0 server surface
// (Driftstack-AS-OAuth-server; the Driftstack-AS-OAuth-client slice
// for social-login is Track C and not yet wired).
//
//   V-667.B anchor — 'V-667.B — OAuth 2.0 Fastify route layer'.
//
//   Admin endpoint roster (auth-gated):
//     POST   /v1/admin/oauth/clients         — register
//     GET    /v1/admin/oauth/clients         — list
//     DELETE /v1/admin/oauth/clients/:id     — revoke
//
//   OAuth provider surface (no account auth; confidential-client
//   credentials protect token exchange and lifecycle calls):
//     GET    /v1/oauth/authorize             — stage authorization
//     POST   /v1/oauth/token                 — code → access_token
//     POST   /v1/oauth/introspect            — token validation
//
//   Interactive dashboard consent (web session + account limiter):
//     POST   /v1/oauth/authorize/complete    — approval
//
//   V-667.C RFC 7009 revoke — accepts token_type_hint informationally.
//
//   V-667.D single-client lookup endpoint.
//
//   V-667.E rotate-secret endpoint with plaintext-returned-once.
//
//   AuthorizeQuery PKCE constraints — code_challenge len 43..128,
//   code_challenge_method literal 'S256', state len 8..256.
//
//   Public client list never exposes hashed secrets.
//
// stays in lockstep across apps/server/src/routes/oauth.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  return readFileSync(p, 'utf8');
}

describe('W1045 routes/oauth V-667.B + V-667.C/D/E cross-source invariant', () => {
  // ─── V-667.B anchor ──────────────────────────────────────────

  it("CRITICAL V-667.B anchor — 'V-667.B — OAuth 2.0 Fastify route layer'. The single-anchor design ties the route to the OAuth-server slice (distinct from V-667 OAuth-client which is Track C / not yet wired).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/oauth.ts'));
    expect(p).toMatch(/V-667\.B — OAuth 2\.0 Fastify route layer\./);
  });

  // ─── Endpoint roster ─────────────────────────────────────────

  it("CRITICAL admin endpoint roster (3 + 2 supplemental) — POST/GET/DELETE /v1/admin/oauth/clients + GET /v1/admin/oauth/clients/:id (V-667.D) + POST /v1/admin/oauth/clients/:id/rotate-secret (V-667.E). The admin surface is auth-gated by 'driftstack_internal_admin'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/oauth.ts'));
    expect(p).toMatch(/POST\s+\/v1\/admin\/oauth\/clients\s+— register/);
    expect(p).toMatch(/GET\s+\/v1\/admin\/oauth\/clients\s+— list/);
    expect(p).toMatch(/DELETE \/v1\/admin\/oauth\/clients\/:id\s+— revoke/);
    expect(p).toMatch(/'\/v1\/admin\/oauth\/clients\/:id\/rotate-secret'/);
  });

  it('CRITICAL public provider roster and separately web-session-gated consent completion', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/oauth.ts'));
    expect(p).toMatch(
      /OAuth provider surface \(no account auth; client credentials protect\s*\/\/\s*token exchange, introspection, and revocation\)/,
    );
    expect(p).toMatch(/GET\s+\/v1\/oauth\/authorize\s+— stage authorization/);
    expect(p).toMatch(/POST\s+\/v1\/oauth\/token\s+— code → access_token/);
    expect(p).toMatch(/POST\s+\/v1\/oauth\/introspect\s+— token validation/);
    expect(p).toMatch(/'\/v1\/oauth\/revoke'/);
    expect(p).toMatch(/Interactive dashboard consent \(web-session \+ account-rate-limit gated\)/);
    expect(p).toMatch(
      /'\/v1\/oauth\/authorize\/complete',[\s\S]{0,100}preHandler: \[app\.requireAuth, app\.rateLimit\('global'\)\]/,
    );
  });

  // ─── Admin scope on every admin route ────────────────────────

  it('CRITICAL driftstack_internal_admin scope on every admin OAuth route. Drift to a different scope would silently let normal customer keys register OAuth clients.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/oauth.ts'));
    const refs = p.match(/preHandler: \[app\.requireScope\('driftstack_internal_admin'\)\]/g) ?? [];
    // 5 admin endpoints: register / list / get-by-id / delete / rotate-secret
    expect(refs.length, 'admin OAuth scope chain count').toBeGreaterThanOrEqual(5);
  });

  // ─── AuthorizeQuery PKCE constraints ─────────────────────────

  it("CRITICAL AuthorizeQuery PKCE constraints — code_challenge len 43..128, code_challenge_method literal 'S256', state len 8..256. The RFC 7636 floor (43) + ceiling (128) match the spec.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/oauth.ts'));
    expect(p).toMatch(/state: z\.string\(\)\.min\(8\)\.max\(256\),/);
    expect(p).toMatch(/code_challenge: z\.string\(\)\.min\(43\)\.max\(128\),/);
    expect(p).toMatch(/code_challenge_method: z\.literal\('S256'\),/);
  });

  // ─── ExchangeCodeBody ────────────────────────────────────────

  it("CRITICAL ExchangeCodeBody — grant_type literal 'authorization_code' + code + code_verifier len 43..128 + client_id + client_secret + redirect_uri. The 6-field shape matches the RFC 6749 token-endpoint POST. Slice 117 added max-length caps (256/128/256) on the previously-unbounded code/client_id/client_secret fields to prevent problem+json body bloat.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/oauth.ts'));
    expect(p).toMatch(/grant_type: z\.literal\('authorization_code'\),/);
    expect(p).toMatch(/code: z\.string\(\)\.min\(1\)\.max\(256\),/);
    expect(p).toMatch(/code_verifier: z\.string\(\)\.min\(43\)\.max\(128\),/);
    expect(p).toMatch(/client_id: z\.string\(\)\.min\(1\)\.max\(128\),/);
    expect(p).toMatch(/client_secret: z\.string\(\)\.min\(1\)\.max\(256\),/);
    expect(p).toMatch(/redirect_uri: z\.string\(\)\.max\(2048\)\.url\(\),/);
  });

  // ─── RegisterClientBody ──────────────────────────────────────

  it("CRITICAL RegisterClientBody — label 1..120 chars + 1..10 redirect_uris + optional account_id nullable. The 1..10 redirect-uri cap balances 'enterprise customer needs multiple envs' against attack surface.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/oauth.ts'));
    expect(p).toMatch(/label: z\.string\(\)\.min\(1\)\.max\(120\),/);
    expect(p).toMatch(
      /redirect_uris: z\.array\(z\.string\(\)\.max\(2048\)\.url\(\)\)\.min\(1\)\.max\(10\),/,
    );
    expect(p).toMatch(/account_id: z\.string\(\)\.uuid\(\)\.nullable\(\)\.optional\(\),/);
  });

  // ─── V-667.C revoke (RFC 7009) ───────────────────────────────

  it("CRITICAL V-667.C RFC 7009 revoke framing — 'token_type_hint is informational (access_token | refresh_token); we ignore it but accept it so off-the-shelf OAuth clients can post unchanged'. The accept-but-ignore is the RFC-conformant tolerance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/oauth.ts'));
    expect(p).toMatch(/V-667\.C — RFC 7009 revoke\. token_type_hint is informational/);
    expect(p).toMatch(/\(access_token \| refresh_token\); we ignore it but accept it so/);
    expect(p).toMatch(/off-the-shelf OAuth clients can post unchanged\./);
    expect(p).toMatch(
      /token_type_hint: z\.enum\(\['access_token', 'refresh_token'\]\)\.optional\(\),/,
    );
    expect(p).toMatch(/await deps\.service\.revokeTokenForClient\(body\);/);
    expect(p).toMatch(/await deps\.service\.introspectForClient\(body\);/);
  });

  // ─── V-667.D single-client lookup ────────────────────────────

  it("CRITICAL V-667.D single-client lookup — 'Returns 404 when the client doesn't exist, the full envelope (minus the hashed secret) when it does. Revoked clients are returned with their revoked_at populated so ops can audit who/when revoked'. The revoked-but-returned posture is what makes the audit-via-API workable.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/oauth.ts'));
    expect(p).toMatch(/V-667\.D — single-client lookup for the founder admin UI\./);
    expect(p).toMatch(/Returns\s*\/\/\s*404 when the client doesn't exist/);
    expect(p).toMatch(/Revoked clients are returned with/);
    expect(p).toMatch(/their revoked_at populated so ops can audit "who\/when revoked\."/);
  });

  // ─── V-667.E rotate-secret ───────────────────────────────────

  it('CRITICAL V-667.E rotation preserves bearer tokens but requires the successor secret for token lifecycle endpoints', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/oauth.ts'));
    expect(p).toMatch(/V-667\.E — rotate the client_secret in place\. Returns the new/);
    expect(p).toMatch(/plaintext ONCE \(the store keeps only the hash\)\. Existing access/);
    expect(p).toMatch(/tokens are NOT invalidated \(they remain bearer-authenticated\), but/);
    expect(p).toMatch(/new secret is required for token exchange\/introspection\/revoke\./);
  });

  // ─── Client list envelope (no hashed-secret leak) ────────────

  it("CRITICAL admin client-list envelope — 6 fields (client_id / label / redirect_uris / account_id / created_at ISO / revoked_at ISO|null). Explicitly excludes the hashed secret — 'Never expose the hashed secret to the admin UI; it's internal'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/oauth.ts'));
    expect(p).toMatch(/Never expose the hashed secret to the admin UI; it's internal\./);
    expect(p).toMatch(/client_id: c\.client_id,/);
    expect(p).toMatch(/label: c\.label,/);
    expect(p).toMatch(/redirect_uris: c\.redirect_uris,/);
    expect(p).toMatch(/account_id: c\.account_id,/);
    expect(p).toMatch(/created_at: new Date\(c\.created_at\)\.toISOString\(\),/);
    expect(p).toMatch(
      /revoked_at: c\.revoked_at !== null \? new Date\(c\.revoked_at\)\.toISOString\(\) : null,/,
    );
  });

  // ─── Delete returns 204 No Content ───────────────────────────

  it('CRITICAL revokeClient → 204 No Content. The RFC-conformant idempotent-delete response.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/oauth.ts'));
    expect(p).toMatch(/await deps\.service\.revokeClient\(req\.params\.id\);/);
    expect(p).toMatch(/return reply\.code\(204\)\.send\(\);/);
  });

  // ─── /authorize/complete account-context note ────────────────

  it('CRITICAL /authorize/complete rejects general API keys and requires interactive dashboard context', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/oauth.ts'));
    expect(p).toMatch(/Account context for \/authorize\/complete comes only from the dashboard's/);
    expect(p).toMatch(/interactive web session\. General API keys are rejected/);
    expect(p).toMatch(/if \(ctx\.webSession === null\)/);
  });
});
