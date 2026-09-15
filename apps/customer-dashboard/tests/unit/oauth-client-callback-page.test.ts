// Local integration test for the /auth/oauth-client/callback page's inline
// script — the page every provider sign-in (Google / GitHub, from /login and
// /signup) lands on. Cookie-free v2 only: the v1 ?code=&state= XHR exchange
// (GET /v1/auth/oauth-client/callback carrying a PKCE cookie) was retired
// 2026-09-14 after its 24-hour compatibility window, and the arm at the bottom
// pins that a query-string arrival is refused WITHOUT any request.
//
// Loads the BUILT page, seeds the ds_oauth_flow.<flow_id> record that
// login.astro / signup.astro write before leaving for the IDP, mocks fetch,
// eval's the script, and asserts the real branches. jsdom cannot navigate: the
// page's window.location.href assignment surfaces as a "Not implemented:
// navigation" jsdomError, which is counted rather than logged so an arm can
// assert "did not leave" as a number.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(
  HERE,
  '..',
  '..',
  'dist',
  'auth',
  'oauth-client',
  'callback',
  'index.html',
);
const PAGE_URL = 'https://app.driftstack.io/auth/oauth-client/callback/';
const FLOW_ID = 'FLOW_ID_TEST';
const FLOW_SECRET = 'flow-secret-43-chars-base64url-placeholder-xyz';
const HANDOFF_CODE = 'handoff_code_123';
const V2_URL = `${PAGE_URL}#flow=${FLOW_ID}&code=${HANDOFF_CODE}`;
// The retired v1 shape: the IDP query string an old server forwarded verbatim.
const LEGACY_URL = `${PAGE_URL}?code=oauth_code_123&state=state_123&provider=github`;

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
  // Captured when the request leaves: the page must strip the fragment BEFORE
  // any await, so the hand-off code never sits in the URL bar mid-redeem.
  hashAtCall: string;
}

interface SetUpOpts {
  url?: string;
  storageDenied?: boolean;
  // null → no record seeded (a flow this browser did not start). Default: a
  // fresh record for FLOW_ID, exactly as login.astro writes it.
  flowRecord?: { secret: string; iat: number } | null;
}

interface DomHandle {
  window: JSDOM['window'];
  fetchCalls: MockFetchCall[];
  navigations: () => number;
}

function setUpDom(
  html: string,
  handler: (call: MockFetchCall) => Response | Promise<Response>,
  opts: SetUpOpts = {},
): DomHandle {
  const scriptBodies: string[] = [];
  const htmlNoScripts = html.replace(/<script[^>]*>([\s\S]*?)<\/script>/g, (_m, body: string) => {
    scriptBodies.push(body);
    return '';
  });
  const virtualConsole = new VirtualConsole();
  let navigationCount = 0;
  virtualConsole.on('jsdomError', (err: Error) => {
    if (/Not implemented: navigation/.test(String(err && err.message))) {
      navigationCount += 1;
      return;
    }
    // eslint-disable-next-line no-console
    console.error(err);
  });
  const dom = new JSDOM(htmlNoScripts, {
    url: opts.url ?? V2_URL,
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
    const call: MockFetchCall = { url: String(input), init, hashAtCall: window.location.hash };
    fetchCalls.push(call);
    return Promise.resolve(handler(call));
  };
  // Seed BEFORE any storage fault: the record is what /login wrote earlier, in
  // a working browser, before the page under test ran.
  if (opts.flowRecord !== null) {
    window.localStorage.setItem(
      `ds_oauth_flow.${FLOW_ID}`,
      JSON.stringify(opts.flowRecord ?? { secret: FLOW_SECRET, iat: Date.now() }),
    );
  }
  if (opts.storageDenied) {
    const storagePrototype = Object.getPrototypeOf(window.localStorage);
    const setItem = storagePrototype.setItem;
    Object.defineProperty(storagePrototype, 'setItem', {
      configurable: true,
      value(this: Storage, key: string, value: string) {
        if (this === window.localStorage) throw new Error('storage denied');
        return setItem.call(this, key, value);
      },
    });
  }

  const pageScript = scriptBodies.find((body) => body.includes('data-page="oauth-callback"'));
  if (!pageScript) throw new Error('oauth callback inline script not found');
  // @ts-expect-error — jsdom global has eval
  window.eval(pageScript);
  return { window: window as JSDOM['window'], fetchCalls, navigations: () => navigationCount };
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function bannerText(window: JSDOM['window']): string {
  return window.document.querySelector('[data-banner]')?.textContent ?? '';
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Wait UNTIL something is true; a fixed turn count turns machine load into a verdict. */
async function until(predicate: () => boolean, what: string, turns = 500): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`timed out after ${String(turns)} turns waiting for ${what}`);
}

const redeemCalls = (calls: MockFetchCall[]): MockFetchCall[] =>
  calls.filter((c) => /\/v1\/auth\/oauth-client\/redeem$/.test(c.url));

describe('OAuth client callback page', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });
  const loadBuiltPage = (): string => readFileSync(BUILT_PAGE, 'utf8');

  it('v2: redeems the fragment hand-off with {code, flow_secret} and NO credentials, strips the fragment before the request leaves, consumes the flow record once, and stores the session', async () => {
    const { window, fetchCalls, navigations } = setUpDom(loadBuiltPage(), () =>
      json({
        outcome: 'signed-in-existing-link',
        session_token: 'ds_web_v2',
        redirect_to: '/settings',
      }),
    );
    win = window;
    await until(() => navigations() >= 1, 'the post-redeem navigation');

    expect(fetchCalls).toHaveLength(1);
    const redeem = fetchCalls[0];
    expect(redeem?.url).toMatch(/\/v1\/auth\/oauth-client\/redeem$/);
    expect(redeem?.init?.method).toBe('POST');
    expect(JSON.parse(String(redeem?.init?.body))).toEqual({
      code: HANDOFF_CODE,
      flow_secret: FLOW_SECRET,
    });
    // The retired v1 exchange carried `credentials: 'include'` for its PKCE
    // cookie; v2 has no cookie in either direction, so a restored value reads
    // here as defined.
    expect(redeem?.init?.credentials).toBeUndefined();
    expect(redeem?.hashAtCall).toBe('');
    expect(window.location.hash).toBe('');
    expect(window.localStorage.getItem(`ds_oauth_flow.${FLOW_ID}`)).toBeNull();
    expect(window.localStorage.getItem('ds_web_session_token')).toBe('ds_web_v2');
  });

  it('does not redeem the one-time hand-off when session storage is unavailable, and leaves the flow record for a retry', async () => {
    const { window, fetchCalls, navigations } = setUpDom(
      loadBuiltPage(),
      () => new Response('{}', { status: 500 }),
      { storageDenied: true },
    );
    win = window;
    await flush();

    expect(fetchCalls).toHaveLength(0);
    expect(navigations()).toBe(0);
    expect(window.location.hash).toBe('');
    expect(bannerText(window)).toMatch(
      /blocking site storage.*sign-in needs.*allow it, then start sign-in again/i,
    );
    expect(window.localStorage.getItem(`ds_oauth_flow.${FLOW_ID}`)).not.toBeNull();
  });

  it('refuses a hand-off whose flow record is missing (started in another browser or window) without any request', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), () => json({}), {
      flowRecord: null,
    });
    win = window;
    await flush();

    expect(fetchCalls).toHaveLength(0);
    expect(window.location.hash).toBe('');
    expect(bannerText(window)).toMatch(/started in a different browser or window/i);
  });

  it('refuses a stale flow record (>10 min) without any request and discards it', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), () => json({}), {
      flowRecord: { secret: FLOW_SECRET, iat: Date.now() - 11 * 60 * 1000 },
    });
    win = window;
    await flush();

    expect(fetchCalls).toHaveLength(0);
    expect(bannerText(window)).toMatch(/started in a different browser or window.*took too long/i);
    expect(window.localStorage.getItem(`ds_oauth_flow.${FLOW_ID}`)).toBeNull();
  });

  it('turns a redeem timeout into a fresh-authorization recovery path', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), () => Promise.reject(timeout));
    win = window;
    await flush(12);

    expect(redeemCalls(fetchCalls)).toHaveLength(1);
    expect(window.location.hash).toBe('');
    expect(bannerText(window)).toMatch(
      /took too long.*not sure what happened.*don't reload this page.*check your inbox for a confirmation email first.*if nothing arrives.*return to sign-in and try again/i,
    );
    expect(
      window.document.querySelector('[data-callback-unknown]')?.classList.contains('hidden'),
    ).toBe(false);
    expect(window.document.querySelector('[data-callback-unknown] a')?.getAttribute('href')).toBe(
      '/login/',
    );
  });

  it('completes an OAuth-issued MFA challenge without asking for the password again, with NO credentials on either request', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), (call) => {
      if (/\/v1\/auth\/mfa\/challenge$/.test(call.url)) {
        return json({ session: { token: 'ds_web_oauth_mfa', expires_at: '2026-08-01' } });
      }
      return json({
        outcome: 'signed-in-existing-link',
        account_id: 'acc_test',
        redirect_to: '/settings',
        mfa_required: true,
        challenge_token: 'ds_mfac_oauth',
        challenge_expires_at: new Date(Date.now() + 300_000).toISOString(),
      });
    });
    win = window;
    await flush();

    const form = window.document.querySelector('[data-form="oauth-mfa"]') as HTMLFormElement;
    const input = window.document.querySelector('#oauth-mfa-code') as HTMLInputElement;
    expect(form.classList.contains('hidden')).toBe(false);
    expect(window.localStorage.getItem('ds_web_session_token')).toBeNull();
    input.value = '123456';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]?.url).toMatch(/\/v1\/auth\/oauth-client\/redeem$/);
    expect(fetchCalls[1]?.url).toMatch(/\/v1\/auth\/mfa\/challenge$/);
    expect(fetchCalls[1]?.init?.method).toBe('POST');
    expect(JSON.parse(String(fetchCalls[1]?.init?.body))).toEqual({
      challenge_token: 'ds_mfac_oauth',
      code: '123456',
    });
    // The challenge token is the whole credential (login.astro submits it the
    // same way); no cookie exists in v2 to carry alongside it.
    expect(fetchCalls[0]?.init?.credentials).toBeUndefined();
    expect(fetchCalls[1]?.init?.credentials).toBeUndefined();
    expect(window.localStorage.getItem('ds_web_session_token')).toBe('ds_web_oauth_mfa');
  });

  it('locks an OAuth MFA challenge after an ambiguous exchange timeout', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), (call) => {
      if (/\/v1\/auth\/mfa\/challenge$/.test(call.url)) return Promise.reject(timeout);
      return json({
        outcome: 'signed-in-existing-link',
        redirect_to: '/',
        mfa_required: true,
        challenge_token: 'ds_mfac_unknown',
        challenge_expires_at: new Date(Date.now() + 300_000).toISOString(),
      });
    });
    win = window;
    await flush();
    const form = window.document.querySelector('[data-form="oauth-mfa"]') as HTMLFormElement;
    const input = window.document.querySelector('#oauth-mfa-code') as HTMLInputElement;
    input.value = '123456';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(fetchCalls.filter((call) => /\/v1\/auth\/mfa\/challenge$/.test(call.url))).toHaveLength(
      1,
    );
    expect(window.localStorage.getItem('ds_web_session_token')).toBeNull();
    expect(form.classList.contains('hidden')).toBe(true);
    expect(bannerText(window)).toMatch(
      /took too long.*your code may already have been used.*don't enter it again.*start a fresh sign-in/i,
    );
  });

  it('collision-pending-verification names the provider from the redeem answer (the fragment carries no query string to read it from); an answer with no provider renders the documented default, Google', async () => {
    for (const [provider, label] of [
      ['github', 'GitHub'],
      ['google', 'Google'],
      // No provider in the answer: JSON.stringify drops the undefined key, so
      // the page sees no `provider` at all and must fall to its default.
      [undefined, 'Google'],
    ] as const) {
      const { window } = setUpDom(loadBuiltPage(), () =>
        json({
          outcome: 'collision-pending-verification',
          provider,
          expires_at: new Date(Date.now() + 60 * 60 * 1000 + 5_000).toISOString(),
        }),
      );
      win = window;
      await flush();
      expect(
        window.document.querySelector('[data-success-merge]')?.classList.contains('hidden'),
      ).toBe(false);
      expect(window.document.querySelector('[data-merge-provider]')?.textContent).toBe(label);
      expect(window.document.querySelector('[data-merge-window]')?.textContent).toBe('60 minutes');
      window.close();
      win = null;
    }
  });

  it('maps a #oauth_error=<enum> arrival to fixed copy without any request, and strips it from the URL', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), () => json({}), {
      url: `${PAGE_URL}#oauth_error=state_replayed`,
      flowRecord: null,
    });
    win = window;
    await flush();

    expect(fetchCalls).toHaveLength(0);
    expect(window.location.hash).toBe('');
    expect(bannerText(window)).toMatch(/already been used or has expired.*return to sign-in/i);
  });

  it('retired v1: a ?code=&state= query arrival is scrubbed from history and refused without ANY request — the GET /v1/auth/oauth-client/callback exchange no longer exists', async () => {
    const { window, fetchCalls, navigations } = setUpDom(loadBuiltPage(), () => json({}), {
      url: LEGACY_URL,
      flowRecord: null,
    });
    win = window;
    await flush(12);

    // Direction of the real failure: the pre-retirement page fired a
    // credentialed GET to the v1 route here. Nothing may reach the server.
    expect(fetchCalls).toHaveLength(0);
    expect(navigations()).toBe(0);
    expect(window.location.search).toBe('');
    expect(window.location.pathname).toBe('/auth/oauth-client/callback/');
    // Neutral copy: no server path produces a query arrival, so the page
    // cannot attribute it to any sign-in page and must not claim to.
    expect(bannerText(window)).toMatch(
      /this link cannot complete a sign-in.*return to sign-in and try again/i,
    );
    expect(bannerText(window)).not.toMatch(/outdated/i);
  });

  it('no fragment and no query → "This page needs to be opened from a Google or GitHub sign-in." without any request', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), () => json({}), {
      url: PAGE_URL,
      flowRecord: null,
    });
    win = window;
    await flush();

    expect(fetchCalls).toHaveLength(0);
    expect(bannerText(window)).toBe(
      'This page needs to be opened from a Google or GitHub sign-in. Return to sign-in and try again.',
    );
  });
});
