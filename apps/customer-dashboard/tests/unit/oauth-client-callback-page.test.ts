import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(
  HERE,
  '..',
  '..',
  'dist',
  'auth',
  'oauth-client',
  'callback',
  'index.html',
);
const PAGE_URL =
  'https://app.driftstack.dev/auth/oauth-client/callback/?code=oauth_code_123&state=state_123&provider=github';

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

  const pageScript = scriptBodies.find((body) => body.includes('data-page="oauth-callback"'));
  if (!pageScript) throw new Error('oauth callback inline script not found');
  // @ts-expect-error — jsdom global has eval
  window.eval(pageScript);
  return { window: window as JSDOM['window'], fetchCalls };
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('OAuth client callback page', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });
  const loadBuiltPage = (): string => readFileSync(BUILT_PAGE, 'utf8');

  it('turns a callback timeout into a fresh-authorization recovery path', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), () => Promise.reject(timeout));
    win = window;
    await flush(12);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.init?.method).toBe('GET');
    expect(fetchCalls[0]?.url).toContain('code=oauth_code_123');
    expect(fetchCalls[0]?.url).toContain('state=state_123');
    expect(fetchCalls[0]?.url).toContain('provider=github');
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /outcome is unknown.*exchanged this one-time callback code.*session whose credential did not reach this browser.*account-link confirmation email.*do not reload or submit this callback URL again.*check your inbox first.*fresh provider authorization/i,
    );
    expect(
      window.document.querySelector('[data-callback-unknown]')?.classList.contains('hidden'),
    ).toBe(false);
    expect(window.document.querySelector('[data-callback-unknown] a')?.getAttribute('href')).toBe(
      '/login',
    );
  });
});
