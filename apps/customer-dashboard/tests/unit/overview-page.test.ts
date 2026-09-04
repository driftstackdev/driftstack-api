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
import { installDashboardDeadline } from './dashboard-test-runtime';
import { TIER_DISPLAY_NAMES } from '../../src/data/tier-display-names.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'index.html');
const PAGE_URL = 'https://app.driftstack.io/';

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
  /** Page URL override (e.g. the ?subscribed= post-checkout landing). */
  url?: string;
  /** Extra localStorage entries seeded before the page script runs
   *  (e.g. ds_onboarding_dismissed or a retired marker under test). */
  storage?: Record<string, string>;
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
    url: opts.url ?? PAGE_URL,
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
  for (const [k, v] of Object.entries(opts.storage ?? {})) window.localStorage.setItem(k, v);
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
  installDashboardDeadline(window);
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
  usage?: Record<string, unknown>;
  usageSeries?: Record<string, unknown>;
  usageSeriesStatus?: number;
  teamMembers?: Array<Record<string, unknown>>;
  teamStatus?: number;
  status?: Record<string, unknown>;
  statusFails?: boolean;
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
    if (/\/v1\/usage$/.test(u)) return json(opts.usage ?? { totals: {} });
    if (/\/v1\/usage\/series\?days=14$/.test(u))
      return json(opts.usageSeries ?? { buckets: [] }, opts.usageSeriesStatus ?? 200);
    if (/\/v1\/team\/members$/.test(u)) {
      if (opts.teamStatus) return json({ detail: 'forbidden' }, opts.teamStatus);
      return json({ data: opts.teamMembers ?? [] });
    }
    if (/\/v1\/status$/.test(u)) {
      if (opts.statusFails) return json({}, 503);
      return json(opts.status ?? { overall_status: 'operational', recent_incidents: [] });
    }
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
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
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
    expect(fetchCalls).toHaveLength(8);
    expect(fetchCalls.every((call) => call.init?.signal instanceof window.AbortSignal)).toBe(true);
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

  it('sessions: an active (busy) session renders id + status + a FRIENDLY archetype label + readable date (no raw slug or ISO)', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({
        me: { name: 'A', tier: 'solo_manual' },
        sessions: [
          {
            id: 'sess_live1',
            // Real session statuses are creating|ready|busy|destroyed|errored
            // (services/sessions.ts) — 'busy' is a live (non-terminal) session
            // the overview counts as active. (Was a fictional 'running'.)
            status: 'busy',
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
    expect(listText).toContain('busy');
    // The destroyed session is filtered out of the active list.
    expect(listText).not.toContain('sess_dead');
    // Archetype renders as the friendly registry label, never the raw slug.
    expect(listText).toContain('iPhone 16 Pro / iOS 18.7 / Safari 26.4');
    expect(listText).not.toContain('iphone16pro_ios18_7_safari26_4');
    // created_at renders as YYYY-MM-DD, not the raw ISO timestamp.
    expect(listText).toContain('2026-05-20');
    expect(listText).not.toContain('T10:00:00');
  });

  it('sessions: status badge color matches /sessions per-status map (2026-06-30 fix) — creating/busy are NOT hardcoded emerald', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({
        me: { name: 'A', tier: 'solo_manual' },
        sessions: [
          { id: 'sess_creating', status: 'creating', created_at: '2026-05-20T10:00:00.000Z' },
          { id: 'sess_busy', status: 'busy', created_at: '2026-05-20T10:00:00.000Z' },
          { id: 'sess_ready', status: 'ready', created_at: '2026-05-20T10:00:00.000Z' },
        ],
      }),
    });
    win = window;
    await flush();
    const list = window.document.querySelector('[data-sessions-list]');
    expect(list).not.toBeNull();
    const rows = Array.from(list?.querySelectorAll('li') ?? []);
    const badgeClassFor = (id: string): string => {
      const row = rows.find((li) => li.textContent?.includes(id));
      return row?.querySelector('span')?.className ?? '';
    };
    // 'creating' must NOT render the green "ready" badge — it's still
    // spinning up. Distinct accent color. (Fleet v2 2026-07-02: badges
    // moved onto the two-axis status tokens — tk-ready/tk-busy/tk-err —
    // so they flip with data-mode instead of the old hard-coded
    // emerald/blue/red literals that broke in light mode.)
    expect(badgeClassFor('sess_creating')).toContain('tk-accent');
    expect(badgeClassFor('sess_creating')).not.toContain('tk-ready');
    // 'busy' must NOT render green either — mid-operation, not idle-ready.
    expect(badgeClassFor('sess_busy')).toContain('tk-busy');
    expect(badgeClassFor('sess_busy')).not.toContain('tk-ready');
    // 'ready' legitimately gets the green/ready badge.
    expect(badgeClassFor('sess_ready')).toContain('tk-ready');
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

  it('account/me failure uses fixed sign-in guidance in the banner', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({ meError: 'Your session has expired.', meStatus: 401 }),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-banner]')).toBe(false);
    expect(text(window, '[data-banner]')).toContain(
      'Your sign-in could not be verified. Check your details and try again.',
    );
    expect(text(window, '[data-banner]')).not.toContain('Your session has expired.');
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

  it('usage: the session-hours stat converts the cycle session_minute total to hours', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({
        me: { name: 'A', tier: 'solo_manual' },
        usage: { totals: { session_minute: 90 } },
      }),
    });
    win = window;
    await flush();
    expect(text(window, '[data-stat-hours]')).toBe('1.5 h');
  });

  it('usage series: an all-zero 14-day series renders the honest empty state, never a fabricated chart (expected prod state until the V-014/V-015 usage writers land)', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({
        me: { name: 'A', tier: 'solo_manual' },
        usageSeries: {
          buckets: [
            { date: '2026-06-19', totals: {} },
            { date: '2026-06-20', totals: { session_minute: 0 } },
          ],
        },
      }),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-usage-empty]')).toBe(false);
    expect(isHidden(window, '[data-usage-chart]')).toBe(true);
  });

  it('usage series: a load failure is labeled as a failure, never as honest zero activity', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({
        me: { name: 'A', tier: 'solo_manual' },
        usageSeriesStatus: 503,
      }),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-usage-empty]')).toBe(false);
    expect(text(window, '[data-usage-empty]')).toBe('Could not load usage history.');
    expect(text(window, '[data-usage-empty]')).not.toContain('No usage recorded');
  });

  it('usage series: non-zero buckets render one bar per day + the first/last-day legend', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({
        me: { name: 'A', tier: 'solo_manual' },
        usageSeries: {
          buckets: [
            { date: '2026-06-19', totals: { session_minute: 30 } },
            { date: '2026-06-20', totals: {} },
            { date: '2026-06-21', totals: { session_minute: 60 } },
          ],
        },
      }),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-usage-chart]')).toBe(false);
    const chart = window.document.querySelector('[data-usage-chart]');
    expect(chart?.querySelectorAll('span').length).toBe(3);
    expect(text(window, '[data-usage-legend]')).toContain('2026-06-19');
    expect(text(window, '[data-usage-legend]')).toContain('2026-06-21');
  });

  it('cap meters: concurrent + profile meter widths reflect active/cap; a zero cap leaves the track empty', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({
        me: {
          name: 'A',
          tier: 'solo_manual',
          concurrent_session_active: 2,
          concurrent_session_cap: 5,
          profile_count: 3,
          profile_cap: 0,
        },
      }),
    });
    win = window;
    await flush();
    const meter = window.document.querySelector<HTMLElement>('[data-stat-concurrent-meter]');
    expect(meter?.style.width).toBe('40%');
    const pMeter = window.document.querySelector<HTMLElement>('[data-stat-profiles-meter]');
    expect(pMeter?.style.width).toBe('0%');
  });

  it('?subscribed=<tier> (the post-checkout Stripe landing) greets the new subscription in the banner', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      url: 'https://app.driftstack.io/?subscribed=team_manual',
      route: makeRouter({ me: { name: 'A', tier: 'team_manual' } }),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-banner]')).toBe(false);
    expect(text(window, '[data-banner]')).toContain(TIER_DISPLAY_NAMES['team_manual']);
    expect(text(window, '[data-banner]')).toContain('subscription is active');
  });

  it('onboarding: a fresh account (no keys, no sessions, zero usage) sees the checklist with app/key/session pending and team revealed-but-pending', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({
        me: { name: 'A', tier: 'team_manual' },
        apiKeys: [],
        sessions: [],
        teamMembers: [{ id: 'm1' }],
      }),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-onboarding]')).toBe(false);
    for (const step of ['app', 'key', 'session', 'team']) {
      const li = window.document.querySelector(`[data-onboarding-step="${step}"]`);
      expect(li?.getAttribute('data-step-done')).toBeNull();
    }
    expect(
      window.document.querySelector('[data-onboarding-step="team"]')?.classList.contains('hidden'),
    ).toBe(false);
  });

  it('onboarding: team fetch 403 (member / non-team tier) keeps the team step hidden without blocking the rest', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({
        me: { name: 'A', tier: 'solo_manual' },
        apiKeys: [{ revoked_at: null }],
        teamStatus: 403,
      }),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-onboarding]')).toBe(false);
    expect(
      window.document.querySelector('[data-onboarding-step="team"]')?.classList.contains('hidden'),
    ).toBe(true);
    // The key step derived done from the active API key.
    expect(
      window.document.querySelector('[data-onboarding-step="key"]')?.getAttribute('data-step-done'),
    ).toBe('true');
  });

  it('onboarding: a key plus a recorded session and team membership auto-hide the checklist', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({
        me: { name: 'A', tier: 'team_manual' },
        apiKeys: [{ revoked_at: null }],
        sessions: [{ id: 's1', status: 'destroyed', created_at: '2026-06-01T00:00:00Z' }],
        teamMembers: [{ id: 'm1' }, { id: 'm2' }],
      }),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-onboarding]')).toBe(true);
  });

  it('onboarding: a retired app-link click marker is scrubbed and cannot fake app completion', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      storage: { ds_onboarding_app_clicked: '1' },
      route: makeRouter({
        me: { name: 'A', tier: 'solo_manual' },
        apiKeys: [],
        sessions: [],
        teamStatus: 403,
      }),
    });
    win = window;
    await flush();
    expect(window.localStorage.getItem('ds_onboarding_app_clicked')).toBeNull();
    expect(
      window.document.querySelector('[data-onboarding-step="app"]')?.getAttribute('data-step-done'),
    ).toBeNull();
    expect(isHidden(window, '[data-onboarding]')).toBe(false);
  });

  it('onboarding: recorded usage alone (no session rows) also satisfies the first-session step', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({
        me: { name: 'A', tier: 'solo_manual' },
        sessions: [],
        usage: { totals: { session_minute: 12 } },
        teamStatus: 403,
      }),
    });
    win = window;
    await flush();
    expect(
      window.document
        .querySelector('[data-onboarding-step="session"]')
        ?.getAttribute('data-step-done'),
    ).toBe('true');
    expect(
      window.document.querySelector('[data-onboarding-step="app"]')?.getAttribute('data-step-done'),
    ).toBe('true');
  });

  it('onboarding: ds_onboarding_dismissed suppresses the checklist entirely', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      storage: { ds_onboarding_dismissed: '1' },
      route: makeRouter({ me: { name: 'A', tier: 'solo_manual' }, apiKeys: [], sessions: [] }),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-onboarding]')).toBe(true);
  });

  it('onboarding: the Dismiss button hides the panel and persists ds_onboarding_dismissed', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({ me: { name: 'A', tier: 'solo_manual' }, apiKeys: [], sessions: [] }),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-onboarding]')).toBe(false);
    (window.document.querySelector('[data-onboarding-dismiss]') as HTMLButtonElement).dispatchEvent(
      new window.Event('click', { bubbles: true }),
    );
    await flush();
    expect(isHidden(window, '[data-onboarding]')).toBe(true);
    expect(window.localStorage.getItem('ds_onboarding_dismissed')).toBe('1');
  });

  it('status pill: operational renders the ready dot + label; the fetch carries NO Authorization header (public endpoint)', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({
        me: { name: 'A', tier: 'solo_manual' },
        status: { overall_status: 'operational', recent_incidents: [] },
      }),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-status-widget]')).toBe(false);
    expect(text(window, '[data-status-text]')).toBe('All systems operational');
    const statusCall = fetchCalls.find((c) => /\/v1\/status$/.test(c.url));
    expect(statusCall).toBeDefined();
    const headers = (statusCall?.init?.headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('authorization');
  });

  it('status pill: major_outage + recent incidents renders the err dot and the incident count', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({
        me: { name: 'A', tier: 'solo_manual' },
        status: { overall_status: 'major_outage', recent_incidents: [{ id: 'i1' }, { id: 'i2' }] },
      }),
    });
    win = window;
    await flush();
    expect(text(window, '[data-status-text]')).toBe('Major outage · 2 recent incidents');
    expect(
      window.document.querySelector('[data-status-dot]')?.classList.contains('status-dot--err'),
    ).toBe(true);
  });

  it('status pill: a failing /v1/status stays hidden (fail-open)', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({ me: { name: 'A', tier: 'solo_manual' }, statusFails: true }),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-status-widget]')).toBe(true);
  });
});
