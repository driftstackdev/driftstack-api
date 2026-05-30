// Behavioural coverage for the Audit Log page — apps/customer-dashboard/src/
// pages/audit-log.astro. Source-parity tests existed; this adds the rendered-
// outcome coverage: the inline script auth-gates, fetches
// /v1/account/audit-log, renders each entry with its friendly action label +
// a per-action payload hint (login method, tier change from→to, profile
// cloned-from, …) + a UTC timestamp, and pages further results via next_cursor.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'audit-log', 'index.html');
const PAGE_URL = 'https://app.driftstack.dev/audit-log/';

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

function setUpDom(
  html: string,
  opts: SetUpOpts,
): { window: JSDOM['window']; fetchCalls: MockFetchCall[] } {
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
  if (opts.token !== undefined) window.localStorage.setItem('ds_web_session_token', opts.token);
  // @ts-expect-error — injected by DashboardLayout
  window.dashboardHydrated = () => {};
  // @ts-expect-error — injected by DashboardLayout
  window.driftstackActAsHeaders = () => ({});

  const pageScript = scriptBodies.find((s) => s.includes('data-page="audit-log"'));
  if (!pageScript) throw new Error('audit-log inline script not found');
  // @ts-expect-error — jsdom global has eval
  window.eval(pageScript);
  return { window: window as JSDOM['window'], fetchCalls };
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

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

let win: JSDOM['window'] | undefined;
afterEach(() => {
  win?.close?.();
  win = undefined;
});

describe('customer-dashboard Audit Log (audit-log.astro) behaviour', () => {
  it('no session token: shows the inline sign-in prompt and makes no API call', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: () => {
        throw new Error('must not fetch when unauthenticated');
      },
    });
    win = window;
    await flush();
    expect(fetchCalls.length).toBe(0);
    expect(text(window, '[data-list]')).toContain('Sign in to view audit log');
  });

  it('renders entries with friendly labels, per-action payload hints, raw action + UTC timestamp', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: () =>
        json({
          data: [
            {
              action: 'account.login',
              timestamp: '2026-05-20T10:00:00.000Z',
              payload: { method: 'password' },
            },
            {
              action: 'subscription.tier_changed',
              timestamp: '2026-05-21T08:30:15.000Z',
              payload: { from: 'free', to: 'api_builder' },
            },
            {
              action: 'profile.created',
              timestamp: '2026-05-22T00:00:00.000Z',
              payload: { cloned_from: 'prof_src1' },
              target_resource_id: 'prof_new1',
            },
          ],
          next_cursor: null,
        }),
    });
    win = window;
    await flush();
    const list = text(window, '[data-list]');
    // Friendly action labels.
    expect(list).toContain('Login');
    expect(list).toContain('Subscription changed');
    expect(list).toContain('Profile created');
    // Per-action payload hints.
    expect(list).toContain('via password');
    expect(list).toContain('free → api_builder');
    expect(list).toContain('cloned from prof_src1');
    // Raw action id + target on the secondary line.
    expect(list).toContain('account.login');
    expect(list).toContain('prof_new1');
    // UTC timestamp formatting (fmtTs: "YYYY-MM-DD HH:MM:SS UTC").
    expect(list).toContain('2026-05-20 10:00:00 UTC');
  });

  it('empty result: reveals the empty state, hides the list', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: () => json({ data: [], next_cursor: null }),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-empty]')).toBe(false);
    expect(isHidden(window, '[data-list]')).toBe(true);
  });

  it('fetch failure: surfaces the error banner', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: () => json({ detail: 'nope' }, 500),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-banner]')).toBe(false);
    expect(text(window, '[data-banner]')).toContain("Couldn't load audit log");
  });

  it('cursor pagination: Load more fetches the next page with the cursor and appends', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) => {
        if (/cursor=cur2/.test(call.url)) {
          return json({
            data: [{ action: 'session.created', timestamp: '2026-05-23T00:00:00.000Z' }],
            next_cursor: null,
          });
        }
        return json({
          data: [{ action: 'api_key.minted', timestamp: '2026-05-22T00:00:00.000Z' }],
          next_cursor: 'cur2',
        });
      },
    });
    win = window;
    await flush();
    // Page 1 rendered; load-more is revealed because next_cursor is present.
    expect(text(window, '[data-list]')).toContain('API key created');
    expect(isHidden(window, '[data-load-more-row]')).toBe(false);
    // Click Load more → second page fetched with cursor + appended.
    const btn = window.document.querySelector('[data-load-more]') as HTMLButtonElement;
    btn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush();
    const page2Call = fetchCalls.find((c) => /cursor=cur2/.test(c.url));
    expect(page2Call).toBeTruthy();
    const list = text(window, '[data-list]');
    expect(list).toContain('API key created');
    expect(list).toContain('Session created');
    // Cursor exhausted → load-more hidden again.
    expect(isHidden(window, '[data-load-more-row]')).toBe(true);
  });
});
