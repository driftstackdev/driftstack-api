// Built-page integration coverage for the admin API-key list. The inline
// script owns cursor pagination, 30-second live refresh, and the security-
// critical force-revoke flow, so tests execute the generated HTML exactly as
// a browser would and drive deterministic fetch races around those owners.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installAdminDeadline } from './admin-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'api-keys', 'index.html');
const PAGE_SOURCE = resolve(HERE, '..', '..', 'src', 'pages', 'api-keys.astro');
const PAGE_URL = 'https://admin.driftstack.io/api-keys/';
const REVOKED_AT = '2026-07-17T12:00:00.000Z';

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
  expires_at: string | null;
  created_at: string;
}

interface SetUpOpts {
  token?: string | null;
  storageDenied?: boolean;
  promptReturns?: string | null | Promise<string | null>;
  pageScript?: string;
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
    Object.defineProperty(Object.getPrototypeOf(window.localStorage), 'getItem', {
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
  const promptResult =
    opts.promptReturns === undefined ? 'customer reported credential leak' : opts.promptReturns;
  // @ts-expect-error — driftstackPrompt is injected by AdminLayout
  window.driftstackPrompt = () => Promise.resolve(promptResult);
  installAdminDeadline(window);

  const pageScript =
    opts.pageScript ?? scriptBodies.find((script) => script.includes('data-page="admin-api-keys"'));
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

function currentInlinePageScript(): string {
  const source = readFileSync(PAGE_SOURCE, 'utf8');
  const match = source.match(
    /<script is:inline define:vars=\{\{ apiBaseUrl \}\}>([\s\S]*?)<\/script>/,
  );
  if (!match?.[1]) throw new Error('admin api-keys source inline script not found');
  return `const apiBaseUrl = "https://api.driftstack.dev";\n${match[1]}`;
}

function stableUuid(seed: string): string {
  let state = 0x811c9dc5;
  let hex = '';
  for (let i = 0; i < 32; i += 1) {
    const code = seed.length === 0 ? 0 : seed.charCodeAt(i % seed.length);
    state = Math.imul(state ^ (code + i), 0x01000193) >>> 0;
    hex += (state & 0xf).toString(16);
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function keyId(value: string): string {
  return /^key_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    ? value
    : `key_${stableUuid(value)}`;
}

function accountId(value: string): string {
  return /^acc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    ? value
    : `acc_${stableUuid(value)}`;
}

function mkKey(over: Partial<AdminKey> = {}): AdminKey {
  const key = {
    id: 'key_default',
    name: 'CI key',
    key_prefix: 'ds_live_abcd',
    account_id: 'acc_1',
    scopes: ['read'],
    last_used_at: '2026-05-28T10:00:00.000Z',
    revoked_at: null,
    expires_at: null,
    created_at: '2026-05-01T10:00:00.000Z',
    ...over,
  };
  return { ...key, id: keyId(key.id), account_id: accountId(key.account_id) };
}

function bannerText(window: JSDOM['window']): string {
  return window.document.querySelector('[data-banner]')?.textContent ?? '';
}

function row(window: JSDOM['window'], id: string): HTMLTableRowElement | null {
  return window.document.querySelector(`[data-key-id="${keyId(id)}"]`);
}

function cursorOf(call: MockFetchCall): string | null {
  return new URL(call.url, PAGE_URL).searchParams.get('cursor');
}

function isGet(call: MockFetchCall): boolean {
  return (call.init?.method || 'GET').toUpperCase() === 'GET';
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function settlePromises(times = 16): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe('admin api-keys page — pagination and force revoke', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
    vi.useRealTimers();
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

  it.each([
    ['null envelope', null],
    ['array envelope', []],
    ['missing data', { next_cursor: null }],
    ['non-array data', { data: {}, next_cursor: null }],
    ['missing next_cursor', { data: [] }],
    ['empty next_cursor', { data: [], next_cursor: '' }],
    ['non-string next_cursor', { data: [], next_cursor: 7 }],
    ['non-object row', { data: [null], next_cursor: null }],
    ['empty row id', { data: [{ ...mkKey(), id: '' }], next_cursor: null }],
    [
      'noncanonical row id',
      { data: [{ ...mkKey(), id: 'key_not-a-canonical-uuid' }], next_cursor: null },
    ],
    ['noncanonical account id', { data: [{ ...mkKey(), account_id: 'acc_1' }], next_cursor: null }],
    ['non-string account id', { data: [{ ...mkKey(), account_id: 7 }], next_cursor: null }],
    ['non-string name', { data: [{ ...mkKey(), name: null }], next_cursor: null }],
    ['non-string key prefix', { data: [{ ...mkKey(), key_prefix: false }], next_cursor: null }],
    ['non-array scopes', { data: [{ ...mkKey(), scopes: 'read' }], next_cursor: null }],
    ['non-string scope member', { data: [{ ...mkKey(), scopes: ['read', 7] }], next_cursor: null }],
    [
      'unknown string scope member',
      { data: [{ ...mkKey(), scopes: ['read', 'future:unknown'] }], next_cursor: null },
    ],
    [
      'missing last-used timestamp',
      { data: [{ ...mkKey(), last_used_at: undefined }], next_cursor: null },
    ],
    [
      'invalid last-used timestamp',
      { data: [mkKey({ last_used_at: 'not-iso' })], next_cursor: null },
    ],
    [
      'invalid revoked status timestamp',
      { data: [mkKey({ revoked_at: '2026-02-31T00:00:00.000Z' })], next_cursor: null },
    ],
    [
      'invalid expiry status type',
      { data: [{ ...mkKey(), expires_at: false }], next_cursor: null },
    ],
    [
      'missing created timestamp',
      { data: [{ ...mkKey(), created_at: undefined }], next_cursor: null },
    ],
    [
      'invalid optional account email type',
      { data: [{ ...mkKey(), account_email: 7 }], next_cursor: null },
    ],
  ])('malformed newest response (%s) renders unavailable, never empty', async (_label, body) => {
    const { window } = setUpDom(loadBuiltPage(), {
      pageScript: currentInlinePageScript(),
      route: () => json(body),
    });
    win = window;
    await flush();

    const listText = window.document.querySelector('[data-list="api-keys"]')?.textContent ?? '';
    expect(listText).toContain('Could not load API keys');
    expect(listText).not.toContain('No keys match the current filter');
    expect(window.document.querySelector('[data-key-id]')).toBeNull();
    expect(
      window.document.querySelector('[data-action="load-more"]')?.classList.contains('hidden'),
    ).toBe(true);
  });

  it('rejects a malformed append atomically and retries the exact cursor', async () => {
    const cursor = 'opaque/retry+cursor==';
    let appendAttempts = 0;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      pageScript: currentInlinePageScript(),
      route(call) {
        if (cursorOf(call) !== cursor) {
          return json({ data: [mkKey({ id: 'key_newest' })], next_cursor: cursor });
        }
        appendAttempts += 1;
        if (appendAttempts === 1) {
          return json({
            data: [
              mkKey({ id: 'key_must_not_commit' }),
              { ...mkKey({ id: 'key_bad' }), revoked_at: 'not-iso' },
            ],
            next_cursor: null,
          });
        }
        return json({ data: [mkKey({ id: 'key_older' })], next_cursor: null });
      },
    });
    win = window;
    await flush();

    const loadMore = window.document.querySelector(
      '[data-action="load-more"]',
    ) as HTMLButtonElement;
    loadMore.click();
    await flush();

    expect(row(window, 'key_newest')).not.toBeNull();
    expect(row(window, 'key_must_not_commit')).toBeNull();
    expect(row(window, 'key_bad')).toBeNull();
    expect(loadMore.classList.contains('hidden')).toBe(false);
    expect(loadMore.disabled).toBe(false);
    expect(bannerText(window)).toContain('Existing rows and cursor are unchanged');

    loadMore.click();
    await flush();

    expect(fetchCalls.filter((call) => cursorOf(call) === cursor)).toHaveLength(2);
    expect(row(window, 'key_newest')).not.toBeNull();
    expect(row(window, 'key_older')).not.toBeNull();
    expect(row(window, 'key_must_not_commit')).toBeNull();
    expect(loadMore.classList.contains('hidden')).toBe(true);
  });

  it('preserves bearer/cookie/deadline wiring and filters reset to a cursorless first page', async () => {
    let firstPageLoads = 0;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route(call) {
        const url = new URL(call.url, PAGE_URL);
        if (url.searchParams.has('cursor')) {
          return json({ data: [mkKey({ id: 'key_older' })], next_cursor: null });
        }
        firstPageLoads += 1;
        return firstPageLoads === 1
          ? json({ data: [mkKey({ id: 'key_newest' })], next_cursor: 'cur_older' })
          : json({ data: [mkKey({ id: 'key_filtered' })], next_cursor: null });
      },
    });
    win = window;
    await flush();

    const first = fetchCalls[0]!;
    expect(new URL(first.url).searchParams.get('limit')).toBe('50');
    expect(cursorOf(first)).toBeNull();
    expect(first.init?.headers).toEqual({ authorization: 'Bearer staff-tok' });
    expect(first.init?.credentials).toBe('include');
    expect(first.init?.signal).toBeInstanceOf(window.AbortSignal);

    (window.document.querySelector('[data-action="load-more"]') as HTMLButtonElement).click();
    await flush();
    expect(row(window, 'key_older')).not.toBeNull();

    const account = window.document.querySelector('[data-field="account-id"]') as HTMLInputElement;
    const hideRevoked = window.document.querySelector(
      '[data-field="hide-revoked"]',
    ) as HTMLInputElement;
    account.value = 'acc_filter';
    hideRevoked.checked = true;
    account.dispatchEvent(new window.Event('input', { bubbles: true }));
    hideRevoked.dispatchEvent(new window.Event('change', { bubbles: true }));
    const loadMoreDuringFilter = window.document.querySelector(
      '[data-action="load-more"]',
    ) as HTMLButtonElement;
    expect(loadMoreDuringFilter.disabled).toBe(true);
    loadMoreDuringFilter.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flush(1);
    expect(fetchCalls.filter((call) => cursorOf(call) !== null)).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 230));
    await flush();

    const filteredCall = fetchCalls.filter(isGet).at(-1)!;
    const filteredUrl = new URL(filteredCall.url, PAGE_URL);
    expect(filteredUrl.searchParams.get('account_id')).toBe('acc_filter');
    expect(filteredUrl.searchParams.get('revoked')).toBe('false');
    expect(filteredUrl.searchParams.get('cursor')).toBeNull();
    expect(row(window, 'key_filtered')).not.toBeNull();
    expect(row(window, 'key_newest')).toBeNull();
    expect(row(window, 'key_older')).toBeNull();
    expect(
      window.document.querySelector('[data-action="back-to-newest"]')?.classList.contains('hidden'),
    ).toBe(true);
  });

  it('single-flights an exact opaque cursor and dedupes overlapping ids', async () => {
    const cursor = 'older/2+opaque value==';
    let resolveOlder: ((response: Response) => void) | undefined;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route(call) {
        if (cursorOf(call) === cursor) {
          return new Promise<Response>((resolve) => {
            resolveOlder = resolve;
          });
        }
        return json({ data: [mkKey({ id: 'key_1' })], next_cursor: cursor });
      },
    });
    win = window;
    await flush();

    const loadMore = window.document.querySelector(
      '[data-action="load-more"]',
    ) as HTMLButtonElement;
    loadMore.click();
    loadMore.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flush(1);

    const appendCalls = fetchCalls.filter((call) => cursorOf(call) !== null);
    expect(appendCalls).toHaveLength(1);
    expect(cursorOf(appendCalls[0]!)).toBe(cursor);
    expect(loadMore.disabled).toBe(true);
    expect(loadMore.textContent).toBe('Loading…');
    expect(loadMore.getAttribute('aria-busy')).toBe('true');

    resolveOlder?.(
      json({
        data: [mkKey({ id: 'key_1', revoked_at: REVOKED_AT }), mkKey({ id: 'key_2' })],
        next_cursor: null,
      }),
    );
    await flush();

    expect(window.document.querySelectorAll('[data-key-id]')).toHaveLength(2);
    expect(row(window, 'key_1')?.textContent).toMatch(/revoked/i);
    expect(row(window, 'key_2')).not.toBeNull();
    expect(loadMore.classList.contains('hidden')).toBe(true);
    expect(
      window.document.querySelector('[data-action="back-to-newest"]')?.classList.contains('hidden'),
    ).toBe(false);
    expect(window.document.querySelector('[data-live-status]')?.textContent).toBe(
      'Live refresh paused while viewing older API keys',
    );
  });

  it('keeps unique rows but refuses to request a repeated append cursor again', async () => {
    const cursor = 'cur_repeat';
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route(call) {
        return cursorOf(call) === cursor
          ? json({ data: [mkKey({ id: 'key_repeated_page' })], next_cursor: cursor })
          : json({ data: [mkKey({ id: 'key_first' })], next_cursor: cursor });
      },
    });
    win = window;
    await flush();

    const loadMore = window.document.querySelector(
      '[data-action="load-more"]',
    ) as HTMLButtonElement;
    loadMore.click();
    await flush();

    expect(row(window, 'key_first')).not.toBeNull();
    expect(row(window, 'key_repeated_page')).not.toBeNull();
    expect(loadMore.classList.contains('hidden')).toBe(true);
    expect(bannerText(window)).toMatch(
      /server repeated a cursor.*unique rows.*will not be requested again/i,
    );
    loadMore.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flush(1);
    expect(fetchCalls.filter((call) => cursorOf(call) === cursor)).toHaveLength(1);
  });

  it('refuses a multi-page cursor cycle, not only an immediate repeat', async () => {
    const cursorA = 'cur_cycle_a';
    const cursorB = 'cur_cycle_b';
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route(call) {
        if (cursorOf(call) === cursorA) {
          return json({ data: [mkKey({ id: 'key_page_a' })], next_cursor: cursorB });
        }
        if (cursorOf(call) === cursorB) {
          return json({ data: [mkKey({ id: 'key_page_b' })], next_cursor: cursorA });
        }
        return json({ data: [mkKey({ id: 'key_first' })], next_cursor: cursorA });
      },
    });
    win = window;
    await flush();

    const loadMore = window.document.querySelector(
      '[data-action="load-more"]',
    ) as HTMLButtonElement;
    loadMore.click();
    await flush();
    loadMore.click();
    await flush();

    expect(row(window, 'key_page_a')).not.toBeNull();
    expect(row(window, 'key_page_b')).not.toBeNull();
    expect(loadMore.classList.contains('hidden')).toBe(true);
    loadMore.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flush(1);
    expect(fetchCalls.filter((call) => cursorOf(call) === cursorA)).toHaveLength(1);
    expect(fetchCalls.filter((call) => cursorOf(call) === cursorB)).toHaveLength(1);
  });

  it('preserves rows and cursor after append failure, then retries the same cursor', async () => {
    const cursor = 'cur_retry';
    let attempts = 0;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route(call) {
        if (cursorOf(call) === cursor) {
          attempts += 1;
          return attempts === 1
            ? json({ detail: 'temporary failure' }, 503)
            : json({ data: [mkKey({ id: 'key_2' })], next_cursor: null });
        }
        return json({ data: [mkKey({ id: 'key_1' })], next_cursor: cursor });
      },
    });
    win = window;
    await flush();

    const loadMore = window.document.querySelector(
      '[data-action="load-more"]',
    ) as HTMLButtonElement;
    loadMore.click();
    await flush();
    expect(row(window, 'key_1')).not.toBeNull();
    expect(row(window, 'key_2')).toBeNull();
    expect(bannerText(window)).toMatch(/older API keys.*rows and cursor are unchanged/i);
    expect(loadMore.disabled).toBe(false);
    expect(loadMore.classList.contains('hidden')).toBe(false);

    loadMore.click();
    await flush();
    expect(fetchCalls.filter((call) => cursorOf(call) === cursor)).toHaveLength(2);
    expect(row(window, 'key_1')).not.toBeNull();
    expect(row(window, 'key_2')).not.toBeNull();
  });

  it('makes a held append inert when explicit Refresh takes a new list epoch', async () => {
    const cursor = 'cur_stale';
    let firstPageLoads = 0;
    let resolveOlder: ((response: Response) => void) | undefined;
    const { window } = setUpDom(loadBuiltPage(), {
      route(call) {
        if (cursorOf(call) === cursor) {
          return new Promise<Response>((resolve) => {
            resolveOlder = resolve;
          });
        }
        firstPageLoads += 1;
        return firstPageLoads === 1
          ? json({ data: [mkKey({ id: 'key_old' })], next_cursor: cursor })
          : json({ data: [mkKey({ id: 'key_fresh' })], next_cursor: 'cur_fresh' });
      },
    });
    win = window;
    await flush();

    (window.document.querySelector('[data-action="load-more"]') as HTMLButtonElement).click();
    await flush(1);
    const refresh = window.document.querySelector('[data-live-refresh]') as HTMLButtonElement;
    expect(refresh.disabled).toBe(false);
    refresh.click();
    await flush();

    resolveOlder?.(json({ data: [mkKey({ id: 'key_stale' })], next_cursor: null }));
    await flush();

    expect(row(window, 'key_fresh')).not.toBeNull();
    expect(row(window, 'key_old')).toBeNull();
    expect(row(window, 'key_stale')).toBeNull();
    expect(refresh.disabled).toBe(false);
    expect(window.document.querySelector('[data-live-status]')?.textContent).toBe('Live · updated');
  });

  it('pauses the 30-second poll while expanded and Back to newest resets the first page', async () => {
    vi.useFakeTimers();
    const cursor = 'cur_older';
    let firstPageLoads = 0;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route(call) {
        if (cursorOf(call) === cursor) {
          return json({ data: [mkKey({ id: 'key_older' })], next_cursor: null });
        }
        firstPageLoads += 1;
        return firstPageLoads === 1
          ? json({ data: [mkKey({ id: 'key_newest' })], next_cursor: cursor })
          : json({ data: [mkKey({ id: 'key_refreshed' })], next_cursor: null });
      },
    });
    win = window;
    await vi.advanceTimersByTimeAsync(0);
    await settlePromises();

    (window.document.querySelector('[data-action="load-more"]') as HTMLButtonElement).click();
    await settlePromises();
    expect(row(window, 'key_older')).not.toBeNull();

    const countWhileExpanded = fetchCalls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    await settlePromises();
    expect(fetchCalls).toHaveLength(countWhileExpanded);
    expect(window.document.querySelector('[data-live-status]')?.textContent).toBe(
      'Live refresh paused while viewing older API keys',
    );

    (window.document.querySelector('[data-action="back-to-newest"]') as HTMLButtonElement).click();
    await settlePromises();
    expect(fetchCalls).toHaveLength(countWhileExpanded + 1);
    expect(cursorOf(fetchCalls.at(-1)!)).toBeNull();
    expect(row(window, 'key_refreshed')).not.toBeNull();
    expect(row(window, 'key_newest')).toBeNull();
    expect(row(window, 'key_older')).toBeNull();
    // Node 22 settles this DOM update one macrotask later than 24+, so a fixed
    // settle depth reads the stale text there (measured: fails on 22, passes on 26).
    // Poll for the state instead of assuming when it lands.
    await vi.waitFor(() =>
      expect(window.document.querySelector('[data-live-status]')?.textContent).toBe(
        'Live · updated',
      ),
    );
  });

  it('does not let the 30-second poll supersede the first held append', async () => {
    vi.useFakeTimers();
    const cursor = 'cur_held_poll';
    let resolveOlder: ((response: Response) => void) | undefined;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route(call) {
        if (cursorOf(call) === cursor) {
          return new Promise<Response>((resolve) => {
            resolveOlder = resolve;
          });
        }
        return json({ data: [mkKey({ id: 'key_newest' })], next_cursor: cursor });
      },
    });
    win = window;
    await vi.advanceTimersByTimeAsync(0);
    await settlePromises();

    (window.document.querySelector('[data-action="load-more"]') as HTMLButtonElement).click();
    await settlePromises();
    expect(fetchCalls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(30_000);
    await settlePromises();
    expect(fetchCalls).toHaveLength(2);

    resolveOlder?.(json({ data: [mkKey({ id: 'key_older' })], next_cursor: null }));
    await settlePromises();
    expect(row(window, 'key_newest')).not.toBeNull();
    expect(row(window, 'key_older')).not.toBeNull();
    // Node 22 settles this DOM update one macrotask later than 24+, so a fixed
    // settle depth reads the stale text there (measured: fails on 22, passes on 26).
    // Poll for the state instead of assuming when it lands.
    await vi.waitFor(() =>
      expect(window.document.querySelector('[data-live-status]')?.textContent).toBe(
        'Live refresh paused while viewing older API keys',
      ),
    );
  });

  it('renders revoked > expired > active precedence and never offers revoke for expired keys', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      route: () =>
        json({
          data: [
            mkKey({
              id: 'key_revoked',
              revoked_at: '2020-01-01T00:00:00.000Z',
              expires_at: '2000-01-01T00:00:00.000Z',
            }),
            mkKey({ id: 'key_expired', expires_at: '2000-01-01T00:00:00.000Z' }),
            mkKey({ id: 'key_active', expires_at: '2999-01-01T00:00:00.000Z' }),
          ],
          next_cursor: null,
        }),
    });
    win = window;
    await flush();

    expect(row(window, 'key_revoked')?.textContent).toMatch(/revoked/i);
    expect(row(window, 'key_revoked')?.textContent).not.toMatch(/expired/i);
    expect(row(window, 'key_expired')?.textContent).toMatch(/expired/i);
    expect(row(window, 'key_expired')?.querySelector('[data-action="revoke"]')).toBeNull();
    expect(row(window, 'key_active')?.textContent).toMatch(/active/i);
    expect(row(window, 'key_active')?.querySelector('[data-action="revoke"]')).not.toBeNull();
  });

  it('requires a non-empty staff-audit reason before sending a revoke', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      promptReturns: '   ',
      route: () => json({ data: [mkKey({ id: 'key_active' })], next_cursor: null }),
    });
    win = window;
    await flush();

    (
      row(window, 'key_active')?.querySelector('[data-action="revoke"]') as HTMLButtonElement
    ).click();
    await flush();
    expect(fetchCalls.some((call) => call.init?.method === 'POST')).toBe(false);
    expect(bannerText(window)).toMatch(/reason is required/i);
  });

  it('disables pagination, filters, and explicit refresh for the full revoke request lease', async () => {
    let resolvePrompt: ((reason: string) => void) | undefined;
    let resolvePost: ((response: Response) => void) | undefined;
    let revoked = false;
    const prompt = new Promise<string>((resolve) => {
      resolvePrompt = resolve;
    });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      promptReturns: prompt,
      route(call) {
        if (call.init?.method === 'POST') {
          return new Promise<Response>((resolve) => {
            resolvePost = resolve;
          });
        }
        return json({
          data: [mkKey({ id: 'key_active', revoked_at: revoked ? REVOKED_AT : null })],
          next_cursor: revoked ? null : 'cur_more',
        });
      },
    });
    win = window;
    await flush();

    const revoke = row(window, 'key_active')?.querySelector(
      '[data-action="revoke"]',
    ) as HTMLButtonElement;
    revoke.click();
    await flush(1);

    const account = window.document.querySelector('[data-field="account-id"]') as HTMLInputElement;
    const hideRevoked = window.document.querySelector(
      '[data-field="hide-revoked"]',
    ) as HTMLInputElement;
    const loadMore = window.document.querySelector(
      '[data-action="load-more"]',
    ) as HTMLButtonElement;
    const refresh = window.document.querySelector('[data-live-refresh]') as HTMLButtonElement;
    expect(account.disabled).toBe(true);
    expect(hideRevoked.disabled).toBe(true);
    expect(loadMore.disabled).toBe(true);
    expect(refresh.disabled).toBe(true);

    account.value = 'acc_blocked';
    account.dispatchEvent(new window.Event('input', { bubbles: true }));
    loadMore.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    refresh.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 230));
    expect(fetchCalls.filter(isGet)).toHaveLength(1);

    resolvePrompt?.('incident 42');
    await flush(2);
    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
    expect(account.disabled).toBe(true);
    expect(refresh.disabled).toBe(true);

    revoked = true;
    resolvePost?.(json({ id: keyId('key_active'), revoked_at: REVOKED_AT }));
    await flush(12);
    expect(fetchCalls.filter(isGet)).toHaveLength(2);
    expect(account.disabled).toBe(false);
    expect(hideRevoked.disabled).toBe(false);
    expect(refresh.disabled).toBe(false);
    expect(row(window, 'key_active')?.textContent).toMatch(/revoked/i);
  });

  it('validates real 200 success, patches locally, and supersedes an older first-page owner', async () => {
    let getCount = 0;
    let resolveStaleRefresh: ((response: Response) => void) | undefined;
    let resolveReconciliation: ((response: Response) => void) | undefined;
    const active = mkKey({ id: 'key_active' });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route(call) {
        if (call.init?.method === 'POST') {
          return json({ id: keyId('key_active'), revoked_at: REVOKED_AT });
        }
        getCount += 1;
        if (getCount === 2) {
          return new Promise<Response>((resolve) => {
            resolveStaleRefresh = resolve;
          });
        }
        if (getCount === 3) {
          return new Promise<Response>((resolve) => {
            resolveReconciliation = resolve;
          });
        }
        // The reconciliation response is deliberately stale-active. The
        // validated mutation response must still win locally.
        return json({ data: [active], next_cursor: null });
      },
    });
    win = window;
    await flush();

    const refresh = window.document.querySelector('[data-live-refresh]') as HTMLButtonElement;
    refresh.click();
    await flush(1);
    (
      row(window, 'key_active')?.querySelector('[data-action="revoke"]') as HTMLButtonElement
    ).click();
    await flush(4);

    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
    const post = fetchCalls.find((call) => call.init?.method === 'POST')!;
    expect(post.init?.signal).toBeInstanceOf(window.AbortSignal);
    expect(JSON.parse(String(post.init?.body))).toEqual({
      reason: 'customer reported credential leak',
    });
    expect(row(window, 'key_active')?.textContent).toMatch(/revoked/i);
    expect(row(window, 'key_active')?.querySelector('[data-action="revoke"]')).toBeNull();
    expect(refresh.disabled).toBe(true);

    resolveReconciliation?.(json({ data: [active], next_cursor: null }));
    await flush(12);
    expect(refresh.disabled).toBe(false);
    expect(window.document.querySelector('[data-live-status]')?.textContent).toBe('Live · updated');

    resolveStaleRefresh?.(json({ data: [active], next_cursor: 'cur_stale' }));
    await flush();
    expect(row(window, 'key_active')?.textContent).toMatch(/revoked/i);
    expect(row(window, 'key_active')?.querySelector('[data-action="revoke"]')).toBeNull();
    expect(refresh.disabled).toBe(false);
    expect(window.document.querySelector('[data-live-status]')?.textContent).toBe('Live · updated');
  });

  it.each([
    ['mismatched id', { id: keyId('key_other'), revoked_at: REVOKED_AT }],
    ['invalid timestamp', { id: keyId('key_active'), revoked_at: 'not-an-iso-timestamp' }],
    ['impossible timestamp', { id: keyId('key_active'), revoked_at: '2026-02-30T12:00:00.000Z' }],
  ])(
    'treats a 200 %s payload as unknown until exact target status is read',
    async (_label, payload) => {
      let getCount = 0;
      const { window } = setUpDom(loadBuiltPage(), {
        route(call) {
          if (call.init?.method === 'POST') return json(payload);
          getCount += 1;
          return json({ data: [mkKey({ id: 'key_active' })], next_cursor: null });
        },
      });
      win = window;
      await flush();

      (
        row(window, 'key_active')?.querySelector('[data-action="revoke"]') as HTMLButtonElement
      ).click();
      await flush(12);

      const action = row(window, 'key_active')?.querySelector(
        '[data-action="revoke"]',
      ) as HTMLButtonElement;
      expect(getCount).toBe(2);
      expect(action).not.toBeNull();
      expect(action.disabled).toBe(false);
      expect(bannerText(window)).toMatch(
        new RegExp(
          `outcome is unknown.*authoritative key-list read confirms ${keyId('key_active')} is active`,
          'i',
        ),
      );
    },
  );

  it('keeps an ambiguous-failure target disabled until a later exact status row is read', async () => {
    let getCount = 0;
    const { window } = setUpDom(loadBuiltPage(), {
      route(call) {
        if (call.init?.method === 'POST') return json({ detail: 'upstream failed' }, 503);
        getCount += 1;
        if (getCount === 2) return json({ detail: 'list unavailable' }, 503);
        return json({ data: [mkKey({ id: 'key_active' })], next_cursor: null });
      },
    });
    win = window;
    await flush();

    (
      row(window, 'key_active')?.querySelector('[data-action="revoke"]') as HTMLButtonElement
    ).click();
    await flush(12);

    let action = row(window, 'key_active')?.querySelector(
      '[data-action="revoke"]',
    ) as HTMLButtonElement;
    expect(action.disabled).toBe(true);
    expect(action.textContent).toBe('Revocation status pending…');
    expect(bannerText(window)).toMatch(/outcome is unknown.*target remains disabled/i);
    expect(bannerText(window)).not.toMatch(/retry|submit a new revocation/i);

    (window.document.querySelector('[data-live-refresh]') as HTMLButtonElement).click();
    await flush();
    action = row(window, 'key_active')?.querySelector(
      '[data-action="revoke"]',
    ) as HTMLButtonElement;
    expect(action.disabled).toBe(false);
    expect(action.textContent).toBe('Revoke');
    expect(bannerText(window)).toMatch(/authoritative key-list read now confirms.*active/i);
  });

  it('does not infer revocation from absence after a transport failure', async () => {
    let getCount = 0;
    const { window } = setUpDom(loadBuiltPage(), {
      route(call) {
        if (call.init?.method === 'POST') return Promise.reject(new Error('socket closed'));
        getCount += 1;
        return getCount === 1
          ? json({ data: [mkKey({ id: 'key_active' })], next_cursor: null })
          : json({ data: [mkKey({ id: 'key_other' })], next_cursor: null });
      },
    });
    win = window;
    await flush();

    (
      row(window, 'key_active')?.querySelector('[data-action="revoke"]') as HTMLButtonElement
    ).click();
    await flush(12);

    expect(row(window, 'key_active')).toBeNull();
    expect(bannerText(window)).toMatch(
      new RegExp(
        `outcome is unknown.*did not include ${keyId('key_active')}.*does not prove revocation.*status remains unverified.*do not submit another`,
        'i',
      ),
    );
    expect(bannerText(window)).not.toMatch(/retry|submit a new revocation/i);
  });

  it('reconciles an ambiguous expanded target through newly-issued cursors', async () => {
    const oldCursor = 'old/opaque+cursor';
    const newCursor = 'new/opaque+cursor';
    let firstPageLoads = 0;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route(call) {
        if (call.init?.method === 'POST') return Promise.reject(new Error('connection reset'));
        const cursor = cursorOf(call);
        if (cursor === oldCursor) {
          return json({ data: [mkKey({ id: 'key_target' })], next_cursor: null });
        }
        if (cursor === newCursor) {
          return json({
            // Conflicts with the newer first-page target below. Terminal
            // status must remain monotonic across overlapping pages.
            data: [mkKey({ id: 'key_target', revoked_at: null })],
            next_cursor: null,
          });
        }
        firstPageLoads += 1;
        return json({
          data:
            firstPageLoads === 1
              ? [mkKey({ id: 'key_newest' })]
              : [
                  mkKey({ id: 'key_refreshed' }),
                  mkKey({ id: 'key_target', revoked_at: REVOKED_AT }),
                ],
          next_cursor: firstPageLoads === 1 ? oldCursor : newCursor,
        });
      },
    });
    win = window;
    await flush();

    (window.document.querySelector('[data-action="load-more"]') as HTMLButtonElement).click();
    await flush();
    (
      row(window, 'key_target')?.querySelector('[data-action="revoke"]') as HTMLButtonElement
    ).click();
    await flush(16);

    expect(fetchCalls.filter((call) => cursorOf(call) === oldCursor)).toHaveLength(1);
    expect(fetchCalls.filter((call) => cursorOf(call) === newCursor)).toHaveLength(1);
    expect(row(window, 'key_target')?.textContent).toMatch(/revoked/i);
    expect(row(window, 'key_target')?.querySelector('[data-action="revoke"]')).toBeNull();
    expect(bannerText(window)).toMatch(
      /outcome is unknown.*authoritative key-list read confirms.*revoked/i,
    );
    expect(window.document.querySelector('[data-live-status]')?.textContent).toBe(
      'Live refresh paused while viewing older API keys',
    );
  });
});
