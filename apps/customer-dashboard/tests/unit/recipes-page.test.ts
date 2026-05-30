// Local integration test for the /recipes page's inline script.
// Loads the BUILT page (apps/customer-dashboard/dist/recipes/index.html),
// strips the inline scripts, executes the recipes page script inside a
// jsdom environment with a mocked localStorage + fetch, and asserts the
// hydrated DOM: which of [data-list] / [data-empty] / [data-more-wrap]
// is visible, the rendered rows, the "Load more" cursor walk, and the
// confirm-gated delete → reload-from-page-1 flow.
//
// Mirrors cli-authorize.test.ts. The recipes page fetches on LOAD (not
// on a button click), so the fetch plan is seeded BEFORE the script is
// eval'd — see setUpDom's `fetchPlan` arg.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'recipes', 'index.html');
const PAGE_URL = 'https://app.driftstack.dev/recipes/';

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
      console.warn('[recipes-page test] unplanned fetch:', call.url);
      return Promise.resolve(new Response('{}', { status: 500 }));
    }
    return Promise.resolve(handler(call));
  };
  if (opts.token !== undefined) window.localStorage.setItem('ds_web_session_token', opts.token);
  // Delete is gated by the branded window.driftstackConfirm modal
  // (injected by DashboardLayout, not eval'd here) → stub it to a
  // resolved Promise. Keep window.confirm stubbed as a defensive
  // fallback.
  const confirmResult = opts.confirmReturns ?? true;
  // @ts-expect-error — jsdom global is loose
  window.driftstackConfirm = () => Promise.resolve(confirmResult);
  window.confirm = () => confirmResult;

  const pageScript = scriptBodies.find((s) => s.includes('data-page="recipes"'));
  if (!pageScript) throw new Error('recipes inline script not found');
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

// Use the Node global Response (not window.Response): the fetch plan
// closures are seeded BEFORE setUpDom returns (the page fetches on
// load), so they can't reference the jsdom `window` const yet. A global
// Response exposes .ok / .status / .json() and works across realms.
function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

const RECIPE_A = {
  id: 'rec_aaaa',
  account_id: 'acc_1',
  agent_session_id: 'agt_1',
  label: 'Checkout flow',
  description: 'example.com checkout',
  intent_count: 12,
  created_at: '2026-05-20T10:00:00.000Z',
  updated_at: '2026-05-20T10:00:00.000Z',
};
const RECIPE_B = {
  id: 'rec_bbbb',
  account_id: 'acc_1',
  agent_session_id: null,
  label: 'Login probe',
  description: null,
  intent_count: 1,
  created_at: '2026-05-19T10:00:00.000Z',
  updated_at: '2026-05-19T10:00:00.000Z',
};

describe('recipes page — local integration', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });
  const loadBuiltPage = (): string => readFileSync(BUILT_PAGE, 'utf8');

  it('no token: does not fetch, leaves the empty state visible', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {});
    win = window;
    await flush();
    expect(fetchCalls.length).toBe(0);
    expect(isHidden(window, '[data-empty]')).toBe(false);
    expect(isHidden(window, '[data-list]')).toBe(true);
  });

  it('empty list: shows empty state, hides list + load-more', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [() => json({ data: [], has_more: false, next_cursor: null })],
    });
    win = window;
    await flush();
    expect(fetchCalls[0]?.url).toMatch(/\/v1\/recipes$/);
    expect(isHidden(window, '[data-empty]')).toBe(false);
    expect(isHidden(window, '[data-list]')).toBe(true);
    expect(isHidden(window, '[data-more-wrap]')).toBe(true);
  });

  it('non-empty list: renders rows with label + intent_count, hides empty + load-more when no cursor', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [() => json({ data: [RECIPE_A, RECIPE_B], has_more: false, next_cursor: null })],
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-list]')).toBe(false);
    expect(isHidden(window, '[data-empty]')).toBe(true);
    expect(isHidden(window, '[data-more-wrap]')).toBe(true);
    expect(rowCount(window)).toBe(2);
    const listText = window.document.querySelector('[data-list]')?.textContent ?? '';
    expect(listText).toContain('Checkout flow');
    expect(listText).toContain('12 intents');
    // Singular grammar + source-session-deleted indicator on RECIPE_B.
    expect(listText).toContain('1 intent');
    expect(listText).toContain('(source session deleted)');
  });

  it('pagination: Load more walks the cursor and appends, then hides when exhausted', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [
        () => json({ data: [RECIPE_A], has_more: true, next_cursor: 'cur1' }),
        () => json({ data: [RECIPE_B], has_more: false, next_cursor: null }),
      ],
    });
    win = window;
    await flush();
    expect(rowCount(window)).toBe(1);
    expect(isHidden(window, '[data-more-wrap]')).toBe(false);
    (window.document.querySelector('[data-more]') as HTMLButtonElement).click();
    await flush();
    // Second fetch carried the cursor.
    expect(fetchCalls[1]?.url).toMatch(/\/v1\/recipes\?cursor=cur1$/);
    expect(rowCount(window)).toBe(2);
    expect(isHidden(window, '[data-more-wrap]')).toBe(true);
  });

  it('delete: confirm-gated DELETE then reload-from-page-1 (204 → empty)', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      confirmReturns: true,
      fetchPlan: [
        () => json({ data: [RECIPE_A], has_more: false, next_cursor: null }),
        // DELETE → 204 No Content.
        () => new Response(null, { status: 204 }),
        // reload from page 1 → now empty.
        () => json({ data: [], has_more: false, next_cursor: null }),
      ],
    });
    win = window;
    await flush();
    expect(rowCount(window)).toBe(1);
    (window.document.querySelector('[data-delete]') as HTMLButtonElement).click();
    await flush(5);
    const del = fetchCalls.find((c) => c.init?.method === 'DELETE');
    expect(del?.url).toMatch(/\/v1\/recipes\/rec_aaaa$/);
    expect(isHidden(window, '[data-empty]')).toBe(false);
    expect(isHidden(window, '[data-list]')).toBe(true);
  });

  it('delete failure: surfaces the server problem+json detail, not a bare HTTP code, and keeps the row', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      confirmReturns: true,
      fetchPlan: [
        () => json({ data: [RECIPE_A], has_more: false, next_cursor: null }),
        // DELETE → 409 problem+json with a human detail.
        () => json({ detail: 'Recipe is referenced by an active session.' }, 409),
      ],
    });
    win = window;
    await flush();
    expect(rowCount(window)).toBe(1);
    (window.document.querySelector('[data-delete]') as HTMLButtonElement).click();
    await flush(5);
    expect(fetchCalls.some((c) => c.init?.method === 'DELETE')).toBe(true);
    const banner = window.document.querySelector('[data-banner]')?.textContent ?? '';
    expect(banner).toBe('Delete failed: Recipe is referenced by an active session.');
    // A failed delete does NOT reload, so the row remains.
    expect(rowCount(window)).toBe(1);
  });

  it('delete cancelled at confirm: no DELETE fetch fired', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      confirmReturns: false,
      fetchPlan: [() => json({ data: [RECIPE_A], has_more: false, next_cursor: null })],
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-delete]') as HTMLButtonElement).click();
    await flush();
    expect(fetchCalls.some((c) => c.init?.method === 'DELETE')).toBe(false);
    expect(rowCount(window)).toBe(1);
  });

  it('fetch error: surfaces the banner, list stays hidden', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [() => json({ title: 'boom' }, 500)],
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-banner]')).toBe(false);
    const banner = window.document.querySelector('[data-banner]')?.textContent ?? '';
    expect(banner).toMatch(/Couldn't load recipes/);
    expect(isHidden(window, '[data-list]')).toBe(true);
  });
});
