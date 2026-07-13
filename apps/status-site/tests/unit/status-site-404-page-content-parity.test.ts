// W607 — drift guard for status-site 404.astro.
// Pins the layout-wrap, the "single overview + per-incident pages"
// scope claim, and the back-to-overview cross-link.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/status-site/src/pages/404.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W607 apps/status-site/src/pages/404.astro content parity', () => {
  const body = read(PAGE);

  it('wraps StatusLayout with "404 · Driftstack status" title + single-overview-plus-per-incident scope claim + back-to-overview cross-link pinned', () => {
    expect(body).toMatch(/^import StatusLayout from '\.\.\/layouts\/StatusLayout\.astro';$/m);
    expect(body).toMatch(/<StatusLayout title="404 · Driftstack status" noindex>/);
    expect(body).toMatch(
      /<p class="font-mono text-xs uppercase tracking-widest text-ink-muted">404<\/p>/,
    );
    expect(body).toMatch(
      /<h1 class="mt-4 text-3xl font-semibold tracking-tight text-ink-primary">Page not found\.<\/h1>/,
    );
    expect(body).toMatch(
      /The status site only hosts a single overview page plus per-incident pages/,
    );
    expect(body).toMatch(
      /under <code class="font-mono text-sm text-ink-secondary">\/incident\?id=&lt;id&gt;<\/code>\./,
    );
    expect(body).toMatch(
      /<a href="\/" class="text-sm text-ink-secondary underline hover:text-ink-primary">/,
    );
    expect(body).toMatch(/← Back to overview/);
    expect(existsSync(PAGE)).toBe(true);
  });
});
