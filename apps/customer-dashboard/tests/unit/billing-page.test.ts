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
import { installDashboardDeadline } from './dashboard-test-runtime';
import { TIER_DISPLAY_NAMES } from '../../src/data/tier-display-names.ts';

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
  token?: string | null;
  storageDenied?: boolean;
  portalTimeoutImmediately?: boolean;
  route: (call: MockFetchCall) => Response | Promise<Response>;
}

function setUpDom(
  html: string,
  opts: SetUpOpts,
): {
  window: JSDOM['window'];
  fetchCalls: MockFetchCall[];
  hydratedCount: () => number;
} {
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
  } else if (opts.token !== undefined && opts.token !== null) {
    window.localStorage.setItem('ds_web_session_token', opts.token);
  }
  let hydrated = 0;
  // @ts-expect-error — injected by DashboardLayout
  window.dashboardHydrated = () => {
    hydrated += 1;
  };
  // @ts-expect-error — injected by DashboardLayout
  window.driftstackActAsHeaders = () => ({});
  if (opts.portalTimeoutImmediately) {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 15_000) {
        window.queueMicrotask(() => {
          if (typeof handler === 'function') handler(...args);
        });
        return 42;
      }
      return nativeSetTimeout(handler, timeout, ...args);
    }) as typeof window.setTimeout;
  }

  const pageScript = scriptBodies.find((s) => s.includes('data-page="billing"'));
  if (!pageScript) throw new Error('billing inline script not found');
  installDashboardDeadline(window);
  // @ts-expect-error — jsdom global has eval
  window.eval(pageScript);
  return {
    window: window as JSDOM['window'],
    fetchCalls,
    hydratedCount: () => hydrated,
  };
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
  it.each([
    ['signed out', {}],
    ['storage denied', { storageDenied: true }],
  ])('%s: shows sign-in, skips network, and releases hydration', async (_label, auth) => {
    const { window, fetchCalls, hydratedCount } = setUpDom(loadBuiltPage(), {
      ...auth,
      route: () => {
        throw new Error('must not fetch when unauthenticated');
      },
    });
    win = window;
    await flush();
    expect(fetchCalls.length).toBe(0);
    expect(hydratedCount()).toBe(1);
    expect(isHidden(window, '[data-banner]')).toBe(false);
    expect(text(window, '[data-banner]')).toContain('Sign in to see live billing state');
    expect(
      (window.document.querySelector('[data-action="portal"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (window.document.querySelector('[data-action="cancel"]') as HTMLButtonElement).disabled,
    ).toBe(true);
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
    expect(text(window, '[data-banner]')).toContain('Billing is unavailable for this deployment');
    // W588 — the mock subscription card is replaced with an honest state, not
    // left showing a fabricated tier/renew that a real customer misreads.
    expect(text(window, '[data-field="sub-tier"]')).toBe('Billing unavailable');
    expect(text(window, '[data-field="sub-status-badge"]')).toBe('unavailable');
    expect(isHidden(window, '[data-action="portal"]')).toBe(true);
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

  it('serializes both portal entry buttons and shows honest in-flight feedback', async () => {
    let resolvePortal!: (response: Response) => void;
    const pendingPortal = new Promise<Response>((resolve) => {
      resolvePortal = resolve;
    });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) => {
        if (/\/v1\/billing\/portal-session$/.test(call.url)) return pendingPortal;
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
    const cancelBtn = window.document.querySelector('[data-action="cancel"]') as HTMLButtonElement;
    portalBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
    cancelBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush(1);

    expect(
      fetchCalls.filter((call) => /\/v1\/billing\/portal-session$/.test(call.url)),
    ).toHaveLength(1);
    expect(portalBtn.disabled).toBe(true);
    expect(cancelBtn.disabled).toBe(true);
    expect(portalBtn.getAttribute('aria-busy')).toBe('true');
    expect(cancelBtn.getAttribute('aria-busy')).toBe('true');
    expect(portalBtn.textContent).toContain('Opening Stripe');
    expect(cancelBtn.textContent).toContain('Opening Stripe');

    resolvePortal(json({ portal_url: 'https://billing.stripe.com/p/session_test' }));
    await flush();
    expect(portalBtn.disabled).toBe(false);
    expect(cancelBtn.disabled).toBe(false);
    expect(portalBtn.getAttribute('aria-busy')).toBe('false');
    expect(portalBtn.textContent).toBe('Manage in Stripe portal');
    expect(cancelBtn.textContent).toBe('Cancel in Stripe portal');
  });

  it('bounds a stalled portal request and restores both entry buttons', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      portalTimeoutImmediately: true,
      route: (call) => {
        if (/\/v1\/billing\/portal-session$/.test(call.url)) {
          return new Promise<Response>((_resolve, reject) => {
            call.init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          });
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
    const cancelBtn = window.document.querySelector('[data-action="cancel"]') as HTMLButtonElement;
    portalBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush();

    const portalCall = fetchCalls.find((call) => /\/v1\/billing\/portal-session$/.test(call.url));
    expect(portalCall?.init?.signal?.aborted).toBe(true);
    expect(portalBtn.disabled).toBe(false);
    expect(cancelBtn.disabled).toBe(false);
    expect(portalBtn.getAttribute('aria-busy')).toBe('false');
    expect(text(window, '[data-banner]')).toContain("Couldn't open Stripe right now");
  });

  it('crypto orders: renders tier label, price, created day + a Receipt button ONLY on paid orders (slice 3.3)', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) => {
        if (/\/v1\/billing\/crypto-orders\?limit=5$/.test(call.url)) {
          return json({
            orders: [
              {
                order_id: 'cro_paid1',
                product: 'team_manual',
                price_cents: 24900,
                price_currency: 'USD',
                status: 'paid',
                created_at: '2026-06-20T10:00:00.000Z',
              },
              {
                order_id: 'cro_pend1',
                product: 'solo_manual',
                price_cents: 7900,
                price_currency: 'USD',
                status: 'pending',
                created_at: '2026-07-01T10:00:00.000Z',
              },
            ],
            next_cursor: null,
          });
        }
        return json({ subscription: null });
      },
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-crypto-list]')).toBe(false);
    const listText = text(window, '[data-crypto-list]');
    expect(listText).toContain('Team');
    expect(listText).toContain('249.00 USD');
    expect(listText).toContain('cro_paid1');
    expect(listText).toContain('2026-06-20');
    // Receipt affordance only where a receipt exists (paid).
    const receipts = window.document.querySelectorAll('[data-crypto-receipt]');
    expect(receipts.length).toBe(1);
    expect(receipts[0]?.getAttribute('data-crypto-receipt')).toBe('cro_paid1');
  });

  it('crypto orders: a successful empty list is the only response that claims no payments', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) => {
        if (/crypto-orders/.test(call.url)) return json({ orders: [], next_cursor: null });
        return json({ subscription: null });
      },
    });
    win = window;
    await flush();
    const state = window.document.querySelector('[data-crypto-empty]');
    expect(isHidden(window, '[data-crypto-empty]')).toBe(false);
    expect(isHidden(window, '[data-crypto-list]')).toBe(true);
    expect(state?.getAttribute('data-crypto-state')).toBe('empty');
    expect(state?.textContent).toContain('No crypto payments yet');
  });

  it.each([
    ['HTTP failure', () => json({ detail: 'nope' }, 500)],
    ['malformed success', () => json({ next_cursor: null })],
  ])(
    'crypto orders: %s renders unavailable rather than a false empty history',
    async (_name, response) => {
      const { window } = setUpDom(loadBuiltPage(), {
        token: 'tok',
        route: (call) => {
          if (/crypto-orders/.test(call.url)) return response();
          return json({ subscription: null });
        },
      });
      win = window;
      await flush();
      const state = window.document.querySelector('[data-crypto-empty]');
      expect(isHidden(window, '[data-crypto-empty]')).toBe(false);
      expect(isHidden(window, '[data-crypto-list]')).toBe(true);
      expect(state?.getAttribute('data-crypto-state')).toBe('unavailable');
      expect(state?.textContent).toContain("Couldn't load crypto payment history");
      expect(state?.textContent).not.toContain('No crypto payments yet');
    },
  );

  it('crypto receipt click: fetches receipt.pdf WITH the Bearer header (a plain link would 401)', async () => {
    const pdf = new Response(new Blob(['%PDF-1.4'], { type: 'application/pdf' }), { status: 200 });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) => {
        if (/receipt\.pdf$/.test(call.url)) return pdf;
        if (/\/v1\/billing\/crypto-orders\?limit=5$/.test(call.url)) {
          return json({
            orders: [
              {
                order_id: 'cro_paid1',
                product: 'team_manual',
                price_cents: 24900,
                price_currency: 'USD',
                status: 'paid',
                created_at: '2026-06-20T10:00:00.000Z',
              },
            ],
            next_cursor: null,
          });
        }
        return json({ subscription: null });
      },
    });
    win = window;
    // jsdom lacks createObjectURL — stub the pair so the download path runs.
    // @ts-expect-error — jsdom global is loose
    window.URL.createObjectURL = () => 'blob:stub';
    // @ts-expect-error — jsdom global is loose
    window.URL.revokeObjectURL = () => {};
    await flush();
    const btn = window.document.querySelector('[data-crypto-receipt]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    btn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush();
    const receiptCall = fetchCalls.find((c) =>
      /\/v1\/billing\/crypto-orders\/cro_paid1\/receipt\.pdf$/.test(c.url),
    );
    expect(receiptCall).toBeTruthy();
    const headers = (receiptCall?.init?.headers ?? {}) as Record<string, string>;
    const authKey = Object.keys(headers).find((h) => h.toLowerCase() === 'authorization');
    expect(authKey).toBeDefined();
    expect(headers[authKey!]).toBe('Bearer tok');
    expect(receiptCall?.init?.signal).toBeInstanceOf(window.AbortSignal);
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('aria-busy')).toBe('false');
    expect(btn.textContent).toBe('Receipt (PDF)');
  });

  it('crypto receipt click: single-flights, shows busy feedback, and restores the button', async () => {
    let resolveReceipt!: (response: Response) => void;
    const pendingReceipt = new Promise<Response>((resolve) => {
      resolveReceipt = resolve;
    });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) => {
        if (/receipt\.pdf$/.test(call.url)) return pendingReceipt;
        if (/\/v1\/billing\/crypto-orders\?limit=5$/.test(call.url)) {
          return json({
            orders: [
              {
                order_id: 'cro_paid1',
                product: 'team_manual',
                price_cents: 24900,
                price_currency: 'USD',
                status: 'paid',
                created_at: '2026-06-20T10:00:00.000Z',
              },
            ],
          });
        }
        return json({ subscription: null });
      },
    });
    win = window;
    // @ts-expect-error — jsdom global is loose
    window.URL.createObjectURL = () => 'blob:stub';
    // @ts-expect-error — jsdom global is loose
    window.URL.revokeObjectURL = () => {};
    await flush();
    const btn = window.document.querySelector('[data-crypto-receipt]') as HTMLButtonElement;
    btn.dispatchEvent(new window.Event('click', { bubbles: true }));
    btn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush(1);
    expect(fetchCalls.filter((call) => /receipt\.pdf$/.test(call.url))).toHaveLength(1);
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.textContent).toBe('Downloading…');

    resolveReceipt(
      new Response(new Blob(['%PDF-1.4'], { type: 'application/pdf' }), { status: 200 }),
    );
    await flush();
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('aria-busy')).toBe('false');
    expect(btn.textContent).toBe('Receipt (PDF)');
  });

  it('crypto receipt click: finally-cleans the anchor and blob URL when click throws', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) => {
        if (/receipt\.pdf$/.test(call.url)) {
          return new Response(new Blob(['%PDF-1.4'], { type: 'application/pdf' }), { status: 200 });
        }
        if (/\/v1\/billing\/crypto-orders\?limit=5$/.test(call.url)) {
          return json({
            orders: [
              {
                order_id: 'cro_paid1',
                product: 'team_manual',
                price_cents: 24900,
                price_currency: 'USD',
                status: 'paid',
                created_at: '2026-06-20T10:00:00.000Z',
              },
            ],
          });
        }
        return json({ subscription: null });
      },
    });
    win = window;
    let revoked = '';
    // @ts-expect-error — jsdom global is loose
    window.URL.createObjectURL = () => 'blob:cleanup';
    // @ts-expect-error — jsdom global is loose
    window.URL.revokeObjectURL = (url: string) => {
      revoked = url;
    };
    window.HTMLAnchorElement.prototype.click = () => {
      throw new Error('click blocked');
    };
    await flush();
    const btn = window.document.querySelector('[data-crypto-receipt]') as HTMLButtonElement;
    btn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush();
    expect(window.document.querySelector('a[href="blob:cleanup"]')).toBeNull();
    expect(revoked).toBe('blob:cleanup');
    expect(btn.disabled).toBe(false);
    expect(text(window, '[data-banner]')).toContain("Couldn't download the receipt");
  });
});
