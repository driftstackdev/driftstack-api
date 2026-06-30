// Local integration test for the /proxies page's inline script. Two
// behaviours were previously unverified (source-regex coverage only):
//
//   1. A transient GET /v1/account/me/proxies failure must NOT render
//      the "No saved proxies yet" empty state — that reads as the
//      customer's saved egress credentials having vanished. It should
//      show a distinct, retry-capable error state instead.
//   2. A successful SOCKS5 save must clear the form fields — leaving
//      them populated invites a customer to click Save again and
//      create a duplicate (the API has no dedup).
//
// Loads the BUILT page, mocks localStorage + fetch, eval's the script,
// and asserts the real hydrated-DOM branches. Mirrors profiles-page.test.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'proxies', 'index.html');
const PAGE_URL = 'https://app.driftstack.dev/proxies/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface SetUpOpts {
  route: (call: MockFetchCall) => Response;
}

function setUpDom(
  html: string,
  opts: SetUpOpts,
): { window: JSDOM['window']; fetchCalls: MockFetchCall[] } {
  const scriptBodies: string[] = [];
  const htmlNoScripts = html.replace(/<script[^>]*>([\s\S]*?)<\/script>/g, (_m, body: string) => {
    scriptBodies.push(body);
    return '';
  });
  const dom = new JSDOM(htmlNoScripts, {
    url: PAGE_URL,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const fetchCalls: MockFetchCall[] = [];
  // @ts-expect-error — jsdom global is loose
  if (typeof window.Response !== 'function') window.Response = Response;
  // @ts-expect-error — jsdom global is loose
  window.fetch = (input: string, init: RequestInit | undefined) => {
    const call: MockFetchCall = { url: String(input), init };
    fetchCalls.push(call);
    return Promise.resolve(opts.route(call));
  };
  window.localStorage.setItem('ds_web_session_token', 'tok');

  const pageScript = scriptBodies.find((s) => s.includes('data-page="proxies"'));
  if (!pageScript) throw new Error('proxies inline script not found');
  // @ts-expect-error — jsdom global has eval
  window.eval(pageScript);
  return { window: window as JSDOM['window'], fetchCalls };
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function isHidden(window: JSDOM['window'], selector: string): boolean {
  const el = window.document.querySelector(selector);
  if (!el) throw new Error(`selector not found: ${selector}`);
  return el.classList.contains('hidden');
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('proxies page — local integration', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });
  const loadBuiltPage = (): string => readFileSync(BUILT_PAGE, 'utf8');

  it('load failure: shows a retry-capable error state, NOT the "No saved proxies yet" empty state', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (/\/v1\/account\/me\/proxies$/.test(call.url)) return json({ detail: 'nope' }, 500);
        return json({ data: [] });
      },
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-banner]')).toBe(false);
    const emptyText = window.document.querySelector('[data-empty="proxies"]')?.textContent ?? '';
    expect(emptyText).not.toContain('No saved proxies yet');
    expect(isHidden(window, '[data-empty="proxies"]')).toBe(false);
    const retryBtn = window.document.querySelector(
      '[data-action="retry-proxies"]',
    ) as HTMLButtonElement | null;
    expect(retryBtn).toBeTruthy();
    const before = fetchCalls.length;
    retryBtn?.click();
    await flush();
    expect(fetchCalls.length).toBeGreaterThan(before);
  });

  it('genuine empty list (200, []): shows "No saved proxies yet"', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      route: () => json({ data: [] }),
    });
    win = window;
    await flush();
    expect(window.document.querySelector('[data-empty="proxies"]')?.textContent).toContain(
      'No saved proxies yet.',
    );
  });

  it('SOCKS5 save success: clears the form fields so "Saved." reads as a completed action (no stale values inviting a duplicate save)', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        const method = (call.init?.method || 'GET').toUpperCase();
        if (/\/v1\/account\/me\/proxies$/.test(call.url) && method === 'POST') {
          return json({ id: 'proxy_new' }, 201);
        }
        return json({ data: [] });
      },
    });
    win = window;
    await flush();
    const label = window.document.querySelector('#proxy-label') as HTMLInputElement;
    const host = window.document.querySelector('#proxy-host') as HTMLInputElement;
    const port = window.document.querySelector('#proxy-port') as HTMLInputElement;
    label.value = 'My proxy';
    host.value = 'proxy.example.com';
    port.value = '1080';
    (window.document.querySelector('[data-action="save-proxy"]') as HTMLButtonElement).click();
    await flush();
    expect(
      fetchCalls.some(
        (c) => c.init?.method === 'POST' && /\/v1\/account\/me\/proxies$/.test(c.url),
      ),
    ).toBe(true);
    expect(label.value).toBe('');
    expect(host.value).toBe('');
    expect(port.value).toBe('');
  });
});
