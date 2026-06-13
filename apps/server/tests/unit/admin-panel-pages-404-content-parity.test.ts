// W486.C — drift guard for apps/admin-panel/src/pages/404.astro.
// Catch-all 404 page for the admin panel. Bridges the next sweep
// domain — opens admin-panel/src/pages coverage with the smallest
// page first. Drift here either swaps the AdminLayout wrapper (the
// 404 would lose admin chrome and look orphaned) or drops the
// 'Check the sidebar links' framing (operators would land with no
// navigation hint).
//
//   • AdminLayout import + title='404' frontmatter.
//   • '404' eyebrow + 'Page not found.' headline + 'Check the
//     sidebar links.' framing.
//   • 'Back to overview' CTA links to '/'.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/404.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W486.C apps/admin-panel/src/pages/404.astro content parity', () => {
  const body = read(LIB);

  it("AdminLayout frontmatter import + title='404' — pinned so the 404 stays wrapped in the admin chrome (sidebar + header) rather than landing as a bare body-only fallback that would look like a different app", () => {
    expect(body).toMatch(/import AdminLayout from '\.\.\/layouts\/AdminLayout\.astro';/);
    expect(body).toMatch(/<AdminLayout title="404">/);
  });

  it("404 eyebrow + 'Page not found.' headline + 'The admin panel has no page at this path. Check the sidebar links.' framing — pinned so operators landing here get a clear 'this URL doesn't exist + here's how to navigate out' message rather than a blank fallback", () => {
    expect(body).toMatch(
      /<p class="font-mono text-xs uppercase tracking-widest text-tk-accent">404<\/p>/,
    );
    // 2026-05-23 — h1 wrapped in oxblood gradient span (admin-panel
    // visual unification); pin loosened to label-presence.
    expect(body).toMatch(/<h1 class="mt-4 text-4xl font-semibold tracking-tight text-tk-ink">/);
    expect(body).toMatch(/Page not found\./);
    expect(body).toMatch(/The admin panel has no page at this path\. Check the sidebar links\./);
  });

  it("'Back to overview' CTA links to '/' with btn-primary styling — pinned so the only escape-hatch link on the 404 always returns to the admin index (the canonical fallback target — drift to /dashboard or /admin would 404 again in environments where the path prefix differs)", () => {
    expect(body).toMatch(/<a href="\/" class="btn-primary">Back to overview<\/a>/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
