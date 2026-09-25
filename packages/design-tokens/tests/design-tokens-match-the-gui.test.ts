// tokens.json IS the desktop app's theme — every value, both directions.
//
// The owner chose the app's light theme as the look for every surface, and
// asked that it be taken as it is: the app is the reference, this package is a
// copy of it. So the guard reads the app's own sources — the token blocks in
// apps/gui-client/src/styles/index.css and apps/gui-client/tailwind.config.ts —
// and fails when tokens.json says anything else, or when either side has a token
// the other lacks. A value can only change here by changing the app first.
//
// Until the app imports dist/tokens.css itself (the last phase of the theme
// work), this is the only thing keeping the two in step.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACCENT_COLOURS, MODE_COLOURS, MODES, accentRing, loadTokens, triplet } from '../build.mjs';
import type { Mode } from '../build.mjs';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const GUI_CSS_PATH = join(REPO, 'apps/gui-client/src/styles/index.css');
const GUI_TAILWIND_PATH = join(REPO, 'apps/gui-client/tailwind.config.ts');
const PRESET_PATH = join(REPO, 'packages/design-tokens/dist/tailwind-preset.mjs');

/** index.css with its comments removed, so a note can never pose as a value. */
const GUI_CSS = readFileSync(GUI_CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const GUI_TAILWIND = readFileSync(GUI_TAILWIND_PATH, 'utf8');
const tokens = loadTokens();

/** Every top-level block whose whole selector is `selector`, in file order. */
function blocks(selector: string): string[] {
  const escaped = selector.replace(/[[\]()'.*]/g, (c) => `\\${c}`);
  const re = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'g');
  return [...GUI_CSS.matchAll(re)].map((m) => m[1] ?? '');
}

/** The declarations of a block: custom-property name → value, whitespace collapsed. */
function declarations(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1] ?? '', (m[2] ?? '').replace(/\s+/g, ' ').trim());
  }
  return out;
}

/** The `--*-rgb` triplets of a block. */
function rgbTokens(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, value] of declarations(block)) {
    const m = /^--([a-z0-9-]+)-rgb$/.exec(name);
    if (m !== null) out.set(m[1] ?? '', value);
  }
  return out;
}

/** The first (palette) block of each axis, and every block for the mode, merged. */
const FIRST = {
  accent: blocks("[data-accent='oxblood']")[0] ?? '',
  light: blocks("[data-mode='light']")[0] ?? '',
  dark: blocks("[data-mode='dark']")[0] ?? '',
};
function allOf(mode: Mode): Map<string, string> {
  const merged = new Map<string, string>();
  for (const b of blocks(`[data-mode='${mode}']`)) {
    for (const [k, v] of declarations(b)) merged.set(k, v);
  }
  return merged;
}
const squash = (s: string): string => s.replace(/\s+/g, '');

describe('tokens.json equals the desktop app’s token blocks (apps/gui-client/src/styles/index.css)', () => {
  it('the sweep found the three palette blocks and the AI layer’s per-mode blocks', () => {
    // A parser that found nothing would pass every arm below by comparing nothing.
    expect(FIRST.accent, "[data-accent='oxblood'] block").toContain('--accent-rgb');
    expect(FIRST.light, "[data-mode='light'] block").toContain('--surface-base-rgb');
    expect(FIRST.dark, "[data-mode='dark'] block").toContain('--surface-base-rgb');
    expect(blocks("[data-mode='light']").length).toBeGreaterThanOrEqual(2);
    expect(blocks("[data-mode='dark']").length).toBeGreaterThanOrEqual(2);
  });

  it('CRITICAL the accent axis: the same six colours, each equal — and no seventh on either side', () => {
    const gui = rgbTokens(FIRST.accent);
    expect([...gui.keys()].sort()).toEqual([...ACCENT_COLOURS].sort());
    for (const name of ACCENT_COLOURS) {
      expect(triplet(tokens.accent[name]), `--${name}-rgb`).toBe(gui.get(name));
    }
    const d = declarations(FIRST.accent);
    expect(d.get('--accent')).toBe(tokens.accent.accent);
    expect(d.get('--accent-ring')).toBe(accentRing(tokens));
  });

  for (const mode of MODES) {
    it(`CRITICAL ${mode}: every colour of the app’s ${mode} palette block, each equal, both directions`, () => {
      const gui = rgbTokens(FIRST[mode]);
      // The island is the AI stage's ground, declared in the AI layer's block
      // (below), not in the palette block.
      const palette = MODE_COLOURS.filter((n) => n !== 'island');
      expect([...gui.keys()].sort()).toEqual([...palette].sort());
      for (const name of palette) {
        expect(triplet(tokens.modes[mode][name]), `${mode} --${name}-rgb`).toBe(gui.get(name));
      }
      expect(String(tokens.modes[mode]['accent-subtle-alpha'])).toBe(
        declarations(FIRST[mode]).get('--accent-subtle-alpha'),
      );
    });

    it(`${mode}: the island, lift and float are the app’s --ai-stage-rgb, --ai-lift and --ai-float`, () => {
      const all = allOf(mode);
      expect(triplet(tokens.modes[mode].island)).toBe(all.get('--ai-stage-rgb'));
      expect(tokens.modes[mode]['shadow-lift']).toBe(all.get('--ai-lift'));
      expect(tokens.modes[mode]['shadow-float']).toBe(all.get('--ai-float'));
    });
  }

  it('the light island is #0f172a — the one dark-island colour every surface keeps dark in light mode', () => {
    expect(tokens.modes.light.island).toBe('#0f172a');
    // …which is the dark theme's own ground: a lit room, not a hole.
    expect(tokens.modes.light.island).toBe(tokens.modes.dark['surface-base']);
  });

  it('the easing is the app’s --ai-ease', () => {
    const accentAxis = declarations(blocks('[data-accent]')[0] ?? '');
    expect(squash(tokens.ease)).toBe(squash(accentAxis.get('--ai-ease') ?? ''));
  });
});

describe('tokens.json equals the app’s tailwind.config.ts', () => {
  it('radius: the app’s DEFAULT and lg, and Tailwind’s own md / xl / 2xl / full that the app inherits', () => {
    const block = /borderRadius:\s*\{([^}]*)\}/.exec(GUI_TAILWIND)?.[1] ?? '';
    expect(block).toContain(`DEFAULT: '${tokens.radius.DEFAULT}'`);
    expect(block).toContain(`lg: '${tokens.radius.lg}'`);
    const requireFromGui = createRequire(join(REPO, 'apps/gui-client/package.json'));
    const defaults = (
      requireFromGui('tailwindcss/defaultTheme') as { borderRadius: Record<string, string> }
    ).borderRadius;
    for (const k of ['md', 'xl', '2xl', 'full']) {
      expect(tokens.radius[k], `radius.${k}`).toBe(defaults[k]);
    }
    // The scale the owner signed off: 4 / 6 / 12 / 16 / full.
    expect(Object.values(tokens.radius)).toEqual([
      '0.25rem',
      '0.375rem',
      '0.375rem',
      '0.75rem',
      '1rem',
      '9999px',
    ]);
  });

  it('the 2xs size, and the app’s own font stacks (recorded, not shipped to the web)', () => {
    const [size, lineHeight] = tokens.fontSize['2xs'] ?? [];
    expect(GUI_TAILWIND).toContain(`'2xs': ['${size}', { lineHeight: '${lineHeight}' }]`);
    const stack = (name: string): string[] => {
      const body = new RegExp(`${name}: \\[([^\\]]*)\\]`).exec(GUI_TAILWIND)?.[1] ?? '';
      return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
    };
    expect(tokens.font.gui?.sans).toEqual(stack('sans'));
    expect(tokens.font.gui?.mono).toEqual(stack('mono'));
    // The web keeps Geist, the family it ships (owner decision 7).
    expect(tokens.font.sans[0]).toBe('Geist');
  });

  it('CRITICAL the v3 preset’s canonical colour groups are the app’s, class for class', async () => {
    type Colours = Record<string, Record<string, string>>;
    const gui = (
      (await import(GUI_TAILWIND_PATH)) as { default: { theme: { extend: { colors: Colours } } } }
    ).default.theme.extend.colors;
    const preset = (
      (await import(PRESET_PATH)) as { default: { theme: { extend: { colors: Colours } } } }
    ).default.theme.extend.colors;
    for (const group of ['surface', 'ink', 'accent', 'status']) {
      expect(preset[group], `colors.${group}`).toEqual(gui[group]);
    }
  });
});
