// A sign-in link asks before replacing a signed-in session (security sweep #21).
//
// The magic-link page used the link's token on load and overwrote whatever session
// the browser held, with no click and no word. A link is not bound to the browser
// that asked for it, so one requested by someone else and sent as "join my
// workspace" swapped a signed-in customer into THAT account in one click — anything
// typed next (a provider key, proxy credentials, profile logins) landed where its
// owner could read it. The previous session was orphaned, not signed out.
//
// Now, when the browser is already signed in, the page names the current account
// and waits for "Continue with this link"; continuing signs the previous session
// out. A browser with no session uses the link on load exactly as before — and so
// does one whose stored session the server no longer accepts (401): there is no
// live account to protect, so the dead token is cleared instead of asked about.
//
// Runs the BUILT page's inline script in jsdom against a scripted fetch.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
// @ts-expect-error — jsdom ships no type declarations in this workspace's test config.
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installDashboardDeadline } from './dashboard-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'auth', 'magic-link', 'index.html');
const PAGE_URL = 'https://app.driftstack.io/auth/magic-link/?token=link_from_someone';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Load the page with `existing` already in storage; `answer` scripts fetch by URL. */
function load(
  existing: string | null,
  answer: (call: Call) => Response,
): { window: JSDOM['window']; calls: Call[] } {
  const scripts: string[] = [];
  const html = readFileSync(BUILT_PAGE, 'utf8').replace(
    /<script[^>]*>([\s\S]*?)<\/script>/g,
    (_m, body: string) => {
      scripts.push(body);
      return '';
    },
  );
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err: Error) => {
    if (!/Not implemented: navigation/.test(String(err && err.message))) {
      // eslint-disable-next-line no-console
      console.error(err);
    }
  });
  const dom = new JSDOM(html, {
    url: PAGE_URL,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  if (existing !== null) window.localStorage.setItem('ds_web_session_token', existing);
  const calls: Call[] = [];
  if (typeof window.Response !== 'function') window.Response = Response;
  window.fetch = (input: string, init: RequestInit | undefined) => {
    const call = { url: String(input), init };
    calls.push(call);
    return Promise.resolve(answer(call));
  };
  installDashboardDeadline(window as JSDOM['window']);
  const pageScript = scripts.find((body) => body.includes('data-page="magic-link"'));
  if (!pageScript) throw new Error('magic-link inline script not found');
  window.eval(pageScript);
  return { window: window as JSDOM['window'], calls };
}

function answer(call: Call): Response {
  if (call.url.endsWith('/v1/account/me')) return json({ email: 'me@example.test' });
  if (call.url.endsWith('/v1/auth/magic-link/consume')) {
    return json({ session: { token: 'session_from_link' } });
  }
  if (call.url.endsWith('/v1/auth/logout')) return json({ ok: true });
  return json({}, 500);
}

const consumes = (calls: Call[]): Call[] =>
  calls.filter((c) => c.url.endsWith('/v1/auth/magic-link/consume'));

describe('a sign-in link asks before replacing a signed-in session', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });

  it('CRITICAL a signed-in browser is not switched on load: the link waits, the current account is named, and the session stays', async () => {
    const { window, calls } = load('my_own_session', answer);
    win = window;
    await flush();

    expect(consumes(calls), 'the link was used without a click').toEqual([]);
    expect(window.localStorage.getItem('ds_web_session_token')).toBe('my_own_session');
    const panel = window.document.querySelector('[data-switch-account]');
    expect(panel?.classList.contains('hidden')).toBe(false);
    expect(window.document.querySelector('[data-current-account]')?.textContent).toBe(
      ' as me@example.test',
    );
    // The link's token is not left in the address bar while the page waits.
    expect(window.location.search).toBe('');
  });

  it('CRITICAL continuing uses the link, keeps the new session, and signs the previous one out', async () => {
    const { window, calls } = load('my_own_session', answer);
    win = window;
    await flush();

    (window.document.querySelector('[data-button="use-link"]') as HTMLButtonElement).click();
    await flush();

    expect(consumes(calls)).toHaveLength(1);
    expect(JSON.parse(String(consumes(calls)[0]?.init?.body))).toEqual({
      token: 'link_from_someone',
    });
    expect(window.localStorage.getItem('ds_web_session_token')).toBe('session_from_link');
    const logout = calls.find((c) => c.url.endsWith('/v1/auth/logout'));
    expect(logout, 'the previous session was left live').toBeDefined();
    expect(JSON.parse(String(logout?.init?.body))).toEqual({ token: 'my_own_session' });
  });

  it('a stored session the server no longer accepts is cleared and the link is used without asking', async () => {
    const { window, calls } = load('revoked_session', (call) =>
      call.url.endsWith('/v1/account/me') ? json({ title: 'Unauthorized' }, 401) : answer(call),
    );
    win = window;
    await flush();

    expect(consumes(calls), 'the link waited on a session that is already dead').toHaveLength(1);
    expect(window.localStorage.getItem('ds_web_session_token')).toBe('session_from_link');
    expect(
      window.document.querySelector('[data-switch-account]')?.classList.contains('hidden'),
    ).toBe(true);
    // Nothing live to sign out.
    expect(calls.some((c) => c.url.endsWith('/v1/auth/logout'))).toBe(false);
  });

  it('CONTROL a live session that merely fails to load its account (a 500) still asks first', async () => {
    const { window, calls } = load('my_own_session', (call) =>
      call.url.endsWith('/v1/account/me') ? json({}, 500) : answer(call),
    );
    win = window;
    await flush();

    expect(consumes(calls)).toEqual([]);
    expect(window.localStorage.getItem('ds_web_session_token')).toBe('my_own_session');
    expect(
      window.document.querySelector('[data-switch-account]')?.classList.contains('hidden'),
    ).toBe(false);
  });

  it('CONTROL a browser with no session uses the link on load, as before, and signs nothing out', async () => {
    const { window, calls } = load(null, answer);
    win = window;
    await flush();

    expect(consumes(calls)).toHaveLength(1);
    expect(window.localStorage.getItem('ds_web_session_token')).toBe('session_from_link');
    expect(calls.some((c) => c.url.endsWith('/v1/auth/logout'))).toBe(false);
    expect(
      window.document.querySelector('[data-switch-account]')?.classList.contains('hidden'),
    ).toBe(true);
  });
});
