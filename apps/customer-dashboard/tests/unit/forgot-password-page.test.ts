// Local integration test for the /forgot-password page's inline script
// — the password-reset REQUEST flow (the entry point to account
// recovery). Covers POST /v1/auth/password-reset/request, the
// anti-enumeration success state (always shown regardless of whether
// the email exists), the expiry-window display, the dev-mode
// debug_token deep-link into /reset-password, and the error banner.
// Only source-regex coverage before.
//
// Mirrors signup-page.test.ts (FIFO plan). This page does NOT navigate
// — it swaps the form for an in-page success panel — so no nav filter
// is needed; assertions check the visible state + POST body.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installDashboardDeadline } from './dashboard-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'forgot-password', 'index.html');
const PAGE_URL = 'https://app.driftstack.dev/forgot-password/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface SetUpOpts {
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
  const dom = new JSDOM(htmlNoScripts, {
    url: PAGE_URL,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
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
      console.warn('[forgot-password test] unplanned fetch:', call.url);
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

  const pageScript = scriptBodies.find((s) => s.includes('data-page="forgot-password"'));
  if (!pageScript) throw new Error('forgot-password inline script not found');
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
function textOf(window: JSDOM['window'], selector: string): string {
  return window.document.querySelector(selector)?.textContent ?? '';
}

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

function submit(window: JSDOM['window'], email: string): void {
  const form = window.document.querySelector('[data-form]') as HTMLFormElement;
  (form.querySelector('input[name="email"]') as HTMLInputElement).value = email;
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

describe('forgot-password page — local integration', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });
  const loadBuiltPage = (): string => readFileSync(BUILT_PAGE, 'utf8');

  it('anti-enumeration success: POSTs {email}, swaps form → success panel, echoes the email + expiry window', async () => {
    const expiresAt = new Date(Date.now() + 30 * 60000).toISOString();
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      fetchPlan: [() => json({ expires_at: expiresAt })],
    });
    win = window;
    submit(window, 'recover@example.com');
    await flush();
    const post = fetchCalls.find((c) => /\/v1\/auth\/password-reset\/request$/.test(c.url));
    expect(post?.init?.method).toBe('POST');
    expect(JSON.parse(String(post?.init?.body))).toEqual({ email: 'recover@example.com' });
    expect(isHidden(window, '[data-form]')).toBe(true);
    expect(isHidden(window, '[data-success]')).toBe(false);
    expect(textOf(window, '[data-success-email]')).toBe('recover@example.com');
    expect(textOf(window, '[data-success-window]')).toMatch(/\d+ minutes/);
  });

  it('dev-mode debug_token: reveals the debug deep-link into /reset-password?token=…', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      fetchPlan: [
        () =>
          json({
            expires_at: new Date(Date.now() + 30 * 60000).toISOString(),
            debug_token: 'dbg_RESET_123',
          }),
      ],
    });
    win = window;
    submit(window, 'dev@example.com');
    await flush();
    expect(isHidden(window, '[data-debug-token]')).toBe(false);
    const link = window.document.querySelector('[data-debug-link]') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(
      '/reset-password?token=' + encodeURIComponent('dbg_RESET_123'),
    );
  });

  it('no debug_token (prod): the debug deep-link stays hidden', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      fetchPlan: [() => json({ expires_at: new Date(Date.now() + 30 * 60000).toISOString() })],
    });
    win = window;
    submit(window, 'real@example.com');
    await flush();
    expect(isHidden(window, '[data-debug-token]')).toBe(true);
    expect(isHidden(window, '[data-success]')).toBe(false);
  });

  it('rate-limited error uses fixed retry guidance and keeps the form visible', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      fetchPlan: [
        () =>
          json(
            {
              type: 'https://errors.driftstack.dev/rate-limited',
              detail: 'Too many reset requests — internal retry bucket=secret.',
            },
            429,
          ),
      ],
    });
    win = window;
    submit(window, 'spammy@example.com');
    await flush();
    expect(isHidden(window, '[data-banner]')).toBe(false);
    expect(textOf(window, '[data-banner]')).toMatch(/usage limit was reached/i);
    expect(textOf(window, '[data-banner]')).not.toMatch(/internal|secret/i);
    expect(isHidden(window, '[data-form]')).toBe(false);
    expect(isHidden(window, '[data-success]')).toBe(true);
  });

  it('serializes duplicate submits and makes an ambiguous request timeout terminal', async () => {
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
    submit(window, 'recover@example.com');
    submit(window, 'recover@example.com');
    await flush();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.init?.signal?.aborted).toBe(true);
    const submitBtn = window.document.querySelector(
      '[data-form] button[type="submit"]',
    ) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
    expect(submitBtn.getAttribute('aria-busy')).toBe('false');
    expect(submitBtn.textContent).toBe('Check inbox before retrying');
    expect(textOf(window, '[data-banner]')).toMatch(
      /delivery is unknown.*may already have sent.*do not request another link.*inbox and spam.*newest one/i,
    );
    expect(isHidden(window, '[data-form]')).toBe(true);
    expect(isHidden(window, '[data-success]')).toBe(false);
    expect(textOf(window, '[data-success-email]')).toBe('recover@example.com');

    submit(window, 'recover@example.com');
    await flush();
    expect(fetchCalls).toHaveLength(1);
  });
});
