// V-254 — typography plugin imported at top-level so the config
// itself stays synchronous (Tailwind's config loader expects a sync
// default export).
import typography from '@tailwindcss/typography';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}'],
  // Fleet rework: dark: variants follow the data-mode axis (not a .dark class).
  darkMode: ['selector', '[data-mode="dark"]'],
  theme: {
    extend: {
      colors: {
        // 2026-07-03 — legacy baked palettes RETIRED (Fleet v2 port). The
        // oxblood ladder ("locked accent per founder direction, #722F37"),
        // slate ladder, graphite surface/ink sets, and glow reds are gone:
        // every page consumes the two-axis tk-* tokens below, and the locked
        // #722F37 accent lives on as --accent-strong in the
        // [data-accent='oxblood'] axis (styles/base.css) per the 2026-06-15
        // "Fleet Mission Control — Dark + Red" verdict. The custom slate
        // ladder was byte-identical to Tailwind 3's built-in slate, so stock
        // slate-* utilities in legacy markup render unchanged.
        //
        // Fleet token namespace (2026-06-12 rework — see
        // docs/internal/2026-06-12-design-system-spec.md). Resolves to the
        // two-axis CSS custom properties in styles/base.css, so tk-* classes
        // flip with <html data-mode>/<html data-accent>.
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
          // AA-safe accent-toned TEXT (mode × accent pair; see base.css).
          'accent-text': 'var(--accent-text)',
        },
      },
      borderRadius: {
        // Fleet card radius (spec §3: 12–16px cards; blueprint uses 14px).
        card: '14px',
      },
      fontFamily: {
        sans: ['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['Berkeley Mono', 'JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      maxWidth: {
        prose: '65ch',
      },
      boxShadow: {
        // Fleet: accent-aware glow that follows the data-accent axis.
        // Reserved for "hot" elements (live dots, active states) — the
        // v2 kit uses ambient shadows for buttons/cards.
        'glow-accent': '0 0 0 1px var(--accent), 0 0 26px var(--glow)',
        'inset-divider': 'inset 0 1px 0 rgba(255, 255, 255, 0.06)',
        // Fleet v2 — calm ambient card shadows (replace glow-on-everything).
        ambient: '0 1px 2px rgb(15 16 20 / 0.04), 0 10px 28px -18px rgb(15 16 20 / 0.12)',
        'ambient-lg': '0 2px 4px rgb(15 16 20 / 0.05), 0 24px 56px -24px rgb(15 16 20 / 0.2)',
      },
      backgroundImage: {
        // Fleet v2 — calmer accent-aware ambient radials (follow the
        // data-accent axis): tighter ellipses + earlier fade-out than the
        // pre-rework versions so light mode reads clean and dark mode
        // loses the heavy wash. (Baked glow-radial-red variants retired
        // 2026-07-03 with the legacy palettes.)
        'glow-radial-accent':
          'radial-gradient(ellipse 55% 38% at 50% 0%, var(--glow), transparent 60%)',
        'glow-radial-accent-soft':
          'radial-gradient(ellipse 60% 40% at 50% 100%, var(--accent-soft), transparent 75%)',
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
  // V-254 — typography plugin enables `prose` classes for markdown
  // content rendering in DocLayout.astro.
  plugins: [typography],
};
