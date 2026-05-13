// V-254 — typography plugin imported at top-level so the config
// itself stays synchronous (Tailwind's config loader expects a sync
// default export).
import typography from '@tailwindcss/typography';

/** @type {import('tailwindcss').Config} */

// R11 — docs site graphite palette synced with marketing-site +
// customer-dashboard. Adds the surface / ink / glow tokens so the
// docs reads as one product with driftstack.dev rather than the
// previous light-theme context switch. Code blocks render on a
// deeper slate-950 surface for readable contrast.
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}'],
  darkMode: 'class',
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
        // Slate base — body text + surfaces.
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
        surface: {
          base: '#0f172a', // slate-900 — page body
          raised: '#1e293b', // slate-800 — cards
          elevated: '#334155', // slate-700 — elevated rows
          inset: '#020617', // slate-950 — code blocks
          divider: '#475569', // slate-600
        },
        ink: {
          primary: '#f8fafc',
          secondary: '#cbd5e1',
          muted: '#94a3b8',
          inverted: '#0f172a',
        },
        glow: {
          red: '#e23847',
          'red-soft': '#f25366',
          'red-deep': '#a8202d',
        },
      },
      fontFamily: {
        sans: ['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['Berkeley Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      maxWidth: {
        prose: '65ch',
      },
      boxShadow: {
        'glow-red': '0 0 0 1px rgba(226, 56, 71, 0.3), 0 6px 20px -8px rgba(226, 56, 71, 0.35)',
        'glow-red-lg': '0 0 0 1px rgba(226, 56, 71, 0.4), 0 12px 40px -12px rgba(226, 56, 71, 0.5)',
        'inset-divider': 'inset 0 1px 0 rgba(255, 255, 255, 0.06)',
      },
    },
  },
  // V-254 — typography plugin enables `prose` classes for markdown
  // content rendering in DocLayout.astro.
  plugins: [typography],
};
