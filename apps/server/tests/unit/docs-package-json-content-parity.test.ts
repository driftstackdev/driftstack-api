// W537.B — drift guard for apps/docs/package.json.
// V-250 docs site manifest. Drift here either drops @tailwindcss/
// typography (would break the prose styling that lets long-form docs
// render readably) or drops @astrojs/sitemap (would break the V-250
// sitemap auto-generation for docs.driftstack.dev).
//
//   • Name: @driftstack/docs.
//   • private: true + type: module.
//   • Standard 4-script Astro pipeline (dev/build/preview/typecheck).
//   • Critical deps: @astrojs/check + @astrojs/sitemap + @astrojs/
//     tailwind + @tailwindcss/typography (for prose-heavy docs pages
//     — distinct from dashboard+admin which deliberately exclude it)
//     + astro + tailwindcss + typescript.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/docs/package.json');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W537.B apps/docs/package.json content parity', () => {
  const body = read(LIB);
  const pkg = JSON.parse(body) as {
    name: string;
    private: boolean;
    type: string;
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
  };

  it("Identity + Astro-app shape framing pinned: 'name: @driftstack/docs' + 'private: true' + 'type: module' + 4-script Astro pipeline (dev/build/preview/typecheck via astro check) — pinned so the monorepo-scoped name + standard Astro-app shape (parity with marketing-site + customer-dashboard + admin-panel + status-site) commitment survives", () => {
    expect(pkg.name).toBe('@driftstack/docs');
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
    expect(pkg.scripts.dev).toBe('astro dev');
    expect(pkg.scripts.build).toBe('astro build');
    expect(pkg.scripts.preview).toBe('astro preview');
    expect(pkg.scripts.typecheck).toBe('astro check');
  });

  it('Critical-dep + typography-plugin framing pinned: @astrojs/check + @astrojs/sitemap (for V-250 docs sitemap) + @astrojs/tailwind + @tailwindcss/typography (load-bearing for prose-heavy long-form docs — distinct from dashboard+admin which deliberately exclude it for forms/tables-only surface) + astro + tailwindcss + typescript + NO @sentry/astro (parity with docs astro.config no-Sentry posture) — pinned so the 7-dep set with typography-plugin commitment survives (drift to dropping @tailwindcss/typography would break prose rendering on docs.driftstack.dev pages; drift to dropping @astrojs/sitemap would break crawler discovery of docs pages)', () => {
    expect(pkg.dependencies).toHaveProperty('@astrojs/check');
    expect(pkg.dependencies).toHaveProperty('@astrojs/sitemap');
    expect(pkg.dependencies).toHaveProperty('@astrojs/tailwind');
    expect(pkg.dependencies).toHaveProperty('@tailwindcss/typography');
    expect(pkg.dependencies).toHaveProperty('astro');
    expect(pkg.dependencies).toHaveProperty('tailwindcss');
    expect(pkg.dependencies).toHaveProperty('typescript');
    expect(pkg.dependencies).not.toHaveProperty('@sentry/astro');
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
