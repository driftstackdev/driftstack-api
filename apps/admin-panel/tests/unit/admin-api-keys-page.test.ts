// Local integration test for the admin /api-keys page's inline script,
// focused on the operator-security-critical FORCE-REVOKE flow (a staff
// admin revokes a customer's API key with a required, audited reason).
// A wiring bug here either blocks legitimate incident response or lets
// a revoke fire without the mandatory reason (which the audit row
// depends on). Loads the built dist page, mocks localStorage + fetch
// with a stateful URL router, and stubs the branded
// window.driftstackPrompt (injected by AdminLayout, not eval'd here).
//
// Mirrors the customer-dashboard page tests; admin pages are static
// (prerendered), so the built dist HTML is loadable.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installAdminDeadline } from './admin-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'api-keys', 'index.html');
const PAGE_URL = 'https://admin.driftstack.dev/api-keys/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}
interface AdminKey {
  id: string;
  name: string;
  key_prefix: string;
  account_id: string;
  scopes: string[];
  last_used_at: string | null;
  revoked_at: string | null;
}
interface SetUpOpts {
  token?: string | null;
  storageDenied?: boolean;
  promptReturns?: string | null;
  route: (call: MockFetchCall) => Response | Promise<Response>;
}

function setUpDom(
  html: string,
  opts: SetUpOpts,
): {
  window: JSDOM['window'];
  fetchCalls: MockFetchCall[];
  hydratedCount: () => number;
} {
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
  if (opts.storageDenied === true) {
    Object.defineProperty(window.localStorage, 'getItem', {
      configurable: true,
      value: () => {
        throw new Error('storage denied');
      },
    });
  } else if (opts.token !== null) {
    window.localStorage.setItem('ds_web_session_token', opts.token ?? 'staff-tok');
  }
  let hydrated = 0;
  // @ts-expect-error — injected by AdminLayout
  window.dashboardHydrated = () => {
    hydrated += 1;
  };
  const pr = opts.promptReturns === undefined ? 'suspected leak' : opts.promptReturns;
  // @ts-expect-error — driftstackPrompt is injected by AdminLayout
  window.driftstackPrompt = () => Promise.resolve(pr);
  installAdminDeadline(window);

  // The admin api-keys script is the LAST inline script that references
  // the page marker (AdminLayout's SSO-bridge script runs first).
  const pageScript = scriptBodies.find((s) => s.includes('data-page="admin-api-keys"'));
  if (!pageScript) throw new Error('admin api-keys inline script not found');
  // @ts-expect-error — jsdom global has eval
  window.eval(pageScript);
  return {
    window: window as JSDOM['window'],
    fetchCalls,
    hydratedCount: () => hydrated,
  };
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function bannerText(window: JSDOM['window']): string {
  return window.document.querySelector('[data-banner]')?.textContent ?? '';
}
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

function mkKey(over: Partial<AdminKey> = {}): AdminKey {
  return {
    id: 'key_' + Math.random().toString(36).slice(2, 8),
    name: 'CI key',
    key_prefix: 'ds_live_abcd',
    account_id: 'acc_1',
    scopes: ['read'],
    last_used_at: '2026-05-28T10:00:00.000Z',
    revoked_at: null,
    ...over,
  };
}

function makeRouter(keys: AdminKey[]): (c: MockFetchCall) => Response {
  return (call: MockFetchCall): Response => {
    const method = (call.init?.method || 'GET').toUpperCase();
    const u = call.url.replace(/^https?:\/\/[^/]+/, '');
    const rev = u.match(/\/v1\/admin\/api-keys\/([^/?]+)\/revoke$/);
    if (rev && method === 'POST') {
      const k = keys.find((x) => x.id === rev[1]);
      if (k) k.revoked_at = '2026-05-29T12:00:00.000Z';
      return new Response(null, { status: 204 });
    }
    if (/\/v1\/admin\/api-keys(\?|$)/.test(u) && method === 'GET') {
      return json({ data: keys });
    }
    return json({}, 404);
  };
}

describe('admin api-keys page — force-revoke (operator security)', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });
  const loadBuiltPage = (): string => readFileSync(BUILT_PAGE, 'utf8');

  it.each([
    ['signed out', { token: null }],
    ['storage denied', { storageDenied: true }],
  ])('%s: renders a fail-closed shell without network', async (_label, auth) => {
    const { window, fetchCalls, hydratedCount } = setUpDom(loadBuiltPage(), {
      ...auth,
      route: () => {
        throw new Error('must not fetch without a bearer');
      },
    });
    win = window;
    await flush();

    expect(fetchCalls).toHaveLength(0);
    expect(hydratedCount()).toBe(1);
    expect(bannerText(window)).toContain('Sign in with a staff admin account');
    expect(window.document.querySelector('[data-list="api-keys"]')?.textContent).toContain(
      'Sign in with a staff admin account',
    );
    expect(
      (window.document.querySelector('[data-live-refresh]') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('renders keys: active key gets a Revoke action; a revoked key does not', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: makeRouter([
        mkKey({ id: 'key_active', revoked_at: null }),
        mkKey({ id: 'key_dead', revoked_at: '2026-05-01T10:00:00.000Z' }),
      ]),
    });
    win = window;
    await flush();
    expect(
      window.document.querySelector('[data-action="revoke"][data-id="key_active"]'),
    ).toBeTruthy();
    expect(window.document.querySelector('[data-action="revoke"][data-id="key_dead"]')).toBeNull();
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.init?.signal).toBeInstanceOf(window.AbortSignal);
  });

  it('revoke with reason: prompts, POSTs /:id/revoke {reason}, then refresh marks it revoked', async () => {
    const keys = [mkKey({ id: 'key_active', revoked_at: null })];
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      promptReturns: 'customer reported leak',
      route: makeRouter(keys),
    });
    win = window;
    await flush();
    (
      window.document.querySelector(
        '[data-action="revoke"][data-id="key_active"]',
      ) as HTMLButtonElement
    ).click();
    await flush();
    const post = fetchCalls.find(
      (c) => c.init?.method === 'POST' && /\/v1\/admin\/api-keys\/key_active\/revoke$/.test(c.url),
    );
    expect(post).toBeTruthy();
    expect(post?.init?.signal).toBeInstanceOf(window.AbortSignal);
    expect(JSON.parse(String(post?.init?.body))).toEqual({ reason: 'customer reported leak' });
    // After the post-revoke refresh the key is revoked → no Revoke action.
    expect(
      window.document.querySelector('[data-action="revoke"][data-id="key_active"]'),
    ).toBeNull();
  });

  it('revoke with NO reason: cancels with the "reason is required" banner and fires no POST', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      promptReturns: '',
      route: makeRouter([mkKey({ id: 'key_active', revoked_at: null })]),
    });
    win = window;
    await flush();
    (
      window.document.querySelector(
        '[data-action="revoke"][data-id="key_active"]',
      ) as HTMLButtonElement
    ).click();
    await flush();
    expect(bannerText(window)).toMatch(/Revoke cancelled — reason is required\./);
    expect(fetchCalls.some((c) => c.init?.method === 'POST')).toBe(false);
  });

  it('single-flights revoke before the prompt resolves and stays visibly busy through the POST', async () => {
    const keys = [mkKey({ id: 'key_active', revoked_at: null })];
    let finishPost: (response: Response) => void = () => {};
    const pendingPost = new Promise<Response>((resolve) => {
      finishPost = resolve;
    });
    const fallback = makeRouter(keys);
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      promptReturns: 'confirmed leak',
      route: (call) => (call.init?.method === 'POST' ? pendingPost : fallback(call)),
    });
    win = window;
    await flush();
    const button = window.document.querySelector(
      '[data-action="revoke"][data-id="key_active"]',
    ) as HTMLButtonElement;
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flush(2);

    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.textContent).toBe('Revoking…');

    keys[0]!.revoked_at = '2026-05-29T12:00:00.000Z';
    finishPost(new Response(null, { status: 204 }));
    await flush();
    expect(
      window.document.querySelector('[data-action="revoke"][data-id="key_active"]'),
    ).toBeNull();
  });

  it('keeps a refreshed replacement row visibly busy and rejects a forced second revoke', async () => {
    const keys = [mkKey({ id: 'key_active', revoked_at: null })];
    let finishPost: (response: Response) => void = () => {};
    const pendingPost = new Promise<Response>((resolve) => {
      finishPost = resolve;
    });
    const fallback = makeRouter(keys);
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      promptReturns: 'confirmed leak',
      route: (call) => (call.init?.method === 'POST' ? pendingPost : fallback(call)),
    });
    win = window;
    await flush();

    const original = window.document.querySelector(
      '[data-action="revoke"][data-id="key_active"]',
    ) as HTMLButtonElement;
    original.click();
    await flush(2);
    (window.document.querySelector('[data-live-refresh]') as HTMLButtonElement).click();
    await flush();

    const replacement = window.document.querySelector(
      '[data-action="revoke"][data-id="key_active"]',
    ) as HTMLButtonElement;
    expect(replacement).not.toBe(original);
    expect(replacement.disabled).toBe(true);
    expect(replacement.getAttribute('aria-busy')).toBe('true');
    expect(replacement.title).toMatch(/wait for the current revocation/i);
    expect(replacement.textContent).toBe('Revocation pending…');
    replacement.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flush(2);
    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);

    keys[0]!.revoked_at = '2026-05-29T12:00:00.000Z';
    finishPost(new Response(null, { status: 204 }));
    await flush();
    expect(
      window.document.querySelector('[data-action="revoke"][data-id="key_active"]'),
    ).toBeNull();
  });

  it('revoke timeout refreshes committed security state before suggesting any retry', async () => {
    const keys = [mkKey({ id: 'key_active', revoked_at: null })];
    const fallback = makeRouter(keys);
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      promptReturns: 'confirmed leak',
      route: (call) => {
        if (call.init?.method === 'POST') {
          keys[0]!.revoked_at = '2026-05-29T12:00:00.000Z';
          return Promise.reject(timeout);
        }
        return fallback(call);
      },
    });
    win = window;
    await flush();
    (
      window.document.querySelector(
        '[data-action="revoke"][data-id="key_active"]',
      ) as HTMLButtonElement
    ).click();
    await flush(12);

    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
    expect(
      window.document.querySelector('[data-action="revoke"][data-id="key_active"]'),
    ).toBeNull();
    expect(bannerText(window)).toMatch(
      /outcome is unknown.*key list was refreshed.*gone or shows revoked.*completed.*do not submit it again.*still shows active.*retry/i,
    );
  });
});
