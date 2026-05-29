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
  fetchPlan?: Array<(call: MockFetchCall) => Response>;
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
  window.confirm = () => opts.confirmReturns ?? true;
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

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
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
    await flush();
    const post = fetchCalls.find((c) => c.init?.method === 'POST' && /\/v1\/api-keys$/.test(c.url));
    expect(post).toBeTruthy();
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
    (window.document.querySelector('[data-rotate="key_active"]') as HTMLButtonElement).click();
    await flush();
    const rot = fetchCalls.find((c) => /\/v1\/api-keys\/key_active\/rotate$/.test(c.url));
    expect(rot?.init?.method).toBe('POST');
    expect(isHidden(window, '[data-rotate-reveal]')).toBe(false);
    expect(window.document.querySelector('[data-rotate-plaintext]')?.textContent).toBe(
      'ds_live_ROTATED_SECRET',
    );
    expect(window.document.querySelector('[data-rotate-grace-expires]')?.textContent).not.toBe('');
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
    (window.document.querySelector('[data-revoke="key_active"]') as HTMLButtonElement).click();
    await flush();
    const del = fetchCalls.find((c) => c.init?.method === 'DELETE');
    expect(del?.url).toMatch(/\/v1\/api-keys\/key_active$/);
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
