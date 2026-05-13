// W527.C — drift guard for apps/admin-panel/package.json.
// Admin-panel package manifest. Pins identity + build pipeline + load-
// bearing deps. Drift here either drops @astrojs/cloudflare (would
// silently break V-200 SSR for /accounts/[id]) or drops
// @driftstack/api-types (would un-type the admin's API client calls
// and risk silently routing admin actions through wrong endpoints).
//
//   • Name: @driftstack/admin-panel (monorepo-scoped, staff-only).
//   • private: true (NEVER publish — staff-only surface).
//   • type: module.
//   • 4 scripts: dev/build/preview/typecheck via astro * commands.
//   • Critical deps: @astrojs/check + @astrojs/cloudflare (V-200) +
//     @astrojs/tailwind + @driftstack/api-types + astro + tailwindcss
//     + typescript.
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

  it("4-script build pipeline framing pinned: 'dev: astro dev' + 'build: astro build' + 'preview: astro preview' + 'typecheck: astro check' — pinned so the 4-script pipeline commitment survives", () => {
    expect(pkg.scripts.dev).toBe('astro dev');
    expect(pkg.scripts.build).toBe('astro build');
    expect(pkg.scripts.preview).toBe('astro preview');
    expect(pkg.scripts.typecheck).toBe('astro check');
  });

  it('Critical-dep set + Sentry-absent framing pinned: @astrojs/check + @astrojs/cloudflare (V-200 SSR adapter) + @astrojs/tailwind + @driftstack/api-types (shared monorepo types) + astro + tailwindcss + typescript — pinned so the load-bearing dep set survives AND admin-panel intentionally excludes @sentry/astro (staff-only surface, no customer error telemetry) — drift to adding @sentry/astro on admin-panel would route staff error data through customer telemetry pipelines', () => {
    expect(pkg.dependencies).toHaveProperty('@astrojs/check');
    expect(pkg.dependencies).toHaveProperty('@astrojs/cloudflare');
    expect(pkg.dependencies).toHaveProperty('@astrojs/tailwind');
    expect(pkg.dependencies).toHaveProperty('@driftstack/api-types');
    expect(pkg.dependencies).toHaveProperty('astro');
    expect(pkg.dependencies).toHaveProperty('tailwindcss');
    expect(pkg.dependencies).toHaveProperty('typescript');
    expect(pkg.dependencies).not.toHaveProperty('@sentry/astro');
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
