// W537.B — drift guard for apps/docs/package.json.
// V-250 docs site manifest. Drift here either drops @tailwindcss/
// typography (would break the prose styling that lets long-form docs
// render readably) or drops @astrojs/sitemap (would break the V-250
// sitemap auto-generation for docs.driftstack.dev).
//
//   • Name: @driftstack/docs.
//   • private: true + type: module.
//   • Standard 4-script Astro pipeline (dev/build/preview/typecheck).
//   • Critical deps: @astrojs/check + @astrojs/sitemap +
//     @tailwindcss/vite + @tailwindcss/typography (for prose-heavy docs
//     pages) + Astro 7 + Tailwind 4 + TypeScript.
//   • S22.3 (2026-07-06): build chains `pagefind --site dist` after
//     `astro build` — the fully-local search index (dist/pagefind/) is
//     emitted INSIDE the workspace build script so both
//     scripts/deploy-frontend.sh docs and .github/workflows/
//     deploy-docs.yml (`npm run build --workspace apps/docs`) pick it
//     up with zero pipeline changes; pagefind is the docs app's only
//     devDependency (build-time indexer, never shipped as app code —
//     the runtime bundle it emits is static + self-contained).

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
    devDependencies: Record<string, string>;
  };

  it("Identity + Astro-app shape framing pinned: 'name: @driftstack/docs' + 'private: true' + 'type: module' + 4-script Astro pipeline (dev/build/preview/typecheck via astro check). S22.3 (2026-07-06): build = 'astro build && pagefind --site dist' — the Pagefind index step is chained INSIDE the workspace build script so deploy-frontend.sh and deploy-docs.yml (both run `npm run build --workspace`) emit dist/pagefind/ with zero pipeline edits; drift back to bare 'astro build' would silently ship a docs site whose search modal finds nothing", () => {
    expect(pkg.name).toBe('@driftstack/docs');
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
    expect(pkg.scripts.dev).toBe('astro dev');
    expect(pkg.scripts.build).toBe('astro build && pagefind --site dist');
    expect(pkg.scripts.preview).toBe('astro preview');
    expect(pkg.scripts.typecheck).toBe('astro check');
  });

  it('S22.3 (2026-07-06) — pagefind devDependency pinned: the static-search indexer lives in devDependencies (build-time tool — the runtime bundle it emits into dist/pagefind/ is fully local + self-contained, so the app ships zero new runtime deps and zero external calls), NOT in dependencies. Drift to dropping it would break the build script chain above; drift into dependencies would misstate it as shipped app code', () => {
    expect(pkg.devDependencies).toHaveProperty('pagefind');
    expect(pkg.dependencies).not.toHaveProperty('pagefind');
  });

  it('pins Astro 7 with the Tailwind 4 Vite engine, sitemap and prose styling, while excluding customer telemetry', () => {
    expect(pkg.dependencies).toHaveProperty('@astrojs/check');
    expect(pkg.dependencies).toHaveProperty('@astrojs/sitemap');
    expect(pkg.dependencies['@tailwindcss/vite']).toBe('4.3.2');
    expect(pkg.dependencies).not.toHaveProperty('@astrojs/tailwind');
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
