import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const BUILT_PAGE = resolve(process.cwd(), 'apps/marketing-site/dist/index.html');

type ClipboardStep = (text: string) => Promise<void>;

function setup(clipboardPlan: ClipboardStep[]): {
  window: JSDOM['window'];
  writes: string[];
  timers: Map<number, TimerHandler>;
  copyScript: string;
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
    url: 'https://driftstack.dev/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const writes: string[] = [];
  const plan = [...clipboardPlan];
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText(text: string) {
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

  const copyScript = scripts.find((script) => script.includes('__dsCopyWired'));
  if (!copyScript) throw new Error('built marketing copy script missing');
  window.eval(copyScript);
  return { window: window as JSDOM['window'], writes, timers, copyScript };
}

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

let currentWindow: JSDOM['window'] | undefined;
afterEach(() => {
  currentWindow?.close();
  currentWindow = undefined;
});

describe('marketing CodeWindow copy behavior', () => {
  it('serializes writes, recovers from denial, and keeps one reset timer', async () => {
    let resolveSecond: (() => void) | undefined;
    const pendingSecond = new Promise<void>((resolvePromise) => {
      resolveSecond = resolvePromise;
    });
    const { window, writes, timers, copyScript } = setup([
      () => Promise.reject(new Error('clipboard denied')),
      () => pendingSecond,
    ]);
    currentWindow = window;
    const button = window.document.querySelector('[data-copy-target]') as HTMLButtonElement;
    const target = window.document.getElementById(button.getAttribute('data-copy-target') ?? '');
    const code = target?.textContent ?? '';

    button.click();
    await flush();
    expect(button.textContent).toBe('Copy failed');
    expect(button.getAttribute('aria-label')).toMatch(/select it manually/i);
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-busy')).toBe('false');
    expect(timers.size).toBe(1);

    button.click();
    button.click();
    expect(writes).toEqual([code, code]);
    expect(button.textContent).toBe('Copying…');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    resolveSecond?.();
    await flush();
    expect(button.textContent).toBe('Copied');
    expect(button.getAttribute('aria-label')).toBe('Code copied to clipboard');
    expect(timers.size).toBe(1);

    window.eval(copyScript);
    const reset = [...timers.values()][0];
    if (typeof reset === 'function') reset();
    expect(button.textContent).toBe('Copy');
    expect(button.getAttribute('aria-label')).toBe('Copy code to clipboard');

    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    button.click();
    await flush();
    expect(button.textContent).toBe('Copy failed');
    expect(writes).toEqual([code, code]);
  });
});
