// V-254 — typography plugin imported at top-level so the config
// itself stays synchronous (Tailwind's config loader expects a sync
// default export).
import typography from '@tailwindcss/typography';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Oxblood — locked accent per founder direction (#722F37).
        // Primary brand color; appears on buttons, accent rules, hover states.
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
        // R7 — "graphite" surface palette. Lighter than the previous
        // near-black abyss to address "kinda too dark" customer feedback
        // while keeping the dark identity. Class names unchanged so
        // every doc-parity test continues to pass.
        surface: {
          base: '#0f172a', // slate-900 — main page background
          raised: '#1e293b', // slate-800 — cards
          elevated: '#334155', // slate-700 — elevated callouts
          inset: '#020617', // slate-950 — code blocks (stays deepest for contrast)
          divider: '#475569', // slate-600 — visible separator lines
        },
        ink: {
          primary: '#f8fafc', // slate-50 — body headings
          secondary: '#cbd5e1', // slate-300 — body copy (much more readable than -400)
          muted: '#94a3b8', // slate-400 — supporting captions
          inverted: '#0f172a',
        },
        // Brighter live-red used for glow + hover lifts. Layered on
        // top of oxblood-700 so the brand-locked accent stays the
        // primary saturated color while highlights pop against dark.
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
        // Red-glow ring used on primary CTAs + accent borders.
        'glow-red': '0 0 0 1px rgba(226, 56, 71, 0.3), 0 6px 20px -8px rgba(226, 56, 71, 0.35)',
        'glow-red-lg': '0 0 0 1px rgba(226, 56, 71, 0.4), 0 12px 40px -12px rgba(226, 56, 71, 0.5)',
        'inset-divider': 'inset 0 1px 0 rgba(255, 255, 255, 0.06)',
      },
      backgroundImage: {
        // Grid pattern + radial glow used on dark surfaces.
        'grid-faint':
          'linear-gradient(to right, rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.04) 1px, transparent 1px)',
        'glow-radial-red':
          'radial-gradient(ellipse 70% 50% at 50% 0%, rgba(226, 56, 71, 0.18), transparent 70%)',
        'glow-radial-red-soft':
          'radial-gradient(ellipse 60% 40% at 50% 100%, rgba(114, 47, 55, 0.22), transparent 75%)',
        'gradient-accent': 'linear-gradient(135deg, #722F37 0%, #e23847 100%)',
      },
      backgroundSize: {
        'grid-faint': '40px 40px',
      },
      animation: {
        'pulse-glow': 'pulse-glow 4s ease-in-out infinite',
        'fade-up': 'fade-up 0.6s ease-out',
        marquee: 'marquee 30s linear infinite',
      },
      keyframes: {
        'pulse-glow': {
          '0%, 100%': { opacity: '0.5' },
          '50%': { opacity: '0.85' },
        },
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        marquee: {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(-50%)' },
        },
      },
    },
  },
  // V-254 — typography plugin enables `prose` classes for markdown
  // content rendering in DocLayout.astro.
  plugins: [typography],
};
