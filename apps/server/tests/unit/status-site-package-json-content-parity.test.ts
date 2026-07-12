// W537.C — drift guard for apps/status-site/package.json.
// V-295c status-site manifest. Most-minimal Astro-app manifest in the
// monorepo: 5 deps only. Drift here either bloats the dep set
// (status-site is intentionally minimal — runtime-fetches the API,
// no build-time data) or drops a load-bearing dep.
//
//   • Name: @driftstack/status-site.
//   • private: true + type: module.
//   • 4-script Astro pipeline.
//   • Minimal-dep set: @astrojs/check + @astrojs/tailwind + astro +
//     tailwindcss + typescript (5 only — NO sitemap (status incidents
//     shouldn't be indexed), NO typography (no prose surface), NO
//     Sentry (parity with docs)).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/status-site/package.json');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W537.C apps/status-site/package.json content parity', () => {
  const body = read(LIB);
  const pkg = JSON.parse(body) as {
    name: string;
    private: boolean;
    type: string;
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
  };

  it("Identity + Astro-app shape framing pinned: 'name: @driftstack/status-site' + 'private: true' + 'type: module' + 4-script Astro pipeline — pinned so the monorepo-scoped name + standard Astro-app shape commitment survives", () => {
    expect(pkg.name).toBe('@driftstack/status-site');
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
    expect(pkg.scripts.dev).toBe('astro dev');
    expect(pkg.scripts.build).toBe('astro build');
    expect(pkg.scripts.preview).toBe('astro preview');
    expect(pkg.scripts.typecheck).toBe('astro check');
  });

  it('Minimal 5-dep set framing pinned (W368 — Tailwind v4): @astrojs/check + @tailwindcss/postcss (v4 engine via PostCSS, replaced the v3 @astrojs/tailwind integration) + astro 6 + tailwindcss 4 + typescript (exactly 5 deps, ZERO others) + NO @astrojs/sitemap (status incidents intentionally not indexed by crawlers) + NO @tailwindcss/typography (no prose surface — status-site renders dynamic incident JSON) + NO @sentry/astro (public read-only surface, no customer-error telemetry) — pinned so the minimal-5-dep + 3-intentional-omission commitment survives', () => {
    expect(pkg.dependencies).toEqual({
      '@astrojs/check': '^0.9.4',
      '@tailwindcss/postcss': '^4.3.0',
      astro: '^6.4.8',
      tailwindcss: '^4.3.0',
      typescript: '^5.7.0',
    });
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
