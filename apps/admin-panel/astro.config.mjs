// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import cloudflare from '@astrojs/cloudflare';

// Admin panel — Driftstack-staff-only surface.
// Lives at admin.driftstack.dev (separate subdomain from the customer
// dashboard at app.driftstack.dev) so security boundary is at the DNS
// + TLS layer, not application logic.
//
// Auth: Driftstack-staff API key with `driftstack_internal_admin`
// scope. Routes call /v1/admin/* on the control plane; preHandler
// enforced V-134 + V-174.
//
// Cloudflare Pages with Workers — V-200 added the @astrojs/cloudflare
// adapter so dynamic detail routes (e.g. /accounts/[id]) can SSR for
// arbitrary live UUIDs. Pages with `prerender = true` (or unmarked
// in `output: 'static'`) still emit static HTML to dist/. Pages with
// `prerender = false` are served by the Worker at request time and
// can fetch live data per request.
export default defineConfig({
  site: 'https://admin.driftstack.dev',
  output: 'static',
  adapter: cloudflare({
    platformProxy: { enabled: false },
  }),
  integrations: [tailwind({ applyBaseStyles: false })],
  build: {
    inlineStylesheets: 'auto',
  },
});
