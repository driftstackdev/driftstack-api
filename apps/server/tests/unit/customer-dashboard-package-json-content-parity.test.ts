// W526.C — drift guard for apps/customer-dashboard/package.json.
// Customer-dashboard package manifest. Pins identity + build pipeline +
// load-bearing deps. Drift here either changes a script (would break
// CI typecheck or deploy workflow), restores the unused SSR adapter,
// drops the explicit Tailwind PostCSS toolchain, or removes shared API
// types from the dashboard client.
//
//   • Name: @driftstack/customer-dashboard (monorepo-scoped).
//   • private: true (never publish to npm).
//   • type: module (ESM).
//   • 4 scripts: dev/build/preview/typecheck via astro * commands.
//   • Critical deps: @astrojs/check + @driftstack/api-types +
//     @sentry/astro + Astro 7 + Tailwind 3/PostCSS/autoprefixer +
//     TypeScript; no SSR adapter or deprecated Tailwind integration.
//   • NOTE: package version intentionally NOT pinned (unreleased
//     monorepo package, will bump with no behavioral signal).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/package.json');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W526.C apps/customer-dashboard/package.json content parity', () => {
  const body = read(LIB);
  const pkg = JSON.parse(body) as {
    name: string;
    private: boolean;
    type: string;
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
  };

  it("Package identity framing pinned: 'name: @driftstack/customer-dashboard' + 'private: true' + 'type: module' — pinned so the monorepo-scoped-name + never-publish-to-npm + ESM commitment survives", () => {
    expect(pkg.name).toBe('@driftstack/customer-dashboard');
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
  });

  it('4-script build pipeline framing pinned with customer dev port 5173 matching DASHBOARD_ORIGIN and the desktop activation capability', () => {
    expect(pkg.scripts.dev).toBe('astro dev --port 5173');
    expect(pkg.scripts.build).toBe('astro build');
    expect(pkg.scripts.preview).toBe('astro preview');
    expect(pkg.scripts.typecheck).toBe('astro check');
  });

  it('pins the static Astro 7 + explicit Tailwind PostCSS dependency set and retains shared types and Sentry telemetry', () => {
    expect(pkg.dependencies).toHaveProperty('@astrojs/check');
    expect(pkg.dependencies).not.toHaveProperty('@astrojs/cloudflare');
    expect(pkg.dependencies).not.toHaveProperty('@astrojs/tailwind');
    expect(pkg.dependencies).toMatchObject({ autoprefixer: '10.5.2', postcss: '8.5.28' });
    expect(pkg.dependencies).toHaveProperty('@driftstack/api-types');
    expect(pkg.dependencies).toHaveProperty('@sentry/astro');
    expect(pkg.dependencies.astro).toBe('7.1.6');
    expect(pkg.dependencies.tailwindcss).toBe('3.4.19');
    expect(pkg.dependencies).toHaveProperty('typescript');
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
