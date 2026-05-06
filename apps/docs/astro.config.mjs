// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import sitemap from '@astrojs/sitemap';

// V-250 — Driftstack docs site (docs.driftstack.dev). Static Astro
// build deployed to Cloudflare Pages, mirroring apps/marketing-site
// pattern. No SSR; pages are pre-rendered at build time.
export default defineConfig({
  site: 'https://docs.driftstack.dev',
  output: 'static',
  integrations: [
    tailwind({ applyBaseStyles: false }),
    sitemap({
      filter: (page) => !page.includes('/404'),
    }),
  ],
  build: {
    inlineStylesheets: 'auto',
  },
});
