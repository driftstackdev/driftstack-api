// W337.C — drift guard for the dashboard /index overview page.
// The page advertises four live endpoints (account/me, api-keys,
// sessions, billing). Each one must remain registered server-side
// under the same /v1/ path. The page also pins a handful of
// data-* hooks that downstream tests / E2E selectors rely on; if
// somebody renames them silently the dashboard quietly stops
// rendering live data.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/index.astro');
const ROUTES_DIR = resolve(REPO_ROOT, 'apps/server/src/routes');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function allRouteSources(): string {
  let combined = '';
  for (const f of readdirSync(ROUTES_DIR)) {
    if (!/\.ts$/.test(f)) continue;
    combined += readFileSync(resolve(ROUTES_DIR, f), 'utf8') + '\n';
  }
  return combined;
}

describe('W337.C dashboard /index overview endpoint parity', () => {
  const body = read(PAGE);
  const routes = allRouteSources();

  it('cites GET /v1/account/me and the route is registered server-side', () => {
    expect(body).toContain("getJson('/v1/account/me')");
    expect(routes).toContain("'/v1/account/me'");
  });

  it('cites GET /v1/api-keys and the route is registered server-side', () => {
    expect(body).toContain("getJson('/v1/api-keys')");
    expect(routes).toContain("'/v1/api-keys'");
  });

  it('cites GET /v1/sessions and the route is registered server-side', () => {
    expect(body).toContain("getJson('/v1/sessions')");
    expect(routes).toContain("'/v1/sessions'");
  });

  it('cites GET /v1/billing and the route is registered server-side', () => {
    expect(body).toContain("getJson('/v1/billing')");
    expect(routes).toContain("'/v1/billing'");
  });

  it('reads the bearer token from the canonical ds_web_session_token key', () => {
    expect(body).toContain("localStorage.getItem('ds_web_session_token')");
  });

  it('routes through the team-RBAC act-as helper installed by DashboardLayout', () => {
    // The "self-scope returns {}" comment is load-bearing — it
    // documents that the request behaves identically when no
    // X-Driftstack-Account header is present.
    expect(body).toContain('window.driftstackActAsHeaders');
  });

  it('pins stat data-* hooks the page exposes for downstream tests', () => {
    for (const hook of [
      'data-account-name',
      'data-account-tier',
      'data-stat-concurrent',
      'data-stat-concurrent-cap',
      'data-stat-profiles',
      'data-stat-profiles-cap',
      'data-stat-api-keys',
      'data-sessions-empty',
      'data-sessions-list',
      'data-subscription-empty',
      'data-subscription-card',
      'data-subscription-line',
      'data-subscription-period',
      'data-trial-pack',
      'data-trial-pack-line',
    ]) {
      expect(body).toContain(hook);
    }
  });

  it('links downstream surfaces (Sessions, Billing, Select tier) the page CTAs target', () => {
    expect(body).toContain('href="/sessions"');
    expect(body).toContain('href="/billing"');
    expect(body).toContain('href="/select-tier"');
  });

  it('formats trial-pack credit in dollars (cents / 100), matching billing API shape', () => {
    // The /v1/billing payload returns credit_cents_remaining; the
    // page must display it as a $-prefixed two-decimal string.
    expect(body).toContain('credit_cents_remaining');
    expect(body).toMatch(/\(cents \/ 100\)\.toFixed\(2\)/);
  });
});
