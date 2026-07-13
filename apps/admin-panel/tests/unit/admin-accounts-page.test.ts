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

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'accounts', 'index.html');
const PAGE_URL = 'https://admin.driftstack.dev/accounts/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface SetUpOpts {
  token?: string;
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
  // @ts-expect-error — jsdom global is loose
  if (typeof window.Response !== 'function') window.Response = Response;
  // @ts-expect-error — jsdom global is loose
  window.fetch = (input: string, init: RequestInit | undefined) => {
    const call: MockFetchCall = { url: String(input), init };
    fetchCalls.push(call);
    return Promise.resolve(opts.route(call));
  };
  if (opts.token !== undefined) window.localStorage.setItem('ds_web_session_token', opts.token);
  // @ts-expect-error — injected by AdminLayout
  window.dashboardHydrated = () => {};

  const pageScript = scriptBodies.find((s) => s.includes('data-page="admin-accounts"'));
  if (!pageScript) throw new Error('admin-accounts inline script not found');
  // @ts-expect-error — jsdom global has eval
  window.eval(pageScript);
  return { window: window as JSDOM['window'], fetchCalls };
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

const ACCOUNT = {
  id: 'acc_abc123',
  name: 'Acme Corp',
  email: 'ops@acme.example',
  tier: 'api_builder',
  status: 'active',
  created_at: '2026-01-15T00:00:00.000Z',
  updated_at: '2026-05-01T00:00:00.000Z',
};

let win: JSDOM['window'] | undefined;
afterEach(() => {
  win?.close?.();
  win = undefined;
});

describe('admin-panel Accounts (accounts.astro) behaviour', () => {
  it('no session token: shows the staff-admin sign-in banner and makes no API call', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      route: () => {
        throw new Error('must not fetch when unauthenticated');
      },
    });
    win = window;
    await flush();
    expect(fetchCalls.length).toBe(0);
    expect(text(window, '[data-banner]')).toContain('Sign in with a staff admin account');
  });

  it('renders an account row with identity, tier, status, dates, and an acc_-stripped Open link', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json({ data: [ACCOUNT], has_more: false }),
    });
    win = window;
    await flush();
    const list = text(window, '[data-list="accounts"]');
    expect(list).toContain('Acme Corp');
    expect(list).toContain('ops@acme.example');
    expect(list).toContain('acc_abc123');
    expect(list).toContain('api_builder');
    expect(list).toContain('active');
    expect(list).toContain('2026-01-15'); // created_at via fmtIso
    // The Open link strips the acc_ prefix from the id segment.
    expect(window.document.querySelector('a[href="/accounts/abc123"]')).toBeTruthy();
    expect(window.document.querySelector('a[href="/accounts/acc_abc123"]')).toBeFalsy();
    expect(text(window, '[data-field="footnote"]')).toContain('Showing 1 account');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.init?.signal).toBeInstanceOf(window.AbortSignal);
  });

  it('empty result: shows the no-match row and a zero-count footnote', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json({ data: [], has_more: false }),
    });
    win = window;
    await flush();
    expect(text(window, '[data-list="accounts"]')).toContain(
      'No accounts match the current filter',
    );
    expect(text(window, '[data-field="footnote"]')).toContain('Showing 0 accounts');
  });

  it('has_more: the footnote notes more results are available', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json({ data: [ACCOUNT], has_more: true }),
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
      route: () => json({ data: [ACCOUNT], has_more: false }),
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
    const ACCOUNT_2 = {
      ...ACCOUNT,
      id: 'acc_def456',
      email: 'second@acme.example',
      name: 'Second Co',
    };
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: (call) => {
        if (/cursor=acc_def456/.test(call.url)) {
          return json({ data: [ACCOUNT_2], has_more: false, next_cursor: null });
        }
        return json({ data: [ACCOUNT], has_more: true, next_cursor: 'acc_def456' });
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

    const cursorCalls = fetchCalls.filter((c) => /cursor=acc_def456/.test(c.url));
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
    expect(loadMoreBtn.hasAttribute('aria-busy')).toBe(false);
  });

  it('pagination: has_more=false keeps "Load more" hidden', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json({ data: [ACCOUNT], has_more: false }),
    });
    win = window;
    await flush();
    const loadMoreBtn = window.document.querySelector(
      '[data-action="load-more"]',
    ) as HTMLButtonElement;
    expect(loadMoreBtn.classList.contains('hidden')).toBe(true);
  });

  it('search filter: typing refetches /v1/admin/accounts with email_contains', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json({ data: [ACCOUNT], has_more: false }),
    });
    win = window;
    await flush();
    const search = window.document.querySelector('[data-field="search"]') as HTMLInputElement;
    search.value = 'acme';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    // The input handler debounces 200ms before loading.
    await new Promise((r) => setTimeout(r, 260));
    const filtered = fetchCalls.find((c) => /email_contains=acme/.test(c.url));
    expect(filtered).toBeTruthy();
  });
});
