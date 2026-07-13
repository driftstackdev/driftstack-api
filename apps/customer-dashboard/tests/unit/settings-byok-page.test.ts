// Local integration test for the /settings page's BYOK-Anthropic flow
// (V-666): a customer stores / tests / clears their own Anthropic API
// key, which powers agent sessions. The stored key is sensitive, so the
// CLEAR action is confirm-gated. Covers the load empty/set states, the
// save (PUT) with its empty-key guard, the stored-key-only test (POST), and the
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
import { installDashboardDeadline } from './dashboard-test-runtime';

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
  last_used_at: string | null;
}
interface SetUpOpts {
  confirmReturns?: boolean;
  route: (call: MockFetchCall) => Response | Promise<Response>;
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
  installDashboardDeadline(window);
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

// Permissive router with a mutable BYOK holder. BYOK GET mirrors the
// metadata-only API contract; PUT sets it; DELETE clears it; /test → ok.
function makeRouter(
  byok: ByokState,
  opts: { testOk?: boolean } = {},
): (c: MockFetchCall) => Response | Promise<Response> {
  return (call: MockFetchCall): Response => {
    const method = (call.init?.method || 'GET').toUpperCase();
    const u = call.url.replace(/^https?:\/\/[^/]+/, '');
    if (/\/v1\/account\/me\/byok-anthropic-key\/test$/.test(u) && method === 'POST') {
      return json({ ok: opts.testOk ?? true });
    }
    if (/\/v1\/account\/me\/byok-anthropic-key$/.test(u)) {
      if (method === 'PUT') {
        byok.set = true;
        return json({ set_at: byok.set_at });
      }
      if (method === 'DELETE') {
        byok.set = false;
        return new Response(null, { status: 204 });
      }
      // GET
      return byok.set
        ? json({ has_key: true, set_at: byok.set_at, last_used_at: byok.last_used_at })
        : json({ has_key: false, set_at: null, last_used_at: null });
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
    last_used_at: null,
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

  it('load with has_key=false: shows the empty state', async () => {
    const { window } = setUpDom(loadBuiltPage(), { route: makeRouter(newByok({ set: false })) });
    win = window;
    await flush();
    expect(isHidden(window, '[data-byok-state="empty"]')).toBe(false);
    expect(isHidden(window, '[data-byok-state="set"]')).toBe(true);
    expect((window.document.querySelector('[data-byok-test]') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((window.document.querySelector('[data-byok-clear]') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('load with a stored key: consumes the API has_key contract and shows set/last-used metadata without a key prefix', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      route: makeRouter(newByok({ set: true, last_used_at: '2026-05-21T11:30:00.000Z' })),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-byok-state="set"]')).toBe(false);
    expect(isHidden(window, '[data-byok-state="empty"]')).toBe(true);
    expect(window.document.querySelector('[data-byok-set-at]')?.textContent).toBe('2026-05-20');
    expect(window.document.querySelector('[data-byok-last-used-at]')?.textContent).toBe(
      '2026-05-21',
    );
    expect(window.document.querySelector('[data-byok-prefix]')).toBeNull();
    expect((window.document.querySelector('[data-byok-test]') as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((window.document.querySelector('[data-byok-clear]') as HTMLButtonElement).disabled).toBe(
      false,
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

  it('ignores a stale initial metadata response that arrives after the post-save refresh', async () => {
    let resolveInitialGet: ((response: Response) => void) | undefined;
    let byokGetCount = 0;
    const byok = newByok({ set: false });
    const base = makeRouter(byok);
    const { window } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        const method = (call.init?.method || 'GET').toUpperCase();
        if (/\/v1\/account\/me\/byok-anthropic-key$/.test(call.url) && method === 'GET') {
          byokGetCount += 1;
          if (byokGetCount === 1) {
            return new Promise<Response>((resolve) => {
              resolveInitialGet = resolve;
            });
          }
        }
        return base(call);
      },
    });
    win = window;
    await flush();

    const form = window.document.querySelector('[data-byok-form]') as HTMLFormElement;
    const input = window.document.querySelector('#byok-key') as HTMLInputElement;
    input.value = 'sk-ant-api03-SECRET';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(10);

    expect(isHidden(window, '[data-byok-state="set"]')).toBe(false);
    expect((window.document.querySelector('[data-byok-test]') as HTMLButtonElement).disabled).toBe(
      false,
    );

    resolveInitialGet?.(json({ has_key: false, set_at: null, last_used_at: null }));
    await flush();

    expect(isHidden(window, '[data-byok-state="set"]')).toBe(false);
    expect(isHidden(window, '[data-byok-state="empty"]')).toBe(true);
    expect((window.document.querySelector('[data-byok-test]') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('committed save followed by AbortError refreshes authoritative metadata, reports likely completion, and clears the plaintext field', async () => {
    const byok = newByok({ set: false });
    const base = makeRouter(byok);
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        const method = (call.init?.method || 'GET').toUpperCase();
        if (/\/v1\/account\/me\/byok-anthropic-key$/.test(call.url) && method === 'PUT') {
          byok.set = true;
          byok.set_at = '2026-05-20T10:05:00.000Z';
          const error = new Error('response lost after commit');
          error.name = 'AbortError';
          return Promise.reject(error);
        }
        return base(call);
      },
    });
    win = window;
    await flush();

    const form = window.document.querySelector('[data-byok-form]') as HTMLFormElement;
    const input = window.document.querySelector('#byok-key') as HTMLInputElement;
    input.value = 'sk-ant-api03-SECRET';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(10);

    expect(fetchCalls.filter((call) => call.init?.method === 'PUT')).toHaveLength(1);
    expect(input.value).toBe('');
    expect(isHidden(window, '[data-byok-state="set"]')).toBe(false);
    expect(window.document.querySelector('[data-byok-set-at]')?.textContent).toBe('2026-05-20');
    expect(window.document.querySelector('[data-byok-error]')?.textContent).toMatch(
      /save likely completed.*timestamp advanced.*Test the stored key.*do not save again/i,
    );
  });

  it('uncommitted save timeout with unchanged metadata retains the plaintext and refuses to claim success', async () => {
    const byok = newByok({ set: true });
    const base = makeRouter(byok);
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        const method = (call.init?.method || 'GET').toUpperCase();
        if (/\/v1\/account\/me\/byok-anthropic-key$/.test(call.url) && method === 'PUT') {
          const error = new Error('request timed out before commit');
          error.name = 'AbortError';
          return Promise.reject(error);
        }
        return base(call);
      },
    });
    win = window;
    await flush();

    const form = window.document.querySelector('[data-byok-form]') as HTMLFormElement;
    const input = window.document.querySelector('#byok-key') as HTMLInputElement;
    input.value = 'sk-ant-api03-RETRY';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(10);

    expect(fetchCalls.filter((call) => call.init?.method === 'PUT')).toHaveLength(1);
    expect(input.value).toBe('sk-ant-api03-RETRY');
    expect(window.document.querySelector('[data-byok-error]')?.textContent).toMatch(
      /outcome is still unknown.*did not advance.*input is retained/i,
    );
    expect(window.document.querySelector('[data-byok-error]')?.textContent).not.toMatch(
      /likely completed/i,
    );
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

  it('committed clear followed by AbortError refreshes metadata and refuses a duplicate clear', async () => {
    const byok = newByok({ set: true });
    const base = makeRouter(byok);
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (
          call.init?.method === 'DELETE' &&
          /\/v1\/account\/me\/byok-anthropic-key$/.test(call.url)
        ) {
          byok.set = false;
          const error = new Error('response lost after clear');
          error.name = 'AbortError';
          return Promise.reject(error);
        }
        return base(call);
      },
    });
    win = window;
    await flush();

    (window.document.querySelector('[data-byok-clear]') as HTMLButtonElement).click();
    await flush(10);

    expect(fetchCalls.filter((call) => call.init?.method === 'DELETE')).toHaveLength(1);
    expect(isHidden(window, '[data-byok-state="empty"]')).toBe(false);
    expect(window.document.querySelector('[data-byok-error]')?.textContent).toMatch(
      /clear likely completed.*no stored key remains.*Do not clear again/i,
    );
    expect((window.document.querySelector('[data-byok-clear]') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('uncommitted clear timeout keeps the authoritative stored state without claiming success', async () => {
    const byok = newByok({ set: true });
    const base = makeRouter(byok);
    const { window } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (
          call.init?.method === 'DELETE' &&
          /\/v1\/account\/me\/byok-anthropic-key$/.test(call.url)
        ) {
          const error = new Error('request timed out before clear');
          error.name = 'AbortError';
          return Promise.reject(error);
        }
        return base(call);
      },
    });
    win = window;
    await flush();

    (window.document.querySelector('[data-byok-clear]') as HTMLButtonElement).click();
    await flush(10);

    expect(isHidden(window, '[data-byok-state="set"]')).toBe(false);
    expect(window.document.querySelector('[data-byok-error]')?.textContent).toMatch(
      /clear timed out.*key is still on file.*retry only if it remains present/i,
    );
    expect(window.document.querySelector('[data-byok-error]')?.textContent).not.toMatch(
      /likely completed/i,
    );
  });

  it('clear timeout plus refresh failure reports an unknown outcome and keeps actions disabled', async () => {
    let byokGets = 0;
    const byok = newByok({ set: true });
    const base = makeRouter(byok);
    const { window } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (/\/v1\/account\/me\/byok-anthropic-key$/.test(call.url)) {
          if (call.init?.method === 'DELETE') {
            const error = new Error('clear response lost');
            error.name = 'AbortError';
            return Promise.reject(error);
          }
          if ((call.init?.method || 'GET').toUpperCase() === 'GET') {
            byokGets += 1;
            if (byokGets > 1) return Promise.reject(new TypeError('status network down'));
          }
        }
        return base(call);
      },
    });
    win = window;
    await flush();

    (window.document.querySelector('[data-byok-clear]') as HTMLButtonElement).click();
    await flush(10);

    expect(isHidden(window, '[data-byok-state="error"]')).toBe(false);
    expect(window.document.querySelector('[data-byok-error]')?.textContent).toMatch(
      /clear outcome is unknown.*could not be refreshed.*Reload to verify before retrying/i,
    );
    expect((window.document.querySelector('[data-byok-test]') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((window.document.querySelector('[data-byok-clear]') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  // S35 2026-07-07 (fable-frontend-audit) — a transient non-2xx on the
  // status GET used to fall back to byokShowState('empty'), telling a
  // customer WITH a stored key "No key on file"; and the chain called
  // r.json() on the (HTML) error body without .catch, surfacing a
  // JSON-parse error instead of the HTTP status.
  it('load failure (502 with an HTML body): shows the ERROR state — never "No key on file" — with the parse-safe HTTP status, and Try again recovers', async () => {
    let gatewayDown = true;
    const base = makeRouter(newByok({ set: true }));
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
    expect(window.document.querySelector('[data-byok-set-at]')?.textContent).toBe('2026-05-20');
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

  it('tests only the confirmed stored key and never transmits plaintext from the input again', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: makeRouter(newByok({ set: true })),
    });
    win = window;
    await flush();

    const input = window.document.querySelector('#byok-key') as HTMLInputElement;
    input.value = 'sk-ant-api03-UNSAVED-PLAINTEXT';
    (window.document.querySelector('[data-byok-test]') as HTMLButtonElement).click();
    await flush();

    const testCall = fetchCalls.find(
      (call) =>
        call.init?.method === 'POST' &&
        /\/v1\/account\/me\/byok-anthropic-key\/test$/.test(call.url),
    );
    expect(testCall).toBeTruthy();
    expect(testCall?.init?.body).toBeUndefined();
    expect(new Headers(testCall?.init?.headers).has('content-type')).toBe(false);
    expect(JSON.stringify(testCall)).not.toContain('UNSAVED-PLAINTEXT');
  });

  it('uses one shared lease so save, test, and clear cannot race', async () => {
    let resolvePut: ((response: Response) => void) | undefined;
    const byok = newByok({ set: true });
    const base = makeRouter(byok);
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      confirmReturns: true,
      route: (call) => {
        if (
          call.init?.method === 'PUT' &&
          /\/v1\/account\/me\/byok-anthropic-key$/.test(call.url)
        ) {
          return new Promise<Response>((resolve) => {
            resolvePut = resolve;
          });
        }
        return base(call);
      },
    });
    win = window;
    await flush();

    const form = window.document.querySelector('[data-byok-form]') as HTMLFormElement;
    const input = window.document.querySelector('#byok-key') as HTMLInputElement;
    input.value = 'sk-ant-api03-SECRET';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    const test = window.document.querySelector('[data-byok-test]') as HTMLButtonElement;
    test.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    const clear = window.document.querySelector('[data-byok-clear]') as HTMLButtonElement;
    clear.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flush();

    let byokMutations = fetchCalls.filter(
      (call) =>
        /\/v1\/account\/me\/byok-anthropic-key(?:\/test)?$/.test(call.url) &&
        ['PUT', 'POST', 'DELETE'].includes(call.init?.method || ''),
    );
    expect(byokMutations.map((call) => call.init?.method)).toEqual(['PUT']);
    expect(test.disabled).toBe(true);
    expect(clear.disabled).toBe(true);
    expect(form.querySelector('button[type="submit"]')?.hasAttribute('aria-busy')).toBe(true);

    byok.set_at = '2026-05-20T10:05:00.000Z';
    resolvePut?.(json({ set_at: byok.set_at }));
    await flush(10);

    expect(test.disabled).toBe(false);
    expect(clear.disabled).toBe(false);
    test.click();
    await flush();
    byokMutations = fetchCalls.filter(
      (call) =>
        /\/v1\/account\/me\/byok-anthropic-key(?:\/test)?$/.test(call.url) &&
        ['PUT', 'POST', 'DELETE'].includes(call.init?.method || ''),
    );
    expect(byokMutations.map((call) => call.init?.method)).toEqual(['PUT', 'POST']);
    expect(byokMutations.every((call) => call.init?.signal instanceof window.AbortSignal)).toBe(
      true,
    );
  });
});
