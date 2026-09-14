// Local integration test for the /login page's inline script — the
// single most critical customer flow (sign-in). A wiring bug here means
// nobody can authenticate. Covers the V-079 password login + the
// V-353d MFA-required discriminated-union branch + token storage + the
// V-269 ?next= round-trip + V-667.C OAuth start. Only source-regex
// coverage before. Loads the BUILT page, mocks localStorage + fetch,
// eval's the script, and asserts the real branches.
//
// Mirrors recipes-page.test.ts (FIFO plan — login fetches on submit /
// oauth-click, not on load). The page navigates via
// window.location.href on success; jsdom can't navigate and emits a
// "Not implemented: navigation" jsdomError — filtered via VirtualConsole
// — so each test asserts the side effect that happens BEFORE the
// navigation (token stored / fetch fired), which is the meaningful wire.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installDashboardDeadline } from './dashboard-test-runtime';
import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'login', 'index.html');
const DEFAULT_URL = 'https://app.driftstack.io/login/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface SetUpOpts {
  url?: string;
  requestTimeoutImmediately?: boolean;
  requestTimeoutOnCall?: number;
  fetchPlan?: Array<(call: MockFetchCall) => Response | Promise<Response>>;
  storageFault?: 'deny-all' | 'drop-session-write';
  // false → the window has NO crypto.subtle (a non-secure context). The v1
  // page fell back to the cookie start here; v2 has nothing to fall back to
  // and /start refuses a body without binding_hash, so the click must be
  // refused locally, before any request.
  webCrypto?: boolean;
}

function faultLocalStorage(window: JSDOM['window'], mode: 'deny-all' | 'drop-session-write'): void {
  const storage = window.localStorage;
  const proto = Object.getPrototypeOf(storage) as Storage;
  const nativeGet = proto.getItem;
  const nativeSet = proto.setItem;
  const nativeRemove = proto.removeItem;
  proto.getItem = function (key: string): string | null {
    if (this === storage && mode === 'deny-all') throw new Error('storage denied');
    return nativeGet.call(this, key);
  };
  proto.setItem = function (key: string, value: string): void {
    if (this === storage && mode === 'deny-all') throw new Error('storage denied');
    if (this === storage && mode === 'drop-session-write' && key === 'ds_web_session_token') return;
    nativeSet.call(this, key, value);
  };
  proto.removeItem = function (key: string): void {
    if (this === storage && mode === 'deny-all') throw new Error('storage denied');
    nativeRemove.call(this, key);
  };
}

interface DomHandle {
  window: JSDOM['window'];
  fetchCalls: MockFetchCall[];
  // jsdom cannot navigate: every `window.location.href = …` the page performs
  // surfaces as a "Not implemented: navigation" jsdomError. Counting them turns
  // "did the page leave for the IDP?" into an assertable number, so a refusal
  // arm can prove the page did NOT navigate — not merely that a banner showed.
  navigations: () => number;
}

function setUpDom(html: string, opts: SetUpOpts): DomHandle {
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
    url: opts.url ?? DEFAULT_URL,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  // jsdom ships no WebCrypto, so without this the built page's OAuth v2 branch (which
  // hashes a browser-held flow secret with crypto.subtle) is never exercised and the
  // click is refused locally as a non-secure context. Node's webcrypto is the real
  // thing. `webCrypto: false` forces the absence explicitly (never relying on what a
  // given jsdom happens to ship) for the arm that pins that refusal.
  if (opts.webCrypto === false) {
    Object.defineProperty(window.crypto, 'subtle', { value: undefined, configurable: true });
  } else if (typeof (window.crypto as Crypto | undefined)?.subtle === 'undefined') {
    Object.defineProperty(window.crypto, 'subtle', { value: webcrypto.subtle });
  }
  // The page encodes the secret with TextEncoder before hashing; jsdom's realm has
  // none, and the page's own guard would turn that into the same local refusal.
  if (typeof (window as unknown as { TextEncoder?: unknown }).TextEncoder === 'undefined') {
    Object.defineProperty(window, 'TextEncoder', { value: TextEncoder });
  }
  const fetchCalls: MockFetchCall[] = [];
  const plan = [...(opts.fetchPlan ?? [])];
  // @ts-expect-error — jsdom global is loose
  if (typeof window.Response !== 'function') window.Response = Response;
  // @ts-expect-error — jsdom global is loose
  window.fetch = (input: string, init: RequestInit | undefined) => {
    const call: MockFetchCall = { url: String(input), init };
    fetchCalls.push(call);
    const handler = plan.shift();
    if (!handler) {
      // eslint-disable-next-line no-console
      console.warn('[login-page test] unplanned fetch:', call.url);
      return Promise.resolve(new Response('{}', { status: 500 }));
    }
    return Promise.resolve(handler(call));
  };
  if (opts.storageFault) faultLocalStorage(window as JSDOM['window'], opts.storageFault);
  if (opts.requestTimeoutImmediately) {
    let requestTimerCount = 0;
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (
        timeout === 15_000 &&
        (++requestTimerCount === (opts.requestTimeoutOnCall ?? 1) ||
          (opts.requestTimeoutOnCall === undefined && opts.requestTimeoutImmediately))
      ) {
        window.queueMicrotask(() => {
          if (typeof handler === 'function') handler(...args);
        });
        return 42;
      }
      return nativeSetTimeout(handler, timeout, ...args);
    }) as typeof window.setTimeout;
  }

  installDashboardDeadline(window);
  const pageScript = scriptBodies.find((s) => s.includes('data-page="login"'));
  if (!pageScript) throw new Error('login inline script not found');
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

function bannerHidden(window: JSDOM['window']): boolean {
  const b = window.document.querySelector('[data-banner]');
  return !b || b.classList.contains('hidden');
}
function bannerText(window: JSDOM['window']): string {
  return window.document.querySelector('[data-banner]')?.textContent ?? '';
}

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

/**
 * Wait UNTIL something is true, rather than for a fixed number of turns.
 *
 * ⛔ `flush()` yields exactly four macrotask turns, which is a bet that the page
 * reaches the state in four. On an idle machine it does. Under the full suite it
 * does not: the pre-push gate failed 2026-09-14 on "OAuth start blocks a
 * competing password submit" with `expected [] to have a length of 1` — zero
 * fetches, i.e. the click handler had not run yet, not a wrong result. The same
 * file passed four times out of four in isolation immediately after.
 *
 * A fixed wait turns machine load into a test verdict, and it fails in the
 * direction that costs most: it blocks every push, including the ones that had
 * nothing to do with it. Use this wherever an assertion depends on WORK HAVING
 * STARTED; `flush()` is still right where the point is that nothing further
 * happens. The throw is deliberate — a silent timeout would just move the same
 * confusing failure one line down.
 */
async function until(predicate: () => boolean, what: string, turns = 500): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`timed out after ${String(turns)} turns waiting for ${what}`);
}

function submitLogin(window: JSDOM['window'], email: string, password: string): void {
  const form = window.document.querySelector('[data-form="login"]') as HTMLFormElement;
  (form.querySelector('input[name="email"]') as HTMLInputElement).value = email;
  (form.querySelector('input[name="password"]') as HTMLInputElement).value = password;
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

function oauthButton(window: JSDOM['window']): HTMLButtonElement {
  const btn = window.document.querySelector('[data-oauth]') as HTMLButtonElement | null;
  // No skip-on-absence branch: a build that dropped the provider buttons must
  // red here, not pass vacuously.
  expect(btn, 'the built /login page must render a [data-oauth] button').not.toBeNull();
  return btn as HTMLButtonElement;
}

function flowKeys(window: JSDOM['window']): string[] {
  const keys: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (k && k.startsWith('ds_oauth_flow.')) keys.push(k);
  }
  return keys;
}

describe('login page — local integration', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });
  const loadBuiltPage = (): string => readFileSync(BUILT_PAGE, 'utf8');

  it('successful login stores the web session token under ds_web_session_token', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      fetchPlan: [() => json({ session: { token: 'ds_web_THE_TOKEN' } })],
    });
    win = window;
    window.localStorage.setItem('ds_act_as_account', 'acct_previous');
    window.localStorage.setItem('ds_is_team_user', 'true');
    window.localStorage.setItem('ds_is_staff_user', 'true');
    submitLogin(window, 'alice@example.com', 'hunter2');
    await flush();
    const post = fetchCalls.find((c) => /\/v1\/auth\/login$/.test(c.url));
    expect(post?.init?.method).toBe('POST');
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      email: 'alice@example.com',
      password: 'hunter2',
    });
    expect(window.localStorage.getItem('ds_web_session_token')).toBe('ds_web_THE_TOKEN');
    expect(window.localStorage.getItem('ds_act_as_account')).toBeNull();
    expect(window.localStorage.getItem('ds_is_team_user')).toBeNull();
    expect(window.localStorage.getItem('ds_is_staff_user')).toBeNull();
  });

  it('does not send credentials when persistent browser storage is unavailable', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      storageFault: 'deny-all',
      fetchPlan: [() => json({ session: { token: 'must-not-be-issued' } })],
    });
    win = window;
    submitLogin(window, 'alice@example.com', 'hunter2');
    await flush();

    expect(fetchCalls).toHaveLength(0);
    const form = window.document.querySelector('[data-form="login"]') as HTMLFormElement;
    expect((form.querySelector('input[name="email"]') as HTMLInputElement).value).toBe(
      'alice@example.com',
    );
    expect((form.querySelector('input[name="password"]') as HTMLInputElement).value).toBe(
      'hunter2',
    );
    expect(bannerText(window)).toMatch(/enable browser site storage.*no sign-in request was sent/i);
  });

  it('detects a silently discarded session and does not navigate as signed in', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      storageFault: 'drop-session-write',
      fetchPlan: [() => json({ session: { token: 'lost-login-session' } })],
    });
    win = window;
    submitLogin(window, 'alice@example.com', 'hunter2');
    await flush();

    expect(fetchCalls).toHaveLength(1);
    expect(window.localStorage.getItem('ds_web_session_token')).toBeNull();
    expect(bannerText(window)).toMatch(
      /sign-in succeeded.*could not persist the session.*enable site storage.*sign in again/i,
    );
  });

  it('V-353d/W528 MFA-required branch: opens the MFA challenge form (login form hides), stores NO token yet, does not redirect', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      fetchPlan: [() => json({ mfa_required: true, challenge_token: 'chal_x' })],
    });
    win = window;
    submitLogin(window, 'mfa@example.com', 'pw');
    await flush();
    const loginForm = window.document.querySelector('[data-form="login"]');
    const mfaForm = window.document.querySelector('[data-form="mfa"]');
    expect(loginForm?.classList.contains('hidden')).toBe(true);
    expect(mfaForm?.classList.contains('hidden')).toBe(false);
    expect(window.localStorage.getItem('ds_web_session_token')).toBeNull();
  });

  it('W528 MFA challenge submit: POSTs {challenge_token, code} to /v1/auth/mfa/challenge, stores the session token', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      fetchPlan: [
        () => json({ mfa_required: true, challenge_token: 'chal_x' }),
        () => json({ session: { token: 'ds_web_MFA_TOKEN', expires_at: '2027-01-01T00:00:00Z' } }),
      ],
    });
    win = window;
    submitLogin(window, 'mfa@example.com', 'pw');
    await flush();
    const codeInput = window.document.querySelector('#login-mfa-code') as HTMLInputElement;
    codeInput.value = '123456';
    const mfaForm = window.document.querySelector('[data-form="mfa"]') as HTMLFormElement;
    mfaForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    const challengeCall = fetchCalls.find((c) => /\/v1\/auth\/mfa\/challenge$/.test(c.url));
    expect(challengeCall?.init?.method).toBe('POST');
    expect(JSON.parse(String(challengeCall?.init?.body))).toEqual({
      challenge_token: 'chal_x',
      code: '123456',
    });
    expect(window.localStorage.getItem('ds_web_session_token')).toBe('ds_web_MFA_TOKEN');
  });

  it('does not consume an MFA challenge when storage becomes unavailable', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      fetchPlan: [() => json({ mfa_required: true, challenge_token: 'chal_retryable' })],
    });
    win = window;
    submitLogin(window, 'mfa@example.com', 'pw');
    await flush();
    const mfaForm = window.document.querySelector('[data-form="mfa"]') as HTMLFormElement;
    const codeInput = window.document.querySelector('#login-mfa-code') as HTMLInputElement;
    codeInput.value = '123456';
    faultLocalStorage(window, 'deny-all');
    mfaForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(fetchCalls).toHaveLength(1);
    expect(mfaForm.classList.contains('hidden')).toBe(false);
    expect(codeInput.value).toBe('123456');
    expect(bannerText(window)).toMatch(
      /enable browser site storage.*one-time MFA challenge.*has not been consumed/i,
    );
  });

  it('locks an accepted MFA response whose session is missing and requires fresh sign-in', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      fetchPlan: [
        () => json({ mfa_required: true, challenge_token: 'chal_accepted' }),
        () => json({ via: 'totp' }),
      ],
    });
    win = window;
    submitLogin(window, 'mfa@example.com', 'secret-password');
    await flush();
    const codeInput = window.document.querySelector('#login-mfa-code') as HTMLInputElement;
    codeInput.value = '123456';
    const mfaForm = window.document.querySelector('[data-form="mfa"]') as HTMLFormElement;
    mfaForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(fetchCalls).toHaveLength(2);
    expect(mfaForm.classList.contains('hidden')).toBe(true);
    const loginForm = window.document.querySelector('[data-form="login"]') as HTMLFormElement;
    expect(loginForm.classList.contains('hidden')).toBe(false);
    expect(codeInput.value).toBe('');
    expect(bannerText(window)).toMatch(
      /two-factor verification was accepted.*do not submit this challenge.*fresh sign-in/i,
    );
    mfaForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(fetchCalls).toHaveLength(2);
  });

  it('makes an ambiguous MFA challenge timeout terminal and returns to fresh sign-in', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      requestTimeoutImmediately: true,
      requestTimeoutOnCall: 2,
      fetchPlan: [
        () => json({ mfa_required: true, challenge_token: 'chal_x' }),
        (call) =>
          new Promise<Response>((_resolve, reject) => {
            call.init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      ],
    });
    win = window;
    submitLogin(window, 'mfa@example.com', 'secret-password');
    await flush();
    const codeInput = window.document.querySelector('#login-mfa-code') as HTMLInputElement;
    codeInput.value = '123456';
    const mfaForm = window.document.querySelector('[data-form="mfa"]') as HTMLFormElement;
    mfaForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    mfaForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    mfaForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    const challengeCalls = fetchCalls.filter((c) => /\/v1\/auth\/mfa\/challenge$/.test(c.url));
    expect(challengeCalls).toHaveLength(1);
    expect(challengeCalls[0]?.init?.signal?.aborted).toBe(true);
    expect(mfaForm.classList.contains('hidden')).toBe(true);
    const loginForm = window.document.querySelector('[data-form="login"]') as HTMLFormElement;
    expect(loginForm.classList.contains('hidden')).toBe(false);
    expect((loginForm.querySelector('#login-password') as HTMLInputElement).value).toBe('');
    expect(codeInput.value).toBe('');
    const submitBtn = mfaForm.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);
    expect(submitBtn.getAttribute('aria-busy')).toBe('false');
    expect(submitBtn.textContent).toBe('Verify');
    expect(bannerText(window)).toMatch(
      /outcome is unknown.*consumed this one-time challenge.*credential did not reach.*do not submit.*start a fresh sign-in/i,
    );
  });

  it('keeps the MFA challenge retryable after an authoritative invalid-code response', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      fetchPlan: [
        () => json({ mfa_required: true, challenge_token: 'chal_retry' }),
        () =>
          json(
            {
              type: 'https://errors.driftstack.dev/unauthorized',
              detail: 'Code is invalid at auth.internal. Try again or use a recovery code.',
            },
            401,
          ),
        () => json({ session: { token: 'ds_web_MFA_RETRY' } }),
      ],
    });
    win = window;
    submitLogin(window, 'mfa@example.com', 'secret-password');
    await flush();
    const mfaForm = window.document.querySelector('[data-form="mfa"]') as HTMLFormElement;
    const codeInput = window.document.querySelector('#login-mfa-code') as HTMLInputElement;
    codeInput.value = '000000';
    mfaForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(mfaForm.classList.contains('hidden')).toBe(false);
    expect(bannerText(window)).toMatch(/sign-in could not be verified.*try again/i);
    expect(bannerText(window)).not.toMatch(/auth\.internal/i);
    codeInput.value = '123456';
    mfaForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    const challengeCalls = fetchCalls.filter((c) => /\/v1\/auth\/mfa\/challenge$/.test(c.url));
    expect(challengeCalls).toHaveLength(2);
    expect(JSON.parse(String(challengeCalls[1]?.init?.body))).toEqual({
      challenge_token: 'chal_retry',
      code: '123456',
    });
    expect(window.localStorage.getItem('ds_web_session_token')).toBe('ds_web_MFA_RETRY');
  });

  it('invalid credentials use stable fixed copy and store no token', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      fetchPlan: [
        () =>
          json(
            {
              type: 'https://errors.driftstack.dev/invalid-credentials',
              detail: 'credential lookup failed at auth.internal',
            },
            401,
          ),
      ],
    });
    win = window;
    submitLogin(window, 'bad@example.com', 'wrong');
    await flush();
    expect(bannerHidden(window)).toBe(false);
    expect(bannerText(window)).toMatch(/email or password was not accepted/i);
    expect(bannerText(window)).not.toMatch(/auth\.internal/i);
    expect(window.localStorage.getItem('ds_web_session_token')).toBeNull();
  });

  it('makes an ambiguous verification resend timeout terminal for the page load', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      requestTimeoutImmediately: true,
      requestTimeoutOnCall: 2,
      fetchPlan: [
        () =>
          json(
            {
              type: 'https://errors.driftstack.dev/email-not-verified',
              detail: 'Verify your email before signing in.',
            },
            403,
          ),
        (call) =>
          new Promise<Response>((_resolve, reject) => {
            call.init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      ],
    });
    win = window;
    submitLogin(window, 'pending@example.com', 'secret-password');
    await flush();
    const resendBtn = window.document.querySelector(
      '[data-resend-verification]',
    ) as HTMLButtonElement;
    resendBtn.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    resendBtn.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await flush();
    resendBtn.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await flush();

    const resendCalls = fetchCalls.filter((c) => /\/v1\/auth\/resend-verification$/.test(c.url));
    expect(resendCalls).toHaveLength(1);
    expect(resendCalls[0]?.init?.signal?.aborted).toBe(true);
    expect(resendBtn.disabled).toBe(true);
    expect(resendBtn.getAttribute('aria-busy')).toBe('false');
    const status = window.document.querySelector('[data-resend-status]')?.textContent ?? '';
    expect(status).toMatch(/delivery is unknown.*may already have sent/i);
    expect(status).toMatch(/do not resend again.*inbox and spam.*newest one/i);
  });

  it('treats malformed accepted resend JSON as delivered and refuses forced repeat clicks', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      fetchPlan: [
        () =>
          json(
            {
              type: 'https://errors.driftstack.dev/email-not-verified',
              detail: 'Verify your email before signing in.',
            },
            403,
          ),
        () =>
          new Response('{', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ],
    });
    win = window;
    submitLogin(window, 'pending@example.com', 'secret-password');
    await flush();

    const resendBtn = window.document.querySelector(
      '[data-resend-verification]',
    ) as HTMLButtonElement;
    resendBtn.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    resendBtn.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await flush();
    resendBtn.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await flush();

    expect(fetchCalls.filter((c) => /\/v1\/auth\/resend-verification$/.test(c.url))).toHaveLength(
      1,
    );
    expect(resendBtn.disabled).toBe(true);
    expect(resendBtn.getAttribute('aria-busy')).toBe('false');
    const status = window.document.querySelector('[data-resend-status]')?.textContent ?? '';
    expect(status).toMatch(/verification email sent.*check your inbox.*reload only/i);
    expect(status).not.toMatch(/couldn't resend|try again shortly/i);
  });

  it('serializes duplicate password submits and recovers after the bounded request times out', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      requestTimeoutImmediately: true,
      fetchPlan: [
        (call) =>
          new Promise<Response>((_resolve, reject) => {
            call.init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      ],
    });
    win = window;
    submitLogin(window, 'alice@example.com', 'secret-password');
    submitLogin(window, 'alice@example.com', 'secret-password');
    await flush();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.init?.signal?.aborted).toBe(true);
    const submitBtn = window.document.querySelector(
      '[data-form="login"] button[type="submit"]',
    ) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);
    expect(submitBtn.getAttribute('aria-busy')).toBe('false');
    expect(submitBtn.textContent).toBe('Sign in');
    expect(bannerText(window)).toMatch(/sign-in took too long.*check your connection/i);
  });

  it('V-667.C OAuth start: POSTs exactly {provider, redirect_to, binding_hash} to /v1/auth/oauth-client/start with NO credentials — v2 has no cookie to carry in either direction', async () => {
    const { window, fetchCalls, navigations } = setUpDom(loadBuiltPage(), {
      fetchPlan: [
        () =>
          json({
            authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
            flow_id: 'FLOW_ID_PLAIN',
          }),
      ],
    });
    win = window;
    oauthButton(window).click();
    await until(() => navigations() >= 1, 'the page to leave for the IDP');
    const post = fetchCalls.find((c) => /\/v1\/auth\/oauth-client\/start$/.test(c.url));
    expect(post?.init?.method).toBe('POST');
    const body = JSON.parse(String(post?.init?.body)) as Record<string, unknown>;
    expect(body.provider).toBe('google');
    expect(body.redirect_to).toBe('https://app.driftstack.io/');
    expect(Object.keys(body).sort()).toEqual(['binding_hash', 'provider', 'redirect_to']);
    // The retired v1 round-trip was `credentials: 'include'` (the PKCE cookie);
    // a mutation that restores it reads here as a defined value.
    expect(post?.init?.credentials).toBeUndefined();
    expect(bannerHidden(window)).toBe(true);
    expect(navigations()).toBe(1);
  });

  it('OAuth start refuses a 200 without a flow_id: nothing stored, no navigation, the banner names the cause (the retired v1 branch navigated anyway and left the callback to fail)', async () => {
    const { window, fetchCalls, navigations } = setUpDom(loadBuiltPage(), {
      fetchPlan: [
        () => json({ authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' }),
      ],
    });
    win = window;
    const btn = oauthButton(window);
    btn.click();
    await until(() => !bannerHidden(window), 'the refusal banner');
    expect(fetchCalls.filter((c) => /\/v1\/auth\/oauth-client\/start$/.test(c.url))).toHaveLength(
      1,
    );
    expect(flowKeys(window)).toEqual([]);
    expect(navigations()).toBe(0);
    expect(bannerText(window)).toBe('OAuth start failed: no flow id in the response.');
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('aria-busy')).toBe('false');
  });

  it('OAuth start refuses locally when crypto.subtle is absent (non-secure context): no /start request, no navigation, the banner names the cause — v1 fell back to its cookie flow here; v2 has none', async () => {
    const { window, fetchCalls, navigations } = setUpDom(loadBuiltPage(), {
      webCrypto: false,
      fetchPlan: [
        () =>
          json({
            authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
            flow_id: 'MUST_NOT_BE_MINTED',
          }),
      ],
    });
    win = window;
    const btn = oauthButton(window);
    btn.click();
    await until(() => !bannerHidden(window), 'the refusal banner');
    // Direction of the real failure: a request here would be a guaranteed 400
    // ("Reload the sign-in page…") that misdescribes a browser problem.
    expect(fetchCalls).toHaveLength(0);
    expect(navigations()).toBe(0);
    expect(flowKeys(window)).toEqual([]);
    expect(bannerText(window)).toMatch(
      /provider sign-in needs a secure \(https\) page with web crypto.*nothing has been sent to the provider yet.*sign in with your password/i,
    );
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('aria-busy')).toBe('false');
  });

  it('OAuth v2 start: sends binding_hash = base64url(sha256(flow_secret)) and, given a flow_id, stores the secret under it before navigating — the record the callback page will redeem', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      fetchPlan: [
        () =>
          json({
            authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
            flow_id: 'FLOW_ID_TEST',
          }),
      ],
    });
    win = window;
    oauthButton(window).click();
    await flush();
    await flush();
    const post = fetchCalls.find((c) => /\/v1\/auth\/oauth-client\/start$/.test(c.url));
    const body = JSON.parse(String(post?.init?.body)) as { binding_hash?: unknown };
    // The v2 discriminator: 43 base64url chars of a SHA-256, never the secret itself.
    expect(typeof body.binding_hash).toBe('string');
    expect(body.binding_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const raw = window.localStorage.getItem('ds_oauth_flow.FLOW_ID_TEST');
    expect(raw, 'the flow record must be stored before the page navigates away').not.toBeNull();
    const record = JSON.parse(String(raw)) as { secret?: unknown; iat?: unknown };
    expect(typeof record.secret).toBe('string');
    expect(typeof record.iat).toBe('number');
    // The stored secret and the sent hash are the SAME flow: hash it here and compare.
    const digest = await webcrypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(String(record.secret)),
    );
    const b64url = Buffer.from(digest)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(b64url).toBe(body.binding_hash);
    // And the secret itself never leaves the browser in the start body.
    expect(String(post?.init?.body)).not.toContain(String(record.secret));
  });

  it('serializes OAuth starts across providers and restores the group after timeout', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      requestTimeoutImmediately: true,
      fetchPlan: [
        (call) =>
          new Promise<Response>((_resolve, reject) => {
            call.init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      ],
    });
    win = window;
    const buttons = Array.from(
      window.document.querySelectorAll('[data-oauth]'),
    ) as HTMLButtonElement[];
    expect(buttons.length).toBeGreaterThan(1);
    buttons[0]?.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    buttons[1]?.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await flush();

    const oauthCalls = fetchCalls.filter((c) => /\/v1\/auth\/oauth-client\/start$/.test(c.url));
    expect(oauthCalls).toHaveLength(1);
    expect(oauthCalls[0]?.init?.signal?.aborted).toBe(true);
    expect(buttons.every((button) => !button.disabled)).toBe(true);
    expect(buttons.every((button) => button.getAttribute('aria-busy') === 'false')).toBe(true);
    expect(bannerText(window)).toMatch(/sign-in provider took too long.*check your connection/i);
  });

  it('password sign-in blocks a competing OAuth start until it settles', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      fetchPlan: [() => new Promise<Response>(() => {})],
    });
    win = window;
    submitLogin(window, 'alice@example.com', 'secret-password');
    const oauth = window.document.querySelector('[data-oauth]') as HTMLButtonElement;
    oauth.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await flush();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toMatch(/\/v1\/auth\/login$/);
    expect(oauth.disabled).toBe(true);
    expect(oauth.getAttribute('aria-busy')).toBe('false');
  });

  it('OAuth start blocks a competing password submit until it settles', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      fetchPlan: [() => new Promise<Response>(() => {})],
    });
    win = window;
    const oauth = window.document.querySelector('[data-oauth]') as HTMLButtonElement;
    oauth.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    submitLogin(window, 'alice@example.com', 'secret-password');
    await until(() => fetchCalls.length >= 1, 'the OAuth start request to be issued');
    await flush();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toMatch(/\/v1\/auth\/oauth-client\/start$/);
    const submit = window.document.querySelector(
      '[data-form="login"] button[type="submit"]',
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it('MFA verification blocks a competing OAuth start until it settles', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      fetchPlan: [
        () => json({ mfa_required: true, challenge_token: 'chal_x' }),
        () => new Promise<Response>(() => {}),
      ],
    });
    win = window;
    submitLogin(window, 'mfa@example.com', 'secret-password');
    await flush();
    const codeInput = window.document.querySelector('#login-mfa-code') as HTMLInputElement;
    codeInput.value = '123456';
    const mfaForm = window.document.querySelector('[data-form="mfa"]') as HTMLFormElement;
    mfaForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    const oauth = window.document.querySelector('[data-oauth]') as HTMLButtonElement;
    oauth.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await until(() => fetchCalls.length >= 2, 'the MFA challenge request to be issued');
    await flush();

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1]?.url).toMatch(/\/v1\/auth\/mfa\/challenge$/);
    expect(oauth.disabled).toBe(true);
  });

  it('V-269 ?next= round-trip: the "create one" signup link carries the next target', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      url: 'https://app.driftstack.io/login/?next=' + encodeURIComponent('/profiles'),
    });
    win = window;
    await flush();
    const link = window.document.querySelector('[data-signup-link]') as HTMLAnchorElement | null;
    expect(link?.getAttribute('href')).toBe('/signup/?next=' + encodeURIComponent('/profiles'));
  });
});
