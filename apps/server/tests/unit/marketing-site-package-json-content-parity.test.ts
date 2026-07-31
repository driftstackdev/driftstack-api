// W525.C — drift guard for apps/marketing-site/package.json.
// Marketing-site package manifest. Pins the package identity, build
// pipeline (4 scripts), and the load-bearing dep set. Drift here either
// changes a script (would break deploy / dev / typecheck workflow) or
// drops a critical dep (would silently disable a feature — e.g.
// removing @sentry/astro would silently disable build-time error
// telemetry per V-469).
//
//   • Name: @driftstack/marketing-site (monorepo-scoped).
//   • private: true (never publish marketing site to npm).
//   • type: module (ESM).
//   • 4 scripts: dev=astro dev / build=astro build / preview=astro
//     preview / typecheck=astro check.
//   • Critical deps: @astrojs/check + @astrojs/sitemap + @sentry/astro +
//     @tailwindcss/typography + Astro 7 + explicit Tailwind 3/PostCSS/
//     autoprefixer + TypeScript; no deprecated Astro Tailwind integration.
//
// NOTE: version field (currently '0.0.1') is intentionally NOT pinned
// since marketing-site versions are unreleased and will bump with no
// behavioral signal.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/package.json');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W525.C apps/marketing-site/package.json content parity', () => {
  const body = read(LIB);
  const pkg = JSON.parse(body) as {
    name: string;
    private: boolean;
    type: string;
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
  };

  it("Package identity framing pinned: 'name: @driftstack/marketing-site' + 'private: true' + 'type: module' — pinned so the monorepo-scoped-name + never-publish-to-npm + ESM commitment survives (drift to private:false would risk accidentally publishing the marketing site to npm)", () => {
    expect(pkg.name).toBe('@driftstack/marketing-site');
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
  });

  it('4-script build pipeline pins deterministic marketing dev port 4321', () => {
    expect(pkg.scripts.dev).toBe('astro dev --port 4321');
    expect(pkg.scripts.build).toBe('astro build');
    expect(pkg.scripts.preview).toBe('astro preview');
    expect(pkg.scripts.typecheck).toBe('astro check');
  });

  it('pins the Astro 7 + explicit Tailwind PostCSS dependency set and retains sitemap, telemetry, and prose styling', () => {
    expect(pkg.dependencies).toHaveProperty('@astrojs/check');
    expect(pkg.dependencies).toHaveProperty('@astrojs/sitemap');
    expect(pkg.dependencies).not.toHaveProperty('@astrojs/tailwind');
    expect(pkg.dependencies).toMatchObject({ autoprefixer: '10.5.2', postcss: '8.5.19' });
    expect(pkg.dependencies).toHaveProperty('@sentry/astro');
    expect(pkg.dependencies).toHaveProperty('@tailwindcss/typography');
    expect(pkg.dependencies.astro).toBe('7.1.6');
    expect(pkg.dependencies.tailwindcss).toBe('3.4.19');
    expect(pkg.dependencies).toHaveProperty('typescript');
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
