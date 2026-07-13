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

  it('cites GET /v1/usage + /v1/usage/series (Fleet v2 hours stat + 14-day chart) and both routes are registered server-side', () => {
    expect(body).toContain("getJson('/v1/usage')");
    expect(body).toContain("getJson('/v1/usage/series?days=14')");
    expect(routes).toContain("'/v1/usage'");
    expect(routes).toContain("'/v1/usage/series'");
  });

  it('cites GET /v1/team/members (onboarding team step; 403 hides the step) and the route is registered server-side', () => {
    expect(body).toContain("getJson('/v1/team/members')");
    expect(routes).toContain("'/v1/team/members'");
  });

  it('cites the PUBLIC GET /v1/status (status pill, NO Authorization header — bounded direct read, not getJson) and the route is registered server-side', () => {
    expect(body).toMatch(
      /boundedFetch\(apiBaseUrl \+ '\/v1\/status', \{ headers: \{ accept: 'application\/json' \} \}\)/,
    );
    expect(routes).toContain("'/v1/status'");
  });

  it('reads the bearer token from the canonical ds_web_session_token key', () => {
    expect(body).toContain("localStorage.getItem('ds_web_session_token')");
  });

  it('getJson surfaces the problem+json detail (W151/W152), not the internal path + raw status', () => {
    // The account/me failure is the one user-visible error on this
    // landing page; it must read as a human message, not leak
    // "/v1/account/me returned 500". Pin the b.detail extraction + the
    // clean banner copy, and assert the old path-leaking throw is gone. The
    // shared response helper marks server detail customer-safe while the
    // banner classifier suppresses arbitrary transport/runtime internals.
    expect(body).toContain('throw window.driftstackResponseError(r, b)');
    expect(body).toContain('window.driftstackRequestErrorMessage(');
    expect(body).not.toMatch(/throw new Error\(b\.detail \|\| 'HTTP ' \+ r\.status\)/);
    expect(body).toContain('Could not load your account: ');
    expect(body).not.toMatch(/throw new Error\(path \+ ' returned ' \+ r\.status\)/);
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
    ]) {
      expect(body).toContain(hook);
    }
    // The trial-pack credit card was removed 2026-05-27 (GetBillingState
    // no longer returns trial_pack; entry tier is the perpetual free tier).
    expect(body).not.toContain('data-trial-pack');
  });

  it('links downstream account-portal surfaces the page CTAs target (2026-07-02: the operational /sessions link left with the account-portal IA — sessions are driven in the desktop app)', () => {
    expect(body).toContain('href="/billing/"');
    expect(body).toContain('href="/select-tier/"');
    expect(body).toContain('href="/team/"');
  });

  it('no residual trial-pack credit formatting (trial pack removed 2026-05-27)', () => {
    // GetBillingState no longer returns credit_cents_remaining; the
    // overview page must not read or format it.
    expect(body).not.toContain('credit_cents_remaining');
    expect(body).not.toContain('b.trial_pack');
  });
});
