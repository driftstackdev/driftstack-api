// W525.A — drift guard for apps/marketing-site/astro.config.mjs.
// V-106 sitemap generation + V-469 Sentry integration + static-output
// commitment. Drift here either changes the Cloudflare-Pages-static
// deploy model (would invite SSR/Workers/edge-functions into a pure
// marketing site) or breaks the sitemap auto-generation (would orphan
// pages from search-engine discovery) or breaks the Sentry build-time
// opt-in (would either always-on Sentry in dev or break prod telemetry).
//
//   • Static output (Cloudflare Pages serves dist/ directly, no SSR).
//   • V-106 sitemap integration with 404 exclusion filter.
//   • V-469 @sentry/astro integration with PUBLIC_SENTRY_DSN_MARKETING
//     build-time opt-in (skips entirely when unset).
//   • Sentry tracesSampleRate: 0.05.
//   • Sentry release fallback chain: SENTRY_RELEASE → GIT_SHA → 'unknown'.
//   • Sentry org fallback: SENTRY_ORG → 'driftstack'.
//   • Sentry project: 'driftstack-marketing'.
//   • site: https://driftstack.dev.
//   • applyBaseStyles: false (Tailwind base styles applied via base.css).
//   • inlineStylesheets: 'auto'.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/astro.config.mjs');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W525.A apps/marketing-site/astro.config.mjs content parity', () => {
  const body = read(LIB);

  it("Static-output framing pinned: 'Static site (Astro's default output) — Cloudflare Pages serves the `dist/` directory directly. No SSR, no Workers, no edge functions. Forms post to a separate API endpoint when forms land (Workstream C admin panel handles inbound form submissions).' + 'site: https://driftstack.dev' + 'output: \"static\"' — pinned so the pure-static + no-SSR + no-Workers + no-edge-functions + driftstack.dev-canonical-site commitment survives (drift to SSR/output:'server' would invite client-side JS bundle into a pure-static marketing site)", () => {
    expect(body).toMatch(
      /\/\/ Static site \(Astro's default output\) — Cloudflare Pages serves the\s*\/\/ `dist\/` directory directly\. No SSR, no Workers, no edge functions\.\s*\/\/ Forms post to a separate API endpoint when forms land \(Workstream C\s*\/\/ admin panel handles inbound form submissions\)\./,
    );
    expect(body).toMatch(/site: 'https:\/\/driftstack\.dev',/);
    expect(body).toMatch(/output: 'static',/);
  });

  it("V-106 sitemap framing pinned: 'V-106: @astrojs/sitemap auto-generates `dist/sitemap-index.xml` + `dist/sitemap-0.xml` from every `.astro` page in `src/pages/` (excludes 404.astro automatically). The companion `public/robots.txt` points crawlers at the sitemap.' + sitemap import + 'filter: (page) => !page.includes(\"/404\")' — pinned so the V-106 anchor + sitemap-index.xml + sitemap-0.xml + 404-filter + robots.txt-companion commitment survives", () => {
    expect(body).toMatch(/import sitemap from '@astrojs\/sitemap';/);
    expect(body).toMatch(
      /\/\/ V-106: @astrojs\/sitemap auto-generates `dist\/sitemap-index\.xml` \+\s*\/\/ `dist\/sitemap-0\.xml` from every `\.astro` page in `src\/pages\/` \(excludes\s*\/\/ 404\.astro automatically\)\. The companion `public\/robots\.txt` points\s*\/\/ crawlers at the sitemap\./,
    );
    expect(body).toMatch(
      /\/\/ 404 and noindex utility routes \(e\.g\. \/newtab\) don't belong\s*\/\/ in the sitemap\./,
    );
    expect(body).toMatch(
      /filter: \(page\) => !page\.includes\('\/404'\) && !page\.includes\('\/newtab'\),/,
    );
  });

  it("V-469 Sentry integration framing pinned: 'V-469 — @sentry/astro integration. Activates when PUBLIC_SENTRY_DSN_MARKETING is set at build time; skips entirely when unset.' + 'const SENTRY_DSN = process.env.PUBLIC_SENTRY_DSN_MARKETING ?? \"\";' + 'const SENTRY_RELEASE = process.env.SENTRY_RELEASE ?? process.env.GIT_SHA ?? \"unknown\";' + 'const SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN ?? \"\";' — pinned so the V-469 anchor + build-time-DSN-opt-in + 3-level-release-fallback (SENTRY_RELEASE → GIT_SHA → 'unknown') + auth-token-from-env commitment survives", () => {
    expect(body).toMatch(/import sentry from '@sentry\/astro';/);
    expect(body).toMatch(
      /\/\/ V-469 — @sentry\/astro integration\. Activates when\s*\/\/ PUBLIC_SENTRY_DSN_MARKETING is set at build time; skips entirely\s*\/\/ when unset\./,
    );
    expect(body).toMatch(/const SENTRY_DSN = process\.env\.PUBLIC_SENTRY_DSN_MARKETING \?\? '';/);
    expect(body).toMatch(/const SENTRY_AUTH_TOKEN = process\.env\.SENTRY_AUTH_TOKEN \?\? '';/);
    expect(body).toMatch(
      /process\.env\.SENTRY_RELEASE \?\?= process\.env\.GIT_SHA \?\? 'unknown';/,
    );
  });

  it("Sentry integration call framing pinned: 'enabled: SENTRY_DSN.length > 0' + 'dsn: SENTRY_DSN' + 'environment: process.env.SENTRY_ENVIRONMENT ?? \"production\"' + 'release: SENTRY_RELEASE' + 'tracesSampleRate: 0.05' + 'sourceMapsUploadOptions: { project: \"driftstack-marketing\", org: process.env.SENTRY_ORG ?? \"driftstack\", authToken: SENTRY_AUTH_TOKEN }' — pinned so the DSN-length-gated-enabled + production-environment-default + 5%-trace-sample + driftstack-marketing-project + driftstack-org-default + sourcemap-upload commitment survives", () => {
    expect(body).toMatch(/enabled: SENTRY_DSN\.length > 0,/);
    expect(body).toMatch(/project: 'driftstack-marketing',/);
    expect(body).toMatch(/org: process\.env\.SENTRY_ORG \?\? 'driftstack',/);
    expect(body).toMatch(/authToken: SENTRY_AUTH_TOKEN \|\| undefined,/);
  });

  it("Tailwind applyBaseStyles:false + inlineStylesheets framing pinned: '@ts-check' + 'tailwind({ applyBaseStyles: false })' (base styles applied via src/styles/base.css instead) + 'inlineStylesheets: \"auto\"' build option — pinned so the @ts-check JSDoc-typecheck + Tailwind-no-base-styles (base.css handles them) + inline-stylesheets-auto build-optimization commitment survives", () => {
    expect(body).toMatch(/\/\/ @ts-check/);
    expect(body).not.toMatch(/@astrojs\/tailwind/);
    expect(body).toMatch(/inlineStylesheets: 'auto',/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
