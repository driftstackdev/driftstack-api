// W527.C — drift guard for apps/admin-panel/package.json.
// Admin-panel package manifest. Pins identity + build pipeline + load-
// bearing deps. Drift here either restores the retired SSR adapter,
// drops the explicit Tailwind PostCSS toolchain, or drops
// @driftstack/api-types (which would un-type the admin's API calls).
//
//   • Name: @driftstack/admin-panel (monorepo-scoped, staff-only).
//   • private: true (NEVER publish — staff-only surface).
//   • type: module.
//   • 4 scripts: dev/build/preview/typecheck via astro * commands.
//   • Critical deps: @astrojs/check + @driftstack/api-types + Astro 7 +
//     Tailwind 3/PostCSS/autoprefixer + TypeScript; no SSR adapter or
//     deprecated Astro Tailwind integration.
//   • NO @sentry/astro in admin-panel deps (unlike marketing-site +
//     customer-dashboard — staff-only surface, no customer-error
//     telemetry).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/admin-panel/package.json');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W527.C apps/admin-panel/package.json content parity', () => {
  const body = read(LIB);
  const pkg = JSON.parse(body) as {
    name: string;
    private: boolean;
    type: string;
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
  };

  it("Package identity framing pinned: 'name: @driftstack/admin-panel' + 'private: true' + 'type: module' — pinned so the staff-only monorepo-scoped-name + never-publish-to-npm + ESM commitment survives (private:false on admin-panel would risk publishing the staff-only build artifact)", () => {
    expect(pkg.name).toBe('@driftstack/admin-panel');
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
  });

  it('4-script build pipeline framing pins deterministic admin dev port 5174', () => {
    expect(pkg.scripts.dev).toBe('astro dev --port 5174');
    expect(pkg.scripts.build).toBe('astro build');
    expect(pkg.scripts.preview).toBe('astro preview');
    expect(pkg.scripts.typecheck).toBe('astro check');
  });

  it('pins the static Astro 7 + explicit Tailwind PostCSS dependency set and excludes SSR, deprecated Tailwind integration, and customer Sentry telemetry', () => {
    expect(pkg.dependencies).toHaveProperty('@astrojs/check');
    expect(pkg.dependencies).not.toHaveProperty('@astrojs/cloudflare');
    expect(pkg.dependencies).not.toHaveProperty('@astrojs/tailwind');
    expect(pkg.dependencies).toMatchObject({ autoprefixer: '10.5.2', postcss: '8.5.19' });
    expect(pkg.dependencies).toHaveProperty('@driftstack/api-types');
    expect(pkg.dependencies.astro).toBe('7.1.6');
    expect(pkg.dependencies.tailwindcss).toBe('3.4.19');
    expect(pkg.dependencies).toHaveProperty('typescript');
    expect(pkg.dependencies).not.toHaveProperty('@sentry/astro');
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
