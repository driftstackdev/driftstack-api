// Local integration test for the /security page's inline script,
// focused on the SECURITY-critical web-session management flow (revoke
// a single sign-in / revoke all other sign-ins). A wiring bug here
// means a customer can't kill a stolen session. These flows lived on
// /settings until the 2026-07-03 design-system v2 split moved the
// security surfaces to the dedicated /security page. The page loads
// several account endpoints concurrently, each with its own
// independent .catch, so this uses a permissive stateful URL router:
// every loader resolves to a minimal response, web-sessions returns a
// mutable list, and the DELETE mutations drive the assertions.
//
// Mirrors profiles-page.test.ts (route-based). Confirmation is the
// branded window.driftstackConfirm (injected by DashboardLayout, not
// eval'd here) → stubbed to a resolved Promise.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDashboardDeadline } from './dashboard-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'security', 'index.html');
const PAGE_URL = 'https://app.driftstack.dev/security/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}
interface WebSession {
  id: string;
  os: string;
  browser: string;
  current: boolean;
  last_used_at: string;
  created_at: string;
  expires_at: string;
}
interface SetUpOpts {
  confirmReturns?: boolean;
  token?: string | null;
  storageDenied?: boolean;
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
    window.localStorage.setItem('ds_web_session_token', opts.token ?? 'tok');
  }
  let hydrated = 0;
  // @ts-expect-error — injected by DashboardLayout
  window.dashboardHydrated = () => {
    hydrated += 1;
  };
  const cr = opts.confirmReturns ?? true;
  // @ts-expect-error — driftstackConfirm is injected by DashboardLayout
  window.driftstackConfirm = () => Promise.resolve(cr);
  window.confirm = () => cr;

  const pageScript = scriptBodies.find((s) => s.includes('data-page="security"'));
  if (!pageScript) throw new Error('security inline script not found');
  installDashboardDeadline(window);
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
function listText(window: JSDOM['window']): string {
  return window.document.querySelector('[data-list="web-sessions"]')?.textContent ?? '';
}
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function mkSession(over: Partial<WebSession> = {}): WebSession {
  return {
    id: 'sess_' + Math.random().toString(36).slice(2, 8),
    os: 'macOS',
    browser: 'Safari',
    current: false,
    last_used_at: '2026-05-29T10:00:00.000Z',
    created_at: '2026-05-20T10:00:00.000Z',
    expires_at: '2026-06-20T10:00:00.000Z',
    ...over,
  };
}

// Permissive router: every security-page loader resolves to a minimal
// shape so the independent sections hydrate without throwing; the
// web-sessions list is mutable so revoke mutations are observable.
function makeRouter(webSessions: WebSession[]): (c: MockFetchCall) => Response {
  return (call: MockFetchCall): Response => {
    const method = (call.init?.method || 'GET').toUpperCase();
    const u = call.url.replace(/^https?:\/\/[^/]+/, '');
    const single = u.match(/\/v1\/account\/web-sessions\/([^/?]+)$/);
    if (single && method === 'DELETE') {
      const i = webSessions.findIndex((s) => s.id === single[1]);
      if (i >= 0) webSessions.splice(i, 1);
      return new Response(null, { status: 204 });
    }
    if (/\/v1\/account\/web-sessions\?keep=current$/.test(u) && method === 'DELETE') {
      const others = webSessions.filter((s) => !s.current).length;
      for (let i = webSessions.length - 1; i >= 0; i--) {
        if (!webSessions[i]!.current) webSessions.splice(i, 1);
      }
      return json({ revoked: others });
    }
    if (/\/v1\/account\/web-sessions$/.test(u) && method === 'GET') {
      return json({ data: webSessions });
    }
    if (/\/v1\/account\/me$/.test(u) && method === 'GET') {
      return json({ email: 'me@example.com', name: 'Me', slug: 'me', region: 'eu' });
    }
    if (/\/v1\/auth\/password-reset\/request$/.test(u) && method === 'POST') {
      return json({ sent: true });
    }
    if (/\/v1\/account\/audit-log/.test(u)) return json({ data: [] });
    // oauth-links / mfa return 404 when absent — the page handles
    // those gracefully (independent .catch per section).
    return json({}, 404);
  };
}

describe('security page — web-session management (security)', () => {
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
  ])(
    '%s: releases hydration without requests and keeps password reset inert',
    async (_label, auth) => {
      const { window, fetchCalls, hydratedCount } = setUpDom(loadBuiltPage(), {
        ...auth,
        route: () => {
          throw new Error('must not fetch without a bearer');
        },
      });
      win = window;
      await flush();

      const btn = window.document.querySelector(
        '[data-action="change-password"]',
      ) as HTMLButtonElement;
      expect(fetchCalls).toHaveLength(0);
      expect(hydratedCount()).toBe(1);
      expect(btn.disabled).toBe(true);
      expect(btn.title).toMatch(/Sign in/i);
      expect(window.document.querySelector('[data-banner]')?.textContent).toContain('Sign in');
    },
  );

  it('requires a current account email before accepting password-reset actions', async () => {
    let resolveAccount: ((response: Response) => void) | undefined;
    const base = makeRouter([]);
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (/\/v1\/account\/me$/.test(call.url)) {
          return new Promise<Response>((resolve) => {
            resolveAccount = resolve;
          });
        }
        return base(call);
      },
    });
    win = window;
    await flush(2);

    const btn = window.document.querySelector(
      '[data-action="change-password"]',
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    btn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush(2);
    expect(fetchCalls.some((call) => /password-reset\/request$/.test(call.url))).toBe(false);

    resolveAccount?.(json({ email: 'authoritative@example.com' }));
    await flush();
    expect(btn.disabled).toBe(false);
    btn.click();
    await flush();
    const reset = fetchCalls.find((call) => /password-reset\/request$/.test(call.url));
    expect(JSON.parse(String(reset?.init?.body))).toEqual({
      email: 'authoritative@example.com',
    });
  });

  it('keeps reset authority revoked when the account identity read fails', async () => {
    const base = makeRouter([]);
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) =>
        /\/v1\/account\/me$/.test(call.url)
          ? json({ detail: 'identity unavailable' }, 503)
          : base(call),
    });
    win = window;
    await flush();

    const btn = window.document.querySelector(
      '[data-action="change-password"]',
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toMatch(/Reload/i);
    btn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush(2);
    expect(fetchCalls.some((call) => /password-reset\/request$/.test(call.url))).toBe(false);
  });

  it('coalesces forced duplicate password-reset actions into one bounded request', async () => {
    const baseRouter = makeRouter([]);
    let releaseReset: (response: Response) => void = () => {};
    const pendingReset = new Promise<Response>((resolve) => {
      releaseReset = resolve;
    });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) =>
        /\/v1\/auth\/password-reset\/request$/.test(call.url) && call.init?.method === 'POST'
          ? pendingReset
          : baseRouter(call),
    });
    win = window;
    await flush();
    const btn = window.document.querySelector(
      '[data-action="change-password"]',
    ) as HTMLButtonElement;
    btn.dispatchEvent(new window.Event('click', { bubbles: true }));
    btn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush();
    const resets = fetchCalls.filter(
      (c) => /\/v1\/auth\/password-reset\/request$/.test(c.url) && c.init?.method === 'POST',
    );
    expect(resets).toHaveLength(1);
    expect(resets[0]?.init?.signal).toBeDefined();
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.textContent?.trim()).toBe('Sending…');

    releaseReset(json({ sent: true }));
    await flush();
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('aria-busy')).toBe('false');
    expect(btn.textContent?.trim()).toBe('Change password');
    expect(window.document.querySelector('[data-banner]')?.textContent).toContain(
      'Password-reset email sent',
    );
  });

  it('treats a malformed accepted reset body as sent without inviting a duplicate email', async () => {
    const fallback = makeRouter([]);
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) =>
        /\/v1\/auth\/password-reset\/request$/.test(call.url) && call.init?.method === 'POST'
          ? new Response('{', {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          : fallback(call),
    });
    win = window;
    await flush();

    const btn = window.document.querySelector(
      '[data-action="change-password"]',
    ) as HTMLButtonElement;
    btn.click();
    await flush();

    expect(
      fetchCalls.filter(
        (call) =>
          /\/v1\/auth\/password-reset\/request$/.test(call.url) && call.init?.method === 'POST',
      ),
    ).toHaveLength(1);
    expect(window.document.querySelector('[data-banner]')?.textContent).toContain(
      'Password-reset email sent',
    );
    expect(window.document.querySelector('[data-banner]')?.textContent).not.toMatch(
      /couldn't send|try again/i,
    );
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('aria-busy')).toBe('false');
  });

  it('makes a password-reset timeout terminal until reload so a committed email is not duplicated', async () => {
    const base = makeRouter([]);
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) =>
        /\/v1\/auth\/password-reset\/request$/.test(call.url) && call.init?.method === 'POST'
          ? Promise.reject(timeout)
          : base(call),
    });
    win = window;
    await flush();
    const btn = window.document.querySelector(
      '[data-action="change-password"]',
    ) as HTMLButtonElement;
    btn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush(12);

    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('false');
    expect(btn.textContent).toContain('Check inbox before retrying');
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /outcome is unknown.*email may have been sent.*inbox and spam.*multiple reset emails.*newest one.*reload Security.*only if no message arrives/i,
    );

    btn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush();
    expect(
      fetchCalls.filter(
        (call) =>
          /\/v1\/auth\/password-reset\/request$/.test(call.url) && call.init?.method === 'POST',
      ),
    ).toHaveLength(1);
  });

  it('renders active sign-ins: the non-current session gets a Revoke button; the current one shows the current badge', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      route: makeRouter([
        mkSession({ id: 'sess_current', current: true, os: 'macOS', browser: 'Safari' }),
        mkSession({ id: 'sess_other', current: false, os: 'iOS', browser: 'Safari' }),
      ]),
    });
    win = window;
    await flush();
    expect(window.document.querySelector('[data-revoke-id="sess_other"]')).toBeTruthy();
    // Current session has no revoke control.
    expect(window.document.querySelector('[data-revoke-id="sess_current"]')).toBeNull();
    expect(listText(window).toLowerCase()).toContain('current');
  });

  it('revoke single: confirm-gated DELETE /v1/account/web-sessions/:id then refresh drops it', async () => {
    const sessions = [
      mkSession({ id: 'sess_current', current: true }),
      mkSession({ id: 'sess_other', current: false, os: 'iOS', browser: 'Safari' }),
    ];
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      confirmReturns: true,
      route: makeRouter(sessions),
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-revoke-id="sess_other"]') as HTMLButtonElement).click();
    await flush();
    const del = fetchCalls.find(
      (c) => c.init?.method === 'DELETE' && /\/web-sessions\/sess_other$/.test(c.url),
    );
    expect(del).toBeTruthy();
    expect(window.document.querySelector('[data-revoke-id="sess_other"]')).toBeNull();
  });

  it('serializes destructive sign-in actions and restores controls after refresh', async () => {
    const sessions = [
      mkSession({ id: 'sess_current', current: true }),
      mkSession({ id: 'sess_other', current: false, os: 'iOS', browser: 'Safari' }),
    ];
    const baseRouter = makeRouter(sessions);
    let releaseDelete: (response: Response) => void = () => {};
    const pendingDelete = new Promise<Response>((resolve) => {
      releaseDelete = resolve;
    });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (call.init?.method === 'DELETE' && /\/web-sessions\/sess_other$/.test(call.url)) {
          return pendingDelete;
        }
        return baseRouter(call);
      },
    });
    win = window;
    await flush();
    const revokeBtn = window.document.querySelector(
      '[data-revoke-id="sess_other"]',
    ) as HTMLButtonElement;
    const revokeAllBtn = window.document.querySelector(
      '[data-button="web-sessions-revoke-all"]',
    ) as HTMLButtonElement;
    revokeBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
    revokeAllBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush();
    expect(revokeBtn.disabled).toBe(true);
    expect(revokeBtn.getAttribute('aria-busy')).toBe('true');
    expect(revokeBtn.textContent?.trim()).toBe('Revoking…');
    expect(revokeAllBtn.disabled).toBe(true);
    expect(revokeAllBtn.textContent?.trim()).toBe('Sign out everywhere else');
    expect(fetchCalls.filter((c) => c.init?.method === 'DELETE')).toHaveLength(1);

    releaseDelete(new Response(null, { status: 204 }));
    await flush();
    expect(revokeAllBtn.disabled).toBe(false);
    expect(revokeAllBtn.textContent?.trim()).toBe('Sign out everywhere else');
  });

  it('shows bulk sign-out progress and restores its retained control after failure', async () => {
    const sessions = [
      mkSession({ id: 'sess_current', current: true }),
      mkSession({ id: 'sess_other', current: false, os: 'iOS', browser: 'Safari' }),
    ];
    const baseRouter = makeRouter(sessions);
    let releaseDelete: (response: Response) => void = () => {};
    const pendingDelete = new Promise<Response>((resolve) => {
      releaseDelete = resolve;
    });
    const { window } = setUpDom(loadBuiltPage(), {
      route: (call) =>
        call.init?.method === 'DELETE' && /\/web-sessions\?keep=current$/.test(call.url)
          ? pendingDelete
          : baseRouter(call),
    });
    win = window;
    await flush();
    const revokeAllBtn = window.document.querySelector(
      '[data-button="web-sessions-revoke-all"]',
    ) as HTMLButtonElement;
    revokeAllBtn.click();
    await flush();
    expect(revokeAllBtn.disabled).toBe(true);
    expect(revokeAllBtn.getAttribute('aria-busy')).toBe('true');
    expect(revokeAllBtn.textContent?.trim()).toBe('Signing out…');

    releaseDelete(json({}, 500));
    await flush();
    expect(revokeAllBtn.disabled).toBe(false);
    expect(revokeAllBtn.hasAttribute('aria-busy')).toBe(false);
    expect(revokeAllBtn.textContent?.trim()).toBe('Sign out everywhere else');
  });

  it('single revoke timeout refreshes a committed removal before suggesting retry', async () => {
    const sessions = [
      mkSession({ id: 'sess_current', current: true }),
      mkSession({ id: 'sess_other', current: false, os: 'iOS', browser: 'Safari' }),
    ];
    const base = makeRouter(sessions);
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (call.init?.method === 'DELETE' && /\/web-sessions\/sess_other$/.test(call.url)) {
          sessions.splice(1, 1);
          return Promise.reject(timeout);
        }
        return base(call);
      },
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-revoke-id="sess_other"]') as HTMLButtonElement).click();
    await flush(12);

    expect(fetchCalls.filter((call) => call.init?.method === 'DELETE')).toHaveLength(1);
    expect(window.document.querySelector('[data-revoke-id="sess_other"]')).toBeNull();
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /outcome is unknown.*active sign-ins were refreshed.*sign-in is gone.*revocation completed.*still appears.*retry/i,
    );
  });

  it('bulk revoke timeout refreshes committed state and confirms only current remains', async () => {
    const sessions = [
      mkSession({ id: 'sess_current', current: true }),
      mkSession({ id: 'sess_other', current: false, os: 'iOS', browser: 'Safari' }),
    ];
    const base = makeRouter(sessions);
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (call.init?.method === 'DELETE' && /\/web-sessions\?keep=current$/.test(call.url)) {
          sessions.splice(1, 1);
          return Promise.reject(timeout);
        }
        return base(call);
      },
    });
    win = window;
    await flush();
    (
      window.document.querySelector('[data-button="web-sessions-revoke-all"]') as HTMLButtonElement
    ).click();
    await flush(12);

    expect(fetchCalls.filter((call) => call.init?.method === 'DELETE')).toHaveLength(1);
    expect(window.document.querySelector('[data-revoke-id]')).toBeNull();
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /outcome is unknown.*active sign-ins were refreshed.*only the current sign-in remains.*every other session was revoked.*others still appear.*retry/i,
    );
  });

  it('treats malformed accepted bulk sign-out JSON as committed and refreshes live sessions', async () => {
    const sessions = [
      mkSession({ id: 'sess_current', current: true }),
      mkSession({ id: 'sess_other', current: false, os: 'iOS', browser: 'Safari' }),
    ];
    const base = makeRouter(sessions);
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (call.init?.method === 'DELETE' && /\/web-sessions\?keep=current$/.test(call.url)) {
          sessions.splice(1, 1);
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
    const revokeAll = window.document.querySelector(
      '[data-button="web-sessions-revoke-all"]',
    ) as HTMLButtonElement;
    revokeAll.click();
    revokeAll.dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush(12);

    expect(fetchCalls.filter((call) => call.init?.method === 'DELETE')).toHaveLength(1);
    expect(window.document.querySelector('[data-revoke-id]')).toBeNull();
    expect(window.document.querySelector('[data-banner]')?.textContent).toBe(
      'Signed out of other sessions.',
    );
    expect(window.document.querySelector('[data-banner]')?.textContent).not.toContain("Couldn't");
  });

  it('does not let an older success timer hide a newer refresh failure', async () => {
    vi.useFakeTimers();
    const sessions = [
      mkSession({ id: 'sess_current', current: true }),
      mkSession({ id: 'sess_other', current: false, os: 'iOS', browser: 'Safari' }),
    ];
    let webSessionReads = 0;
    const baseRouter = makeRouter(sessions);
    const { window } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (call.init?.method !== 'DELETE' && /\/v1\/account\/web-sessions$/.test(call.url)) {
          webSessionReads += 1;
          if (webSessionReads > 1) return json({}, 500);
        }
        return baseRouter(call);
      },
    });
    win = window;
    await flushMicrotasks();
    (window.document.querySelector('[data-revoke-id="sess_other"]') as HTMLButtonElement).click();
    await flushMicrotasks(40);
    const banner = window.document.querySelector('[data-banner]');
    expect(banner?.textContent).toContain('temporarily unavailable');
    expect(banner?.classList.contains('hidden')).toBe(false);

    await vi.advanceTimersByTimeAsync(2000);
    expect(banner?.textContent).toContain('temporarily unavailable');
    expect(banner?.classList.contains('hidden')).toBe(false);
  });

  it('revoke cancelled: no DELETE fired, the session stays', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      confirmReturns: false,
      route: makeRouter([
        mkSession({ id: 'sess_current', current: true }),
        mkSession({ id: 'sess_other', current: false, os: 'iOS', browser: 'Safari' }),
      ]),
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-revoke-id="sess_other"]') as HTMLButtonElement).click();
    await flush();
    expect(
      fetchCalls.some((c) => c.init?.method === 'DELETE' && /\/web-sessions\//.test(c.url)),
    ).toBe(false);
    expect(window.document.querySelector('[data-revoke-id="sess_other"]')).toBeTruthy();
  });

  it('revoke all others: confirm-gated DELETE /v1/account/web-sessions?keep=current', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      confirmReturns: true,
      route: makeRouter([
        mkSession({ id: 'sess_current', current: true }),
        mkSession({ id: 'sess_a', current: false }),
        mkSession({ id: 'sess_b', current: false }),
      ]),
    });
    win = window;
    await flush();
    const allBtn = window.document.querySelector(
      '[data-button="web-sessions-revoke-all"]',
    ) as HTMLButtonElement;
    expect(allBtn.hidden).toBe(false);
    allBtn.click();
    await flush();
    const del = fetchCalls.find(
      (c) => c.init?.method === 'DELETE' && /\/web-sessions\?keep=current$/.test(c.url),
    );
    expect(del).toBeTruthy();
  });
});
