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
import { afterEach, describe, expect, it } from 'vitest';

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
  window.localStorage.setItem('ds_web_session_token', 'tok');
  const cr = opts.confirmReturns ?? true;
  // @ts-expect-error — driftstackConfirm is injected by DashboardLayout
  window.driftstackConfirm = () => Promise.resolve(cr);
  window.confirm = () => cr;

  const pageScript = scriptBodies.find((s) => s.includes('data-page="security"'));
  if (!pageScript) throw new Error('security inline script not found');
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
function listText(window: JSDOM['window']): string {
  return window.document.querySelector('[data-list="web-sessions"]')?.textContent ?? '';
}
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
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
  });
  const loadBuiltPage = (): string => readFileSync(BUILT_PAGE, 'utf8');

  it('coalesces forced duplicate password-reset actions into one bounded request', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: makeRouter([]),
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
    expect(window.document.querySelector('[data-banner]')?.textContent).toContain(
      'Password-reset email sent',
    );
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
