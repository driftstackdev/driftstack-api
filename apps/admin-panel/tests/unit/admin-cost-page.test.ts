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
  if (opts.adminToken !== undefined) {
    window.localStorage.setItem('ds_web_session_token', opts.adminToken);
  }
  // @ts-expect-error — injected by AdminLayout
  window.dashboardHydrated = () => {};

  const pageScript = scriptBodies.find((s) => s.includes('data-page="admin-cost"'));
  if (!pageScript) throw new Error('admin-cost inline script not found');
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
  });

  it('config load: renders the rate card and per-tier thresholds at 2-decimal precision', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
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
  });

  it('config endpoint error: surfaces the status in a banner', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      adminToken: 'admtok',
      route: () => json({ detail: 'boom' }, 500),
    });
    win = window;
    await flush();
    expect(text(window, '[data-banner]')).toContain('returned 500');
  });
});
