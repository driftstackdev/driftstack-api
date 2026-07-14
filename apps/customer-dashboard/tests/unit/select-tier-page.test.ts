// Behavioural coverage for the Select-tier (checkout) page —
// apps/customer-dashboard/src/pages/select-tier.astro. This is the payment
// surface, so rendered correctness matters most: a wrong crypto amount /
// address shown to a customer is real money lost. Source-parity tests existed;
// this adds rendered-outcome coverage for both checkout paths against a jsdom
// mock fetch: the Stripe checkout-session POST (+ its auth-gate + 404/503 soft
// message) and the crypto modal (payment-detail rendering + the stub-provider
// fallback).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDashboardDeadline } from './dashboard-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'select-tier', 'index.html');
const PAGE_URL = 'https://app.driftstack.dev/select-tier/';

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
  cryptoStorageDenied?: boolean;
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
  if (opts.cryptoStorageDenied === true) {
    const storagePrototype = Object.getPrototypeOf(window.localStorage);
    const getItem = storagePrototype.getItem;
    const setItem = storagePrototype.setItem;
    Object.defineProperties(storagePrototype, {
      getItem: {
        configurable: true,
        value(this: Storage, key: string) {
          if (key.startsWith('ds_crypto_idem_')) throw new Error('crypto storage denied');
          return getItem.call(this, key);
        },
      },
      setItem: {
        configurable: true,
        value(this: Storage, key: string, value: string) {
          if (key.startsWith('ds_crypto_idem_')) throw new Error('crypto storage denied');
          setItem.call(this, key, value);
        },
      },
    });
  }
  let hydrated = 0;
  // @ts-expect-error — injected by DashboardLayout
  window.dashboardHydrated = () => {
    hydrated += 1;
  };
  installDashboardDeadline(window);

  const pageScript = scriptBodies.find((s) => s.includes('data-page="select-tier"'));
  if (!pageScript) throw new Error('select-tier inline script not found');
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

function clickFirst(window: JSDOM['window'], selector: string): void {
  const btn = window.document.querySelector(selector) as HTMLElement | null;
  if (!btn) throw new Error(`no element for ${selector}`);
  btn.dispatchEvent(new window.Event('click', { bubbles: true }));
}

let win: JSDOM['window'] | undefined;
afterEach(() => {
  win?.close?.();
  win = undefined;
  vi.useRealTimers();
});

describe('customer-dashboard Select-tier (select-tier.astro) checkout behaviour', () => {
  it('Stripe buy-tier without a token: prompts to sign up, no checkout call', async () => {
    const { window, fetchCalls, hydratedCount } = setUpDom(loadBuiltPage(), {
      route: () => {
        throw new Error('must not fetch when unauthenticated');
      },
    });
    win = window;
    clickFirst(window, '[data-action="buy-tier"]');
    await flush();
    expect(fetchCalls.length).toBe(0);
    expect(hydratedCount()).toBe(1);
    expect(text(window, '[data-banner]')).toContain('Sign up first');
  });

  it('storage denial follows the hydrated signed-out path with inert payment controls', async () => {
    const { window, fetchCalls, hydratedCount } = setUpDom(loadBuiltPage(), {
      storageDenied: true,
      route: () => {
        throw new Error('must not fetch when storage is unavailable');
      },
    });
    win = window;
    await flush();

    expect(fetchCalls).toHaveLength(0);
    expect(hydratedCount()).toBe(1);
    for (const button of window.document.querySelectorAll<HTMLButtonElement>(
      '[data-action="buy-tier"], [data-action="buy-tier-crypto"]',
    )) {
      expect(button.disabled).toBe(true);
      expect(button.title).toMatch(/Sign in/i);
    }
  });

  it('requires a successful current billing snapshot before either payment path can start', async () => {
    let resolveBilling: ((response: Response) => void) | undefined;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) => {
        if (/\/v1\/billing$/.test(call.url)) {
          return new Promise<Response>((resolve) => {
            resolveBilling = resolve;
          });
        }
        return json({ checkout_url: 'https://checkout.stripe.com/c/too-early' });
      },
    });
    win = window;
    const stripe = window.document.querySelector('[data-action="buy-tier"]') as HTMLButtonElement;
    const crypto = window.document.querySelector(
      '[data-action="buy-tier-crypto"]',
    ) as HTMLButtonElement;
    expect(stripe.disabled).toBe(true);
    expect(crypto.disabled).toBe(true);
    stripe.dispatchEvent(new window.Event('click', { bubbles: true }));
    crypto.dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush(2);
    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(0);

    resolveBilling?.(json({ subscription: null }));
    await flush();
    expect(stripe.disabled).toBe(false);
    expect(crypto.disabled).toBe(false);
  });

  it('keeps all payment controls locked when the billing snapshot is failed or malformed', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) =>
        /\/v1\/billing$/.test(call.url) ? json({ unexpected: true }) : json({}, 500),
    });
    win = window;
    await flush();

    for (const button of window.document.querySelectorAll<HTMLButtonElement>(
      '[data-action="buy-tier"], [data-action="buy-tier-crypto"]',
    )) {
      expect(button.disabled).toBe(true);
      expect(button.title).toMatch(/Reload/i);
      button.dispatchEvent(new window.Event('click', { bubbles: true }));
    }
    await flush(2);
    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(0);
  });

  it('routes active subscribers through Stripe portal and keeps crypto orders unavailable', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) => {
        if (/\/v1\/billing$/.test(call.url)) {
          return json({
            subscription: {
              tier: 'solo_manual',
              status: 'active',
              cancel_at_period_end: false,
            },
          });
        }
        if (/\/v1\/billing\/portal-session$/.test(call.url)) {
          return json({ portal_url: 'https://billing.stripe.com/p/session_test' });
        }
        return json({}, 500);
      },
    });
    win = window;
    await flush();

    const stripeButtons = Array.from(
      window.document.querySelectorAll<HTMLButtonElement>('[data-action="buy-tier"]'),
    );
    const current = stripeButtons.find((button) => button.dataset.tier === 'solo_manual');
    const switchPlan = stripeButtons.find((button) => button.dataset.tier === 'team_manual');
    expect(current?.disabled).toBe(true);
    expect(current?.textContent).toContain('Current plan');
    expect(switchPlan?.disabled).toBe(false);
    for (const crypto of window.document.querySelectorAll<HTMLButtonElement>(
      '[data-action="buy-tier-crypto"]',
    )) {
      expect(crypto.classList.contains('hidden')).toBe(true);
      expect(crypto.disabled).toBe(true);
      crypto.dispatchEvent(new window.Event('click', { bubbles: true }));
    }

    switchPlan?.click();
    await flush();
    expect(
      fetchCalls.filter(
        (call) => /\/v1\/billing\/portal-session$/.test(call.url) && call.init?.method === 'POST',
      ),
    ).toHaveLength(1);
    expect(fetchCalls.some((call) => /crypto-checkout$/.test(call.url))).toBe(false);
  });

  it('Stripe buy-tier with a token: POSTs a monthly checkout-session for the tier', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) =>
        /\/v1\/billing$/.test(call.url)
          ? json({ subscription: null })
          : json({ checkout_url: 'https://checkout.stripe.com/c/session_test' }),
    });
    win = window;
    await flush();
    clickFirst(window, '[data-action="buy-tier"]');
    clickFirst(window, '[data-action="buy-tier"]');
    await flush();
    const calls = fetchCalls.filter(
      (c) =>
        /\/v1\/billing\/checkout-session$/.test(c.url) &&
        (c.init?.method || '').toUpperCase() === 'POST',
    );
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeTruthy();
    expect(call?.init?.signal).toBeDefined();
    const body = JSON.parse(String(call?.init?.body));
    expect(body.billing_period).toBe('monthly');
    expect(typeof body.tier).toBe('string');
    expect(body.tier.length).toBeGreaterThan(0);
    expect(new Headers(call?.init?.headers).get('idempotency-key')).toBeTruthy();
  });

  it('serializes checkout across different tier buttons', async () => {
    let releaseCheckout: (response: Response) => void = () => {};
    const pendingCheckout = new Promise<Response>((resolve) => {
      releaseCheckout = resolve;
    });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) => {
        if (/\/v1\/billing$/.test(call.url)) return json({ subscription: null });
        if (/\/v1\/billing\/checkout-session$/.test(call.url)) return pendingCheckout;
        return json({});
      },
    });
    win = window;
    await flush();
    const buttons = Array.from(
      window.document.querySelectorAll('[data-action="buy-tier"]'),
    ) as HTMLButtonElement[];
    const first = buttons[0];
    const second = buttons[1];
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();

    first?.click();
    await flush(1);
    expect(first?.disabled).toBe(true);
    expect(second?.disabled).toBe(true);
    expect(second?.title).toBe('Wait for the active checkout request to finish.');

    second?.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await flush(1);
    expect(
      fetchCalls.filter(
        (call) => /\/v1\/billing\/checkout-session$/.test(call.url) && call.init?.method === 'POST',
      ),
    ).toHaveLength(1);

    releaseCheckout(json({ detail: 'temporary refusal' }, 503));
    await flush();
    expect(first?.disabled).toBe(false);
    expect(second?.disabled).toBe(false);
  });

  it('reuses the checkout idempotency key only after an ambiguous transport failure', async () => {
    const attempts: MockFetchCall[] = [];
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) => {
        if (/\/v1\/billing$/.test(call.url)) return json({ subscription: null });
        if (/\/v1\/billing\/checkout-session$/.test(call.url)) {
          attempts.push(call);
          return Promise.reject(abort);
        }
        return json({});
      },
    });
    win = window;
    await flush();
    clickFirst(window, '[data-action="buy-tier"]');
    await flush();
    clickFirst(window, '[data-action="buy-tier"]');
    await flush();

    expect(attempts).toHaveLength(2);
    const firstKey = new Headers(attempts[0]?.init?.headers).get('idempotency-key');
    const secondKey = new Headers(attempts[1]?.init?.headers).get('idempotency-key');
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBe(firstKey);
    expect(text(window, '[data-banner]')).toContain(
      'Request timed out. Check your connection and try again.',
    );
  });

  it('starts a new checkout attempt after an HTTP response settles the prior key', async () => {
    const attempts: MockFetchCall[] = [];
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) => {
        if (/\/v1\/billing$/.test(call.url)) return json({ subscription: null });
        if (/\/v1\/billing\/checkout-session$/.test(call.url)) attempts.push(call);
        return json({ detail: 'temporary refusal' }, 503);
      },
    });
    win = window;
    await flush();
    clickFirst(window, '[data-action="buy-tier"]');
    await flush();
    clickFirst(window, '[data-action="buy-tier"]');
    await flush();

    expect(attempts).toHaveLength(2);
    const firstKey = new Headers(attempts[0]?.init?.headers).get('idempotency-key');
    const secondKey = new Headers(attempts[1]?.init?.headers).get('idempotency-key');
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBeTruthy();
    expect(secondKey).not.toBe(firstKey);
  });

  it('bounds the initial subscription transport and aborts it when the page is left', async () => {
    vi.useFakeTimers();
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) => {
        if (/\/v1\/billing$/.test(call.url)) return new Promise(() => {});
        return json({});
      },
    });
    win = window;
    const billingRead = fetchCalls.find((call) => /\/v1\/billing$/.test(call.url));
    expect(billingRead?.init?.signal).toBeDefined();
    expect(billingRead?.init?.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(billingRead?.init?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(billingRead?.init?.signal?.aborted).toBe(true);

    const second = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) => {
        if (/\/v1\/billing$/.test(call.url)) return new Promise(() => {});
        return json({});
      },
    });
    window.close();
    win = second.window;
    const secondRead = second.fetchCalls.find((call) => /\/v1\/billing$/.test(call.url));
    second.window.dispatchEvent(new second.window.Event('pagehide'));
    expect(secondRead?.init?.signal?.aborted).toBe(true);
  });

  it('keeps the initial subscription deadline armed while its JSON body is stalled', async () => {
    vi.useFakeTimers();
    const stalledBody = new ReadableStream<Uint8Array>({
      start() {
        // Headers arrive, but the body deliberately never produces or closes.
      },
    });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) => {
        if (/\/v1\/billing$/.test(call.url)) {
          return new Response(stalledBody, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return json({});
      },
    });
    win = window;
    const billingRead = fetchCalls.find((call) => /\/v1\/billing$/.test(call.url));
    await Promise.resolve();
    await Promise.resolve();
    expect(billingRead?.init?.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(billingRead?.init?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(billingRead?.init?.signal?.aborted).toBe(true);
  });

  it('Stripe buy-tier 503 uses fixed temporary-unavailable guidance', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) =>
        /\/v1\/billing$/.test(call.url)
          ? json({ subscription: null })
          : json(
              {
                type: 'https://errors.driftstack.dev/feature-unavailable',
                detail: 'billing provider unwired at billing.internal',
              },
              503,
            ),
    });
    win = window;
    await flush();
    clickFirst(window, '[data-action="buy-tier"]');
    await flush();
    expect(text(window, '[data-banner]')).toContain('service is temporarily unavailable');
    expect(text(window, '[data-banner]')).not.toContain('billing.internal');
  });

  it('crypto checkout without a token: prompts to sign in', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: () => {
        throw new Error('must not fetch when unauthenticated');
      },
    });
    win = window;
    clickFirst(window, '[data-action="buy-tier-crypto"]');
    await flush();
    expect(fetchCalls.length).toBe(0);
    expect(text(window, '[data-banner]')).toContain('Sign in to pay with crypto');
  });

  it('crypto checkout success: renders the exact amount, currency, address, and order id from the API', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) =>
        /\/v1\/billing$/.test(call.url)
          ? json({ subscription: null })
          : json({
              provider: 'nowpayments',
              pay_amount: 0.0123,
              pay_currency: 'eth',
              payment_address: '0xABCDEF0000000000000000000000000000001234',
              order_id: 'ord_crypto_test1',
            }),
    });
    win = window;
    await flush();
    clickFirst(window, '[data-action="buy-tier-crypto"]');
    clickFirst(window, '[data-action="buy-tier-crypto"]');
    await flush();
    const cryptoCalls = fetchCalls.filter((c) => /\/v1\/billing\/crypto-checkout$/.test(c.url));
    expect(cryptoCalls).toHaveLength(1);
    expect(cryptoCalls[0]?.init?.signal).toBeDefined();
    expect(isHidden(window, '[data-crypto-modal-ready]')).toBe(false);
    expect(text(window, '[data-field="crypto-amount"]')).toBe('0.0123');
    expect(text(window, '[data-field="crypto-currency"]')).toBe('eth');
    expect(text(window, '[data-field="crypto-address"]')).toBe(
      '0xABCDEF0000000000000000000000000000001234',
    );
    expect(text(window, '[data-field="crypto-order-id"]')).toBe('ord_crypto_test1');
  });

  it('crypto checkout fails closed before POST when its idempotency key cannot persist', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      cryptoStorageDenied: true,
      route: (call) =>
        /\/v1\/billing$/.test(call.url)
          ? json({ subscription: null })
          : json({ order_id: 'must_not_exist' }),
    });
    win = window;
    await flush();
    clickFirst(window, '[data-action="buy-tier-crypto"]');
    await flush();

    expect(fetchCalls.filter((call) => /\/crypto-checkout$/.test(call.url))).toHaveLength(0);
    expect(isHidden(window, '[data-crypto-modal-error]')).toBe(false);
    expect(text(window, '[data-crypto-modal-error]')).toMatch(
      /needs browser site storage to prevent duplicate payment orders/i,
    );
  });

  it('crypto checkout stub provider: shows the manual-wire fallback with the order id', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) =>
        /\/v1\/billing$/.test(call.url)
          ? json({ subscription: null })
          : json({ provider: 'stub', order_id: 'ord_stub_1' }),
    });
    win = window;
    await flush();
    clickFirst(window, '[data-action="buy-tier-crypto"]');
    await flush();
    expect(isHidden(window, '[data-crypto-modal-error]')).toBe(false);
    const err = text(window, '[data-crypto-modal-error]');
    expect(err).toContain("isn't fully live yet");
    expect(err).toContain('ord_stub_1');
  });
});
