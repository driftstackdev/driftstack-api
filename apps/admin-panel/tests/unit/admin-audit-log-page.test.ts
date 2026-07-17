// Behavioural coverage for the admin Audit Log page —
// apps/admin-panel/src/pages/audit-log.astro. The operator's view of staff
// admin actions across all accounts (actor → action, target, result, time).
// Covers auth-gate, row rendering (admin_account_id / target / resource /
// action / result badge / UTC timestamp), the empty state, the 403 admin-scope
// message, and the CLIENT-SIDE result filter.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installAdminDeadline } from './admin-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'audit-log', 'index.html');
const PAGE_URL = 'https://admin.driftstack.dev/audit-log/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface SetUpOpts {
  token?: string;
  storageDenied?: boolean;
  pageUrl?: string;
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
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(htmlNoScripts, {
    url: opts.pageUrl ?? PAGE_URL,
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

  const pageScript = scriptBodies.find((s) => s.includes('data-page="admin-audit-log"'));
  if (!pageScript) throw new Error('admin-audit-log inline script not found');
  // @ts-expect-error — jsdom global has eval
  window.eval(pageScript);
  return {
    window: window as JSDOM['window'],
    fetchCalls,
    hydratedCount: () => hydrated,
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

const SUCCESS_ENTRY = {
  id: '00000000-0000-4000-8000-000000000001',
  admin_account_id: 'acc_adm1',
  admin_key_id: 'key_admin1',
  target_account_id: 'acc_t1',
  target_resource_id: 'prof_x9',
  input_payload: null,
  ip_address: null,
  timestamp: '2026-05-20T10:00:00.000Z',
  action: 'session.destroyed_by_admin',
  result: 'success',
};
// Failures are audited as `error: <code>` by every admin route's catch block
// (NOT a bare 'error'), and the result <select> offers value="error". The
// client filter must therefore PREFIX-match — using a realistic value here is
// what exercises the bug (an exact === 'error' filter would never match this).
const ERROR_ENTRY = {
  id: '00000000-0000-4000-8000-000000000002',
  admin_account_id: 'acc_adm2',
  admin_key_id: 'key_admin2',
  target_account_id: null,
  target_resource_id: null,
  input_payload: null,
  ip_address: null,
  timestamp: '2026-05-21T08:30:00.000Z',
  action: 'account.suspended',
  result: 'error: forbidden',
};

const OLDER_ERROR_ENTRY = {
  ...ERROR_ENTRY,
  id: '00000000-0000-4000-8000-000000000003',
  timestamp: '2026-05-19T08:30:00.000Z',
  action: 'account.unsuspended',
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let win: JSDOM['window'] | undefined;
afterEach(() => {
  win?.close?.();
  win = undefined;
});

describe('admin-panel Audit Log (audit-log.astro) behaviour', () => {
  it.each([
    ['signed out', {}],
    ['storage denied', { storageDenied: true }],
  ])('%s: renders an inert forensic shell without network', async (_label, auth) => {
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
    expect(text(window, '[data-list="audit"]')).toContain('Sign in with a staff admin account');
    const refresh = window.document.querySelector('[data-live-refresh]') as HTMLButtonElement;
    expect(refresh.disabled).toBe(true);

    const action = window.document.querySelector('[data-field="action"]') as HTMLSelectElement;
    action.value = 'account.suspended';
    action.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(fetchCalls).toHaveLength(0);
    expect(refresh.disabled).toBe(true);
  });

  it('renders a row with actor, action, target, result badge, and UTC timestamp', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json({ data: [SUCCESS_ENTRY], next_cursor: null }),
    });
    win = window;
    await flush();
    const list = text(window, '[data-list="audit"]');
    expect(list).toContain('acc_adm1');
    expect(list).toContain('session.destroyed_by_admin');
    expect(list).toContain('success');
    expect(list).toContain('acc_t1');
    expect(list).toContain('prof_x9');
    expect(list).toContain('2026-05-20 10:00:00 UTC');
    expect(fetchCalls[0]?.init?.signal).toBeTruthy();
  });

  it('offers exact schema-backed admin actions instead of a free-form substring field', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json({ data: [], next_cursor: null }),
    });
    win = window;
    await flush();
    const action = window.document.querySelector('[data-field="action"]');
    expect(action).toBeInstanceOf(window.HTMLSelectElement);
    expect(window.document.querySelector('input[data-field="action"]')).toBeNull();
    const values = [...(action as HTMLSelectElement).options].map((option) => option.value);
    expect(values).toContain('account.tier_changed');
    expect(values).toContain('session.destroyed_by_admin');
    expect(values).not.toContain('account.suspend');
  });

  it('bounds and aborts superseded reads, defers fresh-SSO start, and pins timeout recovery', () => {
    const built = readFileSync(BUILT_PAGE, 'utf8');
    expect(built).toContain('AUDIT_REQUEST_TIMEOUT_MS = 15_000');
    expect(built).toContain('Request timed out. Check the connection and try again.');
    expect(built).toMatch(/if \(loadController\) loadController\.abort\(\)/);
    expect(built).toMatch(
      /document\.addEventListener\('DOMContentLoaded', start, \{ once: true \}\)/,
    );
  });

  it('empty result: shows the no-entries message', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json({ data: [], next_cursor: null }),
    });
    win = window;
    await flush();
    expect(text(window, '[data-list="audit"]')).toContain(
      'No audit entries match the current filter',
    );
  });

  it('never turns a malformed success body into an authoritative empty audit window', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json({ next_cursor: null }),
    });
    win = window;
    await flush();
    expect(text(window, '[data-list="audit"]')).toContain(
      'Could not load live audit entries — nothing is shown as authoritative',
    );
    expect(text(window, '[data-list="audit"]')).not.toContain(
      'No audit entries match the current filter',
    );
    expect(text(window, '[data-banner]')).toContain("Couldn't load audit log");
  });

  it.each([
    ['missing required cursor', { data: [SUCCESS_ENTRY] }],
    ['empty cursor', { data: [SUCCESS_ENTRY], next_cursor: '' }],
    [
      'malformed entry',
      { data: [{ ...SUCCESS_ENTRY, id: '', timestamp: 'not-a-timestamp' }], next_cursor: null },
    ],
  ])('rejects a %s before committing an authoritative page', async (_label, body) => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json(body),
    });
    win = window;
    await flush();
    expect(text(window, '[data-list="audit"]')).toContain(
      'Could not load live audit entries — nothing is shown as authoritative',
    );
    expect(text(window, '[data-field="window-summary"]')).toBe('Loaded window unavailable.');
  });

  it('preserves the prior window and exact retry cursor after a malformed newest refresh', async () => {
    let newestAttempts = 0;
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: ({ url }) => {
        if (new URL(url).searchParams.get('cursor') === 'cursor-1') {
          return json({ data: [OLDER_ERROR_ENTRY], next_cursor: null });
        }
        newestAttempts += 1;
        if (newestAttempts === 1) {
          return json({ data: [SUCCESS_ENTRY], next_cursor: 'cursor-1' });
        }
        return json({ data: [ERROR_ENTRY] });
      },
    });
    win = window;
    await flush();

    (window.document.querySelector('[data-live-refresh]') as HTMLButtonElement).click();
    await flush();
    expect(text(window, '[data-list="audit"]')).toContain('session.destroyed_by_admin');
    expect(text(window, '[data-list="audit"]')).not.toContain('account.suspended');
    expect(text(window, '[data-banner]')).toContain(
      'Existing rows and pagination state are unchanged',
    );

    (window.document.querySelector('[data-action="load-more"]') as HTMLButtonElement).click();
    await flush();
    expect(new URL(fetchCalls[2]!.url).searchParams.get('cursor')).toBe('cursor-1');
    expect(text(window, '[data-list="audit"]')).toContain('account.unsuspended');
  });

  it('403: surfaces the admin-scope-required message', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json({ detail: 'forbidden' }, 403),
    });
    win = window;
    await flush();
    expect(text(window, '[data-banner]')).toContain('admin scope required');
  });

  it('manual live refresh stays red after a handled load failure', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json({ detail: 'boom' }, 500),
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-live-refresh]') as HTMLButtonElement).click();
    await flush();
    expect(window.document.querySelector('[data-live-dot]')?.className).toContain('bg-red-500');
  });

  it('client-side result filter: selecting "error" hides the success rows', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json({ data: [SUCCESS_ENTRY, ERROR_ENTRY], next_cursor: null }),
    });
    win = window;
    await flush();
    // Both rows present initially.
    expect(text(window, '[data-list="audit"]')).toContain('session.destroyed_by_admin');
    expect(text(window, '[data-list="audit"]')).toContain('account.suspended');
    // Filter to errors only (the result filter is applied client-side after fetch).
    const resultEl = window.document.querySelector('[data-field="result"]') as HTMLSelectElement;
    resultEl.value = 'error';
    resultEl.dispatchEvent(new window.Event('change', { bubbles: true }));
    await flush();
    const list = text(window, '[data-list="audit"]');
    expect(list).toContain('account.suspended'); // the error row stays
    expect(list).not.toContain('session.destroyed_by_admin'); // success row filtered out
    expect(fetchCalls).toHaveLength(1); // result is local over the loaded window
  });

  it('loads older pages, dedupes by id, and filters across the complete loaded window', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: ({ url }) => {
        const cursor = new URL(url).searchParams.get('cursor');
        if (cursor === 'cursor-1') {
          return json({ data: [SUCCESS_ENTRY, OLDER_ERROR_ENTRY], next_cursor: null });
        }
        return json({ data: [SUCCESS_ENTRY], next_cursor: 'cursor-1' });
      },
    });
    win = window;
    await flush();

    const resultEl = window.document.querySelector('[data-field="result"]') as HTMLSelectElement;
    resultEl.value = 'error';
    resultEl.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(text(window, '[data-list="audit"]')).toContain(
      'Older entries are available; load more to continue searching.',
    );

    const loadMore = window.document.querySelector(
      '[data-action="load-more"]',
    ) as HTMLButtonElement;
    expect(loadMore.classList.contains('hidden')).toBe(false);
    loadMore.click();
    await flush();

    expect(fetchCalls).toHaveLength(2);
    expect(new URL(fetchCalls[1]!.url).searchParams.get('cursor')).toBe('cursor-1');
    const list = text(window, '[data-list="audit"]');
    expect(list).toContain('account.unsuspended');
    expect(list).not.toContain('session.destroyed_by_admin');
    expect(text(window, '[data-field="window-summary"]')).toContain(
      'Loaded window: 2 audit entries; showing 1 matching',
    );
    expect(text(window, '[data-field="window-summary"]')).toContain(
      'All available entries for these server filters are loaded.',
    );
    expect(
      window.document.querySelector('[data-action="back-to-newest"]')?.classList.contains('hidden'),
    ).toBe(false);

    (window.document.querySelector('[data-action="back-to-newest"]') as HTMLButtonElement).click();
    await flush();
    expect(fetchCalls).toHaveLength(3);
    expect(new URL(fetchCalls[2]!.url).searchParams.has('cursor')).toBe(false);
    expect(
      window.document.querySelector('[data-action="back-to-newest"]')?.classList.contains('hidden'),
    ).toBe(true);
  });

  it('preserves rows and the cursor after an append failure, then permits an exact retry', async () => {
    let appendAttempts = 0;
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: ({ url }) => {
        if (new URL(url).searchParams.get('cursor') !== 'cursor-1') {
          return json({ data: [SUCCESS_ENTRY], next_cursor: 'cursor-1' });
        }
        appendAttempts += 1;
        if (appendAttempts === 1) return json({ detail: 'temporary' }, 500);
        return json({ data: [OLDER_ERROR_ENTRY], next_cursor: null });
      },
    });
    win = window;
    await flush();
    const loadMore = window.document.querySelector(
      '[data-action="load-more"]',
    ) as HTMLButtonElement;

    loadMore.click();
    await flush();
    expect(text(window, '[data-list="audit"]')).toContain('session.destroyed_by_admin');
    expect(text(window, '[data-banner]')).toContain(
      'Existing rows and the retry cursor are unchanged',
    );
    expect(loadMore.disabled).toBe(false);

    loadMore.click();
    await flush();
    expect(text(window, '[data-list="audit"]')).toContain('account.unsuspended');
    expect(
      fetchCalls.filter((call) => new URL(call.url).searchParams.get('cursor') === 'cursor-1'),
    ).toHaveLength(2);
  });

  it('validates a malformed append before state commit and retries the same cursor', async () => {
    let appendAttempts = 0;
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: ({ url }) => {
        if (new URL(url).searchParams.get('cursor') !== 'cursor-1') {
          return json({ data: [SUCCESS_ENTRY], next_cursor: 'cursor-1' });
        }
        appendAttempts += 1;
        if (appendAttempts === 1) {
          return json({ data: [{ ...OLDER_ERROR_ENTRY, id: null }], next_cursor: 'cursor-2' });
        }
        return json({ data: [OLDER_ERROR_ENTRY], next_cursor: null });
      },
    });
    win = window;
    await flush();
    const loadMore = window.document.querySelector(
      '[data-action="load-more"]',
    ) as HTMLButtonElement;

    loadMore.click();
    await flush();
    expect(text(window, '[data-list="audit"]')).toContain('session.destroyed_by_admin');
    expect(text(window, '[data-list="audit"]')).not.toContain('account.unsuspended');
    expect(text(window, '[data-banner]')).toContain(
      'Existing rows and the retry cursor are unchanged',
    );

    loadMore.click();
    await flush();
    expect(text(window, '[data-list="audit"]')).toContain('account.unsuspended');
    expect(
      fetchCalls.filter((call) => new URL(call.url).searchParams.get('cursor') === 'cursor-1'),
    ).toHaveLength(2);
    expect(fetchCalls.some((call) => call.url.includes('cursor-2'))).toBe(false);
  });

  it('claims a changed server-filter scope before debounce and never mixes its old cursor', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: ({ url }) =>
        new URL(url).searchParams.get('action') === 'account.suspended'
          ? json({ data: [ERROR_ENTRY], next_cursor: null })
          : json({ data: [SUCCESS_ENTRY], next_cursor: 'cursor-1' }),
    });
    win = window;
    await flush();

    const loadMore = window.document.querySelector(
      '[data-action="load-more"]',
    ) as HTMLButtonElement;
    const action = window.document.querySelector('[data-field="action"]') as HTMLSelectElement;
    action.value = 'account.suspended';
    action.dispatchEvent(new window.Event('change', { bubbles: true }));

    expect(loadMore.classList.contains('hidden')).toBe(true);
    const result = window.document.querySelector('[data-field="result"]') as HTMLSelectElement;
    result.value = 'error';
    result.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(text(window, '[data-list="audit"]')).toContain('Loading live audit entries');
    loadMore.click();
    await flush(2);
    expect(fetchCalls).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 260));
    await flush();
    expect(fetchCalls).toHaveLength(2);
    const filteredRequest = new URL(fetchCalls[1]!.url);
    expect(filteredRequest.searchParams.get('action')).toBe('account.suspended');
    expect(filteredRequest.searchParams.has('cursor')).toBe(false);
    expect(text(window, '[data-list="audit"]')).toContain('account.suspended');
    expect(text(window, '[data-list="audit"]')).not.toContain('session.destroyed_by_admin');
  });

  it('refuses a repeated server cursor after keeping unique returned rows', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: ({ url }) =>
        new URL(url).searchParams.get('cursor') === 'cursor-1'
          ? json({ data: [OLDER_ERROR_ENTRY], next_cursor: 'cursor-1' })
          : json({ data: [SUCCESS_ENTRY], next_cursor: 'cursor-1' }),
    });
    win = window;
    await flush();
    const loadMore = window.document.querySelector(
      '[data-action="load-more"]',
    ) as HTMLButtonElement;
    loadMore.click();
    await flush();
    expect(text(window, '[data-list="audit"]')).toContain('account.unsuspended');
    expect(text(window, '[data-banner]')).toContain('repeated a pagination cursor');
    expect(loadMore.disabled).toBe(true);
  });

  it('makes a late append inert when a server-side filter resets the list epoch', async () => {
    const heldAppend = deferred<Response>();
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: ({ url }) => {
        const parsed = new URL(url);
        if (parsed.searchParams.get('cursor') === 'cursor-1') return heldAppend.promise;
        if (parsed.searchParams.get('action') === 'account.suspended') {
          return json({ data: [ERROR_ENTRY], next_cursor: null });
        }
        return json({ data: [SUCCESS_ENTRY], next_cursor: 'cursor-1' });
      },
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-action="load-more"]') as HTMLButtonElement).click();
    await flush(2);

    const action = window.document.querySelector('[data-field="action"]') as HTMLSelectElement;
    action.value = 'account.suspended';
    action.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 260));
    await flush();
    expect(fetchCalls).toHaveLength(3);
    expect(text(window, '[data-list="audit"]')).toContain('account.suspended');

    heldAppend.resolve(json({ data: [OLDER_ERROR_ENTRY], next_cursor: null }));
    await flush();
    const list = text(window, '[data-list="audit"]');
    expect(list).toContain('account.suspended');
    expect(list).not.toContain('account.unsuspended');
    expect(list).not.toContain('session.destroyed_by_admin');
  });

  it('clearing a target deep-link resets to a cursor-free newest request', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      pageUrl: PAGE_URL + '?target_id=acc_target',
      route: () => json({ data: [SUCCESS_ENTRY], next_cursor: null }),
    });
    win = window;
    await flush();
    expect(new URL(fetchCalls[0]!.url).searchParams.get('target_id')).toBe('acc_target');

    (window.document.querySelector('[data-action="clear-target"]') as HTMLButtonElement).click();
    await flush();
    expect(fetchCalls).toHaveLength(2);
    const resetUrl = new URL(fetchCalls[1]!.url);
    expect(resetUrl.searchParams.has('target_id')).toBe(false);
    expect(resetUrl.searchParams.has('cursor')).toBe(false);
  });
});
