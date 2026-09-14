// OpenAPI parity — OAuth-client IDP signin endpoints (V-667.C).
// /start + /confirm-merge are the customer-facing endpoints for
// dashboard sign-in-with-Google/GitHub; /redeem (2026-09-11) is the
// cookie-free hand-off step the SPA POSTs after the top-level IDP
// callback 302s it a single-use code. The per-provider IDP-redirect
// target is intentionally NOT in the customer spec (no client posts to
// it directly), and the v1 XHR exchange GET /v1/auth/oauth-client/callback
// was retired 2026-09-14 with the PKCE cookie, so no oauth-client
// operation documents a Set-Cookie header any more.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const OPENAPI_SRC = resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts');
const PUBLISHED_SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');

interface SpecShape {
  components?: { schemas?: Record<string, unknown> };
  paths: Record<
    string,
    Record<
      string,
      {
        requestBody?: { content?: Record<string, { schema?: Record<string, unknown> }> };
        responses?: Record<
          string,
          {
            headers?: Record<string, unknown>;
            content?: Record<string, { schema?: Record<string, unknown> }>;
          }
        >;
      }
    >
  >;
}

/** Resolve one level of `$ref` against `components.schemas`. */
function deref(doc: SpecShape, node: Record<string, unknown> | undefined, depth = 0): unknown {
  if (node === undefined || depth > 4) return undefined;
  const ref = node['$ref'];
  if (typeof ref === 'string') {
    const name = ref.split('/').pop() ?? '';
    return deref(doc, doc.components?.schemas?.[name] as Record<string, unknown>, depth + 1);
  }
  return node;
}

describe('OpenAPI — OAuth-client IDP signin endpoints (V-667.C)', () => {
  const src = readFileSync(OPENAPI_SRC, 'utf8');

  it('registers POST /v1/auth/oauth-client/start (returns authorize URL)', () => {
    expect(src).toMatch(/method:\s*'post',\s*\n\s*path:\s*'\/v1\/auth\/oauth-client\/start'/);
  });

  it('registers POST /v1/auth/oauth-client/confirm-merge (same-email collision resolution)', () => {
    expect(src).toMatch(
      /method:\s*'post',\s*\n\s*path:\s*'\/v1\/auth\/oauth-client\/confirm-merge'/,
    );
  });

  it('registers POST /v1/auth/oauth-client/redeem (v2 hand-off: code + flow_secret, both 43-char base64url)', () => {
    expect(src).toMatch(/method:\s*'post',\s*\n\s*path:\s*'\/v1\/auth\/oauth-client\/redeem'/);
    expect(src).toMatch(
      /OauthClientRedeemRequestOpenApi[\s\S]{0,200}code:\s*OauthClientBase64Url256OpenApi,\s*\n\s*flow_secret:\s*OauthClientBase64Url256OpenApi/,
    );
    expect(src).toMatch(
      /OauthClientBase64Url256OpenApi\s*=\s*z\.string\(\)\.regex\(\/\^\[A-Za-z0-9_-\]\{43\}\$\/\)/,
    );
  });

  it('start endpoint constrains provider to {google, github}', () => {
    expect(src).toMatch(/provider:\s*z\.enum\(\['google',\s*'github'\]\)/);
  });

  it('start endpoint requires a valid redirect_to URL', () => {
    expect(src).toMatch(
      /OauthClientStartRequestOpenApi[\s\S]{0,300}redirect_to:\s*z\.string\(\)\.url\(\)/,
    );
  });

  it('confirm-merge bounds token length to 32-128 chars (matches route validator)', () => {
    expect(src).toMatch(
      /OauthClientConfirmMergeRequestOpenApi[\s\S]{0,200}token:\s*z\.string\(\)\.min\(32\)\.max\(128\)/,
    );
  });

  it('confirm-merge response has outcome="merged" literal + account_id + link_id', () => {
    expect(src).toMatch(
      /OauthClientConfirmMergeResponseOpenApi[\s\S]{0,300}outcome:\s*z\.literal\('merged'\)[\s\S]{0,100}account_id[\s\S]{0,100}link_id/,
    );
  });

  it('every oauth-client endpoint in the slice is tagged "auth" (consistent with the rest of /v1/auth/*)', () => {
    const slice = src.slice(
      src.indexOf('OAuth-client IDP signin'),
      src.indexOf('OAuth 2.0 public dance'),
    );
    // Derived, not frozen: the number of registrations in the slice is what the
    // tag count must equal, so adding a route cannot leave a stale "3" behind and
    // a route registered WITHOUT the tag reds this by the difference.
    const registrations = (slice.match(/registerRoute\(/g) ?? []).length;
    const tagOccurrences = (slice.match(/tags:\s*\['auth'\]/g) ?? []).length;
    expect(registrations, 'the slice must hold a real population').toBeGreaterThanOrEqual(2);
    expect(tagOccurrences).toBe(registrations);
  });

  it('callback endpoint (IDP-redirect target) intentionally absent from the spec', () => {
    expect(src.includes(`'/v1/auth/oauth-client/callback'`)).toBe(false);
  });

  it('start endpoint REQUIRES binding_hash (the 43-char digest) and always answers flow_id — the cookie flow an absent binding_hash used to select was retired 2026-09-14', () => {
    const request = /const OauthClientStartRequestOpenApi = z\.object\(\{([\s\S]*?)\}\);/.exec(src);
    expect(request, 'OauthClientStartRequestOpenApi still parses out of the source').not.toBeNull();
    expect(request?.[1]).toMatch(/binding_hash:\s*OauthClientBase64Url256OpenApi\.describe\(/);
    expect(request?.[1]).not.toContain('.optional()');
    const response = /const OauthClientStartResponseOpenApi = z\.object\(\{([\s\S]*?)\}\);/.exec(
      src,
    );
    expect(
      response,
      'OauthClientStartResponseOpenApi still parses out of the source',
    ).not.toBeNull();
    expect(response?.[1]).toMatch(/flow_id:\s*z\.string\(\)\.describe\(/);
    expect(response?.[1]).not.toContain('.optional()');
  });

  it('no oauth-client operation documents a Set-Cookie header any more (the PKCE cookie is gone), and the slice says so in its one negative mention', () => {
    const slice = src.slice(
      src.indexOf('OAuth-client IDP signin'),
      src.indexOf('OAuth 2.0 public dance'),
    );
    expect(slice.length, 'the slice must hold a real population').toBeGreaterThan(2000);
    expect(slice).not.toMatch(/'Set-Cookie'/);
    expect(slice).not.toMatch(/PKCE cookie/);
    expect(slice).not.toMatch(/legacy/);
    expect(slice.match(/Set-Cookie/g) ?? []).toHaveLength(1);
    expect(slice).toMatch(/NO Set-Cookie/);
  });

  it('the PUBLISHED spec (packages/sdk-python/openapi.json) agrees: /start lists binding_hash as required, its 200 lists authorize_url AND flow_id as required, and no oauth-client 200 declares a Set-Cookie header — the generator output is what ships in the SDK (CI never regenerates it), so the source pin alone would be a false signal against a stale dump', () => {
    const doc = JSON.parse(readFileSync(PUBLISHED_SPEC, 'utf8')) as SpecShape;
    const start = doc.paths['/v1/auth/oauth-client/start']?.['post'];
    expect(start, '/start is published').toBeDefined();
    const body = deref(doc, start?.requestBody?.content?.['application/json']?.schema) as
      | { required?: string[]; properties?: Record<string, unknown> }
      | undefined;
    expect(Object.keys(body?.properties ?? {}).sort()).toEqual([
      'binding_hash',
      'provider',
      'redirect_to',
    ]);
    expect([...(body?.required ?? [])].sort()).toEqual(['binding_hash', 'provider', 'redirect_to']);
    // The 200 answer's `required` too: flow_id is what the page keys its
    // localStorage record on, so an SDK generated from a spec that let it be
    // optional would type every /start answer as possibly flow-less.
    const ok = deref(doc, start?.responses?.['200']?.content?.['application/json']?.schema) as
      | { required?: string[] }
      | undefined;
    expect([...(ok?.required ?? [])].sort()).toEqual(['authorize_url', 'flow_id']);
    for (const path of [
      '/v1/auth/oauth-client/start',
      '/v1/auth/oauth-client/redeem',
      '/v1/auth/oauth-client/confirm-merge',
    ]) {
      const op = doc.paths[path]?.['post'];
      expect(op, path).toBeDefined();
      for (const [status, res] of Object.entries(op?.responses ?? {})) {
        expect(Object.keys(res.headers ?? {}), `${path} ${status}`).not.toContain('Set-Cookie');
      }
    }
  });
});
