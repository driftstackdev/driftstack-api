// Behavioural coverage for the admin Cost page —
// apps/admin-panel/src/pages/cost.astro. Focused on the config-load path,
// where the operator reads the rate card + per-tier thresholds. Pins the
// 2-decimal threshold formatting (a $15.50 cap must render "$15.50", not the
// pre-fix "$15.5") so it stays consistent with the cents() helper used
// everywhere else on the page. Loads the built dist page + runs the inline
// script in jsdom against a mock fetch.
//
// NOTE: the admin Cost page reads its bearer from localStorage key
// "ds_web_session_token" — the SAME key the AdminLayout SSO bridge writes and
// every other admin page reads. (It previously read a never-set
// "driftstack:admin_token", so the page always showed "No admin token found";
// the cross-page token-key guard now prevents that drift.)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'cost', 'index.html');
const PAGE_URL = 'https://admin.driftstack.dev/cost/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface SetUpOpts {
  adminToken?: string;
  beforeEval?: (window: JSDOM['window']) => void;
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
  if (opts.adminToken !== undefined) {
    window.localStorage.setItem('ds_web_session_token', opts.adminToken);
  }
  // @ts-expect-error — injected by AdminLayout
  window.dashboardHydrated = () => {};
  opts.beforeEval?.(window);

  const deadlineScript = scriptBodies.find((s) => s.includes('driftstackFetchWithDeadline'));
  if (!deadlineScript) throw new Error('admin deadline inline script not found');
  const pageScript = scriptBodies.find((s) => s.includes('data-page="admin-cost"'));
  if (!pageScript) throw new Error('admin-cost inline script not found');
  // @ts-expect-error — jsdom global has eval
  window.eval(deadlineScript);
  // @ts-expect-error — jsdom global has eval
  window.eval(pageScript);
  return { window: window as JSDOM['window'], fetchCalls };
}

function text(window: JSDOM['window'], selector: string): string {
  return window.document.querySelector(selector)?.textContent?.trim() ?? '';
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

describe('admin-panel Cost (cost.astro) config-load behaviour', () => {
  it('keeps the deadline armed while response JSON is pending, then aborts the stalled body', async () => {
    let fireDeadline = () => undefined;
    let clearCalls = 0;
    let requestSignal: AbortSignal | null = null;
    const stalled = new Response('{}');
    Object.defineProperty(stalled, 'json', {
      configurable: true,
      value: () => new Promise<never>(() => undefined),
    });
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) => {
        requestSignal = call.init?.signal ?? null;
        return stalled;
      },
      beforeEval: (target) => {
        target.setTimeout = ((handler: TimerHandler) => {
          fireDeadline = () => {
            if (typeof handler === 'function') handler();
          };
          return 1;
        }) as typeof target.setTimeout;
        target.clearTimeout = (() => {
          clearCalls += 1;
        }) as typeof target.clearTimeout;
      },
    });
    win = window;
    await flush();

    expect(clearCalls).toBe(0);
    expect(requestSignal?.aborted).toBe(false);
    fireDeadline();
    expect(requestSignal?.aborted).toBe(true);
  });

  it('clears the deadline after response JSON settles', async () => {
    let clearCalls = 0;
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: () => json({ rates: {}, tierThresholds: {} }),
      beforeEval: (target) => {
        target.setTimeout = (() => 1) as typeof target.setTimeout;
        target.clearTimeout = (() => {
          clearCalls += 1;
        }) as typeof target.clearTimeout;
      },
    });
    win = window;
    await flush();

    expect(clearCalls).toBe(1);
  });

  it('no admin token: surfaces a missing-admin-token message rather than silently failing', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      route: () => {
        throw new Error('must not fetch without an admin token');
      },
    });
    win = window;
    await flush();
    expect(fetchCalls.length).toBe(0);
    expect(text(window, '[data-banner]')).toContain('admin token');
    expect(
      (window.document.querySelector('input[name="account_id"]') as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (window.document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (window.document.querySelector('[data-button="refresh-top"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (window.document.querySelector('[data-button="export-top-csv"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('config load: renders the rate card and per-tier thresholds at 2-decimal precision', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) => {
        if (/\/v1\/admin\/cost\/config$/.test(call.url)) {
          return json({
            rates: {
              computeCentsPerMinute: 0.5,
              storageCentsPerGbMonth: 2,
              egressCentsPerGb: 1,
              emailCentsPerSend: 0.1,
              llmCentsPer1kInputTokens: 0.05,
              llmCentsPer1kOutputTokens: 0.25,
            },
            tierThresholds: {
              api_builder: { softCents: 1550, hardCents: 5000 },
            },
          });
        }
        return json({}, 404);
      },
    });
    win = window;
    await flush();
    // Rate card shows the compute rate + unit.
    const rateCard = text(window, '[data-field="rate-card"]');
    expect(rateCard).toContain('0.5');
    expect(rateCard).toContain('cents / minute');
    // Thresholds render at 2 decimals — the fix: 1550c → "$15.50" (not "$15.5"),
    // 5000c → "$50.00", consistent with the page's cents() helper.
    const thresholds = text(window, '[data-field="tier-thresholds"]');
    expect(thresholds).toContain('api_builder');
    expect(thresholds).toContain('soft $15.50');
    expect(thresholds).toContain('hard $50.00');
    expect(thresholds).not.toContain('$15.5 ');
    expect(
      fetchCalls.find((call) => /\/v1\/admin\/cost\/config$/.test(call.url))?.init?.signal,
    ).toBeTruthy();
    expect(
      (window.document.querySelector('input[name="account_id"]') as HTMLInputElement).disabled,
    ).toBe(false);
    expect(
      (window.document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (window.document.querySelector('[data-button="refresh-top"]') as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (window.document.querySelector('[data-button="export-top-csv"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('uses one 15s timer-cleaned boundary and defers config hydration for fresh SSO', () => {
    const built = readFileSync(BUILT_PAGE, 'utf8');
    expect(built).toContain('COST_REQUEST_TIMEOUT_MS = 15_000');
    expect(built).toContain('Request timed out. Check the connection and try again.');
    expect(built).toMatch(/signal: controller\.signal/);
    expect(built).toContain('window.driftstackFetchWithDeadline(');
    expect(built).toMatch(/window\.clearTimeout\(timeout\)/);
    expect(built).toMatch(
      /document\.addEventListener\('DOMContentLoaded', start, \{ once: true \}\)/,
    );
  });

  it('config endpoint error: uses staff-safe service copy without endpoint/status/body leakage', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: () => json({ detail: 'database host db.internal:5432 secret=abc' }, 500),
    });
    win = window;
    await flush();
    const banner = text(window, '[data-banner]');
    expect(banner).toContain('admin service is temporarily unavailable');
    expect(banner).not.toMatch(/\/v1\/|500|db\.internal|secret=abc/);
  });

  it('CRITICAL config endpoint error: Rate Card / Tier Thresholds tiles clear out of the perpetual loading-skeleton animation instead of pulsing forever (audit waefer6wu)', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: () => json({ detail: 'boom' }, 500),
    });
    win = window;
    await flush();
    const rateCard = window.document.querySelector('[data-field="rate-card"]');
    const tierThresholds = window.document.querySelector('[data-field="tier-thresholds"]');
    expect(rateCard?.querySelector('.animate-pulse')).toBeNull();
    expect(tierThresholds?.querySelector('.animate-pulse')).toBeNull();
    expect(text(window, '[data-field="rate-card"]')).toContain(
      'admin service is temporarily unavailable',
    );
    expect(text(window, '[data-field="tier-thresholds"]')).toContain(
      'admin service is temporarily unavailable',
    );
  });

  it('no admin token: tiles also clear the skeleton (the authedFetch throw is the same failure path as a non-ok response)', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      route: () => {
        throw new Error('must not fetch without an admin token');
      },
    });
    win = window;
    await flush();
    const rateCard = window.document.querySelector('[data-field="rate-card"]');
    const tierThresholds = window.document.querySelector('[data-field="tier-thresholds"]');
    expect(rateCard?.querySelector('.animate-pulse')).toBeNull();
    expect(tierThresholds?.querySelector('.animate-pulse')).toBeNull();
  });

  it('account query: strips the acc_ prefix, fetches the breakdown, and renders total + soft/hard at 2-decimals', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) => {
        if (/\/v1\/admin\/cost\/accounts\/test123/.test(call.url)) {
          return json({
            account_id: 'test123',
            billing_cycle: '2026-05',
            tier: 'api_builder',
            breakdown: {
              computeCents: 1000,
              storageCents: 500,
              egressCents: 200,
              emailCents: 100,
              llmCents: 300,
              totalCents: 2100,
              thresholdState: 'between-soft-and-hard',
            },
            thresholds: { softCents: 1550, hardCents: 5000 },
          });
        }
        return json({ rates: {}, tierThresholds: {} });
      },
    });
    win = window;
    await flush();
    const form = window.document.querySelector('[data-form="account-query"]') as HTMLFormElement;
    const input = form.querySelector('input[name="account_id"]') as HTMLInputElement;
    input.value = 'acc_test123';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    // The acc_ prefix is stripped before hitting the cost endpoint.
    expect(fetchCalls.some((c) => /\/v1\/admin\/cost\/accounts\/test123/.test(c.url))).toBe(true);
    const result = text(window, '[data-field="account-result"]');
    expect(result).toContain('$21.00'); // totalCents 2100
    expect(result).toContain('between-soft-and-hard'); // threshold state badge
    expect(result).toContain('$15.50'); // soft warn 1550c
    expect(result).toContain('$50.00'); // hard cap 5000c
  });

  it('account query failure uses staff-safe copy without account id/status/body leakage', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) => {
        if (/\/v1\/admin\/cost\/accounts\/private-account/.test(call.url)) {
          return json({ detail: 'driver token=secret at node.internal' }, 503);
        }
        return json({ rates: {}, tierThresholds: {} });
      },
    });
    win = window;
    await flush();
    const form = window.document.querySelector('[data-form="account-query"]') as HTMLFormElement;
    (form.querySelector('input[name="account_id"]') as HTMLInputElement).value =
      'acc_private-account';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    const banner = text(window, '[data-banner]');
    expect(banner).toContain('admin service is temporarily unavailable');
    expect(banner).not.toMatch(/private-account|503|node\.internal|token=secret|\/v1\//);
  });

  it('revokes a previous customer breakdown immediately and never leaves it visible after the next query fails', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) => {
        if (/\/v1\/admin\/cost\/accounts\/first-account/.test(call.url)) {
          return json({
            account_id: 'first-account',
            billing_cycle: '2026-07',
            tier: 'api_builder',
            breakdown: { totalCents: 4321, thresholdState: 'under-soft' },
            thresholds: { softCents: 10000, hardCents: 20000 },
          });
        }
        if (/\/v1\/admin\/cost\/accounts\/second-account/.test(call.url)) {
          return json({ detail: 'private upstream failure' }, 503);
        }
        return json({ rates: {}, tierThresholds: {} });
      },
    });
    win = window;
    await flush();
    const form = window.document.querySelector('[data-form="account-query"]') as HTMLFormElement;
    const input = form.querySelector('input[name="account_id"]') as HTMLInputElement;
    input.value = 'acc_first-account';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(text(window, '[data-field="account-result"]')).toContain('first-account');
    expect(text(window, '[data-field="account-result"]')).toContain('$43.21');

    input.value = 'acc_second-account';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    expect(text(window, '[data-field="account-result"]')).toContain(
      'Loading the current account cost',
    );
    expect(text(window, '[data-field="account-result"]')).not.toContain('first-account');
    await flush();
    const result = text(window, '[data-field="account-result"]');
    expect(result).toContain('Could not load the current account cost');
    expect(result).not.toMatch(/first-account|\$43\.21|second-account|503|private upstream/);
  });

  it('account query 404 + account DOES exist (admin-accounts lookup is 200): "exists but no usage" — distinct from "not found" (audit waefer6wu)', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) => {
        if (/\/v1\/admin\/cost\/accounts\//.test(call.url)) return json({ detail: 'none' }, 404);
        // The existence-check call (GET /v1/admin/accounts/:id) finds a
        // real account.
        if (/\/v1\/admin\/accounts\/acc_real123/.test(call.url)) {
          return json({ id: 'acc_real123', status: 'active' });
        }
        return json({ rates: {}, tierThresholds: {} });
      },
    });
    win = window;
    await flush();
    const form = window.document.querySelector('[data-form="account-query"]') as HTMLFormElement;
    (form.querySelector('input[name="account_id"]') as HTMLInputElement).value = 'acc_real123';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(text(window, '[data-banner]')).toContain('Account exists but has no usage');
    expect(text(window, '[data-banner]')).not.toContain('not found');
  });

  it('CRITICAL account query 404 + account does NOT exist (admin-accounts lookup also 404s): distinct "not found" message — without this an operator fat-fingering a UUID reads it as "confirmed zero usage" (audit waefer6wu)', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) => {
        if (/\/v1\/admin\/cost\/accounts\//.test(call.url)) return json({ detail: 'none' }, 404);
        // The existence-check call also 404s — the id is simply wrong.
        if (/\/v1\/admin\/accounts\/acc_typo99/.test(call.url)) return json({}, 404);
        return json({ rates: {}, tierThresholds: {} });
      },
    });
    win = window;
    await flush();
    const form = window.document.querySelector('[data-form="account-query"]') as HTMLFormElement;
    (form.querySelector('input[name="account_id"]') as HTMLInputElement).value = 'acc_typo99';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(text(window, '[data-banner]')).toContain('not found');
    expect(text(window, '[data-banner]')).not.toContain('no usage');
  });

  it('account query 404 + failed existence probe stays unknown instead of claiming zero usage', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) => {
        if (/\/v1\/admin\/cost\/accounts\//.test(call.url)) return json({}, 404);
        if (/\/v1\/admin\/accounts\/acc_uncertain/.test(call.url)) {
          return json({ detail: 'database host db.internal:5432' }, 503);
        }
        return json({ rates: {}, tierThresholds: {} });
      },
    });
    win = window;
    await flush();
    const form = window.document.querySelector('[data-form="account-query"]') as HTMLFormElement;
    (form.querySelector('input[name="account_id"]') as HTMLInputElement).value = 'acc_uncertain';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    const banner = text(window, '[data-banner]');
    expect(banner).toContain('admin service is temporarily unavailable');
    expect(banner).not.toMatch(/exists but has no usage|not found|503|db\.internal/);
  });

  it('top accounts: two-step fetch (accounts → overview) renders the money table', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) => {
        if (/\/v1\/admin\/accounts\?/.test(call.url)) {
          return json({ data: [{ id: 'acc_a1' }] });
        }
        if (/\/v1\/admin\/cost\/overview\?/.test(call.url)) {
          return json({
            summaries: [
              {
                account_id: 'a1',
                tier: 'api_builder',
                breakdown: { totalCents: 2100, thresholdState: 'between-soft-and-hard' },
                thresholds: { softCents: 1550, hardCents: 5000 },
              },
            ],
          });
        }
        return json({ rates: {}, tierThresholds: {} });
      },
    });
    win = window;
    await flush();
    const btn = window.document.querySelector('[data-button="refresh-top"]') as HTMLButtonElement;
    btn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush();
    const top = text(window, '[data-field="top-result"]');
    expect(top).toContain('a1');
    expect(top).toContain('api_builder');
    expect(top).toContain('$21.00');
    expect(top).toContain('$15.50');
    expect(top).toContain('$50.00');
    expect(
      (window.document.querySelector('[data-button="export-top-csv"]') as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it('revokes CSV authority while refreshing and keeps export disabled when the current top-accounts read fails', async () => {
    let accountsReads = 0;
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) => {
        if (/\/v1\/admin\/accounts\?/.test(call.url)) {
          accountsReads += 1;
          return accountsReads === 1
            ? json({ data: [{ id: 'acc_a1' }] })
            : json({ detail: 'new failure' }, 503);
        }
        if (/\/v1\/admin\/cost\/overview\?/.test(call.url)) {
          return json({
            summaries: [
              {
                account_id: 'a1',
                tier: 'api_builder',
                breakdown: { totalCents: 2100, thresholdState: 'under-soft' },
                thresholds: { softCents: 3000, hardCents: 5000 },
              },
            ],
          });
        }
        return json({ rates: {}, tierThresholds: {} });
      },
    });
    win = window;
    await flush();
    const refresh = window.document.querySelector(
      '[data-button="refresh-top"]',
    ) as HTMLButtonElement;
    const exportCsv = window.document.querySelector(
      '[data-button="export-top-csv"]',
    ) as HTMLButtonElement;
    refresh.click();
    await flush();
    expect(exportCsv.disabled).toBe(false);
    expect(text(window, '[data-field="top-result"]')).toContain('a1');

    refresh.click();
    expect(exportCsv.disabled).toBe(true);
    expect(text(window, '[data-field="top-result"]')).toContain('Loading');
    await flush();
    expect(exportCsv.disabled).toBe(true);
    expect(text(window, '[data-field="top-result"]')).toContain(
      'admin service is temporarily unavailable',
    );
    expect(text(window, '[data-field="top-result"]')).not.toContain('a1');
  });

  it('top-accounts failures use staff-safe copy without raw endpoint/status/body text', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) => {
        if (/\/v1\/admin\/accounts\?/.test(call.url)) {
          return json({ detail: 'redis://user:secret@cache.internal' }, 503);
        }
        return json({ rates: {}, tierThresholds: {} });
      },
    });
    win = window;
    await flush();
    const btn = window.document.querySelector('[data-button="refresh-top"]') as HTMLButtonElement;
    btn.click();
    await flush();
    const top = text(window, '[data-field="top-result"]');
    expect(top).toContain('admin service is temporarily unavailable');
    expect(top).not.toMatch(/\/v1\/|503|redis:|cache\.internal|secret/);
  });

  it('top-accounts overview rate limit uses actionable copy without endpoint/status text', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: (call) => {
        if (/\/v1\/admin\/accounts\?/.test(call.url)) return json({ data: [{ id: 'acc_a1' }] });
        if (/\/v1\/admin\/cost\/overview\?/.test(call.url)) return json({ detail: 'slow' }, 429);
        return json({ rates: {}, tierThresholds: {} });
      },
    });
    win = window;
    await flush();
    const btn = window.document.querySelector('[data-button="refresh-top"]') as HTMLButtonElement;
    btn.click();
    await flush();
    const top = text(window, '[data-field="top-result"]');
    expect(top).toContain('Too many requests. Wait a moment and try again.');
    expect(top).not.toMatch(/\/v1\/|429/);
  });

  it('top-accounts refresh is single-flight and exposes honest progress', async () => {
    let releaseAccounts: (() => void) | undefined;
    const accountsGate = new Promise<void>((resolve) => {
      releaseAccounts = resolve;
    });
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: async (call) => {
        if (/\/v1\/admin\/accounts\?/.test(call.url)) {
          await accountsGate;
          return json({ data: [] });
        }
        return json({ rates: {}, tierThresholds: {} });
      },
    });
    win = window;
    await flush();
    const btn = window.document.querySelector('[data-button="refresh-top"]') as HTMLButtonElement;
    btn.click();
    btn.click();
    await flush(2);
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.textContent?.trim()).toBe('Refreshing…');
    expect(fetchCalls.filter((call) => /\/v1\/admin\/accounts\?/.test(call.url))).toHaveLength(1);
    releaseAccounts?.();
    await flush();
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('aria-busy')).toBe('false');
    expect(btn.textContent?.trim()).toBe('Refresh');
  });

  it('account lookup is single-flight and exposes honest progress', async () => {
    let releaseQuery: (() => void) | undefined;
    const queryGate = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: async (call) => {
        if (/\/v1\/admin\/cost\/accounts\/test123/.test(call.url)) {
          await queryGate;
          return json({ breakdown: {}, thresholds: {} });
        }
        return json({ rates: {}, tierThresholds: {} });
      },
    });
    win = window;
    await flush();
    const form = window.document.querySelector('[data-form="account-query"]') as HTMLFormElement;
    (form.querySelector('input[name="account_id"]') as HTMLInputElement).value = 'acc_test123';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(2);
    const btn = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(form.getAttribute('aria-busy')).toBe('true');
    expect(btn.disabled).toBe(true);
    expect(btn.textContent?.trim()).toBe('Querying…');
    expect(
      fetchCalls.filter((call) => /\/v1\/admin\/cost\/accounts\/test123/.test(call.url)),
    ).toHaveLength(1);
    releaseQuery?.();
    await flush();
    expect(form.getAttribute('aria-busy')).toBe('false');
    expect(btn.disabled).toBe(false);
    expect(btn.textContent?.trim()).toBe('Query');
  });
});
