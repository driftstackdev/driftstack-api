// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

// Admin panel — Driftstack-staff-only surface.
// Lives at admin.driftstack.dev (separate subdomain from the customer
// dashboard at app.driftstack.dev) so security boundary is at the DNS
// + TLS layer, not application logic.
//
// Auth: Driftstack-staff API key with `admin` scope. Routes call
// /v1/admin/* on the control plane; preHandler enforced V-134.
//
// Static-build per the same posture as customer-dashboard. Cloudflare
// Pages serves dist/. Future: Cloudflare Access or similar SSO gate
// at the Pages level for a second auth layer.
export default defineConfig({
  site: 'https://admin.driftstack.dev',
  output: 'static',
  integrations: [tailwind({ applyBaseStyles: false })],
  build: {
    inlineStylesheets: 'auto',
  },
});
