// Local integration test for the /webhooks page's inline script
// (V-181 list + V-347 create + V-359/V-475 rotate-secret + delete).
// Security-sensitive wiring: the signing secret is shown ONCE on
// create and on rotate. Loads the BUILT page, mocks localStorage +
// fetch, eval's the script, and asserts the real branches.
//
// Mirrors api-keys-page.test.ts. The page fetches on LOAD, so the
// fetch plan is seeded BEFORE eval. NOTE: this page reloads via
// window.location.reload() after create (8s timeout — never fires in
// test) and after delete (caught by the page's own .catch when jsdom
// can't navigate); reload is stubbed to a no-op and the meaningful
// assertion is that the right fetch fired.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'webhooks', 'index.html');
const PAGE_URL = 'https://app.driftstack.dev/webhooks/';

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
  // The page calls window.location.reload() after create/delete; jsdom
  // can't navigate and logs a "Not implemented: navigation" jsdomError.
  // It's caught by the page's own .catch (harmless) — filter it out of
  // the test console so real errors still surface.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err: Error) => {
    if (!/Not implemented: navigation/.test(String(err && err.message))) {
      // eslint-disable-next-line no-console
      console.error(err);
    }
  });
  const dom = new JSDOM(htmlNoScripts, {
    url: PAGE_URL,
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
      console.warn('[webhooks-page test] unplanned fetch:', call.url);
      return Promise.resolve(new Response('{}', { status: 500 }));
    }
    return Promise.resolve(handler(call));
  };
  if (opts.token !== undefined) window.localStorage.setItem('ds_web_session_token', opts.token);
  const __cr = opts.confirmReturns ?? true;
  // @ts-expect-error — driftstackConfirm is injected by DashboardLayout (not eval'd here)
  window.driftstackConfirm = () => Promise.resolve(__cr);
  window.confirm = () => __cr;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  // jsdom can't navigate; the page reloads after create/delete. No-op it
  // so the post-success reload doesn't throw inside the handler.
  try {
    // @ts-expect-error — overriding the jsdom location.reload stub
    window.location.reload = () => {};
  } catch {
    /* read-only in some jsdom builds; the page's own .catch swallows it */
  }

  const pageScript = scriptBodies.find((s) => s.includes('data-page="webhooks"'));
  if (!pageScript) throw new Error('webhooks inline script not found');
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

const ENDPOINT = {
  id: 'wh_endpoint',
  url: 'https://example.com/hook',
  active: true,
  events: ['session.errored'],
  description: 'CI hook',
  created_at: '2026-05-20T10:00:00.000Z',
  consecutive_failures: 0,
  last_success_at: null,
  rotation_grace_expires_at: null,
};

describe('webhooks page — local integration', () => {
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
    expect(fetchCalls[0]?.url).toMatch(/\/v1\/webhooks$/);
    expect(isHidden(window, '[data-empty]')).toBe(false);
    expect(isHidden(window, '[data-list]')).toBe(true);
  });

  it('non-empty: renders the endpoint with Rotate-secret + Delete actions', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [() => json({ data: [ENDPOINT] })],
    });
    win = window;
    await flush();
    expect(rowCount(window)).toBe(1);
    const text = window.document.querySelector('[data-list]')?.textContent ?? '';
    expect(text).toContain('https://example.com/hook');
    expect(window.document.querySelector('[data-rotate="wh_endpoint"]')).toBeTruthy();
    expect(window.document.querySelector('[data-delete="wh_endpoint"]')).toBeTruthy();
  });

  it('create: POSTs {url, events, description} and reveals the one-shot signing secret', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [
        () => json({ data: [] }),
        () => json({ id: 'wh_new', secret: 'whsec_THE_ONE_SHOT' }, 201),
      ],
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-show-create]') as HTMLButtonElement).click();
    const form = window.document.querySelector('[data-create-form]') as HTMLFormElement;
    (form.querySelector('input[name="url"]') as HTMLInputElement).value = 'https://hooks.test/x';
    (form.querySelector('input[name="event"]') as HTMLInputElement).checked = true;
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    const posts = fetchCalls.filter(
      (c) => c.init?.method === 'POST' && /\/v1\/webhooks$/.test(c.url),
    );
    expect(posts).toHaveLength(1);
    const post = posts[0];
    expect(post).toBeTruthy();
    expect(post?.init?.signal).toBeDefined();
    const body = JSON.parse(String(post?.init?.body));
    expect(body.url).toBe('https://hooks.test/x');
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBeGreaterThanOrEqual(1);
    expect(isHidden(window, '[data-create-reveal]')).toBe(false);
    expect(window.document.querySelector('[data-reveal-secret]')?.textContent).toBe(
      'whsec_THE_ONE_SHOT',
    );
  });

  it('create validation: missing event shows an inline error and fires no POST', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [() => json({ data: [] })],
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-show-create]') as HTMLButtonElement).click();
    const form = window.document.querySelector('[data-create-form]') as HTMLFormElement;
    (form.querySelector('input[name="url"]') as HTMLInputElement).value = 'https://hooks.test/x';
    // Uncheck every event checkbox (the form ships with one checked by
    // default) so the "pick at least one event" guard actually fires.
    form
      .querySelectorAll('input[name="event"]')
      .forEach((el) => ((el as HTMLInputElement).checked = false));
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    const err = window.document.querySelector('[data-create-error]');
    expect(err?.classList.contains('hidden')).toBe(false);
    expect(err?.textContent).toMatch(/at least one event/i);
    expect(fetchCalls.some((c) => c.init?.method === 'POST')).toBe(false);
  });

  it('create timeout reconciles a committed endpoint without pretending its secret is recoverable', async () => {
    const committed = { ...ENDPOINT, id: 'wh_committed', url: 'https://hooks.test/ambiguous' };
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [
        () => json({ data: [] }),
        () => Promise.reject(timeout),
        () => json({ data: [committed] }),
      ],
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-show-create]') as HTMLButtonElement).click();
    const form = window.document.querySelector('[data-create-form]') as HTMLFormElement;
    (form.querySelector('input[name="url"]') as HTMLInputElement).value = committed.url;
    (form.querySelector('input[name="event"]') as HTMLInputElement).checked = true;
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(10);

    expect(fetchCalls.filter((c) => /\/v1\/webhooks$/.test(c.url))).toHaveLength(3);
    expect(window.document.querySelector('[data-list]')?.textContent).toContain(committed.url);
    expect(isHidden(window, '[data-create-reveal]')).toBe(true);
    expect(window.document.querySelector('[data-reveal-secret]')?.textContent).toBe('');
    expect(window.document.querySelector('[data-create-error]')?.textContent).toMatch(
      /outcome is unknown.*list was refreshed.*secret cannot be recovered.*delete.*before creating another/i,
    );
  });

  it('rotate-secret: confirm-gated POST /:id/rotate-secret reveals the new secret', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      confirmReturns: true,
      fetchPlan: [
        () => json({ data: [ENDPOINT] }),
        () => json({ secret: 'whsec_ROTATED', grace_expires_at: '2026-05-21T10:00:00.000Z' }),
      ],
    });
    win = window;
    await flush();
    const rotateBtn = window.document.querySelector(
      '[data-rotate="wh_endpoint"]',
    ) as HTMLButtonElement;
    rotateBtn.dispatchEvent(new window.Event('click'));
    rotateBtn.dispatchEvent(new window.Event('click'));
    await flush();
    const rotations = fetchCalls.filter((c) =>
      /\/v1\/webhooks\/wh_endpoint\/rotate-secret$/.test(c.url),
    );
    expect(rotations).toHaveLength(1);
    const rot = rotations[0];
    expect(rot?.init?.method).toBe('POST');
    expect(rot?.init?.signal).toBeDefined();
    expect(isHidden(window, '[data-rotate-reveal]')).toBe(false);
    expect(window.document.querySelector('[data-rotate-secret]')?.textContent).toBe(
      'whsec_ROTATED',
    );
  });

  it('rotate timeout reconciles committed grace state without a false secret reveal', async () => {
    const rotating = {
      ...ENDPOINT,
      rotation_grace_expires_at: '2026-05-21T10:00:00.000Z',
    };
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [
        () => json({ data: [ENDPOINT] }),
        () => Promise.reject(timeout),
        () => json({ data: [rotating] }),
      ],
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-rotate="wh_endpoint"]') as HTMLButtonElement).click();
    await flush(10);

    expect(
      fetchCalls.filter((c) => /\/v1\/webhooks(?:\/wh_endpoint\/rotate-secret)?$/.test(c.url)),
    ).toHaveLength(3);
    expect(window.document.querySelector('[data-list]')?.textContent).toContain('rotating');
    expect(isHidden(window, '[data-rotate-reveal]')).toBe(true);
    expect(window.document.querySelector('[data-rotate-secret]')?.textContent).toBe('');
    expect(window.document.querySelector('[data-banner]')?.textContent).toMatch(
      /outcome is unknown.*list was refreshed.*secret cannot be recovered.*intentionally want to replace/i,
    );
  });

  it('delete: confirm-gated DELETE /v1/webhooks/:id fires', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      confirmReturns: true,
      fetchPlan: [() => json({ data: [ENDPOINT] }), () => new Response(null, { status: 204 })],
    });
    win = window;
    await flush();
    const deleteBtn = window.document.querySelector(
      '[data-delete="wh_endpoint"]',
    ) as HTMLButtonElement;
    deleteBtn.dispatchEvent(new window.Event('click'));
    deleteBtn.dispatchEvent(new window.Event('click'));
    await flush();
    const deletes = fetchCalls.filter((c) => c.init?.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    const del = deletes[0];
    expect(del?.url).toMatch(/\/v1\/webhooks\/wh_endpoint$/);
    expect(del?.init?.signal).toBeDefined();
  });

  it('send-test coalesces forced duplicate clicks into one bounded POST', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [() => json({ data: [ENDPOINT] }), () => json({ queued: true }, 202)],
    });
    win = window;
    await flush();
    const btn = window.document.querySelector('[data-test="wh_endpoint"]') as HTMLButtonElement;
    btn.dispatchEvent(new window.Event('click'));
    btn.dispatchEvent(new window.Event('click'));
    await flush();
    const sends = fetchCalls.filter((c) => /\/v1\/webhooks\/wh_endpoint\/test$/.test(c.url));
    expect(sends).toHaveLength(1);
    expect(sends[0]?.init?.signal).toBeDefined();
  });

  it('delete cancelled at confirm: no DELETE fetch fired', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      confirmReturns: false,
      fetchPlan: [() => json({ data: [ENDPOINT] })],
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-delete="wh_endpoint"]') as HTMLButtonElement).click();
    await flush();
    expect(fetchCalls.some((c) => c.init?.method === 'DELETE')).toBe(false);
  });
});
