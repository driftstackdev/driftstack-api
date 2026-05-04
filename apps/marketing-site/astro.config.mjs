// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import sitemap from '@astrojs/sitemap';

// Static site (Astro's default output) — Cloudflare Pages serves the
// `dist/` directory directly. No SSR, no Workers, no edge functions.
// Forms post to a separate API endpoint when forms land (Workstream C
// admin panel handles inbound form submissions).
//
// V-106: @astrojs/sitemap auto-generates `dist/sitemap-index.xml` +
// `dist/sitemap-0.xml` from every `.astro` page in `src/pages/` (excludes
// 404.astro automatically). The companion `public/robots.txt` points
// crawlers at the sitemap.
export default defineConfig({
  site: 'https://driftstack.dev',
  output: 'static',
  integrations: [
    tailwind({ applyBaseStyles: false }),
    sitemap({
      // 404 doesn't belong in the sitemap.
      filter: (page) => !page.includes('/404'),
    }),
  ],
  build: {
    inlineStylesheets: 'auto',
  },
});
