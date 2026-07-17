// Built-page behavior proof for the admin rate-limit override list.
// The page is read-mostly, but a clear is consequential: ambiguous DELETE
// outcomes stay fenced until an unfiltered, exhaustive account walk proves
// whether the exact row id survived.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installAdminDeadline } from './admin-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'rate-limit-overrides', 'index.html');
const PAGE_URL = 'https://admin.driftstack.dev/rate-limit-overrides/';

const ACCOUNT_A = 'acc_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'acc_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ROW_A = 'rlo_11111111-1111-4111-8111-111111111111';
const ROW_B = 'rlo_22222222-2222-4222-8222-222222222222';
const ROW_C = 'rlo_33333333-3333-4333-8333-333333333333';
const CURSOR_A = ROW_A.slice(4);
const CURSOR_B = ROW_B.slice(4);

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface OverrideRow {
  id: string;
  account_id: string;
  bucket_key: 'global' | 'sessions:create' | 'agent_sessions:message';
  capacity: number;
  refill_per_second: number;
  reason: string | null;
  expires_at: string;
  set_by_key_id: string;
  created_at: string;
  updated_at: string;
}

interface SetUpOpts {
  token?: string | null;
  storageDenied?: boolean;
  confirm?: () => Promise<boolean>;
  route: (call: MockFetchCall) => Response | Promise<Response>;
}

function row(
  id: string,
  accountId: string,
  bucketKey: OverrideRow['bucket_key'],
  overrides: Partial<OverrideRow> = {},
): OverrideRow {
  return {
    id,
    account_id: accountId,
    bucket_key: bucketKey,
    capacity: 100,
    refill_per_second: 5,
    reason: 'incident capacity',
    expires_at: '2027-01-01T00:00:00.000Z',
    set_by_key_id: 'key_99999999-9999-4999-8999-999999999999',
    created_at: '2026-07-17T12:00:00.000Z',
    updated_at: '2026-07-17T12:00:00.000Z',
    ...overrides,
  };
}

const OV_A = row(ROW_A, ACCOUNT_A, 'sessions:create');
const OV_B = row(ROW_B, ACCOUNT_B, 'agent_sessions:message');
const OV_C = row(ROW_C, ACCOUNT_A, 'sessions:create', { reason: 'replacement' });

function page(data: OverrideRow[], nextCursor: string | null): Response {
  return json({ data, next_cursor: nextCursor });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolvePromise: (value: T) => void = () => {};
  let rejectPromise: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
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
  // @ts-expect-error — jsdom global is deliberately bridged to fetch Response.
  if (typeof window.Response !== 'function') window.Response = Response;
  // @ts-expect-error — jsdom's fetch type is intentionally loose in this harness.
  window.fetch = (input: string, init: RequestInit | undefined) => {
    const call = { url: String(input), init };
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
    window.localStorage.setItem('ds_web_session_token', opts.token ?? 'staff-token');
  }
  let hydrated = 0;
  // @ts-expect-error — injected by AdminLayout.
  window.dashboardHydrated = () => {
    hydrated += 1;
  };
  // @ts-expect-error — injected by AdminLayout.
  window.driftstackConfirm = opts.confirm ?? (() => Promise.resolve(true));
  installAdminDeadline(window);

  const pageScript = scriptBodies.find((script) => script.includes('data-page="admin-overrides"'));
  if (!pageScript) throw new Error('admin rate-limit-overrides inline script not found');
  // @ts-expect-error — deliberate execution of the built inline script.
  window.eval(pageScript);
  return { window, fetchCalls, hydratedCount: () => hydrated };
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function requestPath(call: MockFetchCall): URL {
  return new URL(call.url, PAGE_URL);
}

function listCalls(calls: MockFetchCall[]): MockFetchCall[] {
  return calls.filter(
    (call) =>
      (call.init?.method ?? 'GET').toUpperCase() === 'GET' &&
      requestPath(call).pathname === '/v1/admin/rate-limit-overrides',
  );
}

function renderedIds(window: JSDOM['window']): string[] {
  return Array.from(
    window.document.querySelectorAll('[data-list="overrides"] li[data-row-id]'),
  ).map((element) => element.getAttribute('data-row-id') ?? '');
}

function clearButton(window: JSDOM['window'], rowId = ROW_A): HTMLButtonElement {
  const button = window.document.querySelector(`[data-action="clear"][data-row-id="${rowId}"]`);
  if (!(button instanceof window.HTMLButtonElement)) throw new Error('clear button not found');
  return button as HTMLButtonElement;
}

describe('admin rate-limit-overrides page', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close();
    win = null;
  });
  const loadBuiltPage = (): string => readFileSync(BUILT_PAGE, 'utf8');

  it.each([
    ['signed out', { token: null }],
    ['storage denied', { storageDenied: true }],
  ])('%s fails closed without a network request', async (_label, auth) => {
    const setup = setUpDom(loadBuiltPage(), {
      ...auth,
      route: () => {
        throw new Error('must not fetch');
      },
    });
    win = setup.window;
    await flush();

    expect(setup.fetchCalls).toHaveLength(0);
    expect(setup.hydratedCount()).toBe(1);
    expect(setup.window.document.body.textContent).toContain('Sign in with a staff admin account');
    expect(setup.window.document.querySelector('[data-action="clear"]')).toBeNull();
    expect(
      (setup.window.document.querySelector('[data-live-refresh]') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('accepts only a complete canonical row and envelope', async () => {
    const setup = setUpDom(loadBuiltPage(), { route: () => page([OV_A], null) });
    win = setup.window;
    await flush();

    expect(renderedIds(setup.window)).toEqual([ROW_A]);
    const button = clearButton(setup.window);
    expect(button.dataset.accountId).toBe(ACCOUNT_A);
    expect(button.dataset.bucketKey).toBe('sessions:create');
    expect(setup.fetchCalls[0]?.init?.signal).toBeInstanceOf(setup.window.AbortSignal);
  });

  it.each([
    ['missing cursor', { data: [OV_A] }],
    ['extra envelope field', { data: [OV_A], next_cursor: null, has_more: false }],
    ['extra row field', { data: [{ ...OV_A, surprise: true }], next_cursor: null }],
    ['duplicate row id', { data: [OV_A, OV_A], next_cursor: null }],
    ['empty page with cursor', { data: [], next_cursor: CURSOR_A }],
  ])('rejects malformed authority: %s', async (_label, body) => {
    const setup = setUpDom(loadBuiltPage(), { route: () => json(body) });
    win = setup.window;
    await flush();

    expect(renderedIds(setup.window)).toEqual([]);
    expect(setup.window.document.body.textContent).toContain('nothing to act on');
    expect(setup.window.document.querySelector('[data-action="clear"]')).toBeNull();
  });

  it('appends by the exact cursor, pauses polling, and resets only on an explicit newest action', async () => {
    let newestReads = 0;
    const setup = setUpDom(loadBuiltPage(), {
      route: (call) => {
        const url = requestPath(call);
        const cursor = url.searchParams.get('cursor');
        if (cursor === CURSOR_A) return page([OV_B], null);
        newestReads += 1;
        return newestReads === 1 ? page([OV_A], CURSOR_A) : page([OV_C], null);
      },
    });
    win = setup.window;
    await flush();

    (setup.window.document.querySelector('[data-action="load-more"]') as HTMLButtonElement).click();
    await flush();
    expect(renderedIds(setup.window)).toEqual([ROW_A, ROW_B]);
    expect(requestPath(listCalls(setup.fetchCalls)[1]!).searchParams.get('cursor')).toBe(CURSOR_A);
    expect(setup.window.document.querySelector('[data-live-status]')?.textContent).toContain(
      'paused',
    );

    (
      setup.window.document.querySelector('[data-action="back-to-newest"]') as HTMLButtonElement
    ).click();
    await flush();
    expect(renderedIds(setup.window)).toEqual([ROW_C]);
    expect(requestPath(listCalls(setup.fetchCalls)[2]!).searchParams.has('cursor')).toBe(false);
  });

  it('preserves the loaded window and exact retry cursor after append failure or duplication', async () => {
    let appendAttempt = 0;
    const setup = setUpDom(loadBuiltPage(), {
      route: (call) => {
        const cursor = requestPath(call).searchParams.get('cursor');
        if (cursor !== CURSOR_A) return page([OV_A], CURSOR_A);
        appendAttempt += 1;
        if (appendAttempt === 1) return json({ detail: 'unavailable' }, 503);
        if (appendAttempt === 2) return page([OV_A], CURSOR_B);
        return page([OV_B], null);
      },
    });
    win = setup.window;
    await flush();
    const loadMore = setup.window.document.querySelector(
      '[data-action="load-more"]',
    ) as HTMLButtonElement;

    loadMore.click();
    await flush();
    expect(renderedIds(setup.window)).toEqual([ROW_A]);
    expect(setup.window.document.querySelector('[data-banner]')?.textContent).toContain(
      'retry cursor are unchanged',
    );

    loadMore.click();
    await flush();
    expect(renderedIds(setup.window)).toEqual([ROW_A]);
    expect(setup.window.document.querySelector('[data-banner]')?.textContent).toContain(
      'row id was repeated across pages',
    );

    loadMore.click();
    await flush();
    expect(renderedIds(setup.window)).toEqual([ROW_A, ROW_B]);
    const cursorValues = listCalls(setup.fetchCalls)
      .slice(1)
      .map((call) => requestPath(call).searchParams.get('cursor'));
    expect(cursorValues).toEqual([CURSOR_A, CURSOR_A, CURSOR_A]);
  });

  it('stops an immediate cursor cycle without issuing the repeated request', async () => {
    const setup = setUpDom(loadBuiltPage(), {
      route: (call) =>
        requestPath(call).searchParams.has('cursor')
          ? page([OV_B], CURSOR_A)
          : page([OV_A], CURSOR_A),
    });
    win = setup.window;
    await flush();
    (setup.window.document.querySelector('[data-action="load-more"]') as HTMLButtonElement).click();
    await flush();

    expect(renderedIds(setup.window)).toEqual([ROW_A, ROW_B]);
    expect(setup.window.document.querySelector('[data-field="summary"]')?.textContent).toContain(
      'pagination stopped because the server repeated a cursor',
    );
    expect(setup.window.document.querySelector('[data-action="load-more"]')?.classList).toContain(
      'hidden',
    );
    expect(listCalls(setup.fetchCalls)).toHaveLength(2);
  });

  it('invalidates an old filter request synchronously and rejects its late response', async () => {
    const oldRequest = deferred<Response>();
    const newRequest = deferred<Response>();
    let callCount = 0;
    const setup = setUpDom(loadBuiltPage(), {
      route: () => {
        callCount += 1;
        return callCount === 1 ? oldRequest.promise : newRequest.promise;
      },
    });
    win = setup.window;
    await flush(1);

    const filter = setup.window.document.querySelector(
      '[data-field="account-id"]',
    ) as HTMLInputElement;
    filter.value = ACCOUNT_B;
    filter.dispatchEvent(new setup.window.Event('input', { bubbles: true }));
    expect(setup.window.document.body.textContent).toContain(
      'Loading overrides for the new filter',
    );
    await new Promise((resolve) => setTimeout(resolve, 230));
    expect(listCalls(setup.fetchCalls)).toHaveLength(2);

    newRequest.resolve(page([OV_B], null));
    await flush();
    oldRequest.resolve(page([OV_A], null));
    await flush();
    expect(renderedIds(setup.window)).toEqual([ROW_B]);
    expect(requestPath(listCalls(setup.fetchCalls)[1]!).searchParams.get('account_id')).toBe(
      ACCOUNT_B,
    );
  });

  it.each([204, 404])(
    'treats exact %i as authoritative absence and removes only the exact row',
    async (status) => {
      const setup = setUpDom(loadBuiltPage(), {
        route: (call) =>
          (call.init?.method ?? 'GET').toUpperCase() === 'DELETE'
            ? new Response(null, { status })
            : page([OV_A, OV_B], null),
      });
      win = setup.window;
      await flush();
      const button = clearButton(setup.window);
      button.dispatchEvent(new setup.window.MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new setup.window.MouseEvent('click', { bubbles: true }));
      await flush();

      const deletes = setup.fetchCalls.filter((call) => call.init?.method === 'DELETE');
      expect(deletes).toHaveLength(1);
      expect(deletes[0]?.url).toContain(`/v1/admin/accounts/${ACCOUNT_A}/quota-override`);
      expect(deletes[0]?.url).toContain('bucket_key=sessions%3Acreate');
      expect(renderedIds(setup.window)).toEqual([ROW_B]);
    },
  );

  it('keeps the one synchronous mutation lease through confirmation and DELETE', async () => {
    const heldConfirm = deferred<boolean>();
    const heldDelete = deferred<Response>();
    const setup = setUpDom(loadBuiltPage(), {
      confirm: () => heldConfirm.promise,
      route: (call) =>
        call.init?.method === 'DELETE' ? heldDelete.promise : page([OV_A, OV_B], null),
    });
    win = setup.window;
    await flush();
    const target = clearButton(setup.window);
    target.click();
    target.dispatchEvent(new setup.window.MouseEvent('click', { bubbles: true }));

    expect(target.disabled).toBe(true);
    expect(target.textContent).toBe('Confirming…');
    expect(
      (setup.window.document.querySelector('[data-field="account-id"]') as HTMLInputElement)
        .disabled,
    ).toBe(true);
    heldConfirm.resolve(true);
    await flush(2);
    expect(target.textContent).toBe('Clearing…');
    expect(setup.fetchCalls.filter((call) => call.init?.method === 'DELETE')).toHaveLength(1);

    heldDelete.resolve(new Response(null, { status: 204 }));
    await flush();
    expect(renderedIds(setup.window)).toEqual([ROW_B]);
  });

  it('proves ambiguous success by exhaustive exact-row absence and keeps a replacement id visible', async () => {
    let initial = true;
    const timeout = Object.assign(new Error('deadline exceeded'), { name: 'AbortError' });
    const setup = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (call.init?.method === 'DELETE') return Promise.reject(timeout);
        const url = requestPath(call);
        if (url.searchParams.get('include_expired') === 'true') {
          expect(url.searchParams.get('account_id')).toBe(ACCOUNT_A);
          expect(url.searchParams.get('limit')).toBe('100');
          return page([{ ...OV_C, expires_at: '2026-07-01T00:00:00.000Z' }], null);
        }
        if (initial) {
          initial = false;
          return page([OV_A], null);
        }
        return page([], null);
      },
    });
    win = setup.window;
    await flush();
    clearButton(setup.window).click();
    await flush(12);

    expect(renderedIds(setup.window)).toEqual([ROW_C]);
    expect(setup.window.document.querySelector('[data-banner]')?.textContent).toContain(
      'exact original override row is absent',
    );
    expect(setup.window.document.querySelector('[data-banner]')?.textContent).toContain(
      'replacement with a different row id remains visible',
    );
  });

  it('retains an uncertain lease on a cyclic account walk and releases it only after safe recheck', async () => {
    let reconcileRequest = 0;
    const setup = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (call.init?.method === 'DELETE') return json({ accepted: true }, 202);
        const url = requestPath(call);
        if (url.searchParams.get('include_expired') !== 'true') return page([OV_A], null);
        reconcileRequest += 1;
        if (reconcileRequest === 1) {
          return page([row(ROW_B, ACCOUNT_A, 'global')], CURSOR_B);
        }
        if (reconcileRequest === 2) {
          return page([row(ROW_C, ACCOUNT_A, 'agent_sessions:message')], CURSOR_B);
        }
        return page([], null);
      },
    });
    win = setup.window;
    await flush();
    clearButton(setup.window).click();
    await flush(12);

    expect(setup.window.document.querySelector('[data-banner]')?.textContent).toContain(
      'outcome remains unknown',
    );
    expect(clearButton(setup.window).disabled).toBe(true);
    expect(
      (setup.window.document.querySelector('[data-field="include-expired"]') as HTMLInputElement)
        .disabled,
    ).toBe(true);
    const recheck = setup.window.document.querySelector(
      '[data-action="recheck-clear"]',
    ) as HTMLButtonElement;
    expect(recheck.classList).not.toContain('hidden');

    recheck.click();
    await flush(8);
    expect(renderedIds(setup.window)).toEqual([]);
    expect(recheck.classList).toContain('hidden');
    expect(setup.window.document.querySelector('[data-banner]')?.textContent).toContain(
      'exact original override row is absent',
    );
  });

  it('releases the lease after an authoritative 4xx without an account walk', async () => {
    const setup = setUpDom(loadBuiltPage(), {
      route: (call) =>
        call.init?.method === 'DELETE'
          ? json({ error: { message: 'request rejected' } }, 400)
          : page([OV_A], null),
    });
    win = setup.window;
    await flush();
    clearButton(setup.window).click();
    await flush();

    expect(listCalls(setup.fetchCalls)).toHaveLength(1);
    expect(clearButton(setup.window).disabled).toBe(false);
    expect(setup.window.document.querySelector('[data-banner]')?.textContent).toContain(
      'No retry fence is needed',
    );
  });
});
