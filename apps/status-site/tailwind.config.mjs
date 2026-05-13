/** @type {import('tailwindcss').Config} */

// R13 — status-site graphite palette synced with marketing-site +
// customer-dashboard + docs. Customers landing on status.driftstack.dev
// during an incident shouldn't experience a brand-jarring light theme
// when the rest of the product is dark.
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Oxblood accent — matches marketing-site + admin-panel.
        oxblood: {
          50: '#fbf3f4',
          100: '#f5e1e3',
          200: '#ebbfc4',
          300: '#dc939c',
          400: '#c8606e',
          500: '#a83b4d',
          600: '#8d2c3e',
          700: '#722F37',
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
        surface: {
          base: '#0f172a',
          raised: '#1e293b',
          elevated: '#334155',
          inset: '#020617',
          divider: '#475569',
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
    },
  },
};
