// Local integration test for the /sessions page's inline script.
// Sessions are the product's only billing meter (concurrent caps), and
// this page is the customer's live read-model of them — yet it had only
// source-regex coverage (status-badge-class / endpoints / content
// parity) before; none of those exercise the actual render. This loads
// the BUILT page, mocks localStorage + fetch, eval's the script, and
// asserts the real hydrated-DOM branches.
//
// The load-bearing behaviours, none of which a regex can see:
//   • active/recent PARTITION by status (active = not destroyed/errored).
//   • the V-186 concurrent meter, whose two halves update INDEPENDENTLY
//     (now from /v1/sessions, cap from /v1/usage.tier) so a usage 5xx
//     still surfaces the live active count — a regression here would
//     blank the meter on any usage hiccup.
//   • the three banner states: no-token preview, empty list, fetch error.
//   • the egress proxy-warning badge (Arc 5 eg.5).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'sessions', 'index.html');
const PAGE_URL = 'https://app.driftstack.dev/sessions/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface SetUpOpts {
  token?: string;
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
  if (opts.token !== undefined) window.localStorage.setItem('ds_web_session_token', opts.token);

  const pageScript = scriptBodies.find((s) => s.includes('data-page="sessions"'));
  if (!pageScript) throw new Error('sessions inline script not found');
  // @ts-expect-error — jsdom global has eval
  window.eval(pageScript);
  return { window: window as JSDOM['window'], fetchCalls };
}

function isHidden(window: JSDOM['window'], selector: string): boolean {
  const el = window.document.querySelector(selector);
  if (!el) throw new Error(`selector not found: ${selector}`);
  return el.classList.contains('hidden');
}

function text(window: JSDOM['window'], selector: string): string {
  return window.document.querySelector(selector)?.textContent ?? '';
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

function makeSession(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sess_' + Math.random().toString(36).slice(2, 8),
    status: 'ready',
    archetype: 'iphone16pro_ios18_7_safari26_4',
    profile_id: null,
    created_at: '2026-05-29T10:00:00.000Z',
    destroyed_at: null,
    ...over,
  };
}

// Route both load fetches. `usage` defaults to a tier whose cap (24)
// differs from the SSG mock default (api_builder = 8) so a meter
// assertion proves the live value won, not the baked-in one.
function makeRouter(opts: {
  sessions?: Array<Record<string, unknown>>;
  sessionsStatus?: number;
  usageTier?: string | null;
  usageStatus?: number;
}): (c: MockFetchCall) => Response {
  return (call: MockFetchCall): Response => {
    const u = call.url;
    if (/\/v1\/sessions$/.test(u)) {
      if (opts.sessionsStatus && opts.sessionsStatus >= 400) return json({}, opts.sessionsStatus);
      return json({ data: opts.sessions ?? [] });
    }
    if (/\/v1\/usage$/.test(u)) {
      if (opts.usageStatus && opts.usageStatus >= 400) return json({}, opts.usageStatus);
      return json({ tier: opts.usageTier ?? 'api_builder' });
    }
    // eslint-disable-next-line no-console
    console.warn('[sessions-page test] unrouted fetch:', u);
    return json({}, 500);
  };
}

describe('sessions page — local integration', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });
  const loadBuiltPage = (): string => readFileSync(BUILT_PAGE, 'utf8');

  it('no token: shows the sign-in preview banner and fires NO fetch', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: makeRouter({}),
    });
    win = window;
    await flush();
    expect(fetchCalls.length).toBe(0);
    expect(isHidden(window, '[data-banner]')).toBe(false);
    expect(text(window, '[data-banner]')).toContain('Sign in to see live sessions');
  });

  it('empty list: both empty states show, lists hide, "no sessions yet" banner', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({ sessions: [] }),
    });
    win = window;
    await flush();
    expect(fetchCalls.some((c) => /\/v1\/sessions$/.test(c.url))).toBe(true);
    expect(isHidden(window, '[data-empty="active"]')).toBe(false);
    expect(isHidden(window, '[data-list="active"]')).toBe(true);
    expect(isHidden(window, '[data-empty="recent"]')).toBe(false);
    expect(text(window, '[data-banner]')).toContain('No sessions yet');
    expect(text(window, '[data-count="active"]')).toBe('0');
    expect(text(window, '[data-field="meter-now"]')).toBe('0');
  });

  it('partitions by status: ready/busy → active, destroyed/errored → recent', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({
        sessions: [
          makeSession({ id: 'sess_live', status: 'ready' }),
          makeSession({ id: 'sess_busy', status: 'busy' }),
          makeSession({
            id: 'sess_gone',
            status: 'destroyed',
            destroyed_at: '2026-05-29T11:00:00.000Z',
          }),
          makeSession({
            id: 'sess_err',
            status: 'errored',
            destroyed_at: '2026-05-29T11:30:00.000Z',
          }),
        ],
      }),
    });
    win = window;
    await flush();
    expect(text(window, '[data-count="active"]')).toBe('2');
    expect(text(window, '[data-count="recent"]')).toBe('2');
    const activeText = text(window, '[data-list="active"]');
    expect(activeText).toContain('sess_live');
    expect(activeText).toContain('sess_busy');
    expect(activeText).not.toContain('sess_gone');
    // Archetype renders as the friendly registry label, never the raw slug
    // (consistent with the profiles + overview pages).
    expect(activeText).toContain('iPhone 16 Pro / iOS 18.7 / Safari 26.4');
    expect(activeText).not.toContain('iphone16pro_ios18_7_safari26_4');
    const recentText = text(window, '[data-list="recent"]');
    expect(recentText).toContain('sess_gone');
    expect(recentText).toContain('sess_err');
    // active rows expose Open + Destroy affordances; recent rows expose a recording link.
    expect(activeText).toContain('Destroy');
    expect(recentText).toContain('View recording');
  });

  it('concurrent meter: now = active count, cap = usage tier limit', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({
        sessions: [makeSession({ status: 'ready' }), makeSession({ status: 'creating' })],
        usageTier: 'api_scale', // → cap 24, distinct from the SSG mock default (8)
      }),
    });
    win = window;
    await flush();
    expect(text(window, '[data-field="meter-now"]')).toBe('2');
    expect(text(window, '[data-field="meter-cap"]')).toBe('24');
    expect(text(window, '[data-field="header-cap"]')).toBe('24');
  });

  it('partial failure: usage 5xx still surfaces the live active count (V-186)', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({
        sessions: [
          makeSession({ status: 'ready' }),
          makeSession({ status: 'ready' }),
          makeSession({ status: 'busy' }),
        ],
        usageStatus: 500,
      }),
    });
    win = window;
    await flush();
    // `now` comes from /v1/sessions, so it renders even though usage failed…
    expect(text(window, '[data-field="meter-now"]')).toBe('3');
    // …and the cap stays at the neutral SSG placeholder ("—"), since the SSG
    // no longer bakes a fabricated cap and the usage fetch (which supplies the
    // real cap) failed. (Pre-2026-06-24 this baked in a mock "8".)
    expect(text(window, '[data-field="meter-cap"]')).toBe('—');
    // sessions loaded fine, so no error banner.
    expect(isHidden(window, '[data-banner]')).toBe(true);
  });

  it('sessions fetch error: surfaces the "couldn\'t load" banner', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({ sessionsStatus: 503 }),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-banner]')).toBe(false);
    expect(text(window, '[data-banner]')).toContain("Couldn't load live sessions");
  });

  it('egress proxy warnings render a ⚠ badge on the row (Arc 5 eg.5)', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter({
        sessions: [
          makeSession({
            id: 'sess_warn',
            status: 'ready',
            egress_capabilities: {
              warnings: ['udp_unsupported_by_proxy', 'dns_remote_resolve_unsupported_by_proxy'],
            },
          }),
        ],
      }),
    });
    win = window;
    await flush();
    const activeText = text(window, '[data-list="active"]');
    expect(activeText).toContain('⚠ proxy 2');
  });
});
