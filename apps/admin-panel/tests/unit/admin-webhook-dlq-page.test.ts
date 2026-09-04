// Local integration test for the admin /webhook-dlq page's inline
// script — the dead-letter-queue operator console. The DISCARD action
// is the most destructive admin operation: it hard-deletes a webhook
// delivery (payload + retry history gone forever; only the audit row
// remains), so it MUST be confirm-gated. Requeue re-fires the delivery.
// Loads the built dist page, mocks localStorage + fetch with a stateful
// URL router, and stubs the branded window.driftstackConfirm (injected
// by AdminLayout). Admin pages are static → built dist HTML is loadable.
//
// Mirrors admin-sessions-page.test.ts (confirm variant).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installAdminDeadline } from './admin-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'webhook-dlq', 'index.html');
const PAGE_URL = 'https://admin.driftstack.dev/webhook-dlq/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}
interface DlqEntry {
  id: string;
  webhook_id: string;
  event_id: string;
  event_type: string;
  status: 'dlq';
  attempts: number;
  next_attempt_at: string;
  last_response_status: number | null;
  last_response_excerpt: string | null;
  last_error: string | null;
  delivered_at: string | null;
  created_at: string;
}
interface SetUpOpts {
  token?: string | null;
  storageDenied?: boolean;
  confirmReturns?: boolean;
  confirmCalls?: unknown[];
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
  const cr = opts.confirmReturns ?? true;
  // @ts-expect-error — driftstackConfirm is injected by AdminLayout
  window.driftstackConfirm = (_message: string, confirmOpts: unknown) => {
    opts.confirmCalls?.push(confirmOpts);
    return Promise.resolve(cr);
  };
  installAdminDeadline(window);

  const pageScript = scriptBodies.find((s) => s.includes('data-page="admin-dlq"'));
  if (!pageScript) throw new Error('admin webhook-dlq inline script not found');
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
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

async function settlePromises(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

// A control the first page's response has not yet enabled swallows a click in
// silence: jsdom dispatches nothing for a disabled button, so the test proceeds
// having made NO request and fails later at an assertion that reads like a render
// bug. Measured at this click: Node 22 finds `disabled=true class="hidden …"`
// where Node 25 finds it enabled, same checkout and fixtures — so polling the
// ASSERTION could never work, the click had already no-op'd before the poll began.
// Wait for the control to be actionable instead.
async function clickWhenEnabled(
  window: JSDOM['window'],
  selector: string,
  label: string,
  rounds = 100,
): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    const el = window.document.querySelector(selector) as HTMLButtonElement | null;
    if (el !== null && !el.disabled && !el.classList.contains('hidden')) {
      el.click();
      return;
    }
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    await settlePromises();
  }
  throw new Error(`clickWhenEnabled: "${label}" (${selector}) never became clickable`);
}

let entrySequence = 100;
function testDeliveryId(sequence = ++entrySequence): string {
  return 'wdl_00000000-0000-4000-8000-' + String(sequence).padStart(12, '0');
}

function mkEntry(over: Partial<DlqEntry> = {}): DlqEntry {
  return {
    id: testDeliveryId(),
    webhook_id: 'whk_00000000-0000-4000-8000-000000000001',
    event_id: '00000000-0000-4000-8000-000000000001',
    event_type: 'session.failed',
    status: 'dlq',
    attempts: 6,
    next_attempt_at: '2026-05-28T10:01:00.000Z',
    last_response_status: 503,
    last_response_excerpt: 'service unavailable',
    last_error: 'delivery failed',
    delivered_at: null,
    created_at: '2026-05-28T10:00:00.000Z',
    ...over,
  };
}

function makeRouter(entries: DlqEntry[]): (c: MockFetchCall) => Response {
  return (call: MockFetchCall): Response => {
    const method = (call.init?.method || 'GET').toUpperCase();
    const u = call.url.replace(/^https?:\/\/[^/]+/, '');
    const act = u.match(/\/v1\/admin\/webhook-dlq\/([^/?]+)\/(discard|requeue)$/);
    if (act && method === 'POST') {
      const i = entries.findIndex((e) => e.id === act[1]);
      if (i >= 0) entries.splice(i, 1); // both discard + requeue remove from the DLQ
      return json({ ok: true });
    }
    if (/\/v1\/admin\/webhook-dlq(\?|$)/.test(u) && method === 'GET') {
      return json({ data: entries, next_cursor: null });
    }
    return json({}, 404);
  };
}

describe('admin webhook-dlq page — discard / requeue (operator)', () => {
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
    expect(window.document.querySelector('[data-list="dlq"]')?.textContent).toContain(
      'Sign in with a staff admin account',
    );
    expect(
      (window.document.querySelector('[data-live-refresh]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(window.document.querySelector('[data-action="discard"]')).toBeNull();
    expect(window.document.querySelector('[data-action="requeue"]')).toBeNull();
  });

  it('renders DLQ entries with Requeue + Discard actions', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: makeRouter([mkEntry({ id: 'wdl_00000000-0000-4000-8000-000000000001' })]),
    });
    win = window;
    await flush();
    expect(
      window.document.querySelector(
        '[data-action="requeue"][data-id="wdl_00000000-0000-4000-8000-000000000001"]',
      ),
    ).toBeTruthy();
    expect(
      window.document.querySelector(
        '[data-action="discard"][data-id="wdl_00000000-0000-4000-8000-000000000001"]',
      ),
    ).toBeTruthy();
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.init?.signal).toBeInstanceOf(window.AbortSignal);
  });

  it.each([
    ['missing next_cursor', { data: [mkEntry()] }],
    ['empty next_cursor', { data: [mkEntry()], next_cursor: '' }],
    [
      'malformed delivery row',
      {
        data: [{ ...mkEntry(), status: 'delivered' }],
        next_cursor: null,
      },
    ],
  ])('fails closed when the initial page has %s', async (_label, payload) => {
    const { window } = setUpDom(loadBuiltPage(), {
      route: () => json(payload),
    });
    win = window;
    await flush();

    expect(window.document.querySelector('[data-action="requeue"]')).toBeNull();
    expect(window.document.querySelector('[data-action="discard"]')).toBeNull();
    expect(window.document.querySelector('[data-list="dlq"]')?.textContent).toContain(
      'Could not load the DLQ — nothing to act on',
    );
    expect(window.document.querySelector('[data-banner]')?.textContent).toContain(
      'Invalid DLQ response',
    );
    expect(
      window.document.querySelector('[data-action="load-more"]')?.classList.contains('hidden'),
    ).toBe(true);
  });

  it('keeps the authoritative window and exact cursor retryable after a malformed newest refresh', async () => {
    const firstId = testDeliveryId(20);
    const olderId = testDeliveryId(21);
    const cursor = 'cursor-before-malformed-refresh';
    let newestReads = 0;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route(call) {
        const url = new URL(call.url, PAGE_URL);
        if (url.searchParams.get('cursor') === cursor) {
          return json({ data: [mkEntry({ id: olderId })], next_cursor: null });
        }
        newestReads += 1;
        if (newestReads === 1) {
          return json({ data: [mkEntry({ id: firstId })], next_cursor: cursor });
        }
        return json({ data: [mkEntry({ id: testDeliveryId(22) })] });
      },
    });
    win = window;
    await flush();

    (window.document.querySelector('[data-live-refresh]') as HTMLButtonElement).click();
    await flush();

    expect(window.document.querySelector(`[data-id="${firstId}"]`)).not.toBeNull();
    expect(window.document.querySelector('[data-field="summary"]')?.textContent).toBe(
      'Showing 1 entry — more available',
    );
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /couldn't refresh DLQ.*invalid DLQ response.*rows and pagination state are unchanged/i,
    );

    (window.document.querySelector('[data-action="load-more"]') as HTMLButtonElement).click();
    await flush();

    expect(
      fetchCalls.filter(
        (call) => new URL(call.url, PAGE_URL).searchParams.get('cursor') === cursor,
      ),
    ).toHaveLength(1);
    expect(window.document.querySelector(`[data-id="${firstId}"]`)).not.toBeNull();
    expect(window.document.querySelector(`[data-id="${olderId}"]`)).not.toBeNull();
  });

  it('keeps rows and the exact append cursor after a malformed older page, then retries it', async () => {
    const firstId = testDeliveryId(30);
    const olderId = testDeliveryId(31);
    const cursor = 'cursor-retry-after-malformed-page';
    let appendAttempts = 0;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route(call) {
        const url = new URL(call.url, PAGE_URL);
        if (url.searchParams.get('cursor') === cursor) {
          appendAttempts += 1;
          if (appendAttempts === 1) {
            return json({
              data: [{ ...mkEntry({ id: olderId }), webhook_id: 'wrong-prefix' }],
              next_cursor: null,
            });
          }
          return json({ data: [mkEntry({ id: olderId })], next_cursor: null });
        }
        return json({ data: [mkEntry({ id: firstId })], next_cursor: cursor });
      },
    });
    win = window;
    await flush();

    const loadMore = window.document.querySelector(
      '[data-action="load-more"]',
    ) as HTMLButtonElement;
    loadMore.click();
    await flush();

    expect(window.document.querySelector(`[data-id="${firstId}"]`)).not.toBeNull();
    expect(window.document.querySelector(`[data-id="${olderId}"]`)).toBeNull();
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /couldn't load older DLQ entries.*invalid DLQ response.*existing rows are unchanged.*retry cursor is unchanged/i,
    );
    expect(loadMore.classList.contains('hidden')).toBe(false);
    expect(loadMore.disabled).toBe(false);

    loadMore.click();
    await flush();

    expect(
      fetchCalls.filter(
        (call) => new URL(call.url, PAGE_URL).searchParams.get('cursor') === cursor,
      ),
    ).toHaveLength(2);
    expect(window.document.querySelector(`[data-id="${firstId}"]`)).not.toBeNull();
    expect(window.document.querySelector(`[data-id="${olderId}"]`)).not.toBeNull();
  });

  it('single-flights an exact opaque cursor, dedupes overlapping pages, and reports the reachable total honestly', async () => {
    const cursor = 'older/2+opaque value';
    let resolveOlder: ((response: Response) => void) | undefined;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route(call) {
        const url = new URL(call.url, PAGE_URL);
        if (url.searchParams.get('cursor') === cursor) {
          return new Promise<Response>((resolve) => {
            resolveOlder = resolve;
          });
        }
        return json({
          data: [mkEntry({ id: 'wdl_00000000-0000-4000-8000-000000000001' })],
          next_cursor: cursor,
        });
      },
    });
    win = window;
    await flush();

    const loadMore = window.document.querySelector(
      '[data-action="load-more"]',
    ) as HTMLButtonElement;
    expect(loadMore.classList.contains('hidden')).toBe(false);
    expect(window.document.querySelector('[data-field="summary"]')?.textContent).toBe(
      'Showing 1 entry — more available',
    );

    loadMore.click();
    loadMore.click();
    await flush(1);

    const cursorCalls = fetchCalls.filter(
      (call) => new URL(call.url, PAGE_URL).searchParams.get('cursor') !== null,
    );
    expect(cursorCalls).toHaveLength(1);
    expect(new URL(cursorCalls[0]!.url, PAGE_URL).searchParams.get('cursor')).toBe(cursor);
    expect(loadMore.disabled).toBe(true);
    expect(loadMore.textContent).toBe('Loading…');
    expect(loadMore.getAttribute('aria-busy')).toBe('true');

    resolveOlder?.(
      json({
        data: [
          mkEntry({ id: 'wdl_00000000-0000-4000-8000-000000000001' }),
          mkEntry({ id: 'wdl_00000000-0000-4000-8000-000000000002' }),
        ],
        next_cursor: null,
      }),
    );
    await flush();

    expect(window.document.querySelectorAll('[data-action="requeue"]')).toHaveLength(2);
    expect(
      window.document.querySelectorAll('[data-id="wdl_00000000-0000-4000-8000-000000000001"]'),
    ).toHaveLength(2);
    expect(
      window.document.querySelectorAll('[data-id="wdl_00000000-0000-4000-8000-000000000002"]'),
    ).toHaveLength(2);
    expect(window.document.querySelector('[data-field="summary"]')?.textContent).toBe(
      'Showing 2 entries',
    );
    expect(loadMore.classList.contains('hidden')).toBe(true);
    expect(
      window.document.querySelector('[data-action="back-to-newest"]')?.classList.contains('hidden'),
    ).toBe(false);
    expect(window.document.querySelector('[data-live-status]')?.textContent).toBe(
      'Live refresh paused while viewing older entries',
    );
  });

  it('makes a held append inert after a newer first-page refresh owns the list epoch', async () => {
    const cursor = 'cur_stale';
    let firstPage = true;
    let resolveOlder: ((response: Response) => void) | undefined;
    const { window } = setUpDom(loadBuiltPage(), {
      route(call) {
        const url = new URL(call.url, PAGE_URL);
        if (url.searchParams.get('cursor') === cursor) {
          return new Promise<Response>((resolve) => {
            resolveOlder = resolve;
          });
        }
        if (firstPage) {
          firstPage = false;
          return json({
            data: [mkEntry({ id: 'wdl_00000000-0000-4000-8000-000000000010' })],
            next_cursor: cursor,
          });
        }
        return json({
          data: [mkEntry({ id: 'wdl_00000000-0000-4000-8000-000000000011' })],
          next_cursor: 'cur_fresh',
        });
      },
    });
    win = window;
    await flush();

    (window.document.querySelector('[data-action="load-more"]') as HTMLButtonElement).click();
    await flush(1);
    (window.document.querySelector('[data-live-refresh]') as HTMLButtonElement).click();
    await flush();

    resolveOlder?.(
      json({
        data: [mkEntry({ id: 'wdl_00000000-0000-4000-8000-000000000012' })],
        next_cursor: null,
      }),
    );
    await flush();

    expect(
      window.document.querySelector('[data-id="wdl_00000000-0000-4000-8000-000000000011"]'),
    ).not.toBeNull();
    expect(
      window.document.querySelector('[data-id="wdl_00000000-0000-4000-8000-000000000010"]'),
    ).toBeNull();
    expect(
      window.document.querySelector('[data-id="wdl_00000000-0000-4000-8000-000000000012"]'),
    ).toBeNull();
    expect(window.document.querySelector('[data-field="summary"]')?.textContent).toBe(
      'Showing 1 entry — more available',
    );
    expect(
      window.document.querySelector('[data-action="load-more"]')?.classList.contains('hidden'),
    ).toBe(false);
    expect(
      window.document.querySelector('[data-action="back-to-newest"]')?.classList.contains('hidden'),
    ).toBe(true);
  });

  it('preserves rows and cursor after an append failure so the operator can retry safely', async () => {
    const cursor = 'cur_retry';
    let appendAttempts = 0;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route(call) {
        const url = new URL(call.url, PAGE_URL);
        if (url.searchParams.get('cursor') === cursor) {
          appendAttempts += 1;
          if (appendAttempts === 1) return json({ detail: 'temporary failure' }, 503);
          return json({
            data: [mkEntry({ id: 'wdl_00000000-0000-4000-8000-000000000002' })],
            next_cursor: null,
          });
        }
        return json({
          data: [mkEntry({ id: 'wdl_00000000-0000-4000-8000-000000000001' })],
          next_cursor: cursor,
        });
      },
    });
    win = window;
    await flush();

    const loadMore = window.document.querySelector(
      '[data-action="load-more"]',
    ) as HTMLButtonElement;
    loadMore.click();
    await flush();

    expect(
      window.document.querySelector('[data-id="wdl_00000000-0000-4000-8000-000000000001"]'),
    ).not.toBeNull();
    expect(
      window.document.querySelector('[data-id="wdl_00000000-0000-4000-8000-000000000002"]'),
    ).toBeNull();
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /couldn't load older DLQ entries.*existing rows are unchanged/i,
    );
    expect(loadMore.classList.contains('hidden')).toBe(false);
    expect(loadMore.disabled).toBe(false);

    loadMore.click();
    await flush();

    expect(
      fetchCalls.filter(
        (call) => new URL(call.url, PAGE_URL).searchParams.get('cursor') === cursor,
      ),
    ).toHaveLength(2);
    expect(
      window.document.querySelector('[data-id="wdl_00000000-0000-4000-8000-000000000001"]'),
    ).not.toBeNull();
    expect(
      window.document.querySelector('[data-id="wdl_00000000-0000-4000-8000-000000000002"]'),
    ).not.toBeNull();
    expect(loadMore.classList.contains('hidden')).toBe(true);
  });

  it('pauses live polling while older rows are expanded and Back to newest resets the list', async () => {
    vi.useFakeTimers();
    const cursor = 'cur_older';
    let newestLoads = 0;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route(call) {
        const url = new URL(call.url, PAGE_URL);
        if (url.searchParams.get('cursor') === cursor) {
          return json({
            data: [mkEntry({ id: 'wdl_00000000-0000-4000-8000-000000000013' })],
            next_cursor: null,
          });
        }
        newestLoads += 1;
        return newestLoads === 1
          ? json({
              data: [mkEntry({ id: 'wdl_00000000-0000-4000-8000-000000000014' })],
              next_cursor: cursor,
            })
          : json({
              data: [mkEntry({ id: 'wdl_00000000-0000-4000-8000-000000000015' })],
              next_cursor: null,
            });
      },
    });
    win = window;
    await settlePromises();

    await clickWhenEnabled(window, '[data-action="load-more"]', 'load more');
    await settlePromises();
    expect(
      window.document.querySelector('[data-id="wdl_00000000-0000-4000-8000-000000000013"]'),
    ).not.toBeNull();

    const fetchCountWhileExpanded = fetchCalls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchCalls).toHaveLength(fetchCountWhileExpanded);
    expect(window.document.querySelector('[data-live-status]')?.textContent).toBe(
      'Live refresh paused while viewing older entries',
    );

    await clickWhenEnabled(window, '[data-action="back-to-newest"]', 'back to newest');
    await settlePromises();
    await vi.advanceTimersByTimeAsync(0);
    await settlePromises();

    expect(fetchCalls).toHaveLength(fetchCountWhileExpanded + 1);
    expect(
      window.document.querySelector('[data-id="wdl_00000000-0000-4000-8000-000000000015"]'),
    ).not.toBeNull();
    expect(
      window.document.querySelector('[data-id="wdl_00000000-0000-4000-8000-000000000014"]'),
    ).toBeNull();
    expect(
      window.document.querySelector('[data-id="wdl_00000000-0000-4000-8000-000000000013"]'),
    ).toBeNull();
    expect(
      window.document.querySelector('[data-action="back-to-newest"]')?.classList.contains('hidden'),
    ).toBe(true);
    expect(window.document.querySelector('[data-live-status]')?.textContent).toBe('Live · updated');
  });

  it('CRITICAL discard confirm is destructive:true — without it a stray Enter fires the irrecoverable hard-delete with no click required (audit waefer6wu)', async () => {
    const confirmCalls: unknown[] = [];
    const { window } = setUpDom(loadBuiltPage(), {
      confirmReturns: true,
      confirmCalls,
      route: makeRouter([mkEntry({ id: 'wdl_00000000-0000-4000-8000-000000000001' })]),
    });
    win = window;
    await flush();
    (
      window.document.querySelector(
        '[data-action="discard"][data-id="wdl_00000000-0000-4000-8000-000000000001"]',
      ) as HTMLButtonElement
    ).click();
    await flush();
    expect(confirmCalls.length).toBe(1);
    expect(confirmCalls[0]).toMatchObject({ destructive: true });
  });

  it('discard: confirm-gated POST /:id/discard then refresh removes that entry (others remain)', async () => {
    // Two entries so the list re-renders (a 0-length refresh hides the
    // region without clearing innerHTML, which would leave stale nodes).
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      confirmReturns: true,
      route: makeRouter([
        mkEntry({ id: 'wdl_00000000-0000-4000-8000-000000000001' }),
        mkEntry({ id: 'wdl_00000000-0000-4000-8000-000000000002' }),
      ]),
    });
    win = window;
    await flush();
    (
      window.document.querySelector(
        '[data-action="discard"][data-id="wdl_00000000-0000-4000-8000-000000000001"]',
      ) as HTMLButtonElement
    ).click();
    await flush();
    const post = fetchCalls.find(
      (c) =>
        c.init?.method === 'POST' &&
        /\/v1\/admin\/webhook-dlq\/wdl_00000000-0000-4000-8000-000000000001\/discard$/.test(c.url),
    );
    expect(post).toBeTruthy();
    expect(post?.init?.signal).toBeInstanceOf(window.AbortSignal);
    expect(
      window.document.querySelector(
        '[data-action="discard"][data-id="wdl_00000000-0000-4000-8000-000000000001"]',
      ),
    ).toBeNull();
    expect(
      window.document.querySelector(
        '[data-action="discard"][data-id="wdl_00000000-0000-4000-8000-000000000002"]',
      ),
    ).toBeTruthy();
  });

  it('discard cancelled: irrecoverable delete is NOT fired without confirmation', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      confirmReturns: false,
      route: makeRouter([mkEntry({ id: 'wdl_00000000-0000-4000-8000-000000000001' })]),
    });
    win = window;
    await flush();
    (
      window.document.querySelector(
        '[data-action="discard"][data-id="wdl_00000000-0000-4000-8000-000000000001"]',
      ) as HTMLButtonElement
    ).click();
    await flush();
    expect(fetchCalls.some((c) => /\/discard$/.test(c.url))).toBe(false);
    expect(
      window.document.querySelector(
        '[data-action="discard"][data-id="wdl_00000000-0000-4000-8000-000000000001"]',
      ),
    ).toBeTruthy();
  });

  it('requeue: POST /:id/requeue (re-fire delivery) then refresh removes the entry', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: makeRouter([mkEntry({ id: 'wdl_00000000-0000-4000-8000-000000000001' })]),
    });
    win = window;
    await flush();
    (
      window.document.querySelector(
        '[data-action="requeue"][data-id="wdl_00000000-0000-4000-8000-000000000001"]',
      ) as HTMLButtonElement
    ).click();
    await flush();
    const post = fetchCalls.find(
      (c) =>
        c.init?.method === 'POST' &&
        /\/v1\/admin\/webhook-dlq\/wdl_00000000-0000-4000-8000-000000000001\/requeue$/.test(c.url),
    );
    expect(post).toBeTruthy();
    expect(post?.init?.signal).toBeInstanceOf(window.AbortSignal);
    expect(window.document.querySelectorAll('button[data-id]').length).toBe(0);
  });

  it.each(['requeue', 'discard'] as const)(
    '%s trusts an accepted status without parsing a malformed success body or inviting replay',
    async (action) => {
      const entries = [
        mkEntry({ id: 'wdl_00000000-0000-4000-8000-000000000001' }),
        mkEntry({ id: 'wdl_00000000-0000-4000-8000-000000000002' }),
      ];
      const base = makeRouter(entries);
      const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
        route: (call) => {
          if (call.init?.method === 'POST' && new RegExp('/' + action + '$').test(call.url)) {
            entries.splice(0, 1);
            return new Response('{', {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return base(call);
        },
      });
      win = window;
      await flush();

      (
        window.document.querySelector(
          `[data-action="${action}"][data-id="wdl_00000000-0000-4000-8000-000000000001"]`,
        ) as HTMLButtonElement
      ).click();
      await flush(10);

      expect(
        fetchCalls.filter(
          (call) => call.init?.method === 'POST' && new RegExp('/' + action + '$').test(call.url),
        ),
      ).toHaveLength(1);
      expect(
        window.document.querySelector('[data-id="wdl_00000000-0000-4000-8000-000000000001"]'),
      ).toBeNull();
      expect(
        window.document.querySelector('[data-id="wdl_00000000-0000-4000-8000-000000000002"]'),
      ).not.toBeNull();
      expect(window.document.querySelector('[data-banner]')?.textContent).not.toMatch(
        /couldn't (?:requeue|discard)/i,
      );
    },
  );

  it('requeue timeout refreshes a committed removal and warns against a second delivery attempt', async () => {
    const entries = [mkEntry({ id: 'wdl_00000000-0000-4000-8000-000000000001' })];
    const base = makeRouter(entries);
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (call.init?.method === 'POST' && /\/requeue$/.test(call.url)) {
          entries.splice(0, 1);
          return Promise.reject(timeout);
        }
        return base(call);
      },
    });
    win = window;
    await flush();
    (
      window.document.querySelector(
        '[data-action="requeue"][data-id="wdl_00000000-0000-4000-8000-000000000001"]',
      ) as HTMLButtonElement
    ).click();
    await flush(12);

    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
    expect(
      window.document.querySelector('[data-id="wdl_00000000-0000-4000-8000-000000000001"]'),
    ).toBeNull();
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /outcome is unknown.*DLQ was refreshed.*gone.*likely re-enqueued.*do not submit it again/i,
    );
  });

  it('discard timeout refreshes a committed removal and explains the remaining audit-only trace', async () => {
    const entries = [mkEntry({ id: 'wdl_00000000-0000-4000-8000-000000000001' })];
    const base = makeRouter(entries);
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (call.init?.method === 'POST' && /\/discard$/.test(call.url)) {
          entries.splice(0, 1);
          return Promise.reject(timeout);
        }
        return base(call);
      },
    });
    win = window;
    await flush();
    (
      window.document.querySelector(
        '[data-action="discard"][data-id="wdl_00000000-0000-4000-8000-000000000001"]',
      ) as HTMLButtonElement
    ).click();
    await flush(12);

    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
    expect(
      window.document.querySelector('[data-id="wdl_00000000-0000-4000-8000-000000000001"]'),
    ).toBeNull();
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /outcome is unknown.*DLQ was refreshed.*gone.*likely discarded.*audit trace remains.*do not submit it again/i,
    );
  });

  it('locks both entry actions and sends only one requeue while the mutation is pending', async () => {
    let resolveMutation: ((response: Response) => void) | undefined;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route(call) {
        const method = (call.init?.method || 'GET').toUpperCase();
        if (method === 'POST') {
          return new Promise<Response>((resolve) => {
            resolveMutation = resolve;
          });
        }
        return json({
          data: [mkEntry({ id: 'wdl_00000000-0000-4000-8000-000000000001' })],
          next_cursor: 'cur_pending',
        });
      },
    });
    win = window;
    await flush();
    const requeue = window.document.querySelector(
      '[data-action="requeue"][data-id="wdl_00000000-0000-4000-8000-000000000001"]',
    ) as HTMLButtonElement;
    const discard = window.document.querySelector(
      '[data-action="discard"][data-id="wdl_00000000-0000-4000-8000-000000000001"]',
    ) as HTMLButtonElement;

    requeue.click();
    requeue.click();
    await flush(1);

    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
    expect(requeue.disabled).toBe(true);
    expect(requeue.textContent).toBe('Requeueing…');
    expect(requeue.getAttribute('aria-busy')).toBe('true');
    expect(discard.disabled).toBe(true);
    expect(
      (window.document.querySelector('[data-action="load-more"]') as HTMLButtonElement).disabled,
    ).toBe(true);

    // A manual/automatic refresh replaces the row nodes. The replacement
    // controls must retain the pending state instead of looking clickable
    // while the id-level guard silently ignores them.
    (window.document.querySelector('[data-live-refresh]') as HTMLButtonElement).click();
    await flush();
    const refreshedRequeue = window.document.querySelector(
      '[data-action="requeue"][data-id="wdl_00000000-0000-4000-8000-000000000001"]',
    ) as HTMLButtonElement;
    const refreshedDiscard = window.document.querySelector(
      '[data-action="discard"][data-id="wdl_00000000-0000-4000-8000-000000000001"]',
    ) as HTMLButtonElement;
    expect(refreshedRequeue).not.toBe(requeue);
    expect(refreshedRequeue.disabled).toBe(true);
    expect(refreshedRequeue.textContent).toBe('Requeueing…');
    expect(refreshedRequeue.getAttribute('aria-busy')).toBe('true');
    expect(refreshedDiscard.disabled).toBe(true);
    expect(
      (window.document.querySelector('[data-action="load-more"]') as HTMLButtonElement).disabled,
    ).toBe(true);

    resolveMutation?.(json({ ok: true }));
    await flush();
  });

  it('single-flights discard before its async confirmation resolves', async () => {
    const confirmCalls: unknown[] = [];
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      confirmReturns: true,
      confirmCalls,
      route: makeRouter([mkEntry({ id: 'wdl_00000000-0000-4000-8000-000000000001' })]),
    });
    win = window;
    await flush();
    const discard = window.document.querySelector(
      '[data-action="discard"][data-id="wdl_00000000-0000-4000-8000-000000000001"]',
    ) as HTMLButtonElement;

    discard.click();
    discard.click();
    await flush();

    expect(confirmCalls).toHaveLength(1);
    expect(
      fetchCalls.filter((call) => call.init?.method === 'POST' && /\/discard$/.test(call.url)),
    ).toHaveLength(1);
  });
});
