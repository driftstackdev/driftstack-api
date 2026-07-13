// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import cloudflare from '@astrojs/cloudflare';
import sentry from '@sentry/astro';

// Customer dashboard for app.driftstack.dev. Static-build per the
// dashboard-stack proposal in docs/architecture/customer-dashboard-stack.md
// (pending founder review of Option A — Astro + React islands shared with
// marketing site). When founder approves, React islands land alongside;
// for now the scaffolding is pure-Astro static.
//
// Cloudflare Pages serves the build output. V-200 added the
// @astrojs/cloudflare adapter so future dynamic detail routes
// (e.g. /sessions/[id], /api-keys/[id]) can SSR for arbitrary live
// UUIDs without 404ing on Cloudflare Pages. Static pages still emit
// to dist/ unmodified; only pages with `prerender = false` go
// through the Worker.
//
// Auth-flow pages POST to the control plane at /v1/auth/* per V-079.
//
// V-469 — @sentry/astro integration. Activates when
// PUBLIC_SENTRY_DSN_DASHBOARD is set at build time; skips entirely
// when unset, matching the existing API-server skip-when-empty
// posture for SENTRY_DSN. Source-map upload is a no-op when
// SENTRY_AUTH_TOKEN is unset.
const SENTRY_DSN = process.env.PUBLIC_SENTRY_DSN_DASHBOARD ?? '';
const SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN ?? '';

// Dedicated Sentry init files run in separate client/server Vite contexts.
// Keep the non-secret environment label identical in both, and let the
// Sentry build plugin inject the release so events and uploaded source maps
// cannot drift onto different release names.
process.env.PUBLIC_SENTRY_ENVIRONMENT ??= process.env.SENTRY_ENVIRONMENT ?? 'production';
process.env.SENTRY_RELEASE ??= process.env.GIT_SHA ?? 'unknown';

export default defineConfig({
  site: 'https://app.driftstack.dev',
  output: 'static',
  adapter: cloudflare({
    platformProxy: { enabled: false },
  }),
  integrations: [
    tailwind({ applyBaseStyles: false }),
    sentry({
      enabled: SENTRY_DSN.length > 0,
      project: 'driftstack-dashboard',
      org: process.env.SENTRY_ORG ?? 'driftstack',
      authToken: SENTRY_AUTH_TOKEN || undefined,
    }),
  ],
  build: {
    inlineStylesheets: 'auto',
  },
});
