// @ts-check
import { defineConfig } from 'astro/config';

// V-295c — public service status page.
//
// Static Astro output served from Cloudflare Pages at status.driftstack.dev.
// At runtime the page fetches `https://api.driftstack.dev/v1/status/incidents`
// and renders. No build-time fetch — keeps the build hermetic and decoupled
// from the API's availability.
export default defineConfig({
  site: 'https://status.driftstack.dev',
  output: 'static',
  // Tailwind v4 via the PostCSS plugin (postcss.config.mjs) — decoupled from
  // Astro's bundled Vite version (the @tailwindcss/vite plugin breaks in this
  // monorepo while astro 5 + 6 coexist: createIdResolver Vite-version conflict).
  build: {
    inlineStylesheets: 'auto',
  },
});
