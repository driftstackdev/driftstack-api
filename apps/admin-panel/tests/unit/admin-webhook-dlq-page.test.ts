// Local integration test for the admin /webhook-dlq page's inline
// script — the dead-letter-queue operator console. The DISCARD action
// is the most destructive admin operation: it hard-deletes a webhook
// delivery (payload + retry history gone forever; only the audit row
// remains), so it MUST be confirm-gated. Requeue re-fires the delivery.
// Loads the built dist page, mocks localStorage + fetch with a stateful
// URL router, and stubs the branded window.driftstackConfirm (injected
// by AdminLayout). Admin pages are static → built dist HTML is loadable.
//
// Mirrors admin-sessions-page.test.ts (confirm variant).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'webhook-dlq', 'index.html');
const PAGE_URL = 'https://admin.driftstack.dev/webhook-dlq/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}
interface DlqEntry {
  id: string;
  event_type: string;
  attempts: number;
  created_at: string;
}
interface SetUpOpts {
  confirmReturns?: boolean;
  confirmCalls?: unknown[];
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
  window.driftstackConfirm = (_message: string, confirmOpts: unknown) => {
    opts.confirmCalls?.push(confirmOpts);
    return Promise.resolve(cr);
  };

  const pageScript = scriptBodies.find((s) => s.includes('data-page="admin-dlq"'));
  if (!pageScript) throw new Error('admin webhook-dlq inline script not found');
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

function mkEntry(over: Partial<DlqEntry> = {}): DlqEntry {
  return {
    id: 'whd_' + Math.random().toString(36).slice(2, 8),
    event_type: 'session.errored',
    attempts: 6,
    created_at: '2026-05-28T10:00:00.000Z',
    ...over,
  };
}

function makeRouter(entries: DlqEntry[]): (c: MockFetchCall) => Response {
  return (call: MockFetchCall): Response => {
    const method = (call.init?.method || 'GET').toUpperCase();
    const u = call.url.replace(/^https?:\/\/[^/]+/, '');
    const act = u.match(/\/v1\/admin\/webhook-dlq\/([^/?]+)\/(discard|requeue)$/);
    if (act && method === 'POST') {
      const i = entries.findIndex((e) => e.id === act[1]);
      if (i >= 0) entries.splice(i, 1); // both discard + requeue remove from the DLQ
      return json({ ok: true });
    }
    if (/\/v1\/admin\/webhook-dlq(\?|$)/.test(u) && method === 'GET') {
      return json({ data: entries });
    }
    return json({}, 404);
  };
}

describe('admin webhook-dlq page — discard / requeue (operator)', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });
  const loadBuiltPage = (): string => readFileSync(BUILT_PAGE, 'utf8');

  it('renders DLQ entries with Requeue + Discard actions', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      route: makeRouter([mkEntry({ id: 'whd_1' })]),
    });
    win = window;
    await flush();
    expect(window.document.querySelector('[data-action="requeue"][data-id="whd_1"]')).toBeTruthy();
    expect(window.document.querySelector('[data-action="discard"][data-id="whd_1"]')).toBeTruthy();
  });

  it('CRITICAL discard confirm is destructive:true — without it a stray Enter fires the irrecoverable hard-delete with no click required (audit waefer6wu)', async () => {
    const confirmCalls: unknown[] = [];
    const { window } = setUpDom(loadBuiltPage(), {
      confirmReturns: true,
      confirmCalls,
      route: makeRouter([mkEntry({ id: 'whd_1' })]),
    });
    win = window;
    await flush();
    (
      window.document.querySelector('[data-action="discard"][data-id="whd_1"]') as HTMLButtonElement
    ).click();
    await flush();
    expect(confirmCalls.length).toBe(1);
    expect(confirmCalls[0]).toMatchObject({ destructive: true });
  });

  it('discard: confirm-gated POST /:id/discard then refresh removes that entry (others remain)', async () => {
    // Two entries so the list re-renders (a 0-length refresh hides the
    // region without clearing innerHTML, which would leave stale nodes).
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      confirmReturns: true,
      route: makeRouter([mkEntry({ id: 'whd_1' }), mkEntry({ id: 'whd_2' })]),
    });
    win = window;
    await flush();
    (
      window.document.querySelector('[data-action="discard"][data-id="whd_1"]') as HTMLButtonElement
    ).click();
    await flush();
    const post = fetchCalls.find(
      (c) => c.init?.method === 'POST' && /\/v1\/admin\/webhook-dlq\/whd_1\/discard$/.test(c.url),
    );
    expect(post).toBeTruthy();
    expect(window.document.querySelector('[data-action="discard"][data-id="whd_1"]')).toBeNull();
    expect(window.document.querySelector('[data-action="discard"][data-id="whd_2"]')).toBeTruthy();
  });

  it('discard cancelled: irrecoverable delete is NOT fired without confirmation', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      confirmReturns: false,
      route: makeRouter([mkEntry({ id: 'whd_1' })]),
    });
    win = window;
    await flush();
    (
      window.document.querySelector('[data-action="discard"][data-id="whd_1"]') as HTMLButtonElement
    ).click();
    await flush();
    expect(fetchCalls.some((c) => /\/discard$/.test(c.url))).toBe(false);
    expect(window.document.querySelector('[data-action="discard"][data-id="whd_1"]')).toBeTruthy();
  });

  it('requeue: POST /:id/requeue (re-fire delivery) then refresh removes the entry', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: makeRouter([mkEntry({ id: 'whd_1' })]),
    });
    win = window;
    await flush();
    (
      window.document.querySelector('[data-action="requeue"][data-id="whd_1"]') as HTMLButtonElement
    ).click();
    await flush();
    const post = fetchCalls.find(
      (c) => c.init?.method === 'POST' && /\/v1\/admin\/webhook-dlq\/whd_1\/requeue$/.test(c.url),
    );
    expect(post).toBeTruthy();
  });

  it('locks both entry actions and sends only one requeue while the mutation is pending', async () => {
    let resolveMutation: ((response: Response) => void) | undefined;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route(call) {
        const method = (call.init?.method || 'GET').toUpperCase();
        if (method === 'POST') {
          return new Promise<Response>((resolve) => {
            resolveMutation = resolve;
          });
        }
        return json({ data: [mkEntry({ id: 'whd_1' })] });
      },
    });
    win = window;
    await flush();
    const requeue = window.document.querySelector(
      '[data-action="requeue"][data-id="whd_1"]',
    ) as HTMLButtonElement;
    const discard = window.document.querySelector(
      '[data-action="discard"][data-id="whd_1"]',
    ) as HTMLButtonElement;

    requeue.click();
    requeue.click();
    await flush(1);

    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
    expect(requeue.disabled).toBe(true);
    expect(requeue.textContent).toBe('Requeueing…');
    expect(requeue.getAttribute('aria-busy')).toBe('true');
    expect(discard.disabled).toBe(true);

    resolveMutation?.(json({ ok: true }));
    await flush();
  });

  it('single-flights discard before its async confirmation resolves', async () => {
    const confirmCalls: unknown[] = [];
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      confirmReturns: true,
      confirmCalls,
      route: makeRouter([mkEntry({ id: 'whd_1' })]),
    });
    win = window;
    await flush();
    const discard = window.document.querySelector(
      '[data-action="discard"][data-id="whd_1"]',
    ) as HTMLButtonElement;

    discard.click();
    discard.click();
    await flush();

    expect(confirmCalls).toHaveLength(1);
    expect(
      fetchCalls.filter((call) => call.init?.method === 'POST' && /\/discard$/.test(call.url)),
    ).toHaveLength(1);
  });
});
