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
import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'signup', 'index.html');
const DEFAULT_URL = 'https://app.driftstack.io/signup/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface SetUpOpts {
  url?: string;
  requestTimeoutImmediately?: boolean;
  fetchPlan?: Array<(call: MockFetchCall) => Response | Promise<Response>>;
  storageFault?: 'deny-all' | 'drop-oauth-flow-write';
}

// localStorage faults for the OAuth v2 arms. 'deny-all' is a browser with site
// storage blocked (every access throws); 'drop-oauth-flow-write' is the quieter
// failure — setItem returns normally but the ds_oauth_flow.* record never lands,
// which only the page's read-back can see. Scoped to THIS window's localStorage
// via the `this === storage` check so sessionStorage keeps working.
function faultLocalStorage(
  window: JSDOM['window'],
  mode: 'deny-all' | 'drop-oauth-flow-write',
): void {
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
    if (this === storage && mode === 'drop-oauth-flow-write' && key.startsWith('ds_oauth_flow.')) {
      return;
    }
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
  // "did the page leave for the IDP?" into an assertable number, so a failure
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
  // click silently falls to the legacy cookie start. Node's webcrypto is the real thing.
  if (typeof (window.crypto as Crypto | undefined)?.subtle === 'undefined') {
    Object.defineProperty(window.crypto, 'subtle', { value: webcrypto.subtle });
  }
  // The page encodes the secret with TextEncoder before hashing; jsdom's realm has
  // none, and the page's own guard turns that into a silent legacy start.
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
      console.warn('[signup-page test] unplanned fetch:', call.url);
      return Promise.resolve(new Response('{}', { status: 500 }));
    }
    return Promise.resolve(handler(call));
  };
  if (opts.storageFault) faultLocalStorage(window as JSDOM['window'], opts.storageFault);
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
  return { window: window as JSDOM['window'], fetchCalls, navigations: () => navigationCount };
}

function base64UrlOf(buf: ArrayBuffer): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function oauthButton(window: JSDOM['window']): HTMLButtonElement {
  const btn = window.document.querySelector('[data-oauth]') as HTMLButtonElement | null;
  // No skip-on-absence branch: a build that dropped the provider buttons must
  // red here, not pass vacuously (the previous form of this arm could not fail).
  expect(btn, 'the built /signup page must render a [data-oauth] button').not.toBeNull();
  return btn as HTMLButtonElement;
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

function denySessionStorageWrites(window: JSDOM['window'], silent = false): void {
  const storagePrototype = Object.getPrototypeOf(window.sessionStorage) as Storage;
  Object.defineProperty(storagePrototype, 'setItem', {
    configurable: true,
    value: silent
      ? () => {}
      : () => {
          throw new window.DOMException('Storage denied', 'SecurityError');
        },
  });
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

  it('sends no account-creation request when verification state cannot be persisted', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      fetchPlan: [() => json({}, 201)],
    });
    win = window;
    denySessionStorageWrites(window);
    submitSignup(window, 'newbie@example.com', 'a-very-long-password');
    await flush();

    expect(fetchCalls).toHaveLength(0);
    expect(bannerText(window)).toMatch(
      /site storage is unavailable.*no account-creation request was sent.*entries are still here/i,
    );
    const password = window.document.querySelector(
      '[data-form="signup"] input[name="password"]',
    ) as HTMLInputElement;
    expect(password.value).toBe('a-very-long-password');
  });

  it('locks replay when storage silently fails after an accepted account creation', async () => {
    let activeWindow: JSDOM['window'];
    const setup = setUpDom(loadBuiltPage(), {
      fetchPlan: [
        () => {
          denySessionStorageWrites(activeWindow, true);
          return json({}, 201);
        },
      ],
    });
    activeWindow = setup.window;
    win = activeWindow;
    submitSignup(activeWindow, 'newbie@example.com', 'a-very-long-password');
    await flush();

    expect(setup.fetchCalls).toHaveLength(1);
    expect(bannerText(activeWindow)).toMatch(
      /account was created.*could not complete the verification handoff.*do not submit.*enter your email manually/i,
    );
    expect(activeWindow.sessionStorage.getItem('ds_signup_email')).toBeNull();
    submitSignup(activeWindow, 'newbie@example.com', 'a-very-long-password');
    await flush();
    expect(setup.fetchCalls).toHaveLength(1);
  });

  it('treats malformed JSON after 2xx as accepted and never replays signup', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      fetchPlan: [() => new Response('{', { status: 201 })],
    });
    win = window;
    submitSignup(window, 'newbie@example.com', 'a-very-long-password');
    await flush();

    expect(fetchCalls).toHaveLength(1);
    expect(bannerText(window)).toMatch(
      /account was created.*could not complete the verification handoff.*do not submit/i,
    );
    expect(window.sessionStorage.getItem('ds_signup_email')).toBe('newbie@example.com');
    submitSignup(window, 'newbie@example.com', 'a-very-long-password');
    await flush();
    expect(fetchCalls).toHaveLength(1);
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
    expect(submitBtn.textContent).toBe('Continue to verification');
    expect(bannerText(window)).toMatch(
      /outcome is unknown.*may already have created your account.*verification email.*do not submit this signup again.*inbox and spam.*continue to email verification/i,
    );
    expect(window.sessionStorage.getItem('ds_signup_email')).toBe('newbie@example.com');
    expect(
      window.document.querySelector('[data-signup-unknown]')?.classList.contains('hidden'),
    ).toBe(false);
    expect(
      window.document.querySelector('[data-continue-verification]')?.getAttribute('href'),
    ).toBe('/verify-email/');

    submitSignup(window, 'newbie@example.com', 'a-very-long-password');
    const oauth = window.document.querySelector('[data-oauth]') as HTMLButtonElement;
    oauth.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await flush();
    expect(fetchCalls).toHaveLength(1);
  });

  it('preserves a safe next target in signup-timeout verification recovery', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      url: 'https://app.driftstack.io/signup/?next=' + encodeURIComponent('/cli/authorize'),
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
    ).toBe('/verify-email/?next=' + encodeURIComponent('/cli/authorize'));
  });

  it('V-667.C OAuth start: POSTs {provider, redirect_to} to /v1/auth/oauth-client/start and, without a flow_id (old server), stores no flow record and still navigates', async () => {
    const { window, fetchCalls, navigations } = setUpDom(loadBuiltPage(), {
      fetchPlan: [() => json({ authorize_url: 'https://github.com/login/oauth/authorize?x=1' })],
    });
    win = window;
    oauthButton(window).click();
    await flush();
    await flush();
    const post = fetchCalls.find((c) => /\/v1\/auth\/oauth-client\/start$/.test(c.url));
    expect(post?.init?.method).toBe('POST');
    const body = JSON.parse(String(post?.init?.body));
    expect(typeof body.provider).toBe('string');
    expect(body.provider.length).toBeGreaterThan(0);
    expect(body.redirect_to).toBe('https://app.driftstack.io/');
    // Legacy-server control: no flow_id → nothing under ds_oauth_flow.* (the
    // cookie the old server set is the whole state), and the page still leaves.
    const flowKeys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith('ds_oauth_flow.')) flowKeys.push(k);
    }
    expect(flowKeys).toEqual([]);
    expect(bannerHidden(window)).toBe(true);
    expect(navigations()).toBe(1);
  });

  it('OAuth v2 start (Item 1 closure): sends binding_hash = base64url(sha256(flow_secret)) and, given a flow_id, stores the secret under ds_oauth_flow.<flow_id> before navigating — the record the callback page will redeem, so no cross-site PKCE cookie is needed', async () => {
    const { window, fetchCalls, navigations } = setUpDom(loadBuiltPage(), {
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
    expect(post?.init?.method).toBe('POST');
    const body = JSON.parse(String(post?.init?.body)) as {
      provider?: unknown;
      redirect_to?: unknown;
      binding_hash?: unknown;
    };
    expect(body.provider).toBe('google');
    expect(body.redirect_to).toBe('https://app.driftstack.io/');
    // The v2 discriminator: 43 base64url chars of a SHA-256, never the secret itself.
    // This is the field whose absence sent /signup down the cookie path (the 400
    // "PKCE verifier cookie missing or invalid." in Safari / Incognito / Firefox TCP).
    expect(typeof body.binding_hash).toBe('string');
    expect(body.binding_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const raw = window.localStorage.getItem('ds_oauth_flow.FLOW_ID_TEST');
    expect(raw, 'the flow record must be stored before the page navigates away').not.toBeNull();
    const record = JSON.parse(String(raw)) as { secret?: unknown; iat?: unknown };
    expect(typeof record.secret).toBe('string');
    expect(record.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(typeof record.iat).toBe('number');
    expect(Math.abs(Date.now() - Number(record.iat))).toBeLessThan(60_000);
    // The stored secret and the sent hash are the SAME flow: hash it here and compare.
    const digest = await webcrypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(String(record.secret)),
    );
    expect(base64UrlOf(digest)).toBe(body.binding_hash);
    // And the secret itself never leaves the browser in the start body.
    expect(String(post?.init?.body)).not.toContain(String(record.secret));
    expect(bannerHidden(window)).toBe(true);
    expect(navigations()).toBe(1);
  });

  it('OAuth v2 start prunes a stale ds_oauth_flow.* record (>10 min) and keeps a fresh one from a parallel tab', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      fetchPlan: [
        () =>
          json({
            authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
            flow_id: 'FLOW_ID_NEW',
          }),
      ],
    });
    win = window;
    window.localStorage.setItem(
      'ds_oauth_flow.FLOW_ID_STALE',
      JSON.stringify({ secret: 's', iat: Date.now() - 11 * 60 * 1000 }),
    );
    window.localStorage.setItem(
      'ds_oauth_flow.FLOW_ID_PARALLEL',
      JSON.stringify({ secret: 's', iat: Date.now() - 60 * 1000 }),
    );
    oauthButton(window).click();
    await flush();
    await flush();
    expect(window.localStorage.getItem('ds_oauth_flow.FLOW_ID_STALE')).toBeNull();
    expect(window.localStorage.getItem('ds_oauth_flow.FLOW_ID_PARALLEL')).not.toBeNull();
    expect(window.localStorage.getItem('ds_oauth_flow.FLOW_ID_NEW')).not.toBeNull();
  });

  it('refuses to start a provider sign-up when localStorage is unavailable: no /start request, the banner names storage as the cause, the buttons recover', async () => {
    const { window, fetchCalls, navigations } = setUpDom(loadBuiltPage(), {
      storageFault: 'deny-all',
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
    await flush();
    await flush();
    // Direction of the real failure: the pre-v2 page fired /start here and the
    // customer only found out at the callback. Nothing may reach the server.
    expect(fetchCalls).toHaveLength(0);
    expect(navigations()).toBe(0);
    expect(bannerHidden(window)).toBe(false);
    expect(bannerText(window)).toMatch(
      /enable browser site storage before signing up with a provider.*nothing has been sent to the provider yet/i,
    );
    // The refusal happens BEFORE the busy lease is taken, so the button was never
    // disabled or marked busy (aria-busy stays unset, never 'true').
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('aria-busy')).not.toBe('true');
  });

  it('does not navigate to the IDP when the flow record write silently drops (read-back fails): banner names the cause, no navigation, buttons recover', async () => {
    const { window, fetchCalls, navigations } = setUpDom(loadBuiltPage(), {
      storageFault: 'drop-oauth-flow-write',
      fetchPlan: [
        () =>
          json({
            authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
            flow_id: 'FLOW_ID_DROPPED',
          }),
      ],
    });
    win = window;
    const btn = oauthButton(window);
    btn.click();
    await flush();
    await flush();
    // The pre-flight probe passes (only ds_oauth_flow.* writes drop), so /start
    // IS called with a binding_hash …
    const post = fetchCalls.find((c) => /\/v1\/auth\/oauth-client\/start$/.test(c.url));
    expect(
      typeof (JSON.parse(String(post?.init?.body)) as { binding_hash?: unknown }).binding_hash,
    ).toBe('string');
    // … but the record never landed, so leaving now would strand the sign-up at
    // the callback with nothing to redeem. Without the read-back the page would
    // navigate (navigations() === 1) with the banner still hidden.
    expect(window.localStorage.getItem('ds_oauth_flow.FLOW_ID_DROPPED')).toBeNull();
    expect(navigations()).toBe(0);
    expect(bannerHidden(window)).toBe(false);
    expect(bannerText(window)).toMatch(
      /could not persist the sign-up flow.*enable site storage.*start a fresh sign-up/i,
    );
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('aria-busy')).toBe('false');
  });

  it('OAuth v2 start carries the sanitized ?next= inside redirect_to (origin-prefixed) alongside the binding_hash', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      url: 'https://app.driftstack.io/signup/?next=' + encodeURIComponent('/cli/authorize?x=1'),
      fetchPlan: [
        () =>
          json({
            authorize_url: 'https://github.com/login/oauth/authorize?x=1',
            flow_id: 'FLOW_ID_NEXT',
          }),
      ],
    });
    win = window;
    oauthButton(window).click();
    await flush();
    await flush();
    const post = fetchCalls.find((c) => /\/v1\/auth\/oauth-client\/start$/.test(c.url));
    const body = JSON.parse(String(post?.init?.body)) as Record<string, unknown>;
    expect(body.redirect_to).toBe('https://app.driftstack.io/cli/authorize?x=1');
    expect(typeof body.binding_hash).toBe('string');
    expect(Object.keys(body).sort()).toEqual(['binding_hash', 'provider', 'redirect_to']);
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
      url: 'https://app.driftstack.io/signup/?next=' + encodeURIComponent('/cli/authorize'),
    });
    win = window;
    await flush();
    const link = window.document.querySelector('[data-login-link]') as HTMLAnchorElement | null;
    expect(link?.getAttribute('href')).toBe('/login/?next=' + encodeURIComponent('/cli/authorize'));
  });
});
