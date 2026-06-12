/** @type {import('tailwindcss').Config} */

// Design tokens shared with the marketing site (apps/marketing-site/
// tailwind.config.mjs). Keep these synchronised — the customer
// experience reads as one product, not two.

export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}'],
  // Fleet rework: dark: variants follow the data-mode axis.
  darkMode: ['selector', '[data-mode="dark"]'],
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
        // R7 — "graphite" palette synced with marketing-site. Lighter
        // than the prior near-black abyss so the dashboard reads as
        // less oppressive while staying brand-dark.
        surface: {
          base: '#0f172a', // slate-900
          raised: '#1e293b', // slate-800
          elevated: '#334155', // slate-700
          inset: '#020617', // slate-950 — code/diff surfaces stay deepest
          divider: '#475569', // slate-600
        },
        ink: {
          primary: '#f8fafc', // slate-50
          secondary: '#cbd5e1', // slate-300 — more readable body
          muted: '#94a3b8', // slate-400
          inverted: '#0f172a',
        },
        glow: {
          red: '#e23847',
          'red-soft': '#f25366',
          'red-deep': '#a8202d',
        },
        // Fleet token namespace (2026-06-12 rework — see
        // docs/internal/2026-06-12-design-system-spec.md); same mapping as
        // marketing-site so the two surfaces stay in lockstep.
        tk: {
          bg: 'rgb(var(--bg-rgb) / <alpha-value>)',
          surface: 'rgb(var(--surface-rgb) / <alpha-value>)',
          raised: 'rgb(var(--raised-rgb) / <alpha-value>)',
          hover: 'rgb(var(--hover-rgb) / <alpha-value>)',
          ink: 'rgb(var(--ink-rgb) / <alpha-value>)',
          'ink-2': 'rgb(var(--ink-2-rgb) / <alpha-value>)',
          'ink-3': 'rgb(var(--ink-3-rgb) / <alpha-value>)',
          border: 'rgb(var(--border-rgb) / <alpha-value>)',
          accent: 'rgb(var(--accent-rgb) / <alpha-value>)',
          'accent-2': 'rgb(var(--accent-2-rgb) / <alpha-value>)',
          'accent-strong': 'rgb(var(--accent-strong-rgb) / <alpha-value>)',
          'accent-ink': 'var(--accent-ink)',
          'accent-soft': 'var(--accent-soft)',
          ready: 'rgb(var(--ready-rgb) / <alpha-value>)',
          busy: 'rgb(var(--busy-rgb) / <alpha-value>)',
          err: 'rgb(var(--err-rgb) / <alpha-value>)',
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
        // Fleet: accent-aware glow following the data-accent axis.
        'glow-accent': '0 0 0 1px var(--accent), 0 0 26px var(--glow)',
        'glow-red-lg': '0 0 0 1px rgba(226, 56, 71, 0.4), 0 12px 40px -12px rgba(226, 56, 71, 0.5)',
        'inset-divider': 'inset 0 1px 0 rgba(255, 255, 255, 0.06)',
      },
      backgroundImage: {
        'glow-radial-red':
          'radial-gradient(ellipse 70% 50% at 50% 0%, rgba(226, 56, 71, 0.18), transparent 70%)',
        'glow-radial-accent':
          'radial-gradient(ellipse 70% 50% at 50% 0%, var(--glow), transparent 70%)',
        'glow-radial-accent-soft':
          'radial-gradient(ellipse 60% 40% at 50% 100%, var(--accent-soft), transparent 75%)',
        'glow-radial-red-soft':
          'radial-gradient(ellipse 60% 40% at 50% 100%, rgba(114, 47, 55, 0.22), transparent 75%)',
        'gradient-accent': 'linear-gradient(135deg, #722F37 0%, #e23847 100%)',
      },
      animation: {
        'fade-up': 'fade-up 0.6s ease-out',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};
