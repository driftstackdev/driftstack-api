// Behavioural coverage for the Billing page — apps/customer-dashboard/src/
// pages/billing.astro. Source-parity tests existed; this adds rendered-outcome
// coverage for the inline script: auth-gate, the live /v1/billing subscription
// card (tier label, renew/cancel summary, status badge, cancel-button
// visibility), the no-subscription state, the 503 activation-gate soft message,
// and the Stripe-portal action POST.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { TIER_DISPLAY_NAMES } from '../../src/data/mocks.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'billing', 'index.html');
const PAGE_URL = 'https://app.driftstack.dev/billing/';

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

  const pageScript = scriptBodies.find((s) => s.includes('data-page="billing"'));
  if (!pageScript) throw new Error('billing inline script not found');
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

describe('customer-dashboard Billing (billing.astro) behaviour', () => {
  it('no session token: shows the sign-in banner and skips the /v1/billing fetch', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: () => {
        throw new Error('must not fetch when unauthenticated');
      },
    });
    win = window;
    await flush();
    expect(fetchCalls.length).toBe(0);
    expect(isHidden(window, '[data-banner]')).toBe(false);
    expect(text(window, '[data-banner]')).toContain('Sign in to see live billing state');
  });

  it('active auto-renewing subscription: renders tier label, renew summary, status badge, cancel button shown', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: () =>
        json({
          subscription: {
            tier: 'api_builder',
            status: 'past_due',
            current_period_end: '2026-06-30T00:00:00.000Z',
            cancel_at_period_end: false,
          },
        }),
    });
    win = window;
    await flush();
    expect(text(window, '[data-field="sub-tier"]')).toBe(TIER_DISPLAY_NAMES['api_builder']);
    expect(text(window, '[data-field="sub-summary"]')).toContain('Renews 2026-06-30');
    expect(text(window, '[data-field="sub-summary"]')).toContain('auto-renews');
    // Status badge replaces underscores with spaces.
    expect(text(window, '[data-field="sub-status-badge"]')).toBe('past due');
    expect(text(window, '[data-field="plan-cta"]')).toBe('Change plan');
    expect(isHidden(window, '[data-action="cancel"]')).toBe(false);
  });

  it('subscription set to cancel: summary says so and the cancel button is hidden', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: () =>
        json({
          subscription: {
            tier: 'api_builder',
            status: 'active',
            current_period_end: '2026-06-30T00:00:00.000Z',
            cancel_at_period_end: true,
          },
        }),
    });
    win = window;
    await flush();
    expect(text(window, '[data-field="sub-summary"]')).toContain('set to cancel at period end');
    expect(isHidden(window, '[data-action="cancel"]')).toBe(true);
  });

  it('no subscription: shows the empty state and a "Choose a plan" CTA, hides the portal button', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: () => json({ subscription: null }),
    });
    win = window;
    await flush();
    expect(text(window, '[data-field="sub-tier"]')).toBe('No active subscription');
    expect(text(window, '[data-field="plan-cta"]')).toBe('Choose a plan');
    expect(isHidden(window, '[data-action="portal"]')).toBe(true);
  });

  it('503 activation-gate: soft message instead of a raw HTTP 503', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: () => json({ detail: 'Billing not configured' }, 503),
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-banner]')).toBe(false);
    expect(text(window, '[data-banner]')).toContain('Live billing is not yet available');
  });

  it('Manage portal: posts to /v1/billing/portal-session', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) => {
        if (/\/v1\/billing\/portal-session$/.test(call.url)) {
          return json({ portal_url: 'https://billing.stripe.com/p/session_test' });
        }
        return json({
          subscription: {
            tier: 'api_builder',
            status: 'active',
            current_period_end: '2026-06-30T00:00:00.000Z',
            cancel_at_period_end: false,
          },
        });
      },
    });
    win = window;
    await flush();
    const portalBtn = window.document.querySelector('[data-action="portal"]') as HTMLButtonElement;
    portalBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush();
    const portalCall = fetchCalls.find(
      (c) =>
        /\/v1\/billing\/portal-session$/.test(c.url) &&
        (c.init?.method || '').toUpperCase() === 'POST',
    );
    expect(portalCall).toBeTruthy();
  });
});
