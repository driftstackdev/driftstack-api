// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import sitemap from '@astrojs/sitemap';
import sentry from '@sentry/astro';

// Static site (Astro's default output) — Cloudflare Pages serves the
// `dist/` directory directly. No SSR, no Workers, no edge functions.
// Forms post to a separate API endpoint when forms land (Workstream C
// admin panel handles inbound form submissions).
//
// V-106: @astrojs/sitemap auto-generates `dist/sitemap-index.xml` +
// `dist/sitemap-0.xml` from every `.astro` page in `src/pages/` (excludes
// 404.astro automatically). The companion `public/robots.txt` points
// crawlers at the sitemap.
//
// V-469 — @sentry/astro integration. Activates when
// PUBLIC_SENTRY_DSN_MARKETING is set at build time; skips entirely
// when unset.
const SENTRY_DSN = process.env.PUBLIC_SENTRY_DSN_MARKETING ?? '';
const SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN ?? '';

// Dedicated Sentry init files run in separate client/server Vite contexts.
// Keep the non-secret environment label identical in both, and let the
// Sentry build plugin inject the release so events and uploaded source maps
// cannot drift onto different release names.
process.env.PUBLIC_SENTRY_ENVIRONMENT ??= process.env.SENTRY_ENVIRONMENT ?? 'production';
process.env.SENTRY_RELEASE ??= process.env.GIT_SHA ?? 'unknown';

export default defineConfig({
  site: 'https://driftstack.dev',
  output: 'static',
  integrations: [
    tailwind({ applyBaseStyles: false }),
    sitemap({
      // 404 and noindex utility routes (e.g. /newtab) don't belong
      // in the sitemap.
      filter: (page) => !page.includes('/404') && !page.includes('/newtab'),
    }),
    sentry({
      enabled: SENTRY_DSN.length > 0,
      project: 'driftstack-marketing',
      org: process.env.SENTRY_ORG ?? 'driftstack',
      authToken: SENTRY_AUTH_TOKEN || undefined,
    }),
  ],
  build: {
    inlineStylesheets: 'auto',
  },
});
