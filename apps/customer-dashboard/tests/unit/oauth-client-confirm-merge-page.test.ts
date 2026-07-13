import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installDashboardDeadline } from './dashboard-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(
  HERE,
  '..',
  '..',
  'dist',
  'auth',
  'oauth-client',
  'confirm-merge',
  'index.html',
);
const PAGE_URL = 'https://app.driftstack.dev/auth/oauth-client/confirm-merge/?token=merge_tok_123';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

function setUpDom(
  html: string,
  handler: (call: MockFetchCall) => Response | Promise<Response>,
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
  // @ts-expect-error — jsdom global is loose
  if (typeof window.Response !== 'function') window.Response = Response;
  // @ts-expect-error — jsdom global is loose
  window.fetch = (input: string, init: RequestInit | undefined) => {
    const call = { url: String(input), init };
    fetchCalls.push(call);
    return Promise.resolve(handler(call));
  };
  installDashboardDeadline(window);

  const pageScript = scriptBodies.find((body) => body.includes('data-page="oauth-confirm-merge"'));
  if (!pageScript) throw new Error('oauth confirm-merge inline script not found');
  // @ts-expect-error — jsdom global has eval
  window.eval(pageScript);
  return { window: window as JSDOM['window'], fetchCalls };
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('OAuth client merge confirmation page', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });
  const loadBuiltPage = (): string => readFileSync(BUILT_PAGE, 'utf8');

  it('turns a one-shot merge timeout into a connected-account check', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), () => Promise.reject(timeout));
    win = window;
    await flush(12);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({ token: 'merge_tok_123' });
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /outcome is unknown.*consumed this one-time token.*linked the identity provider.*do not reload or submit this link again.*check connected accounts.*provider is absent.*sign in with your password.*IDP button/i,
    );
    expect(
      window.document.querySelector('[data-merge-unknown]')?.classList.contains('hidden'),
    ).toBe(false);
    expect(window.document.querySelector('[data-merge-unknown] a')?.getAttribute('href')).toBe(
      '/security/',
    );
  });
});
