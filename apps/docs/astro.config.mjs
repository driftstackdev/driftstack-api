// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// V-250 — Driftstack docs site (docs.driftstack.io). Static Astro
// build deployed to Cloudflare Pages, mirroring apps/marketing-site
// pattern. No SSR; pages are pre-rendered at build time.
export default defineConfig({
  site: 'https://docs.driftstack.io',
  output: 'static',
  // Preserve Astro 6's HTML-aware whitespace semantics under Astro 7.
  compressHTML: true,
  vite: {
    plugins: [tailwindcss()],
  },
  integrations: [
    sitemap({
      filter: (page) => !page.includes('/404'),
    }),
  ],
  markdown: {
    // S22.1 (2026-07-06) — the default github-dark theme's comment token
    // (#6A737D on its inline #24292e block bg) measures ~2.9:1, below
    // WCAG AA; github-dark-default (GitHub's current production dark
    // code theme) keeps the founder-pinned dark-terminal look with
    // AA-readable comments (#8b949e ≈ 6.2:1 on #0d1117).
    shikiConfig: {
      theme: 'github-dark-default',
    },
  },
  build: {
    inlineStylesheets: 'auto',
  },
});
