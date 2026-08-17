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
import { installDashboardDeadline } from './dashboard-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'api-keys', 'index.html');
const PAGE_URL = 'https://app.driftstack.dev/api-keys/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface SetUpOpts {
  token?: string | null;
  storageDenied?: boolean;
  confirmReturns?: boolean;
  callerTier?: string;
  callerId?: string;
  callerTeams?: Array<{
    owner_account_id: string;
    role: string;
    membership_id?: string;
  }>;
  effectiveTier?: string;
  entitlementPlan?: (call: MockFetchCall) => Response | Promise<Response>;
  accountMePlan?: (call: MockFetchCall) => Response | Promise<Response>;
  actAsHeaders?: Record<string, string>;
  fetchPlan?: Array<(call: MockFetchCall) => Response | Promise<Response>>;
  clipboardPlan?: Array<(text: string) => Promise<void>>;
}

function setUpDom(
  html: string,
  opts: SetUpOpts,
): {
  window: JSDOM['window'];
  fetchCalls: MockFetchCall[];
  clipboardWrites: string[];
  hydratedCount: () => number;
} {
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
  const clipboardWrites: string[] = [];
  const clipboardPlan = [...(opts.clipboardPlan ?? [])];
  // @ts-expect-error — jsdom global is loose
  if (typeof window.Response !== 'function') window.Response = Response;
  // @ts-expect-error — jsdom global is loose
  window.fetch = (input: string, init: RequestInit | undefined) => {
    const call: MockFetchCall = { url: String(input), init };
    fetchCalls.push(call);
    if (/\/v1\/account\/me$/.test(call.url)) {
      const callerId = opts.callerId ?? 'acc_caller';
      const selectedOwner =
        opts.actAsHeaders?.['x-driftstack-account'] ??
        opts.actAsHeaders?.['X-Driftstack-Account'] ??
        '';
      const defaultTeams =
        selectedOwner && selectedOwner !== callerId
          ? [{ owner_account_id: selectedOwner, role: 'admin', membership_id: 'mem_default' }]
          : [];
      return Promise.resolve(
        opts.accountMePlan?.(call) ??
          json({
            id: callerId,
            tier: opts.callerTier ?? 'free',
            teams: opts.callerTeams ?? defaultTeams,
          }),
      );
    }
    if (/\/v1\/usage$/.test(call.url)) {
      return Promise.resolve(
        opts.entitlementPlan?.(call) ?? json({ tier: opts.effectiveTier ?? 'api_builder' }),
      );
    }
    const handler = plan.shift();
    if (!handler) {
      // eslint-disable-next-line no-console
      console.warn('[api-keys-page test] unplanned fetch:', call.url);
      return Promise.resolve(new Response('{}', { status: 500 }));
    }
    return Promise.resolve(handler(call));
  };
  if (opts.storageDenied === true) {
    Object.defineProperty(Object.getPrototypeOf(window.localStorage), 'getItem', {
      configurable: true,
      value: () => {
        throw new Error('storage denied');
      },
    });
  } else if (opts.token !== undefined && opts.token !== null) {
    window.localStorage.setItem('ds_web_session_token', opts.token);
  }
  let hydrated = 0;
  // @ts-expect-error — injected by DashboardLayout
  window.dashboardHydrated = () => {
    hydrated += 1;
  };
  const __cr = opts.confirmReturns ?? true;
  // @ts-expect-error — driftstackConfirm is injected by DashboardLayout (not eval'd here)
  window.driftstackConfirm = () => Promise.resolve(__cr);
  // @ts-expect-error — injected by DashboardLayout
  window.driftstackActAsHeaders = () => opts.actAsHeaders ?? {};
  window.confirm = () => __cr;
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        clipboardWrites.push(text);
        return clipboardPlan.shift()?.(text) ?? Promise.resolve();
      },
    },
  });
  // jsdom doesn't implement scrollIntoView; reveal panes use it.
  window.HTMLElement.prototype.scrollIntoView = () => {};
  installDashboardDeadline(window);

  const pageScript = scriptBodies.find((s) => s.includes('data-page="api-keys"'));
  if (!pageScript) throw new Error('api-keys inline script not found');
  // @ts-expect-error — jsdom global has eval
  window.eval(pageScript);
  return {
    window: window as JSDOM['window'],
    fetchCalls,
    clipboardWrites,
    hydratedCount: () => hydrated,
  };
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

  it.each([
    ['signed out', {}],
    ['storage denied', { storageDenied: true }],
  ])('%s: releases hydration without network and keeps create inert', async (_label, auth) => {
    const { window, fetchCalls, hydratedCount } = setUpDom(loadBuiltPage(), auth);
    win = window;
    await flush();

    expect(fetchCalls).toHaveLength(0);
    expect(hydratedCount()).toBe(1);
    expect(window.document.querySelector('[data-banner]')?.textContent).toContain('Sign in');
    for (const button of window.document.querySelectorAll<HTMLButtonElement>(
      '[data-show-create], [data-create-submit]',
    )) {
      expect(button.disabled).toBe(true);
    }
  });

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
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
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

  it('Free: lists and revokes existing keys while every create/rotate surface and forced form submit stay inert', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      effectiveTier: 'free',
      fetchPlan: [
        () => json({ data: [ACTIVE_KEY] }),
        () => new Response(null, { status: 204 }),
        () => json({ data: [{ ...ACTIVE_KEY, revoked_at: '2026-07-17T10:00:00.000Z' }] }),
      ],
    });
    win = window;
    await flush();

    expect(window.document.querySelector('[data-revoke="key_active"]')).toBeTruthy();
    expect(isHidden(window, '[data-rotate="key_active"]')).toBe(true);
    expect(isHidden(window, '[data-api-access-notice]')).toBe(false);
    expect(window.document.querySelector('[data-api-access-notice]')?.textContent).toContain(
      'Free sessions',
    );
    for (const element of window.document.querySelectorAll('[data-api-access-only]')) {
      expect(element.classList.contains('hidden')).toBe(true);
    }

    const forcedButton = window.document.querySelector('[data-show-create]') as HTMLButtonElement;
    forcedButton.disabled = false;
    forcedButton.classList.remove('hidden');
    forcedButton.click();
    expect(isHidden(window, '[data-create-form-wrap]')).toBe(true);

    const form = window.document.querySelector('[data-create-form]') as HTMLFormElement;
    (form.querySelector('input[name="name"]') as HTMLInputElement).value = 'Forced key';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    expect(
      fetchCalls.filter((call) => call.init?.method === 'POST' && /\/v1\/api-keys$/.test(call.url)),
    ).toHaveLength(0);

    (window.document.querySelector('[data-revoke="key_active"]') as HTMLButtonElement).click();
    await flush();
    expect(fetchCalls.filter((call) => call.init?.method === 'DELETE')).toHaveLength(1);
  });

  it.each([
    ['unknown tier', { effectiveTier: 'future_unknown' }],
    ['effective-tier lookup failure', { entitlementPlan: () => json({}, 503) }],
  ])(
    '%s: fails closed for creation/rotation without blocking list or revoke',
    async (_label, account) => {
      const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
        token: 'tok',
        ...account,
        fetchPlan: [() => json({ data: [ACTIVE_KEY] })],
      });
      win = window;
      await flush();

      expect(window.document.querySelector('[data-revoke="key_active"]')).toBeTruthy();
      expect(isHidden(window, '[data-rotate="key_active"]')).toBe(true);
      expect(isHidden(window, '[data-api-access-notice]')).toBe(false);
      expect(fetchCalls.some((call) => /\/v1\/usage$/.test(call.url))).toBe(true);
      expect(
        fetchCalls.filter(
          (call) => call.init?.method === 'POST' && /\/v1\/api-keys$/.test(call.url),
        ),
      ).toHaveLength(0);
    },
  );

  it('uses selected-owner headers for effective reads but caller-only headers for role authority', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      actAsHeaders: { 'x-driftstack-account': 'acc_owner' },
      fetchPlan: [() => json({ data: [] })],
    });
    win = window;
    await flush();

    const effectiveReads = fetchCalls.filter((call) => /\/v1\/(?:api-keys|usage)$/.test(call.url));
    expect(effectiveReads).toHaveLength(2);
    for (const read of effectiveReads) {
      expect(read.init?.headers).toMatchObject({
        authorization: 'Bearer tok',
        'x-driftstack-account': 'acc_owner',
      });
    }
    const callerRead = fetchCalls.find((call) => /\/v1\/account\/me$/.test(call.url));
    expect(callerRead?.init?.headers).toEqual({ authorization: 'Bearer tok' });
  });

  it('Free caller acting as a paid team admin gets paid write controls from both authorities', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      callerTier: 'free',
      effectiveTier: 'api_builder',
      callerTeams: [{ owner_account_id: 'acc_owner', role: 'admin', membership_id: 'mem_admin' }],
      actAsHeaders: { 'x-driftstack-account': 'acc_owner' },
      fetchPlan: [() => json({ data: [ACTIVE_KEY] })],
    });
    win = window;
    await flush();

    expect(fetchCalls.some((call) => /\/v1\/account\/me$/.test(call.url))).toBe(true);
    expect(fetchCalls.some((call) => /\/v1\/usage$/.test(call.url))).toBe(true);
    expect(isHidden(window, '[data-rotate="key_active"]')).toBe(false);
    expect(isHidden(window, '[data-revoke="key_active"]')).toBe(false);
    expect(isHidden(window, 'section[data-api-access-only]')).toBe(false);
    expect(isHidden(window, '[data-show-create]')).toBe(false);
  });

  it('paid caller acting as a paid team member keeps SDK guidance and list read-only even after forced DOM clicks', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      callerTier: 'api_builder',
      effectiveTier: 'api_builder',
      callerTeams: [{ owner_account_id: 'acc_owner', role: 'member', membership_id: 'mem_member' }],
      actAsHeaders: { 'x-driftstack-account': 'acc_owner' },
      fetchPlan: [() => json({ data: [ACTIVE_KEY] })],
    });
    win = window;
    await flush();

    expect(isHidden(window, 'section[data-api-access-only]')).toBe(false);
    expect(isHidden(window, '[data-show-create]')).toBe(true);
    expect(isHidden(window, '[data-rotate="key_active"]')).toBe(true);
    expect(isHidden(window, '[data-revoke="key_active"]')).toBe(true);
    expect(window.document.querySelector('[data-api-access-notice]')?.textContent).toContain(
      'selected team role is read-only',
    );

    const createButton = window.document.querySelector('[data-show-create]') as HTMLButtonElement;
    createButton.classList.remove('hidden');
    createButton.disabled = false;
    createButton.click();
    const form = window.document.querySelector('[data-create-form]') as HTMLFormElement;
    (form.querySelector('input[name="name"]') as HTMLInputElement).value = 'Forced member key';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    for (const selector of ['[data-rotate="key_active"]', '[data-revoke="key_active"]']) {
      const button = window.document.querySelector(selector) as HTMLButtonElement;
      button.classList.remove('hidden');
      button.disabled = false;
      button.click();
    }
    await flushMicrotasks();

    expect(isHidden(window, '[data-create-form-wrap]')).toBe(true);
    expect(
      fetchCalls.filter((call) =>
        ['POST', 'DELETE'].includes(String(call.init?.method ?? '').toUpperCase()),
      ),
    ).toHaveLength(0);
  });

  it.each([
    ['missing selected-team membership', { callerTeams: [] }],
    ['caller identity lookup failure', { accountMePlan: () => json({}, 503) }],
  ])('%s fails closed for every write while preserving key reads', async (_label, authority) => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      effectiveTier: 'api_builder',
      actAsHeaders: { 'x-driftstack-account': 'acc_owner' },
      ...authority,
      fetchPlan: [() => json({ data: [ACTIVE_KEY] })],
    });
    win = window;
    await flush();

    expect(window.document.querySelector('[data-list]')?.textContent).toContain('CI key');
    expect(isHidden(window, '[data-rotate="key_active"]')).toBe(true);
    expect(isHidden(window, '[data-revoke="key_active"]')).toBe(true);
    expect(isHidden(window, '[data-show-create]')).toBe(true);
    expect(
      fetchCalls.filter((call) =>
        ['POST', 'DELETE'].includes(String(call.init?.method ?? '').toUpperCase()),
      ),
    ).toHaveLength(0);
  });

  it('paid caller acting as a Free admin preserves revoke but hides tier-gated create and rotate', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      callerTier: 'api_builder',
      effectiveTier: 'free',
      callerTeams: [{ owner_account_id: 'acc_owner', role: 'admin', membership_id: 'mem_admin' }],
      actAsHeaders: { 'x-driftstack-account': 'acc_owner' },
      fetchPlan: [() => json({ data: [ACTIVE_KEY] })],
    });
    win = window;
    await flush();

    expect(isHidden(window, '[data-show-create]')).toBe(true);
    expect(isHidden(window, '[data-rotate="key_active"]')).toBe(true);
    expect(isHidden(window, '[data-revoke="key_active"]')).toBe(false);
    expect(isHidden(window, 'section[data-api-access-only]')).toBe(true);
  });

  it('requires the initial authoritative list before allowing a create', async () => {
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
    await flushMicrotasks(10);

    expect(initialSignal?.aborted).toBe(false);
    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(0);
    expect(isHidden(window, '[data-create-form-wrap]')).toBe(true);

    releaseInitial(json({ data: [] }));
    await flushMicrotasks(20);
    (window.document.querySelector('[data-show-create]') as HTMLButtonElement).click();
    (form.querySelector('input[name="name"]') as HTMLInputElement).value = 'Current key';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks(40);
    const list = window.document.querySelector('[data-list]')?.textContent ?? '';
    expect(list).toContain('Current key');
    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
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
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
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
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
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

  // "Shown once and never stored" is a promise this page makes to the customer
  // in its own copy, and nothing enforced the second half of it. Measured:
  // adding a localStorage.setItem of the revealed plaintext left all 1099
  // dashboard tests green.
  //
  // It matters because the failure is silent and durable. A key in
  // localStorage survives the tab, is readable by any XSS or page-scoped
  // extension, and is exactly what a customer who read that sentence believes
  // cannot happen. The reveal pane is the only place the plaintext is allowed
  // to exist.
  it('CRITICAL create: the one-shot plaintext is revealed but never persisted', async () => {
    const secret = 'ds_live_NEVER_PERSISTED_SECRET';
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [
        () => json({ data: [] }),
        () => json({ id: 'key_new', plaintext: secret }, 201),
        () => json({ data: [ACTIVE_KEY] }),
      ],
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-show-create]') as HTMLButtonElement).click();
    const form = window.document.querySelector('[data-create-form]') as HTMLFormElement;
    (form.querySelector('input[name="name"]') as HTMLInputElement).value = 'persist probe';
    const broad = form.querySelector(
      'input[name="scope"][value="account_owner"]',
    ) as HTMLInputElement | null;
    if (broad) broad.checked = true;
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    // It IS revealed — otherwise this arm would pass on a page that never
    // showed the key at all.
    expect(window.document.querySelector('[data-created-plaintext]')?.textContent).toBe(secret);

    const stores: ReadonlyArray<readonly [string, Storage]> = [
      ['localStorage', window.localStorage],
      ['sessionStorage', window.sessionStorage],
    ];
    for (const [label, store] of stores) {
      const dumped: string[] = [];
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key !== null) dumped.push(`${key}=${String(store.getItem(key))}`);
      }
      expect(
        dumped.join('\n'),
        `the one-time plaintext was written to ${label}, where it outlives the tab and is ` +
          'readable by any XSS or page-scoped extension — the page tells the customer it is ' +
          'never stored',
      ).not.toContain(secret);
    }
    expect(window.document.cookie, 'the plaintext was written to a cookie').not.toContain(secret);
    expect(window.location.href, 'the plaintext was put in the URL').not.toContain(secret);
  });

  it('copy feedback recovers from denial and mutates on repeated success', async () => {
    const secret = 'ds_live_COPY_RECOVERY_SECRET';
    const { window, clipboardWrites } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [
        () => json({ data: [] }),
        () => json({ id: 'key_copy', plaintext: secret }, 201),
        () => json({ data: [ACTIVE_KEY] }),
      ],
      clipboardPlan: [
        () => Promise.reject(new Error('clipboard denied')),
        () => Promise.resolve(),
        () => Promise.resolve(),
      ],
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-show-create]') as HTMLButtonElement).click();
    const form = window.document.querySelector('[data-create-form]') as HTMLFormElement;
    (form.querySelector('input[name="name"]') as HTMLInputElement).value = 'Copy recovery';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    const copy = window.document.querySelector('[data-created-copy]') as HTMLButtonElement;
    const feedback = window.document.querySelector('[data-created-copy-feedback]') as HTMLElement;
    copy.click();
    await flushMicrotasks();
    expect(feedback.textContent).toMatch(/copy failed/i);
    expect(feedback.classList.contains('hidden')).toBe(false);

    copy.click();
    await flushMicrotasks();
    expect(feedback.textContent).toBe('Copied.');
    expect(feedback.classList.contains('hidden')).toBe(false);

    let textMutations = 0;
    const observer = new window.MutationObserver((records) => {
      textMutations += records.filter((record) => record.type === 'childList').length;
    });
    observer.observe(feedback, { childList: true });
    copy.click();
    await flushMicrotasks();
    observer.disconnect();
    expect(feedback.textContent).toBe('Copied.');
    expect(textMutations).toBeGreaterThanOrEqual(2);
    expect(clipboardWrites).toEqual([secret, secret, secret]);

    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    copy.click();
    await flushMicrotasks();
    expect(feedback.textContent).toMatch(/copy failed.*manually/i);
    expect(feedback.classList.contains('hidden')).toBe(false);
    expect(clipboardWrites).toEqual([secret, secret, secret]);

    (window.document.querySelector('[data-created-dismiss]') as HTMLButtonElement).click();
    expect(feedback.textContent).toBe('');
    expect(feedback.classList.contains('hidden')).toBe(true);
  });

  it('create timeout reconciles the list and warns that a committed key plaintext is unrecoverable', async () => {
    const ambiguous = { ...ACTIVE_KEY, id: 'key_ambiguous', name: 'Ambiguous key' };
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
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
    const submit = form.querySelector('[data-create-submit]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(
      fetchCalls.filter((c) => c.init?.method === 'POST' && /\/v1\/api-keys$/.test(c.url)),
    ).toHaveLength(1);
    expect(window.document.querySelector('[data-create-error]')?.textContent).toMatch(
      /likely created.*one-shot plaintext was lost.*revoke the matching key/i,
    );
  });

  it('create timeout retries only after an authoritative exact-name non-match', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [
        () => json({ data: [] }),
        () => Promise.reject(abortError()),
        () => json({ data: [] }),
        () => json({ id: 'key_retry', plaintext: 'ds_live_RETRY' }, 201),
        () => json({ data: [{ ...ACTIVE_KEY, id: 'key_retry', name: 'Retry key' }] }),
      ],
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-show-create]') as HTMLButtonElement).click();
    const form = window.document.querySelector('[data-create-form]') as HTMLFormElement;
    (form.querySelector('input[name="name"]') as HTMLInputElement).value = 'Retry key';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    const submit = form.querySelector('[data-create-submit]') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(window.document.querySelector('[data-create-error]')?.textContent).toMatch(
      /authoritative list has no new.*retry key.*retry only if the key is still required/i,
    );
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(
      fetchCalls.filter((c) => c.init?.method === 'POST' && /\/v1\/api-keys$/.test(c.url)),
    ).toHaveLength(2);
    expect(window.document.querySelector('[data-created-plaintext]')?.textContent).toBe(
      'ds_live_RETRY',
    );
  });

  it('create timeout locks when the key list cannot be refreshed', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [
        () => json({ data: [] }),
        () => Promise.reject(abortError()),
        () => Promise.reject(new Error('list unavailable')),
      ],
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-show-create]') as HTMLButtonElement).click();
    const form = window.document.querySelector('[data-create-form]') as HTMLFormElement;
    (form.querySelector('input[name="name"]') as HTMLInputElement).value = 'Unverified key';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    const submit = form.querySelector('[data-create-submit]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toMatch(/verify before retrying/i);
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(
      fetchCalls.filter((c) => c.init?.method === 'POST' && /\/v1\/api-keys$/.test(c.url)),
    ).toHaveLength(1);
    expect(window.document.querySelector('[data-create-error]')?.textContent).toMatch(
      /creation timed out.*key list could not be refreshed.*reload and verify/i,
    );
  });

  it('create reveal dismiss WIPES the plaintext from the DOM (no post-dismiss recovery)', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
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

  it('serializes rotate and revoke controls for the same key', async () => {
    let releaseRotation: (response: Response) => void = () => {};
    const pendingRotation = new Promise<Response>((resolve) => {
      releaseRotation = resolve;
    });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      confirmReturns: true,
      fetchPlan: [
        () => json({ data: [ACTIVE_KEY] }),
        () => pendingRotation,
        () => json({ data: [ACTIVE_KEY] }),
      ],
    });
    win = window;
    await flush();
    const rotateBtn = window.document.querySelector(
      '[data-rotate="key_active"]',
    ) as HTMLButtonElement;
    const revokeBtn = window.document.querySelector(
      '[data-revoke="key_active"]',
    ) as HTMLButtonElement;

    rotateBtn.click();
    await flushMicrotasks();
    expect(rotateBtn.disabled).toBe(true);
    expect(revokeBtn.disabled).toBe(true);
    expect(revokeBtn.title).toBe('Wait for the active API key action to finish.');

    revokeBtn.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    expect(fetchCalls.filter((call) => call.init?.method === 'DELETE')).toHaveLength(0);
    expect(
      fetchCalls.filter((call) => /\/v1\/api-keys\/key_active\/rotate$/.test(call.url)),
    ).toHaveLength(1);

    releaseRotation(
      json({
        rotated_from: 'key_active',
        plaintext: 'ds_live_SERIALIZED_ROTATION',
        grace_period_ends_at: '2026-05-21T10:00:00.000Z',
      }),
    );
    await flush();
    const refreshedRevoke = window.document.querySelector(
      '[data-revoke="key_active"]',
    ) as HTMLButtonElement;
    expect(refreshedRevoke.disabled).toBe(false);
  });

  it('rotate timeout reconciles the list and warns against a blind second rotation', async () => {
    const ambiguous = { ...ACTIVE_KEY, id: 'key_rotated_unknown', name: 'CI key' };
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
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
    const blockedRotate = window.document.querySelector(
      '[data-rotate="key_active"]',
    ) as HTMLButtonElement;
    expect(blockedRotate.disabled).toBe(true);
    blockedRotate.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await flush();
    expect(
      fetchCalls.filter((c) => /\/v1\/api-keys\/key_active\/rotate$/.test(c.url)),
    ).toHaveLength(1);
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /rotation is locked.*reload and review the key list/i,
    );
  });

  it('rotate timeout retries only after an authoritative successor non-match', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      confirmReturns: true,
      fetchPlan: [
        () => json({ data: [ACTIVE_KEY] }),
        () => Promise.reject(abortError()),
        () => json({ data: [ACTIVE_KEY] }),
        () =>
          json({
            rotated_from: 'key_active',
            plaintext: 'ds_live_RETRIED_ROTATION',
            grace_period_ends_at: '2026-05-21T10:00:00.000Z',
          }),
        () =>
          json({
            data: [ACTIVE_KEY, { ...ACTIVE_KEY, id: 'key_retry_successor', name: 'CI key' }],
          }),
      ],
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-rotate="key_active"]') as HTMLButtonElement).click();
    await flush();

    const retryRotate = window.document.querySelector(
      '[data-rotate="key_active"]',
    ) as HTMLButtonElement;
    expect(retryRotate.disabled).toBe(false);
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /authoritative list has no new.*ci key.*successor.*retry only if rotation is still required/i,
    );
    retryRotate.click();
    await flush();
    expect(
      fetchCalls.filter((c) => /\/v1\/api-keys\/key_active\/rotate$/.test(c.url)),
    ).toHaveLength(2);
    expect(window.document.querySelector('[data-rotate-plaintext]')?.textContent).toBe(
      'ds_live_RETRIED_ROTATION',
    );
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

  it('revoke timeout refreshes status and blocks replay while the key still appears active', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      confirmReturns: true,
      fetchPlan: [
        () => json({ data: [ACTIVE_KEY] }),
        () => Promise.reject(abortError()),
        () => json({ data: [ACTIVE_KEY] }),
      ],
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-revoke="key_active"]') as HTMLButtonElement).click();
    await flush();

    const uncertainRevoke = window.document.querySelector(
      '[data-revoke="key_active"]',
    ) as HTMLButtonElement;
    const uncertainRotate = window.document.querySelector(
      '[data-rotate="key_active"]',
    ) as HTMLButtonElement;
    expect(uncertainRevoke.disabled).toBe(true);
    expect(uncertainRevoke.getAttribute('aria-busy')).toBeNull();
    expect(uncertainRevoke.textContent).toBe('Check status');
    expect(uncertainRotate.disabled).toBe(true);
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /outcome is unknown.*still shows.*active.*completion may be delayed.*do not revoke it again/i,
    );

    uncertainRevoke.dispatchEvent(new window.Event('click'));
    await flush();
    expect(fetchCalls.filter((call) => call.init?.method === 'DELETE')).toHaveLength(1);
  });

  it('revoke timeout reports likely completion when the refreshed list shows it revoked', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      confirmReturns: true,
      fetchPlan: [
        () => json({ data: [ACTIVE_KEY] }),
        () => Promise.reject(abortError()),
        () => json({ data: [{ ...ACTIVE_KEY, revoked_at: '2026-05-20T11:00:00.000Z' }] }),
      ],
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-revoke="key_active"]') as HTMLButtonElement).click();
    await flush();

    expect(window.document.querySelector('[data-revoke="key_active"]')).toBeNull();
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /outcome is unknown.*no longer shows.*active.*revocation likely completed.*do not revoke it again/i,
    );
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
