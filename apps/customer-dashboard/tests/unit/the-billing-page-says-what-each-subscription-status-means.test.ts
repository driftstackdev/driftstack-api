// The billing page says what each subscription status means (live-billing
// audit #7).
//
// The page rendered EVERY subscription as a current one: after a cancellation
// it still showed the old paid plan, "Renews <date> · auto-renews" and a
// "Cancel in Stripe portal" button — while the account was actually on Free.
// A past_due subscription read the same, so a customer whose card had failed
// was told it would simply renew. And a plan paid by crypto was hidden behind
// an old Stripe row.
//
// Now only an active or trialing subscription shows the renewal line and the
// cancel button. A canceled one shows the plan the ACCOUNT is on, marked
// canceled. A past_due or unpaid one says the payment did not go through and
// offers the way to update the card. Whatever the account's plan is — a crypto
// plan included — is the plan shown whenever the subscription is not current.
//
// Run against the BUILT page, as a customer's browser gets it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { installDashboardDeadline } from './dashboard-test-runtime';
import { TIER_DISPLAY_NAMES } from '../../src/data/tier-display-names.ts';

// jsdom ships no type declarations here; the page's window is the DOM window plus
// the globals DashboardLayout injects.
type PageWindow = Window &
  typeof globalThis & {
    driftstackActAsHeaders?: () => Record<string, string>;
    dashboardHydrated?: () => void;
  };
const { JSDOM, VirtualConsole } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: Record<string, unknown>) => { window: PageWindow };
  VirtualConsole: new () => { on(event: string, listener: () => void): void };
};

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'billing', 'index.html');
const PAGE_URL = 'https://app.driftstack.io/billing/';

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Subscription {
  tier: string;
  status: string;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean;
  canceled_at?: string | null;
}

function render(sub: Subscription, accountTier: string | null): PageWindow {
  const scripts: string[] = [];
  const html = readFileSync(BUILT_PAGE, 'utf8').replace(
    /<script[^>]*>([\s\S]*?)<\/script>/g,
    (_m, body: string) => {
      scripts.push(body);
      return '';
    },
  );
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const { window } = new JSDOM(html, {
    url: PAGE_URL,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
  });
  if (typeof window.Response !== 'function') window.Response = Response;
  window.fetch = (input: RequestInfo | URL) => {
    const url = String(input);
    if (/\/v1\/billing$/.test(url)) return Promise.resolve(json({ subscription: sub }));
    if (/\/v1\/account\/me$/.test(url)) {
      return Promise.resolve(
        accountTier === null ? json({}, 500) : json({ email: 'me@example.com', tier: accountTier }),
      );
    }
    if (/crypto-orders/.test(url)) return Promise.resolve(json({ orders: [], next_cursor: null }));
    return Promise.resolve(json({}, 404));
  };
  window.localStorage.setItem('ds_web_session_token', 'tok');
  window.dashboardHydrated = () => {};
  window.driftstackActAsHeaders = () => ({});
  const pageScript = scripts.find((s) => s.includes('data-page="billing"'));
  if (!pageScript) throw new Error('billing inline script not found');
  installDashboardDeadline(window);
  window.eval(pageScript);
  return window;
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

function text(window: PageWindow, selector: string): string {
  return window.document.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function hidden(window: PageWindow, selector: string): boolean {
  const el = window.document.querySelector(selector);
  if (!el) throw new Error(`not found: ${selector}`);
  return el.classList.contains('hidden');
}

const PERIOD_END = '2026-06-30T00:00:00.000Z';

describe('the billing page says what each subscription status means', () => {
  let win: PageWindow | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });

  it.each(['active', 'trialing'])(
    'CONTROL a %s subscription shows its plan, "Renews … · auto-renews" and the cancel button',
    async (status) => {
      win = render(
        {
          tier: 'api_builder',
          status,
          current_period_end: PERIOD_END,
          cancel_at_period_end: false,
        },
        'api_builder',
      );
      await flush();
      expect(text(win, '[data-field="sub-tier"]')).toBe(TIER_DISPLAY_NAMES['api_builder']);
      expect(text(win, '[data-field="sub-summary"]')).toContain('Renews 2026-06-30 · auto-renews');
      expect(hidden(win, '[data-action="cancel"]')).toBe(false);
      expect(hidden(win, '[data-action="portal"]')).toBe(false);
    },
  );

  it('CRITICAL a canceled subscription shows the plan the account is actually on, marked canceled — no renewal and no cancel button', async () => {
    win = render(
      {
        tier: 'api_builder',
        status: 'canceled',
        current_period_end: PERIOD_END,
        cancel_at_period_end: false,
        canceled_at: '2026-06-12T09:00:00.000Z',
      },
      'free',
    );
    await flush();
    expect(text(win, '[data-field="sub-tier"]'), 'the old paid plan is shown as current').toBe(
      TIER_DISPLAY_NAMES['free'],
    );
    const summary = text(win, '[data-field="sub-summary"]');
    expect(summary).toMatch(/canceled/i);
    expect(summary).toContain('2026-06-12');
    expect(summary).not.toMatch(/Renews|auto-renews/);
    expect(text(win, '[data-field="sub-status-badge"]')).toBe('canceled');
    expect(hidden(win, '[data-action="cancel"]'), 'a cancel button for a canceled plan').toBe(true);
    expect(hidden(win, '[data-field="cancel-hint"]')).toBe(true);
  });

  it.each(['past_due', 'unpaid'])(
    'CRITICAL a %s subscription says the payment did not go through and offers the way to update the card — not a renewal',
    async (status) => {
      win = render(
        {
          tier: 'api_builder',
          status,
          current_period_end: PERIOD_END,
          cancel_at_period_end: false,
        },
        'free',
      );
      await flush();
      const summary = text(win, '[data-field="sub-summary"]');
      expect(summary, 'a failed payment reads as a normal renewal').not.toMatch(
        /auto-renews|Renews/,
      );
      expect(summary).toMatch(/payment/i);
      expect(summary).toMatch(/didn.t go through/i);
      expect(summary).toContain(TIER_DISPLAY_NAMES['api_builder']);
      const portal = win.document.querySelector('[data-action="portal"]') as HTMLButtonElement;
      expect(hidden(win, '[data-action="portal"]')).toBe(false);
      expect(portal.disabled).toBe(false);
      expect(portal.textContent?.trim()).toMatch(/update payment method/i);
      expect(hidden(win, '[data-action="cancel"]')).toBe(true);
    },
  );

  it('CRITICAL a plan paid by crypto is shown when it is the account’s plan, not the old Stripe subscription behind it', async () => {
    win = render(
      {
        tier: 'api_starter',
        status: 'canceled',
        current_period_end: PERIOD_END,
        cancel_at_period_end: false,
        canceled_at: '2026-05-02T00:00:00.000Z',
      },
      'api_scale',
    );
    await flush();
    expect(text(win, '[data-field="sub-tier"]')).toBe(TIER_DISPLAY_NAMES['api_scale']);
    expect(text(win, '[data-field="sub-summary"]')).not.toMatch(/Renews|auto-renews/);
    expect(hidden(win, '[data-action="cancel"]')).toBe(true);
  });

  it('when the account cannot be read, a canceled subscription still never shows its old plan as current', async () => {
    win = render(
      {
        tier: 'api_builder',
        status: 'canceled',
        current_period_end: PERIOD_END,
        cancel_at_period_end: false,
        canceled_at: '2026-06-12T09:00:00.000Z',
      },
      null,
    );
    await flush();
    expect(text(win, '[data-field="sub-tier"]')).not.toBe(TIER_DISPLAY_NAMES['api_builder']);
    expect(text(win, '[data-field="sub-summary"]')).not.toMatch(/Renews|auto-renews/);
    expect(hidden(win, '[data-action="cancel"]')).toBe(true);
  });
});
