// Local integration test for the /api-keys page's inline script
// (V-182 list + V-270 create/revoke + V-296b rotate). Security-
// sensitive wiring: the plaintext key is shown EXACTLY once on create
// and on rotate, and must be wiped from the DOM on dismiss. Loads the
// BUILT page, mocks localStorage + fetch, eval's the script, and
// asserts the real branches.
//
// Mirrors snapshots-page.test.ts / recipes-page.test.ts. The page
// fetches on LOAD, so the fetch plan is seeded BEFORE eval; create /
// rotate / revoke fetches are consumed in order as interactions fire.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'api-keys', 'index.html');
const PAGE_URL = 'https://app.driftstack.dev/api-keys/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface SetUpOpts {
  token?: string;
  confirmReturns?: boolean;
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
      console.warn('[api-keys-page test] unplanned fetch:', call.url);
      return Promise.resolve(new Response('{}', { status: 500 }));
    }
    return Promise.resolve(handler(call));
  };
  if (opts.token !== undefined) window.localStorage.setItem('ds_web_session_token', opts.token);
  const __cr = opts.confirmReturns ?? true;
  // @ts-expect-error — driftstackConfirm is injected by DashboardLayout (not eval'd here)
  window.driftstackConfirm = () => Promise.resolve(__cr);
  window.confirm = () => __cr;
  // jsdom doesn't implement these; the reveal panes call scrollIntoView,
  // and copy buttons (not exercised here) touch navigator.clipboard.
  window.HTMLElement.prototype.scrollIntoView = () => {};

  const pageScript = scriptBodies.find((s) => s.includes('data-page="api-keys"'));
  if (!pageScript) throw new Error('api-keys inline script not found');
  // @ts-expect-error — jsdom global has eval
  window.eval(pageScript);
  return { window: window as JSDOM['window'], fetchCalls };
}

function isHidden(window: JSDOM['window'], selector: string): boolean {
  const el = window.document.querySelector(selector);
  if (!el) throw new Error(`selector not found: ${selector}`);
  return el.classList.contains('hidden');
}

function rowCount(window: JSDOM['window']): number {
  return window.document.querySelectorAll('[data-list] > li').length;
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function abortError(): Error {
  const error = new Error('request aborted');
  error.name = 'AbortError';
  return error;
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const ACTIVE_KEY = {
  id: 'key_active',
  name: 'CI key',
  key_prefix: 'ds_live_abcd',
  scopes: ['account_owner'],
  created_at: '2026-05-20T10:00:00.000Z',
  last_used_at: null,
  revoked_at: null,
  expires_at: null,
};
const REVOKED_KEY = {
  id: 'key_revoked',
  name: 'Old key',
  key_prefix: 'ds_live_old0',
  scopes: ['read'],
  created_at: '2026-05-01T10:00:00.000Z',
  last_used_at: '2026-05-10T10:00:00.000Z',
  revoked_at: '2026-05-15T10:00:00.000Z',
  expires_at: null,
};

describe('api-keys page — local integration', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });
  const loadBuiltPage = (): string => readFileSync(BUILT_PAGE, 'utf8');

  it('empty list: shows empty state, hides the list', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [() => json({ data: [] })],
    });
    win = window;
    await flush();
    expect(fetchCalls[0]?.url).toMatch(/\/v1\/api-keys$/);
    expect(isHidden(window, '[data-empty]')).toBe(false);
    expect(isHidden(window, '[data-list]')).toBe(true);
  });

  it('non-empty: active key gets Rotate + Revoke; revoked key shows the revoked badge instead', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [() => json({ data: [ACTIVE_KEY, REVOKED_KEY] })],
    });
    win = window;
    await flush();
    expect(rowCount(window)).toBe(2);
    const text = window.document.querySelector('[data-list]')?.textContent ?? '';
    expect(text).toContain('CI key');
    expect(text).toContain('ds_live_abcd');
    // Active key → action buttons present.
    expect(window.document.querySelector('[data-rotate="key_active"]')).toBeTruthy();
    expect(window.document.querySelector('[data-revoke="key_active"]')).toBeTruthy();
    // Revoked key → NO action buttons, shows the revoked badge.
    expect(window.document.querySelector('[data-rotate="key_revoked"]')).toBeNull();
    expect(window.document.querySelector('[data-revoke="key_revoked"]')).toBeNull();
    expect(text.toLowerCase()).toContain('revoked');
  });

  it('supersedes an older list read so it cannot overwrite post-create credential state', async () => {
    let releaseInitial: (response: Response) => void = () => {};
    const initialRead = new Promise<Response>((resolve) => {
      releaseInitial = resolve;
    });
    const currentKey = { ...ACTIVE_KEY, id: 'key_new', name: 'Current key' };
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [
        () => initialRead,
        () => json({ id: 'key_new', plaintext: 'ds_live_CURRENT_SECRET' }, 201),
        () => json({ data: [currentKey] }),
      ],
    });
    win = window;
    const initialSignal = fetchCalls[0]?.init?.signal;
    (window.document.querySelector('[data-show-create]') as HTMLButtonElement).click();
    const form = window.document.querySelector('[data-create-form]') as HTMLFormElement;
    (form.querySelector('input[name="name"]') as HTMLInputElement).value = 'Current key';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks(40);

    expect(initialSignal?.aborted).toBe(true);
    expect(window.document.querySelector('[data-list]')?.textContent).toContain('Current key');
    releaseInitial(json({ data: [{ ...REVOKED_KEY, name: 'Stale key' }] }));
    await flushMicrotasks(30);
    const list = window.document.querySelector('[data-list]')?.textContent ?? '';
    expect(list).toContain('Current key');
    expect(list).not.toContain('Stale key');
  });

  it('aborts and invalidates an orphaned list read on pagehide', () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [() => new Promise(() => {})],
    });
    win = window;
    const signal = fetchCalls[0]?.init?.signal;
    expect(signal?.aborted).toBe(false);
    window.dispatchEvent(new window.Event('pagehide'));
    expect(signal?.aborted).toBe(true);
  });

  // S35 2026-07-07 (fable-frontend-audit) — fmtIso used to floor
  // (now - date)/day, so any FUTURE timestamp rendered "-1 days ago":
  // every rotated key displayed "grace ends -1 days ago" for its entire
  // 24h grace window.
  it('rotated key with a future grace expiry renders "grace ends in Nh" — never "-1 days ago"', async () => {
    const graceKey = {
      ...ACTIVE_KEY,
      id: 'key_grace',
      name: 'Rotated key',
      expires_at: new Date(Date.now() + 23.5 * 60 * 60 * 1000).toISOString(),
    };
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [() => json({ data: [graceKey] })],
    });
    win = window;
    await flush();
    const text = window.document.querySelector('[data-list]')?.textContent ?? '';
    expect(text).toContain('grace ends in 23h');
    expect(text).not.toContain('days ago');
  });

  it('a future grace expiry under an hour renders "grace ends in <1h"', async () => {
    const graceKey = {
      ...ACTIVE_KEY,
      id: 'key_grace_soon',
      name: 'Nearly-expired grace',
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [() => json({ data: [graceKey] })],
    });
    win = window;
    await flush();
    const text = window.document.querySelector('[data-list]')?.textContent ?? '';
    expect(text).toContain('grace ends in <1h');
  });

  it('create: POSTs {name, scopes}, reveals the one-shot plaintext', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [
        () => json({ data: [] }),
        () => json({ id: 'key_new', plaintext: 'ds_live_THE_ONE_SHOT_SECRET' }, 201),
        () => json({ data: [ACTIVE_KEY] }),
      ],
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-show-create]') as HTMLButtonElement).click();
    const form = window.document.querySelector('[data-create-form]') as HTMLFormElement;
    (form.querySelector('input[name="name"]') as HTMLInputElement).value = 'My new key';
    const broad = form.querySelector(
      'input[name="scope"][value="account_owner"]',
    ) as HTMLInputElement | null;
    if (broad) broad.checked = true;
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    const posts = fetchCalls.filter(
      (c) => c.init?.method === 'POST' && /\/v1\/api-keys$/.test(c.url),
    );
    expect(posts).toHaveLength(1);
    const post = posts[0];
    expect(post).toBeTruthy();
    expect(post?.init?.signal).toBeDefined();
    const body = JSON.parse(String(post?.init?.body));
    expect(body.name).toBe('My new key');
    expect(Array.isArray(body.scopes)).toBe(true);
    expect(body.scopes.length).toBeGreaterThanOrEqual(1);
    // Plaintext reveal shown once.
    expect(isHidden(window, '[data-created-reveal]')).toBe(false);
    expect(window.document.querySelector('[data-created-plaintext]')?.textContent).toBe(
      'ds_live_THE_ONE_SHOT_SECRET',
    );
  });

  it('create timeout reconciles the list and warns that a committed key plaintext is unrecoverable', async () => {
    const ambiguous = { ...ACTIVE_KEY, id: 'key_ambiguous', name: 'Ambiguous key' };
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [
        () => json({ data: [] }),
        () => Promise.reject(abortError()),
        () => json({ data: [ambiguous] }),
      ],
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-show-create]') as HTMLButtonElement).click();
    const form = window.document.querySelector('[data-create-form]') as HTMLFormElement;
    (form.querySelector('input[name="name"]') as HTMLInputElement).value = 'Ambiguous key';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(window.document.querySelector('[data-list]')?.textContent).toContain('Ambiguous key');
    const warning = window.document.querySelector('[data-create-error]')?.textContent ?? '';
    expect(warning).toMatch(/outcome is unknown/i);
    expect(warning).toMatch(/plaintext cannot be recovered/i);
    expect(warning).toMatch(/revoke it before creating another key/i);
    expect(isHidden(window, '[data-created-reveal]')).toBe(true);
  });

  it('create reveal dismiss WIPES the plaintext from the DOM (no post-dismiss recovery)', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [
        () => json({ data: [] }),
        () => json({ id: 'key_new', plaintext: 'ds_live_SENSITIVE' }, 201),
        () => json({ data: [ACTIVE_KEY] }),
      ],
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-show-create]') as HTMLButtonElement).click();
    const form = window.document.querySelector('[data-create-form]') as HTMLFormElement;
    (form.querySelector('input[name="name"]') as HTMLInputElement).value = 'Wipe me';
    const broad = form.querySelector(
      'input[name="scope"][value="account_owner"]',
    ) as HTMLInputElement | null;
    if (broad) broad.checked = true;
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(window.document.querySelector('[data-created-plaintext]')?.textContent).toBe(
      'ds_live_SENSITIVE',
    );
    (window.document.querySelector('[data-created-dismiss]') as HTMLButtonElement).click();
    expect(isHidden(window, '[data-created-reveal]')).toBe(true);
    expect(window.document.querySelector('[data-created-plaintext]')?.textContent).toBe('');
  });

  it('rotate: confirm-gated POST /:id/rotate reveals the new plaintext + grace expiry', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      confirmReturns: true,
      fetchPlan: [
        () => json({ data: [ACTIVE_KEY] }),
        () =>
          json({
            rotated_from: 'key_active',
            plaintext: 'ds_live_ROTATED_SECRET',
            grace_period_ends_at: '2026-05-21T10:00:00.000Z',
          }),
        () => json({ data: [{ ...ACTIVE_KEY, expires_at: '2026-05-21T10:00:00.000Z' }] }),
      ],
    });
    win = window;
    await flush();
    const rotateBtn = window.document.querySelector(
      '[data-rotate="key_active"]',
    ) as HTMLButtonElement;
    rotateBtn.dispatchEvent(new window.Event('click'));
    rotateBtn.dispatchEvent(new window.Event('click'));
    await flush();
    const rotations = fetchCalls.filter((c) => /\/v1\/api-keys\/key_active\/rotate$/.test(c.url));
    expect(rotations).toHaveLength(1);
    const rot = rotations[0];
    expect(rot?.init?.method).toBe('POST');
    expect(rot?.init?.signal).toBeDefined();
    expect(isHidden(window, '[data-rotate-reveal]')).toBe(false);
    expect(window.document.querySelector('[data-rotate-plaintext]')?.textContent).toBe(
      'ds_live_ROTATED_SECRET',
    );
    expect(window.document.querySelector('[data-rotate-grace-expires]')?.textContent).not.toBe('');
  });

  it('rotate timeout reconciles the list and warns against a blind second rotation', async () => {
    const ambiguous = { ...ACTIVE_KEY, id: 'key_rotated_unknown', name: 'CI key' };
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      confirmReturns: true,
      fetchPlan: [
        () => json({ data: [ACTIVE_KEY] }),
        () => Promise.reject(abortError()),
        () => json({ data: [ambiguous, ACTIVE_KEY] }),
      ],
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-rotate="key_active"]') as HTMLButtonElement).click();
    await flush();

    expect(rowCount(window)).toBe(2);
    const warning = window.document.querySelector('[data-banner]')?.textContent ?? '';
    expect(warning).toMatch(/rotation timed out.*outcome is unknown/i);
    expect(warning).toMatch(/plaintext cannot be recovered/i);
    expect(warning).toMatch(/before rotating again/i);
    expect(isHidden(window, '[data-rotate-reveal]')).toBe(true);
  });

  it('revoke: confirm-gated DELETE then refresh', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      confirmReturns: true,
      fetchPlan: [
        () => json({ data: [ACTIVE_KEY] }),
        () => new Response(null, { status: 204 }),
        () => json({ data: [{ ...ACTIVE_KEY, revoked_at: '2026-05-20T11:00:00.000Z' }] }),
      ],
    });
    win = window;
    await flush();
    const revokeBtn = window.document.querySelector(
      '[data-revoke="key_active"]',
    ) as HTMLButtonElement;
    revokeBtn.dispatchEvent(new window.Event('click'));
    revokeBtn.dispatchEvent(new window.Event('click'));
    await flush();
    const deletes = fetchCalls.filter((c) => c.init?.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    const del = deletes[0];
    expect(del?.url).toMatch(/\/v1\/api-keys\/key_active$/);
    expect(del?.init?.signal).toBeDefined();
    // After refresh the key is revoked → no rotate/revoke buttons remain.
    expect(window.document.querySelector('[data-revoke="key_active"]')).toBeNull();
  });

  it('revoke cancelled at confirm: no DELETE fetch fired', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      confirmReturns: false,
      fetchPlan: [() => json({ data: [ACTIVE_KEY] })],
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-revoke="key_active"]') as HTMLButtonElement).click();
    await flush();
    expect(fetchCalls.some((c) => c.init?.method === 'DELETE')).toBe(false);
  });
});
