// Behavioural coverage for the admin Accounts page —
// apps/admin-panel/src/pages/accounts.astro. This is the operator's primary
// customer-management surface (list + filter + drill-in) and had only source-
// parity tests. Loads the built dist page, runs the inline script in jsdom
// against a mock fetch, and asserts the rendered outcome: auth-gate, the
// /v1/admin/accounts row rendering (incl. the acc_-stripped "Open" link), the
// empty + has-more footnote, the 403 admin-scope message, and that a search
// filter refetches with email_contains.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installAdminDeadline } from './admin-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'accounts', 'index.html');
const PAGE_URL = 'https://admin.driftstack.dev/accounts/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface SetUpOpts {
  token?: string;
  storageDenied?: boolean;
  captureIntervals?: boolean;
  route: (call: MockFetchCall) => Response | Promise<Response>;
}

function setUpDom(
  html: string,
  opts: SetUpOpts,
): {
  window: JSDOM['window'];
  fetchCalls: MockFetchCall[];
  hydratedCount: () => number;
  runInterval: (delay: number) => void;
} {
  const scriptBodies: string[] = [];
  const htmlNoScripts = html.replace(/<script[^>]*>([\s\S]*?)<\/script>/g, (_m, body: string) => {
    scriptBodies.push(body);
    return '';
  });
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(htmlNoScripts, {
    url: PAGE_URL,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  const fetchCalls: MockFetchCall[] = [];
  const intervals: Array<{ callback: () => void; delay: number }> = [];
  if (opts.captureIntervals) {
    window.setInterval = ((handler: TimerHandler, delay?: number) => {
      intervals.push({
        callback: () => {
          if (typeof handler === 'function') handler();
          else window.eval(handler);
        },
        delay: Number(delay ?? 0),
      });
      return intervals.length;
    }) as typeof window.setInterval;
  }
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
  } else if (opts.token !== undefined) {
    window.localStorage.setItem('ds_web_session_token', opts.token);
  }
  let hydrated = 0;
  // @ts-expect-error — injected by AdminLayout
  window.dashboardHydrated = () => {
    hydrated += 1;
  };
  installAdminDeadline(window);

  const pageScript = scriptBodies.find((s) => s.includes('data-page="admin-accounts"'));
  if (!pageScript) throw new Error('admin-accounts inline script not found');
  // @ts-expect-error — jsdom global has eval
  window.eval(pageScript);
  return {
    window: window as JSDOM['window'],
    fetchCalls,
    hydratedCount: () => hydrated,
    runInterval: (delay: number) => {
      const interval = intervals.find((entry) => entry.delay === delay);
      if (!interval) throw new Error(`interval ${delay}ms was not registered`);
      interval.callback();
    },
  };
}

function text(window: JSDOM['window'], selector: string): string {
  return window.document.querySelector(selector)?.textContent?.trim() ?? '';
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const ACCOUNT = {
  id: 'acc_11111111-1111-4111-8111-111111111111',
  name: 'Acme Corp',
  email: 'ops@acme.example',
  tier: 'api_builder',
  status: 'active',
  created_at: '2026-01-15T00:00:00.000Z',
  updated_at: '2026-05-01T00:00:00.000Z',
};

const ACCOUNT_2 = {
  ...ACCOUNT,
  id: 'acc_22222222-2222-4222-8222-222222222222',
  email: 'second@acme.example',
  name: 'Second Co',
};

const ACCOUNT_3 = {
  ...ACCOUNT,
  id: 'acc_33333333-3333-4333-8333-333333333333',
  email: 'third@acme.example',
  name: 'Third Co',
};

const terminalPage = (data: unknown[]) => ({ data, has_more: false, next_cursor: null });
const continuedPage = (data: unknown[], nextCursor: string) => ({
  data,
  has_more: true,
  next_cursor: nextCursor,
});

let win: JSDOM['window'] | undefined;
afterEach(() => {
  win?.close?.();
  win = undefined;
});

describe('admin-panel Accounts (accounts.astro) behaviour', () => {
  it.each([
    ['signed out', {}],
    ['storage denied', { storageDenied: true }],
  ])('%s: renders an inert staff sign-in shell without network', async (_label, auth) => {
    const { window, fetchCalls, hydratedCount } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      ...auth,
      route: () => {
        throw new Error('must not fetch when unauthenticated');
      },
    });
    win = window;
    await flush();
    expect(fetchCalls.length).toBe(0);
    expect(hydratedCount()).toBe(1);
    expect(text(window, '[data-banner]')).toContain('Sign in with a staff admin account');
    expect(text(window, '[data-list="accounts"]')).toContain('Sign in with a staff admin account');
    expect(
      (window.document.querySelector('[data-live-refresh]') as HTMLButtonElement).disabled,
    ).toBe(true);
    const loadMore = window.document.querySelector(
      '[data-action="load-more"]',
    ) as HTMLButtonElement;
    expect(loadMore.disabled).toBe(true);
    expect(loadMore.classList.contains('hidden')).toBe(true);
  });

  it('renders an account row with identity, tier, status, dates, and an acc_-stripped Open link', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json(terminalPage([ACCOUNT])),
    });
    win = window;
    await flush();
    const list = text(window, '[data-list="accounts"]');
    expect(list).toContain('Acme Corp');
    expect(list).toContain('ops@acme.example');
    expect(list).toContain(ACCOUNT.id);
    expect(list).toContain('api_builder');
    expect(list).toContain('active');
    expect(list).toContain('2026-01-15'); // created_at via fmtIso
    // The Open link strips the acc_ prefix from the id segment.
    const rawId = ACCOUNT.id.replace(/^acc_/, '');
    expect(window.document.querySelector(`a[href="/accounts/${rawId}"]`)).toBeTruthy();
    expect(window.document.querySelector(`a[href="/accounts/${ACCOUNT.id}"]`)).toBeFalsy();
    expect(text(window, '[data-field="footnote"]')).toContain('Showing 1 account');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.init?.signal).toBeInstanceOf(window.AbortSignal);
  });

  it('empty result: shows the no-match row and a zero-count footnote', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json(terminalPage([])),
    });
    win = window;
    await flush();
    expect(text(window, '[data-list="accounts"]')).toContain(
      'No accounts match the current filter',
    );
    expect(text(window, '[data-field="footnote"]')).toContain('Showing 0 accounts');
  });

  it('has_more + next_cursor: the footnote notes more results are available', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json(continuedPage([ACCOUNT], ACCOUNT.id)),
    });
    win = window;
    await flush();
    expect(text(window, '[data-field="footnote"]')).toContain('more available');
  });

  it('403: surfaces the admin-scope-required message (not a raw HTTP 403)', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json({ detail: 'forbidden' }, 403),
    });
    win = window;
    await flush();
    expect(text(window, '[data-banner]')).toContain('admin scope required');
  });

  it('CRITICAL SSO-bridge race: a token written to localStorage AFTER this page\'s own script has already run (simulating AdminLayout\'s trailing hash-bridge <script>, which sits later in document order) is still picked up — no false "sign in" banner + stale mock data on a fresh sign-in (audit waefer6wu)', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      // Deliberately omit `token` here — at the moment this page's script
      // runs (synchronously, during the eval below), localStorage has NO
      // token yet, exactly like a fresh SSO sign-in where AdminLayout's
      // bridge script hasn't executed its write yet.
      route: () => json(terminalPage([ACCOUNT])),
    });
    win = window;
    // Simulate AdminLayout's later <script> (the SSO hash bridge) writing
    // the token a tick after this page's own script executed.
    window.localStorage.setItem('ds_web_session_token', 'tok');
    await flush();
    expect(fetchCalls.length).toBeGreaterThan(0);
    expect(text(window, '[data-banner]')).not.toContain('Sign in with a staff admin account');
    expect(text(window, '[data-list="accounts"]')).toContain('Acme Corp');
  });

  it('CRITICAL pagination: has_more + next_cursor reveals "Load more"; clicking it fetches the next cursor page and APPENDS rows instead of leaving them permanently unreachable (audit waefer6wu)', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: (call) => {
        if (new URL(call.url).searchParams.get('cursor') === ACCOUNT.id) {
          return json(terminalPage([ACCOUNT_2]));
        }
        return json(continuedPage([ACCOUNT], ACCOUNT.id));
      },
    });
    win = window;
    await flush();
    const loadMoreBtn = window.document.querySelector(
      '[data-action="load-more"]',
    ) as HTMLButtonElement;
    expect(loadMoreBtn.classList.contains('hidden')).toBe(false);
    expect(text(window, '[data-field="footnote"]')).toContain('more available');

    loadMoreBtn.click();
    loadMoreBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flush();

    const cursorCalls = fetchCalls.filter(
      (call) => new URL(call.url).searchParams.get('cursor') === ACCOUNT.id,
    );
    const cursorCall = cursorCalls[0];
    expect(cursorCall).toBeTruthy();
    expect(cursorCalls).toHaveLength(1);
    expect(cursorCall?.init?.signal).toBeInstanceOf(window.AbortSignal);
    const list = text(window, '[data-list="accounts"]');
    // Both pages' rows are present — the second page was appended, not
    // swapped in, so the first page's row stays visible.
    expect(list).toContain('Acme Corp');
    expect(list).toContain('Second Co');
    // has_more is now false, so the button hides again.
    expect(loadMoreBtn.classList.contains('hidden')).toBe(true);
    expect(text(window, '[data-field="footnote"]')).toContain('Showing 2 accounts');
    expect(loadMoreBtn.getAttribute('aria-busy')).toBe('false');
  });

  it('pagination: has_more=false keeps "Load more" hidden', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json(terminalPage([ACCOUNT])),
    });
    win = window;
    await flush();
    const loadMoreBtn = window.document.querySelector(
      '[data-action="load-more"]',
    ) as HTMLButtonElement;
    expect(loadMoreBtn.classList.contains('hidden')).toBe(true);
  });

  it.each([
    ['missing next_cursor', { data: [ACCOUNT], has_more: false }],
    ['has_more/cursor disagreement', { data: [ACCOUNT], has_more: true, next_cursor: null }],
    ['terminal page with a cursor', { data: [ACCOUNT], has_more: false, next_cursor: ACCOUNT.id }],
    ['malformed row', terminalPage([{ ...ACCOUNT, id: 'acc_not-a-uuid' }])],
  ])('strict page parser rejects %s as unavailable, never as empty', async (_label, body) => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json(body),
    });
    win = window;
    await flush();

    expect(text(window, '[data-list="accounts"]')).toContain('Could not load accounts');
    expect(text(window, '[data-list="accounts"]')).not.toContain(
      'No accounts match the current filter',
    );
    expect(text(window, '[data-banner]')).toContain("Couldn't load accounts");
  });

  it('malformed append preserves rows and the exact cursor so the same page can be retried', async () => {
    let cursorAttempts = 0;
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: (call) => {
        const cursor = new URL(call.url).searchParams.get('cursor');
        if (cursor === ACCOUNT.id) {
          cursorAttempts += 1;
          if (cursorAttempts === 1) {
            return json({ data: [ACCOUNT_2], has_more: true, next_cursor: null });
          }
          return json(terminalPage([ACCOUNT_2]));
        }
        return json(continuedPage([ACCOUNT], ACCOUNT.id));
      },
    });
    win = window;
    await flush();
    const loadMore = window.document.querySelector(
      '[data-action="load-more"]',
    ) as HTMLButtonElement;

    loadMore.click();
    await flush();
    expect(text(window, '[data-list="accounts"]')).toContain('Acme Corp');
    expect(text(window, '[data-list="accounts"]')).not.toContain('Second Co');
    expect(text(window, '[data-banner]')).toContain('retry cursor are unchanged');
    expect(loadMore.disabled).toBe(false);

    loadMore.click();
    await flush();
    expect(text(window, '[data-list="accounts"]')).toContain('Second Co');
    const cursorCalls = fetchCalls.filter(
      (call) => new URL(call.url).searchParams.get('cursor') === ACCOUNT.id,
    );
    expect(cursorCalls).toHaveLength(2);
  });

  it('HTTP append failure also preserves rows and retries the identical cursor', async () => {
    let cursorAttempts = 0;
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: (call) => {
        const cursor = new URL(call.url).searchParams.get('cursor');
        if (cursor === ACCOUNT.id) {
          cursorAttempts += 1;
          return cursorAttempts === 1
            ? json({ detail: 'temporary' }, 503)
            : json(terminalPage([ACCOUNT_2]));
        }
        return json(continuedPage([ACCOUNT], ACCOUNT.id));
      },
    });
    win = window;
    await flush();
    const loadMore = window.document.querySelector(
      '[data-action="load-more"]',
    ) as HTMLButtonElement;

    loadMore.click();
    await flush();
    expect(text(window, '[data-list="accounts"]')).toContain('Acme Corp');
    expect(text(window, '[data-list="accounts"]')).not.toContain('Second Co');
    expect(loadMore.disabled).toBe(false);
    loadMore.click();
    await flush();

    expect(text(window, '[data-list="accounts"]')).toContain('Second Co');
    expect(
      fetchCalls
        .filter((call) => new URL(call.url).searchParams.has('cursor'))
        .map((call) => new URL(call.url).searchParams.get('cursor')),
    ).toEqual([ACCOUNT.id, ACCOUNT.id]);
  });

  it('deduplicates overlap and refuses an immediate repeated cursor without another request', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: (call) =>
        new URL(call.url).searchParams.get('cursor') === ACCOUNT.id
          ? json(continuedPage([ACCOUNT, ACCOUNT_2], ACCOUNT.id))
          : json(continuedPage([ACCOUNT], ACCOUNT.id)),
    });
    win = window;
    await flush();
    const loadMore = window.document.querySelector(
      '[data-action="load-more"]',
    ) as HTMLButtonElement;

    loadMore.click();
    await flush();
    const rawId = ACCOUNT.id.replace(/^acc_/, '');
    expect(window.document.querySelectorAll(`a[href="/accounts/${rawId}"]`)).toHaveLength(1);
    expect(text(window, '[data-field="footnote"]')).toContain('Showing 2 accounts');
    expect(text(window, '[data-field="footnote"]')).toContain('pagination stopped');
    expect(text(window, '[data-banner]')).toContain('server repeated a cursor');
    expect(loadMore.disabled).toBe(true);
    expect(loadMore.classList.contains('hidden')).toBe(true);

    loadMore.click();
    await flush();
    expect(fetchCalls).toHaveLength(2);
  });

  it('refuses a multi-page cursor history cycle C1 → C2 → C1', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: (call) => {
        const cursor = new URL(call.url).searchParams.get('cursor');
        if (cursor === ACCOUNT.id) return json(continuedPage([ACCOUNT_2], ACCOUNT_2.id));
        if (cursor === ACCOUNT_2.id) return json(continuedPage([ACCOUNT_3], ACCOUNT.id));
        return json(continuedPage([ACCOUNT], ACCOUNT.id));
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

    expect(text(window, '[data-list="accounts"]')).toContain('Third Co');
    expect(text(window, '[data-field="footnote"]')).toContain('Showing 3 accounts');
    expect(text(window, '[data-field="footnote"]')).toContain('pagination stopped');
    expect(fetchCalls).toHaveLength(3);
    expect(loadMore.disabled).toBe(true);
  });

  it('a newer explicit refresh owns the list and makes a held older-page response inert', async () => {
    const older = deferred<Response>();
    let firstPageRequests = 0;
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: (call) => {
        if (new URL(call.url).searchParams.get('cursor') === ACCOUNT.id) return older.promise;
        firstPageRequests += 1;
        return json(
          firstPageRequests === 1
            ? continuedPage([ACCOUNT], ACCOUNT.id)
            : terminalPage([ACCOUNT_3]),
        );
      },
    });
    win = window;
    await flush();

    (window.document.querySelector('[data-action="load-more"]') as HTMLButtonElement).click();
    await flush(2);
    (window.document.querySelector('[data-live-refresh]') as HTMLButtonElement).click();
    await flush();
    older.resolve(json(terminalPage([ACCOUNT_2])));
    await flush();

    const list = text(window, '[data-list="accounts"]');
    expect(list).toContain('Third Co');
    expect(list).not.toContain('Second Co');
    expect(list).not.toContain('Acme Corp');
  });

  it('expanded rows pause polling until Back to newest / Refresh explicitly resets them', async () => {
    let firstPageRequests = 0;
    const { window, fetchCalls, runInterval } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      captureIntervals: true,
      route: (call) => {
        if (new URL(call.url).searchParams.get('cursor') === ACCOUNT.id) {
          return json(terminalPage([ACCOUNT_2]));
        }
        firstPageRequests += 1;
        return json(
          firstPageRequests === 1
            ? continuedPage([ACCOUNT], ACCOUNT.id)
            : terminalPage([ACCOUNT_3]),
        );
      },
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-action="load-more"]') as HTMLButtonElement).click();
    await flush();
    expect(fetchCalls).toHaveLength(2);

    runInterval(30_000);
    await flush();
    expect(fetchCalls).toHaveLength(2);
    expect(text(window, '[data-live-status]')).toContain(
      'Live refresh paused while viewing older accounts',
    );
    const back = window.document.querySelector(
      '[data-action="back-to-newest"]',
    ) as HTMLButtonElement;
    expect(back.classList.contains('hidden')).toBe(false);

    back.click();
    await flush();
    expect(fetchCalls).toHaveLength(3);
    expect(text(window, '[data-list="accounts"]')).toContain('Third Co');
    expect(text(window, '[data-list="accounts"]')).not.toContain('Second Co');
    expect(back.classList.contains('hidden')).toBe(true);
  });

  it('filter input synchronously disables old-cursor pagination and refetches cursorlessly', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: (call) =>
        new URL(call.url).searchParams.has('email_contains')
          ? json(terminalPage([ACCOUNT]))
          : json(continuedPage([ACCOUNT], ACCOUNT.id)),
    });
    win = window;
    await flush();
    const loadMore = window.document.querySelector(
      '[data-action="load-more"]',
    ) as HTMLButtonElement;
    expect(loadMore.disabled).toBe(false);
    const search = window.document.querySelector('[data-field="search"]') as HTMLInputElement;
    search.value = 'acme';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(loadMore.disabled).toBe(true);
    loadMore.click();
    expect(fetchCalls).toHaveLength(1);
    // The input handler debounces 200ms before loading.
    await new Promise((r) => setTimeout(r, 260));
    const filtered = fetchCalls.find((c) => /email_contains=acme/.test(c.url));
    expect(filtered).toBeTruthy();
    expect(new URL(filtered!.url).searchParams.has('cursor')).toBe(false);
    expect(fetchCalls.some((call) => new URL(call.url).searchParams.has('cursor'))).toBe(false);
  });
});
