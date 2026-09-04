// Built-page behavior coverage for the Settings profile form. A slow initial
// read must never overwrite typing, and a lost PATCH response is reconciled
// against exact authoritative fields before the page claims completion.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installDashboardDeadline } from './dashboard-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'settings', 'index.html');

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface ProfileState {
  name: string | null;
  timezone: string | null;
  slug: string | null;
  region: 'us' | 'eu' | 'apac' | null;
}

interface DesiredProfile {
  name: string;
  timezone: string;
  slug: string;
  region: 'us' | 'eu' | 'apac';
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function abortError(): Error {
  const error = new Error('response lost after commit');
  error.name = 'AbortError';
  return error;
}

function accountBody(profile: ProfileState): Record<string, unknown> {
  return {
    id: 'acc_test',
    email: 'me@example.test',
    avatar_url: null,
    avatar_source: 'none',
    ...profile,
  };
}

function fallbackRoute(profile: ProfileState, call: FetchCall): Response {
  const method = (call.init?.method || 'GET').toUpperCase();
  const path = call.url.replace(/^https?:\/\/[^/]+/, '');
  if (/\/v1\/account\/me$/.test(path) && method === 'GET') return json(accountBody(profile));
  if (/\/v1\/account\/email-preferences$/.test(path)) return json({ data: [] });
  if (/\/v1\/account\/audit-log/.test(path)) return json({ data: [] });
  if (/\/v1\/account\/web-sessions$/.test(path)) return json({ data: [] });
  return json({}, 404);
}

function setUpDom(route: (call: FetchCall) => Response | Promise<Response>): {
  window: JSDOM['window'];
  fetchCalls: FetchCall[];
} {
  const html = readFileSync(BUILT_PAGE, 'utf8');
  const scripts: string[] = [];
  const htmlNoScripts = html.replace(/<script[^>]*>([\s\S]*?)<\/script>/g, (_m, body: string) => {
    scripts.push(body);
    return '';
  });
  const dom = new JSDOM(htmlNoScripts, {
    url: 'https://app.driftstack.io/settings/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const fetchCalls: FetchCall[] = [];
  // @ts-expect-error — jsdom does not expose undici Response by default.
  if (typeof window.Response !== 'function') window.Response = Response;
  // @ts-expect-error — deterministic browser-fetch seam for built-page behavior.
  window.fetch = (input: string, init: RequestInit | undefined) => {
    const call = { url: String(input), init };
    fetchCalls.push(call);
    return Promise.resolve().then(() => route(call));
  };
  window.localStorage.setItem('ds_web_session_token', 'tok');
  const pageScript = scripts.find((body) => body.includes('data-page="settings"'));
  if (!pageScript) throw new Error('settings inline script not found');
  installDashboardDeadline(window);
  // @ts-expect-error — eval is the intended built-page seam.
  window.eval(pageScript);
  return { window: window as JSDOM['window'], fetchCalls };
}

function setProfileInputs(window: JSDOM['window'], profile: DesiredProfile): void {
  const values: Array<[string, string]> = [
    ['[data-field="profile-name"]', profile.name],
    ['[data-field="profile-timezone"]', profile.timezone],
    ['[data-field="profile-slug"]', profile.slug],
    ['[data-field="profile-region"]', profile.region],
  ];
  for (const [selector, value] of values) {
    const control = window.document.querySelector(selector) as HTMLInputElement;
    control.value = value;
    control.dispatchEvent(new window.Event('input', { bubbles: true }));
    control.dispatchEvent(new window.Event('change', { bubbles: true }));
  }
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('settings page — profile hydration and timeout reconciliation', () => {
  let win: JSDOM['window'] | null = null;

  afterEach(() => {
    win?.close?.();
    win = null;
  });

  it('does not let a delayed initial profile response overwrite typing', async () => {
    const profile: ProfileState = {
      name: 'Server Name',
      timezone: 'UTC',
      slug: 'server-name',
      region: 'eu',
    };
    let resolveInitial: ((response: Response) => void) | undefined;
    let firstMe = true;
    const { window } = setUpDom((call) => {
      if (/\/v1\/account\/me$/.test(call.url) && !call.init?.method && firstMe) {
        firstMe = false;
        return new Promise<Response>((resolvePromise) => {
          resolveInitial = resolvePromise;
        });
      }
      return fallbackRoute(profile, call);
    });
    win = window;

    const name = window.document.querySelector('[data-field="profile-name"]') as HTMLInputElement;
    name.value = 'Typing Must Survive';
    name.dispatchEvent(new window.Event('input', { bubbles: true }));
    resolveInitial?.(json(accountBody(profile)));
    await flush();

    expect(name.value).toBe('Typing Must Survive');
  });

  it('confirms a committed PATCH timeout only after all live fields match', async () => {
    const profile: ProfileState = {
      name: 'Old Name',
      timezone: 'UTC',
      slug: 'old-name',
      region: 'eu',
    };
    const desired = {
      name: 'New Name',
      timezone: 'America/New_York',
      slug: 'new-name',
      region: 'us' as const,
    };
    const { window, fetchCalls } = setUpDom((call) => {
      if (call.init?.method === 'PATCH' && /\/v1\/account\/me$/.test(call.url)) {
        Object.assign(profile, JSON.parse(String(call.init.body)) as ProfileState);
        return Promise.reject(abortError());
      }
      return fallbackRoute(profile, call);
    });
    win = window;
    await flush();
    setProfileInputs(window, desired);
    (window.document.querySelector('[data-form="profile"]') as HTMLFormElement).dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true }),
    );
    await flush(14);

    expect(fetchCalls.filter((call) => call.init?.method === 'PATCH')).toHaveLength(1);
    expect(window.document.querySelector('[data-field="profile-status"]')?.textContent).toContain(
      'live profile matches',
    );
    expect(
      window.document.querySelector('[data-field="profile-error"]')?.classList.contains('hidden'),
    ).toBe(true);
  });

  it('treats a malformed accepted PATCH body as saved without duplicate retry guidance', async () => {
    const profile: ProfileState = {
      name: 'Old Name',
      timezone: 'UTC',
      slug: 'old-name',
      region: 'eu',
    };
    const desired = {
      name: 'Accepted Name',
      timezone: 'America/New_York',
      slug: 'accepted-name',
      region: 'us' as const,
    };
    const { window, fetchCalls } = setUpDom((call) => {
      if (call.init?.method === 'PATCH' && /\/v1\/account\/me$/.test(call.url)) {
        Object.assign(profile, JSON.parse(String(call.init.body)) as ProfileState);
        return new Response('{', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return fallbackRoute(profile, call);
    });
    win = window;
    await flush();
    setProfileInputs(window, desired);
    const form = window.document.querySelector('[data-form="profile"]') as HTMLFormElement;
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(fetchCalls.filter((call) => call.init?.method === 'PATCH')).toHaveLength(1);
    expect(window.document.querySelector('[data-field="profile-status"]')?.textContent).toBe(
      'Saved.',
    );
    expect(
      window.document.querySelector('[data-field="profile-error"]')?.classList.contains('hidden'),
    ).toBe(true);
  });

  it('preserves desired inputs when a timed-out PATCH did not commit', async () => {
    const profile: ProfileState = {
      name: 'Old Name',
      timezone: 'UTC',
      slug: 'old-name',
      region: 'eu',
    };
    const desired = {
      name: 'Wanted Name',
      timezone: 'America/Chicago',
      slug: 'wanted-name',
      region: 'apac' as const,
    };
    const { window } = setUpDom((call) => {
      if (call.init?.method === 'PATCH' && /\/v1\/account\/me$/.test(call.url)) {
        return Promise.reject(abortError());
      }
      return fallbackRoute(profile, call);
    });
    win = window;
    await flush();
    setProfileInputs(window, desired);
    (window.document.querySelector('[data-form="profile"]') as HTMLFormElement).dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true }),
    );
    await flush(14);

    expect(
      (window.document.querySelector('[data-field="profile-name"]') as HTMLInputElement).value,
    ).toBe(desired.name);
    expect(window.document.querySelector('[data-field="profile-error"]')?.textContent).toContain(
      'live profile differs',
    );
  });
});
