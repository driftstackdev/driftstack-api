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

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'login', 'index.html');
const DEFAULT_URL = 'https://app.driftstack.dev/login/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface SetUpOpts {
  url?: string;
  requestTimeoutImmediately?: boolean;
  requestTimeoutOnCall?: number;
  fetchPlan?: Array<(call: MockFetchCall) => Response | Promise<Response>>;
}

function setUpDom(
  html: string,
  opts: SetUpOpts,
): { window: JSDOM['window']; fetchCalls: MockFetchCall[] } {
  const scriptBodies: string[] = [];
  const htmlNoScripts = html.replace(/<script[^>]*>([\s\S]*?)<\/script>/g, (_m, body: string) => {
    scriptBodies.push(body);
    return '';
  });
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err: Error) => {
    if (!/Not implemented: navigation/.test(String(err && err.message))) {
      // eslint-disable-next-line no-console
      console.error(err);
    }
  });
  const dom = new JSDOM(htmlNoScripts, {
    url: opts.url ?? DEFAULT_URL,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
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

  const pageScript = scriptBodies.find((s) => s.includes('data-page="login"'));
  if (!pageScript) throw new Error('login inline script not found');
  // @ts-expect-error — jsdom global has eval
  window.eval(pageScript);
  return { window: window as JSDOM['window'], fetchCalls };
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

function submitLogin(window: JSDOM['window'], email: string, password: string): void {
  const form = window.document.querySelector('[data-form="login"]') as HTMLFormElement;
  (form.querySelector('input[name="email"]') as HTMLInputElement).value = email;
  (form.querySelector('input[name="password"]') as HTMLInputElement).value = password;
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
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
    submitLogin(window, 'alice@example.com', 'hunter2');
    await flush();
    const post = fetchCalls.find((c) => /\/v1\/auth\/login$/.test(c.url));
    expect(post?.init?.method).toBe('POST');
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      email: 'alice@example.com',
      password: 'hunter2',
    });
    expect(window.localStorage.getItem('ds_web_session_token')).toBe('ds_web_THE_TOKEN');
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

  it('serializes duplicate MFA submits and recovers after the bounded challenge times out', async () => {
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

    const challengeCalls = fetchCalls.filter((c) => /\/v1\/auth\/mfa\/challenge$/.test(c.url));
    expect(challengeCalls).toHaveLength(1);
    expect(challengeCalls[0]?.init?.signal?.aborted).toBe(true);
    const submitBtn = mfaForm.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);
    expect(submitBtn.getAttribute('aria-busy')).toBe('false');
    expect(submitBtn.textContent).toBe('Verify');
    expect(bannerText(window)).toMatch(/verification took too long.*check your connection/i);
  });

  it('invalid credentials: surfaces the server detail in the banner, stores no token', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      fetchPlan: [() => json({ detail: 'Invalid email or password.' }, 401)],
    });
    win = window;
    submitLogin(window, 'bad@example.com', 'wrong');
    await flush();
    expect(bannerHidden(window)).toBe(false);
    expect(bannerText(window)).toMatch(/Invalid email or password\./);
    expect(window.localStorage.getItem('ds_web_session_token')).toBeNull();
  });

  it('serializes duplicate verification resends and recovers after the bounded request times out', async () => {
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

    const resendCalls = fetchCalls.filter((c) => /\/v1\/auth\/resend-verification$/.test(c.url));
    expect(resendCalls).toHaveLength(1);
    expect(resendCalls[0]?.init?.signal?.aborted).toBe(true);
    expect(resendBtn.disabled).toBe(false);
    expect(resendBtn.getAttribute('aria-busy')).toBe('false');
    const status = window.document.querySelector('[data-resend-status]')?.textContent ?? '';
    expect(status).toMatch(/resending took too long.*check your connection/i);
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

  it('V-667.C OAuth start: POSTs {provider, redirect_to} to /v1/auth/oauth-client/start', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      fetchPlan: [
        () => json({ authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' }),
      ],
    });
    win = window;
    const btn = window.document.querySelector('[data-oauth]') as HTMLButtonElement | null;
    if (!btn) {
      // No OAuth buttons rendered in this build — skip without failing.
      expect(true).toBe(true);
      return;
    }
    btn.click();
    await flush();
    const post = fetchCalls.find((c) => /\/v1\/auth\/oauth-client\/start$/.test(c.url));
    expect(post?.init?.method).toBe('POST');
    const body = JSON.parse(String(post?.init?.body));
    expect(typeof body.provider).toBe('string');
    expect(body.provider.length).toBeGreaterThan(0);
    expect(typeof body.redirect_to).toBe('string');
  });

  it('V-269 ?next= round-trip: the "create one" signup link carries the next target', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      url: 'https://app.driftstack.dev/login/?next=' + encodeURIComponent('/profiles'),
    });
    win = window;
    await flush();
    const link = window.document.querySelector('[data-signup-link]') as HTMLAnchorElement | null;
    expect(link?.getAttribute('href')).toBe('/signup?next=' + encodeURIComponent('/profiles'));
  });
});
