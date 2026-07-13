// Local integration test for the /signup page's inline script — the
// account-creation (onboarding) flow. Covers POST /v1/auth/signup, the
// success hand-off to /verify-email (stashing ds_signup_email +
// debug_token in sessionStorage, NO token yet), the per-field
// validation-issue formatting (zod extensions.issues → friendly
// messages, Issue 2 wave 1085+), the generic-detail fallback, V-667.C
// OAuth start, and the V-269 ?next= round-trip. Only source-regex
// coverage before.
//
// Mirrors login-page.test.ts (FIFO plan; the page navigates via
// window.location.href on success → jsdom "Not implemented: navigation"
// is filtered; assert the PRE-nav side effect).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installDashboardDeadline } from './dashboard-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'signup', 'index.html');
const DEFAULT_URL = 'https://app.driftstack.dev/signup/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface SetUpOpts {
  url?: string;
  requestTimeoutImmediately?: boolean;
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
      console.warn('[signup-page test] unplanned fetch:', call.url);
      return Promise.resolve(new Response('{}', { status: 500 }));
    }
    return Promise.resolve(handler(call));
  };
  if (opts.requestTimeoutImmediately) {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 15_000) {
        window.queueMicrotask(() => {
          if (typeof handler === 'function') handler(...args);
        });
        return 42;
      }
      return nativeSetTimeout(handler, timeout, ...args);
    }) as typeof window.setTimeout;
  }

  installDashboardDeadline(window);
  const pageScript = scriptBodies.find((s) => s.includes('data-page="signup"'));
  if (!pageScript) throw new Error('signup inline script not found');
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

function submitSignup(window: JSDOM['window'], email: string, password: string): void {
  const form = window.document.querySelector('[data-form="signup"]') as HTMLFormElement;
  (form.querySelector('input[name="email"]') as HTMLInputElement).value = email;
  (form.querySelector('input[name="password"]') as HTMLInputElement).value = password;
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

describe('signup page — local integration', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });
  const loadBuiltPage = (): string => readFileSync(BUILT_PAGE, 'utf8');

  it('successful signup POSTs {email, password} and stashes ds_signup_email (no token yet — verify-email flow)', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      fetchPlan: [() => json({ debug_token: 'verify_abc' }, 201)],
    });
    win = window;
    submitSignup(window, 'newbie@example.com', 'a-very-long-password');
    await flush();
    const post = fetchCalls.find((c) => /\/v1\/auth\/signup$/.test(c.url));
    expect(post?.init?.method).toBe('POST');
    const body = JSON.parse(String(post?.init?.body));
    expect(body.email).toBe('newbie@example.com');
    expect(body.password).toBe('a-very-long-password');
    // No web session token on signup — that comes after verify-email.
    expect(window.localStorage.getItem('ds_web_session_token')).toBeNull();
    // Email stashed for the verify page; debug_token stashed for dev paste-in.
    expect(window.sessionStorage.getItem('ds_signup_email')).toBe('newbie@example.com');
    expect(window.sessionStorage.getItem('ds_debug_verify_token')).toBe('verify_abc');
  });

  it('per-field validation: zod extensions.issues.fieldErrors → friendly banner message', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      fetchPlan: [
        () =>
          json(
            {
              title: 'Validation failed',
              detail: 'One or more fields failed validation',
              extensions: {
                issues: {
                  formErrors: [],
                  fieldErrors: {
                    password: ['String must contain at least 12 character(s)'],
                  },
                },
              },
            },
            422,
          ),
      ],
    });
    win = window;
    submitSignup(window, 'x@example.com', 'short');
    await flush();
    expect(bannerHidden(window)).toBe(false);
    // friendly mapping, NOT the generic "One or more fields failed validation".
    expect(bannerText(window)).toMatch(/Password must be at least 12 characters\./);
    expect(bannerText(window)).not.toMatch(/One or more fields failed validation/);
  });

  it('registered-email conflict uses stable fixed copy', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      fetchPlan: [
        () =>
          json(
            {
              type: 'https://errors.driftstack.dev/email-already-registered',
              detail: 'duplicate row account_id=acct_secret',
            },
            409,
          ),
      ],
    });
    win = window;
    submitSignup(window, 'dupe@example.com', 'a-very-long-password');
    await flush();
    expect(bannerHidden(window)).toBe(false);
    expect(bannerText(window)).toMatch(
      /account with this email already exists.*sign in or reset your password/i,
    );
    expect(bannerText(window)).not.toMatch(/acct_secret/i);
    expect(window.sessionStorage.getItem('ds_signup_email')).toBeNull();
  });

  it('serializes duplicate submits and makes an ambiguous signup timeout terminal', async () => {
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
    submitSignup(window, 'newbie@example.com', 'a-very-long-password');
    submitSignup(window, 'newbie@example.com', 'a-very-long-password');
    await flush();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.init?.signal?.aborted).toBe(true);
    const submitBtn = window.document.querySelector(
      '[data-form="signup"] button[type="submit"]',
    ) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
    expect(submitBtn.getAttribute('aria-busy')).toBe('false');
    expect(submitBtn.textContent).toBe('Check inbox before continuing');
    expect(bannerText(window)).toMatch(
      /outcome is unknown.*may already have created your account.*verification email.*do not submit this signup again.*inbox and spam.*continue to email verification/i,
    );
    expect(window.sessionStorage.getItem('ds_signup_email')).toBe('newbie@example.com');
    expect(
      window.document.querySelector('[data-signup-unknown]')?.classList.contains('hidden'),
    ).toBe(false);
    expect(
      window.document.querySelector('[data-continue-verification]')?.getAttribute('href'),
    ).toBe('/verify-email');

    submitSignup(window, 'newbie@example.com', 'a-very-long-password');
    const oauth = window.document.querySelector('[data-oauth]') as HTMLButtonElement;
    oauth.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await flush();
    expect(fetchCalls).toHaveLength(1);
  });

  it('preserves a safe next target in signup-timeout verification recovery', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      url: 'https://app.driftstack.dev/signup/?next=' + encodeURIComponent('/cli/authorize'),
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
    submitSignup(window, 'newbie@example.com', 'a-very-long-password');
    await flush();

    expect(
      window.document.querySelector('[data-continue-verification]')?.getAttribute('href'),
    ).toBe('/verify-email?next=' + encodeURIComponent('/cli/authorize'));
  });

  it('V-667.C OAuth start: POSTs {provider, redirect_to} to /v1/auth/oauth-client/start', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      fetchPlan: [() => json({ authorize_url: 'https://github.com/login/oauth/authorize?x=1' })],
    });
    win = window;
    const btn = window.document.querySelector('[data-oauth]') as HTMLButtonElement | null;
    if (!btn) {
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
    expect(bannerText(window)).toMatch(/signup provider took too long.*check your connection/i);
  });

  it('email signup blocks a competing OAuth start until it settles', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      fetchPlan: [() => new Promise<Response>(() => {})],
    });
    win = window;
    submitSignup(window, 'newbie@example.com', 'a-very-long-password');
    const oauth = window.document.querySelector('[data-oauth]') as HTMLButtonElement;
    oauth.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await flush();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toMatch(/\/v1\/auth\/signup$/);
    expect(oauth.disabled).toBe(true);
    expect(oauth.getAttribute('aria-busy')).toBe('false');
  });

  it('OAuth signup blocks a competing email submit until it settles', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      fetchPlan: [() => new Promise<Response>(() => {})],
    });
    win = window;
    const oauth = window.document.querySelector('[data-oauth]') as HTMLButtonElement;
    oauth.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    submitSignup(window, 'newbie@example.com', 'a-very-long-password');
    await flush();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toMatch(/\/v1\/auth\/oauth-client\/start$/);
    const submit = window.document.querySelector(
      '[data-form="signup"] button[type="submit"]',
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it('V-269 ?next= round-trip: the "sign in" login link carries the next target', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      url: 'https://app.driftstack.dev/signup/?next=' + encodeURIComponent('/cli/authorize'),
    });
    win = window;
    await flush();
    const link = window.document.querySelector('[data-login-link]') as HTMLAnchorElement | null;
    expect(link?.getAttribute('href')).toBe('/login?next=' + encodeURIComponent('/cli/authorize'));
  });
});
