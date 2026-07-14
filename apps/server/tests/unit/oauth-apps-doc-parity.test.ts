// W214.B — drift-guard between the /docs/oauth-apps marketing page
// and the actual `api_key_scope` Postgres enum. Every scope listed in
// the doc MUST exist in the enum, or OAuth requests for it fail with
// `invalid_scope` at /v1/oauth/authorize.
//
// Also pins the doc's claims about the OAuth endpoint paths + token
// lifetime + id prefixes to the source.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'docs', 'oauth-apps.astro');
const SCHEMA_PATH = join(REPO, 'apps', 'server', 'src', 'db', 'schema.ts');
const OAUTH_SVC_PATH = join(REPO, 'apps', 'server', 'src', 'services', 'oauth.ts');
const OAUTH_ROUTES_PATH = join(REPO, 'apps', 'server', 'src', 'routes', 'oauth.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function enumScopes(): string[] {
  const schema = read(SCHEMA_PATH);
  const block = schema.split("pgEnum('api_key_scope', [")[1]!.split(']')[0]!;
  return Array.from(block.matchAll(/'([^']+)'/g)).map((m) => m[1]!);
}

function docScopes(): string[] {
  const doc = read(DOC_PATH);
  return Array.from(doc.matchAll(/\{ name: '([^']+)',/g)).map((m) => m[1]!);
}

function serviceOAuthScopes(): string[] {
  const service = read(OAUTH_SVC_PATH);
  const block = service
    .split('const OAUTH_ALLOWED_SCOPES: ReadonlySet<ApiKeyScope> = new Set([')[1]!
    .split('] as ApiKeyScope[])')[0]!;
  return Array.from(block.matchAll(/'([^']+)'/g)).map((match) => match[1]!);
}

describe('W214.B oauth-apps doc parity', () => {
  it('every scope listed in /docs/oauth-apps exists in the api_key_scope enum', () => {
    const allowed = new Set(enumScopes());
    const listed = docScopes();
    expect(listed.length, 'doc must list at least one scope').toBeGreaterThan(0);
    const offenders = listed.filter((s) => !allowed.has(s));
    expect(offenders).toEqual([]);
  });

  it('the service allowlist exactly matches the curated integrator scope table', () => {
    expect(serviceOAuthScopes()).toEqual(docScopes());
  });

  it('doc does not list the fictional read:recordings scope', () => {
    expect(docScopes()).not.toContain('read:recordings');
  });

  it('doc does not expose internal-only scopes to OAuth integrators', () => {
    const listed = new Set(docScopes());
    // These exist in the enum but should not be requestable via the
    // OAuth flow — they belong to API-keys / staff / dashboard.
    for (const internalOnly of [
      'read',
      'write',
      'admin',
      'account_owner',
      'driftstack_internal_admin',
      'gui_control',
    ]) {
      expect(listed.has(internalOnly)).toBe(false);
    }
  });

  it('token TTL claim (1 hour) matches TOKEN_TTL_SECONDS', () => {
    const m = read(OAUTH_SVC_PATH).match(/TOKEN_TTL_SECONDS\s*=\s*([^;]+);/);
    expect(m).not.toBeNull();
    // 60 * 60 → 3600. Verify the doc shows that number.
    expect(read(DOC_PATH)).toMatch(/"expires_in":\s*3600/);
    expect(read(DOC_PATH)).toMatch(/one hour/i);
  });

  it('OAuth endpoints in the doc match the route registrations', () => {
    const routes = read(OAUTH_ROUTES_PATH);
    const doc = read(DOC_PATH);
    for (const path of [
      '/v1/oauth/authorize',
      '/v1/oauth/token',
      '/v1/oauth/introspect',
      '/v1/oauth/revoke',
    ]) {
      expect(routes, `route registration missing for ${path}`).toContain(`'${path}'`);
      expect(doc, `doc must reference ${path}`).toContain(path);
    }
  });

  it('id-prefix claims match the service constants', () => {
    const svc = read(OAUTH_SVC_PATH);
    const doc = read(DOC_PATH);
    expect(svc).toMatch(/`oac_\$\{randomBytes/);
    expect(svc).toMatch(/`oas_\$\{randomBytes/);
    expect(svc).toMatch(/`oat_\$\{randomBytes/);
    expect(doc).toMatch(/\boac_/);
    expect(doc).toMatch(/\boas_/);
    expect(doc).toMatch(/\boat_/);
  });
});
