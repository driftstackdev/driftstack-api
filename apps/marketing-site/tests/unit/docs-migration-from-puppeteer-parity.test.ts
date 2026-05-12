// W355.C — drift guard for /docs/migration-from-puppeteer. The
// Puppeteer/Playwright → Driftstack migration reference. The page
// asserts a concept-mapping table; pin every endpoint claim
// against a registered server route so a rename surfaces here.
//
// Pinned:
//   • Concept-mapping table — every /v1/* endpoint cited resolves
//     to a registered route.
//   • "Arbitrary script eval is intentionally not exposed" claim
//     (negative — no /eval-style endpoint registered server-side).
//   • capture endpoint kinds (screenshot / dom_snapshot / pdf).
//   • Profile + profile-snapshots endpoint paths match what the
//     server registers.
//   • Recordings cited as roadmap (cross-link resolves).
//   • Cross-links to /docs/recordings + /docs/concurrency + /docs/sessions
//     resolve.
//   • concurrency-limit framing for back-pressure (429 dispatch slug).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(
  REPO_ROOT,
  'apps/marketing-site/src/pages/docs/migration-from-puppeteer.astro',
);
const ROUTES_DIR = resolve(REPO_ROOT, 'apps/server/src/routes');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function allRoutes(): string {
  const out: string[] = [];
  for (const entry of readdirSync(ROUTES_DIR)) {
    if (entry.endsWith('.ts')) out.push(readFileSync(join(ROUTES_DIR, entry), 'utf8'));
  }
  return out.join('\n');
}

describe('W355.C /docs/migration-from-puppeteer parity', () => {
  const body = read(PAGE);
  const routes = allRoutes();

  it('session endpoints cited match registered server routes', () => {
    // Each citation must show up in a registered route file.
    const sessionEndpoints = [
      "'/v1/sessions'",
      "'/v1/sessions/:id'",
      "'/v1/sessions/:id/navigate'",
      "'/v1/sessions/:id/interact'",
      "'/v1/sessions/:id/wait'",
      "'/v1/sessions/:id/state'",
      "'/v1/sessions/:id/capture'",
    ] as const;
    for (const r of sessionEndpoints) {
      expect(routes, `route missing: ${r}`).toContain(r);
    }
    // And each citation must appear on the page.
    expect(body).toContain('/v1/sessions/:id/navigate');
    expect(body).toContain('/v1/sessions/:id/interact');
    expect(body).toContain('/v1/sessions/:id/wait');
    expect(body).toContain('/v1/sessions/:id/state');
    expect(body).toContain('/v1/sessions/:id/capture');
  });

  it('DELETE /v1/sessions/:id is the documented browser.close() equivalent', () => {
    expect(body).toMatch(/<code>DELETE \/v1\/sessions\/:id<\/code>/);
  });

  it('GUI-input endpoint (/v1/sessions/:id/gui-input) cited + registered server-side', () => {
    expect(body).toContain('/v1/sessions/:id/gui-input');
    expect(routes).toContain("'/v1/sessions/:id/gui-input'");
  });

  it('"arbitrary script eval intentionally not exposed" claim pinned (no eval route registered)', () => {
    expect(body).toMatch(/Arbitrary script\s*eval is intentionally not exposed/);
    // Negative server-side guard.
    expect(routes).not.toMatch(/['"]\/v1\/sessions\/:id\/evaluate['"]/);
    expect(routes).not.toMatch(/['"]\/v1\/sessions\/:id\/eval['"]/);
  });

  it('capture kind=screenshot returns inline base64 (not a presigned URL)', () => {
    expect(body).toMatch(/<code>kind=screenshot<\/code>/);
    expect(body).toMatch(/inline base64\s*bytes \(no presigned URL\)/);
  });

  it('profile + profile-snapshot endpoints cited match registered routes', () => {
    expect(body).toContain('/v1/profiles');
    expect(body).toContain('/v1/profiles/:id/snapshots');
    expect(body).toContain('/v1/profile-snapshots/:id/restore');
    expect(routes).toContain("'/v1/profiles'");
    expect(routes).toContain("'/v1/profiles/:id/snapshots'");
    expect(routes).toContain("'/v1/profile-snapshots/:id/restore'");
  });

  it('recordings cited as roadmap (cross-link resolves)', () => {
    expect(body).toContain('/docs/recordings');
    expect(body).toMatch(/Roadmap/);
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/recordings.astro')),
    ).toBe(true);
  });

  it('back-pressure framing uses concurrency-limit 429 (not a fictional error code)', () => {
    expect(body).toMatch(/concurrency_limit_reached/);
    expect(body).toMatch(/429/);
    // Pin "back off + retry" copy — defensive shape.
    expect(body).toMatch(/back off \+ retry/);
  });

  it('side-by-side login snippet uses real Driftstack endpoint paths', () => {
    expect(body).toContain('POST /v1/sessions');
    expect(body).toMatch(/POST \/v1\/sessions\/ses_…\/navigate/);
  });
});
