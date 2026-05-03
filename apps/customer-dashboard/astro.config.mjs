// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

// Customer dashboard for app.driftstack.dev. Static-build per the
// dashboard-stack proposal in docs/architecture/customer-dashboard-stack.md
// (pending founder review of Option A — Astro + React islands shared with
// marketing site). When founder approves, React islands land alongside;
// for now the scaffolding is pure-Astro static.
//
// Cloudflare Pages serves dist/ directly. Auth-flow pages POST to the
// control plane at /v1/auth/* per V-079.
export default defineConfig({
  site: 'https://app.driftstack.dev',
  output: 'static',
  integrations: [tailwind({ applyBaseStyles: false })],
  build: {
    inlineStylesheets: 'auto',
  },
});
