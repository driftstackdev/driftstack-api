// Local integration test for the /settings page's BYOK-Anthropic flow
// (V-666): a customer stores / tests / clears their own Anthropic API
// key, which powers agent sessions. The stored key is sensitive, so the
// CLEAR action is confirm-gated. Covers the load empty/set states, the
// save (PUT) with its empty-key guard, the test (POST), and the
// confirm-gated clear (DELETE → back to empty). The settings page loads
// ~7 account endpoints concurrently (each independent .catch), so this
// uses a permissive stateful router with a mutable BYOK holder.
//
// Mirrors settings-page.test.ts (route-based; stubs driftstackConfirm).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'settings', 'index.html');
const PAGE_URL = 'https://app.driftstack.dev/settings/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}
interface ByokState {
  set: boolean;
  set_at: string;
  key_prefix: string;
}
interface SetUpOpts {
  confirmReturns?: boolean;
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
  const cr = opts.confirmReturns ?? true;
  // @ts-expect-error — driftstackConfirm is injected by DashboardLayout
  window.driftstackConfirm = () => Promise.resolve(cr);

  const pageScript = scriptBodies.find((s) => s.includes('data-page="settings"'));
  if (!pageScript) throw new Error('settings inline script not found');
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

// Permissive router with a mutable BYOK holder. byok GET → 404 when
// empty, else the metadata; PUT sets it; DELETE clears it; /test → ok.
function makeRouter(
  byok: ByokState,
  opts: { testOk?: boolean } = {},
): (c: MockFetchCall) => Response {
  return (call: MockFetchCall): Response => {
    const method = (call.init?.method || 'GET').toUpperCase();
    const u = call.url.replace(/^https?:\/\/[^/]+/, '');
    if (/\/v1\/account\/me\/byok-anthropic-key\/test$/.test(u) && method === 'POST') {
      return json({ ok: opts.testOk ?? true });
    }
    if (/\/v1\/account\/me\/byok-anthropic-key$/.test(u)) {
      if (method === 'PUT') {
        byok.set = true;
        return json({ key_set: true, set_at: byok.set_at, key_prefix: byok.key_prefix });
      }
      if (method === 'DELETE') {
        byok.set = false;
        return new Response(null, { status: 204 });
      }
      // GET
      return byok.set
        ? json({ key_set: true, set_at: byok.set_at, key_prefix: byok.key_prefix })
        : json({}, 404);
    }
    if (/\/v1\/account\/me$/.test(u) && method === 'GET') {
      return json({ email: 'me@example.com', name: 'Me', slug: 'me', region: 'eu' });
    }
    if (/\/v1\/account\/email-preferences$/.test(u)) return json({ data: [] });
    if (/\/v1\/account\/audit-log/.test(u)) return json({ data: [] });
    if (/\/v1\/account\/web-sessions$/.test(u)) return json({ data: [] });
    return json({}, 404); // oauth-links / mfa → handled gracefully
  };
}

function newByok(over: Partial<ByokState> = {}): ByokState {
  return {
    set: false,
    set_at: '2026-05-20T10:00:00.000Z',
    key_prefix: 'sk-ant-api03-abcd',
    ...over,
  };
}

describe('settings page — BYOK Anthropic key', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });
  const loadBuiltPage = (): string => readFileSync(BUILT_PAGE, 'utf8');

  it('load with no key (404): shows the empty state', async () => {
    const { window } = setUpDom(loadBuiltPage(), { route: makeRouter(newByok({ set: false })) });
    win = window;
    await flush();
    expect(isHidden(window, '[data-byok-state="empty"]')).toBe(false);
    expect(isHidden(window, '[data-byok-state="set"]')).toBe(true);
  });

  it('load with a stored key: shows the set state + the key prefix', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      route: makeRouter(newByok({ set: true, key_prefix: 'sk-ant-api03-XYZ' })),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-byok-state="set"]')).toBe(false);
    expect(isHidden(window, '[data-byok-state="empty"]')).toBe(true);
    expect(window.document.querySelector('[data-byok-prefix]')?.textContent).toBe(
      'sk-ant-api03-XYZ',
    );
  });

  it('save empty input: shows the "paste a key first" error, fires no PUT', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), { route: makeRouter(newByok()) });
    win = window;
    await flush();
    const form = window.document.querySelector('[data-byok-form]') as HTMLFormElement;
    (window.document.querySelector('#byok-key') as HTMLInputElement).value = '   ';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(isHidden(window, '[data-byok-error]')).toBe(false);
    expect(window.document.querySelector('[data-byok-error]')?.textContent).toMatch(
      /Paste an Anthropic API key/,
    );
    expect(fetchCalls.some((c) => c.init?.method === 'PUT')).toBe(false);
  });

  it('save a key: PUTs {api_key}, then the reload flips to the set state', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), { route: makeRouter(newByok()) });
    win = window;
    await flush();
    const form = window.document.querySelector('[data-byok-form]') as HTMLFormElement;
    (window.document.querySelector('#byok-key') as HTMLInputElement).value = 'sk-ant-api03-SECRET';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    const put = fetchCalls.find(
      (c) => c.init?.method === 'PUT' && /\/v1\/account\/me\/byok-anthropic-key$/.test(c.url),
    );
    expect(JSON.parse(String(put?.init?.body))).toEqual({ api_key: 'sk-ant-api03-SECRET' });
    expect(isHidden(window, '[data-byok-state="set"]')).toBe(false);
  });

  it('clear: confirm-gated DELETE then reload flips back to the empty state', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      confirmReturns: true,
      route: makeRouter(newByok({ set: true })),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-byok-state="set"]')).toBe(false);
    (window.document.querySelector('[data-byok-clear]') as HTMLButtonElement).click();
    await flush();
    const del = fetchCalls.find(
      (c) => c.init?.method === 'DELETE' && /\/v1\/account\/me\/byok-anthropic-key$/.test(c.url),
    );
    expect(del).toBeTruthy();
    expect(isHidden(window, '[data-byok-state="empty"]')).toBe(false);
  });

  // S35 2026-07-07 (fable-frontend-audit) — a transient non-2xx on the
  // status GET used to fall back to byokShowState('empty'), telling a
  // customer WITH a stored key "No key on file"; and the chain called
  // r.json() on the (HTML) error body without .catch, surfacing a
  // JSON-parse error instead of the HTTP status.
  it('load failure (502 with an HTML body): shows the ERROR state — never "No key on file" — with the parse-safe HTTP status, and Try again recovers', async () => {
    let gatewayDown = true;
    const base = makeRouter(newByok({ set: true, key_prefix: 'sk-ant-api03-XYZ' }));
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        const method = (call.init?.method || 'GET').toUpperCase();
        const u = call.url.replace(/^https?:\/\/[^/]+/, '');
        if (/\/v1\/account\/me\/byok-anthropic-key$/.test(u) && method === 'GET' && gatewayDown) {
          return new Response('<html><body>502 Bad Gateway</body></html>', {
            status: 502,
            headers: { 'content-type': 'text/html' },
          });
        }
        return base(call);
      },
    });
    win = window;
    await flush();
    // The regression: this used to show 'empty' ("No key on file").
    expect(isHidden(window, '[data-byok-state="error"]')).toBe(false);
    expect(isHidden(window, '[data-byok-state="empty"]')).toBe(true);
    expect(isHidden(window, '[data-byok-state="set"]')).toBe(true);
    // Parse-safe: the surfaced detail is the HTTP status, not a
    // JSON-parse exception message from the HTML body.
    expect(window.document.querySelector('[data-byok-error]')?.textContent).toBe('HTTP 502');
    // Try again re-fires the GET; with the gateway back, the stored key
    // shows as set.
    gatewayDown = false;
    const getsBefore = fetchCalls.filter(
      (c) => (c.init?.method || 'GET').toUpperCase() === 'GET' && /byok-anthropic-key$/.test(c.url),
    ).length;
    (window.document.querySelector('[data-byok-retry]') as HTMLButtonElement).click();
    await flush();
    const getsAfter = fetchCalls.filter(
      (c) => (c.init?.method || 'GET').toUpperCase() === 'GET' && /byok-anthropic-key$/.test(c.url),
    ).length;
    expect(getsAfter).toBe(getsBefore + 1);
    expect(isHidden(window, '[data-byok-state="set"]')).toBe(false);
    expect(isHidden(window, '[data-byok-state="error"]')).toBe(true);
    expect(window.document.querySelector('[data-byok-prefix]')?.textContent).toBe(
      'sk-ant-api03-XYZ',
    );
  });

  it('clear cancelled: no DELETE fired, the key stays set', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      confirmReturns: false,
      route: makeRouter(newByok({ set: true })),
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-byok-clear]') as HTMLButtonElement).click();
    await flush();
    expect(
      fetchCalls.some((c) => c.init?.method === 'DELETE' && /byok-anthropic-key$/.test(c.url)),
    ).toBe(false);
    expect(isHidden(window, '[data-byok-state="set"]')).toBe(false);
  });

  it('serializes duplicate save, test, and pre-confirm clear actions with signaled requests', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      confirmReturns: true,
      route: makeRouter(newByok({ set: true })),
    });
    win = window;
    await flush();

    const form = window.document.querySelector('[data-byok-form]') as HTMLFormElement;
    const input = window.document.querySelector('#byok-key') as HTMLInputElement;
    input.value = 'sk-ant-api03-SECRET';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    const test = window.document.querySelector('[data-byok-test]') as HTMLButtonElement;
    test.click();
    test.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    const clear = window.document.querySelector('[data-byok-clear]') as HTMLButtonElement;
    clear.click();
    clear.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flush();

    const byokMutations = fetchCalls.filter(
      (call) =>
        /\/v1\/account\/me\/byok-anthropic-key(?:\/test)?$/.test(call.url) &&
        ['PUT', 'POST', 'DELETE'].includes(call.init?.method || ''),
    );
    expect(byokMutations.map((call) => call.init?.method).sort()).toEqual([
      'DELETE',
      'POST',
      'PUT',
    ]);
    expect(byokMutations.every((call) => call.init?.signal instanceof window.AbortSignal)).toBe(
      true,
    );
    expect(clear.disabled).toBe(false);
    expect(clear.hasAttribute('aria-busy')).toBe(false);
  });
});
