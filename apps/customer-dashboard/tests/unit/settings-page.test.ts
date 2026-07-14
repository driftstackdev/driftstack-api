// Local integration test for the /settings page's inline script,
// focused on the email notification preferences flow (V-204 toggles
// with optimistic-update revert on save failure). The web-session
// management flow moved to /security with the 2026-07-03 design-system
// v2 split — see security-page.test.ts. The settings page loads its
// account endpoints concurrently, each with its own independent
// .catch, so this uses a permissive stateful URL router: every loader
// resolves to a minimal response and the PUT mutations drive the
// assertions.
//
// Mirrors profiles-page.test.ts (route-based). Confirmation is the
// branded window.driftstackConfirm (injected by DashboardLayout, not
// eval'd here) → stubbed to a resolved Promise.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDashboardDeadline } from './dashboard-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'settings', 'index.html');
const PAGE_URL = 'https://app.driftstack.dev/settings/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}
interface SetUpOpts {
  confirmReturns?: boolean;
  token?: string | null;
  storageDenied?: boolean;
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
  const dom = new JSDOM(htmlNoScripts, {
    url: PAGE_URL,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const fetchCalls: MockFetchCall[] = [];
  // @ts-expect-error — jsdom global is loose
  if (typeof window.Response !== 'function') window.Response = Response;
  // @ts-expect-error — jsdom global is loose
  window.fetch = (input: string, init: RequestInit | undefined) => {
    const call: MockFetchCall = { url: String(input), init };
    fetchCalls.push(call);
    return Promise.resolve().then(() => opts.route(call));
  };
  if (opts.storageDenied === true) {
    Object.defineProperty(Object.getPrototypeOf(window.localStorage), 'getItem', {
      configurable: true,
      value: () => {
        throw new Error('storage denied');
      },
    });
  } else if (opts.token !== null) {
    window.localStorage.setItem('ds_web_session_token', opts.token ?? 'tok');
  }
  let hydrated = 0;
  // @ts-expect-error — injected by DashboardLayout
  window.dashboardHydrated = () => {
    hydrated += 1;
  };
  const cr = opts.confirmReturns ?? true;
  // @ts-expect-error — driftstackConfirm is injected by DashboardLayout
  window.driftstackConfirm = () => Promise.resolve(cr);
  window.confirm = () => cr;

  const pageScript = scriptBodies.find((s) => s.includes('data-page="settings"'));
  if (!pageScript) throw new Error('settings inline script not found');
  installDashboardDeadline(window);
  // @ts-expect-error — jsdom global has eval
  window.eval(pageScript);
  return {
    window: window as JSDOM['window'],
    fetchCalls,
    hydratedCount: () => hydrated,
  };
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('settings page — email notification preferences', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
    vi.useRealTimers();
  });
  const loadBuiltPage = (): string => readFileSync(BUILT_PAGE, 'utf8');

  function routerWithEmailPref(putStatus: number): (c: MockFetchCall) => Response {
    return (call: MockFetchCall): Response => {
      const method = (call.init?.method || 'GET').toUpperCase();
      const u = call.url.replace(/^https?:\/\/[^/]+/, '');
      if (/\/v1\/account\/email-preferences$/.test(u) && method === 'PUT') {
        return putStatus === 204 ? new Response(null, { status: 204 }) : json({}, putStatus);
      }
      if (/\/v1\/account\/email-preferences$/.test(u) && method === 'GET') {
        return json({ data: [{ event_type: 'billing-receipt', opted_in: true }] });
      }
      if (/\/v1\/account\/me$/.test(u) && method === 'GET') {
        return json({ email: 'me@example.com', name: 'Me', slug: 'me', region: 'eu' });
      }
      return json({}, 404);
    };
  }

  it.each([
    ['signed out', { token: null }],
    ['storage denied', { storageDenied: true }],
  ])(
    '%s: releases hydration with zero network and keeps profile/BYOK mutations inert',
    async (_label, auth) => {
      const { window, fetchCalls, hydratedCount } = setUpDom(loadBuiltPage(), {
        ...auth,
        route: () => {
          throw new Error('must not fetch without a bearer');
        },
      });
      win = window;
      await flush();

      expect(fetchCalls).toHaveLength(0);
      expect(hydratedCount()).toBe(1);
      expect(window.document.querySelector('[data-banner]')?.textContent).toContain('Sign in');
      for (const control of window.document.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLButtonElement
      >(
        '[data-field="profile-name"], [data-field="profile-timezone"], [data-field="profile-slug"], [data-field="profile-region"], [data-button="profile-save"], #byok-key, [data-byok-form] button[type="submit"]',
      )) {
        expect(control.disabled).toBe(true);
        expect(control.title).toMatch(/Sign in/i);
      }
    },
  );

  it('requires a successful current profile read before enabling edits or accepting submit', async () => {
    let resolveProfile: ((response: Response) => void) | undefined;
    const base = routerWithEmailPref(204);
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        const method = (call.init?.method || 'GET').toUpperCase();
        if (/\/v1\/account\/me$/.test(call.url) && method === 'GET') {
          return new Promise<Response>((resolve) => {
            resolveProfile = resolve;
          });
        }
        return base(call);
      },
    });
    win = window;
    await flush(2);

    const form = window.document.querySelector('[data-form="profile"]') as HTMLFormElement;
    const name = window.document.querySelector('[data-field="profile-name"]') as HTMLInputElement;
    const save = window.document.querySelector('[data-button="profile-save"]') as HTMLButtonElement;
    expect(name.disabled).toBe(true);
    expect(save.disabled).toBe(true);
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(2);
    expect(fetchCalls.some((call) => call.init?.method === 'PATCH')).toBe(false);

    resolveProfile?.(
      json({
        id: 'acct_1234567890123456',
        email: 'me@example.com',
        name: 'Authoritative name',
        timezone: 'America/New_York',
        slug: 'authoritative',
        region: 'us',
      }),
    );
    await flush();
    expect(name.value).toBe('Authoritative name');
    expect(name.disabled).toBe(false);
    expect(save.disabled).toBe(false);
  });

  it('keeps profile mutation authority revoked when the current profile read fails', async () => {
    const base = routerWithEmailPref(204);
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        const method = (call.init?.method || 'GET').toUpperCase();
        if (/\/v1\/account\/me$/.test(call.url) && method === 'GET') {
          return json({ detail: 'profile unavailable' }, 503);
        }
        return base(call);
      },
    });
    win = window;
    await flush();

    const form = window.document.querySelector('[data-form="profile"]') as HTMLFormElement;
    const save = window.document.querySelector('[data-button="profile-save"]') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.title).toMatch(/Reload/i);
    expect(window.document.querySelector('[data-field="profile-error"]')?.textContent).toMatch(
      /temporarily unavailable|Could not load your current profile/i,
    );
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(2);
    expect(fetchCalls.some((call) => call.init?.method === 'PATCH')).toBe(false);
  });

  it('toggle off a preference that SAVES OK: stays unchecked + shows "saved"', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), { route: routerWithEmailPref(204) });
    win = window;
    await flush();
    const checkbox = window.document.querySelector(
      'input[data-event-type="billing-receipt"]',
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    checkbox.checked = false;
    checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
    await flush();
    const put = fetchCalls.find(
      (c) => c.init?.method === 'PUT' && /\/email-preferences$/.test(c.url),
    );
    expect(JSON.parse(String(put?.init?.body))).toEqual({
      event_type: 'billing-receipt',
      opted_in: false,
    });
    expect(checkbox.checked).toBe(false);
  });

  it('toggle off a preference whose save FAILS: reverts the checkbox back to checked instead of silently lying about the opted-in state', async () => {
    const { window } = setUpDom(loadBuiltPage(), { route: routerWithEmailPref(500) });
    win = window;
    await flush();
    const checkbox = window.document.querySelector(
      'input[data-event-type="billing-receipt"]',
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    checkbox.checked = false;
    checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
    // Optimistically unchecked the instant the customer clicks…
    expect(checkbox.checked).toBe(false);
    await flush();
    // …but the PUT failed, so it must revert to match what the server
    // actually has — otherwise the customer believes they opted out of
    // an email the server is still sending.
    expect(checkbox.checked).toBe(true);
    const banner = window.document.querySelector('[data-banner]');
    expect(banner?.classList.contains('hidden')).toBe(false);
    expect(banner?.textContent).toContain("Couldn't save email preference");
  });

  it('committed PUT timeout refreshes the live preference instead of reverting it', async () => {
    let optedIn = true;
    const base = routerWithEmailPref(204);
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        const method = (call.init?.method || 'GET').toUpperCase();
        if (/\/v1\/account\/email-preferences$/.test(call.url) && method === 'PUT') {
          optedIn = false;
          const error = new Error('response lost after commit');
          error.name = 'AbortError';
          return Promise.reject(error);
        }
        if (/\/v1\/account\/email-preferences$/.test(call.url) && method === 'GET') {
          return json({ data: [{ event_type: 'billing-receipt', opted_in: optedIn }] });
        }
        return base(call);
      },
    });
    win = window;
    await flush();
    const checkbox = window.document.querySelector(
      'input[data-event-type="billing-receipt"]',
    ) as HTMLInputElement;
    checkbox.checked = false;
    checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
    await flush(12);

    expect(fetchCalls.filter((call) => call.init?.method === 'PUT')).toHaveLength(1);
    expect(checkbox.checked).toBe(false);
    expect(checkbox.indeterminate).toBe(false);
    expect(checkbox.disabled).toBe(false);
    expect(window.document.querySelector('[data-banner]')?.textContent).toContain(
      'live setting matches',
    );
  });

  it('uncommitted PUT timeout restores the authoritative live preference', async () => {
    const base = routerWithEmailPref(204);
    const { window } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (call.init?.method === 'PUT' && /\/email-preferences$/.test(call.url)) {
          const error = new Error('request timed out');
          error.name = 'AbortError';
          return Promise.reject(error);
        }
        return base(call);
      },
    });
    win = window;
    await flush();
    const checkbox = window.document.querySelector(
      'input[data-event-type="billing-receipt"]',
    ) as HTMLInputElement;
    checkbox.checked = false;
    checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
    await flush(12);

    expect(checkbox.checked).toBe(true);
    expect(checkbox.indeterminate).toBe(false);
    expect(checkbox.disabled).toBe(false);
    expect(window.document.querySelector('[data-banner]')?.textContent).toContain(
      'checkbox now shows the live preference',
    );
  });

  it('shows and locks an indeterminate checkbox when timeout reconciliation also fails', async () => {
    const base = routerWithEmailPref(204);
    let mutationStarted = false;
    const { window } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        const method = (call.init?.method || 'GET').toUpperCase();
        if (/\/email-preferences$/.test(call.url) && method === 'PUT') {
          mutationStarted = true;
          const error = new Error('request timed out');
          error.name = 'AbortError';
          return Promise.reject(error);
        }
        if (/\/email-preferences$/.test(call.url) && method === 'GET' && mutationStarted) {
          return Promise.reject(new Error('gateway unavailable'));
        }
        return base(call);
      },
    });
    win = window;
    await flush();
    const checkbox = window.document.querySelector(
      'input[data-event-type="billing-receipt"]',
    ) as HTMLInputElement;
    checkbox.checked = false;
    checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
    await flush(12);

    expect(checkbox.indeterminate).toBe(true);
    expect(checkbox.disabled).toBe(true);
    expect(window.document.querySelector('[data-banner]')?.textContent).toContain(
      'outcome is unknown',
    );
  });

  it('does not let an older saved timer hide a newer preference failure', async () => {
    vi.useFakeTimers();
    let writes = 0;
    const baseRouter = routerWithEmailPref(204);
    const { window } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (call.init?.method === 'PUT' && /\/email-preferences$/.test(call.url)) {
          writes += 1;
          return writes === 1 ? new Response(null, { status: 204 }) : json({}, 500);
        }
        return baseRouter(call);
      },
    });
    win = window;
    await flushMicrotasks(40);
    const checkbox = window.document.querySelector(
      'input[data-event-type="billing-receipt"]',
    ) as HTMLInputElement;

    checkbox.checked = false;
    checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
    await flushMicrotasks(30);
    expect(window.document.querySelector('[data-banner]')?.textContent).toContain(
      'Email preference saved',
    );

    checkbox.checked = true;
    checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
    await flushMicrotasks(30);
    const banner = window.document.querySelector('[data-banner]');
    expect(banner?.textContent).toContain("Couldn't save email preference");
    await vi.advanceTimersByTimeAsync(2000);
    expect(banner?.textContent).toContain("Couldn't save email preference");
    expect(banner?.classList.contains('hidden')).toBe(false);
  });

  it('serializes duplicate preference and profile mutations and gives every request an abort signal', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), { route: routerWithEmailPref(204) });
    win = window;
    await flush();

    const checkbox = window.document.querySelector(
      'input[data-event-type="billing-receipt"]',
    ) as HTMLInputElement;
    checkbox.checked = false;
    checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
    checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));

    const profile = window.document.querySelector('[data-form="profile"]') as HTMLFormElement;
    profile.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    profile.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    const mutations = fetchCalls.filter((call) =>
      ['PUT', 'PATCH'].includes(call.init?.method || ''),
    );
    expect(mutations.map((call) => call.init?.method)).toEqual(['PUT', 'PATCH']);
    expect(mutations.every((call) => call.init?.signal instanceof window.AbortSignal)).toBe(true);
    expect(checkbox.disabled).toBe(false);
    expect(checkbox.hasAttribute('aria-busy')).toBe(false);
    const save = window.document.querySelector('[data-button="profile-save"]') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    expect(save.hasAttribute('aria-busy')).toBe(false);
  });
});
