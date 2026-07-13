// Local integration test for the /verify-email page's inline script —
// the onboarding-completion flow (consume the verification token, store
// the web-session token, land on /welcome). Covers the V-184a.B
// auto-submit-from-?token= path (spinner → POST verify → token store /
// redirect), the auto-verify FAILURE → showFallback recovery (reveal
// the manual paste form + banner), and the no-token manual-fallback
// path (form shown on load, manual submit POSTs the pasted token).
// Only source-regex coverage before.
//
// Mirrors signup-page.test.ts (FIFO plan; success redirects via
// window.location.href → jsdom "Not implemented: navigation" filtered;
// assert the pre-nav side effect). NOTE: this page toggles the HTML
// `hidden` ATTRIBUTE (el.hidden), not a `.hidden` class.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'verify-email', 'index.html');
const TOKEN_URL = 'https://app.driftstack.dev/verify-email/?token=link_tok_123';
const NO_TOKEN_URL = 'https://app.driftstack.dev/verify-email/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface SetUpOpts {
  url?: string;
  requestTimeoutImmediately?: boolean;
  signupEmail?: string;
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
      console.warn('[verify-email test] unplanned fetch:', call.url);
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
  if (opts.signupEmail) window.sessionStorage.setItem('ds_signup_email', opts.signupEmail);

  const pageScript = scriptBodies.find((s) => s.includes('data-page="verify-email"'));
  if (!pageScript) throw new Error('verify-email inline script not found');
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

// This page toggles the HTML `hidden` attribute (el.hidden), not a class.
function attrHidden(window: JSDOM['window'], selector: string): boolean {
  const el = window.document.querySelector(selector) as HTMLElement | null;
  if (!el) throw new Error(`selector not found: ${selector}`);
  return el.hidden;
}
function bannerHidden(window: JSDOM['window']): boolean {
  const b = window.document.querySelector('[data-banner]');
  return !b || b.classList.contains('hidden');
}

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('verify-email page — local integration', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });
  const loadBuiltPage = (): string => readFileSync(BUILT_PAGE, 'utf8');

  it('auto-verify success: ?token= auto-submits POST /v1/auth/verify-email {token} and stores ds_web_session_token', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      url: TOKEN_URL,
      fetchPlan: [() => json({ session: { token: 'ds_web_VERIFIED' } })],
    });
    win = window;
    await flush();
    const post = fetchCalls.find((c) => /\/v1\/auth\/verify-email$/.test(c.url));
    expect(post?.init?.method).toBe('POST');
    expect(JSON.parse(String(post?.init?.body))).toEqual({ token: 'link_tok_123' });
    expect(window.localStorage.getItem('ds_web_session_token')).toBe('ds_web_VERIFIED');
  });

  it('auto-verify failure: reveals the manual fallback form + banner, stores no token', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      url: TOKEN_URL,
      fetchPlan: [() => json({ detail: 'This verification link has expired.' }, 400)],
    });
    win = window;
    await flush();
    // showFallback(): form revealed, spinner hidden.
    expect(attrHidden(window, '[data-form="verify"]')).toBe(false);
    expect(attrHidden(window, '[data-field="auto-verify-spinner"]')).toBe(true);
    expect(bannerHidden(window)).toBe(false);
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /This verification link has expired\./,
    );
    expect(window.localStorage.getItem('ds_web_session_token')).toBeNull();
  });

  it('makes an ambiguous auto-verification timeout terminal for the one-shot token', async () => {
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
    await flush();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.init?.signal?.aborted).toBe(true);
    expect(attrHidden(window, '[data-form="verify"]')).toBe(true);
    expect(attrHidden(window, '[data-field="auto-verify-spinner"]')).toBe(true);
    expect(attrHidden(window, '[data-verify-unknown]')).toBe(false);
    const form = window.document.querySelector('[data-form="verify"]') as HTMLFormElement;
    expect(form.getAttribute('aria-busy')).toBe('false');
    expect((form.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /outcome is unknown.*verified your account.*consumed this one-time token.*credential did not reach this browser.*do not submit this token again.*continue to sign in.*still unverified.*resend/i,
    );
    expect(
      window.document.querySelector('[data-link="verify-timeout-login"]')?.getAttribute('href'),
    ).toBe('/login');

    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(fetchCalls).toHaveLength(1);
  });

  it('no token: shows the manual fallback form on load (spinner hidden, no fetch)', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), { url: NO_TOKEN_URL });
    win = window;
    await flush();
    expect(attrHidden(window, '[data-form="verify"]')).toBe(false);
    expect(attrHidden(window, '[data-field="auto-verify-spinner"]')).toBe(true);
    expect(fetchCalls.length).toBe(0);
  });

  it('manual paste: submitting the form POSTs the pasted token + stores the session token', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      url: NO_TOKEN_URL,
      fetchPlan: [() => json({ session: { token: 'ds_web_MANUAL' } })],
    });
    win = window;
    await flush();
    const form = window.document.querySelector('[data-form="verify"]') as HTMLFormElement;
    (form.querySelector('input[name="token"]') as HTMLInputElement).value = 'pasted_tok_456';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    const post = fetchCalls.find((c) => /\/v1\/auth\/verify-email$/.test(c.url));
    expect(JSON.parse(String(post?.init?.body))).toEqual({ token: 'pasted_tok_456' });
    expect(window.localStorage.getItem('ds_web_session_token')).toBe('ds_web_MANUAL');
  });

  it('single-flights auto and manual verification against the same one-time token', async () => {
    let finishVerify: (response: Response) => void = () => {};
    const pendingVerify = new Promise<Response>((resolve) => {
      finishVerify = resolve;
    });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      url: TOKEN_URL,
      fetchPlan: [() => pendingVerify],
    });
    win = window;
    const form = window.document.querySelector('[data-form="verify"]') as HTMLFormElement;
    // Bypass the native disabled-control suppression to exercise the request
    // lease itself (e.g. a queued/synthetic submit already dispatched).
    (form.querySelector('input[name="token"]') as HTMLInputElement).disabled = false;
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(2);

    expect(fetchCalls.filter((call) => /\/v1\/auth\/verify-email$/.test(call.url))).toHaveLength(1);
    expect(form.getAttribute('aria-busy')).toBe('true');
    expect((form.querySelector('button[type="submit"]') as HTMLButtonElement).textContent).toBe(
      'Verifying…',
    );

    finishVerify(json({ session: { token: 'ds_web_ONCE' } }));
    await flush();
    expect(window.localStorage.getItem('ds_web_session_token')).toBe('ds_web_ONCE');
    expect(form.getAttribute('aria-busy')).toBe('false');
  });

  it('makes an ambiguous resend timeout terminal for the page load', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      url: NO_TOKEN_URL,
      requestTimeoutImmediately: true,
      signupEmail: 'pending@example.com',
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
    const resendBtn = window.document.querySelector('[data-action="resend"]') as HTMLButtonElement;
    resendBtn.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    resendBtn.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await flush();
    resendBtn.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await flush();

    const calls = fetchCalls.filter((call) => /\/v1\/auth\/resend-verification$/.test(call.url));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.signal?.aborted).toBe(true);
    expect(resendBtn.disabled).toBe(true);
    expect(resendBtn.getAttribute('aria-busy')).toBe('false');
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /delivery is unknown.*may already have sent.*do not resend again.*inbox and spam.*newest one/i,
    );
    expect(window.document.querySelector('[data-field="resend-status"]')?.textContent).toMatch(
      /check inbox before retrying/i,
    );
  });
});
