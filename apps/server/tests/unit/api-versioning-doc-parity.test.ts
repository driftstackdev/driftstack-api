// W244.B — drift-guard for /docs/api-versioning. The doc is mostly
// policy, but it advertises specific endpoints + the X-Request-Id
// response header. This guard pins both so renaming any of them
// without updating the doc fails CI.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(
  REPO,
  'apps',
  'marketing-site',
  'src',
  'pages',
  'docs',
  'api-versioning.astro',
);
const ROUTES_DIR = join(REPO, 'apps', 'server', 'src', 'routes');
const SERVER_SRC = join(REPO, 'apps', 'server', 'src');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function serverSourceMatches(re: RegExp): boolean {
  function walk(dir: string): boolean {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(p)) return true;
      } else if (entry.name.endsWith('.ts')) {
        if (re.test(readFileSync(p, 'utf8'))) return true;
      }
    }
    return false;
  }
  return walk(SERVER_SRC);
}

describe('W244.B api-versioning doc parity', () => {
  const doc = read(DOC_PATH);

  it('every example endpoint in the doc exists in the routes/ tree', () => {
    // Endpoints called out in the example block.
    expect(serverSourceMatches(/'\/v1\/sessions'/)).toBe(true);
    expect(serverSourceMatches(/'\/v1\/profiles'/)).toBe(true);
    expect(serverSourceMatches(/'\/v1\/billing\/crypto-checkout'/)).toBe(true);
    // Doc continues to reference them.
    expect(doc).toMatch(/\/v1\/sessions/);
    expect(doc).toMatch(/\/v1\/profiles/);
    expect(doc).toMatch(/\/v1\/billing\/crypto-checkout/);
  });

  it('asserts X-Request-Id is the response correlation header', () => {
    // Live: middleware/request-id.ts sets reply.header('x-request-id', ...).
    expect(serverSourceMatches(/reply\.header\(\s*['"]x-request-id['"]/)).toBe(true);
    expect(doc).toMatch(/X-Request-Id/);
  });

  it('does not claim beta endpoints that do not actually exist', () => {
    // The doc explicitly states "No customer-facing endpoints are in beta today".
    expect(doc).toMatch(/No customer-facing endpoints are in beta today/);
  });

  it('uses the canonical /v1/ prefix narrative consistently', () => {
    // No regressions to a /v2/ claim (we're still on v1).
    expect(doc).toMatch(/currently at\s*<strong>v1<\/strong>/);
  });

  it('lists SDK docs cross-links by their actual page slugs', () => {
    const docsDir = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'docs');
    const docFiles = new Set(readdirSync(docsDir));
    for (const slug of ['sdk-typescript.astro', 'sdk-python.astro', 'sdk-go.astro']) {
      expect(docFiles.has(slug)).toBe(true);
    }
    expect(doc).toMatch(/\/docs\/sdk-typescript/);
    expect(doc).toMatch(/\/docs\/sdk-python/);
    expect(doc).toMatch(/\/docs\/sdk-go/);
    // Lint that routes_dir exists so test isn't silently wrong.
    expect(readdirSync(ROUTES_DIR).length).toBeGreaterThan(0);
  });
});
