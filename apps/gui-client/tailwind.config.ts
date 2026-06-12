import type { Config } from 'tailwindcss';

// Driftstack brand identity (locked per file 128).
//   - Slate base: neutral surface palette built around Tailwind's
//     slate scale, biased dark-mode-first since the GUI client is a
//     desktop ops tool, not a marketing surface.
//   - Oxblood accent: the only highlight color; reserved for action
//     surfaces (primary buttons, live indicators, danger affordances).
//   - Geist Sans for body / UI; Berkeley Mono for technical accents
//     (session ids, command output, request/response previews,
//     anywhere the Mac mini fleet's actual addresses appear).

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // Fleet rework: dark: variants + the semantic palette follow the
  // data-mode axis (see styles/index.css token layer).
  darkMode: ['selector', '[data-mode="dark"]'],
  theme: {
    extend: {
      colors: {
        // Slate palette mapped to semantic tokens. The GUI uses these,
        // not raw `slate-*` references, so a future palette tweak
        // doesn't require touching every component.
        // Fleet rework (2026-06-12): every semantic color resolves to the
        // two-axis CSS custom properties in styles/index.css, so the whole
        // GUI flips with <html data-mode>/<html data-accent>. rgb()/<alpha>
        // form keeps alpha modifiers (bg-status-error/10 etc) working.
        surface: {
          base: 'rgb(var(--surface-base-rgb) / <alpha-value>)',
          raised: 'rgb(var(--surface-raised-rgb) / <alpha-value>)',
          elevated: 'rgb(var(--surface-elevated-rgb) / <alpha-value>)',
          inset: 'rgb(var(--surface-inset-rgb) / <alpha-value>)',
          divider: 'rgb(var(--surface-divider-rgb) / <alpha-value>)',
        },
        ink: {
          primary: 'rgb(var(--ink-primary-rgb) / <alpha-value>)',
          secondary: 'rgb(var(--ink-secondary-rgb) / <alpha-value>)',
          muted: 'rgb(var(--ink-muted-rgb) / <alpha-value>)',
          inverted: 'rgb(var(--ink-inverted-rgb) / <alpha-value>)',
        },
        accent: {
          // Follows the data-accent axis (violet default per the rework).
          DEFAULT: 'rgb(var(--accent-rgb) / <alpha-value>)',
          hover: 'rgb(var(--accent-hover-rgb) / <alpha-value>)',
          active: 'rgb(var(--accent-active-rgb) / <alpha-value>)',
          // soft selected-row wash: accent at a mode-tuned alpha
          subtle: 'rgb(var(--accent-subtle-rgb) / var(--accent-subtle-alpha))',
          ring: 'var(--accent-ring)', // focus ring
        },
        status: {
          ready: 'rgb(var(--status-ready-rgb) / <alpha-value>)',
          busy: 'rgb(var(--status-busy-rgb) / <alpha-value>)',
          error: 'rgb(var(--status-error-rgb) / <alpha-value>)',
          idle: 'rgb(var(--status-idle-rgb) / <alpha-value>)',
          // aliases — components already use these names; they were
          // silently UNDEFINED pre-rework (no-op classes). Mapped to the
          // ready/busy hues they were visually intended as.
          success: 'rgb(var(--status-ready-rgb) / <alpha-value>)',
          warning: 'rgb(var(--status-busy-rgb) / <alpha-value>)',
        },
      },
      fontFamily: {
        // Geist Sans for body. Pulled from the Geist npm package or
        // self-hosted in /public/fonts. Falls back through a sensible
        // OS stack so first paint isn't blank if the font hasn't loaded.
        sans: [
          'Geist Sans',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'system-ui',
          'sans-serif',
        ],
        // Berkeley Mono for technical accents. Premium licensed font;
        // the brand-id package will provide it. Fall back to a credible
        // mono stack so dev installs without the licensed font still
        // look correct in shape.
        mono: [
          'Berkeley Mono',
          'JetBrains Mono',
          'Menlo',
          'Monaco',
          'Consolas',
          'Liberation Mono',
          'monospace',
        ],
      },
      fontSize: {
        // Compact-by-default sizes — the GUI is dense ops UI, not docs.
        '2xs': ['0.625rem', { lineHeight: '0.875rem' }],
      },
      borderRadius: {
        // Tighter corners than the Tailwind defaults — matches the
        // Berkeley-Mono / engineering-tool aesthetic.
        DEFAULT: '0.25rem',
        lg: '0.375rem',
      },
      ringWidth: {
        DEFAULT: '1px',
      },
    },
  },
  plugins: [],
} satisfies Config;
