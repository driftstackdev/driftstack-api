// Tailwind v4 via PostCSS (decoupled from Astro's bundled Vite — the
// @tailwindcss/vite plugin breaks while astro 5 + 6 coexist in this monorepo).
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
