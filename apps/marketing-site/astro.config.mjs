// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

// Static site (Astro's default output) — Cloudflare Pages serves the
// `dist/` directory directly. No SSR, no Workers, no edge functions.
// Forms post to a separate API endpoint when forms land (Workstream C
// admin panel handles inbound form submissions).
export default defineConfig({
  site: 'https://driftstack.dev',
  output: 'static',
  integrations: [tailwind({ applyBaseStyles: false })],
  build: {
    inlineStylesheets: 'auto',
  },
});
