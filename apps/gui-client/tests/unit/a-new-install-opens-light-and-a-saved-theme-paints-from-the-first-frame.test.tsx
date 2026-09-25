// A new install opens LIGHT, and a saved theme paints from the first frame.
//
// 2026-09-25 — the owner: the light theme is the one every surface is now built
// on. Two defects stood between that and the app a customer actually launches:
//
//   1. New installs opened DARK (DEFAULT_SETTINGS.themeMode, index.html and the
//      visual harness all said so). Only the default moves; a mode already in
//      settings.json is kept.
//   2. The first frames of EVERY launch were painted before settings.json can
//      be read — the boot splash and the fatal panel were hard-coded near-black
//      (#0b0b0b) with a red that is not the brand (#c0392b), and React started
//      on the default mode until the store answered. A light-theme customer saw
//      a dark flash on every launch.
//
// The fix mirrors the mode to localStorage (SettingsContext → boot-theme.ts),
// reads it back in index.html before anything paints, and paints the splash and
// both fatal panels from ONE table of the mode tokens. Each arm below names what
// reverting its line does.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── the Tauri store and keychain, in memory ────────────────────────────────
const disk = new Map<string, unknown>();
let storeWrites = 0;
/** While set, every store read waits on it — the "settings are still loading" window. */
let readGate: Promise<void> | null = null;
let readFails = false;

vi.mock('@tauri-apps/api/core', () => ({ invoke: () => Promise.resolve(null) }));
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    async get<T>(key: string): Promise<T | undefined> {
      if (readGate !== null) await readGate;
      if (readFails) throw new Error('store locked');
      return disk.get(key) as T | undefined;
    }
    set(key: string, value: unknown): Promise<void> {
      storeWrites += 1;
      disk.set(key, value);
      return Promise.resolve();
    }
    save(): Promise<void> {
      return Promise.resolve();
    }
  },
}));
// The provider builds an SDK client and starts telemetry; neither is under test.
vi.mock('../../src/lib/client', () => ({ buildClient: () => null }));
vi.mock('../../src/lib/telemetry', () => ({ initTelemetry: () => undefined }));

import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  loadSettings,
  resetKeychainCache,
} from '../../src/lib/settings';
import { SettingsProvider, useSettings } from '../../src/lib/SettingsContext';
import { BOOT_COLOURS, THEME_MODE_KEY, type BootColours } from '../../src/lib/boot-theme';

const GUI = join(__dirname, '..', '..');
const INDEX_HTML = readFileSync(join(GUI, 'index.html'), 'utf8');
const HARNESS_HTML = readFileSync(join(GUI, 'visual-harness.html'), 'utf8');
const CSS = readFileSync(join(GUI, 'src', 'styles', 'index.css'), 'utf8');
const MAIN = readFileSync(join(GUI, 'src', 'main.tsx'), 'utf8');

type Rgb = [number, number, number];
function hexRgb(hex: string): Rgb {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (m === null) throw new Error(`not a #rrggbb colour: ${hex}`);
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}
/** How jsdom serialises a colour set through the CSSOM. */
const cssRgb = (hex: string): string => `rgb(${hexRgb(hex).join(', ')})`;
function luminance([r, g, b]: Rgb): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(hexRgb(a)), luminance(hexRgb(b))].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

/** The FIRST block for a token selector in index.css (the one the app's
 *  palette reads), comments removed so a note cannot pose as a value. */
function cssBlock(selector: string): string {
  const m = new RegExp(`\\[${selector}\\]\\s*\\{([^}]*)\\}`).exec(CSS);
  if (m === null) throw new Error(`[${selector}] not found in index.css`);
  return (m[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
}
function cssToken(block: string, name: string): Rgb {
  const m = new RegExp(`--${name}:\\s*(\\d+) (\\d+) (\\d+);`).exec(block);
  if (m === null) throw new Error(`--${name} not found`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** The inline scripts of index.html, in document order: the head script (the
 *  pre-paint theme, then the fail-visible guard) and the body's boot splash. */
const SCRIPTS = [...INDEX_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
const [HEAD = '', SPLASH = ''] = SCRIPTS;
const run = (src: string): void => {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call -- runs index.html's own inline script: that script IS the thing under test
  new Function(src)();
};
/** The head script as the webview runs it. Its guard starts a 500 ms mount poll;
 *  under fake timers it never fires (the setup file restores real ones). */
const runHead = (): void => {
  vi.useFakeTimers();
  run(HEAD);
};

type BootWindow = Window & {
  __dsFatal?: (code: string, err: unknown) => void;
  __dsFatalShown?: boolean;
  __dsBooted?: boolean;
  __dsBootColours?: () => BootColours;
};
const w = window as BootWindow;

/** index.html as parsed, before any of its scripts ran. */
function freshDocument(search = ''): void {
  const html = /<html lang="en" data-mode="(\w+)" data-accent="(\w+)">/.exec(INDEX_HTML);
  if (html === null) throw new Error('index.html has no <html data-mode data-accent> tag');
  document.documentElement.setAttribute('data-mode', html[1]!);
  document.documentElement.setAttribute('data-accent', html[2]!);
  document.body.innerHTML = '';
  delete w.__dsFatalShown;
  window.history.replaceState({}, '', `/${search}`);
}

beforeEach(() => {
  disk.clear();
  storeWrites = 0;
  readGate = null;
  readFails = false;
  resetKeychainCache();
  freshDocument();
  // The head script's error listeners stand down once the app has booted; this
  // file calls __dsFatal directly, so they must never paint on their own.
  w.__dsBooted = true;
});

describe('a new install opens light; a mode already saved is kept', () => {
  it('CRITICAL the default is light in all three places a new install reads it', () => {
    // Reverting settings.ts to 'dark' reds the first line; index.html or the
    // harness back to data-mode="dark" reds the others.
    expect(DEFAULT_SETTINGS.themeMode).toBe('light');
    expect(INDEX_HTML).toMatch(/<html lang="en" data-mode="light" data-accent="oxblood">/);
    expect(HARNESS_HTML).toMatch(/<html lang="en" data-mode="light" data-accent="oxblood">/);
  });

  it('an empty store (a fresh install) loads light, and the first load writes light', async () => {
    const loaded = await loadSettings();
    expect(loaded.themeMode).toBe('light');
    // The layout-marker stamp persists the resolved object on first load, so
    // from here on the mode is the customer's, not a default.
    expect(disk.get('driftstack')).toMatchObject({
      themeMode: 'light',
      settingsVersion: SETTINGS_VERSION,
    });
  });

  it('CRITICAL a saved dark mode loads dark and is not rewritten — existing customers keep their theme', async () => {
    disk.set('driftstack', {
      baseUrl: 'https://api.example.test',
      themeMode: 'dark',
      themeAccent: 'oxblood',
      telemetryOptIn: null,
      startUrl: 'https://example.test/',
      autoUpdate: true,
      settingsVersion: SETTINGS_VERSION,
    });
    expect((await loadSettings()).themeMode).toBe('dark');
    expect(storeWrites, 'a marked file must not be rewritten by a load').toBe(0);
    expect(disk.get('driftstack')).toMatchObject({ themeMode: 'dark' });
  });

  it('a dark mode written by a build older than the layout marker is kept through the one-time stamp', async () => {
    disk.set('driftstack', { baseUrl: 'https://api.example.test', themeMode: 'dark' });
    expect((await loadSettings()).themeMode).toBe('dark');
    expect(disk.get('driftstack')).toMatchObject({
      themeMode: 'dark',
      settingsVersion: SETTINGS_VERSION,
    });
  });

  it('a value that is not a mode falls back to the new default', async () => {
    disk.set('driftstack', { baseUrl: 'https://api.example.test', themeMode: 'violet' });
    expect((await loadSettings()).themeMode).toBe('light');
  });
});

describe('the boot colours are the mode tokens, in one table with one copy', () => {
  const LIGHT = cssBlock("data-mode='light'");
  const DARK = cssBlock("data-mode='dark'");
  const ACCENT = cssBlock("data-accent='oxblood'");
  const FROM_CSS: Record<keyof BootColours, [string, string]> = {
    base: ['mode', 'surface-base-rgb'],
    raised: ['mode', 'surface-raised-rgb'],
    inset: ['mode', 'surface-inset-rgb'],
    divider: ['mode', 'surface-divider-rgb'],
    ink: ['mode', 'ink-primary-rgb'],
    inkSecondary: ['mode', 'ink-secondary-rgb'],
    inkMuted: ['mode', 'ink-muted-rgb'],
    accent: ['accent', 'accent-rgb'],
    onAccent: ['accent', 'on-accent-rgb'],
  };

  for (const [mode, block] of [
    ['light', LIGHT],
    ['dark', DARK],
  ] as const) {
    it(`${mode}: every boot colour equals its token in styles/index.css`, () => {
      const table = BOOT_COLOURS[mode];
      expect(Object.keys(table).sort()).toEqual(Object.keys(FROM_CSS).sort());
      for (const [key, [axis, token]] of Object.entries(FROM_CSS)) {
        expect(hexRgb(table[key as keyof BootColours]), `${mode}.${key} vs --${token}`).toEqual(
          cssToken(axis === 'mode' ? block : ACCENT, token),
        );
      }
    });
  }

  it("index.html's inline table is the same table — the splash and the early fatal panel cannot drift from main.tsx's", () => {
    const literal = /var palette = (\{[\s\S]*?\n {8}\});/.exec(HEAD)?.[1];
    expect(literal, 'the pre-paint script has no palette literal').toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call -- evaluates index.html's own palette literal: that table IS the thing under test
    const inline = new Function(`return ${literal ?? '{}'};`)() as Record<string, BootColours>;
    expect(inline).toEqual(BOOT_COLOURS);
  });

  it('every text pair the splash and the fatal panel paint clears 4.5:1 in both modes', () => {
    for (const mode of ['light', 'dark'] as const) {
      const c = BOOT_COLOURS[mode];
      const pairs: Array<[string, string, string]> = [
        ['heading, error code', c.ink, c.base],
        ['body copy', c.inkSecondary, c.base],
        ['splash caption, disclosure', c.inkMuted, c.base],
        ['message box', c.inkSecondary, c.raised],
        ['stack trace', c.inkMuted, c.inset],
        ['Reload label', c.onAccent, c.accent],
      ];
      for (const [what, fg, bg] of pairs) {
        expect(contrast(fg, bg), `${mode}: ${what} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    // Vacuity control: the retired dark panel's disclosure grey #888 on its own
    // #0b0b0b ground passed, but on the LIGHT ground it would read 3.3 — the
    // measurement can fail.
    expect(contrast('#888888', BOOT_COLOURS.light.base)).toBeLessThan(4.5);
  });

  it('the retired near-black ground and off-brand red are gone from index.html and the main.tsx fatal panel', () => {
    const fatal = /function renderFatalError[\s\S]*?\n}\n/.exec(MAIN)?.[0] ?? '';
    expect(fatal, 'renderFatalError not found in main.tsx').toContain('bootColours()');
    expect(fatal).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    for (const retired of ['#0b0b0b', '#c0392b', '#ffb86b']) {
      expect(INDEX_HTML).not.toContain(retired);
      expect(fatal).not.toContain(retired);
    }
  });
});

describe('index.html paints the saved mode before the first frame', () => {
  const splashAfter = (saved: string | null, search = ''): HTMLElement => {
    freshDocument(search);
    if (saved !== null) localStorage.setItem(THEME_MODE_KEY, saved);
    runHead();
    run(SPLASH);
    return document.getElementById('ds-boot-splash') as HTMLElement;
  };

  it('CRITICAL a saved dark mode is on <html> and the splash is the dark ground with the brand spinner', () => {
    const splash = splashAfter('dark');
    expect(document.documentElement.dataset.mode).toBe('dark');
    expect(splash.style.backgroundColor).toBe(cssRgb(BOOT_COLOURS.dark.base));
    expect(splash.style.color).toBe(cssRgb(BOOT_COLOURS.dark.inkMuted));
    const spinner = splash.firstElementChild?.getAttribute('style') ?? '';
    expect(spinner).toContain(`border-top-color:${BOOT_COLOURS.dark.accent}`);
    expect(spinner).toContain(`solid ${BOOT_COLOURS.dark.divider}`);
  });

  it('CRITICAL a saved light mode opens light — the dark flash every light customer saw on launch', () => {
    const splash = splashAfter('light');
    expect(document.documentElement.dataset.mode).toBe('light');
    expect(splash.style.backgroundColor).toBe(cssRgb(BOOT_COLOURS.light.base));
    expect(splash.firstElementChild?.getAttribute('style')).toContain(
      `border-top-color:${BOOT_COLOURS.light.accent}`,
    );
  });

  it('nothing saved (a new install) and a junk value both paint the default light', () => {
    expect(splashAfter(null).style.backgroundColor).toBe(cssRgb(BOOT_COLOURS.light.base));
    expect(document.documentElement.dataset.mode).toBe('light');
    expect(splashAfter('violet').style.backgroundColor).toBe(cssRgb(BOOT_COLOURS.light.base));
    expect(document.documentElement.dataset.mode).toBe('light');
  });

  it('the simulator window is pinned dark from its first frame whatever was saved, and gets no splash', () => {
    const splash = splashAfter('light', '?window=simulator');
    expect(document.documentElement.dataset.mode).toBe('dark');
    expect(splash).toBeNull();
  });

  it('the early fatal panel paints the mode <html> carries AT PAINT TIME, with the brand Reload button', () => {
    localStorage.setItem(THEME_MODE_KEY, 'dark');
    runHead();
    try {
      w.__dsFatal?.('TEST_CODE', new Error('boom'));
      const panel = document.querySelector<HTMLElement>('[data-fatal-error="TEST_CODE"]');
      expect(panel?.style.backgroundColor).toBe(cssRgb(BOOT_COLOURS.dark.base));
      const reload = document.getElementById('ds-fatal-reload');
      expect(reload?.style.backgroundColor).toBe(cssRgb(BOOT_COLOURS.dark.accent));
      expect(reload?.style.color).toBe(cssRgb(BOOT_COLOURS.dark.onAccent));

      // React applied a different live mode before the fatal: the panel follows it.
      freshDocument();
      document.documentElement.dataset.mode = 'light';
      w.__dsFatal?.('LATER', new Error('boom'));
      const later = document.querySelector<HTMLElement>('[data-fatal-error="LATER"]');
      expect(later?.style.backgroundColor).toBe(cssRgb(BOOT_COLOURS.light.base));
    } finally {
      w.__dsBooted = true; // stand the guard's window listeners down
    }
  });
});

describe('SettingsProvider mirrors the mode it knows, and starts React in the mirrored one', () => {
  let update: ReturnType<typeof useSettings>['update'] | null = null;
  function Probe(): JSX.Element {
    const ctx = useSettings();
    update = ctx.update;
    return <span data-testid="loading">{String(ctx.loading)}</span>;
  }
  const mount = (): ReturnType<typeof render> =>
    render(
      <SettingsProvider>
        <Probe />
      </SettingsProvider>,
    );

  it('CRITICAL while the store is still loading, <html> keeps the mirrored mode and the mirror is not overwritten', async () => {
    localStorage.setItem(THEME_MODE_KEY, 'dark');
    document.documentElement.dataset.mode = 'dark'; // what the pre-paint script did
    disk.set('driftstack', { baseUrl: 'https://api.example.test', themeMode: 'light' });
    let release: () => void = () => undefined;
    readGate = new Promise<void>((r) => {
      release = r;
    });
    mount();
    // Starting React on the plain default would repaint light here, then dark.
    expect(document.documentElement.dataset.mode).toBe('dark');
    expect(localStorage.getItem(THEME_MODE_KEY)).toBe('dark');
    await act(async () => {
      release();
      await Promise.resolve();
    });
    // The store answered: the saved mode wins, on <html> and in the mirror.
    await waitFor(() => expect(document.documentElement.dataset.mode).toBe('light'));
    await waitFor(() => expect(localStorage.getItem(THEME_MODE_KEY)).toBe('light'));
  });

  it('CRITICAL with no mirror yet (the first launch of this build), nothing is mirrored until the store answers — the default is a guess, not the mode', async () => {
    disk.set('driftstack', { baseUrl: 'https://api.example.test', themeMode: 'dark' });
    let release: () => void = () => undefined;
    readGate = new Promise<void>((r) => {
      release = r;
    });
    const view = mount();
    expect(view.getByTestId('loading').textContent).toBe('true');
    // Mirroring while loading would write the default 'light' here, and the
    // NEXT launch of a dark customer would open light.
    expect(localStorage.getItem(THEME_MODE_KEY)).toBeNull();
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => expect(localStorage.getItem(THEME_MODE_KEY)).toBe('dark'));
  });

  it('a loaded mode is mirrored for the next launch, and so is a change the customer makes', async () => {
    disk.set('driftstack', { baseUrl: 'https://api.example.test', themeMode: 'dark' });
    mount();
    await waitFor(() => expect(localStorage.getItem(THEME_MODE_KEY)).toBe('dark'));
    await act(async () => {
      await update?.({ themeMode: 'light' });
    });
    expect(localStorage.getItem(THEME_MODE_KEY)).toBe('light');
    expect(document.documentElement.dataset.mode).toBe('light');
  });

  it('a store that cannot be read keeps the mirrored mode instead of dropping to the default', async () => {
    localStorage.setItem(THEME_MODE_KEY, 'dark');
    readFails = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      mount();
      await waitFor(() => expect(warn).toHaveBeenCalled());
      expect(document.documentElement.dataset.mode).toBe('dark');
      expect(localStorage.getItem(THEME_MODE_KEY)).toBe('dark');
    } finally {
      warn.mockRestore();
    }
  });

  it('the pinned-dark simulator window never writes the mirror', async () => {
    window.history.replaceState({}, '', '/?window=simulator');
    disk.set('driftstack', { baseUrl: 'https://api.example.test', themeMode: 'light' });
    const view = mount();
    // Settled, so the mirror effect has had its chance to run.
    await waitFor(() => expect(view.getByTestId('loading').textContent).toBe('false'));
    expect(localStorage.getItem(THEME_MODE_KEY)).toBeNull();
  });
});
