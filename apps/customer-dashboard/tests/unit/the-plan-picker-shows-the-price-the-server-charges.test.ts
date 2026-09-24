// The plan picker shows the price the server charges (live-billing audit #14).
//
// The crypto charge follows the price table the owner can edit
// (PricingService.listEffective), while every tier card on this page showed a
// price hard-coded into the page. After an owner price edit a customer read
// "$499/mo" and was charged the new amount. The cards now read the effective
// price of every tier from the same source the crypto charge uses (the
// crypto-checkout quote, one per tier), and show it.
//
// If that read fails — for one tier or all of them — the card keeps the price
// built into the page, which is the seeded price the server itself falls back
// to. A signed-out visitor sees the built-in prices and nothing is fetched.
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
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'select-tier', 'index.html');
const PAGE_URL = 'https://app.driftstack.io/select-tier/';
const SELF = 'acc_00000000-0000-4000-8000-000000000001';

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Call {
  url: string;
  body: string | null;
}

function render(opts: {
  token: string | null;
  quote: (product: string) => Response | Promise<Response>;
}): { window: PageWindow; calls: Call[] } {
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
  const calls: Call[] = [];
  if (typeof window.Response !== 'function') window.Response = Response;
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : null;
    calls.push({ url, body });
    if (/\/v1\/billing\/crypto-checkout\/quote$/.test(url)) {
      const product = (JSON.parse(body ?? '{}') as { product?: string }).product ?? '';
      return Promise.resolve(opts.quote(product));
    }
    if (/\/v1\/billing$/.test(url)) return Promise.resolve(json({ subscription: null }));
    if (/\/v1\/account\/me$/.test(url)) return Promise.resolve(json({ id: SELF }));
    return Promise.resolve(json({}, 404));
  };
  Object.defineProperty(window.navigator, 'locks', {
    configurable: true,
    value: { request: () => Promise.resolve() },
  });
  if (opts.token !== null) window.localStorage.setItem('ds_web_session_token', opts.token);
  window.dashboardHydrated = () => {};
  installDashboardDeadline(window);
  const pageScript = scripts.find((s) => s.includes('data-page="select-tier"'));
  if (!pageScript) throw new Error('select-tier inline script not found');
  window.eval(pageScript);
  return { window, calls };
}

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

/** The price shown on a tier's card, and the amount its crypto button carries. */
function card(window: PageWindow, tier: string): { price: string; cents: string | null } {
  const button = window.document.querySelector(
    `[data-action="buy-tier-crypto"][data-tier="${tier}"]`,
  );
  // The price line of the card that holds this tier's buttons.
  const price = button?.closest('.tk-liftable')?.querySelector('p.text-2xl') ?? null;
  return {
    price: price?.textContent?.trim() ?? '(no price element)',
    cents: button?.getAttribute('data-tier-price-cents') ?? null,
  };
}

const EDITED: Record<string, number> = {
  solo_manual: 8_900,
  team_manual: 24_900,
  agency_manual: 69_900,
  api_starter: 14_900,
  api_builder: 59_900,
  api_scale: 149_950,
};

describe('the plan picker shows the price the server charges', () => {
  let win: PageWindow | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });

  it('CRITICAL after an owner price edit every card shows the effective price, and the crypto button carries it', async () => {
    const page = render({
      token: 'tok',
      quote: (product) => json({ product, price_cents: EDITED[product], price_currency: 'USD' }),
    });
    win = page.window;
    await flush();

    expect(card(win, 'api_builder'), 'the card still shows the hard-coded price').toEqual({
      price: '$599/mo',
      cents: '59900',
    });
    expect(card(win, 'solo_manual')).toEqual({ price: '$89/mo', cents: '8900' });
    expect(card(win, 'api_scale')).toEqual({ price: '$1,499.50/mo', cents: '149950' });
    expect(card(win, 'team_manual')).toEqual({ price: '$249/mo', cents: '24900' });
  });

  it('CONTROL when the price read fails, every card keeps the price built into the page', async () => {
    const page = render({ token: 'tok', quote: () => json({ detail: 'down' }, 503) });
    win = page.window;
    await flush();

    expect(card(win, 'api_builder')).toEqual({ price: '$499/mo', cents: '49900' });
    expect(card(win, 'api_scale')).toEqual({ price: '$1,499/mo', cents: '149900' });
  });

  it('one tier whose read fails or answers for another tier keeps its built-in price; the others show theirs', async () => {
    const page = render({
      token: 'tok',
      quote: (product) => {
        if (product === 'api_builder') return Promise.reject(new TypeError('network'));
        if (product === 'api_scale') {
          return json({ product: 'api_starter', price_cents: 1, price_currency: 'USD' });
        }
        return json({ product, price_cents: EDITED[product], price_currency: 'USD' });
      },
    });
    win = page.window;
    await flush();

    expect(card(win, 'api_builder')).toEqual({ price: '$499/mo', cents: '49900' });
    expect(card(win, 'api_scale')).toEqual({ price: '$1,499/mo', cents: '149900' });
    expect(card(win, 'solo_manual')).toEqual({ price: '$89/mo', cents: '8900' });
  });

  it('a signed-out visitor sees the built-in prices and nothing is fetched', async () => {
    const page = render({
      token: null,
      quote: () => {
        throw new Error('must not fetch when signed out');
      },
    });
    win = page.window;
    await flush();

    expect(page.calls).toEqual([]);
    expect(card(win, 'api_builder')).toEqual({ price: '$499/mo', cents: '49900' });
  });
});
