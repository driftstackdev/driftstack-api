import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const BUILT_PAGE = resolve(process.cwd(), 'apps/docs/dist/quickstart/index.html');
const PAGE_URL = 'https://docs.driftstack.dev/quickstart/';

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
});
