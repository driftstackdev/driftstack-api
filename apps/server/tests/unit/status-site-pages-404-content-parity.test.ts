// Drift guard for apps/status-site/src/pages/404.astro. Pins the
// minimal status-site 404 page — single-overview-page + per-incident-
// page route documentation in the copy + Back-to-overview discovery
// link. Drift to a different copy framing would either over-promise
// status-site scope or break the discoverability link.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/status-site/src/pages/404.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('status-site/pages/404 content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('StatusLayout title + noindex pinned so the error page is named correctly without entering search indexes', () => {
    expect(body).toMatch(/<StatusLayout title="404 · Driftstack status" noindex>/);
  });

  it("'Page not found.' headline + 404 section-label tag pinned. Drift to a different headline would mismatch the rest of the 404 family across the customer-dashboard / marketing-site 404 pages", () => {
    expect(body).toMatch(
      /<p class="font-mono text-xs uppercase tracking-widest text-ink-muted">404<\/p>/,
    );
    expect(body).toMatch(
      /<h1 class="mt-4 text-3xl font-semibold tracking-tight text-ink-primary">Page not found\.<\/h1>/,
    );
  });

  it("Status-site scope copy pinned: 'The status site only hosts a single overview page plus per-incident pages under /incident?id=<id>.' — pinned so the single-overview + per-incident-route contract stays documented (the page is incident.astro served at /incident with a ?id= query; the old /incidents/<id> path had no matching route)", () => {
    expect(body).toMatch(
      /The status site only hosts a single overview page plus per-incident pages\s*under <code class="font-mono text-sm text-ink-secondary">\/incident\?id=&lt;id&gt;<\/code>\./,
    );
  });

  it('Back-to-overview discovery link pinned: \'<a href="/"…>← Back to overview</a>\'. Drift to a different fallback URL would orphan customers from the only working entry point', () => {
    expect(body).toMatch(
      /<a href="\/" class="text-sm text-ink-secondary underline hover:text-ink-primary">\s*← Back to overview\s*<\/a>/,
    );
  });
});
