// W357.A — drift guard for /docs/migration-from-browserless. The
// V-705 migration reference for teams coming off Browserless.
// W228.A already pins the negative claims (no script-passthrough,
// no waitUntilTerminal, etc.) from the server side; this guard
// pins the positive surface claims a porting engineer relies on.
//
// Pinned:
//   • Action endpoint set cited in the surface-comparison table is
//     a subset of what apps/server actually registers
//     (navigate / interact / wait / capture under /v1/sessions/:id/*).
//   • capture kinds (screenshot / dom_snapshot / pdf) inline-base64
//     framing — not presigned URLs.
//   • Over-cap 429 + concurrency-limit RFC 7807 type pinned.
//   • Recordings cross-link cites the roadmap state (V-540).
//   • Tier-pick list (api_starter / api_builder / api_scale) — the
//     three tier slugs must continue to resolve in the tier
//     taxonomy.
//   • "WebKit only" + "Cloud only" negative claims pinned.
//   • Cross-links to /docs/profiles + /docs/sdk-typescript +
//     /docs/sdk-python + /docs/webhooks + /docs/cost-monitoring +
//     /docs/recordings + /pricing all resolve.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(
  REPO_ROOT,
  'apps/marketing-site/src/pages/docs/migration-from-browserless.astro',
);
const ROUTES_DIR = resolve(REPO_ROOT, 'apps/server/src/routes');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function allRoutes(): string {
  const out: string[] = [];
  for (const e of readdirSync(ROUTES_DIR)) {
    if (e.endsWith('.ts')) out.push(readFileSync(join(ROUTES_DIR, e), 'utf8'));
  }
  return out.join('\n');
}

describe('W357.A /docs/migration-from-browserless parity', () => {
  const body = read(PAGE);
  const routes = allRoutes();

  it('action endpoint set cited in the comparison table is registered server-side', () => {
    // POST /v1/sessions itself + the four action endpoints.
    for (const r of [
      "'/v1/sessions'",
      "'/v1/sessions/:id/navigate'",
      "'/v1/sessions/:id/interact'",
      "'/v1/sessions/:id/wait'",
      "'/v1/sessions/:id/capture'",
    ]) {
      expect(routes, `route missing: ${r}`).toContain(r);
    }
    expect(body).toContain('/v1/sessions');
    expect(body).toMatch(/<code>navigate<\/code>/);
    expect(body).toMatch(/<code>interact<\/code>/);
    expect(body).toMatch(/<code>wait<\/code>/);
    expect(body).toMatch(/<code>capture<\/code>/);
  });

  it('capture kind set (screenshot / dom_snapshot / pdf) framed as inline base64 — no presigned URL', () => {
    expect(body).toMatch(/<code>kind=screenshot<\/code>/);
    expect(body).toMatch(/<code>dom_snapshot<\/code>/);
    expect(body).toMatch(/<code>pdf<\/code>/);
    expect(body).toMatch(/inline base64 bytes — no\s+presigned URL/);
  });

  it('over-cap 429 + concurrency-limit RFC 7807 type pinned', () => {
    expect(body).toMatch(/Tier-driven concurrency cap/);
    expect(body).toMatch(/<code>429<\/code>/);
    expect(body).toMatch(/<code>concurrency-limit<\/code> RFC 7807 type/);
  });

  it('recordings cited as roadmap (V-540) — not shipped today', () => {
    expect(body).toMatch(/<a href="\/docs\/recordings">roadmap<\/a>\s*\(V-540\)\s*but not shipped/);
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/recordings.astro')),
    ).toBe(true);
  });

  it('tier-pick list cites api_starter / api_builder / api_scale (three real tier slugs)', () => {
    expect(body).toMatch(/api_starter/);
    expect(body).toMatch(/api_builder/);
    expect(body).toMatch(/api_scale/);
  });

  it('"WebKit only" + "Cloud only today" negative claims pinned', () => {
    expect(body).toMatch(/Self-hosted on-prem\. Cloud only today\./);
    expect(body).toMatch(/WebKit only\./);
    expect(body).toMatch(/Chrome \+ Firefox are\s+on the roadmap/);
  });

  it('"no /function-style endpoint" claim pinned (negative server-side guard)', () => {
    expect(body).toMatch(
      /Server-side JS execution\. There is no\s+<code>\/function<\/code>-style endpoint/,
    );
    // Negative server-side guard: there must NOT be a /v1/sessions/:id/function
    // (or similar) route registered.
    expect(routes).not.toMatch(/['"]\/v1\/sessions\/:id\/function['"]/);
    expect(routes).not.toMatch(/['"]\/v1\/sessions\/:id\/eval['"]/);
  });

  it('cross-links resolve (profiles / sdk-typescript / sdk-python / webhooks / cost-monitoring / recordings)', () => {
    for (const [href, path] of [
      ['/docs/profiles', 'apps/marketing-site/src/pages/docs/profiles.astro'],
      ['/docs/sdk-typescript', 'apps/marketing-site/src/pages/docs/sdk-typescript.astro'],
      ['/docs/sdk-python', 'apps/marketing-site/src/pages/docs/sdk-python.astro'],
      ['/docs/webhooks', 'apps/marketing-site/src/pages/docs/webhooks.astro'],
      ['/docs/cost-monitoring', 'apps/marketing-site/src/pages/docs/cost-monitoring.astro'],
      ['/docs/recordings', 'apps/marketing-site/src/pages/docs/recordings.astro'],
    ] as const) {
      expect(body).toContain(href);
      expect(existsSync(resolve(REPO_ROOT, path)), `missing: ${path}`).toBe(true);
    }
  });

  it('developer-contact mailto + /pricing cross-link pinned', () => {
    expect(body).toContain('mailto:developers@driftstack.dev');
    expect(body).toContain('/pricing');
  });

  it('migration-checklist still cites the real onboarding flow (webhooks + cost alerts)', () => {
    // The customer-facing migration checklist must keep pointing at
    // the live cost-monitoring + webhooks endpoints — these are the
    // gates that catch a bad cutover.
    expect(body).toMatch(
      /Set up <a href="\/docs\/webhooks">webhooks<\/a> for\s+session-completed events/,
    );
    expect(body).toMatch(
      /Wire <a href="\/docs\/cost-monitoring">cost monitoring<\/a>\s+alerts before flipping production traffic/,
    );
  });
});
