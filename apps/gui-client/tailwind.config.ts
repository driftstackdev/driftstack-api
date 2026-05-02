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
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Slate palette mapped to semantic tokens. The GUI uses these,
        // not raw `slate-*` references, so a future palette tweak
        // doesn't require touching every component.
        surface: {
          base: '#0b0f14', // slate-950-ish; primary background
          raised: '#111722', // panels / cards
          elevated: '#1a2230', // popovers, dropdowns
          inset: '#070a0e', // input backgrounds
          divider: '#1f2937', // hairlines
        },
        ink: {
          primary: '#e5e7eb', // body text
          secondary: '#9ca3af', // labels, captions
          muted: '#6b7280', // disabled, placeholder
          inverted: '#0b0f14', // text on accent surfaces
        },
        accent: {
          // Oxblood — locked. Sole accent color.
          DEFAULT: '#722f37',
          hover: '#823942',
          active: '#5e252c',
          subtle: '#3a1a1f', // for soft backgrounds (selected row, etc.)
          ring: 'rgba(114, 47, 55, 0.4)', // focus ring
        },
        status: {
          ready: '#34d399', // session ready / connected
          busy: '#fbbf24', // session busy / activity
          error: '#f87171', // session errored / alerts
          idle: '#6b7280', // not running
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
