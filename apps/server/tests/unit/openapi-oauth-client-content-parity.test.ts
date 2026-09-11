// OpenAPI parity — OAuth-client IDP signin endpoints (V-667.C).
// /start + /confirm-merge are the customer-facing endpoints for
// dashboard sign-in-with-Google/GitHub; /redeem (2026-09-11) is the
// v2 cookie-free hand-off step the SPA POSTs after the top-level IDP
// callback 302s it a single-use code. /callback is an IDP-redirect
// target and intentionally NOT in the customer spec (no client
// posts to it directly).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const OPENAPI_SRC = resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts');

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

  it('all three endpoints tagged "auth" (consistent with the rest of /v1/auth/*)', () => {
    const slice = src.slice(
      src.indexOf('OAuth-client IDP signin'),
      src.indexOf('OAuth 2.0 public dance'),
    );
    const tagOccurrences = (slice.match(/tags:\s*\['auth'\]/g) ?? []).length;
    // 3 since 2026-09-11: /start, /redeem, /confirm-merge.
    expect(tagOccurrences).toBe(3);
  });

  it('callback endpoint (IDP-redirect target) intentionally absent from the spec', () => {
    expect(src.includes(`'/v1/auth/oauth-client/callback'`)).toBe(false);
  });
});
