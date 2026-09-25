// The post-checkout banner names only a plan that billing confirms (security
// sweep 2026-09-24, finding #32).
//
// Stripe Checkout returns the customer to /?subscribed=<tier>, and the Overview
// greeted them with "Your <X> subscription is active — welcome aboard." for ANY
// value of `subscribed`: an unknown value was printed verbatim, and nothing
// checked that a subscription existed. A link carrying `?subscribed=` with
// attacker-chosen text (a fake support number, a billing instruction) put that
// text inside the dashboard's own banner. The banner now appears only for a known
// plan slug, and says the subscription is active only when GET /v1/billing
// reports an active or trialing subscription on that plan; until then it says the
// payment is being confirmed. The page reads billing once, so that banner asks the
// customer to refresh rather than promising the plan will appear by itself.
//
// "Being confirmed" is shown only when it is true, or cannot be known: for a
// subscription on that plan that is still `incomplete` (its first payment has not
// cleared), or when billing could not be read. When billing reports no
// subscription, or one on another plan, or one on that plan that has lapsed
// (past_due, canceled, incomplete_expired), nothing is being confirmed, and no
// banner is shown (finding #32, second pass).
//
// Loads the BUILT page and runs its inline script in jsdom against a mock fetch.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — jsdom ships no type declarations in this workspace.
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installDashboardDeadline } from './dashboard-test-runtime';
import { TIER_DISPLAY_NAMES } from '../../src/data/tier-display-names.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'index.html');

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let win: JSDOM['window'] | undefined;
afterEach(() => {
  win?.close?.();
  win = undefined;
});

/** Runs the Overview's inline script at `search` with /v1/billing answering `billing`. */
function overview(search: string, billing: () => Response): JSDOM['window'] {
  const scriptBodies: string[] = [];
  const html = readFileSync(BUILT_PAGE, 'utf8').replace(
    /<script[^>]*>([\s\S]*?)<\/script>/g,
    (_m, body: string) => {
      scriptBodies.push(body);
      return '';
    },
  );
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(html, {
    url: `https://app.driftstack.io/${search}`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  if (typeof window.Response !== 'function') window.Response = Response;
  window.fetch = (input: string) => {
    const u = String(input);
    if (/\/v1\/billing$/.test(u)) return Promise.resolve(billing());
    if (/\/v1\/account\/me$/.test(u)) return Promise.resolve(json({ name: 'A', tier: 'free' }));
    if (/\/v1\/(api-keys|sessions|team\/members)$/.test(u))
      return Promise.resolve(json({ data: [] }));
    if (/\/v1\/usage$/.test(u)) return Promise.resolve(json({ totals: {} }));
    if (/\/v1\/usage\/series\?days=14$/.test(u)) return Promise.resolve(json({ buckets: [] }));
    if (/\/v1\/status$/.test(u)) {
      return Promise.resolve(json({ overall_status: 'operational', recent_incidents: [] }));
    }
    return Promise.resolve(json({}, 404));
  };
  window.localStorage.setItem('ds_web_session_token', 'tok');
  window.dashboardHydrated = () => {};
  window.driftstackActAsHeaders = () => ({});
  window.driftstackRequestErrorMessage = (_err: unknown, fallback: string) => fallback;
  window.driftstackResponseError = (r: Response) => new Error(`HTTP ${String(r.status)}`);
  const pageScript = scriptBodies.find((s) => s.includes('data-page="overview"'));
  if (!pageScript) throw new Error('overview inline script not found');
  installDashboardDeadline(window);
  window.eval(pageScript);
  win = window as JSDOM['window'];
  return win;
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

function banner(window: JSDOM['window']): { shown: boolean; text: string } {
  const el = window.document.querySelector('[data-banner]');
  if (!el) throw new Error('banner not found');
  return { shown: !el.classList.contains('hidden'), text: el.textContent?.trim() ?? '' };
}

function subscription(tier: string, status: string): Response {
  return json({
    subscription: {
      tier,
      status,
      stripe_subscription_id: 'sub_1',
      current_period_end: '2026-10-24T00:00:00.000Z',
      cancel_at_period_end: false,
      canceled_at: null,
      created_at: '2026-09-24T00:00:00.000Z',
      updated_at: '2026-09-24T00:00:00.000Z',
    },
  });
}

describe('the post-checkout banner names only a plan that billing confirms', () => {
  it('CRITICAL an unknown ?subscribed= value puts none of its text in the banner', async () => {
    const injected = 'Call +1 555 0100 to verify your card';
    const window = overview(`?subscribed=${encodeURIComponent(injected)}`, () =>
      json({ subscription: null }),
    );
    await flush();

    const b = banner(window);
    expect(b.text, 'attacker-chosen text reached the dashboard banner').not.toContain('555');
    expect(b.text).not.toContain('subscription is active');
    expect(b.shown).toBe(false);
  });

  it('CRITICAL a known plan that billing does not show as active is not announced as active', async () => {
    const window = overview('?subscribed=api_scale', () => subscription('api_scale', 'incomplete'));
    await flush();

    const b = banner(window);
    expect(b.text).not.toContain('subscription is active');
    expect(b.text).toContain(TIER_DISPLAY_NAMES.api_scale);
    expect(b.text).toContain('being confirmed');
  });

  it('CRITICAL a known plan whose subscription billing reports on another plan is not announced as active', async () => {
    const window = overview('?subscribed=api_scale', () => subscription('solo_manual', 'active'));
    await flush();

    expect(banner(window).text).not.toContain('subscription is active');
  });

  it.each(['free', 'enterprise'])(
    'CRITICAL ?subscribed=%s names a plan no checkout sells, so no banner thanks the customer for buying it',
    async (tier) => {
      const window = overview(`?subscribed=${tier}`, () => json({ subscription: null }));
      await flush();

      const b = banner(window);
      expect(b.shown, `a banner appeared for ?subscribed=${tier}: ${b.text}`).toBe(false);
      expect(b.text).not.toContain('Thanks for subscribing');
    },
  );

  it('CRITICAL when billing cannot be read, a new subscriber is still told the payment is being confirmed', async () => {
    const window = overview('?subscribed=api_builder', () => json({ detail: 'unavailable' }, 503));
    await flush();

    const b = banner(window);
    expect(b.shown, 'a subscriber back from checkout was greeted with nothing').toBe(true);
    expect(b.text).toContain(TIER_DISPLAY_NAMES.api_builder);
    expect(b.text).toContain('being confirmed');
    expect(b.text).not.toContain('subscription is active');
  });

  it('the being-confirmed banner asks for a refresh, because the page does not show the plan by itself', async () => {
    let billingReads = 0;
    const window = overview('?subscribed=api_scale', () => {
      billingReads += 1;
      // Confirmed on any later read: the page would only see it by reading again.
      return billingReads === 1
        ? subscription('api_scale', 'incomplete')
        : subscription('api_scale', 'active');
    });
    await flush(30);

    const b = banner(window);
    expect(billingReads, 'the Overview reads billing once').toBe(1);
    expect(b.text).toContain('being confirmed');
    expect(b.text, 'the banner promised a plan the page never re-reads').not.toContain(
      'as soon as it is',
    );
    expect(b.text).toContain('refresh this page');
  });

  it('control: once billing reports the plan active, the banner welcomes the subscriber', async () => {
    const window = overview('?subscribed=team_manual', () => subscription('team_manual', 'active'));
    await flush();

    const b = banner(window);
    expect(b.shown).toBe(true);
    expect(b.text).toContain(TIER_DISPLAY_NAMES.team_manual);
    expect(b.text).toContain('subscription is active');
  });

  it('CRITICAL when billing reports no subscription, no banner says a payment is being confirmed', async () => {
    const window = overview('?subscribed=api_scale', () => json({ subscription: null }));
    await flush();

    const b = banner(window);
    expect(b.shown, `a banner appeared with no subscription behind it: ${b.text}`).toBe(false);
    expect(b.text).not.toContain('being confirmed');
    expect(b.text).not.toContain('subscription is active');
  });

  it('CRITICAL when billing reports a subscription on another plan, no banner is shown', async () => {
    const window = overview('?subscribed=api_scale', () => subscription('solo_manual', 'active'));
    await flush();

    const b = banner(window);
    expect(b.shown, `a banner appeared for a plan billing does not hold: ${b.text}`).toBe(false);
    expect(b.text).not.toContain('being confirmed');
  });

  it('CRITICAL an incomplete subscription on the plan is being confirmed', async () => {
    const window = overview('?subscribed=api_scale', () => subscription('api_scale', 'incomplete'));
    await flush();

    const b = banner(window);
    expect(b.shown).toBe(true);
    expect(b.text).toContain(TIER_DISPLAY_NAMES.api_scale);
    expect(b.text).toContain('being confirmed');
    expect(b.text).toContain('refresh this page');
  });

  it.each(['past_due', 'canceled', 'incomplete_expired', 'unpaid'])(
    'CRITICAL a subscription on the plan that is %s is not being confirmed, so no banner is shown',
    async (status) => {
      const window = overview('?subscribed=api_scale', () => subscription('api_scale', status));
      await flush();

      const b = banner(window);
      expect(b.shown, `a banner appeared for a ${status} subscription: ${b.text}`).toBe(false);
      expect(b.text).not.toContain('being confirmed');
    },
  );

  it('control: a trialing subscription on the plan counts as active', async () => {
    const window = overview('?subscribed=api_starter', () =>
      subscription('api_starter', 'trialing'),
    );
    await flush();

    expect(banner(window).text).toContain('subscription is active');
  });
});
