/** @type {import('tailwindcss').Config} */

// Design tokens shared with the marketing site (apps/marketing-site/
// tailwind.config.mjs). Keep these synchronised — the customer
// experience reads as one product, not two.

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
          base: '#0b0f14',
          raised: '#111722',
          elevated: '#1a2230',
          inset: '#070a0e',
          divider: '#1f2937',
        },
        ink: {
          primary: '#e5e7eb',
          secondary: '#9ca3af',
          muted: '#6b7280',
          inverted: '#0b0f14',
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
        'glow-red': '0 0 0 1px rgba(226, 56, 71, 0.35), 0 8px 24px -8px rgba(226, 56, 71, 0.45)',
        'glow-red-lg': '0 0 0 1px rgba(226, 56, 71, 0.5), 0 16px 48px -12px rgba(226, 56, 71, 0.6)',
        'inset-divider': 'inset 0 1px 0 rgba(255, 255, 255, 0.04)',
      },
      backgroundImage: {
        'glow-radial-red':
          'radial-gradient(ellipse 70% 50% at 50% 0%, rgba(226, 56, 71, 0.18), transparent 70%)',
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
