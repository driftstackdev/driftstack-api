// dist/ is what build.mjs writes from tokens.json — and what it writes works.
//
// dist/ is committed (no deploy workflow runs a build step), so three things can
// go wrong between a token edit and a surface, and each has an arm here:
//
//   1. STALE: tokens.json changed and dist/ did not. `npm run lint` runs the same
//      check (`build.mjs --check`); this arm makes the suite say it too.
//   2. INVALID: tokens.json is malformed and the generator papers over it. It
//      must refuse instead — a filled gap ships a colour nobody chose.
//   3. UNUSABLE: the files are fresh but a Tailwind build cannot use them. Both
//      majors this repo ships are run here on the real outputs: v3 (marketing,
//      dashboard, admin) and v4 (docs, status), each resolved from the app that
//      builds with it.
//
// And the alias layer is held to the web's CURRENT vocabulary: every token name
// the web surfaces declare today is provided by the package or is one of the
// named web extensions, so a surface can switch its import without losing a name.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DIST_DIR,
  TK_COLOURS,
  TOKENS_PATH,
  WEB_ALIASES,
  loadTokens,
  render,
  staleOutputs,
} from '../build.mjs';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'design-tokens-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const dist = (name: string): string => readFileSync(join(DIST_DIR, name), 'utf8');
/** Every custom property a stylesheet declares. */
const declared = (css: string): Set<string> =>
  new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1] ?? ''));

describe('dist/ is what build.mjs writes from tokens.json', () => {
  it('CRITICAL every committed output equals a fresh render, and dist/ holds nothing else', () => {
    expect(staleOutputs()).toEqual([]);
    expect(Object.keys(render()).sort()).toEqual([
      'hex.d.mts',
      'hex.mjs',
      'tailwind-preset.mjs',
      'theme-v4.css',
      'tokens.css',
      'web-aliases.css',
    ]);
  });

  it('POSITIVE CONTROL — the check reports a stale file, a missing one and one it does not write', () => {
    const dir = join(scratch, 'dist');
    mkdirSync(dir, { recursive: true });
    const rendered = render();
    for (const [name, content] of Object.entries(rendered)) writeFileSync(join(dir, name), content);
    expect(staleOutputs(dir, rendered)).toEqual([]);
    writeFileSync(join(dir, 'tokens.css'), rendered['tokens.css']!.replace('#ebedf2', '#f2f3f6'));
    rmSync(join(dir, 'hex.mjs'));
    writeFileSync(join(dir, 'old-aliases.css'), '/* an output that was renamed */');
    expect(staleOutputs(dir, rendered).sort()).toEqual([
      'dist/hex.mjs is missing',
      'dist/old-aliases.css is not written by the generator',
      'dist/tokens.css is stale',
    ]);
  });
});

describe('the generator refuses a tokens.json it would have to guess about', () => {
  interface Raw {
    accent: Record<string, unknown>;
    modes: Record<'light' | 'dark', Record<string, unknown>>;
    radius: Record<string, unknown>;
  }
  const variant = (edit: (raw: Raw) => void): string => {
    const raw = JSON.parse(readFileSync(TOKENS_PATH, 'utf8')) as Raw;
    edit(raw);
    const path = join(scratch, `tokens-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify(raw));
    return path;
  };

  it('the committed file loads', () => {
    expect(loadTokens().modes.light['surface-base']).toBe('#ebedf2');
  });

  it('a colour missing from one mode, an uppercase or short hex, an unknown key, a bad alpha: each throws', () => {
    const cases: Array<[string, (raw: Raw) => void]> = [
      ['missing', (r) => delete r.modes.dark['ink-muted']],
      ['uppercase', (r) => (r.modes.light['ink-muted'] = '#5B6270')],
      ['short', (r) => (r.accent.accent = '#a34')],
      ['unknown', (r) => (r.modes.light['surface-hover'] = '#e0e3ea')],
      ['alpha', (r) => (r.modes.light['accent-subtle-alpha'] = 12)],
      ['radius', (r) => (r.radius.xl = '12px')],
    ];
    for (const [name, edit] of cases) {
      expect(() => loadTokens(variant(edit)), name).toThrow(/design-tokens:/);
    }
  });
});

describe('the outputs work in the Tailwind builds this repo ships', () => {
  const PROBE = [
    'bg-tk-bg',
    'text-tk-ink-2',
    'bg-surface-raised/50',
    'border-surface-divider',
    'bg-accent-subtle',
    'bg-tk-accent-soft',
    'text-accent-text',
    'hover:bg-accent-fill-hover',
    'rounded',
    'rounded-lg',
    'rounded-xl',
    'rounded-card',
    'shadow-lift',
    'text-2xs',
    'font-sans',
    'ease-standard',
  ];

  /** The two calls the v3 arm makes. Typed here rather than imported: the
   *  compilers are resolved from the SITE that builds with them, so this package
   *  declares neither and imports neither. */
  type PostcssPlugin = { postcssPlugin?: string };
  type Postcss = (plugins: PostcssPlugin[]) => {
    process: (css: string, opts: { from: undefined }) => Promise<{ css: string }>;
  };

  it('CRITICAL Tailwind v3 (as the marketing site resolves it) builds every probe class from the preset', async () => {
    const requireFromSite = createRequire(join(REPO, 'apps/marketing-site/package.json'));
    const tailwind = requireFromSite('tailwindcss') as (config: object) => PostcssPlugin;
    const postcss = requireFromSite('postcss') as Postcss;
    const version = (requireFromSite('tailwindcss/package.json') as { version: string }).version;
    expect(version).toMatch(/^3\./);
    const preset = ((await import(join(DIST_DIR, 'tailwind-preset.mjs'))) as { default: object })
      .default;
    const out = (
      await postcss([
        tailwind({
          presets: [preset],
          content: [{ raw: `<div class="${PROBE.join(' ')}"></div>` }],
          corePlugins: { preflight: false },
        }),
      ]).process('@tailwind utilities;', { from: undefined })
    ).css;
    const squashed = out.replace(/\s+/g, ' ');
    expect(squashed).toContain(
      'background-color: rgb(var(--surface-base-rgb) / var(--tw-bg-opacity, 1))',
    );
    expect(squashed).toContain('color: rgb(var(--ink-secondary-rgb) / var(--tw-text-opacity, 1))');
    expect(squashed).toContain('background-color: rgb(var(--surface-raised-rgb) / 0.5)');
    expect(squashed).toContain(
      'background-color: rgb(var(--accent-subtle-rgb) / var(--accent-subtle-alpha))',
    );
    expect(squashed).toMatch(/\.rounded \{ border-radius: 0\.25rem/);
    expect(squashed).toMatch(/\.rounded-lg \{ border-radius: 0\.375rem/);
    expect(squashed).toMatch(/\.rounded-xl \{ border-radius: 0\.75rem/);
    expect(squashed).toMatch(/\.rounded-card \{ border-radius: 0\.75rem/);
    expect(squashed).toContain('--tw-shadow: var(--shadow-lift)');
    expect(squashed).toMatch(/\.text-2xs \{ font-size: 0\.625rem; line-height: 0\.875rem/);
    expect(squashed).toContain('font-family: Geist, ui-sans-serif, system-ui, sans-serif');
    expect(squashed).toContain('transition-timing-function: var(--ease)');
    // Every probe produced a rule: a class the preset does not know emits nothing.
    for (const cls of PROBE) {
      const selector = `.${cls.replace(/[:/]/g, (c) => `\\${c}`)}`;
      expect(out, cls).toContain(selector);
    }
  });

  it('CRITICAL Tailwind v4 (as the docs site resolves it) builds every probe class from theme-v4.css', async () => {
    const requireFromDocs = createRequire(join(REPO, 'apps/docs/package.json'));
    const twDir = join(requireFromDocs.resolve('tailwindcss/package.json'), '..');
    const version = (
      JSON.parse(readFileSync(join(twDir, 'package.json'), 'utf8')) as {
        version: string;
      }
    ).version;
    expect(version).toMatch(/^4\./);
    const { compile } = (await import(pathToFileURL(join(twDir, 'dist/lib.mjs')).href)) as {
      compile: (
        css: string,
        opts: {
          base: string;
          loadStylesheet: (
            id: string,
            base: string,
          ) => Promise<{ path: string; base: string; content: string }>;
        },
      ) => Promise<{ build: (candidates: string[]) => string }>;
    };
    const loadStylesheet = (id: string, base: string) => {
      const path =
        id === 'tailwindcss' ? join(twDir, 'index.css') : isAbsolute(id) ? id : join(base, id);
      return Promise.resolve({ path, base: join(path, '..'), content: readFileSync(path, 'utf8') });
    };
    const compiler = await compile(
      `@import 'tailwindcss';\n@import '${join(DIST_DIR, 'theme-v4.css')}';`,
      { base: DIST_DIR, loadStylesheet },
    );
    const out = compiler.build(PROBE).replace(/\s+/g, ' ');
    expect(out).toContain('background-color: rgb(var(--surface-base-rgb))');
    expect(out).toContain('color: rgb(var(--ink-secondary-rgb))');
    expect(out).toMatch(
      /color-mix\(in (srgb|oklab), rgb\(var\(--surface-raised-rgb\)\) 50%, transparent\)/,
    );
    expect(out).toContain(
      'background-color: rgb(var(--accent-subtle-rgb) / var(--accent-subtle-alpha))',
    );
    expect(out).toMatch(/\.rounded-lg \{ border-radius: 0\.375rem/);
    expect(out).toMatch(/\.rounded-card \{ border-radius: 0\.75rem/);
    expect(out).toContain('box-shadow: var(--shadow-lift)');
    expect(out).toContain('font-size: 0.625rem');
    expect(out).toContain('transition-timing-function: var(--ease)');
    for (const cls of PROBE) {
      const selector = `.${cls.replace(/[:/]/g, (c) => `\\${c}`)}`;
      expect(out, cls).toContain(selector);
    }
  });
});

describe('the alias layer covers the web’s vocabulary as it stands', () => {
  /** Every token name the web surfaces declared on 2026-09-25 (marketing, dashboard,
   *  docs and admin base.css, the dashboard's --tk-ease). */
  const WEB_VOCABULARY = [
    '--accent',
    '--accent-2',
    '--accent-2-rgb',
    '--accent-ink',
    '--accent-rgb',
    '--accent-soft',
    '--accent-strong',
    '--accent-strong-rgb',
    '--accent-text',
    '--bg',
    '--bg-rgb',
    '--border',
    '--border-rgb',
    '--busy',
    '--busy-rgb',
    '--busy-text',
    '--err',
    '--err-rgb',
    '--err-text',
    '--hover',
    '--hover-rgb',
    '--ink',
    '--ink-2',
    '--ink-2-rgb',
    '--ink-3',
    '--ink-3-rgb',
    '--ink-rgb',
    '--raised',
    '--raised-rgb',
    '--ready',
    '--ready-rgb',
    '--ready-text',
    '--shadow-ambient',
    '--shadow-ambient-lg',
    '--shadow-float',
    '--shadow-lift',
    '--surface',
    '--surface-rgb',
    '--tk-ease',
  ];
  /** Surface-specific on purpose (the plan keeps them per site): the hero glow,
   *  the sync blue and the code-block ground. */
  const WEB_EXTENSIONS = ['--glow', '--sync', '--sync-rgb', '--code-bg', '--code-bg-rgb'];
  /** The tk-* Tailwind colours the four v3/v4 web configs define today. */
  const WEB_TK = [
    'bg',
    'surface',
    'raised',
    'hover',
    'ink',
    'ink-2',
    'ink-3',
    'border',
    'accent',
    'accent-2',
    'accent-strong',
    'accent-hover',
    'accent-ink',
    'accent-soft',
    'ready',
    'busy',
    'err',
    'accent-text',
    'ready-text',
    'busy-text',
    'err-text',
  ];
  const TK_EXTENSIONS = ['sync', 'code-bg'];

  it('CRITICAL every web token name is declared by tokens.css or web-aliases.css', () => {
    const provided = new Set([
      ...declared(dist('tokens.css')),
      ...declared(dist('web-aliases.css')),
    ]);
    expect(WEB_VOCABULARY.filter((n) => !provided.has(n))).toEqual([]);
    // …and the package does not quietly take over a name the sites keep.
    expect(WEB_EXTENSIONS.filter((n) => provided.has(n))).toEqual([]);
  });

  it('CRITICAL every tk-* colour the web configs use is in the v3 preset and the v4 theme', async () => {
    const preset = (
      (await import(join(DIST_DIR, 'tailwind-preset.mjs'))) as {
        default: { theme: { extend: { colors: { tk: Record<string, string> } } } };
      }
    ).default.theme.extend.colors.tk;
    expect(WEB_TK.filter((k) => !(k in preset))).toEqual([]);
    const v4 = declared(dist('theme-v4.css'));
    expect(WEB_TK.filter((k) => !v4.has(`--color-tk-${k}`))).toEqual([]);
    // The inset alias is new: inputs get the app's recessed well (tk-inset).
    expect(preset.inset).toBe('rgb(var(--surface-inset-rgb) / <alpha-value>)');
    expect(TK_COLOURS.length).toBeGreaterThan(WEB_ALIASES.length);
  });

  it('the vocabulary above is still complete: nothing a web stylesheet declares is outside it', () => {
    // While a surface still declares its own token blocks, every name in them must
    // be in WEB_VOCABULARY or WEB_EXTENSIONS — so this list cannot fall behind the
    // web. Once a surface imports the package it declares none, and passes.
    const known = new Set([...WEB_VOCABULARY, ...WEB_EXTENSIONS]);
    const unknown: string[] = [];
    for (const site of ['marketing-site', 'customer-dashboard', 'docs', 'admin-panel']) {
      const css = readFileSync(join(REPO, `apps/${site}/src/styles/base.css`), 'utf8').replace(
        /\/\*[\s\S]*?\*\//g,
        '',
      );
      for (const m of css.matchAll(/(?:^|\n)\s*\[data-(?:mode|accent)[^{]*\{([^}]*)\}/g)) {
        for (const name of declared(m[1] ?? '')) {
          if (!known.has(name)) unknown.push(`${site}: ${name}`);
        }
      }
    }
    expect(unknown).toEqual([]);
    const tkUnknown: string[] = [];
    for (const site of ['marketing-site', 'customer-dashboard', 'admin-panel']) {
      const cfg = readFileSync(join(REPO, `apps/${site}/tailwind.config.mjs`), 'utf8');
      const tk = /\btk: \{([^}]*)\}/.exec(cfg)?.[1] ?? '';
      for (const m of tk.matchAll(/^\s+'?([a-z0-9-]+)'?:/gm)) {
        const k = m[1] ?? '';
        if (![...WEB_TK, ...TK_EXTENSIONS].includes(k)) tkUnknown.push(`${site}: tk-${k}`);
      }
    }
    expect(tkUnknown).toEqual([]);
  });
});
