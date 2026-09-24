// The billing page offers no Stripe portal in another member's workspace
// (live-billing audit #5).
//
// A team member viewing the owner's workspace sees the OWNER's plan on this
// page — but "Manage in Stripe portal" and "Cancel in Stripe portal" opened the
// member's OWN Stripe customer, so a member could cancel their own plan
// believing it was the team's. The server now refuses a portal request made
// for another workspace; the page no longer offers one. In another member's
// workspace both portal buttons are hidden and a plain note says who manages
// this workspace's payment details. In their own workspace nothing changes.
//
// Run against the BUILT page, as a customer's browser gets it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { installDashboardDeadline } from './dashboard-test-runtime';

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
const OWNER = 'acc_0f1e2d3c-4b5a-4968-8776-655443322110';

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function render(actAs: string | null): { window: PageWindow; portalPosts: () => number } {
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
  let portalPosts = 0;
  if (typeof window.Response !== 'function') window.Response = Response;
  window.fetch = (input: RequestInfo | URL) => {
    const url = String(input);
    if (/\/v1\/billing\/portal-session$/.test(url)) {
      portalPosts += 1;
      return Promise.resolve(json({ portal_url: 'https://billing.stripe.com/p/session_x' }));
    }
    if (/\/v1\/billing$/.test(url)) {
      return Promise.resolve(
        json({
          subscription: {
            tier: 'api_scale',
            status: 'active',
            current_period_end: '2026-06-30T00:00:00.000Z',
            cancel_at_period_end: false,
          },
        }),
      );
    }
    if (/\/v1\/account\/me$/.test(url)) {
      return Promise.resolve(json({ email: 'member@example.com', tier: 'free' }));
    }
    if (/crypto-orders/.test(url)) return Promise.resolve(json({ orders: [], next_cursor: null }));
    return Promise.resolve(json({}, 404));
  };
  window.localStorage.setItem('ds_web_session_token', 'tok');
  window.dashboardHydrated = () => {};
  // DashboardLayout's act-as helper: a header only while viewing another member's workspace.
  window.driftstackActAsHeaders = (): Record<string, string> =>
    actAs === null ? {} : { 'x-driftstack-account': actAs };
  const pageScript = scripts.find((s) => s.includes('data-page="billing"'));
  if (!pageScript) throw new Error('billing inline script not found');
  installDashboardDeadline(window);
  window.eval(pageScript);
  return { window, portalPosts: () => portalPosts };
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

function el(window: PageWindow, selector: string): HTMLElement {
  const found = window.document.querySelector(selector);
  if (found === null) throw new Error(`not found: ${selector}`);
  return found as HTMLElement;
}

describe("the billing page offers no Stripe portal in another member's workspace", () => {
  let win: PageWindow | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });

  it("CRITICAL in the owner's workspace both portal buttons are hidden, a plain note says who manages it, and no portal session is requested", async () => {
    const page = render(OWNER);
    win = page.window;
    await flush();

    expect(
      el(win, '[data-action="portal"]').classList.contains('hidden'),
      "the member's own portal is offered under the owner's plan",
    ).toBe(true);
    expect(el(win, '[data-action="cancel"]').classList.contains('hidden')).toBe(true);
    expect(el(win, '[data-field="cancel-hint"]').classList.contains('hidden')).toBe(true);

    const note = el(win, '[data-billing-other-workspace]');
    expect(note.classList.contains('hidden')).toBe(false);
    expect(note.textContent).toMatch(/owner/i);
    expect(note.textContent).not.toMatch(/X-Driftstack|header|Stripe portal session/i);

    // The plan read still shows the owner's subscription.
    expect(el(win, '[data-field="sub-tier"]').textContent?.trim()).toBe('API Scale');

    el(win, '[data-action="portal"]').dispatchEvent(new win.Event('click', { bubbles: true }));
    el(win, '[data-action="cancel"]').dispatchEvent(new win.Event('click', { bubbles: true }));
    await flush();
    expect(page.portalPosts()).toBe(0);
  });

  it('CONTROL in their own workspace the portal buttons are offered and the note stays hidden', async () => {
    const page = render(null);
    win = page.window;
    await flush();

    expect(el(win, '[data-action="portal"]').classList.contains('hidden')).toBe(false);
    expect(el(win, '[data-action="cancel"]').classList.contains('hidden')).toBe(false);
    expect(el(win, '[data-billing-other-workspace]').classList.contains('hidden')).toBe(true);

    el(win, '[data-action="portal"]').dispatchEvent(new win.Event('click', { bubbles: true }));
    await flush();
    expect(page.portalPosts()).toBe(1);
  });
});
