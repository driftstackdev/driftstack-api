// OpenAPI parity — OAuth 2.0 public-dance endpoints (V-667). The
// 4 standard-spec endpoints third-party clients use to obtain
// access tokens. Pinned so a future refactor can't drop them from
// the spec — generated SDKs would lose typed surfaces for the
// OAuth flow.
//
// V-824 — the line here used to say admin endpoints
// (/v1/admin/oauth/clients/*) are intentionally NOT in the spec because
// they are internal-only. THREE of them are in it, in the very spec file
// shipped inside the Python SDK package. The arm below derives that
// instead of asserting it, so whichever way the policy settles, the
// comment and the artifact cannot disagree again.
//
// The sibling claim — "the 4 standard-spec endpoints third-party clients
// use" — was checked and is CORRECT, though routes/oauth.ts registers
// five. `authorize/complete` is the dashboard's consent submission: it
// requires an interactive web session and explicitly refuses API keys, so
// a third-party client never calls it and an SDK-facing spec is right to
// omit it. Counting registered routes and expecting five here would have
// been a wrong fix that looked like a right one.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const OPENAPI_SRC = resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts');

/**
 * Admin-oauth paths that ARE published in the spec the SDKs consume.
 *
 * V-824 — the header comment said this set was empty and internal-only. It is
 * not. Recorded rather than silently accepted: publishing an admin surface in
 * an SDK-facing artifact is a decision, and it should be a visible one.
 */
const ADMIN_OAUTH_PUBLISHED: readonly string[] = [
  '/v1/admin/oauth/clients',
  '/v1/admin/oauth/clients/{id}',
  '/v1/admin/oauth/clients/{id}/rotate-secret',
];

describe('OpenAPI — OAuth 2.0 public dance endpoints', () => {
  const src = readFileSync(OPENAPI_SRC, 'utf8');

  it('registers GET /v1/oauth/authorize (PKCE stage)', () => {
    expect(src).toMatch(/method:\s*'get',\s*\n\s*path:\s*'\/v1\/oauth\/authorize'/);
  });

  it('registers POST /v1/oauth/token (code → access_token exchange)', () => {
    expect(src).toMatch(/method:\s*'post',\s*\n\s*path:\s*'\/v1\/oauth\/token'/);
  });

  it('registers POST /v1/oauth/introspect (RFC 7662)', () => {
    expect(src).toMatch(/method:\s*'post',\s*\n\s*path:\s*'\/v1\/oauth\/introspect'/);
  });

  it('registers POST /v1/oauth/revoke (RFC 7009)', () => {
    expect(src).toMatch(/method:\s*'post',\s*\n\s*path:\s*'\/v1\/oauth\/revoke'/);
  });

  it('authorize query schema requires PKCE S256 method (not "plain")', () => {
    expect(src).toMatch(/code_challenge_method:\s*z\.literal\('S256'\)/);
  });

  it('authorize state field bounded 8-256 chars (matches route validation)', () => {
    expect(src).toMatch(/state:\s*z\.string\(\)\.min\(8\)\.max\(256\)/);
  });

  it('keeps dashboard consent internal and documents its interactive-session boundary', () => {
    expect(src).toMatch(/requires an interactive web session and rejects API keys/);
    const slice = src.slice(
      src.indexOf('OAuth 2.0 public dance'),
      src.indexOf('RateLimitBucketOpenApi'),
    );
    expect(slice).not.toMatch(/path:\s*'\/v1\/oauth\/authorize\/complete'/);
  });

  it('token response declares Bearer + expires_in + scope array (RFC 6749 §5.1)', () => {
    expect(src).toMatch(
      /OAuthTokenResponseOpenApi[\s\S]{0,500}access_token[\s\S]{0,100}token_type:\s*z\.literal\('Bearer'\)[\s\S]{0,100}expires_in[\s\S]{0,100}scope:\s*z\.array/,
    );
  });

  it('introspect response is a discriminated union (active=false | active=true+metadata)', () => {
    expect(src).toMatch(
      /OAuthIntrospectResponseOpenApi[\s\S]{0,800}z\.literal\(false\)[\s\S]{0,400}z\.literal\(true\)/,
    );
  });

  it('introspection and revocation require bounded confidential-client credentials', () => {
    expect(src).toMatch(
      /OAuthIntrospectRequestOpenApi[\s\S]{0,350}client_id: z\.string\(\)\.min\(1\)\.max\(128\)[\s\S]{0,150}client_secret: z\.string\(\)\.min\(1\)\.max\(256\)/,
    );
    expect(src).toMatch(
      /OAuthRevokeRequestOpenApi[\s\S]{0,350}client_id: z\.string\(\)\.min\(1\)\.max\(128\)[\s\S]{0,150}client_secret: z\.string\(\)\.min\(1\)\.max\(256\)/,
    );
  });

  it('revoke documents authenticated always-200 anti-enumeration and 401 bad credentials', () => {
    expect(src).toMatch(/For an authenticated client, always 200 whether its token was revoked/);
    expect(src).toMatch(/401: \{ description: 'Invalid or revoked client credentials\.'/);
  });

  it('all 4 endpoints tagged "oauth" (consistent grouping for the Scalar UI)', () => {
    const slice = src.slice(
      src.indexOf('OAuth 2.0 public dance'),
      src.indexOf('RateLimitBucketOpenApi'),
    );
    const tagOccurrences = (slice.match(/tags:\s*\['oauth'\]/g) ?? []).length;
    expect(tagOccurrences).toBe(4);
  });

  it('no admin endpoints leak into the public spec (/v1/admin/oauth/clients/* stays internal)', () => {
    // Sanity: the registration block must NOT include the admin
    // clients path family. (The admin routes are still registered
    // on the Fastify app — they're just not in the customer-facing
    // OpenAPI surface.)
    const slice = src.slice(
      src.indexOf('OAuth 2.0 public dance'),
      src.indexOf('RateLimitBucketOpenApi'),
    );
    expect(slice.includes('/v1/admin/oauth/clients')).toBe(false);
  });

  // V-824 — derived, in the direction the prose got wrong.
  it('V-824 CRITICAL the admin-oauth spec posture matches what the comment claims. The header asserted these are withheld as internal-only; three are published in the spec that ships inside the Python SDK package. Deriving it means the claim and the artifact cannot drift apart again — if the policy is that they stay published, the roster below records it; if they should be withheld, this fails until they are.', () => {
    const spec = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'packages/sdk-python/openapi.json'), 'utf8'),
    ) as { paths: Record<string, unknown> };
    const published = Object.keys(spec.paths);
    expect(published.length, 'paths parsed out of the published spec').toBeGreaterThan(100);

    const adminOauth = published.filter((p) => p.startsWith('/v1/admin/oauth/')).sort();
    expect(
      adminOauth,
      'admin-oauth paths in the shipped spec — the header comment describes this set, so they must agree:',
    ).toEqual(ADMIN_OAUTH_PUBLISHED);
  });
});
