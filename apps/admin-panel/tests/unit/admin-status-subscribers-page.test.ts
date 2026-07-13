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
  window.localStorage.setItem('ds_web_session_token', 'staff-tok');
  const cr = opts.confirmReturns ?? true;
  // @ts-expect-error — driftstackConfirm is injected by AdminLayout
  window.driftstackConfirm = () => Promise.resolve(cr);

  const pageScript = scriptBodies.find((s) => s.includes('data-page="status-subscribers"'));
  if (!pageScript) throw new Error('admin status-subscribers inline script not found');
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
function abortError(): Error {
  const error = new Error('request aborted');
  error.name = 'AbortError';
  return error;
}
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

function mkSub(over: Partial<Sub> = {}): Sub {
  return {
    id: 'sub_' + Math.random().toString(36).slice(2, 8),
    email: 'watcher@example.com',
    created_at: '2026-05-20T10:00:00.000Z',
    confirmed_at: '2026-05-20T10:05:00.000Z',
    unsubscribed_at: null,
    ...over,
  };
}

function makeRouter(subs: Sub[]): (c: MockFetchCall) => Response {
  return (call: MockFetchCall): Response => {
    const method = (call.init?.method || 'GET').toUpperCase();
    const u = call.url.replace(/^https?:\/\/[^/]+/, '');
    const fu = u.match(/\/v1\/admin\/status-subscribers\/([^/]+)\/force-unsubscribe$/);
    if (fu && method === 'POST') {
      const s = subs.find((x) => x.id === fu[1]);
      if (s) s.unsubscribed_at = '2026-05-29T12:00:00.000Z';
      return json({ ok: true });
    }
    if (/\/v1\/admin\/status-subscribers(\?|$)/.test(u) && method === 'GET') {
      return json({ data: subs });
    }
    return json({}, 404);
  };
}

describe('admin status-subscribers page — force-unsubscribe (operator)', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });
  const loadBuiltPage = (): string => readFileSync(BUILT_PAGE, 'utf8');

  it('renders: an active subscriber gets Force-unsubscribe; an already-unsubscribed one does not', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: makeRouter([
        mkSub({ id: 'sub_active', unsubscribed_at: null }),
        mkSub({ id: 'sub_gone', unsubscribed_at: '2026-05-01T10:00:00.000Z' }),
      ]),
    });
    win = window;
    await flush();
    expect(window.document.querySelector('[data-force-unsub="sub_active"]')).toBeTruthy();
    expect(window.document.querySelector('[data-force-unsub="sub_gone"]')).toBeNull();
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.init?.signal).toBeInstanceOf(window.AbortSignal);
  });

  it('force-unsub: confirm-gated POST /:id/force-unsubscribe, then refresh drops the action', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      confirmReturns: true,
      route: makeRouter([mkSub({ id: 'sub_active', unsubscribed_at: null })]),
    });
    win = window;
    await flush();
    const button = window.document.querySelector(
      '[data-force-unsub="sub_active"]',
    ) as HTMLButtonElement;
    button.click();
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    await flush();
    const posts = fetchCalls.filter(
      (c) =>
        c.init?.method === 'POST' &&
        /\/v1\/admin\/status-subscribers\/sub_active\/force-unsubscribe$/.test(c.url),
    );
    const post = posts[0];
    expect(post).toBeTruthy();
    expect(posts).toHaveLength(1);
    expect(post?.init?.signal).toBeInstanceOf(window.AbortSignal);
    // After refresh the sub is unsubscribed → its row shows "no action".
    expect(window.document.querySelector('[data-force-unsub="sub_active"]')).toBeNull();
  });

  it('keeps a refreshed replacement row visibly busy and rejects a forced second unsubscribe', async () => {
    const subscribers = [mkSub({ id: 'sub_active', unsubscribed_at: null })];
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
      '[data-force-unsub="sub_active"]',
    ) as HTMLButtonElement;
    original.click();
    await flush(2);
    (window.document.querySelector('[data-live-refresh]') as HTMLButtonElement).click();
    await flush();

    const replacement = window.document.querySelector(
      '[data-force-unsub="sub_active"]',
    ) as HTMLButtonElement;
    expect(replacement).not.toBe(original);
    expect(replacement.disabled).toBe(true);
    expect(replacement.getAttribute('aria-busy')).toBe('true');
    expect(replacement.title).toMatch(/wait for the current force-unsubscribe/i);
    expect(replacement.textContent).toBe('Unsubscribe pending…');
    replacement.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flush(2);
    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);

    subscribers[0]!.unsubscribed_at = '2026-05-29T12:00:00.000Z';
    finishPost(json({ ok: true }));
    await flush();
    expect(window.document.querySelector('[data-force-unsub="sub_active"]')).toBeNull();
  });

  it('force-unsub timeout refreshes status and blocks replay after likely completion', async () => {
    const subscriber = mkSub({ id: 'sub_timeout', unsubscribed_at: null });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      confirmReturns: true,
      route: (call) => {
        if (call.init?.method === 'POST' && /\/sub_timeout\/force-unsubscribe$/.test(call.url)) {
          subscriber.unsubscribed_at = '2026-05-29T12:00:00.000Z';
          return Promise.reject(abortError());
        }
        return json({ data: [subscriber] });
      },
    });
    win = window;
    await flush();
    const button = window.document.querySelector(
      '[data-force-unsub="sub_timeout"]',
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
    expect(window.document.querySelector('[data-force-unsub="sub_timeout"]')).toBeNull();
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /outcome is unknown.*no longer shows.*active.*likely completed.*do not submit it again/i,
    );
  });

  it('force-unsub cancelled: no POST fired, the action stays', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      confirmReturns: false,
      route: makeRouter([mkSub({ id: 'sub_active', unsubscribed_at: null })]),
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-force-unsub="sub_active"]') as HTMLButtonElement).click();
    await flush();
    expect(fetchCalls.some((c) => c.init?.method === 'POST')).toBe(false);
    expect(window.document.querySelector('[data-force-unsub="sub_active"]')).toBeTruthy();
  });

  it('force-subscribe form is single-flight, signaled, and restores its busy state', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (call.init?.method === 'POST' && /\/force-subscribe$/.test(call.url)) {
          return json({
            id: 'sub_new',
            email: 'new@example.com',
            unsubscribe_link: 'https://status.driftstack.dev/unsubscribe/token',
          });
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

  it('force-subscribe timeout reconciles the list and blocks unrecoverable-link replay', async () => {
    const subscribers: Sub[] = [];
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (call.init?.method === 'POST' && /\/force-subscribe$/.test(call.url)) {
          subscribers.push(mkSub({ id: 'sub_added_unknown', email: 'new@example.com' }));
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
      /outcome is unknown.*list now contains.*likely completed.*unsubscribe link cannot be recovered.*do not submit it again/i,
    );
  });

  it('a newer refresh supersedes a late older response', async () => {
    let resolveInitial: ((response: Response) => void) | undefined;
    const initial = new Promise<Response>((resolve) => {
      resolveInitial = resolve;
    });
    let reads = 0;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (call.init?.method && call.init.method !== 'GET') return json({}, 404);
        reads += 1;
        if (reads === 1) return initial;
        return json({ data: [mkSub({ id: 'sub_newest', email: 'newest@example.com' })] });
      },
    });
    win = window;

    (window.document.querySelector('[data-live-refresh]') as HTMLButtonElement).click();
    await flush();
    expect(fetchCalls).toHaveLength(2);
    expect((fetchCalls[0]?.init?.signal as AbortSignal).aborted).toBe(true);
    expect(window.document.querySelector('[data-force-unsub="sub_newest"]')).toBeTruthy();

    resolveInitial?.(json({ data: [mkSub({ id: 'sub_stale', email: 'stale@example.com' })] }));
    await flush();

    expect(window.document.querySelector('[data-force-unsub="sub_newest"]')).toBeTruthy();
    expect(window.document.querySelector('[data-force-unsub="sub_stale"]')).toBeNull();
  });

  it('an intentionally superseded refresh cannot publish a false timeout banner', async () => {
    let rejectInitial: ((error: Error) => void) | undefined;
    const initial = new Promise<Response>((_resolve, reject) => {
      rejectInitial = reject;
    });
    let reads = 0;
    const { window } = setUpDom(loadBuiltPage(), {
      route: () => {
        reads += 1;
        return reads === 1 ? initial : json({ data: [] });
      },
    });
    win = window;

    (window.document.querySelector('[data-live-refresh]') as HTMLButtonElement).click();
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
    window.dispatchEvent(new window.Event('pagehide'));
    expect((fetchCalls[0]?.init?.signal as AbortSignal).aborted).toBe(true);

    resolveRead?.(json({ data: [mkSub({ id: 'sub_after_hide' })] }));
    await flush();
    expect(window.document.querySelector('[data-force-unsub="sub_after_hide"]')).toBeNull();
    expect(
      window.document.querySelector('[data-page="status-subscribers"]')?.hasAttribute('aria-busy'),
    ).toBe(false);
  });
});
