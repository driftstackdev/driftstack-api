// W526.C — drift guard for apps/customer-dashboard/package.json.
// Customer-dashboard package manifest. Pins identity + build pipeline +
// load-bearing deps. Drift here either changes a script (would break
// CI typecheck or deploy workflow) or drops a critical dep (e.g.
// removing @astrojs/cloudflare would silently break V-200 dynamic-route
// SSR; removing @driftstack/api-types would silently un-type the
// dashboard's API client calls).
//
//   • Name: @driftstack/customer-dashboard (monorepo-scoped).
//   • private: true (never publish to npm).
//   • type: module (ESM).
//   • 4 scripts: dev/build/preview/typecheck via astro * commands.
//   • Critical deps: @astrojs/check + @astrojs/cloudflare (V-200) +
//     @astrojs/tailwind + @driftstack/api-types (shared types) +
//     @sentry/astro (V-469) + astro + tailwindcss + typescript.
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

  it("4-script build pipeline framing pinned: 'dev: astro dev' + 'build: astro build' + 'preview: astro preview' + 'typecheck: astro check' — pinned so the 4-script pipeline commitment survives (drift to a different typecheck command would break CI's dashboard-typecheck step)", () => {
    expect(pkg.scripts.dev).toBe('astro dev');
    expect(pkg.scripts.build).toBe('astro build');
    expect(pkg.scripts.preview).toBe('astro preview');
    expect(pkg.scripts.typecheck).toBe('astro check');
  });

  it("Critical-dep set framing pinned: @astrojs/check + @astrojs/cloudflare (V-200 dynamic-route SSR adapter) + @astrojs/tailwind + @driftstack/api-types (shared monorepo types so dashboard ↔ server can't drift) + @sentry/astro (V-469 build-time telemetry) + astro + tailwindcss + typescript — pinned so the load-bearing dep set survives (drift to dropping @astrojs/cloudflare silently breaks V-200 dynamic-route SSR; dropping @driftstack/api-types un-types every API call; dropping @sentry/astro silently breaks V-469 telemetry)", () => {
    expect(pkg.dependencies).toHaveProperty('@astrojs/check');
    expect(pkg.dependencies).toHaveProperty('@astrojs/cloudflare');
    expect(pkg.dependencies).toHaveProperty('@astrojs/tailwind');
    expect(pkg.dependencies).toHaveProperty('@driftstack/api-types');
    expect(pkg.dependencies).toHaveProperty('@sentry/astro');
    expect(pkg.dependencies).toHaveProperty('astro');
    expect(pkg.dependencies).toHaveProperty('tailwindcss');
    expect(pkg.dependencies).toHaveProperty('typescript');
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
