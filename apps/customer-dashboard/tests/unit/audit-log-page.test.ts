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
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
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
    expect(fetchCalls.every((call) => call.init?.signal instanceof window.AbortSignal)).toBe(true);
    expect(
      window.document.querySelector('[data-page="audit-log"]')?.hasAttribute('aria-busy'),
    ).toBe(false);
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

  it('fetch failure on initial load: clears the SSR skeleton + shows a retry row instead of pulsing forever', async () => {
    let calls = 0;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: () => {
        calls++;
        return json({ detail: 'nope' }, 500);
      },
    });
    win = window;
    await flush();
    // The skeleton <li>s (no data-action) are gone — replaced by a
    // single retry row, not left pulsing forever.
    expect(window.document.querySelectorAll('[data-list] > li').length).toBe(1);
    const retryBtn = window.document.querySelector(
      '[data-action="retry-audit-log"]',
    ) as HTMLButtonElement | null;
    expect(retryBtn).toBeTruthy();
    expect(isHidden(window, '[data-list]')).toBe(false);
    // Clicking retry re-fetches the first page.
    retryBtn?.click();
    await flush();
    expect(calls).toBe(2);
    expect(fetchCalls.length).toBe(2);
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
    btn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush();
    const page2Calls = fetchCalls.filter((c) => /cursor=cur2/.test(c.url));
    const page2Call = page2Calls[0];
    expect(page2Call).toBeTruthy();
    expect(page2Calls).toHaveLength(1);
    expect(page2Call?.init?.signal).toBeInstanceOf(window.AbortSignal);
    const list = text(window, '[data-list]');
    expect(list).toContain('API key created');
    expect(list).toContain('Session created');
    // Cursor exhausted → load-more hidden again.
    expect(isHidden(window, '[data-load-more-row]')).toBe(true);
    expect(btn.disabled).toBe(false);
    expect(btn.hasAttribute('aria-busy')).toBe(false);
  });

  it('filter refresh aborts and ignores the superseded page response', async () => {
    let resolveInitial: ((value: Response) => void) | undefined;
    let listCalls = 0;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: () => {
        listCalls++;
        if (listCalls === 1) {
          return new Promise<Response>((resolve) => {
            resolveInitial = resolve;
          });
        }
        return json({
          data: [{ action: 'account.login', timestamp: '2026-05-24T00:00:00.000Z' }],
          next_cursor: null,
        });
      },
    });
    win = window;
    const filter = window.document.querySelector('[data-filter]') as HTMLSelectElement;
    filter.value = 'account.login';
    filter.dispatchEvent(new window.Event('change', { bubbles: true }));
    await flush();
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]?.init?.signal?.aborted).toBe(true);
    expect(text(window, '[data-list]')).toContain('Login');

    resolveInitial?.(
      json({
        data: [{ action: 'subscription.tier_changed', timestamp: '2026-05-20T00:00:00.000Z' }],
        next_cursor: null,
      }),
    );
    await flush();
    expect(text(window, '[data-list]')).toContain('Login');
    expect(text(window, '[data-list]')).not.toContain('Subscription changed');
  });

  it('serializes CSV/JSON export attempts and restores both controls', async () => {
    let releaseExport: (response: Response) => void = () => {};
    const pendingExport = new Promise<Response>((resolve) => {
      releaseExport = resolve;
    });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) =>
        /\/export\?format=/.test(call.url) ? pendingExport : json({ data: [], next_cursor: null }),
    });
    win = window;
    await flush();
    const csv = window.document.querySelector('[data-export-csv]') as HTMLButtonElement;
    const jsonBtn = window.document.querySelector('[data-export-json]') as HTMLButtonElement;
    csv.click();
    jsonBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flush();
    const exports = fetchCalls.filter((call) => /\/export\?format=/.test(call.url));
    expect(exports).toHaveLength(1);
    expect(exports[0]?.init?.signal).toBeInstanceOf(window.AbortSignal);
    expect(csv.disabled).toBe(true);
    expect(csv.getAttribute('aria-busy')).toBe('true');
    expect(csv.textContent?.trim()).toBe('Exporting CSV…');
    expect(jsonBtn.disabled).toBe(true);
    expect(jsonBtn.hasAttribute('aria-busy')).toBe(false);
    expect(jsonBtn.textContent?.trim()).toBe('Export JSON');

    releaseExport(json({ detail: 'Export temporarily unavailable' }, 503));
    await flush();
    expect(csv.disabled).toBe(false);
    expect(jsonBtn.disabled).toBe(false);
    expect(csv.hasAttribute('aria-busy')).toBe(false);
    expect(jsonBtn.hasAttribute('aria-busy')).toBe(false);
    expect(csv.textContent?.trim()).toBe('Export CSV');
    expect(jsonBtn.textContent?.trim()).toBe('Export JSON');
  });
});
