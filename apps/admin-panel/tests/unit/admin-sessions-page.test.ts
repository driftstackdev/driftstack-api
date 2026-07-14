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
import { afterEach, describe, expect, it } from 'vitest';
import { installAdminDeadline } from './admin-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'sessions', 'index.html');
const PAGE_URL = 'https://admin.driftstack.dev/sessions/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}
interface AdminSession {
  id: string;
  archetype: string;
  account_id: string;
  status: string;
}
interface SetUpOpts {
  token?: string | null;
  storageDenied?: boolean;
  promptReturns?: string | null;
  confirmReturns?: boolean;
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

  const pageScript = scriptBodies.find((s) => s.includes('data-page="admin-sessions"'));
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
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

function mkSession(over: Partial<AdminSession> = {}): AdminSession {
  return {
    id: 'agt_' + Math.random().toString(36).slice(2, 8),
    archetype: 'iphone16pro_ios18_7_safari26_4',
    account_id: 'acc_1',
    status: 'running',
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
      return json({ data: sessions });
    }
    return json({}, 404);
  };
}

describe('admin sessions page — force-destroy (operator)', () => {
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

  it('renders sessions: a running session gets Force-destroy; a destroyed one does not', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: makeRouter([
        mkSession({ id: 'agt_live', status: 'running' }),
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
      route: makeRouter([mkSession({ id: 'agt_live', status: 'running' })]),
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

  it('treats a malformed accepted destroy body as committed and never offers a replay', async () => {
    const sessions = [
      mkSession({ id: 'agt_live', status: 'running' }),
      mkSession({ id: 'agt_other', status: 'running' }),
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
      route: makeRouter([mkSession({ id: 'agt_live', status: 'running' })]),
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
      route: makeRouter([mkSession({ id: 'agt_live', status: 'running' })]),
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

  it('keeps a refreshed replacement row visibly busy and rejects a forced second destroy', async () => {
    const sessions = [mkSession({ id: 'agt_live', status: 'running' })];
    let finishPost: (response: Response) => void = () => {};
    const pendingPost = new Promise<Response>((resolve) => {
      finishPost = resolve;
    });
    const fallback = makeRouter(sessions);
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => (call.init?.method === 'POST' ? pendingPost : fallback(call)),
    });
    win = window;
    await flush();

    const original = window.document.querySelector(
      '[data-action="destroy"][data-id="agt_live"]',
    ) as HTMLButtonElement;
    original.click();
    await flush(2);
    (window.document.querySelector('[data-live-refresh]') as HTMLButtonElement).click();
    await flush();

    const replacement = window.document.querySelector(
      '[data-action="destroy"][data-id="agt_live"]',
    ) as HTMLButtonElement;
    expect(replacement).not.toBe(original);
    expect(replacement.disabled).toBe(true);
    expect(replacement.getAttribute('aria-busy')).toBe('true');
    expect(replacement.title).toMatch(/wait for the current force-destroy/i);
    expect(replacement.textContent).toBe('Destroy pending…');
    replacement.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flush(2);
    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);

    sessions[0]!.status = 'destroyed';
    finishPost(json({ ok: true }));
    await flush();
    expect(window.document.querySelector('[data-action="destroy"][data-id="agt_live"]')).toBeNull();
  });

  it('reconciles a committed force-destroy timeout before advising another attempt', async () => {
    const sessions = [mkSession({ id: 'agt_live', status: 'running' })];
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        const method = (call.init?.method || 'GET').toUpperCase();
        if (method === 'POST' && /\/v1\/admin\/sessions\/agt_live\/destroy$/.test(call.url)) {
          sessions[0]!.status = 'destroyed';
          return Promise.reject(timeout);
        }
        return makeRouter(sessions)(call);
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
    expect(window.document.querySelector('[data-action="destroy"][data-id="agt_live"]')).toBeNull();
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /force-destroy outcome is unknown.*live sessions were refreshed.*no destroy action remains.*likely destroyed.*do not submit the action again/i,
    );
  });
});
