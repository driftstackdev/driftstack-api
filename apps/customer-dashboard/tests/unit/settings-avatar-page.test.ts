// Built-page behavior coverage for the Settings avatar lifecycle. The API
// deliberately distinguishes a removable customer upload from a read-only
// OAuth fallback; timeout recovery always refreshes /account/me before giving
// retry guidance so a lost response cannot leave a stale or dishonest control.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'settings', 'index.html');
const PAGE_URL = 'https://app.driftstack.dev/settings/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface AccountAvatarState {
  avatar_url: string | null;
  avatar_source: 'user' | 'idp' | 'none';
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function abortError(): Error {
  const error = new Error('response lost after commit');
  error.name = 'AbortError';
  return error;
}

function setUpDom(route: (call: MockFetchCall) => Response | Promise<Response>): {
  window: JSDOM['window'];
  fetchCalls: MockFetchCall[];
} {
  const html = readFileSync(BUILT_PAGE, 'utf8');
  const scripts: string[] = [];
  const htmlNoScripts = html.replace(/<script[^>]*>([\s\S]*?)<\/script>/g, (_m, body: string) => {
    scripts.push(body);
    return '';
  });
  const dom = new JSDOM(htmlNoScripts, {
    url: PAGE_URL,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const fetchCalls: MockFetchCall[] = [];
  // @ts-expect-error — jsdom does not expose undici Response by default.
  if (typeof window.Response !== 'function') window.Response = Response;
  // @ts-expect-error — test router intentionally provides the browser fetch seam.
  window.fetch = (input: string, init: RequestInit | undefined) => {
    const call = { url: String(input), init };
    fetchCalls.push(call);
    return Promise.resolve().then(() => route(call));
  };
  window.localStorage.setItem('ds_web_session_token', 'tok');
  const pageScript = scripts.find((body) => body.includes('data-page="settings"'));
  if (!pageScript) throw new Error('settings inline script not found');
  // @ts-expect-error — eval is the intended built-page behavior seam.
  window.eval(pageScript);
  return { window: window as JSDOM['window'], fetchCalls };
}

function baseRoute(state: AccountAvatarState): (call: MockFetchCall) => Response {
  return (call) => {
    const method = (call.init?.method || 'GET').toUpperCase();
    const path = call.url.replace(/^https?:\/\/[^/]+/, '');
    if (/\/v1\/account\/me$/.test(path) && method === 'GET') {
      return json({
        id: 'acc_test',
        email: 'me@example.test',
        name: 'Me',
        timezone: 'UTC',
        slug: 'me',
        region: 'eu',
        ...state,
      });
    }
    if (/\/v1\/account\/email-preferences$/.test(path)) return json({ data: [] });
    if (/\/v1\/account\/audit-log/.test(path)) return json({ data: [] });
    if (/\/v1\/account\/web-sessions$/.test(path)) return json({ data: [] });
    return json({}, 404);
  };
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('settings page — avatar source and ambiguous outcomes', () => {
  let win: JSDOM['window'] | null = null;

  afterEach(() => {
    win?.close?.();
    win = null;
  });

  it('shows an OAuth fallback honestly without a Remove control', async () => {
    const state: AccountAvatarState = {
      avatar_url: 'https://images.example.test/idp.png',
      avatar_source: 'idp',
    };
    const { window } = setUpDom(baseRoute(state));
    win = window;
    await flush();

    const remove = window.document.querySelector(
      '[data-button="avatar-remove"]',
    ) as HTMLButtonElement;
    expect(remove.hidden).toBe(true);
    expect(window.document.querySelector('[data-field="avatar-source"]')?.textContent).toContain(
      'linked sign-in',
    );
    expect(
      window.document.querySelector('[data-field="avatar-preview"] img')?.getAttribute('src'),
    ).toBe(state.avatar_url);
  });

  it('reconciles a committed first upload whose response times out', async () => {
    const state: AccountAvatarState = {
      avatar_url: 'https://images.example.test/idp.png',
      avatar_source: 'idp',
    };
    const base = baseRoute(state);
    const { window, fetchCalls } = setUpDom((call) => {
      if (call.init?.method === 'POST' && /\/v1\/account\/me\/avatar$/.test(call.url)) {
        state.avatar_url = 'https://r2.example.test/avatars/account.png?sig=new';
        state.avatar_source = 'user';
        return Promise.reject(abortError());
      }
      return base(call);
    });
    win = window;
    await flush();

    const input = window.document.querySelector('[data-field="avatar-input"]') as HTMLInputElement;
    const file = new window.File([new Uint8Array([137, 80, 78, 71])], 'avatar.png', {
      type: 'image/png',
    });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    await flush(16);

    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
    expect(
      (window.document.querySelector('[data-button="avatar-remove"]') as HTMLButtonElement).hidden,
    ).toBe(false);
    expect(window.document.querySelector('[data-field="avatar-status"]')?.textContent).toContain(
      'Do not upload it again',
    );
  });

  it('reconciles a committed removal timeout and restores the OAuth fallback', async () => {
    const state: AccountAvatarState = {
      avatar_url: 'https://r2.example.test/avatars/account.png?sig=old',
      avatar_source: 'user',
    };
    const base = baseRoute(state);
    const { window, fetchCalls } = setUpDom((call) => {
      if (call.init?.method === 'DELETE' && /\/v1\/account\/me\/avatar$/.test(call.url)) {
        state.avatar_url = 'https://images.example.test/idp.png';
        state.avatar_source = 'idp';
        return Promise.reject(abortError());
      }
      return base(call);
    });
    win = window;
    await flush();

    const remove = window.document.querySelector(
      '[data-button="avatar-remove"]',
    ) as HTMLButtonElement;
    expect(remove.hidden).toBe(false);
    remove.click();
    await flush(14);

    expect(fetchCalls.filter((call) => call.init?.method === 'DELETE')).toHaveLength(1);
    expect(remove.hidden).toBe(true);
    expect(
      window.document.querySelector('[data-field="avatar-preview"] img')?.getAttribute('src'),
    ).toBe(state.avatar_url);
    expect(window.document.querySelector('[data-field="avatar-status"]')?.textContent).toContain(
      'removal completed',
    );
  });
});
