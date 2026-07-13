import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'auth', 'magic-link', 'index.html');
const PAGE_URL = 'https://app.driftstack.dev/auth/magic-link/?token=magic_tok_123';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

function setUpDom(
  html: string,
  plan: Array<(call: MockFetchCall) => Response | Promise<Response>>,
): { window: JSDOM['window']; fetchCalls: MockFetchCall[] } {
  const scriptBodies: string[] = [];
  const htmlNoScripts = html.replace(/<script[^>]*>([\s\S]*?)<\/script>/g, (_m, body: string) => {
    scriptBodies.push(body);
    return '';
  });
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err: Error) => {
    if (!/Not implemented: navigation/.test(String(err && err.message))) {
      // eslint-disable-next-line no-console
      console.error(err);
    }
  });
  const dom = new JSDOM(htmlNoScripts, {
    url: PAGE_URL,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  const fetchCalls: MockFetchCall[] = [];
  const queue = [...plan];
  // @ts-expect-error — jsdom global is loose
  if (typeof window.Response !== 'function') window.Response = Response;
  // @ts-expect-error — jsdom global is loose
  window.fetch = (input: string, init: RequestInit | undefined) => {
    const call = { url: String(input), init };
    fetchCalls.push(call);
    const handler = queue.shift();
    if (!handler) return Promise.resolve(new Response('{}', { status: 500 }));
    return Promise.resolve(handler(call));
  };

  const pageScript = scriptBodies.find((body) => body.includes('data-page="magic-link"'));
  if (!pageScript) throw new Error('magic-link inline script not found');
  // @ts-expect-error — jsdom global has eval
  window.eval(pageScript);
  return { window: window as JSDOM['window'], fetchCalls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('magic-link consume page', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });
  const loadBuiltPage = (): string => readFileSync(BUILT_PAGE, 'utf8');

  it('makes a timeout terminal and cannot POST the consumed token again', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), [() => Promise.reject(timeout)]);
    win = window;
    await flush(12);

    const form = window.document.querySelector('[data-form="magic-link"]') as HTMLFormElement;
    expect(fetchCalls).toHaveLength(1);
    expect(form.classList.contains('hidden')).toBe(true);
    expect(
      window.document.querySelector('[data-unknown-recovery]')?.classList.contains('hidden'),
    ).toBe(false);
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /outcome is unknown.*consumed this one-time link.*credential did not reach this browser.*do not try this link again.*fresh sign-in link/i,
    );
    expect(window.document.querySelector('[data-unknown-recovery] a')?.getAttribute('href')).toBe(
      '/login',
    );

    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(fetchCalls).toHaveLength(1);
  });

  it('keeps an authoritative HTTP failure retryable through the paste form', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), [
      () => json({ detail: 'Temporary sign-in failure.' }, 503),
      () => json({ session: { token: 'web_after_retry' } }),
    ]);
    win = window;
    await flush();
    const form = window.document.querySelector('[data-form="magic-link"]') as HTMLFormElement;
    const tokenInput = form.querySelector('input[name="token"]') as HTMLInputElement;
    expect(form.classList.contains('hidden')).toBe(false);
    expect(tokenInput.value).toBe('magic_tok_123');
    expect(window.document.querySelector('[data-banner]')?.textContent).toContain(
      'Temporary sign-in failure.',
    );

    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(fetchCalls).toHaveLength(2);
    expect(window.localStorage.getItem('ds_web_session_token')).toBe('web_after_retry');
  });
});
