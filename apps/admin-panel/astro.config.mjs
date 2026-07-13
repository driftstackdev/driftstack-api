// @ts-check
import { defineConfig } from 'astro/config';

// Admin panel — Driftstack-staff-only surface.
// Lives at admin.driftstack.dev (separate subdomain from the customer
// dashboard at app.driftstack.dev) so security boundary is at the DNS
// + TLS layer, not application logic.
//
// Auth: Driftstack-staff API key with `driftstack_internal_admin`
// scope. Routes call /v1/admin/* on the control plane; preHandler
// enforced V-134 + V-174.
//
// Cloudflare Pages serves static output directly. Arbitrary account and
// incident ids use `_redirects` 200 rewrites to deterministic client-fetched
// shells; no Worker/SSR adapter is required.
export default defineConfig({
  site: 'https://admin.driftstack.dev',
  output: 'static',
  // Preserve Astro 5/6's HTML-aware whitespace semantics under Astro 7.
  compressHTML: true,
  build: {
    inlineStylesheets: 'auto',
  },
});
