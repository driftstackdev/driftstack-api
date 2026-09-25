#!/usr/bin/env node
// @driftstack/design-tokens — the generator.
//
// tokens.json holds the only hand-edited values. This file turns them into the
// five outputs every surface imports, and commits them (dist/ is tracked on
// purpose: no deploy workflow needs a build step, and a reviewer sees the exact
// CSS a token change ships):
//
//   dist/tokens.css          the canonical tokens on the desktop app's two axes:
//                            [data-accent='oxblood'] and [data-mode='light'|'dark'],
//                            each colour as an `r g b` triplet (--x-rgb) AND as
//                            hex (--x); plus the lift/float shadows, the island
//                            colour and the house easing.
//   dist/web-aliases.css     the web's existing names (--bg, --ink-2, --accent-soft,
//                            …, the ones the tk-* classes were built on) as aliases
//                            of the canonical tokens, so no markup has to be renamed.
//   dist/tailwind-preset.mjs Tailwind v3 preset: the canonical colour groups, the
//                            tk-* colours, radii, fonts, the 2xs size, shadows, easing.
//   dist/theme-v4.css        the same for Tailwind v4, as an `@theme inline` block.
//   dist/hex.mjs (+ .d.mts)  flat hex constants for code that cannot use CSS
//                            variables: email HTML, the errors site's inline CSS.
//
// Usage (repo root):
//   node packages/design-tokens/build.mjs           write dist/
//   node packages/design-tokens/build.mjs --check   exit 1 when dist/ differs from
//                                                   what tokens.json generates (run by
//                                                   `npm run lint`)

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
export const TOKENS_PATH = join(PACKAGE_DIR, 'tokens.json');
export const DIST_DIR = join(PACKAGE_DIR, 'dist');

export const MODES = /** @type {const} */ (['light', 'dark']);

/** The colour tokens every mode defines, in output order. */
export const MODE_COLOURS = [
  'surface-base',
  'surface-raised',
  'surface-elevated',
  'surface-inset',
  'surface-divider',
  'ink-primary',
  'ink-secondary',
  'ink-muted',
  'ink-inverted',
  'status-ready',
  'status-busy',
  'status-error',
  'status-error-text',
  'status-idle',
  'accent-text',
  'island',
];

/** The colour tokens on the accent axis (the same in both modes). */
export const ACCENT_COLOURS = [
  'accent',
  'accent-hover',
  'accent-active',
  'accent-fill-hover',
  'accent-subtle',
  'on-accent',
];

/** The non-colour values every mode defines. */
const MODE_VALUES = ['accent-subtle-alpha', 'shadow-lift', 'shadow-float'];

/**
 * The web's names, each an alias of one canonical token: [web name, canonical].
 * The web surfaces were built on these (`tk-bg`, `var(--ink-2)`, …); keeping them
 * as aliases means a surface moves to the shared values without renaming a class.
 * Names the web already shares with the canonical set (--accent, --accent-rgb,
 * --accent-text) need no alias. Two web names deliberately collapse onto one token:
 * the web's "hover" and the new "inset" are both the app's inset surface, and the
 * web's *-text status tones are the app's status hues, which already clear AA as text.
 */
export const WEB_ALIASES = [
  ['bg', 'surface-base'],
  ['surface', 'surface-raised'],
  ['raised', 'surface-elevated'],
  ['hover', 'surface-inset'],
  ['inset', 'surface-inset'],
  ['border', 'surface-divider'],
  ['ink', 'ink-primary'],
  ['ink-2', 'ink-secondary'],
  ['ink-3', 'ink-muted'],
  ['accent-2', 'accent-hover'],
  ['accent-strong', 'accent-active'],
  ['accent-ink', 'on-accent'],
  ['ready', 'status-ready'],
  ['ready-text', 'status-ready'],
  ['busy', 'status-busy'],
  ['busy-text', 'status-busy'],
  ['err', 'status-error'],
  ['err-text', 'status-error-text'],
];

/**
 * The tk-* Tailwind colours: every alias, plus the canonical names the web uses
 * as-is. ⚠️ `tk-accent-hover` is the admin panel's name for the hover of an accent
 * FILL, which darkens — the app's `accent-fill-hover`. It is NOT the canonical
 * `accent-hover` (the lighter rose the app keeps for borders and rings, 3.9:1
 * under white text), and the two must not be swapped.
 */
export const TK_COLOURS = [
  ...WEB_ALIASES,
  ['accent', 'accent'],
  ['accent-fill-hover', 'accent-fill-hover'],
  ['accent-hover', 'accent-fill-hover'],
  ['accent-text', 'accent-text'],
  ['island', 'island'],
];

/** The soft accent wash: the accent at the mode's own alpha. Not a plain colour,
 *  so it takes no Tailwind alpha modifier. */
const ACCENT_SOFT = 'rgb(var(--accent-subtle-rgb) / var(--accent-subtle-alpha))';

const HEX = /^#[0-9a-f]{6}$/;

function fail(message) {
  throw new Error(`design-tokens: ${message}`);
}

/** Drop the `$comment` keys, which are documentation, not tokens. */
function values(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !k.startsWith('$')));
}

/**
 * Read and validate tokens.json. Throws — never defaults — on a missing mode, a
 * missing or extra key, or a colour that is not lowercase #rrggbb: a generator
 * that filled a gap would ship a colour nobody chose.
 */
export function loadTokens(path = TOKENS_PATH) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const accent = values(raw.accent ?? fail('no "accent" block'));
  for (const name of ACCENT_COLOURS) {
    if (!HEX.test(accent[name] ?? '')) fail(`accent.${name} is not a lowercase #rrggbb colour`);
  }
  const ringAlpha = accent['accent-ring-alpha'];
  if (typeof ringAlpha !== 'number' || ringAlpha <= 0 || ringAlpha >= 1) {
    fail('accent.accent-ring-alpha must be a number between 0 and 1');
  }
  const expectedAccent = [...ACCENT_COLOURS, 'accent-ring-alpha'].sort();
  if (JSON.stringify(Object.keys(accent).sort()) !== JSON.stringify(expectedAccent)) {
    fail(
      `accent keys are ${Object.keys(accent).sort().join(', ')}, expected ${expectedAccent.join(', ')}`,
    );
  }
  const modes = {};
  for (const mode of MODES) {
    const m = values(raw.modes?.[mode] ?? fail(`no "modes.${mode}" block`));
    for (const name of MODE_COLOURS) {
      if (!HEX.test(m[name] ?? '')) fail(`modes.${mode}.${name} is not a lowercase #rrggbb colour`);
    }
    const alpha = m['accent-subtle-alpha'];
    if (typeof alpha !== 'number' || alpha <= 0 || alpha >= 1) {
      fail(`modes.${mode}.accent-subtle-alpha must be a number between 0 and 1`);
    }
    for (const shadow of ['shadow-lift', 'shadow-float']) {
      if (typeof m[shadow] !== 'string' || m[shadow].trim() === '') {
        fail(`modes.${mode}.${shadow} must be a box-shadow value`);
      }
    }
    const expected = [...MODE_COLOURS, ...MODE_VALUES].sort();
    if (JSON.stringify(Object.keys(m).sort()) !== JSON.stringify(expected)) {
      fail(`modes.${mode} keys differ from the token list: ${Object.keys(m).sort().join(', ')}`);
    }
    modes[mode] = m;
  }
  const radius = values(raw.radius ?? fail('no "radius" block'));
  for (const [k, v] of Object.entries(radius)) {
    if (!/^(\d+(\.\d+)?rem|9999px)$/.test(v))
      fail(`radius.${k} = ${v} is not a rem value or 9999px`);
  }
  const font = values(raw.font ?? fail('no "font" block'));
  for (const k of ['sans', 'mono']) {
    if (!Array.isArray(font[k]) || font[k].length === 0) fail(`font.${k} must be a non-empty list`);
  }
  if (typeof raw.ease !== 'string' || !raw.ease.startsWith('cubic-bezier(')) {
    fail('ease must be a cubic-bezier()');
  }
  return {
    accent,
    modes,
    radius,
    font,
    fontSize: values(raw.fontSize ?? {}),
    ease: raw.ease,
  };
}

/** '#a83b4d' → '168 59 77' */
export function triplet(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' ');
}

/** 'surface-base' → 'surfaceBase' */
function camel(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/** A CSS font-family value: quote names that are not generic keywords. */
function fontFamily(list) {
  const generic =
    /^(ui-[a-z-]+|system-ui|sans-serif|serif|monospace|-apple-system|BlinkMacSystemFont)$/;
  return list.map((f) => (generic.test(f) ? f : `'${f}'`)).join(', ');
}

/** '0.375rem' → '6px' (email and inline CSS want pixels). */
function px(value) {
  return value.endsWith('rem') ? `${Number.parseFloat(value) * 16}px` : value;
}

export function accentRing(tokens) {
  const [r, g, b] = triplet(tokens.accent.accent).split(' ');
  return `rgba(${r}, ${g}, ${b}, ${tokens.accent['accent-ring-alpha']})`;
}

const HEADER = (what) =>
  `GENERATED by packages/design-tokens/build.mjs from tokens.json — do not edit.\n` +
  `   Change tokens.json and run \`node packages/design-tokens/build.mjs\`; \`--check\`\n` +
  `   (in \`npm run lint\`) fails while this file is stale.\n\n   ${what}`;

function renderTokensCss(t) {
  const lines = [];
  lines.push(
    `/* ${HEADER(
      'The canonical tokens, on the two axes the desktop app puts on <html>:\n' +
        '   data-accent (oxblood, the only accent) and data-mode (light | dark).\n' +
        '   The accent axis also applies at :root, so a page without the attribute\n' +
        '   still has an accent; a mode always needs its data-mode attribute. Every\n' +
        "   value is the app's own (tests/design-tokens-match-the-gui.test.ts).",
    )} */`,
    '',
    ":root,\n[data-accent='oxblood'] {",
  );
  for (const name of ACCENT_COLOURS) {
    lines.push(`  --${name}-rgb: ${triplet(t.accent[name])};`, `  --${name}: ${t.accent[name]};`);
  }
  lines.push(`  --accent-ring: ${accentRing(t)};`, `  --ease: ${t.ease};`, '}');
  for (const mode of MODES) {
    const m = t.modes[mode];
    lines.push('', `[data-mode='${mode}'] {`, `  color-scheme: ${mode};`);
    for (const name of MODE_COLOURS) {
      lines.push(`  --${name}-rgb: ${triplet(m[name])};`, `  --${name}: ${m[name]};`);
    }
    lines.push(
      `  --accent-subtle-alpha: ${m['accent-subtle-alpha']};`,
      `  --shadow-lift: ${m['shadow-lift']};`,
      `  --shadow-float: ${m['shadow-float']};`,
      '}',
    );
  }
  return `${lines.join('\n')}\n`;
}

function renderWebAliasesCss() {
  const lines = [
    `/* ${HEADER(
      "The web surfaces' names as aliases of the canonical tokens (import\n" +
        '   tokens.css first). Declared on EVERY [data-mode] element, not on :root: a\n' +
        '   custom property resolves its var() where it is declared, so a nested\n' +
        "   [data-mode='dark'] island has to re-declare the alias to get its own\n" +
        "   mode's value.",
    )} */`,
    '',
    '[data-mode] {',
  ];
  for (const [web, canonical] of WEB_ALIASES) {
    lines.push(`  --${web}-rgb: var(--${canonical}-rgb);`, `  --${web}: var(--${canonical});`);
  }
  lines.push(
    `  --accent-soft: ${ACCENT_SOFT};`,
    '  --shadow-ambient: var(--shadow-lift);',
    '  --shadow-ambient-lg: var(--shadow-float);',
    '  --tk-ease: var(--ease);',
    '}',
  );
  return `${lines.join('\n')}\n`;
}

/** The colour map shared by the v3 preset and the v4 theme: [group, key, value]. */
function colourEntries(alphaSuffix) {
  const c = (name) => `rgb(var(--${name}-rgb)${alphaSuffix})`;
  const entries = [];
  for (const k of ['base', 'raised', 'elevated', 'inset', 'divider']) {
    entries.push(['surface', k, c(`surface-${k}`)]);
  }
  for (const k of ['primary', 'secondary', 'muted', 'inverted']) {
    entries.push(['ink', k, c(`ink-${k}`)]);
  }
  entries.push(
    ['accent', 'DEFAULT', c('accent')],
    ['accent', 'hover', c('accent-hover')],
    ['accent', 'active', c('accent-active')],
    ['accent', 'fill-hover', c('accent-fill-hover')],
    ['accent', 'subtle', ACCENT_SOFT],
    ['accent', 'ring', 'var(--accent-ring)'],
    ['accent', 'text', c('accent-text')],
    ['accent', 'on', c('on-accent')],
    ['status', 'ready', c('status-ready')],
    ['status', 'busy', c('status-busy')],
    ['status', 'error', c('status-error')],
    ['status', 'error-text', c('status-error-text')],
    ['status', 'idle', c('status-idle')],
    // the app's own aliases for the two hues (tailwind.config.ts)
    ['status', 'success', c('status-ready')],
    ['status', 'warning', c('status-busy')],
    ['island', 'DEFAULT', c('island')],
  );
  for (const [web, canonical] of TK_COLOURS) entries.push(['tk', web, c(canonical)]);
  entries.push(['tk', 'accent-soft', ACCENT_SOFT]);
  return entries;
}

/** A JS string literal: single-quoted, or JSON-quoted when the value holds a quote. */
const q = (s) => (s.includes("'") ? JSON.stringify(s) : `'${s}'`);
const key = (k) => (/^[a-zA-Z_$][\w$]*$/.test(k) ? k : q(k));

function renderTailwindPreset(t) {
  const groups = new Map();
  for (const [group, k, v] of colourEntries(' / <alpha-value>')) {
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push([k, v]);
  }
  const colours = [...groups]
    .map(([group, entries]) =>
      entries.length === 1 && entries[0][0] === 'DEFAULT'
        ? `        ${key(group)}: ${q(entries[0][1])},`
        : `        ${key(group)}: {\n${entries.map(([k, v]) => `          ${key(k)}: ${q(v)},`).join('\n')}\n        },`,
    )
    .join('\n');
  const radius = [...Object.entries(t.radius), ['card', t.radius.xl]]
    .map(([k, v]) => `        ${key(k)}: ${q(v)},`)
    .join('\n');
  const fontSize = Object.entries(t.fontSize)
    .map(
      ([k, [size, lineHeight]]) =>
        `        ${key(k)}: [${q(size)}, { lineHeight: ${q(lineHeight)} }],`,
    )
    .join('\n');
  const list = (l) => `[${l.map(q).join(', ')}]`;
  return `/* ${HEADER(
    'Tailwind v3 preset: `presets: [preset]` in tailwind.config.mjs, with\n' +
      '   tokens.css (and web-aliases.css for hand-written CSS) imported by the\n' +
      '   stylesheet. Every colour reads a token variable, so it follows data-mode.',
  )} */

export default {
  darkMode: ['selector', '[data-mode="dark"]'],
  theme: {
    extend: {
      colors: {
${colours}
      },
      borderRadius: {
${radius}
      },
      fontFamily: {
        sans: ${list(t.font.sans)},
        mono: ${list(t.font.mono)},
      },
      fontSize: {
${fontSize}
      },
      boxShadow: {
        lift: 'var(--shadow-lift)',
        float: 'var(--shadow-float)',
        ambient: 'var(--shadow-lift)',
        'ambient-lg': 'var(--shadow-float)',
      },
      transitionTimingFunction: {
        standard: 'var(--ease)',
      },
    },
  },
};
`;
}

function renderThemeV4(t) {
  const colours = colourEntries('')
    .map(([group, k, v]) => `  --color-${group}${k === 'DEFAULT' ? '' : `-${k}`}: ${v};`)
    .join('\n');
  const radius = [...Object.entries(t.radius), ['card', t.radius.xl]]
    .map(([k, v]) => `  --radius${k === 'DEFAULT' ? '' : `-${k}`}: ${v};`)
    .join('\n');
  const fontSize = Object.entries(t.fontSize)
    .map(
      ([k, [size, lineHeight]]) =>
        `  --text-${k}: ${size};\n  --text-${k}--line-height: ${lineHeight};`,
    )
    .join('\n');
  const shadows = [
    ['lift', 'var(--shadow-lift)'],
    ['float', 'var(--shadow-float)'],
    ['ambient', 'var(--shadow-lift)'],
    ['ambient-lg', 'var(--shadow-float)'],
  ]
    .map(([name, v]) => `@utility shadow-${name} {\n  box-shadow: ${v};\n}`)
    .join('\n\n');
  return `/* ${HEADER(
    "Tailwind v4: `@import` this after `@import 'tailwindcss'`, with tokens.css\n" +
      '   (and web-aliases.css) imported too. `inline` makes each utility read the\n' +
      '   token variable where it is used, so it follows data-mode. The shadows are\n' +
      '   @utility rules, not --shadow-* theme keys: a theme key named like the\n' +
      '   token it reads would reference itself.',
  )} */

@theme inline {
${colours}
${radius}
  --font-sans: ${fontFamily(t.font.sans)};
  --font-mono: ${fontFamily(t.font.mono)};
${fontSize}
  --ease-standard: var(--ease);
}

${shadows}
`;
}

function renderHex(t) {
  const obj = (entries, indent = '  ') =>
    `{\n${entries.map(([k, v]) => `${indent}${key(k)}: ${q(v)},`).join('\n')}\n}`;
  const accent = [
    ...ACCENT_COLOURS.map((n) => [camel(n), t.accent[n]]),
    ['accentRing', accentRing(t)],
  ];
  const mode = (m) => MODE_COLOURS.map((n) => [camel(n), t.modes[m][n]]);
  const radius = Object.entries(t.radius).map(([k, v]) => [k, px(v)]);
  return `/* ${HEADER(
    'Flat constants for code that cannot use CSS variables (email HTML, inline\n' +
      '   styles). Radii are in px here.',
  )} */

export const accent = Object.freeze(${obj(accent)});

export const light = Object.freeze(${obj(mode('light'))});

export const dark = Object.freeze(${obj(mode('dark'))});

export const radius = Object.freeze(${obj(radius)});

export const font = Object.freeze(${obj([
    ['sans', fontFamily(t.font.sans)],
    ['mono', fontFamily(t.font.mono)],
  ])});

export const ease = ${q(t.ease)};
`;
}

function renderHexTypes(t) {
  const shape = (names) => `Readonly<{\n${names.map((n) => `  ${key(n)}: string;`).join('\n')}\n}>`;
  return `/* ${HEADER('Types for hex.mjs.')} */

export declare const accent: ${shape([...ACCENT_COLOURS.map(camel), 'accentRing'])};
export declare const light: ${shape(MODE_COLOURS.map(camel))};
export declare const dark: typeof light;
export declare const radius: ${shape(Object.keys(t.radius))};
export declare const font: ${shape(['sans', 'mono'])};
export declare const ease: string;
`;
}

/** Every output file, rendered in memory: { 'tokens.css': '…', … }. */
export function render(tokens = loadTokens()) {
  return {
    'tokens.css': renderTokensCss(tokens),
    'web-aliases.css': renderWebAliasesCss(),
    'tailwind-preset.mjs': renderTailwindPreset(tokens),
    'theme-v4.css': renderThemeV4(tokens),
    'hex.mjs': renderHex(tokens),
    'hex.d.mts': renderHexTypes(tokens),
  };
}

/**
 * What differs between dist/ and a fresh render: stale or missing outputs, and
 * files in dist/ that the generator does not write (a renamed output leaves one
 * behind, and an import of it would keep working on stale values).
 */
export function staleOutputs(dir = DIST_DIR, rendered = render()) {
  const problems = [];
  for (const [name, content] of Object.entries(rendered)) {
    const path = join(dir, name);
    if (!existsSync(path)) problems.push(`dist/${name} is missing`);
    else if (readFileSync(path, 'utf8') !== content) problems.push(`dist/${name} is stale`);
  }
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!(name in rendered)) problems.push(`dist/${name} is not written by the generator`);
    }
  }
  return problems;
}

function main(argv) {
  const rendered = render();
  if (argv.includes('--check')) {
    const problems = staleOutputs(DIST_DIR, rendered);
    if (problems.length > 0) {
      console.error(
        `✗ design tokens: ${problems.join('; ')}.\n  Run: node packages/design-tokens/build.mjs`,
      );
      process.exit(1);
    }
    console.log(
      `→ design tokens: dist/ matches tokens.json (${Object.keys(rendered).length} files)`,
    );
    return;
  }
  mkdirSync(DIST_DIR, { recursive: true });
  for (const [name, content] of Object.entries(rendered)) {
    writeFileSync(join(DIST_DIR, name), content);
  }
  console.log(`→ design tokens: wrote ${Object.keys(rendered).length} files to dist/`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
