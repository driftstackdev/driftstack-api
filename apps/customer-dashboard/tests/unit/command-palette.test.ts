// Behavioural coverage for the ⌘K command palette wired into
// DashboardLayout (Fleet v2 slice 4). The palette is a LAYOUT-level
// inline script (not a page's data-page script), so the per-page test
// harnesses never exercise it — this test isolates the palette script
// from a built signed-in page, evals it in jsdom, and drives the
// keyboard interactions.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
// Any signed-in page carries the layout; the overview build is the smallest.
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'index.html');

function loadBuiltPage(): string {
  return readFileSync(BUILT_PAGE, 'utf8');
}

interface SetUp {
  window: JSDOM['window'];
  overlay: () => Element | null;
  isOpen: () => boolean;
  press: (key: string, opts?: { meta?: boolean; ctrl?: boolean }) => void;
  pressInput: (key: string) => void;
}

function setUp(): SetUp {
  const html = loadBuiltPage();
  // Collect script bodies, strip them from the DOM (jsdom won't run the
  // page/layout auth-gate etc. — we only want the palette one).
  const scriptBodies: string[] = [];
  const htmlNoScripts = html.replace(/<script[^>]*>([\s\S]*?)<\/script>/g, (_m, body: string) => {
    scriptBodies.push(body);
    return '';
  });
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(htmlNoScripts, {
    url: 'https://app.driftstack.io/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  // @ts-expect-error — jsdom global is loose
  window.fetch = () => Promise.resolve(new Response('{}', { status: 200 }));

  const paletteScript = scriptBodies.find((s) => s.includes("querySelector('[data-cmdk]')"));
  if (!paletteScript) throw new Error('command palette script not found in built layout');
  // @ts-expect-error — jsdom eval
  window.eval(paletteScript);

  const overlay = () => window.document.querySelector('[data-cmdk]');
  return {
    window,
    overlay,
    isOpen: () => !overlay()?.classList.contains('hidden'),
    // ⌘K / Ctrl-K is a GLOBAL toggle (document-level handler).
    press: (key, opts = {}) => {
      window.document.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key,
          metaKey: !!opts.meta,
          ctrlKey: !!opts.ctrl,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    // Enter / Arrow / Escape are palette-internal (bound to the focused
    // input) — dispatch them there, mirroring real keyboard focus.
    pressInput: (key: string) => {
      const input = overlay()!.querySelector('[data-cmdk-input]') as HTMLInputElement;
      input.dispatchEvent(
        new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      );
    },
  };
}

let win: JSDOM['window'] | undefined;
afterEach(() => {
  win?.close?.();
  win = undefined;
});

describe('DashboardLayout ⌘K command palette', () => {
  it('is closed on load and opens on ⌘K (and Ctrl-K), then closes on Escape', () => {
    const s = setUp();
    win = s.window;
    expect(s.isOpen()).toBe(false);
    s.press('k', { meta: true });
    expect(s.isOpen()).toBe(true);
    s.pressInput('Escape');
    expect(s.isOpen()).toBe(false);
    // Ctrl-K works too (non-mac).
    s.press('k', { ctrl: true });
    expect(s.isOpen()).toBe(true);
  });

  it('populates a static action list including navigation, theme, and sign-out actions', () => {
    const s = setUp();
    win = s.window;
    s.press('k', { meta: true });
    const labels = Array.from(s.overlay()!.querySelectorAll('[data-cmdk-list] li')).map(
      (li) => li.textContent,
    );
    expect(labels).toContain('Go to Billing');
    expect(labels).toContain('Theme: Light');
    expect(labels).toContain('Sign out');
    expect(labels.length).toBeGreaterThanOrEqual(10);
  });

  it('filters the list as the user types', () => {
    const s = setUp();
    win = s.window;
    s.press('k', { meta: true });
    const input = s.overlay()!.querySelector('[data-cmdk-input]') as HTMLInputElement;
    input.value = 'billing';
    input.dispatchEvent(new s.window.Event('input', { bubbles: true }));
    const labels = Array.from(s.overlay()!.querySelectorAll('[data-cmdk-list] li')).map(
      (li) => li.textContent,
    );
    expect(labels).toEqual(['Go to Billing']);
  });

  it('Theme action flips <html data-mode> and persists ds_theme_mode (no navigation)', () => {
    const s = setUp();
    win = s.window;
    s.window.document.documentElement.setAttribute('data-mode', 'dark');
    s.press('k', { meta: true });
    const input = s.overlay()!.querySelector('[data-cmdk-input]') as HTMLInputElement;
    input.value = 'Theme: Light';
    input.dispatchEvent(new s.window.Event('input', { bubbles: true }));
    s.pressInput('Enter');
    expect(s.window.document.documentElement.getAttribute('data-mode')).toBe('light');
    expect(s.window.localStorage.getItem('ds_theme_mode')).toBe('light');
    // A theme action closes the palette but does NOT navigate away.
    expect(s.isOpen()).toBe(false);
  });

  it('Sign out action clicks the layout sign-out control', () => {
    const s = setUp();
    win = s.window;
    let clicked = false;
    const btn = s.window.document.querySelector('[data-signout]');
    // The signed-in identity block (which holds [data-signout]) is present
    // in the built layout; wire a spy to prove the palette delegates to it.
    expect(btn).not.toBeNull();
    btn!.addEventListener('click', () => {
      clicked = true;
    });
    s.press('k', { meta: true });
    const input = s.overlay()!.querySelector('[data-cmdk-input]') as HTMLInputElement;
    input.value = 'Sign out';
    input.dispatchEvent(new s.window.Event('input', { bubbles: true }));
    s.pressInput('Enter');
    expect(clicked).toBe(true);
  });
});
