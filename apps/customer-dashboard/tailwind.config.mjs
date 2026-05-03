/** @type {import('tailwindcss').Config} */

// Design tokens shared with the marketing site (apps/marketing-site/
// tailwind.config.mjs). Keep these synchronised — the customer
// experience reads as one product, not two.

export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Oxblood — locked accent per founder direction (#722F37).
        oxblood: {
          50: '#fbf3f4',
          100: '#f5e1e3',
          200: '#ebbfc4',
          300: '#dc939c',
          400: '#c8606e',
          500: '#a83b4d',
          600: '#8d2c3e',
          700: '#722F37', // base — primary accent, locked
          800: '#5e2730',
          900: '#4f242b',
          950: '#2b0f15',
        },
        slate: {
          50: '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
          400: '#94a3b8',
          500: '#64748b',
          600: '#475569',
          700: '#334155',
          800: '#1e293b',
          900: '#0f172a',
          950: '#020617',
        },
      },
      fontFamily: {
        sans: ['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['Berkeley Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      maxWidth: {
        prose: '65ch',
      },
    },
  },
  plugins: [],
};
