// W760 — apps/docs api/index.astro content parity. Eighty-sixth in
// the cross-SDK drift-guard series. First parity guard on the apps/
// docs surface (35+ pages without one to date).
//
// /api on docs.driftstack.io is the customer-facing TOC for the
// HTTP API. Drift to dropping a sub-section link would silently
// hide that capability from new SDK consumers.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/index.astro');

describe('W760 docs /api index page content parity', () => {
  it('api/index.astro file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL canonical API origin pinned — https://api.driftstack.dev. Drift to a different host would diverge from the DASHBOARD_ORIGIN single-source-of-truth + W742 dashboard-resolveApiBaseUrl prod-default.', () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /The Driftstack HTTP API surface lives at <code>https:\/\/api\.driftstack\.dev<\/code>/,
    );
  });

  it('CRITICAL /v1/* versioning framing pinned. The "Every endpoint is versioned under /v1/\\*; new majors land with explicit deprecation cycles per the policy below" wording is the load-bearing versioning contract.', () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /Every\s*\n\s+endpoint is versioned under <code>\/v1\/\*<\/code>; new majors land with explicit deprecation/,
    );
    expect(p).toMatch(/cycles per the policy below\./);
  });

  it('CRITICAL 20-section sub-TOC pinned. Drift to dropping any link would hide that API surface. Order: auth/account/api-keys/sessions/agent-sessions/recipes/bundled-llm/byok-anthropic/profiles/usage/audit-log/mfa/billing/team/status/oauth/versioning + 3 webhook subsections (endpoints/events/replay).', () => {
    const p = read(PAGE);

    for (const href of [
      '/api/auth/',
      '/api/account/',
      '/api/api-keys/',
      '/api/sessions/',
      '/api/agent-sessions/',
      '/api/recipes/',
      // v2-#6/#8 — bundled-LLM + BYOK Anthropic API surfaces.
      '/api/bundled-llm/',
      '/api/byok-anthropic/',
      '/api/profiles/',
      '/api/usage/',
      '/api/audit-log/',
      '/api/mfa/',
      '/api/billing/',
      '/api/team/',
      // V-295a status API + V-667 OAuth 2.0 third-party client surface.
      '/api/status/',
      '/api/oauth/',
      '/api/versioning/',
      // 3 webhook subsections: endpoints (CRUD), events (catalog),
      // replay (per-delivery replay endpoint).
      '/webhooks/endpoints/',
      '/webhooks/events/',
      '/webhooks/replay/',
    ]) {
      expect(p, `link ${href}`).toMatch(new RegExp(`<a href="${href.replace(/\//g, '\\/')}">`));
    }
  });

  it("CRITICAL /api/auth customer-dashboard-surface framing pinned. The 'The customer-dashboard surface; distinct from API-key bearer auth' wording is what tells SDK builders auth endpoints are NOT for API keys.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/The customer-dashboard surface;\s*\n\s+distinct from API-key bearer auth\./);
  });

  it('CRITICAL /api/account team-RBAC framing pinned. The "Team-RBAC interaction notes" anchor cross-references the V-326e team-roles taxonomy.', () => {
    const p = read(PAGE);
    expect(p).toMatch(/Team-RBAC interaction notes\./);
  });

  it('CRITICAL /api/api-keys paid-create/rotate and dashboard list/revoke boundary plus 24-hour grace pinned.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/paid tiers create and rotate; dashboard web/);
    expect(p).toMatch(/sessions can list and revoke\. Includes 24-hour rotation grace/);
  });

  it('CRITICAL /api/sessions 6-action lifecycle pinned — create/navigate/interact/capture/wait/destroy. Drift to dropping an action would hide the lifecycle from SDK consumers.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/create, navigate, interact, capture, wait, destroy\./);
    expect(p).toMatch(/Session lifecycle \+ concurrency caps\./);
  });

  it("CRITICAL /api/profiles snapshots-included framing pinned. 'Snapshots — capture / list / restore / delete' is what tells API consumers snapshots live UNDER profiles (matches W752 + W756 dashboard separation: capture on /profiles, manage on /snapshots).", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Snapshots — capture \/ list \/ restore \/ delete\./);
  });

  it('CRITICAL /api/billing summary pinned — subscriptions + Stripe Customer Portal + billing-state read (trial pack retired 2026-05-27).', () => {
    const p = read(PAGE);

    expect(p).toMatch(/subscriptions, Stripe Customer/);
    expect(p).toMatch(/Portal redirect, billing-state read\./);
    expect(p).not.toMatch(/trial pack/);
  });

  it('CRITICAL OpenAPI canonical URL pinned — https://api.driftstack.dev/openapi.json. Drift would mismatch the SDK regeneration source-of-truth.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Live at <code>https:\/\/api\.driftstack\.dev\/openapi\.json<\/code>;/);
    expect(p).toMatch(/rendered via Scalar UI on the API host at <code>\/docs\/<\/code>\./);
  });

  it('CRITICAL auth boundary pins ds_live customer keys on every paid tier and ds_test restricted desktop credentials on Free.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Customer API keys are <code>ds_live_…<\/code> on every/);
    expect(p).toMatch(/paid tier, including Manual/);
    expect(p).toMatch(/<code>ds_test_…<\/code> device credential automatically/);
    expect(p).toMatch(/it is not a general sandbox key/);
  });

  it('CRITICAL web-session sha256-hashed-opaque-tokens framing pinned. Drift to suggesting a JWT/symmetric framing would diverge from the V-079 dashboard-session lifecycle.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Dashboard web sessions use opaque SHA-256-hashed tokens\. All use a Bearer header\./,
    );
  });

  it('CRITICAL rate-limit header pair pinned — x-ratelimit-remaining + retry-after on 429. Drift to dropping retry-after would force SDK consumers to back-off without server-suggested timing.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Per-tier token-bucket policy\. Response headers include\s*\n\s+<code>x-ratelimit-remaining<\/code>; <code>429<\/code> responses include <code>retry-after<\/code>\./,
    );
  });

  it('CRITICAL IP-based auth-endpoint gate framing pinned. The "IP-based gates also apply on unauthenticated auth endpoints (signup / login / verify-email / password-reset)" wording is the canonical 4-endpoint set of pre-auth rate-limited surfaces.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /IP-based gates also apply on unauthenticated auth endpoints \(signup \/ login \/ verify-email\s*\n\s+\/ password-reset\)\./,
    );
  });

  it('CRITICAL 3-link "Practical use" set — /quickstart/ + /guides/session-lifecycle/ + /guides/profile-management/. Drift to dropping would force new customers to hunt for getting-started content.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/<a href="\/quickstart\/">Quickstart<\/a>/);
    expect(p).toMatch(/<a href="\/guides\/session-lifecycle\/">Session lifecycle<\/a>/);
    expect(p).toMatch(/<a href="\/guides\/profile-management\/">Profile management<\/a>/);
  });

  it('CRITICAL DocLayout used with title="API reference".', () => {
    const p = read(PAGE);

    expect(p).toMatch(/import DocLayout from '\.\.\/\.\.\/layouts\/DocLayout\.astro'/);
    expect(p).toMatch(/<DocLayout title="API reference">/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/docs-pages-api-index-content-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
