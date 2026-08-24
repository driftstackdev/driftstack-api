// Local integration test for the admin /status-subscribers page's
// inline script — the operator force-unsubscribes a status-page email
// (POST /v1/admin/status-subscribers/:id/force-unsubscribe), confirm-
// gated + audit-logged. Loads the built dist page, mocks localStorage +
// fetch with a stateful router, stubs the branded window.driftstackConfirm.
// Admin pages are static → built dist HTML is loadable.
//
// Mirrors admin-webhook-dlq-page.test.ts. The force-unsub button only
// renders for ACTIVE subscribers (no unsubscribed_at + has email); a
// force-unsub flips unsubscribed_at so the refreshed row shows "no
// action" — that's how the test asserts the effect (no empty-list churn).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installAdminDeadline } from './admin-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'status-subscribers', 'index.html');
const PAGE_URL = 'https://admin.driftstack.dev/status-subscribers/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}
interface Sub {
  id: string;
  email: string | null;
  created_at: string;
  confirmed_at: string | null;
  unsubscribed_at: string | null;
}
interface SetUpOpts {
  confirmReturns?: boolean;
  route: (call: MockFetchCall) => Response | Promise<Response>;
}

function setUpDom(
  html: string,
  opts: SetUpOpts,
): {
  window: JSDOM['window'];
  fetchCalls: MockFetchCall[];
  runRefreshInterval: () => void;
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
  const intervalHandlers: TimerHandler[] = [];
  // @ts-expect-error — jsdom global is loose
  if (typeof window.Response !== 'function') window.Response = Response;
  // @ts-expect-error — jsdom global is loose
  window.fetch = (input: string, init: RequestInit | undefined) => {
    const call: MockFetchCall = { url: String(input), init };
    fetchCalls.push(call);
    return Promise.resolve(opts.route(call));
  };
  window.localStorage.setItem('ds_web_session_token', 'staff-tok');
  const cr = opts.confirmReturns ?? true;
  // @ts-expect-error — driftstackConfirm is injected by AdminLayout
  window.driftstackConfirm = () => Promise.resolve(cr);
  installAdminDeadline(window);
  window.setInterval = ((handler: TimerHandler) => {
    intervalHandlers.push(handler);
    return intervalHandlers.length;
  }) as typeof window.setInterval;

  const pageScript = scriptBodies.find((s) => s.includes('data-page="status-subscribers"'));
  if (!pageScript) throw new Error('admin status-subscribers inline script not found');
  // @ts-expect-error — jsdom global has eval
  window.eval(pageScript);
  return {
    window: window as JSDOM['window'],
    fetchCalls,
    runRefreshInterval: () => {
      const handler = intervalHandlers[0];
      if (typeof handler === 'function') handler();
    },
  };
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function abortError(): Error {
  const error = new Error('request aborted');
  error.name = 'AbortError';
  return error;
}
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

let subSequence = 0;
function testSubscriberId(sequence: number): string {
  return 'sub_00000000-0000-4000-8000-' + String(sequence).padStart(12, '0');
}

function mkSub(over: Partial<Sub> = {}): Sub {
  subSequence += 1;
  return {
    id: testSubscriberId(subSequence),
    email: 'watcher-' + subSequence.toString() + '@example.com',
    created_at: '2026-05-20T10:00:00.000Z',
    confirmed_at: '2026-05-20T10:05:00.000Z',
    unsubscribed_at: null,
    ...over,
  };
}

function mkSubs(count: number, prefix = 'page'): Sub[] {
  return Array.from({ length: count }, (_, index) =>
    mkSub({
      email: `${prefix}-${index.toString().padStart(3, '0')}@example.com`,
    }),
  );
}

function makeRouter(subs: Sub[]): (c: MockFetchCall) => Response {
  return (call: MockFetchCall): Response => {
    const method = (call.init?.method || 'GET').toUpperCase();
    const url = new URL(call.url, PAGE_URL);
    const fu = url.pathname.match(/\/v1\/admin\/status-subscribers\/([^/]+)\/force-unsubscribe$/);
    if (fu && method === 'POST') {
      const s = subs.find((x) => x.id === fu[1]);
      if (s) s.unsubscribed_at = '2026-05-29T12:00:00.000Z';
      // V-1501 — the shape the server actually sends. This double used to answer
      // `{ ok: true }`, copied from a published schema no handler has ever
      // satisfied; the page ignores the body either way, but a double written
      // from the document is how the document's fiction stays alive.
      return json({ message: 'Subscriber force-unsubscribed.', email: s ? s.email : null });
    }
    if (url.pathname === '/v1/admin/status-subscribers' && method === 'GET') {
      const offset = Number(url.searchParams.get('offset') || '0');
      const limit = Number(url.searchParams.get('limit') || '50');
      return json({ data: subs.slice(offset, offset + limit) });
    }
    return json({}, 404);
  };
}

describe('admin status-subscribers page — force-unsubscribe (operator)', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
    subSequence = 0;
  });
  const loadBuiltPage = (): string => readFileSync(BUILT_PAGE, 'utf8');

  it('renders: an active subscriber gets Force-unsubscribe; an already-unsubscribed one does not', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: makeRouter([
        mkSub({ id: 'sub_00000000-0000-4000-8000-000000001001', unsubscribed_at: null }),
        mkSub({
          id: 'sub_00000000-0000-4000-8000-000000001002',
          unsubscribed_at: '2026-05-01T10:00:00.000Z',
        }),
      ]),
    });
    win = window;
    await flush();
    expect(
      window.document.querySelector(
        '[data-force-unsub="sub_00000000-0000-4000-8000-000000001001"]',
      ),
    ).toBeTruthy();
    expect(
      window.document.querySelector(
        '[data-force-unsub="sub_00000000-0000-4000-8000-000000001002"]',
      ),
    ).toBeNull();
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toContain('/v1/admin/status-subscribers?limit=51&offset=0');
    expect(fetchCalls[0]?.init?.signal).toBeInstanceOf(window.AbortSignal);
  });

  it('requests a 51-row lookahead, renders 50, and derives Previous/Next only from offset and the sentinel', async () => {
    const subscribers = mkSubs(51, 'lookahead');
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: makeRouter(subscribers),
    });
    win = window;
    await flush();

    const previous = window.document.querySelector('[data-page-previous]') as HTMLButtonElement;
    const next = window.document.querySelector('[data-page-next]') as HTMLButtonElement;
    expect(fetchCalls[0]?.url).toContain('?limit=51&offset=0');
    expect(window.document.querySelectorAll('[data-subscriber-id]')).toHaveLength(50);
    expect(
      window.document.querySelector(`[data-subscriber-id="${subscribers[50]!.id}"]`),
    ).toBeNull();
    expect(previous.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    expect(window.document.querySelector('[data-page-status]')?.textContent).toContain('Page 1');

    next.click();
    await flush();

    expect(fetchCalls[1]?.url).toContain('?limit=51&offset=50');
    expect(window.document.querySelectorAll('[data-subscriber-id]')).toHaveLength(1);
    expect(
      window.document.querySelector(`[data-subscriber-id="${subscribers[50]!.id}"]`),
    ).toBeTruthy();
    expect(previous.disabled).toBe(false);
    expect(next.disabled).toBe(true);
    expect(window.document.querySelector('[data-page-status]')?.textContent).toContain('Page 2');
  });

  it('does not offer Next when the first page contains exactly 50 rows', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      route: makeRouter(mkSubs(50, 'exact')),
    });
    win = window;
    await flush();

    expect(window.document.querySelectorAll('[data-subscriber-id]')).toHaveLength(50);
    expect(
      (window.document.querySelector('[data-page-previous]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((window.document.querySelector('[data-page-next]') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it.each([
    ['a missing data field', () => ({})],
    [
      'a malformed subscriber row',
      () => ({
        data: [{ ...mkSub(), created_at: 'not-an-iso-timestamp' }],
      }),
    ],
  ])('fails closed when the initial response contains %s', async (_label, payload) => {
    const { window } = setUpDom(loadBuiltPage(), {
      route: () => json(payload()),
    });
    win = window;
    await flush();

    expect(window.document.querySelector('[data-subscriber-id]')).toBeNull();
    expect(window.document.querySelector('[data-list]')?.textContent).toContain(
      'Could not load the current subscriber list',
    );
    expect(window.document.querySelector('[data-page-status]')?.textContent).toContain(
      'Page unavailable',
    );
    expect(window.document.querySelector('[data-banner]')?.textContent).toContain(
      'Invalid subscriber list response',
    );
    expect((window.document.querySelector('#add-email') as HTMLInputElement).disabled).toBe(true);
  });

  it('validates the malformed 51st sentinel before rendering the first 50 rows', async () => {
    const subscribers = mkSubs(51, 'sentinel-invalid');
    subscribers[50] = {
      ...subscribers[50]!,
      email: null,
      unsubscribed_at: null,
    };
    const { window } = setUpDom(loadBuiltPage(), {
      route: () => json({ data: subscribers }),
    });
    win = window;
    await flush();

    expect(window.document.querySelectorAll('[data-subscriber-id]')).toHaveLength(0);
    expect(window.document.querySelector('[data-page-status]')?.textContent).toContain(
      'Page unavailable',
    );
    expect(window.document.querySelector('[data-banner]')?.textContent).toContain(
      'Invalid subscriber list response',
    );
  });

  it('preserves the authoritative page and retries its exact next offset after a malformed page', async () => {
    const firstPage = mkSubs(51, 'valid-first');
    const secondPage = [mkSub({ email: 'valid-second@example.com' })];
    let secondPageAttempts = 0;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route(call) {
        const offset = Number(new URL(call.url, PAGE_URL).searchParams.get('offset') || '0');
        if (offset === 0) return json({ data: firstPage });
        secondPageAttempts += 1;
        if (secondPageAttempts === 1) {
          return json({ data: [{ ...secondPage[0]!, id: 'sub_wrong-shape' }] });
        }
        return json({ data: secondPage });
      },
    });
    win = window;
    await flush();

    const firstId = firstPage[0]!.id;
    const next = window.document.querySelector('[data-page-next]') as HTMLButtonElement;
    next.click();
    await flush();

    expect(window.document.querySelector(`[data-subscriber-id="${firstId}"]`)).toBeTruthy();
    expect(window.document.querySelector('[data-page-status]')?.textContent).toContain('Page 1');
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /failed to refresh subscribers.*invalid subscriber list response.*previous page and action status are unchanged/i,
    );
    expect(next.disabled).toBe(false);

    next.click();
    await flush();

    expect(
      fetchCalls.filter((call) => new URL(call.url, PAGE_URL).searchParams.get('offset') === '50'),
    ).toHaveLength(2);
    expect(
      window.document.querySelector(`[data-subscriber-id="${secondPage[0]!.id}"]`),
    ).toBeTruthy();
    expect(window.document.querySelector('[data-page-status]')?.textContent).toContain('Page 2');
  });

  it('keeps the synchronous requested offset across a superseding poll and ignores the late page response', async () => {
    const firstPage = mkSubs(51, 'first');
    const secondPage = [
      mkSub({ id: 'sub_00000000-0000-4000-8000-000000001003', email: 'current@example.com' }),
    ];
    let resolveNavigation: ((response: Response) => void) | undefined;
    const pendingNavigation = new Promise<Response>((resolve) => {
      resolveNavigation = resolve;
    });
    let reads = 0;
    const { window, fetchCalls, runRefreshInterval } = setUpDom(loadBuiltPage(), {
      route: () => {
        reads += 1;
        if (reads === 1) return json({ data: firstPage });
        if (reads === 2) return pendingNavigation;
        return json({ data: secondPage });
      },
    });
    win = window;
    await flush();

    (window.document.querySelector('[data-page-next]') as HTMLButtonElement).click();
    await flush(1);
    expect(fetchCalls[1]?.url).toContain('?limit=51&offset=50');

    runRefreshInterval();
    await flush();
    expect(fetchCalls[2]?.url).toContain('?limit=51&offset=50');
    expect((fetchCalls[1]?.init?.signal as AbortSignal).aborted).toBe(true);
    expect(
      window.document.querySelector(
        '[data-subscriber-id="sub_00000000-0000-4000-8000-000000001003"]',
      ),
    ).toBeTruthy();
    expect(window.document.querySelector('[data-page-status]')?.textContent).toContain('Page 2');

    resolveNavigation?.(
      json({
        data: [
          mkSub({ id: 'sub_00000000-0000-4000-8000-000000001004', email: 'stale@example.com' }),
        ],
      }),
    );
    await flush();
    expect(
      window.document.querySelector(
        '[data-subscriber-id="sub_00000000-0000-4000-8000-000000001003"]',
      ),
    ).toBeTruthy();
    expect(
      window.document.querySelector(
        '[data-subscriber-id="sub_00000000-0000-4000-8000-000000001004"]',
      ),
    ).toBeNull();
  });

  it('force-unsub: confirm-gated POST /:id/force-unsubscribe, then refresh drops the action', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      confirmReturns: true,
      route: makeRouter([
        mkSub({ id: 'sub_00000000-0000-4000-8000-000000001001', unsubscribed_at: null }),
      ]),
    });
    win = window;
    await flush();
    const button = window.document.querySelector(
      '[data-force-unsub="sub_00000000-0000-4000-8000-000000001001"]',
    ) as HTMLButtonElement;
    button.click();
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    await flush();
    const posts = fetchCalls.filter(
      (c) =>
        c.init?.method === 'POST' &&
        /\/v1\/admin\/status-subscribers\/sub_00000000-0000-4000-8000-000000001001\/force-unsubscribe$/.test(
          c.url,
        ),
    );
    const post = posts[0];
    expect(post).toBeTruthy();
    expect(posts).toHaveLength(1);
    expect(post?.init?.signal).toBeInstanceOf(window.AbortSignal);
    // After refresh the sub is unsubscribed → its row shows "no action".
    expect(
      window.document.querySelector(
        '[data-force-unsub="sub_00000000-0000-4000-8000-000000001001"]',
      ),
    ).toBeNull();
  });

  it('treats a malformed accepted unsubscribe body as committed and never offers a replay', async () => {
    const subscribers = [
      mkSub({ id: 'sub_00000000-0000-4000-8000-000000001001', unsubscribed_at: null }),
      mkSub({ id: 'sub_00000000-0000-4000-8000-000000001005', unsubscribed_at: null }),
    ];
    const fallback = makeRouter(subscribers);
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (
          call.init?.method === 'POST' &&
          /\/sub_00000000-0000-4000-8000-000000001001\/force-unsubscribe$/.test(call.url)
        ) {
          subscribers[0]!.unsubscribed_at = '2026-05-29T12:00:00.000Z';
          return new Response('{', {
            status: 200,
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
        '[data-force-unsub="sub_00000000-0000-4000-8000-000000001001"]',
      ) as HTMLButtonElement
    ).click();
    await flush();

    expect(
      fetchCalls.filter(
        (call) =>
          call.init?.method === 'POST' &&
          /\/sub_00000000-0000-4000-8000-000000001001\/force-unsubscribe$/.test(call.url),
      ),
    ).toHaveLength(1);
    expect(
      window.document.querySelector(
        '[data-force-unsub="sub_00000000-0000-4000-8000-000000001001"]',
      ),
    ).toBeNull();
    expect(
      window.document.querySelector(
        '[data-force-unsub="sub_00000000-0000-4000-8000-000000001005"]',
      ),
    ).toBeTruthy();
    expect(window.document.querySelector('[data-banner]')?.textContent).not.toMatch(
      /force-unsubscribe failed|couldn't unsubscribe/i,
    );
  });

  it('keeps an accepted force-unsubscribe latched when the immediate row read is still active', async () => {
    const subscriber = mkSub({
      id: 'sub_00000000-0000-4000-8000-000000001006',
      unsubscribed_at: null,
    });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (call.init?.method === 'POST') return json({ message: 'accepted' });
        return json({ data: [subscriber] });
      },
    });
    win = window;
    await flush();

    (
      window.document.querySelector(
        '[data-force-unsub="sub_00000000-0000-4000-8000-000000001006"]',
      ) as HTMLButtonElement
    ).click();
    await flush();
    const replacement = window.document.querySelector(
      '[data-force-unsub="sub_00000000-0000-4000-8000-000000001006"]',
    ) as HTMLButtonElement;
    expect(replacement.disabled).toBe(true);
    expect(replacement.textContent).toBe('Check status');
    replacement.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flush(2);
    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
  });

  it('preserves a committed unsubscribe latch when its reconciliation page is malformed', async () => {
    const subscriber = mkSub({
      id: testSubscriberId(1_030),
      email: 'committed-refresh@example.com',
      unsubscribed_at: null,
    });
    let reads = 0;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (call.init?.method === 'POST') return json({ message: 'accepted' });
        reads += 1;
        return reads === 1
          ? json({ data: [subscriber] })
          : json({ data: [{ ...subscriber, confirmed_at: 'invalid' }] });
      },
    });
    win = window;
    await flush();

    (
      window.document.querySelector(`[data-force-unsub="${subscriber.id}"]`) as HTMLButtonElement
    ).click();
    await flush();

    const retained = window.document.querySelector(
      `[data-force-unsub="${subscriber.id}"]`,
    ) as HTMLButtonElement;
    expect(retained).toBeTruthy();
    expect(retained.disabled).toBe(true);
    expect(retained.textContent).toBe('Check status');
    expect(window.document.querySelector('[data-page-status]')?.textContent).toContain('Page 1');
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /failed to refresh subscribers.*invalid subscriber list response.*action status are unchanged/i,
    );

    retained.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flush(2);
    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
  });

  it('keeps the owned row busy, blocks refresh, and rejects a forced second unsubscribe', async () => {
    const subscribers = [
      mkSub({ id: 'sub_00000000-0000-4000-8000-000000001001', unsubscribed_at: null }),
      ...mkSubs(50, 'mutation-lock'),
    ];
    let finishPost: (response: Response) => void = () => {};
    const pendingPost = new Promise<Response>((resolve) => {
      finishPost = resolve;
    });
    const fallback = makeRouter(subscribers);
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => (call.init?.method === 'POST' ? pendingPost : fallback(call)),
    });
    win = window;
    await flush();

    const original = window.document.querySelector(
      '[data-force-unsub="sub_00000000-0000-4000-8000-000000001001"]',
    ) as HTMLButtonElement;
    expect((window.document.querySelector('[data-page-next]') as HTMLButtonElement).disabled).toBe(
      false,
    );
    original.click();
    await flush(2);
    expect((window.document.querySelector('[data-page-next]') as HTMLButtonElement).disabled).toBe(
      true,
    );
    const refresh = window.document.querySelector('[data-live-refresh]') as HTMLButtonElement;
    const callsBeforeRefresh = fetchCalls.length;
    expect(refresh.disabled).toBe(true);
    refresh.click();
    await flush();

    const replacement = window.document.querySelector(
      '[data-force-unsub="sub_00000000-0000-4000-8000-000000001001"]',
    ) as HTMLButtonElement;
    expect(fetchCalls).toHaveLength(callsBeforeRefresh);
    expect(replacement).toBe(original);
    expect(replacement.disabled).toBe(true);
    expect(replacement.getAttribute('aria-busy')).toBe('true');
    expect(replacement.textContent).toBe('Unsubscribing…');
    expect((window.document.querySelector('[data-page-next]') as HTMLButtonElement).disabled).toBe(
      true,
    );
    replacement.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flush(2);
    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);

    subscribers[0]!.unsubscribed_at = '2026-05-29T12:00:00.000Z';
    finishPost(json({ ok: true }));
    await flush();
    expect(
      window.document.querySelector(
        '[data-force-unsub="sub_00000000-0000-4000-8000-000000001001"]',
      ),
    ).toBeNull();
    expect((window.document.querySelector('[data-page-next]') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('reconciles an accepted force-unsubscribe on its originating page', async () => {
    const subscribers = mkSubs(51, 'origin');
    const target = subscribers[50]!;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: makeRouter(subscribers),
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-page-next]') as HTMLButtonElement).click();
    await flush();

    (
      window.document.querySelector(`[data-force-unsub="${target.id}"]`) as HTMLButtonElement
    ).click();
    await flush();

    const reads = fetchCalls.filter(
      (call) => !call.init?.method || call.init.method.toUpperCase() === 'GET',
    );
    expect(reads.at(-1)?.url).toContain('?limit=51&offset=50');
    expect(window.document.querySelector('[data-page-status]')?.textContent).toContain('Page 2');
    expect(window.document.querySelector(`[data-subscriber-id="${target.id}"]`)).toBeTruthy();
    expect(window.document.querySelector(`[data-force-unsub="${target.id}"]`)).toBeNull();
  });

  it('force-unsub timeout verifies completion only from the exact returned row id and unsubscribed_at', async () => {
    const subscriber = mkSub({
      id: 'sub_00000000-0000-4000-8000-000000001007',
      unsubscribed_at: null,
    });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      confirmReturns: true,
      route: (call) => {
        if (
          call.init?.method === 'POST' &&
          /\/sub_00000000-0000-4000-8000-000000001007\/force-unsubscribe$/.test(call.url)
        ) {
          subscriber.unsubscribed_at = '2026-05-29T12:00:00.000Z';
          return Promise.reject(abortError());
        }
        return json({ data: [subscriber] });
      },
    });
    win = window;
    await flush();
    const button = window.document.querySelector(
      '[data-force-unsub="sub_00000000-0000-4000-8000-000000001007"]',
    ) as HTMLButtonElement;
    button.click();
    await flush();
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flush();

    expect(
      fetchCalls.filter(
        (call) => call.init?.method === 'POST' && /\/force-unsubscribe$/.test(call.url),
      ),
    ).toHaveLength(1);
    expect(
      window.document.querySelector(
        '[data-force-unsub="sub_00000000-0000-4000-8000-000000001007"]',
      ),
    ).toBeNull();
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /outcome was verified.*exact subscriber row.*is now unsubscribed.*confirming completion.*do not submit it again/i,
    );
    expect(window.document.querySelector('[data-banner]')?.textContent).not.toMatch(
      /likely completed/i,
    );
  });

  it('force-unsub timeout keeps the exact active row latched without claiming completion', async () => {
    const subscriber = mkSub({
      id: 'sub_00000000-0000-4000-8000-000000001008',
      email: 'active-timeout@example.com',
      unsubscribed_at: null,
    });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (
          call.init?.method === 'POST' &&
          /\/sub_00000000-0000-4000-8000-000000001008\/force-unsubscribe$/.test(call.url)
        ) {
          return Promise.reject(abortError());
        }
        return json({ data: [subscriber] });
      },
    });
    win = window;
    await flush();
    (
      window.document.querySelector(
        '[data-force-unsub="sub_00000000-0000-4000-8000-000000001008"]',
      ) as HTMLButtonElement
    ).click();
    await flush();

    const replacement = window.document.querySelector(
      '[data-force-unsub="sub_00000000-0000-4000-8000-000000001008"]',
    ) as HTMLButtonElement;
    expect(replacement.disabled).toBe(true);
    expect(replacement.textContent).toBe('Check status');
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /outcome is unknown.*exact subscriber row.*still active.*completion may be delayed/i,
    );
    expect(window.document.querySelector('[data-banner]')?.textContent).not.toMatch(
      /likely completed/i,
    );
    replacement.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flush(2);
    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
  });

  it('treats a post-commit force-unsubscribe 5xx as outcome-unknown and verifies the exact row', async () => {
    const subscriber = mkSub({
      id: 'sub_00000000-0000-4000-8000-000000001009',
      email: 'server-error@example.com',
      unsubscribed_at: null,
    });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (
          call.init?.method === 'POST' &&
          /\/sub_00000000-0000-4000-8000-000000001009\/force-unsubscribe$/.test(call.url)
        ) {
          subscriber.unsubscribed_at = '2026-05-29T12:00:00.000Z';
          return json({ type: 'https://errors.driftstack.dev/internal' }, 500);
        }
        return json({ data: [subscriber] });
      },
    });
    win = window;
    await flush();

    (
      window.document.querySelector(
        '[data-force-unsub="sub_00000000-0000-4000-8000-000000001009"]',
      ) as HTMLButtonElement
    ).click();
    await flush();

    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
    expect(
      window.document.querySelector(
        '[data-force-unsub="sub_00000000-0000-4000-8000-000000001009"]',
      ),
    ).toBeNull();
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /outcome was verified.*server error.*exact subscriber row.*is now unsubscribed/i,
    );
  });

  it('does not let the live poll or Refresh supersede an in-flight mutation reconciliation', async () => {
    const subscriber = mkSub({
      id: 'sub_00000000-0000-4000-8000-000000001010',
      unsubscribed_at: null,
    });
    let resolveReconciliation: ((response: Response) => void) | undefined;
    const reconciliation = new Promise<Response>((resolve) => {
      resolveReconciliation = resolve;
    });
    let reads = 0;
    const { window, fetchCalls, runRefreshInterval } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (call.init?.method === 'POST') {
          subscriber.unsubscribed_at = '2026-05-29T12:00:00.000Z';
          return json({ ok: true });
        }
        reads += 1;
        return reads === 1 ? json({ data: [subscriber] }) : reconciliation;
      },
    });
    win = window;
    await flush();

    (
      window.document.querySelector(
        '[data-force-unsub="sub_00000000-0000-4000-8000-000000001010"]',
      ) as HTMLButtonElement
    ).click();
    await flush(2);
    const beforePoll = fetchCalls.length;
    const refresh = window.document.querySelector('[data-live-refresh]') as HTMLButtonElement;
    expect(refresh.disabled).toBe(true);
    refresh.click();
    runRefreshInterval();
    await flush(2);
    expect(fetchCalls).toHaveLength(beforePoll);

    resolveReconciliation?.(json({ data: [subscriber] }));
    await flush();
    expect(refresh.disabled).toBe(false);
    expect(
      window.document.querySelector(
        '[data-force-unsub="sub_00000000-0000-4000-8000-000000001010"]',
      ),
    ).toBeNull();
  });

  it('treats a timeout target shifted beyond the 51-row slice as unverified, never likely completed', async () => {
    const subscribers = mkSubs(50, 'shift');
    const target = subscribers[49]!;
    const fallback = makeRouter(subscribers);
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (call.init?.method === 'POST' && call.url.endsWith(`/${target.id}/force-unsubscribe`)) {
          subscribers.unshift(
            mkSub({
              id: 'sub_00000000-0000-4000-8000-000000001011',
              email: 'inserted-1@example.com',
            }),
            mkSub({
              id: 'sub_00000000-0000-4000-8000-000000001012',
              email: 'inserted-2@example.com',
            }),
          );
          return Promise.reject(abortError());
        }
        return fallback(call);
      },
    });
    win = window;
    await flush();
    (
      window.document.querySelector(`[data-force-unsub="${target.id}"]`) as HTMLButtonElement
    ).click();
    await flush();

    expect(fetchCalls.at(-1)?.url).toContain('?limit=51&offset=0');
    expect(window.document.querySelector(`[data-subscriber-id="${target.id}"]`)).toBeNull();
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /outcome is unverified.*exact subscriber row.*absent from the refreshed page slice.*absence.*is not evidence/i,
    );
    expect(window.document.querySelector('[data-banner]')?.textContent).not.toMatch(
      /likely completed/i,
    );
  });

  it('force-unsub cancelled: no POST fired, the action stays', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      confirmReturns: false,
      route: makeRouter([
        mkSub({ id: 'sub_00000000-0000-4000-8000-000000001001', unsubscribed_at: null }),
      ]),
    });
    win = window;
    await flush();
    (
      window.document.querySelector(
        '[data-force-unsub="sub_00000000-0000-4000-8000-000000001001"]',
      ) as HTMLButtonElement
    ).click();
    await flush();
    expect(fetchCalls.some((c) => c.init?.method === 'POST')).toBe(false);
    expect(
      window.document.querySelector(
        '[data-force-unsub="sub_00000000-0000-4000-8000-000000001001"]',
      ),
    ).toBeTruthy();
  });

  it('force-subscribe form is single-flight, signaled, and restores its busy state', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (call.init?.method === 'POST' && /\/force-subscribe$/.test(call.url)) {
          return json(
            {
              id: 'sub_00000000-0000-4000-8000-000000001013',
              email: 'new@example.com',
              unsubscribe_link: 'https://status.driftstack.dev/unsubscribe/token',
            },
            201,
          );
        }
        return json({ data: [] });
      },
    });
    win = window;
    await flush();
    const form = window.document.querySelector('[data-add-form]') as HTMLFormElement;
    const email = window.document.querySelector('#add-email') as HTMLInputElement;
    email.value = 'new@example.com';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    const posts = fetchCalls.filter(
      (call) => call.init?.method === 'POST' && /\/force-subscribe$/.test(call.url),
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]?.init?.signal).toBeInstanceOf(window.AbortSignal);
    expect(form.hasAttribute('aria-busy')).toBe(false);
    expect((form.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('force-subscribe from an older page refreshes and commits the first page', async () => {
    const subscribers = mkSubs(51, 'add-origin');
    const added = mkSub({
      id: 'sub_00000000-0000-4000-8000-000000001014',
      email: 'new-first@example.com',
    });
    const fallback = makeRouter(subscribers);
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (call.init?.method === 'POST' && /\/force-subscribe$/.test(call.url)) {
          subscribers.unshift(added);
          return json(
            {
              id: added.id,
              email: added.email,
              unsubscribe_link: 'https://status.driftstack.dev/unsubscribe/new-first',
            },
            201,
          );
        }
        return fallback(call);
      },
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-page-next]') as HTMLButtonElement).click();
    await flush();
    expect(window.document.querySelector('[data-page-status]')?.textContent).toContain('Page 2');

    const form = window.document.querySelector('[data-add-form]') as HTMLFormElement;
    const input = window.document.querySelector('#add-email') as HTMLInputElement;
    input.value = 'new-first@example.com';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    const reads = fetchCalls.filter(
      (call) => !call.init?.method || call.init.method.toUpperCase() === 'GET',
    );
    expect(reads.at(-1)?.url).toContain('?limit=51&offset=0');
    expect(window.document.querySelector('[data-page-status]')?.textContent).toContain('Page 1');
    expect(
      window.document.querySelector(
        '[data-subscriber-id="sub_00000000-0000-4000-8000-000000001014"]',
      ),
    ).toBeTruthy();
  });

  it.each([
    [
      'malformed JSON',
      () =>
        new Response('{', {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
    ],
    [
      'shape-invalid JSON',
      () =>
        json(
          { id: 'sub_00000000-0000-4000-8000-000000001015', email: 'committed@example.com' },
          201,
        ),
    ],
  ])(
    'treats a committed 201 with %s as details-unavailable and blocks replay',
    async (_label, acceptedResponse) => {
      const subscribers = mkSubs(51, 'committed');
      const committed = mkSub({
        id: 'sub_00000000-0000-4000-8000-000000001015',
        email: 'committed@example.com',
      });
      const fallback = makeRouter(subscribers);
      const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
        route: (call) => {
          if (call.init?.method === 'POST' && /\/force-subscribe$/.test(call.url)) {
            subscribers.unshift(committed);
            return acceptedResponse();
          }
          return fallback(call);
        },
      });
      win = window;
      await flush();
      (window.document.querySelector('[data-page-next]') as HTMLButtonElement).click();
      await flush();

      const form = window.document.querySelector('[data-add-form]') as HTMLFormElement;
      const input = window.document.querySelector('#add-email') as HTMLInputElement;
      input.value = 'committed@example.com';
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      input.value = 'committed@example.com';
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await flush(2);

      expect(
        fetchCalls.filter(
          (call) => call.init?.method === 'POST' && /\/force-subscribe$/.test(call.url),
        ),
      ).toHaveLength(1);
      expect(fetchCalls.at(-1)?.url).toContain('?limit=51&offset=0');
      expect(
        window.document.querySelector(
          '[data-subscriber-id="sub_00000000-0000-4000-8000-000000001015"]',
        ),
      ).toBeTruthy();
      expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
        /add subscriber committed.*result details are unavailable.*do not submit committed@example\.com again/i,
      );
      const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
      expect(submit.textContent).toBe('Added — verify');
    },
  );

  it('force-subscribe timeout reconciles the list and blocks unrecoverable-link replay', async () => {
    const subscribers: Sub[] = [];
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (call.init?.method === 'POST' && /\/force-subscribe$/.test(call.url)) {
          subscribers.push(
            mkSub({ id: 'sub_00000000-0000-4000-8000-000000001016', email: 'new@example.com' }),
          );
          return Promise.reject(abortError());
        }
        return json({ data: subscribers });
      },
    });
    win = window;
    await flush();
    const form = window.document.querySelector('[data-add-form]') as HTMLFormElement;
    const email = window.document.querySelector('#add-email') as HTMLInputElement;
    email.value = 'new@example.com';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(
      fetchCalls.filter(
        (call) => call.init?.method === 'POST' && /\/force-subscribe$/.test(call.url),
      ),
    ).toHaveLength(1);
    expect(window.document.querySelector('[data-list]')?.textContent).toContain('new@example.com');
    const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toBe('Check status');
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /outcome is unknown.*first subscriber page now contains.*likely completed.*unsubscribe link cannot be recovered.*do not submit it again/i,
    );
  });

  it('treats a force-subscribe 5xx after persistence as outcome-unknown and blocks replay', async () => {
    const subscribers: Sub[] = [];
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (call.init?.method === 'POST' && /\/force-subscribe$/.test(call.url)) {
          subscribers.push(
            mkSub({
              id: 'sub_00000000-0000-4000-8000-000000001017',
              email: 'server500@example.com',
            }),
          );
          return json({ type: 'https://errors.driftstack.dev/internal' }, 500);
        }
        return json({ data: subscribers });
      },
    });
    win = window;
    await flush();
    const form = window.document.querySelector('[data-add-form]') as HTMLFormElement;
    const input = window.document.querySelector('#add-email') as HTMLInputElement;
    input.value = 'server500@example.com';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(2);

    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
    expect(
      window.document.querySelector(
        '[data-subscriber-id="sub_00000000-0000-4000-8000-000000001017"]',
      ),
    ).toBeTruthy();
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /outcome is unknown.*server error.*first subscriber page now contains.*likely completed/i,
    );
    expect((form.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('treats absence from the first page after an add timeout as unverified and blocks replay', async () => {
    const subscribers = mkSubs(60, 'older-add');
    subscribers[55]!.email = 'older-restored@example.com';
    const fallback = makeRouter(subscribers);
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (call.init?.method === 'POST' && /\/force-subscribe$/.test(call.url)) {
          return Promise.reject(abortError());
        }
        return fallback(call);
      },
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-page-next]') as HTMLButtonElement).click();
    await flush();

    const form = window.document.querySelector('[data-add-form]') as HTMLFormElement;
    const input = window.document.querySelector('#add-email') as HTMLInputElement;
    input.value = 'older-restored@example.com';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    input.value = 'older-restored@example.com';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(2);

    expect(fetchCalls.at(-1)?.url).toContain('?limit=51&offset=0');
    expect(window.document.querySelector('[data-page-status]')?.textContent).toContain('Page 1');
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /outcome is unverified.*first subscriber page does not contain.*absence from that page is not evidence/i,
    );
    expect(window.document.querySelector('[data-banner]')?.textContent).not.toMatch(
      /likely completed/i,
    );
    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
    expect((form.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps a null-email tombstone with no action beside a newly added active row', async () => {
    const tombstone = mkSub({
      id: 'sub_00000000-0000-4000-8000-000000001021',
      email: null,
      unsubscribed_at: '2026-02-01T00:00:00.000Z',
    });
    const subscribers = [...mkSubs(50, 'tombstone-page'), tombstone];
    const active = mkSub({
      id: 'sub_00000000-0000-4000-8000-000000001022',
      email: 'restored@example.com',
    });
    const fallback = makeRouter(subscribers);
    const { window } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (call.init?.method === 'POST' && /\/force-subscribe$/.test(call.url)) {
          subscribers.unshift(active);
          return json(
            {
              id: active.id,
              email: active.email,
              unsubscribe_link: 'https://status.driftstack.dev/unsubscribe/restored',
            },
            201,
          );
        }
        return fallback(call);
      },
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-page-next]') as HTMLButtonElement).click();
    await flush();

    const initialTombstone = window.document.querySelector(
      '[data-subscriber-id="sub_00000000-0000-4000-8000-000000001021"]',
    ) as HTMLElement;
    expect(initialTombstone.textContent).toContain('(purged after retention period)');
    expect(initialTombstone.querySelector('[data-force-unsub]')).toBeNull();

    const form = window.document.querySelector('[data-add-form]') as HTMLFormElement;
    const input = window.document.querySelector('#add-email') as HTMLInputElement;
    input.value = 'restored@example.com';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(
      window.document.querySelector(
        '[data-subscriber-id="sub_00000000-0000-4000-8000-000000001022"]',
      ),
    ).toBeTruthy();
    expect(
      window.document.querySelector(
        '[data-force-unsub="sub_00000000-0000-4000-8000-000000001022"]',
      ),
    ).toBeTruthy();

    (window.document.querySelector('[data-page-next]') as HTMLButtonElement).click();
    await flush();
    const retainedTombstone = window.document.querySelector(
      '[data-subscriber-id="sub_00000000-0000-4000-8000-000000001021"]',
    ) as HTMLElement;
    expect(retainedTombstone).toBeTruthy();
    expect(retainedTombstone.textContent).toContain('(purged after retention period)');
    expect(retainedTombstone.querySelector('[data-force-unsub]')).toBeNull();
  });

  it('a newer refresh supersedes a late older response', async () => {
    let resolveInitial: ((response: Response) => void) | undefined;
    const initial = new Promise<Response>((resolve) => {
      resolveInitial = resolve;
    });
    let reads = 0;
    const { window, fetchCalls, runRefreshInterval } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (call.init?.method && call.init.method !== 'GET') return json({}, 404);
        reads += 1;
        if (reads === 1) return initial;
        return json({
          data: [
            mkSub({ id: 'sub_00000000-0000-4000-8000-000000001019', email: 'newest@example.com' }),
          ],
        });
      },
    });
    win = window;

    await flush(1);
    runRefreshInterval();
    await flush();
    expect(fetchCalls).toHaveLength(2);
    expect((fetchCalls[0]?.init?.signal as AbortSignal).aborted).toBe(true);
    expect(
      window.document.querySelector(
        '[data-force-unsub="sub_00000000-0000-4000-8000-000000001019"]',
      ),
    ).toBeTruthy();

    resolveInitial?.(
      json({
        data: [
          mkSub({ id: 'sub_00000000-0000-4000-8000-000000001020', email: 'stale@example.com' }),
        ],
      }),
    );
    await flush();

    expect(
      window.document.querySelector(
        '[data-force-unsub="sub_00000000-0000-4000-8000-000000001019"]',
      ),
    ).toBeTruthy();
    expect(
      window.document.querySelector(
        '[data-force-unsub="sub_00000000-0000-4000-8000-000000001020"]',
      ),
    ).toBeNull();
  });

  it('an intentionally superseded refresh cannot publish a false timeout banner', async () => {
    let rejectInitial: ((error: Error) => void) | undefined;
    const initial = new Promise<Response>((_resolve, reject) => {
      rejectInitial = reject;
    });
    let reads = 0;
    const { window, runRefreshInterval } = setUpDom(loadBuiltPage(), {
      route: () => {
        reads += 1;
        return reads === 1 ? initial : json({ data: [] });
      },
    });
    win = window;

    await flush(1);
    runRefreshInterval();
    await flush();
    rejectInitial?.(new window.DOMException('superseded', 'AbortError'));
    await flush();

    expect(window.document.querySelector('[data-banner]')?.classList.contains('hidden')).toBe(true);
  });

  it('pagehide aborts the owned refresh and suppresses its late completion', async () => {
    let resolveRead: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      resolveRead = resolve;
    });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), { route: () => pending });
    win = window;
    await flush(1);
    window.dispatchEvent(new window.Event('pagehide'));
    expect((fetchCalls[0]?.init?.signal as AbortSignal).aborted).toBe(true);

    resolveRead?.(json({ data: [mkSub({ id: 'sub_00000000-0000-4000-8000-000000001018' })] }));
    await flush();
    expect(
      window.document.querySelector(
        '[data-force-unsub="sub_00000000-0000-4000-8000-000000001018"]',
      ),
    ).toBeNull();
    expect(
      window.document.querySelector('[data-page="status-subscribers"]')?.hasAttribute('aria-busy'),
    ).toBe(false);
  });
});
