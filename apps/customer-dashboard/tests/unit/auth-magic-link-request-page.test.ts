import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installDashboardDeadline } from './dashboard-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'auth', 'magic-link-request', 'index.html');

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

function setUpDom(html: string): { window: JSDOM['window']; fetchCalls: MockFetchCall[] } {
  const scripts: string[] = [];
  const htmlNoScripts = html.replace(/<script[^>]*>([\s\S]*?)<\/script>/g, (_m, body: string) => {
    scripts.push(body);
    return '';
  });
  const dom = new JSDOM(htmlNoScripts, {
    url: 'https://app.driftstack.dev/auth/magic-link-request/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const fetchCalls: MockFetchCall[] = [];
  // @ts-expect-error — jsdom global is loose
  window.fetch = (input: string, init: RequestInit | undefined) => {
    const call = { url: String(input), init };
    fetchCalls.push(call);
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  };
  const nativeSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (timeout === 15_000) {
      window.queueMicrotask(() => {
        if (typeof handler === 'function') handler(...args);
      });
      return 42;
    }
    return nativeSetTimeout(handler, timeout, ...args);
  }) as typeof window.setTimeout;
  installDashboardDeadline(window);
  const script = scripts.find((body) => body.includes('data-page="magic-link-request"'));
  if (!script) throw new Error('magic-link request inline script not found');
  // @ts-expect-error — jsdom global has eval
  window.eval(script);
  return { window: window as JSDOM['window'], fetchCalls };
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('magic-link request page', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });

  it('makes an ambiguous send timeout terminal and blocks forced replay', async () => {
    const html = readFileSync(BUILT_PAGE, 'utf8');
    const { window, fetchCalls } = setUpDom(html);
    win = window;
    const form = window.document.querySelector('[data-form]') as HTMLFormElement;
    (form.querySelector('input[name="email"]') as HTMLInputElement).value = 'magic@example.com';
    const submit = (): void =>
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    submit();
    submit();
    await flush();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toMatch(/\/v1\/auth\/magic-link\/request$/);
    expect(fetchCalls[0]?.init?.signal?.aborted).toBe(true);
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /delivery is unknown.*may already have sent.*do not request another link.*inbox and spam.*newest one/i,
    );
    expect(form.classList.contains('hidden')).toBe(true);
    expect(window.document.querySelector('[data-success]')?.classList.contains('hidden')).toBe(
      false,
    );
    expect(window.document.querySelector('[data-success-email]')?.textContent).toBe(
      'magic@example.com',
    );
    const button = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('false');
    expect(button.textContent).toBe('Check inbox before retrying');

    submit();
    await flush();
    expect(fetchCalls).toHaveLength(1);
  });
});
