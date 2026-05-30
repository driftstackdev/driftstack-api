// Behavioural coverage for the dashboard Overview (home) page —
// apps/customer-dashboard/src/pages/index.astro. The page was previously
// untested despite being the first authenticated surface a customer sees: it
// auth-gates (redirect to /login when there's no token), fans out 4 parallel
// reads (account/me, api-keys, sessions, billing), and degrades each section
// independently on failure. These tests load the BUILT page, run its inline
// script in jsdom against a mock fetch, and assert the rendered outcome.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { TIER_DISPLAY_NAMES } from '../../src/data/mocks.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'index.html');
const PAGE_URL = 'https://app.driftstack.dev/';

function loadBuiltPage(): string {
  return readFileSync(BUILT_PAGE, 'utf8');
}

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface SetUpOpts {
  token?: string;
  route: (call: MockFetchCall) => Response;
}

interface SetUpResult {
  window: JSDOM['window'];
  fetchCalls: MockFetchCall[];
  hydratedCount: () => number;
}

function setUpDom(html: string, opts: SetUpOpts): SetUpResult {
  const scriptBodies: string[] = [];
  const htmlNoScripts = html.replace(/<script[^>]*>([\s\S]*?)<\/script>/g, (_m, body: string) => {
    scriptBodies.push(body);
    return '';
  });
  // Swallow jsdom's "Not implemented: navigation" error so the auth-gate
  // redirect (window.location.replace) doesn't spam test output.
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
  // Helpers DashboardLayout installs; stub so the page script behaves the same.
  let hydrated = 0;
  // @ts-expect-error — injected by DashboardLayout (not eval'd here)
  window.dashboardHydrated = () => {
    hydrated += 1;
  };
  // @ts-expect-error — injected by DashboardLayout
  window.driftstackActAsHeaders = () => ({});

  const pageScript = scriptBodies.find((s) => s.includes('data-page="overview"'));
  if (!pageScript) throw new Error('overview inline script not found');
  // @ts-expect-error — jsdom global has eval
  window.eval(pageScript);
  return { window: window as JSDOM['window'], fetchCalls, hydratedCount: () => hydrated };
}

function text(window: JSDOM['window'], selector: string): string {
  return window.document.querySelector(selector)?.textContent?.trim() ?? '';
}

function isHidden(window: JSDOM['window'], selector: string): boolean {
  const el = window.document.querySelector(selector);
  if (!el) throw new Error(`selector not found: ${selector}`);
  return el.classList.contains('hidden');
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface RouterOpts {
  me?: Record<string, unknown>;
  meError?: string;
  meStatus?: number;
  apiKeys?: Array<Record<string, unknown>>;
  sessions?: Array<Record<string, unknown>>;
  billing?: Record<string, unknown>;
}

function makeRouter(opts: RouterOpts): (c: MockFetchCall) => Response {
  return (call) => {
    const u = call.url;
    if (/\/v1\/account\/me$/.test(u)) {
      if (opts.meError) return json({ detail: opts.meError }, opts.meStatus ?? 500);
      return json(opts.me ?? {});
    }
    if (/\/v1\/api-keys$/.test(u)) return json({ data: opts.apiKeys ?? [] });
    if (/\/v1\/sessions$/.test(u)) return json({ data: opts.sessions ?? [] });
    if (/\/v1\/billing$/.test(u)) return json(opts.billing ?? {});
    return json({}, 404);
  };
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

let win: JSDOM['window'] | undefined;
afterEach(() => {
  win?.close?.();
  win = undefined;
});

describe('customer-dashboard Overview (index.astro) behaviour', () => {
  it('no session token: short-circuits to /login and makes no API calls', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      // no token supplied → getToken() returns '' → redirect + return
      route: () => {
        throw new Error('must not fetch when unauthenticated');
      },
    });
    win = window;
    await flush();
    expect(fetchCalls.length).toBe(0);
  });

  it('account/me: populates name, tier label, concurrent usage + cap, and profile usage + cap', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({
        me: {
          name: 'Acme Corp',
          tier: 'solo_manual',
          concurrent_session_active: 2,
          concurrent_session_cap: 5,
          profile_count: 3,
          profile_cap: 10,
        },
      }),
    });
    win = window;
    await flush();
    expect(text(window, '[data-account-name]')).toBe('Acme Corp');
    expect(text(window, '[data-account-tier]')).toBe(TIER_DISPLAY_NAMES['solo_manual']);
    expect(text(window, '[data-stat-concurrent]')).toBe('2');
    expect(text(window, '[data-stat-concurrent-cap]')).toBe('5');
    expect(text(window, '[data-stat-profiles]')).toBe('3');
    expect(text(window, '[data-stat-profiles-cap]')).toBe('/ 10');
  });

  it('api-keys: the active-keys stat excludes revoked keys', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({
        me: { name: 'A', tier: 'solo_manual' },
        apiKeys: [
          { revoked_at: null },
          { revoked_at: '2026-05-01T00:00:00Z' },
          { revoked_at: null },
        ],
      }),
    });
    win = window;
    await flush();
    expect(text(window, '[data-stat-api-keys]')).toBe('2');
  });

  it('sessions: empty list shows the empty state, not the list', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({ me: { name: 'A', tier: 'solo_manual' }, sessions: [] }),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-sessions-empty]')).toBe(false);
    expect(isHidden(window, '[data-sessions-list]')).toBe(true);
  });

  it('sessions: a running session renders id + status + a FRIENDLY archetype label + readable date (no raw slug or ISO)', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({
        me: { name: 'A', tier: 'solo_manual' },
        sessions: [
          {
            id: 'sess_live1',
            status: 'running',
            archetype: 'iphone16pro_ios18_7_safari26_4',
            created_at: '2026-05-20T10:00:00.000Z',
          },
          { id: 'sess_dead', status: 'destroyed' },
        ],
      }),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-sessions-list]')).toBe(false);
    const listText = text(window, '[data-sessions-list]');
    expect(listText).toContain('sess_live1');
    expect(listText).toContain('running');
    // The destroyed session is filtered out of the active list.
    expect(listText).not.toContain('sess_dead');
    // Archetype renders as the friendly registry label, never the raw slug.
    expect(listText).toContain('iPhone 16 Pro / iOS 18.7 / Safari 26.4');
    expect(listText).not.toContain('iphone16pro_ios18_7_safari26_4');
    // created_at renders as YYYY-MM-DD, not the raw ISO timestamp.
    expect(listText).toContain('2026-05-20');
    expect(listText).not.toContain('T10:00:00');
  });

  it('billing: an active subscription renders the subscription card', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({
        me: { name: 'A', tier: 'solo_manual' },
        billing: {
          subscription: {
            tier: 'solo_manual',
            status: 'active',
            current_period_end: '2026-06-30T00:00:00Z',
          },
        },
      }),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-subscription-card]')).toBe(false);
    expect(text(window, '[data-subscription-line]')).toContain(TIER_DISPLAY_NAMES['solo_manual']);
    expect(text(window, '[data-subscription-line]')).toContain('active');
    expect(text(window, '[data-subscription-period]')).toContain('2026-06-30');
  });

  it('billing: no subscription shows the pick-a-tier empty state', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({
        me: { name: 'A', tier: 'solo_manual' },
        billing: { subscription: null },
      }),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-subscription-empty]')).toBe(false);
    expect(isHidden(window, '[data-subscription-card]')).toBe(true);
  });

  it('account/me failure: surfaces the server detail in the banner', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({ meError: 'Your session has expired.', meStatus: 401 }),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-banner]')).toBe(false);
    expect(text(window, '[data-banner]')).toContain('Your session has expired.');
  });

  it('opacity-gate: dashboardHydrated() fires once account/me settles', async () => {
    const { window, hydratedCount } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({ me: { name: 'A', tier: 'solo_manual' } }),
    });
    win = window;
    await flush();
    expect(hydratedCount()).toBeGreaterThanOrEqual(1);
  });
});
