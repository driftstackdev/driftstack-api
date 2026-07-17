// Local integration test for the admin /sessions page's inline script,
// focused on the operator FORCE-DESTROY flow (a staff admin kills a
// customer's live session, with an OPTIONAL audited reason). A wiring
// bug here either blocks support/incident response or mis-shapes the
// audit body. Loads the built dist page, mocks localStorage + fetch
// with a stateful URL router, and stubs the branded
// window.driftstackPrompt (injected by AdminLayout). Admin pages are
// static (prerendered), so the built dist HTML is loadable.
//
// Mirrors admin-api-keys-page.test.ts. Key contrast: the reason is
// OPTIONAL here — empty reason still destroys, and the POST body must
// be {} (not {reason:''}).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installAdminDeadline } from './admin-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'sessions', 'index.html');
const PAGE_SOURCE = resolve(HERE, '..', '..', 'src', 'pages', 'sessions.astro');
const PAGE_URL = 'https://admin.driftstack.dev/sessions/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}
interface AdminSession {
  id: string;
  archetype: string;
  account_id: string;
  api_key_id: string;
  status: string;
  purpose: string;
  label: string | null;
  metadata: Record<string, unknown> | null;
  egress_capabilities: {
    udp_associate: boolean;
    quic_route: string;
    dns_remote_resolve: boolean;
    warnings: string[];
  } | null;
  egress_capability_report: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  last_state_at: string | null;
  destroyed_at: string | null;
}
interface SetUpOpts {
  token?: string | null;
  storageDenied?: boolean;
  promptReturns?: string | null | Promise<string | null>;
  confirmReturns?: boolean | Promise<boolean>;
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
  const pr = opts.promptReturns === undefined ? 'support ticket #42' : opts.promptReturns;
  // @ts-expect-error — driftstackPrompt is injected by AdminLayout
  window.driftstackPrompt = () => Promise.resolve(pr);
  const cr = opts.confirmReturns === undefined ? true : opts.confirmReturns;
  // @ts-expect-error — driftstackConfirm is injected by AdminLayout; force-destroy is gated behind it
  window.driftstackConfirm = () => Promise.resolve(cr);
  installAdminDeadline(window);

  const pageScript =
    opts.pageScript ?? scriptBodies.find((s) => s.includes('data-page="admin-sessions"'));
  if (!pageScript) throw new Error('admin sessions inline script not found');
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
    /<script is:inline define:vars=\{\{ apiBaseUrl, archetypeLabels: ARCHETYPE_LABELS \}\}>([\s\S]*?)<\/script>/,
  );
  if (!match?.[1]) throw new Error('admin sessions source inline script not found');
  const archetypeLabels = {
    iphone16pro_ios18_7_safari26_4: 'iPhone 16 Pro / iOS 18.7 / Safari 26.4',
  };
  return (
    `const apiBaseUrl = "https://api.driftstack.dev";\n` +
    `const archetypeLabels = ${JSON.stringify(archetypeLabels)};\n` +
    match[1]
  );
}
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

async function settlePromises(times = 16): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function mkSession(over: Partial<AdminSession> = {}): AdminSession {
  return {
    id: 'ses_default',
    archetype: 'iphone16pro_ios18_7_safari26_4',
    account_id: 'acc_1',
    api_key_id: 'key_1',
    status: 'ready',
    purpose: 'production_customer',
    label: null,
    metadata: null,
    egress_capabilities: null,
    egress_capability_report: null,
    created_at: '2026-05-01T10:00:00.000Z',
    updated_at: '2026-05-01T10:01:00.000Z',
    last_state_at: null,
    destroyed_at: null,
    ...over,
  };
}

function makeRouter(sessions: AdminSession[]): (c: MockFetchCall) => Response {
  return (call: MockFetchCall): Response => {
    const method = (call.init?.method || 'GET').toUpperCase();
    const u = call.url.replace(/^https?:\/\/[^/]+/, '');
    const destroy = u.match(/\/v1\/admin\/sessions\/([^/?]+)\/destroy$/);
    if (destroy && method === 'POST') {
      const s = sessions.find((x) => x.id === destroy[1]);
      if (s) s.status = 'destroyed';
      return json({ ok: true });
    }
    if (/\/v1\/admin\/sessions(\?|$)/.test(u) && method === 'GET') {
      return json({ data: sessions, next_cursor: null });
    }
    return json({}, 404);
  };
}

function bannerText(window: JSDOM['window']): string {
  return window.document.querySelector('[data-banner]')?.textContent ?? '';
}

function row(window: JSDOM['window'], id: string): HTMLTableRowElement | null {
  return window.document.querySelector(`[data-session-id="${id}"]`);
}

function cursorOf(call: MockFetchCall): string | null {
  return new URL(call.url, PAGE_URL).searchParams.get('cursor');
}

function isGet(call: MockFetchCall): boolean {
  return (call.init?.method || 'GET').toUpperCase() === 'GET';
}

describe('admin sessions page — force-destroy (operator)', () => {
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
    expect(window.document.querySelector('[data-banner]')?.textContent).toContain(
      'Sign in with a staff admin account',
    );
    expect(window.document.querySelector('[data-list="sessions"]')?.textContent).toContain(
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
    ['missing id', { data: [{ ...mkSession(), id: undefined }], next_cursor: null }],
    [
      'missing API-key id',
      { data: [{ ...mkSession(), api_key_id: undefined }], next_cursor: null },
    ],
    ['invalid status', { data: [mkSession({ status: 'running' })], next_cursor: null }],
    ['invalid purpose', { data: [mkSession({ purpose: 'customerish' })], next_cursor: null }],
    ['invalid label type', { data: [{ ...mkSession(), label: 7 }], next_cursor: null }],
    ['array metadata', { data: [{ ...mkSession(), metadata: [] }], next_cursor: null }],
    [
      'invalid egress warning member',
      {
        data: [
          mkSession({
            egress_capabilities: {
              udp_associate: true,
              quic_route: 'proxy',
              dns_remote_resolve: true,
              warnings: ['ok', 7] as unknown as string[],
            },
          }),
        ],
        next_cursor: null,
      },
    ],
    [
      'array egress report',
      { data: [{ ...mkSession(), egress_capability_report: [] }], next_cursor: null },
    ],
    [
      'impossible created timestamp',
      { data: [mkSession({ created_at: '2026-02-31T00:00:00.000Z' })], next_cursor: null },
    ],
    [
      'missing updated timestamp',
      { data: [{ ...mkSession(), updated_at: undefined }], next_cursor: null },
    ],
    [
      'invalid last-state timestamp',
      { data: [mkSession({ last_state_at: 'not-iso' })], next_cursor: null },
    ],
    [
      'invalid destroyed timestamp type',
      { data: [{ ...mkSession(), destroyed_at: false }], next_cursor: null },
    ],
  ])('malformed newest response (%s) renders unavailable, never empty', async (_label, body) => {
    const { window } = setUpDom(loadBuiltPage(), {
      pageScript: currentInlinePageScript(),
      route: () => json(body),
    });
    win = window;
    await flush();

    const listText = window.document.querySelector('[data-list="sessions"]')?.textContent ?? '';
    expect(listText).toContain('Could not load live sessions');
    expect(listText).not.toContain('No sessions match the current filter');
    expect(window.document.querySelector('[data-session-id]')).toBeNull();
    expect(
      window.document.querySelector('[data-action="load-more"]')?.classList.contains('hidden'),
    ).toBe(true);
  });

  it('rejects a malformed append atomically and retries the exact cursor', async () => {
    const cursor = 'opaque/session-retry+==';
    let appendAttempts = 0;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      pageScript: currentInlinePageScript(),
      route(call) {
        if (cursorOf(call) !== cursor) {
          return json({ data: [mkSession({ id: 'ses_newest' })], next_cursor: cursor });
        }
        appendAttempts += 1;
        if (appendAttempts === 1) {
          return json({
            data: [
              mkSession({ id: 'ses_must_not_commit' }),
              mkSession({ id: 'ses_bad', status: 'running' }),
            ],
            next_cursor: null,
          });
        }
        return json({ data: [mkSession({ id: 'ses_older' })], next_cursor: null });
      },
    });
    win = window;
    await flush();

    const loadMore = window.document.querySelector(
      '[data-action="load-more"]',
    ) as HTMLButtonElement;
    loadMore.click();
    await flush();

    expect(row(window, 'ses_newest')).not.toBeNull();
    expect(row(window, 'ses_must_not_commit')).toBeNull();
    expect(row(window, 'ses_bad')).toBeNull();
    expect(loadMore.classList.contains('hidden')).toBe(false);
    expect(loadMore.disabled).toBe(false);
    expect(bannerText(window)).toContain('Existing rows and cursor are unchanged');

    loadMore.click();
    await flush();

    expect(fetchCalls.filter((call) => cursorOf(call) === cursor)).toHaveLength(2);
    expect(row(window, 'ses_newest')).not.toBeNull();
    expect(row(window, 'ses_older')).not.toBeNull();
    expect(row(window, 'ses_must_not_commit')).toBeNull();
    expect(loadMore.classList.contains('hidden')).toBe(true);
  });

  it('renders sessions: a ready session gets Force-destroy; a destroyed one does not', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: makeRouter([
        mkSession({ id: 'agt_live', status: 'ready' }),
        mkSession({ id: 'agt_done', status: 'destroyed' }),
      ]),
    });
    win = window;
    await flush();
    expect(
      window.document.querySelector('[data-action="destroy"][data-id="agt_live"]'),
    ).toBeTruthy();
    expect(window.document.querySelector('[data-action="destroy"][data-id="agt_done"]')).toBeNull();
    // Archetype renders as the friendly registry label, never the raw slug
    // (consistent with the customer profiles/overview/sessions pages).
    const pageText = window.document.body.textContent ?? '';
    expect(pageText).toContain('iPhone 16 Pro / iOS 18.7 / Safari 26.4');
    expect(pageText).not.toContain('iphone16pro_ios18_7_safari26_4');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.init?.signal).toBeInstanceOf(window.AbortSignal);
  });

  it('filters reset the loaded window to a cursorless authenticated first page', async () => {
    let firstPageLoads = 0;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route(call) {
        if (cursorOf(call) !== null) {
          return json({ data: [mkSession({ id: 'ses_older' })], next_cursor: null });
        }
        firstPageLoads += 1;
        return firstPageLoads === 1
          ? json({ data: [mkSession({ id: 'ses_newest' })], next_cursor: 'opaque/older+==' })
          : json({ data: [mkSession({ id: 'ses_filtered' })], next_cursor: null });
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
    expect(row(window, 'ses_older')).not.toBeNull();

    const status = window.document.querySelector('[data-field="status"]') as HTMLSelectElement;
    const account = window.document.querySelector('[data-field="account-id"]') as HTMLInputElement;
    status.value = 'busy';
    account.value = 'acc_filter';
    status.dispatchEvent(new window.Event('change', { bubbles: true }));
    account.dispatchEvent(new window.Event('input', { bubbles: true }));
    const loadMore = window.document.querySelector(
      '[data-action="load-more"]',
    ) as HTMLButtonElement;
    expect(loadMore.disabled).toBe(true);
    loadMore.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flush(1);
    expect(fetchCalls.filter((call) => cursorOf(call) !== null)).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 230));
    await flush();

    const filteredCall = fetchCalls.filter(isGet).at(-1)!;
    const filteredUrl = new URL(filteredCall.url, PAGE_URL);
    expect(filteredUrl.searchParams.get('status')).toBe('busy');
    expect(filteredUrl.searchParams.get('account_id')).toBe('acc_filter');
    expect(filteredUrl.searchParams.get('cursor')).toBeNull();
    expect(row(window, 'ses_filtered')).not.toBeNull();
    expect(row(window, 'ses_newest')).toBeNull();
    expect(row(window, 'ses_older')).toBeNull();
    expect(window.document.querySelector('[data-field="footnote"]')?.textContent).toMatch(
      /1 session in the loaded window/i,
    );
  });

  it('single-flights opaque cursors, dedupes ids, and refuses a multi-page cursor cycle', async () => {
    const cursorA = 'opaque/a+==';
    const cursorB = 'opaque/b/==';
    let resolvePageA: ((response: Response) => void) | undefined;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route(call) {
        if (cursorOf(call) === cursorA) {
          return new Promise<Response>((resolve) => {
            resolvePageA = resolve;
          });
        }
        if (cursorOf(call) === cursorB) {
          return json({ data: [mkSession({ id: 'ses_page_b' })], next_cursor: cursorA });
        }
        return json({ data: [mkSession({ id: 'ses_first' })], next_cursor: cursorA });
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
    expect(fetchCalls.filter((call) => cursorOf(call) === cursorA)).toHaveLength(1);
    expect(loadMore.disabled).toBe(true);
    expect(loadMore.textContent).toBe('Loading…');
    expect(loadMore.getAttribute('aria-busy')).toBe('true');

    resolvePageA?.(
      json({
        data: [mkSession({ id: 'ses_first', status: 'busy' }), mkSession({ id: 'ses_page_a' })],
        next_cursor: cursorB,
      }),
    );
    await flush();
    expect(window.document.querySelectorAll('[data-session-id]')).toHaveLength(2);
    expect(row(window, 'ses_first')?.textContent).toMatch(/busy/i);

    loadMore.click();
    await flush();
    expect(row(window, 'ses_page_b')).not.toBeNull();
    expect(loadMore.classList.contains('hidden')).toBe(true);
    expect(bannerText(window)).toMatch(/server repeated a cursor.*unique sessions/i);
    loadMore.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flush(1);
    expect(fetchCalls.filter((call) => cursorOf(call) === cursorA)).toHaveLength(1);
    expect(fetchCalls.filter((call) => cursorOf(call) === cursorB)).toHaveLength(1);
  });

  it('preserves the loaded window after append failure and retries the same cursor', async () => {
    const cursor = 'cur_retry';
    let attempts = 0;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route(call) {
        if (cursorOf(call) === cursor) {
          attempts += 1;
          return attempts === 1
            ? json({ detail: 'temporary' }, 503)
            : json({ data: [mkSession({ id: 'ses_2' })], next_cursor: null });
        }
        return json({ data: [mkSession({ id: 'ses_1' })], next_cursor: cursor });
      },
    });
    win = window;
    await flush();

    const loadMore = window.document.querySelector(
      '[data-action="load-more"]',
    ) as HTMLButtonElement;
    loadMore.click();
    await flush();
    expect(row(window, 'ses_1')).not.toBeNull();
    expect(row(window, 'ses_2')).toBeNull();
    expect(bannerText(window)).toMatch(/older sessions.*rows and cursor are unchanged/i);
    expect(loadMore.disabled).toBe(false);

    loadMore.click();
    await flush();
    expect(fetchCalls.filter((call) => cursorOf(call) === cursor)).toHaveLength(2);
    expect(row(window, 'ses_1')).not.toBeNull();
    expect(row(window, 'ses_2')).not.toBeNull();
  });

  it('makes a held append stale when Refresh takes a new list epoch', async () => {
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
          ? json({ data: [mkSession({ id: 'ses_old' })], next_cursor: cursor })
          : json({ data: [mkSession({ id: 'ses_fresh' })], next_cursor: null });
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
    resolveOlder?.(json({ data: [mkSession({ id: 'ses_stale' })], next_cursor: null }));
    await flush();

    expect(row(window, 'ses_fresh')).not.toBeNull();
    expect(row(window, 'ses_old')).toBeNull();
    expect(row(window, 'ses_stale')).toBeNull();
    expect(window.document.querySelector('[data-live-status]')?.textContent).toBe('Live · updated');
  });

  it('pauses polling while expanded and Back to newest replaces the loaded window', async () => {
    vi.useFakeTimers();
    const cursor = 'cur_older';
    let firstPageLoads = 0;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route(call) {
        if (cursorOf(call) === cursor) {
          return json({ data: [mkSession({ id: 'ses_older' })], next_cursor: null });
        }
        firstPageLoads += 1;
        return firstPageLoads === 1
          ? json({ data: [mkSession({ id: 'ses_newest' })], next_cursor: cursor })
          : json({ data: [mkSession({ id: 'ses_refreshed' })], next_cursor: null });
      },
    });
    win = window;
    await vi.advanceTimersByTimeAsync(0);
    await settlePromises();

    (window.document.querySelector('[data-action="load-more"]') as HTMLButtonElement).click();
    await settlePromises();
    expect(row(window, 'ses_older')).not.toBeNull();
    const countWhileExpanded = fetchCalls.length;

    await vi.advanceTimersByTimeAsync(30_000);
    await settlePromises();
    expect(fetchCalls).toHaveLength(countWhileExpanded);
    expect(window.document.querySelector('[data-live-status]')?.textContent).toBe(
      'Live refresh paused while viewing older sessions',
    );

    (window.document.querySelector('[data-action="back-to-newest"]') as HTMLButtonElement).click();
    await settlePromises();
    expect(fetchCalls).toHaveLength(countWhileExpanded + 1);
    expect(cursorOf(fetchCalls.at(-1)!)).toBeNull();
    expect(row(window, 'ses_refreshed')).not.toBeNull();
    expect(row(window, 'ses_newest')).toBeNull();
    expect(row(window, 'ses_older')).toBeNull();
  });

  it('W604: a failed live-load CLEARS the SSG mock rows (no fake force-destroy buttons) + shows an honest error', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      route: () => json({ detail: 'boom' }, 500),
    });
    win = window;
    await flush();
    // No destroy buttons survive — the mock rows (with fake ids) are gone, so
    // an admin can't fire force-destroy on a session that doesn't exist.
    expect(window.document.querySelectorAll('[data-action="destroy"]').length).toBe(0);
    const text = window.document.body.textContent ?? '';
    expect(text).toContain('Could not load live sessions');
    expect(text).toContain("Couldn't load live sessions");
    // The old misleading "Showing preview data below" wording is gone.
    expect(text).not.toContain('Showing preview data below');
  });

  it('destroy WITH reason: POSTs /:id/destroy {reason}, then refresh removes the action', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      promptReturns: 'abuse — ToS violation',
      route: makeRouter([mkSession({ id: 'agt_live', status: 'ready' })]),
    });
    win = window;
    await flush();
    const button = window.document.querySelector(
      '[data-action="destroy"][data-id="agt_live"]',
    ) as HTMLButtonElement;
    button.click();
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    await flush();
    const posts = fetchCalls.filter(
      (c) => c.init?.method === 'POST' && /\/v1\/admin\/sessions\/agt_live\/destroy$/.test(c.url),
    );
    const post = posts[0];
    expect(post).toBeTruthy();
    expect(posts).toHaveLength(1);
    expect(post?.init?.signal).toBeInstanceOf(window.AbortSignal);
    expect(JSON.parse(String(post?.init?.body))).toEqual({ reason: 'abuse — ToS violation' });
    expect(window.document.querySelector('[data-action="destroy"][data-id="agt_live"]')).toBeNull();
  });

  it('commits an accepted 2xx before body parsing and never offers a replay', async () => {
    const sessions = [
      mkSession({ id: 'agt_live', status: 'ready' }),
      mkSession({ id: 'agt_other', status: 'ready' }),
    ];
    const fallback = makeRouter(sessions);
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (
          call.init?.method === 'POST' &&
          /\/v1\/admin\/sessions\/agt_live\/destroy$/.test(call.url)
        ) {
          sessions[0]!.status = 'destroyed';
          return new Response('{', {
            status: 202,
            headers: { 'content-type': 'application/json' },
          });
        }
        return fallback(call);
      },
    });
    win = window;
    await flush();

    (
      window.document.querySelector(
        '[data-action="destroy"][data-id="agt_live"]',
      ) as HTMLButtonElement
    ).click();
    await flush();

    expect(
      fetchCalls.filter(
        (call) =>
          call.init?.method === 'POST' &&
          /\/v1\/admin\/sessions\/agt_live\/destroy$/.test(call.url),
      ),
    ).toHaveLength(1);
    expect(window.document.querySelector('[data-action="destroy"][data-id="agt_live"]')).toBeNull();
    expect(
      window.document.querySelector('[data-action="destroy"][data-id="agt_other"]'),
    ).toBeTruthy();
    expect(window.document.querySelector('[data-banner]')?.textContent).not.toMatch(
      /couldn't destroy|force-destroy failed/i,
    );
  });

  it('destroy WITHOUT reason (optional): still destroys, POST body is {} (not {reason:""})', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      promptReturns: '',
      route: makeRouter([mkSession({ id: 'agt_live', status: 'ready' })]),
    });
    win = window;
    await flush();
    (
      window.document.querySelector(
        '[data-action="destroy"][data-id="agt_live"]',
      ) as HTMLButtonElement
    ).click();
    await flush();
    const post = fetchCalls.find(
      (c) => c.init?.method === 'POST' && /\/v1\/admin\/sessions\/agt_live\/destroy$/.test(c.url),
    );
    expect(post).toBeTruthy();
    expect(JSON.parse(String(post?.init?.body))).toEqual({});
  });

  it('cancelled force-destroy restores the control and fires no POST', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      confirmReturns: false,
      route: makeRouter([mkSession({ id: 'agt_live', status: 'ready' })]),
    });
    win = window;
    await flush();
    const button = window.document.querySelector(
      '[data-action="destroy"][data-id="agt_live"]',
    ) as HTMLButtonElement;
    button.click();
    await flush();
    expect(fetchCalls.some((call) => call.init?.method === 'POST')).toBe(false);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Force destroy');
    expect(button.hasAttribute('aria-busy')).toBe(false);
  });

  it('takes one synchronous destroy owner and disables paging, filters, refresh, and other destroys', async () => {
    const sessions = [
      mkSession({ id: 'agt_live', account_id: 'acc_captured', status: 'ready' }),
      mkSession({ id: 'agt_other', account_id: 'acc_other', status: 'ready' }),
    ];
    let finishConfirm: ((confirmed: boolean) => void) | undefined;
    let finishPost: ((response: Response) => void) | undefined;
    const pendingConfirm = new Promise<boolean>((resolve) => {
      finishConfirm = resolve;
    });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      confirmReturns: pendingConfirm,
      route(call) {
        if (call.init?.method === 'POST') {
          return new Promise<Response>((resolve) => {
            finishPost = resolve;
          });
        }
        return json({ data: sessions, next_cursor: 'cur_more' });
      },
    });
    win = window;
    await flush();

    const target = window.document.querySelector(
      '[data-action="destroy"][data-id="agt_live"]',
    ) as HTMLButtonElement;
    target.click();

    expect(target.disabled).toBe(true);
    expect(target.getAttribute('aria-busy')).toBe('true');
    expect(
      (window.document.querySelector('[data-field="status"]') as HTMLSelectElement).disabled,
    ).toBe(true);
    expect(
      (window.document.querySelector('[data-field="account-id"]') as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (window.document.querySelector('[data-live-refresh]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (window.document.querySelector('[data-action="load-more"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (
        window.document.querySelector(
          '[data-action="destroy"][data-id="agt_other"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    finishConfirm?.(true);
    await flush(2);
    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
    expect(
      (window.document.querySelector('[data-field="status"]') as HTMLSelectElement).disabled,
    ).toBe(true);

    sessions[0]!.status = 'destroyed';
    finishPost?.(json({ ok: true }));
    await flush(12);
    expect(window.document.querySelector('[data-action="destroy"][data-id="agt_live"]')).toBeNull();
    expect(
      (window.document.querySelector('[data-field="status"]') as HTMLSelectElement).disabled,
    ).toBe(false);
  });

  it('treats a malformed exact destroy-verification page as a failed read and keeps the lease', async () => {
    const target = mkSession({ id: 'agt_live', account_id: 'acc_captured', status: 'busy' });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      pageScript: currentInlinePageScript(),
      route(call) {
        if (call.init?.method === 'POST') return json({ detail: 'maybe committed' }, 503);
        const url = new URL(call.url, PAGE_URL);
        if (url.searchParams.get('account_id') !== 'acc_captured') {
          return json({ data: [target], next_cursor: null });
        }
        if (cursorOf(call) === 'verify_exact') {
          return json({
            data: [{ ...target, status: 'destroyed' }],
            next_cursor: '',
          });
        }
        return json({ data: [mkSession({ id: 'agt_other' })], next_cursor: 'verify_exact' });
      },
    });
    win = window;
    await flush();

    (
      window.document.querySelector(
        '[data-action="destroy"][data-id="agt_live"]',
      ) as HTMLButtonElement
    ).click();
    await flush(15);

    const verificationReads = fetchCalls.filter(
      (call) =>
        isGet(call) &&
        new URL(call.url, PAGE_URL).searchParams.get('account_id') === 'acc_captured',
    );
    expect(verificationReads).toHaveLength(2);
    expect(cursorOf(verificationReads[0]!)).toBeNull();
    expect(cursorOf(verificationReads[1]!)).toBe('verify_exact');
    const leased = window.document.querySelector(
      '[data-action="destroy"][data-id="agt_live"]',
    ) as HTMLButtonElement;
    expect(leased.disabled).toBe(true);
    expect(leased.textContent).toBe('Destroy status pending…');
    expect(bannerText(window)).toMatch(
      /verification walk could not complete \(invalid verification response\).*remains disabled and unverified/i,
    );
    leased.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flush(2);
    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
  });

  it('walks fresh opaque cursors with the captured account and accepts only the exact destroyed row', async () => {
    const target = mkSession({ id: 'agt_live', account_id: 'acc_captured', status: 'busy' });
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        const method = (call.init?.method || 'GET').toUpperCase();
        if (method === 'POST' && /\/v1\/admin\/sessions\/agt_live\/destroy$/.test(call.url)) {
          return Promise.reject(timeout);
        }
        const url = new URL(call.url, PAGE_URL);
        if (url.searchParams.get('account_id') === 'acc_captured') {
          return cursorOf(call) === 'verify_older'
            ? json({ data: [{ ...target, status: 'destroyed' }], next_cursor: null })
            : json({ data: [mkSession({ id: 'agt_other' })], next_cursor: 'verify_older' });
        }
        return json({ data: [target], next_cursor: null });
      },
    });
    win = window;
    await flush();

    const button = window.document.querySelector(
      '[data-action="destroy"][data-id="agt_live"]',
    ) as HTMLButtonElement;
    button.click();
    await flush(15);

    expect(
      fetchCalls.filter(
        (call) =>
          call.init?.method === 'POST' &&
          /\/v1\/admin\/sessions\/agt_live\/destroy$/.test(call.url),
      ),
    ).toHaveLength(1);
    const verificationReads = fetchCalls.filter(
      (call) =>
        isGet(call) &&
        new URL(call.url, PAGE_URL).searchParams.get('account_id') === 'acc_captured',
    );
    expect(verificationReads).toHaveLength(2);
    expect(cursorOf(verificationReads[0]!)).toBeNull();
    expect(cursorOf(verificationReads[1]!)).toBe('verify_older');
    for (const read of verificationReads) {
      const url = new URL(read.url, PAGE_URL);
      expect(url.searchParams.get('status')).toBeNull();
      expect(url.searchParams.get('limit')).toBe('50');
    }
    expect(window.document.querySelector('[data-action="destroy"][data-id="agt_live"]')).toBeNull();
    expect(bannerText(window)).toMatch(
      /outcome is unknown.*exact account-scoped unfiltered row confirms agt_live is destroyed.*do not submit another/i,
    );
  });

  it.each(['ready', 'errored'])(
    'keeps an exact %s row unverified and nonreplayable after a 5xx',
    async (reportedStatus) => {
      const target = mkSession({
        id: 'agt_live',
        account_id: 'acc_captured',
        status: 'busy',
      });
      const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
        route(call) {
          if (call.init?.method === 'POST') return json({ detail: 'maybe committed' }, 503);
          const url = new URL(call.url, PAGE_URL);
          return url.searchParams.get('account_id') === 'acc_captured'
            ? json({ data: [{ ...target, status: reportedStatus }], next_cursor: null })
            : json({ data: [target], next_cursor: null });
        },
      });
      win = window;
      await flush();

      const button = window.document.querySelector(
        '[data-action="destroy"][data-id="agt_live"]',
      ) as HTMLButtonElement;
      button.click();
      await flush(15);

      const leased = window.document.querySelector(
        '[data-action="destroy"][data-id="agt_live"]',
      ) as HTMLButtonElement;
      expect(leased.disabled).toBe(true);
      expect(leased.textContent).toBe('Destroy status pending…');
      expect(leased.title).toMatch(/outcome is unverified/i);
      expect(bannerText(window)).toMatch(
        new RegExp(
          `outcome is unknown \\(HTTP 503\\).*exact account-scoped unfiltered row.*${reportedStatus}.*Only status destroyed proves completion.*does not permit replay.*remains disabled and unverified`,
          'i',
        ),
      );
      leased.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await flush(2);
      expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
    },
  );

  it.each([
    ['exhaustive absence', 'exhaustive'],
    ['cursor cycle', 'cycle'],
    ['defensive page cap', 'cap'],
  ])('keeps the target nonreplayable when verification ends in %s', async (_label, mode) => {
    const target = mkSession({ id: 'agt_live', account_id: 'acc_captured', status: 'busy' });
    let verificationPages = 0;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route(call) {
        if (call.init?.method === 'POST') return json({ detail: 'maybe committed' }, 500);
        const url = new URL(call.url, PAGE_URL);
        if (url.searchParams.get('account_id') !== 'acc_captured') {
          return json({ data: [target], next_cursor: null });
        }
        verificationPages += 1;
        if (mode === 'exhaustive') {
          return json({ data: [mkSession({ id: 'agt_other' })], next_cursor: null });
        }
        if (mode === 'cycle') {
          return json({ data: [], next_cursor: 'verify_cycle' });
        }
        return json({ data: [], next_cursor: 'verify_page_' + verificationPages });
      },
    });
    win = window;
    await flush();

    (
      window.document.querySelector(
        '[data-action="destroy"][data-id="agt_live"]',
      ) as HTMLButtonElement
    ).click();
    await flush(50);

    const leased = window.document.querySelector(
      '[data-action="destroy"][data-id="agt_live"]',
    ) as HTMLButtonElement;
    expect(leased.disabled).toBe(true);
    expect(leased.textContent).toBe('Destroy status pending…');
    expect(bannerText(window)).toMatch(
      new RegExp(
        mode === 'exhaustive'
          ? 'exhaustive absence.*Absence does not prove completion'
          : mode === 'cycle'
            ? 'cursor cycle.*Absence does not prove completion'
            : 'defensive page cap.*Absence does not prove completion',
        'i',
      ),
    );
    expect(verificationPages).toBe(mode === 'cap' ? 20 : mode === 'cycle' ? 2 : 1);
    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
  });
});
