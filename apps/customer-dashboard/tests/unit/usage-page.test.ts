// Behavioural coverage for the Usage page — apps/customer-dashboard/src/pages/
// usage.astro. The page had source-parity tests but no behavioural one: its
// inline script auth-gates, fetches /v1/usage + /v1/usage/series, then replaces
// the SSG mock tiles with live totals (incl. a combined captures = state +
// screenshot sum) and recomputes the sparkline SVG paths from the series
// buckets. These tests load the BUILT page, run the script in jsdom against a
// mock fetch, and assert the rendered outcome.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installDashboardDeadline } from './dashboard-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'usage', 'index.html');
const PAGE_URL = 'https://app.driftstack.dev/usage/';

function loadBuiltPage(): string {
  return readFileSync(BUILT_PAGE, 'utf8');
}

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface SetUpOpts {
  token?: string;
  storageDenied?: boolean;
  route: (call: MockFetchCall) => Response | Promise<Response>;
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
  // @ts-expect-error — injected by DashboardLayout
  window.dashboardHydrated = () => {
    hydrated += 1;
  };
  // @ts-expect-error — injected by DashboardLayout
  window.driftstackActAsHeaders = () => ({});

  const pageScript = scriptBodies.find((s) => s.includes('data-page="usage"'));
  if (!pageScript) throw new Error('usage inline script not found');
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
  summary?: Record<string, unknown>;
  summaryStatus?: number;
  series?: Record<string, unknown>;
  seriesStatus?: number;
}

function makeRouter(opts: RouterOpts): (c: MockFetchCall) => Response {
  return (call) => {
    const u = call.url;
    if (/\/v1\/usage\/series/.test(u))
      return json(opts.series ?? { buckets: [] }, opts.seriesStatus ?? 200);
    if (/\/v1\/usage$/.test(u)) return json(opts.summary ?? {}, opts.summaryStatus ?? 200);
    return json({}, 404);
  };
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

const TOTALS = {
  session_minute: 12345,
  navigate: 5678,
  interact: 90,
  screenshot_capture: 3,
  state_capture: 5,
};

let win: JSDOM['window'] | undefined;
afterEach(() => {
  win?.close?.();
  win = undefined;
});

describe('customer-dashboard Usage (usage.astro) behaviour', () => {
  it('no session token: shows the sign-in banner, releases hydration, and keeps chart controls inert', async () => {
    const { window, fetchCalls, hydratedCount } = setUpDom(loadBuiltPage(), {
      route: () => {
        throw new Error('must not fetch when unauthenticated');
      },
    });
    win = window;
    await flush();
    expect(fetchCalls.length).toBe(0);
    expect(isHidden(window, '[data-banner]')).toBe(false);
    expect(text(window, '[data-banner]')).toContain('Sign in to see live usage');
    expect(hydratedCount()).toBe(1);
    for (const button of window.document.querySelectorAll<HTMLButtonElement>('[data-usage-days]')) {
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(button.title).toContain('sign-in');
    }
  });

  it('storage denial follows the same hydrated signed-out path without a network request', async () => {
    const { window, fetchCalls, hydratedCount } = setUpDom(loadBuiltPage(), {
      storageDenied: true,
      route: () => {
        throw new Error('must not fetch when storage is unavailable');
      },
    });
    win = window;
    await flush();

    expect(fetchCalls).toHaveLength(0);
    expect(hydratedCount()).toBe(1);
    expect(text(window, '[data-banner]')).toContain('Sign in to see live usage');
    expect(
      Array.from(window.document.querySelectorAll<HTMLButtonElement>('[data-usage-days]')).every(
        (button) => button.disabled,
      ),
    ).toBe(true);
  });

  it('live data: replaces tiles with API totals, computes the combined captures sum, and updates period + tier', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({
        summary: {
          tier: 'api_builder',
          period_start: '2026-05-01T00:00:00.000Z',
          period_end: '2026-05-31T23:59:59.000Z',
          totals: TOTALS,
        },
        series: { buckets: [] },
      }),
    });
    win = window;
    await flush();
    // Per-metric tiles (en-US grouped, computed so the assertion is ICU-stable).
    expect(text(window, '[data-stat="session_minute"]')).toBe((12345).toLocaleString('en-US'));
    expect(text(window, '[data-stat="navigate"]')).toBe((5678).toLocaleString('en-US'));
    expect(text(window, '[data-stat="interact"]')).toBe('90');
    expect(text(window, '[data-stat="screenshot_capture"]')).toBe('3');
    expect(text(window, '[data-stat="state_capture"]')).toBe('5');
    // Combined captures tile = state_capture + screenshot_capture = 8.
    expect(text(window, '[data-stat="captures_total"]')).toBe('8');
    // Period line carries the live window + tier. (The nested [data-field="tier"]
    // span is intentionally overwritten when periodEl.textContent is replaced —
    // the tier survives as text within the period line, which is what shows.)
    // The tier id is mapped to its human plan name via TIER_DISPLAY_NAMES
    // (api_builder → "API Builder"), matching the index/billing pages, so the
    // customer never sees the raw backend id.
    expect(text(window, '[data-field="period"]')).toContain('2026-05-01');
    expect(text(window, '[data-field="period"]')).toContain('2026-05-31');
    expect(text(window, '[data-field="period"]')).toContain('API Builder tier');
    expect(
      fetchCalls.filter((call) => /\/v1\/usage\/series\?days=30$/.test(call.url)),
    ).toHaveLength(1);
    expect(fetchCalls.every((call) => call.init?.signal instanceof window.AbortSignal)).toBe(true);
  });

  it('sparkline: the navigate path is recomputed from the series buckets', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({
        summary: {
          tier: 'api_builder',
          period_start: '2026-05-01',
          period_end: '2026-05-31',
          totals: TOTALS,
        },
        // Two buckets, navigate 0 → 10. With SPARK_W=200, SPARK_H=48:
        // max=10, stepX=200; i0 → (0, 48); i1 → (200, 0).
        series: {
          buckets: [{ totals: { navigate: 0 } }, { totals: { navigate: 10 } }],
        },
      }),
    });
    win = window;
    await flush();
    const d = window.document.querySelector('[data-spark="navigate"]')?.getAttribute('d');
    expect(d).toBe('M 0.0 48.0 L 200.0 0.0');
  });

  it('all-zero totals: surfaces the "no activity yet" banner', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({
        summary: {
          tier: 'free',
          period_start: '2026-05-01',
          period_end: '2026-05-31',
          totals: {
            session_minute: 0,
            navigate: 0,
            interact: 0,
            screenshot_capture: 0,
            state_capture: 0,
          },
        },
        series: { buckets: [] },
      }),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-banner]')).toBe(false);
    expect(text(window, '[data-banner]')).toContain('No activity in the current period yet');
  });

  it('fetch failure: surfaces the preview-fallback banner and still fires the opacity-gate', async () => {
    const { window, hydratedCount } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({ summaryStatus: 500, series: { buckets: [] } }),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-banner]')).toBe(false);
    expect(text(window, '[data-banner]')).toContain("Couldn't load live usage");
    expect(hydratedCount()).toBeGreaterThanOrEqual(1);
  });

  it('daily chart: an all-zero series renders the honest empty state, not a fabricated chart (slice 3.4; expected until the V-014/V-015 usage writers land)', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({
        summary: {
          period_start: '2026-06-01T00:00:00Z',
          period_end: '2026-06-30T00:00:00Z',
          tier: 'solo_manual',
          totals: {},
        },
        series: {
          buckets: [
            { date: '2026-06-01', totals: {} },
            { date: '2026-06-02', totals: { navigate: 0 } },
          ],
        },
      }),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-daily-empty]')).toBe(false);
    expect(isHidden(window, '[data-daily-chart]')).toBe(true);
  });

  it('daily chart: a series failure stays distinct from an honest zero-activity result', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({
        summary: {
          period_start: '2026-06-01T00:00:00Z',
          period_end: '2026-06-30T00:00:00Z',
          tier: 'solo_manual',
          totals: TOTALS,
        },
        seriesStatus: 503,
      }),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-daily-empty]')).toBe(true);
    expect(text(window, '[data-banner]')).toContain("Couldn't load live usage");
  });

  it('daily chart: non-zero buckets sum every usage type into one bar per day + a first/last-day legend', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({
        summary: {
          period_start: '2026-06-01T00:00:00Z',
          period_end: '2026-06-30T00:00:00Z',
          tier: 'solo_manual',
          totals: TOTALS,
        },
        series: {
          buckets: [
            { date: '2026-06-01', totals: { session_minute: 10, navigate: 5 } },
            { date: '2026-06-02', totals: {} },
            { date: '2026-06-03', totals: { interact: 40 } },
          ],
        },
      }),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-daily-chart]')).toBe(false);
    const bars = window.document.querySelectorAll('[data-daily-chart] span');
    expect(bars.length).toBe(3);
    expect(text(window, '[data-daily-legend]')).toContain('2026-06-01');
    expect(text(window, '[data-daily-legend]')).toContain('2026-06-03');
  });

  it('daily chart: the 7/30/90 window buttons re-fetch the series with the chosen days + toggle aria-pressed', async () => {
    const calls: string[] = [];
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) => {
        if (/\/v1\/usage\/series/.test(call.url)) {
          calls.push(call.url);
          return json({ buckets: [{ date: '2026-06-01', totals: { navigate: 3 } }] });
        }
        if (/\/v1\/usage$/.test(call.url))
          return json({
            period_start: '2026-06-01T00:00:00Z',
            period_end: '2026-06-30T00:00:00Z',
            tier: 'solo_manual',
            totals: {},
          });
        return json({}, 404);
      },
    });
    win = window;
    await flush();
    const btn7 = window.document.querySelector('[data-usage-days="7"]') as HTMLButtonElement;
    btn7.dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush();
    expect(calls.some((u) => /days=7\b/.test(u))).toBe(true);
    expect(btn7.getAttribute('aria-pressed')).toBe('true');
    expect(
      window.document.querySelector('[data-usage-days="30"]')?.getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('daily chart: rapid window changes are latest-wins and expose busy state without stale redraws', async () => {
    let resolve7: ((value: Response) => void) | undefined;
    let resolve90: ((value: Response) => void) | undefined;
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) => {
        if (/\/v1\/usage\/series\?days=7$/.test(call.url)) {
          return new Promise<Response>((resolve) => {
            resolve7 = resolve;
          });
        }
        if (/\/v1\/usage\/series\?days=90$/.test(call.url)) {
          return new Promise<Response>((resolve) => {
            resolve90 = resolve;
          });
        }
        if (/\/v1\/usage\/series/.test(call.url)) return json({ buckets: [] });
        if (/\/v1\/usage$/.test(call.url)) {
          return json({
            period_start: '2026-06-01T00:00:00Z',
            period_end: '2026-06-30T00:00:00Z',
            tier: 'solo_manual',
            totals: TOTALS,
          });
        }
        return json({ buckets: [] });
      },
    });
    win = window;
    await flush();

    const btn7 = window.document.querySelector('[data-usage-days="7"]') as HTMLButtonElement;
    const btn90 = window.document.querySelector('[data-usage-days="90"]') as HTMLButtonElement;
    btn7.click();
    btn90.click();
    expect(btn90.getAttribute('aria-busy')).toBe('true');
    expect(btn90.disabled).toBe(true);
    expect(btn90.getAttribute('aria-disabled')).toBe('true');
    expect(btn7.disabled).toBe(false);
    expect(
      window.document.querySelector('[data-section="daily-activity"]')?.getAttribute('aria-busy'),
    ).toBe('true');

    resolve90?.(
      json({
        buckets: [
          { date: '2026-09-01', totals: { navigate: 1 } },
          { date: '2026-09-30', totals: { navigate: 2 } },
        ],
      }),
    );
    await flush();
    expect(text(window, '[data-daily-legend]')).toContain('2026-09-30');
    expect(btn90.hasAttribute('aria-busy')).toBe(false);
    expect(btn90.disabled).toBe(false);
    expect(btn90.getAttribute('aria-disabled')).toBe('false');

    resolve7?.(
      json({
        buckets: [
          { date: '2026-07-01', totals: { navigate: 9 } },
          { date: '2026-07-07', totals: { navigate: 9 } },
        ],
      }),
    );
    await flush();
    expect(text(window, '[data-daily-legend]')).toContain('2026-09-30');
    expect(text(window, '[data-daily-legend]')).not.toContain('2026-07-07');
  });
});
