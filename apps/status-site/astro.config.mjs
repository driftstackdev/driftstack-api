// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// V-295c — public service status page.
//
// Static Astro output served from Cloudflare Pages at status.driftstack.io.
// At runtime the page fetches `https://api.driftstack.dev/v1/status/incidents`
// and renders. No build-time fetch — keeps the build hermetic and decoupled
// from the API's availability.
export default defineConfig({
  site: 'https://status.driftstack.io',
  output: 'static',
  // Preserve Astro 6's HTML-aware whitespace semantics under Astro 7.
  compressHTML: true,
  vite: {
    plugins: [tailwindcss()],
  },
  build: {
    inlineStylesheets: 'auto',
  },
});
