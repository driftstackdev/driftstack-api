// Local integration test for the /reset-password page's inline script
// — a critical account-recovery flow. A wiring bug here locks
// password-reset users out permanently. Covers the ?token= gate (no
// token → show the "open from your email link" state), the client-side
// match + min-length validation, the POST
// /v1/auth/password-reset/confirm contract, the success path (store
// ds_web_session_token + redirect), and the expired/invalid-token
// error. Only source-regex coverage before.
//
// Mirrors signup-page.test.ts (FIFO plan; the page navigates via
// window.location.href on success → jsdom "Not implemented: navigation"
// filtered; assert the PRE-nav side effect / banner).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'reset-password', 'index.html');
const TOKEN_URL = 'https://app.driftstack.dev/reset-password/?token=reset_tok_123';
const NO_TOKEN_URL = 'https://app.driftstack.dev/reset-password/';

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
    url: opts.url ?? TOKEN_URL,
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
      console.warn('[reset-password test] unplanned fetch:', call.url);
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

  const pageScript = scriptBodies.find((s) => s.includes('data-page="reset-password"'));
  if (!pageScript) throw new Error('reset-password inline script not found');
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

function isHidden(window: JSDOM['window'], selector: string): boolean {
  const el = window.document.querySelector(selector);
  if (!el) throw new Error(`selector not found: ${selector}`);
  return el.classList.contains('hidden');
}
function bannerText(window: JSDOM['window']): string {
  return window.document.querySelector('[data-banner]')?.textContent ?? '';
}

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

function submit(window: JSDOM['window'], password: string, confirm: string): void {
  const form = window.document.querySelector('[data-form]') as HTMLFormElement;
  (form.querySelector('input[name="password"]') as HTMLInputElement).value = password;
  (form.querySelector('input[name="confirm"]') as HTMLInputElement).value = confirm;
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

describe('reset-password page — local integration', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });
  const loadBuiltPage = (): string => readFileSync(BUILT_PAGE, 'utf8');

  it('no ?token= in the URL: hides the form, shows the "open from your email link" state', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), { url: NO_TOKEN_URL });
    win = window;
    await flush();
    expect(isHidden(window, '[data-form]')).toBe(true);
    expect(isHidden(window, '[data-missing]')).toBe(false);
    expect(fetchCalls.length).toBe(0);
  });

  it('password mismatch: banner "Passwords do not match." and no fetch', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), { url: TOKEN_URL });
    win = window;
    submit(window, 'a-long-enough-password', 'different-password');
    await flush();
    expect(bannerText(window)).toMatch(/Passwords do not match\./);
    expect(fetchCalls.length).toBe(0);
  });

  it('password too short (<12): banner "Password must be at least 12 characters." and no fetch', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), { url: TOKEN_URL });
    win = window;
    submit(window, 'short', 'short');
    await flush();
    expect(bannerText(window)).toMatch(/Password must be at least 12 characters\./);
    expect(fetchCalls.length).toBe(0);
  });

  it('success: POSTs {token, new_password}, stores ds_web_session_token from the returned session', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      url: TOKEN_URL,
      fetchPlan: [() => json({ session: { token: 'ds_web_AFTER_RESET' } })],
    });
    win = window;
    submit(window, 'a-brand-new-password', 'a-brand-new-password');
    await flush();
    const post = fetchCalls.find((c) => /\/v1\/auth\/password-reset\/confirm$/.test(c.url));
    expect(post?.init?.method).toBe('POST');
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      token: 'reset_tok_123',
      new_password: 'a-brand-new-password',
    });
    expect(window.localStorage.getItem('ds_web_session_token')).toBe('ds_web_AFTER_RESET');
  });

  it('expired / invalid token: surfaces the server detail in the banner, stores no token', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      url: TOKEN_URL,
      fetchPlan: [() => json({ detail: 'This reset link has expired.' }, 400)],
    });
    win = window;
    submit(window, 'a-brand-new-password', 'a-brand-new-password');
    await flush();
    expect(bannerText(window)).toMatch(/This reset link has expired\./);
    expect(window.localStorage.getItem('ds_web_session_token')).toBeNull();
  });

  it('serializes duplicate submits and recovers when the bounded request times out', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      url: TOKEN_URL,
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
    submit(window, 'a-brand-new-password', 'a-brand-new-password');
    submit(window, 'a-brand-new-password', 'a-brand-new-password');
    await flush();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.init?.signal?.aborted).toBe(true);
    const submitBtn = window.document.querySelector(
      '[data-form] button[type="submit"]',
    ) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);
    expect(submitBtn.getAttribute('aria-busy')).toBe('false');
    expect(submitBtn.textContent).toBe('Reset password + sign in');
    expect(bannerText(window)).toMatch(/took too long.*check your connection/i);
  });
});
