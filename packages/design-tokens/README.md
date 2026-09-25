# @driftstack/design-tokens

The design tokens every Driftstack surface is built on. The values are the desktop
app's own theme: its light theme is the reference for every surface, and
`tests/design-tokens-match-the-gui.test.ts` fails whenever `tokens.json` and the app
(`apps/gui-client/src/styles/index.css`, `apps/gui-client/tailwind.config.ts`) disagree.

## What is in it

| File                       | What it is                                                                                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tokens.json`              | The only hand-edited values: both modes, the oxblood accent, the lift and float shadows, radii, fonts, the easing, and the dark island.                                                        |
| `build.mjs`                | Writes `dist/`. `--check` exits 1 when `dist/` is stale; it runs in `npm run lint`.                                                                                                            |
| `dist/tokens.css`          | The canonical tokens on the app's two axes, `data-accent='oxblood'` and `data-mode='light' \| 'dark'`, each colour as an `r g b` triplet (`--surface-base-rgb`) and as hex (`--surface-base`). |
| `dist/web-aliases.css`     | The web's existing names (`--bg`, `--ink-2`, `--accent-soft`, …) as aliases of the canonical tokens, so the `tk-*` markup keeps working.                                                       |
| `dist/tailwind-preset.mjs` | Tailwind v3 preset (marketing, dashboard, admin): the canonical colour groups, the `tk-*` colours, radii, fonts, `text-2xs`, `shadow-lift`/`shadow-float`, `ease-standard`.                    |
| `dist/theme-v4.css`        | The same for Tailwind v4 (docs, status), as an `@theme inline` block plus the shadow utilities.                                                                                                |
| `dist/hex.mjs`             | Flat hex constants for code that cannot use CSS variables (email HTML, inline styles).                                                                                                         |

## Using it

```css
/* Tailwind v3 site: base.css */
@import '@driftstack/design-tokens/tokens.css';
@import '@driftstack/design-tokens/web-aliases.css';
```

```js
// tailwind.config.mjs
import preset from '@driftstack/design-tokens/tailwind-preset';
export default { presets: [preset] /* , … */ };
```

```css
/* Tailwind v4 site */
@import 'tailwindcss';
@import '@driftstack/design-tokens/tokens.css';
@import '@driftstack/design-tokens/web-aliases.css';
@import '@driftstack/design-tokens/theme-v4.css';
```

Every colour follows `data-mode` on `<html>` (and on any nested element that sets its
own `data-mode`, such as a dark island). Light is the default mode on every surface.

## Where a text colour may sit

`tests/every-text-token-clears-aa-on-every-ground-it-may-sit-on.test.ts` holds the
placement contract and measures every allowed pair in both modes at WCAG AA (4.5:1).
The rules a surface must follow, each measured there:

- Muted ink (`ink-muted`, web `ink-3`) never sits on the elevated surface; use secondary ink.
- Muted ink sits on a wash only as the selected row's soft accent over a card.
- A status pill (status text on its own `/15` or `/20` wash) sits on a card
  (`surface-raised`), not on the page ground or the elevated surface.
- `accent-hover` (web `accent-2`) is for borders and rings, never text; accent copy is
  `accent-text`.
- Text on an accent fill is `on-accent`, never `ink-inverted`.
- The error red is a close neighbour of the brand accent (under the 25° hue gap the app
  keeps between the accent and every other status hue), so an error must never be told
  apart from the brand by hue alone.

## Changing a value

Change the app first, then `tokens.json`, in the same commit, and run
`node packages/design-tokens/build.mjs`. Commit `dist/` with it.
