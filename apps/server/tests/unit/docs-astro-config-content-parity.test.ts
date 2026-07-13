// W536.C — drift guard for apps/docs/astro.config.mjs.
// V-250 docs site Astro config. Drift here either changes the
// docs.driftstack.dev subdomain (would break customer-facing docs
// link discovery) or breaks the marketing-site-pattern-mirror (would
// create cross-Astro-app config drift).
//
//   • V-250 anchor + 'Driftstack docs site (docs.driftstack.dev).
//     Static Astro build deployed to Cloudflare Pages, mirroring
//     apps/marketing-site pattern. No SSR; pages are pre-rendered at
//     build time.'.
//   • site: https://docs.driftstack.dev.
//   • output: static (no SSR).
//   • Integrations: tailwind({applyBaseStyles:false}) + sitemap with
//     404 filter.
//   • build.inlineStylesheets: auto.
//   • NO Sentry integration (docs site is unlikely to surface customer
//     errors worth telemetering — V-469 cluster intentionally excluded).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/docs/astro.config.mjs');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W536.C apps/docs/astro.config.mjs content parity', () => {
  const body = read(LIB);

  it("V-250 + marketing-site-pattern-mirror framing pinned: 'V-250 — Driftstack docs site (docs.driftstack.dev). Static Astro build deployed to Cloudflare Pages, mirroring apps/marketing-site pattern. No SSR; pages are pre-rendered at build time.' + 'site: https://docs.driftstack.dev' + 'output: static' — pinned so the V-250 anchor + docs.driftstack.dev-canonical-site + Cloudflare-Pages-static + marketing-site-pattern-mirror + no-SSR-pre-rendered commitment survives", () => {
    expect(body).toMatch(/\/\/ @ts-check/);
    expect(body).toMatch(
      /\/\/ V-250 — Driftstack docs site \(docs\.driftstack\.dev\)\. Static Astro\s*\n?\s*\/\/ build deployed to Cloudflare Pages, mirroring apps\/marketing-site\s*\n?\s*\/\/ pattern\. No SSR; pages are pre-rendered at build time\./,
    );
    expect(body).toMatch(/site: 'https:\/\/docs\.driftstack\.dev',/);
    expect(body).toMatch(/output: 'static',/);
  });

  it('Sitemap + 404 filter and Tailwind 4 Vite integration are pinned', () => {
    expect(body).toMatch(/import sitemap from '@astrojs\/sitemap';/);
    expect(body).toMatch(/import tailwindcss from '@tailwindcss\/vite';/);
    expect(body).toMatch(/filter: \(page\) => !page\.includes\('\/404'\),/);
    expect(body).toMatch(/vite: \{\s*\n\s*plugins: \[tailwindcss\(\)\],/);
    expect(body).not.toMatch(/@astrojs\/tailwind/);
  });

  it('inlineStylesheets + no-Sentry framing pinned: \'inlineStylesheets: "auto"\' build option + intentional absence of @sentry/astro (docs site has no customer-error-telemetry surface worth Sentry overhead — drift to adding sentry would route docs-static-render errors through customer-facing telemetry) — pinned so the build-optimization + no-Sentry-on-docs-site commitment survives', () => {
    expect(body).toMatch(/inlineStylesheets: 'auto',/);
    expect(body).not.toMatch(/import sentry from '@sentry\/astro';/);
    expect(body).not.toMatch(/sentry\(/);
  });

  it('S22.1 shiki theme pinned: github-dark-default (AA-readable comment token #8b949e ≈ 6.2:1 on #0d1117; the old default github-dark measured ~2.9:1) — the docs code blocks stay a dark terminal in BOTH modes (founder-pinned) while comments stay readable', () => {
    expect(body).toMatch(/shikiConfig: \{\s*\n\s*theme: 'github-dark-default',/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
