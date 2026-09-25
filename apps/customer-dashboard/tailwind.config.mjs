/** @type {import('tailwindcss').Config} */

// Design tokens shared with every Driftstack surface, from one package:
// packages/design-tokens (the desktop app's own theme). The preset supplies the
// colours (the canonical surface-* / ink-* / accent-* / status-* groups and the
// tk-* names the dashboard markup uses), the radius scale, the font stacks,
// text-2xs, the lift/float shadows and the easing — so the customer experience
// reads as one product with the app, not a copy of it that drifts.
//
// 2026-09-25 — the dashboard's own hand-kept sets are gone: the legacy slate
// palette, the dark-only `surface` / `ink` sets (they collided with the
// canonical names the preset now provides), the `glow` reds (retired with
// every off-brand red) and the local tk-* table. Only the web's
// atmosphere (glow-accent, the radial washes) and motion stay here.

import preset from '@driftstack/design-tokens/tailwind-preset';

export default {
  presets: [preset],
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}'],
  theme: {
    extend: {
      maxWidth: {
        prose: '65ch',
      },
      boxShadow: {
        // Accent-aware glow for genuinely "hot" elements only — never default
        // card/button chrome. --glow is derived from the accent (base.css).
        'glow-accent': '0 0 0 1px var(--accent), 0 0 26px var(--glow)',
      },
      backgroundImage: {
        // Calm ambient radials for the auth/onboarding surfaces, drawn from the
        // accent at a low alpha. The top one reads --glow. The lower one is
        // half the app's soft-accent alpha (0.06 light, 0.125 dark): the full
        // --accent-soft is a nav-row wash, twice as strong in dark as the old
        // web glow. It is centred inside its own box and fades out before any
        // edge, so it never ends in a straight line (the box is fixed to the
        // first viewport, which a full-page capture shows mid-page).
        'glow-radial-accent':
          'radial-gradient(ellipse 55% 38% at 50% 0%, var(--glow), transparent 60%)',
        'glow-radial-accent-soft':
          'radial-gradient(ellipse 45% 38% at 50% 70%, rgb(var(--accent-rgb) / calc(var(--accent-subtle-alpha) / 2)), transparent 65%)',
      },
      animation: {
        'fade-up': 'fade-up 0.6s ease-out',
        'view-in': 'view-in 0.15s ease-out',
        livepulse: 'livepulse 2.4s ease-in-out infinite',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        // View/panel entrance (GUI ds-view-in port).
        'view-in': {
          '0%': { opacity: '0', transform: 'translateY(3px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        // Live-status dot breathe (killed by the global prefers-reduced-motion
        // clamp in base.css).
        livepulse: {
          '0%, 100%': { boxShadow: '0 0 0 0 var(--glow)' },
          '50%': { boxShadow: '0 0 0 4px var(--glow)' },
        },
      },
    },
  },
  plugins: [],
};
