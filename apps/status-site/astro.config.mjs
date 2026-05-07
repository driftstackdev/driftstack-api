// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

// V-295c — public service status page.
//
// Static Astro output served from Cloudflare Pages at status.driftstack.dev.
// At runtime the page fetches `https://api.driftstack.dev/v1/status/incidents`
// and renders. No build-time fetch — keeps the build hermetic and decoupled
// from the API's availability.
export default defineConfig({
  site: 'https://status.driftstack.dev',
  output: 'static',
  integrations: [tailwind({ applyBaseStyles: false })],
  build: {
    inlineStylesheets: 'auto',
  },
});
