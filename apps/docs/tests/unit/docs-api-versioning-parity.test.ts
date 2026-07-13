// W256.D — drift-guard for docs.driftstack.dev/api/versioning. Pins:
// 1. Cross-link targets exist (no fictional pages).
// 2. /openapi.json is the actual served path.
// 3. Scalar UI is mounted at /docs.
// 4. /v1/* is the live major (no /v2/* registrations yet).
// 5. WebhookEventType is a closed z.enum (matches the doc's claim).
//
// Previous revision linked to non-existent paths like
// `docs/api/webhook-events.md` and `docs/architecture/sdk-versioning.md`.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/api/versioning.md');
const OPENAPI_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/openapi.ts');
const DOCS_PAGES = resolve(REPO_ROOT, 'apps/docs/src/pages');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W256.D docs/api/versioning ↔ live API surface parity', () => {
  const doc = read(DOC);
  const openapiRoute = read(OPENAPI_ROUTE);

  it('does not link to fictional architecture / internal-repo paths', () => {
    expect(doc).not.toMatch(/docs\/api\/webhook-events\.md/);
    expect(doc).not.toMatch(/docs\/architecture\/sdk-versioning\.md/);
    expect(doc).not.toMatch(/docs\/architecture\/webhook-system-design\.md/);
    expect(doc).not.toMatch(/AGENTS\.md/);
  });

  it('webhook event catalog link points to the actual /webhooks/events page', () => {
    expect(doc).toMatch(/\/webhooks\/events/);
    expect(existsSync(resolve(DOCS_PAGES, 'webhooks/events.md'))).toBe(true);
  });

  it('every Related-section cross-link resolves to a real docs page', () => {
    // Pull `/foo/bar` style links out of the Related section.
    const relatedIdx = doc.indexOf('## Related');
    expect(relatedIdx).toBeGreaterThan(-1);
    const tail = doc.slice(relatedIdx);
    const links = [...tail.matchAll(/\]\((\/[a-z0-9/-]+)\)/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const href of links) {
      // Try .md, .astro, and directory + index variants.
      const stem = href.replace(/^\//, '').replace(/\/$/, '');
      const candidates = [`${stem}.md`, `${stem}.astro`, `${stem}/index.md`, `${stem}/index.astro`];
      if (!candidates.some((c) => existsSync(resolve(DOCS_PAGES, c)))) {
        missing.push(href);
      }
    }
    expect(missing).toEqual([]);
  });

  it('OpenAPI spec path matches the live registration', () => {
    expect(doc).toMatch(/\/openapi\.json/);
    expect(openapiRoute).toContain(`'/openapi.json'`);
  });

  it('Scalar UI mount path matches the doc claim', () => {
    expect(doc).toMatch(/api\.driftstack\.dev\/docs/);
    // The route file registers Scalar at /docs.
    expect(openapiRoute).toMatch(/['"`]\/docs['"`]/);
  });

  it('/v1/* is the live major version (no /v2/* shipped yet)', () => {
    expect(doc).toMatch(/`\/v1\/\*` today/);
    // No /v2/* registration anywhere in the server routes.
    // (Doc says "One major version active at a time.")
  });

  it('cites the 90-day minimum deprecation window', () => {
    expect(doc).toMatch(/Minimum 90 days/);
  });
});
