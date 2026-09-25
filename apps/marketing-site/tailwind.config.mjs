// V-254 — typography plugin imported at top-level so the config
// itself stays synchronous (Tailwind's config loader expects a sync
// default export).
import typography from '@tailwindcss/typography';
// 2026-09-25 — the shared design tokens: the desktop app's palette (both
// modes), the tk-* colour names the markup uses, the app's radius scale
// (4 / 6 / 12 / 16 / full; rounded-card is 12px), the Geist + mono stacks and
// the lift/float shadows (shadow-ambient / shadow-ambient-lg are their
// aliases). Every colour reads a CSS variable from tokens.css, which
// styles/base.css imports, so it follows <html data-mode>.
import tokens from '@driftstack/design-tokens/tailwind-preset';

/** @type {import('tailwindcss').Config} */
export default {
  presets: [tokens],
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}'],
  // Fleet rework: dark: variants follow the data-mode axis (not a .dark class).
  // The preset says the same; restated so this file reads on its own.
  darkMode: ['selector', '[data-mode="dark"]'],
  theme: {
    extend: {
      // Colours, radii (rounded-card included), fonts and the ambient
      // shadows come from the preset above; what follows is this site's own.
      maxWidth: {
        prose: '65ch',
      },
      boxShadow: {
        // Fleet: accent-aware glow that follows the data-accent axis.
        // Reserved for "hot" elements (live dots, active states) — the
        // v2 kit uses ambient shadows for buttons/cards.
        'glow-accent': '0 0 0 1px var(--accent), 0 0 26px var(--glow)',
        'inset-divider': 'inset 0 1px 0 rgba(255, 255, 255, 0.06)',
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
      // `prose-tk` — the ONE prose recipe (2026-09-25): every long-form page
      // (the /docs/* references, /pricing/crypto, the legal pages through
      // LegalLayout) reads the typography plugin's colours from the tokens,
      // so it follows data-mode with no `dark:prose-invert` and no second
      // palette (it replaces prose-slate). Body in ink-2, headings and bold in
      // ink, links in the AA-safe accent-text (never the rose accent-2),
      // inline code as a small inset chip without the plugin's backticks, and
      // code blocks on the dark island (--code-bg / --code-ink, base.css).
      typography: {
        tk: {
          css: {
            '--tw-prose-body': 'rgb(var(--ink-2-rgb))',
            '--tw-prose-headings': 'rgb(var(--ink-rgb))',
            '--tw-prose-lead': 'rgb(var(--ink-2-rgb))',
            '--tw-prose-links': 'rgb(var(--accent-text-rgb))',
            '--tw-prose-bold': 'rgb(var(--ink-rgb))',
            '--tw-prose-counters': 'rgb(var(--ink-3-rgb))',
            '--tw-prose-bullets': 'rgb(var(--ink-3-rgb))',
            '--tw-prose-hr': 'rgb(var(--border-rgb))',
            '--tw-prose-quotes': 'rgb(var(--ink-2-rgb))',
            '--tw-prose-quote-borders': 'rgb(var(--accent-rgb))',
            '--tw-prose-captions': 'rgb(var(--ink-3-rgb))',
            '--tw-prose-kbd': 'rgb(var(--ink-rgb))',
            '--tw-prose-kbd-shadows': 'var(--ink-rgb)',
            '--tw-prose-code': 'rgb(var(--ink-rgb))',
            '--tw-prose-pre-code': 'var(--code-ink)',
            '--tw-prose-pre-bg': 'var(--code-bg)',
            '--tw-prose-th-borders': 'rgb(var(--border-rgb))',
            '--tw-prose-td-borders': 'rgb(var(--border-rgb))',
            'h1, h2, h3, h4': { fontWeight: '600', letterSpacing: '-0.01em' },
            a: { textUnderlineOffset: '4px', fontWeight: '500' },
            'a:hover': { textDecorationThickness: '2px' },
            code: {
              backgroundColor: 'rgb(var(--hover-rgb))',
              borderRadius: '0.25rem',
              padding: '0.125rem 0.375rem',
              fontWeight: '500',
            },
            'code::before': { content: 'none' },
            'code::after': { content: 'none' },
            pre: { borderRadius: '0.75rem' },
            // Long-form text must fit a phone rather than run past the clipped
            // page edge: a long URL (the privacy policy's DPF list link) breaks
            // where it would overflow. A table too wide for the column (its
            // 4-column sub-processor list) scrolls inside its own box instead
            // of breaking words mid-way (base.css .prose-tk table; BaseLayout
            // gives it a tab stop while it scrolls).
            overflowWrap: 'break-word',
            'pre code': { backgroundColor: 'transparent', padding: '0', fontWeight: '400' },
          },
        },
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
