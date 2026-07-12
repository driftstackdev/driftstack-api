// Local integration test for the admin /rate-limit-overrides page's
// inline script — the operator clears a per-account quota override
// (DELETE /v1/admin/accounts/:id/quota-override?bucket_key=…),
// confirm-gated. A wiring bug could clear the WRONG bucket (the colon
// in bucket-keys like 'sessions:create' must be URL-encoded). Loads the
// built dist page, mocks localStorage + fetch with a stateful router,
// stubs the branded window.driftstackConfirm. Admin pages are static.
//
// Mirrors admin-webhook-dlq-page.test.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'rate-limit-overrides', 'index.html');
const PAGE_URL = 'https://admin.driftstack.dev/rate-limit-overrides/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}
interface Override {
  account_id: string;
  bucket_key: string;
  refill_per_second: number;
  expires_at: string;
}
interface SetUpOpts {
  confirmReturns?: boolean;
  route: (call: MockFetchCall) => Response | Promise<Response>;
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
  // @ts-expect-error — jsdom global is loose
  if (typeof window.Response !== 'function') window.Response = Response;
  // @ts-expect-error — jsdom global is loose
  window.fetch = (input: string, init: RequestInit | undefined) => {
    const call: MockFetchCall = { url: String(input), init };
    fetchCalls.push(call);
    return Promise.resolve(opts.route(call));
  };
  window.localStorage.setItem('ds_web_session_token', 'staff-tok');
  const cr = opts.confirmReturns ?? true;
  // @ts-expect-error — driftstackConfirm is injected by AdminLayout
  window.driftstackConfirm = () => Promise.resolve(cr);

  const pageScript = scriptBodies.find((s) => s.includes('data-page="admin-overrides"'));
  if (!pageScript) throw new Error('admin rate-limit-overrides inline script not found');
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
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

function makeRouter(overrides: Override[]): (c: MockFetchCall) => Response {
  return (call: MockFetchCall): Response => {
    const method = (call.init?.method || 'GET').toUpperCase();
    const u = call.url.replace(/^https?:\/\/[^/]+/, '');
    const clear = u.match(/\/v1\/admin\/accounts\/([^/]+)\/quota-override\?bucket_key=(.+)$/);
    if (clear && method === 'DELETE') {
      const accountId = decodeURIComponent(clear[1]!);
      const bucket = decodeURIComponent(clear[2]!);
      const i = overrides.findIndex((o) => o.account_id === accountId && o.bucket_key === bucket);
      if (i >= 0) overrides.splice(i, 1);
      return new Response(null, { status: 204 });
    }
    if (/\/v1\/admin\/rate-limit-overrides(\?|$)/.test(u) && method === 'GET') {
      return json({ data: overrides });
    }
    return json({}, 404);
  };
}

const OV_A: Override = {
  account_id: 'acc_a',
  bucket_key: 'sessions:create',
  refill_per_second: 5,
  expires_at: '2026-06-01T10:00:00.000Z',
};
const OV_B: Override = {
  account_id: 'acc_b',
  bucket_key: 'agent_sessions:message',
  refill_per_second: 2,
  expires_at: '2026-06-02T10:00:00.000Z',
};

describe('admin rate-limit-overrides page — clear-now (operator)', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });
  const loadBuiltPage = (): string => readFileSync(BUILT_PAGE, 'utf8');

  it('renders overrides with a Clear-now action carrying account_id + bucket_key', async () => {
    const { window } = setUpDom(loadBuiltPage(), { route: makeRouter([{ ...OV_A }]) });
    win = window;
    await flush();
    const btn = window.document.querySelector('[data-action="clear"][data-account-id="acc_a"]');
    expect(btn).toBeTruthy();
    expect(btn?.getAttribute('data-bucket-key')).toBe('sessions:create');
  });

  it('clear: confirm-gated DELETE /accounts/:id/quota-override?bucket_key=… (colon URL-encoded), then refresh drops it', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      confirmReturns: true,
      route: makeRouter([{ ...OV_A }, { ...OV_B }]),
    });
    win = window;
    await flush();
    (
      window.document.querySelector(
        '[data-action="clear"][data-account-id="acc_a"]',
      ) as HTMLButtonElement
    ).click();
    await flush();
    const del = fetchCalls.find((c) => c.init?.method === 'DELETE');
    expect(del?.url).toContain('/v1/admin/accounts/acc_a/quota-override?bucket_key=');
    // The colon in the bucket key must be percent-encoded on the wire.
    expect(del?.url).toContain('sessions%3Acreate');
    expect(
      window.document.querySelector('[data-action="clear"][data-account-id="acc_a"]'),
    ).toBeNull();
    expect(
      window.document.querySelector('[data-action="clear"][data-account-id="acc_b"]'),
    ).toBeTruthy();
  });

  it('clear cancelled: no DELETE fired, the override stays', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      confirmReturns: false,
      route: makeRouter([{ ...OV_A }]),
    });
    win = window;
    await flush();
    (
      window.document.querySelector(
        '[data-action="clear"][data-account-id="acc_a"]',
      ) as HTMLButtonElement
    ).click();
    await flush();
    expect(fetchCalls.some((c) => c.init?.method === 'DELETE')).toBe(false);
    expect(
      window.document.querySelector('[data-action="clear"][data-account-id="acc_a"]'),
    ).toBeTruthy();
  });

  it('single-flights the account+bucket clear and stays visibly busy through DELETE', async () => {
    const overrides = [{ ...OV_A }];
    let finishDelete: (response: Response) => void = () => {};
    const pendingDelete = new Promise<Response>((resolve) => {
      finishDelete = resolve;
    });
    const fallback = makeRouter(overrides);
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => (call.init?.method === 'DELETE' ? pendingDelete : fallback(call)),
    });
    win = window;
    await flush();
    const button = window.document.querySelector(
      '[data-action="clear"][data-account-id="acc_a"]',
    ) as HTMLButtonElement;
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flush(2);

    expect(fetchCalls.filter((call) => call.init?.method === 'DELETE')).toHaveLength(1);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.textContent).toBe('Clearing…');

    overrides.splice(0, 1);
    finishDelete(new Response(null, { status: 204 }));
    await flush();
    expect(
      window.document.querySelector('[data-action="clear"][data-account-id="acc_a"]'),
    ).toBeNull();
  });
});
