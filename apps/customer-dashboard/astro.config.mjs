// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import cloudflare from '@astrojs/cloudflare';

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
export default defineConfig({
  site: 'https://app.driftstack.dev',
  output: 'static',
  adapter: cloudflare({
    platformProxy: { enabled: false },
  }),
  integrations: [tailwind({ applyBaseStyles: false })],
  build: {
    inlineStylesheets: 'auto',
  },
});
