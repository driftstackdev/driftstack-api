import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const BUILT_PAGE = resolve(process.cwd(), 'apps/docs/dist/quickstart/index.html');
const PAGE_URL = 'https://docs.driftstack.io/quickstart/';
const BUILT_SESSIONS = resolve(process.cwd(), 'apps/docs/dist/api/sessions/index.html');
const SESSIONS_URL = 'https://docs.driftstack.io/api/sessions/';

type ClipboardStep = (text: string) => Promise<void>;

function setup(clipboardPlan: ClipboardStep[]): {
  window: JSDOM['window'];
  writes: string[];
  timers: Map<number, TimerHandler>;
} {
  const html = readFileSync(BUILT_PAGE, 'utf8');
  const scripts: string[] = [];
  const withoutScripts = html.replace(
    /<script[^>]*>([\s\S]*?)<\/script>/g,
    (_match, body: string) => {
      scripts.push(body);
      return '';
    },
  );
  const dom = new JSDOM(withoutScripts, {
    url: PAGE_URL,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const writes: string[] = [];
  const plan = [...clipboardPlan];
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        writes.push(text);
        return plan.shift()?.(text) ?? Promise.resolve();
      },
    },
  });

  let nextTimer = 1;
  const timers = new Map<number, TimerHandler>();
  window.setTimeout = ((handler: TimerHandler) => {
    const id = nextTimer++;
    timers.set(id, handler);
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id: number | undefined) => {
    if (id !== undefined) timers.delete(id);
  }) as typeof window.clearTimeout;

  const copyScript = scripts.find((script) => script.includes("setAttribute('data-copy-code'"));
  const anchorScript = scripts.find((script) => script.includes("setAttribute('data-anchor'"));
  if (!copyScript || !anchorScript) throw new Error('built docs clipboard scripts missing');
  window.eval(copyScript);
  window.eval(anchorScript);
  return { window: window as JSDOM['window'], writes, timers };
}

/** Runs a built page's code-block scripts in document order: the Copy
 *  buttons, the language tabs, then the code windows and table cards. */
function runCodeBlockScripts(
  builtPage: string,
  url: string,
): { window: JSDOM['window']; writes: string[] } {
  const html = readFileSync(builtPage, 'utf8');
  const scripts: string[] = [];
  const withoutScripts = html.replace(
    /<script[^>]*>([\s\S]*?)<\/script>/g,
    (_match, body: string) => {
      scripts.push(body);
      return '';
    },
  );
  const dom = new JSDOM(withoutScripts, { url, runScripts: 'outside-only' });
  const { window } = dom;
  const writes: string[] = [];
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        writes.push(text);
        return Promise.resolve();
      },
    },
  });
  const copyScript = scripts.findIndex((s) => s.includes("setAttribute('data-copy-code'"));
  const tabsScript = scripts.findIndex((s) => s.includes("var STORE_KEY = 'ds_docs_lang'"));
  const windowScript = scripts.findIndex((s) => s.includes("setAttribute('data-codewindow'"));
  if (copyScript === -1 || tabsScript === -1 || windowScript === -1) {
    throw new Error('built docs code-block scripts missing');
  }
  if (!(copyScript < tabsScript && tabsScript < windowScript)) {
    throw new Error('built docs code-block scripts out of order');
  }
  for (const i of [copyScript, tabsScript, windowScript]) window.eval(scripts[i] as string);
  return { window: window as JSDOM['window'], writes };
}

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

let currentWindow: JSDOM['window'] | undefined;
afterEach(() => {
  currentWindow?.close();
  currentWindow = undefined;
});

describe('docs clipboard controls', () => {
  it('reports code-copy failure, recovers on retry, and keeps only the newest reset timer', async () => {
    const { window, writes, timers } = setup([
      () => Promise.reject(new Error('clipboard denied')),
      () => Promise.resolve(),
    ]);
    currentWindow = window;
    const button = window.document.querySelector('[data-copy-code]') as HTMLButtonElement;
    const code = button.closest('pre')?.querySelector('code')?.textContent ?? '';

    button.click();
    await flush();
    expect(button.textContent).toBe('Copy failed');
    expect(button.getAttribute('aria-label')).toMatch(/select it manually/i);
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-busy')).toBe('false');
    expect(timers.size).toBe(1);

    button.click();
    await flush();
    expect(button.textContent).toBe('Copied');
    expect(button.getAttribute('aria-label')).toBe('Code copied to clipboard');
    expect(writes).toEqual([code, code]);
    expect(timers.size).toBe(1);

    const newestReset = [...timers.values()][0];
    if (typeof newestReset === 'function') newestReset();
    expect(button.textContent).toBe('Copy');
    expect(button.getAttribute('aria-label')).toBe('Copy code to clipboard');
  });

  it('serializes a pending code-copy write', async () => {
    let resolveWrite: (() => void) | undefined;
    const pending = new Promise<void>((resolvePromise) => {
      resolveWrite = resolvePromise;
    });
    const { window, writes } = setup([() => pending]);
    currentWindow = window;
    const button = window.document.querySelector('[data-copy-code]') as HTMLButtonElement;
    button.click();
    button.click();
    expect(writes).toHaveLength(1);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    resolveWrite?.();
    await flush();
    expect(button.textContent).toBe('Copied');
    expect(button.disabled).toBe(false);
  });

  it('keeps section navigation and exposes failure without letting an older write overwrite success', async () => {
    let rejectFirst: ((reason?: unknown) => void) | undefined;
    const first = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const { window, writes, timers } = setup([
      () => first,
      () => Promise.resolve(),
      () => Promise.reject(new Error('clipboard denied')),
    ]);
    currentWindow = window;
    const anchor = window.document.querySelector('[data-anchor]') as HTMLAnchorElement;
    const expectedUrl = PAGE_URL + anchor.getAttribute('href');

    anchor.click();
    anchor.click();
    await flush();
    expect(anchor.textContent).toBe('✓');
    expect(anchor.getAttribute('aria-label')).toBe('Section link copied');
    expect(writes).toEqual([expectedUrl, expectedUrl]);
    rejectFirst?.(new Error('late denial'));
    await flush();
    expect(anchor.textContent).toBe('✓');
    expect(timers.size).toBe(1);

    const reset = [...timers.values()][0];
    if (typeof reset === 'function') reset();
    expect(anchor.textContent).toBe('#');
    expect(anchor.getAttribute('aria-label')).toBe('Link to this section');
    expect(anchor.hasAttribute('title')).toBe(false);

    anchor.click();
    await flush();
    expect(anchor.textContent).toBe('!');
    expect(anchor.getAttribute('aria-label')).toMatch(/browser address bar/i);
    expect(anchor.title).toMatch(/could not copy/i);

    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    anchor.click();
    await flush();
    expect(anchor.textContent).toBe('!');
    expect(anchor.getAttribute('aria-label')).toMatch(/browser address bar/i);
    expect(writes).toEqual([expectedUrl, expectedUrl, expectedUrl]);
  });

  // P4 fix-up (2026-09-25) — the Copy button sat ABSOLUTELY on the code block
  // and, fully opaque, covered the end of the first line of code (at 390px on
  // most blocks: 149 blocks across the docs; 11 even at 1440px). It now sits in
  // a header above the code: a language-tab group's own header (one button,
  // the visible panel's), or a code-window header that names the language.
  it('puts every Copy button in a header above its code, never on it, and copies what is shown', async () => {
    const { window, writes } = runCodeBlockScripts(BUILT_PAGE, PAGE_URL);
    currentWindow = window;
    const doc = window.document as Document;
    const pres = Array.from(doc.querySelectorAll('article pre'));
    const buttons = Array.from(doc.querySelectorAll<HTMLButtonElement>('[data-copy-code]'));
    expect(pres.length).toBeGreaterThanOrEqual(5);
    expect(buttons).toHaveLength(pres.length);
    for (const button of buttons) {
      expect(button.closest('pre'), 'a Copy button inside a code block').toBeNull();
      expect(button.classList.contains('absolute')).toBe(false);
      const frame = button.closest('[data-langtabs], [data-codewindow]');
      expect(frame).not.toBeNull();
      const pre = frame?.querySelector('pre');
      // The header comes first: the button precedes its code.
      expect(
        (pre?.compareDocumentPosition(button) ?? 0) & window.Node.DOCUMENT_POSITION_PRECEDING,
      ).toBeTruthy();
    }

    // A language-tab group shows ONE Copy button, the visible panel's, beside
    // (not inside) the tablist, and it copies that panel's code.
    const groups = Array.from(doc.querySelectorAll('[data-langtabs]'));
    expect(groups.length).toBeGreaterThanOrEqual(1);
    for (const group of groups) {
      const shown = Array.from(
        group.querySelectorAll<HTMLButtonElement>('[data-copy-code]'),
      ).filter((b) => !b.hidden);
      expect(shown).toHaveLength(1);
      expect(group.querySelector('[role="tablist"] [data-copy-code]')).toBeNull();
      const visible = group.querySelector('[role="tabpanel"]:not([hidden]) pre code');
      shown[0]?.click();
      await flush();
      expect(writes.at(-1)).toBe(visible?.textContent);
    }

    // Every other block is a code window whose header names its language.
    const windows = Array.from(doc.querySelectorAll('[data-codewindow]'));
    expect(windows.length).toBeGreaterThanOrEqual(1);
    for (const frame of windows) {
      if (frame.querySelector('pre')?.getAttribute('data-language') === 'bash') {
        expect(frame.firstElementChild?.textContent).toMatch(/^bash/);
      }
    }
  });

  // P4 fix-up (2026-09-25) — a narrow first column broke table code names
  // mid-word ('unverifie' / 'd'). Every table moves into a scroll box that
  // takes the card (base.css .table-scroll: code never wraps there, and a
  // wide table scrolls inside its card).
  it('moves every table into its scroll card', () => {
    const { window } = runCodeBlockScripts(BUILT_SESSIONS, SESSIONS_URL);
    currentWindow = window;
    const tables = Array.from((window.document as Document).querySelectorAll('article table'));
    expect(tables.length).toBeGreaterThanOrEqual(2);
    for (const table of tables) {
      expect(table.parentElement?.className).toBe('table-scroll');
      expect(table.parentElement?.children).toHaveLength(1);
    }
  });
});
