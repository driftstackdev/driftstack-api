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
const PAGE_URL = 'https://app.driftstack.io/select-tier/';
const DEFAULT_SELF_ACCOUNT_ID = 'acc_00000000-0000-4000-8000-000000000001';
const FUTURE_EXPIRES_AT = '2099-01-01T00:00:00.000Z';

function cryptoIntentStorageKey(accountId: string, tier: string): string {
  return `ds_crypto_idem_v2:${accountId}:${tier}`;
}

function cryptoIntentEnvelope(accountId: string, tier: string, key: string): string {
  return JSON.stringify({
    version: 2,
    account_id: accountId,
    product: tier,
    idempotency_key: key,
  });
}

function storedCryptoIntentKey(
  window: JSDOM['window'],
  accountId: string,
  tier: string,
): string | null {
  const encoded = window.localStorage.getItem(cryptoIntentStorageKey(accountId, tier));
  if (!encoded) return null;
  const parsed = JSON.parse(encoded) as { idempotency_key?: unknown };
  return typeof parsed.idempotency_key === 'string' ? parsed.idempotency_key : null;
}

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
  locksAvailable?: boolean;
  lockRequest?: (...args: unknown[]) => Promise<unknown>;
  actAsAccountId?: string;
  selfAccountId?: string;
  accountMeBody?: unknown;
  accountMeStatus?: number;
  initialStorage?: Record<string, string>;
  clipboardPlan?: Array<(text: string) => Promise<void>>;
  route: (call: MockFetchCall) => Response | Promise<Response>;
}

function setUpDom(
  html: string,
  opts: SetUpOpts,
): {
  window: JSDOM['window'];
  fetchCalls: MockFetchCall[];
  clipboardWrites: string[];
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
  const clipboardWrites: string[] = [];
  const clipboardPlan = [...(opts.clipboardPlan ?? [])];
  // @ts-expect-error — jsdom global is loose
  if (typeof window.Response !== 'function') window.Response = Response;
  // @ts-expect-error — jsdom global is loose
  window.fetch = (input: string, init: RequestInit | undefined) => {
    const call: MockFetchCall = { url: String(input), init };
    fetchCalls.push(call);
    if (/\/v1\/account\/me$/.test(call.url)) {
      return Promise.resolve(
        json(
          opts.accountMeBody ?? { id: opts.selfAccountId ?? DEFAULT_SELF_ACCOUNT_ID },
          opts.accountMeStatus ?? 200,
        ),
      );
    }
    return Promise.resolve(opts.route(call));
  };
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText(text: string) {
        clipboardWrites.push(text);
        return clipboardPlan.shift()?.(text) ?? Promise.resolve();
      },
    },
  });
  if (opts.locksAvailable !== false) {
    Object.defineProperty(window.navigator, 'locks', {
      configurable: true,
      value: {
        request:
          opts.lockRequest ??
          ((_name: unknown, optionsOrCallback: unknown, maybeCallback?: unknown) => {
            const callback =
              typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
            if (typeof callback !== 'function') {
              return Promise.reject(new Error('lock callback missing'));
            }
            return Promise.resolve().then(() => callback());
          }),
      },
    });
  }
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
  for (const [key, value] of Object.entries(opts.initialStorage ?? {})) {
    window.localStorage.setItem(key, value);
  }
  if (opts.actAsAccountId !== undefined) {
    // @ts-expect-error — DashboardLayout installs this before the page script.
    window.driftstackActAsHeaders = () => ({
      'x-driftstack-account': opts.actAsAccountId,
    });
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
    clipboardWrites,
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
    const { window } = setUpDom(loadBuiltPage(), {
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

  it('fails all purchase controls closed in an acting-as team workspace', async () => {
    const { window, fetchCalls, hydratedCount } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      actAsAccountId: 'acc_00000000-0000-4000-8000-000000000001',
      route: () => {
        throw new Error('team-workspace checkout must not call the self-scoped billing API');
      },
    });
    win = window;
    await flush();

    expect(fetchCalls).toHaveLength(0);
    expect(hydratedCount()).toBe(1);
    expect(text(window, '[data-banner]')).toMatch(/self-workspace only/i);
    for (const button of window.document.querySelectorAll<HTMLButtonElement>(
      '[data-action="buy-tier"], [data-action="buy-tier-crypto"]',
    )) {
      expect(button.disabled).toBe(true);
      expect(button.title).toMatch(/workspace picker to Self/i);
    }
  });

  it('fails crypto checkout closed when origin-wide browser locks are unavailable', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      locksAvailable: false,
      route: (call) =>
        /\/v1\/billing$/.test(call.url) ? json({ subscription: null }) : json({}, 500),
    });
    win = window;
    await flush();

    const crypto = window.document.querySelector(
      '[data-action="buy-tier-crypto"]',
    ) as HTMLButtonElement;
    expect(crypto.disabled).toBe(true);
    expect(crypto.title).toMatch(/cross-tab locking/i);
    crypto.dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush();
    expect(fetchCalls.filter((call) => /\/crypto-checkout$/.test(call.url))).toHaveLength(0);
    expect(text(window, '[data-banner]')).toMatch(/cross-tab locking/i);
  });

  it('requires a strict authoritative self-account identity before enabling purchases', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      accountMeBody: { id: 'not-an-account-id' },
      route: (call) =>
        /\/v1\/billing$/.test(call.url) ? json({ subscription: null }) : json({}, 500),
    });
    win = window;
    await flush();

    for (const button of window.document.querySelectorAll<HTMLButtonElement>(
      '[data-action="buy-tier"], [data-action="buy-tier-crypto"]',
    )) {
      expect(button.disabled).toBe(true);
    }
    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(0);
    expect(text(window, '[data-banner]')).toMatch(/Purchases remain unavailable/i);
  });

  it('namespaces the intent envelope and Web Lock by exact self account plus tier', async () => {
    const accountA = 'acc_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const accountB = 'acc_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const accountAKey = 'crypto-intent-account-a';
    const lockNames: string[] = [];
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      selfAccountId: accountB,
      initialStorage: {
        [cryptoIntentStorageKey(accountA, 'solo_manual')]: cryptoIntentEnvelope(
          accountA,
          'solo_manual',
          accountAKey,
        ),
      },
      lockRequest: async (...args: unknown[]) => {
        lockNames.push(String(args[0]));
        const callback = args[2];
        if (typeof callback !== 'function') throw new Error('lock callback missing');
        return callback();
      },
      route: (call) => {
        if (/\/v1\/billing$/.test(call.url)) return json({ subscription: null });
        if (/\/v1\/billing\/crypto-checkout$/.test(call.url)) {
          return json({
            order_id: 'ord_account_b',
            product: 'solo_manual',
            status: 'pending',
            provider: 'nowpayments',
            pay_amount: 0.01,
            pay_currency: 'btc',
            payment_address: '0xACCOUNT_B',
          });
        }
        if (/\/v1\/billing\/crypto-orders\/ord_account_b$/.test(call.url)) {
          return json({
            order_id: 'ord_account_b',
            product: 'solo_manual',
            status: 'pending',
            expires_at: FUTURE_EXPIRES_AT,
          });
        }
        return json({}, 404);
      },
    });
    win = window;
    await flush();
    clickFirst(window, '[data-action="buy-tier-crypto"][data-tier="solo_manual"]');
    await flush();

    expect(storedCryptoIntentKey(window, accountA, 'solo_manual')).toBe(accountAKey);
    expect(storedCryptoIntentKey(window, accountB, 'solo_manual')).toMatch(/^crypto-intent-/);
    expect(lockNames).toEqual([`driftstack:crypto-checkout:${accountB}:solo_manual`]);
    expect(text(window, '[data-field="crypto-address"]')).toBe('0xACCOUNT_B');
  });

  it('rejects a cross-tier idempotency replay before rendering or status lookup', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) =>
        /\/v1\/billing$/.test(call.url)
          ? json({ subscription: null })
          : json({
              order_id: 'ord_wrong_product',
              product: 'team_manual',
              status: 'pending',
              provider: 'nowpayments',
              pay_amount: 0.01,
              pay_currency: 'btc',
              payment_address: '0xMUST_NOT_RENDER',
            }),
    });
    win = window;
    await flush();
    clickFirst(window, '[data-action="buy-tier-crypto"][data-tier="solo_manual"]');
    await flush();

    expect(fetchCalls.filter((call) => /\/crypto-orders\//.test(call.url))).toHaveLength(0);
    expect(text(window, '[data-field="crypto-address"]')).toBe('—');
    expect(isHidden(window, '[data-crypto-modal-ready]')).toBe(true);
    expect(storedCryptoIntentKey(window, DEFAULT_SELF_ACCOUNT_ID, 'solo_manual')).toBeTruthy();
  });

  it.each([
    ['whitespace address', { payment_address: '   ', pay_currency: 'btc', pay_amount: 1 }],
    ['whitespace currency', { payment_address: '0xSAFE', pay_currency: ' ', pay_amount: 1 }],
    ['non-positive amount', { payment_address: '0xSAFE', pay_currency: 'btc', pay_amount: 0 }],
    ['non-decimal amount', { payment_address: '0xSAFE', pay_currency: 'btc', pay_amount: 'NaN' }],
  ] as const)(
    'keeps the intent but hides malformed pending payment fields: %s',
    async (_label, malformed) => {
      const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
        token: 'tok',
        route: (call) =>
          /\/v1\/billing$/.test(call.url)
            ? json({ subscription: null })
            : json({
                order_id: 'ord_malformed_payment',
                product: 'solo_manual',
                status: 'pending',
                provider: 'nowpayments',
                ...malformed,
              }),
      });
      win = window;
      await flush();
      clickFirst(window, '[data-action="buy-tier-crypto"][data-tier="solo_manual"]');
      await flush();

      expect(fetchCalls.filter((call) => /\/crypto-orders\//.test(call.url))).toHaveLength(0);
      expect(text(window, '[data-field="crypto-address"]')).toBe('—');
      expect(
        (window.document.querySelector('[data-crypto-copy]') as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(storedCryptoIntentKey(window, DEFAULT_SELF_ACCOUNT_ID, 'solo_manual')).toBeTruthy();
    },
  );

  it.each([undefined, 'not-a-date', '2020-01-01T00:00:00.000Z'])(
    'keeps the intent and address hidden for unverifiable pending expiry %s',
    async (expiresAt) => {
      const { window } = setUpDom(loadBuiltPage(), {
        token: 'tok',
        route: (call) => {
          if (/\/v1\/billing$/.test(call.url)) return json({ subscription: null });
          if (/\/v1\/billing\/crypto-checkout$/.test(call.url)) {
            return json({
              order_id: 'ord_bad_expiry',
              product: 'solo_manual',
              status: 'pending',
              provider: 'nowpayments',
              pay_amount: 1,
              pay_currency: 'btc',
              payment_address: '0xMUST_NOT_RENDER',
            });
          }
          return json({
            order_id: 'ord_bad_expiry',
            product: 'solo_manual',
            status: 'pending',
            ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
          });
        },
      });
      win = window;
      await flush();
      clickFirst(window, '[data-action="buy-tier-crypto"]');
      await flush();

      expect(text(window, '[data-field="crypto-address"]')).toBe('—');
      expect(isHidden(window, '[data-crypto-modal-ready]')).toBe(true);
      expect(storedCryptoIntentKey(window, DEFAULT_SELF_ACCOUNT_ID, 'solo_manual')).toBeTruthy();
    },
  );

  it('owns an expiry deadline that hides the address without waiting for another response', async () => {
    vi.useFakeTimers();
    let browserNowMs = Date.parse('2026-07-17T12:00:00.000Z');
    const expiresAt = new Date(browserNowMs + 2_000).toISOString();
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) => {
        if (/\/v1\/billing$/.test(call.url)) return json({ subscription: null });
        if (/\/v1\/billing\/crypto-checkout$/.test(call.url)) {
          return json({
            order_id: 'ord_deadline',
            product: 'solo_manual',
            status: 'pending',
            provider: 'nowpayments',
            pay_amount: 1,
            pay_currency: 'btc',
            payment_address: '0xDEADLINE',
          });
        }
        return json({
          order_id: 'ord_deadline',
          product: 'solo_manual',
          status: 'pending',
          expires_at: expiresAt,
        });
      },
    });
    win = window;
    vi.spyOn(window.Date, 'now').mockImplementation(() => browserNowMs);
    await vi.advanceTimersByTimeAsync(0);
    clickFirst(window, '[data-action="buy-tier-crypto"]');
    await vi.advanceTimersByTimeAsync(0);
    expect(text(window, '[data-field="crypto-address"]')).toBe('0xDEADLINE');

    browserNowMs += 2_000;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(text(window, '[data-field="crypto-address"]')).toBe('—');
    expect(text(window, '[data-crypto-modal-error]')).toMatch(/payment deadline/i);
    expect(fetchCalls.filter((call) => /\/crypto-orders\//.test(call.url))).toHaveLength(1);
    expect(storedCryptoIntentKey(window, DEFAULT_SELF_ACCOUNT_ID, 'solo_manual')).toBeTruthy();
  });

  it('hides a previously verified address when a later pending poll loses expiry authority', async () => {
    vi.useFakeTimers();
    let statusReads = 0;
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) => {
        if (/\/v1\/billing$/.test(call.url)) return json({ subscription: null });
        if (/\/v1\/billing\/crypto-checkout$/.test(call.url)) {
          return json({
            order_id: 'ord_poll_malformed',
            product: 'solo_manual',
            status: 'pending',
            provider: 'nowpayments',
            pay_amount: 1,
            pay_currency: 'btc',
            payment_address: '0xPOLL_AUTHORITY',
          });
        }
        statusReads += 1;
        return json({
          order_id: 'ord_poll_malformed',
          product: 'solo_manual',
          status: 'pending',
          ...(statusReads === 1 ? { expires_at: FUTURE_EXPIRES_AT } : {}),
        });
      },
    });
    win = window;
    await vi.advanceTimersByTimeAsync(0);
    clickFirst(window, '[data-action="buy-tier-crypto"]');
    await vi.advanceTimersByTimeAsync(0);
    expect(text(window, '[data-field="crypto-address"]')).toBe('0xPOLL_AUTHORITY');

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(statusReads).toBe(2);
    expect(text(window, '[data-field="crypto-address"]')).toBe('—');
    expect(storedCryptoIntentKey(window, DEFAULT_SELF_ACCOUNT_ID, 'solo_manual')).toBeTruthy();
  });

  it.each(['paid', 'failed', 'cancelled'] as const)(
    'retires an exact %s intent and makes at most one fresh successor request for the explicit click',
    async (terminalStatus) => {
      const oldKey = 'crypto-intent-old-terminal';
      const attempts: MockFetchCall[] = [];
      const lockNames: string[] = [];
      const { window } = setUpDom(loadBuiltPage(), {
        token: 'tok',
        initialStorage: {
          [cryptoIntentStorageKey(DEFAULT_SELF_ACCOUNT_ID, 'solo_manual')]: cryptoIntentEnvelope(
            DEFAULT_SELF_ACCOUNT_ID,
            'solo_manual',
            oldKey,
          ),
        },
        lockRequest: async (...args: unknown[]) => {
          lockNames.push(String(args[0]));
          const callback = args[2];
          if (typeof callback !== 'function') throw new Error('lock callback missing');
          return callback();
        },
        route: (call) => {
          if (/\/v1\/billing$/.test(call.url)) return json({ subscription: null });
          if (/\/v1\/billing\/crypto-checkout$/.test(call.url)) {
            attempts.push(call);
            const key = new Headers(call.init?.headers).get('idempotency-key');
            if (key === oldKey) {
              return json({
                order_id: 'ord_terminal_old',
                product: 'solo_manual',
                status: terminalStatus,
                provider: 'stub',
                payment_address: null,
              });
            }
            return json({
              order_id: 'ord_fresh_successor',
              product: 'solo_manual',
              status: 'pending',
              provider: 'nowpayments',
              pay_amount: 0.0123,
              pay_currency: 'btc',
              payment_address: '0xFRESH_SUCCESSOR',
              expires_at: FUTURE_EXPIRES_AT,
            });
          }
          if (/\/v1\/billing\/crypto-orders\/ord_fresh_successor$/.test(call.url)) {
            return json({
              order_id: 'ord_fresh_successor',
              product: 'solo_manual',
              status: 'pending',
              expires_at: FUTURE_EXPIRES_AT,
            });
          }
          return json({}, 404);
        },
      });
      win = window;
      await flush();
      clickFirst(window, '[data-action="buy-tier-crypto"]');
      await flush();

      expect(attempts).toHaveLength(2);
      const firstKey = new Headers(attempts[0]?.init?.headers).get('idempotency-key');
      const secondKey = new Headers(attempts[1]?.init?.headers).get('idempotency-key');
      expect(firstKey).toBe(oldKey);
      expect(secondKey).toBeTruthy();
      expect(secondKey).not.toBe(oldKey);
      expect(storedCryptoIntentKey(window, DEFAULT_SELF_ACCOUNT_ID, 'solo_manual')).toBe(secondKey);
      expect(lockNames).toEqual([
        `driftstack:crypto-checkout:${DEFAULT_SELF_ACCOUNT_ID}:solo_manual`,
      ]);
      expect(text(window, '[data-field="crypto-order-id"]')).toBe('ord_fresh_successor');
      expect(text(window, '[data-field="crypto-address"]')).toBe('0xFRESH_SUCCESSOR');
      expect(isHidden(window, '[data-crypto-modal-ready]')).toBe(false);
    },
  );

  it.each(['confirming', 'partial'] as const)(
    'keeps a %s intent and never mints a successor while funds may be in flight',
    async (status) => {
      const key = 'crypto-intent-money-in-flight';
      const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
        token: 'tok',
        initialStorage: {
          [cryptoIntentStorageKey(DEFAULT_SELF_ACCOUNT_ID, 'solo_manual')]: cryptoIntentEnvelope(
            DEFAULT_SELF_ACCOUNT_ID,
            'solo_manual',
            key,
          ),
        },
        route: (call) =>
          /\/v1\/billing$/.test(call.url)
            ? json({ subscription: null })
            : json({
                order_id: 'ord_money_in_flight',
                product: 'solo_manual',
                status,
                provider: 'stub',
                payment_address: null,
              }),
      });
      win = window;
      await flush();
      clickFirst(window, '[data-action="buy-tier-crypto"]');
      await flush();

      expect(fetchCalls.filter((call) => /\/crypto-checkout$/.test(call.url))).toHaveLength(1);
      expect(storedCryptoIntentKey(window, DEFAULT_SELF_ACCOUNT_ID, 'solo_manual')).toBe(key);
      expect(text(window, '[data-crypto-modal-error]')).toMatch(
        status === 'confirming' ? /confirming on-chain/i : /partial payment/i,
      );
      expect(text(window, '[data-field="crypto-address"]')).toBe('—');
      expect(
        (window.document.querySelector('[data-crypto-copy]') as HTMLButtonElement).disabled,
      ).toBe(true);
    },
  );

  it('retains the exact crypto intent after an ambiguous transport failure', async () => {
    const attempts: MockFetchCall[] = [];
    let fail = true;
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) => {
        if (/\/v1\/billing$/.test(call.url)) return json({ subscription: null });
        if (/\/v1\/billing\/crypto-checkout$/.test(call.url)) {
          attempts.push(call);
          if (fail) {
            fail = false;
            return Promise.reject(
              Object.assign(new Error('transport lost'), { name: 'AbortError' }),
            );
          }
          return json({
            order_id: 'ord_retry_same_intent',
            product: 'solo_manual',
            status: 'pending',
            provider: 'nowpayments',
            pay_amount: 1,
            pay_currency: 'btc',
            payment_address: '0xRETRY_SAFE',
          });
        }
        if (/\/v1\/billing\/crypto-orders\/ord_retry_same_intent$/.test(call.url)) {
          return json({
            order_id: 'ord_retry_same_intent',
            product: 'solo_manual',
            status: 'pending',
            expires_at: FUTURE_EXPIRES_AT,
          });
        }
        return json({}, 404);
      },
    });
    win = window;
    await flush();
    clickFirst(window, '[data-action="buy-tier-crypto"]');
    await flush();
    clickFirst(window, '[data-action="buy-tier-crypto"]');
    await flush();

    expect(attempts).toHaveLength(2);
    const firstKey = new Headers(attempts[0]?.init?.headers).get('idempotency-key');
    const secondKey = new Headers(attempts[1]?.init?.headers).get('idempotency-key');
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBe(firstKey);
    expect(storedCryptoIntentKey(window, DEFAULT_SELF_ACCOUNT_ID, 'solo_manual')).toBe(firstKey);
  });

  it('crypto checkout success: renders the exact amount, currency, address, and order id from the API', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) =>
        /\/v1\/billing$/.test(call.url)
          ? json({ subscription: null })
          : json({
              provider: 'nowpayments',
              product: 'solo_manual',
              status: 'pending',
              pay_amount: 0.0123,
              pay_currency: 'eth',
              payment_address: '0xABCDEF0000000000000000000000000000001234',
              order_id: 'ord_crypto_test1',
              expires_at: FUTURE_EXPIRES_AT,
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

  it('generation-fenced status polling hides and retires an address as soon as the order becomes terminal', async () => {
    vi.useFakeTimers();
    const key = 'crypto-intent-poll-terminal';
    let statusReads = 0;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      initialStorage: {
        [cryptoIntentStorageKey(DEFAULT_SELF_ACCOUNT_ID, 'solo_manual')]: cryptoIntentEnvelope(
          DEFAULT_SELF_ACCOUNT_ID,
          'solo_manual',
          key,
        ),
      },
      route: (call) => {
        if (/\/v1\/billing$/.test(call.url)) return json({ subscription: null });
        if (/\/v1\/billing\/crypto-checkout$/.test(call.url)) {
          return json({
            order_id: 'ord_poll_terminal',
            product: 'solo_manual',
            status: 'pending',
            provider: 'nowpayments',
            pay_amount: 0.0123,
            pay_currency: 'btc',
            payment_address: '0xMUST_DISAPPEAR',
          });
        }
        if (/\/v1\/billing\/crypto-orders\/ord_poll_terminal$/.test(call.url)) {
          statusReads += 1;
          return statusReads === 1
            ? json({
                order_id: 'ord_poll_terminal',
                product: 'solo_manual',
                status: 'pending',
                expires_at: FUTURE_EXPIRES_AT,
              })
            : json({
                order_id: 'ord_poll_terminal',
                product: 'solo_manual',
                status: 'paid',
              });
        }
        return json({}, 404);
      },
    });
    win = window;
    await vi.advanceTimersByTimeAsync(0);
    clickFirst(window, '[data-action="buy-tier-crypto"]');
    await vi.advanceTimersByTimeAsync(0);
    expect(text(window, '[data-field="crypto-address"]')).toBe('0xMUST_DISAPPEAR');

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(statusReads).toBe(2);
    expect(
      fetchCalls.filter((call) => /\/crypto-orders\/ord_poll_terminal$/.test(call.url)),
    ).toHaveLength(2);
    expect(text(window, '[data-field="crypto-address"]')).toBe('—');
    expect(isHidden(window, '[data-crypto-modal-ready]')).toBe(true);
    expect(text(window, '[data-crypto-modal-error]')).toMatch(/is paid.*address is now closed/i);
    expect(
      (window.document.querySelector('[data-crypto-copy]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(storedCryptoIntentKey(window, DEFAULT_SELF_ACCOUNT_ID, 'solo_manual')).toBeNull();
  });

  it('ignores a stale in-flight status response after another tier takes modal ownership', async () => {
    vi.useFakeTimers();
    let resolveOldStatus: ((response: Response) => void) | undefined;
    const oldStatus = new Promise<Response>((resolve) => {
      resolveOldStatus = resolve;
    });
    let oldStatusReads = 0;
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) => {
        if (/\/v1\/billing$/.test(call.url)) return json({ subscription: null });
        if (/\/v1\/billing\/crypto-checkout$/.test(call.url)) {
          if (typeof call.init?.body !== 'string') throw new Error('checkout body missing');
          const product = JSON.parse(call.init.body) as { product?: string };
          return product.product === 'solo_manual'
            ? json({
                order_id: 'ord_old_poll',
                product: 'solo_manual',
                status: 'pending',
                provider: 'nowpayments',
                pay_amount: 0.01,
                pay_currency: 'btc',
                payment_address: '0xOLD_ADDRESS',
              })
            : json({
                order_id: 'ord_new_owner',
                product: 'team_manual',
                status: 'pending',
                provider: 'nowpayments',
                pay_amount: 0.02,
                pay_currency: 'eth',
                payment_address: '0xNEW_ADDRESS',
              });
        }
        if (/\/v1\/billing\/crypto-orders\/ord_old_poll$/.test(call.url)) {
          oldStatusReads += 1;
          return oldStatusReads === 1
            ? json({
                order_id: 'ord_old_poll',
                product: 'solo_manual',
                status: 'pending',
                expires_at: FUTURE_EXPIRES_AT,
              })
            : oldStatus;
        }
        if (/\/v1\/billing\/crypto-orders\/ord_new_owner$/.test(call.url)) {
          return json({
            order_id: 'ord_new_owner',
            product: 'team_manual',
            status: 'pending',
            expires_at: FUTURE_EXPIRES_AT,
          });
        }
        return json({}, 404);
      },
    });
    win = window;
    await vi.advanceTimersByTimeAsync(0);
    clickFirst(window, '[data-action="buy-tier-crypto"][data-tier="solo_manual"]');
    await vi.advanceTimersByTimeAsync(0);
    expect(text(window, '[data-field="crypto-address"]')).toBe('0xOLD_ADDRESS');
    const oldIntent = storedCryptoIntentKey(window, DEFAULT_SELF_ACCOUNT_ID, 'solo_manual');
    expect(oldIntent).toBeTruthy();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(oldStatusReads).toBe(2);

    clickFirst(window, '[data-action="buy-tier-crypto"][data-tier="team_manual"]');
    await vi.advanceTimersByTimeAsync(0);
    expect(text(window, '[data-field="crypto-order-id"]')).toBe('ord_new_owner');
    expect(text(window, '[data-field="crypto-address"]')).toBe('0xNEW_ADDRESS');
    const newIntent = storedCryptoIntentKey(window, DEFAULT_SELF_ACCOUNT_ID, 'team_manual');
    expect(newIntent).toBeTruthy();

    resolveOldStatus?.(json({ order_id: 'ord_old_poll', product: 'solo_manual', status: 'paid' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(text(window, '[data-field="crypto-order-id"]')).toBe('ord_new_owner');
    expect(text(window, '[data-field="crypto-address"]')).toBe('0xNEW_ADDRESS');
    expect(isHidden(window, '[data-crypto-modal-ready]')).toBe(false);
    expect(storedCryptoIntentKey(window, DEFAULT_SELF_ACCOUNT_ID, 'solo_manual')).toBe(oldIntent);
    expect(storedCryptoIntentKey(window, DEFAULT_SELF_ACCOUNT_ID, 'team_manual')).toBe(newIntent);
  });

  it('keeps an old clipboard write serialized until a fresh order can copy its new address', async () => {
    vi.useFakeTimers();
    const oldAddress = '0xOLD_CLIPBOARD_ADDRESS';
    const newAddress = '0xNEW_CLIPBOARD_ADDRESS';
    let clipboardValue = '';
    let resolveOldCopy: (() => void) | undefined;
    let checkoutAttempts = 0;
    let oldOrderStatusReads = 0;
    const { window, clipboardWrites } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      clipboardPlan: [
        (value) =>
          new Promise<void>((resolve) => {
            resolveOldCopy = () => {
              clipboardValue = value;
              resolve();
            };
          }),
        (value) => {
          clipboardValue = value;
          return Promise.resolve();
        },
      ],
      route: (call) => {
        if (/\/v1\/billing$/.test(call.url)) return json({ subscription: null });
        if (/\/v1\/billing\/crypto-checkout$/.test(call.url)) {
          checkoutAttempts += 1;
          return json({
            order_id: checkoutAttempts === 1 ? 'ord_old_copy' : 'ord_new_copy',
            product: 'solo_manual',
            status: 'pending',
            provider: 'nowpayments',
            pay_amount: checkoutAttempts === 1 ? 0.01 : 0.02,
            pay_currency: 'btc',
            payment_address: checkoutAttempts === 1 ? oldAddress : newAddress,
          });
        }
        if (/\/v1\/billing\/crypto-orders\/ord_old_copy$/.test(call.url)) {
          oldOrderStatusReads += 1;
          return oldOrderStatusReads === 1
            ? json({
                order_id: 'ord_old_copy',
                product: 'solo_manual',
                status: 'pending',
                expires_at: FUTURE_EXPIRES_AT,
              })
            : json({ order_id: 'ord_old_copy', product: 'solo_manual', status: 'paid' });
        }
        if (/\/v1\/billing\/crypto-orders\/ord_new_copy$/.test(call.url)) {
          return json({
            order_id: 'ord_new_copy',
            product: 'solo_manual',
            status: 'pending',
            expires_at: FUTURE_EXPIRES_AT,
          });
        }
        return json({}, 404);
      },
    });
    win = window;
    await vi.advanceTimersByTimeAsync(0);
    clickFirst(window, '[data-action="buy-tier-crypto"][data-tier="solo_manual"]');
    await vi.advanceTimersByTimeAsync(0);

    const copy = window.document.querySelector('[data-crypto-copy]') as HTMLButtonElement;
    copy.click();
    expect(clipboardWrites).toEqual([oldAddress]);
    expect(copy.disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(text(window, '[data-field="crypto-address"]')).toBe('—');

    clickFirst(window, '[data-action="buy-tier-crypto"][data-tier="solo_manual"]');
    await vi.advanceTimersByTimeAsync(0);
    expect(text(window, '[data-field="crypto-address"]')).toBe(newAddress);
    expect(copy.disabled).toBe(true);
    copy.click();
    expect(clipboardWrites).toEqual([oldAddress]);

    resolveOldCopy?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(clipboardValue).toBe(oldAddress);
    expect(copy.disabled).toBe(false);
    expect(copy.textContent).toBe('Copy address');

    copy.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(clipboardWrites).toEqual([oldAddress, newAddress]);
    expect(clipboardValue).toBe(newAddress);
    expect(copy.textContent).toBe('Copied ✓');
  });

  it('serializes payment-address copy and recovers from denial on retry', async () => {
    let rejectFirst: ((reason?: unknown) => void) | undefined;
    const firstWrite = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const address = '0xABCDEF0000000000000000000000000000001234';
    const { window, clipboardWrites } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      clipboardPlan: [() => firstWrite, () => Promise.resolve()],
      route: (call) =>
        /\/v1\/billing$/.test(call.url)
          ? json({ subscription: null })
          : json({
              provider: 'nowpayments',
              product: 'solo_manual',
              status: 'pending',
              pay_amount: 0.0123,
              pay_currency: 'eth',
              payment_address: address,
              order_id: 'ord_crypto_copy',
              expires_at: FUTURE_EXPIRES_AT,
            }),
    });
    win = window;
    await flush();
    clickFirst(window, '[data-action="buy-tier-crypto"]');
    await flush();

    const copy = window.document.querySelector('[data-crypto-copy]') as HTMLButtonElement;
    copy.click();
    copy.click();
    expect(clipboardWrites).toEqual([address]);
    expect(copy.disabled).toBe(true);
    expect(copy.getAttribute('aria-busy')).toBe('true');
    expect(copy.textContent).toMatch(/copying/i);

    rejectFirst?.(new Error('clipboard denied'));
    await flush();
    expect(copy.disabled).toBe(false);
    expect(copy.getAttribute('aria-busy')).toBe('false');
    expect(copy.textContent).toMatch(/copy failed/i);
    expect(text(window, '[data-banner]')).toMatch(/select the payment address manually/i);

    copy.click();
    await flush();
    expect(clipboardWrites).toEqual([address, address]);
    expect(copy.textContent).toBe('Copied ✓');
    expect(copy.getAttribute('aria-label')).toBe('Payment address copied');
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

  it('crypto checkout stub provider: shows the unavailable/manual-payment fallback with the order id', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: (call) =>
        /\/v1\/billing$/.test(call.url)
          ? json({ subscription: null })
          : json({
              provider: 'stub',
              product: 'solo_manual',
              status: 'pending',
              order_id: 'ord_stub_1',
            }),
    });
    win = window;
    await flush();
    clickFirst(window, '[data-action="buy-tier-crypto"]');
    await flush();
    expect(isHidden(window, '[data-crypto-modal-error]')).toBe(false);
    const err = text(window, '[data-crypto-modal-error]');
    expect(err).toContain('Crypto checkout is unavailable on this server');
    expect(err).toContain('billing@driftstack.dev');
    expect(err).toContain('ord_stub_1');
  });
});
