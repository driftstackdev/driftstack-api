// Local integration test for the /profiles page's inline script.
// Profiles are the mission-central entity (the "undetectable iOS
// profiles") and this is the most mutation-heavy dashboard page —
// create / clone / launch / snapshot / delete — with only source-regex
// coverage before. Loads the BUILT page, mocks localStorage + fetch,
// eval's the script, and asserts the real hydrated-DOM branches.
//
// Unlike the FIFO-plan pages, /profiles fires TWO concurrent fetches on
// load (GET /v1/profiles + GET /v1/account/me) and every mutation
// refreshes (two more), so this uses a stateful URL ROUTER over a
// mutable profiles array — GET reflects the current state, so a
// create/clone/delete produces a realistic post-refresh row count.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'profiles', 'index.html');
const PAGE_URL = 'https://app.driftstack.dev/profiles/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface SetUpOpts {
  token?: string;
  confirmReturns?: boolean;
  route: (call: MockFetchCall) => Response;
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
  if (opts.token !== undefined) window.localStorage.setItem('ds_web_session_token', opts.token);
  const __cr = opts.confirmReturns ?? true;
  // @ts-expect-error — driftstackConfirm is injected by DashboardLayout (not eval'd here)
  window.driftstackConfirm = () => Promise.resolve(__cr);
  window.confirm = () => __cr;
  window.HTMLElement.prototype.scrollIntoView = () => {};

  const pageScript = scriptBodies.find((s) => s.includes('data-page="profiles"'));
  if (!pageScript) throw new Error('profiles inline script not found');
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

function makeProfile(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'prof_' + Math.random().toString(36).slice(2, 8),
    name: 'My profile',
    description: 'a profile',
    archetype: 'iphone16pro_ios18_7_safari26_4',
    last_used_at: '2026-05-20T10:00:00.000Z',
    ...over,
  };
}

// Stateful router over a mutable profiles array. Handles the load pair
// (profiles + me), the proxy-picker hydrate, and the create/clone/
// launch/delete mutations. `me` returns 500 so the page's meP.catch
// drops it to null and skips renderUsage (we assert the list, not the
// tier panel).
function makeRouter(profiles: Array<Record<string, unknown>>): (c: MockFetchCall) => Response {
  let cloneSeq = 0;
  return (call: MockFetchCall): Response => {
    const method = (call.init?.method || 'GET').toUpperCase();
    const u = call.url;
    if (/\/v1\/account\/me$/.test(u)) return json({}, 500);
    if (/\/v1\/proxies$/.test(u)) return json({ data: [] });
    const cloneMatch = u.match(/\/v1\/profiles\/([^/]+)\/clone$/);
    if (cloneMatch && method === 'POST') {
      const src = profiles.find((p) => p.id === cloneMatch[1]);
      const copy = makeProfile({
        id: 'prof_clone' + cloneSeq++,
        name: (src?.name ?? 'profile') + ' (copy)',
      });
      profiles.push(copy);
      return json({ id: copy.id, name: copy.name }, 201);
    }
    const launchMatch = u.match(/\/v1\/profiles\/([^/]+)\/launch$/);
    if (launchMatch && method === 'POST') return json({ session_id: 'sess_launched' }, 201);
    const idMatch = u.match(/\/v1\/profiles\/([^/]+)$/);
    if (idMatch && method === 'DELETE') {
      const i = profiles.findIndex((p) => p.id === idMatch[1]);
      if (i >= 0) profiles.splice(i, 1);
      return new Response(null, { status: 204 });
    }
    if (/\/v1\/profiles$/.test(u) && method === 'POST') {
      const body = JSON.parse(String(call.init?.body || '{}'));
      const created = makeProfile({ id: 'prof_created', name: body.name });
      profiles.push(created);
      return json({ id: created.id, name: created.name }, 201);
    }
    if (/\/v1\/profiles$/.test(u) && method === 'GET') return json({ data: profiles });
    // eslint-disable-next-line no-console
    console.warn('[profiles-page test] unrouted fetch:', method, u);
    return json({}, 500);
  };
}

describe('profiles page — local integration', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });
  const loadBuiltPage = (): string => readFileSync(BUILT_PAGE, 'utf8');

  it('empty list: shows the empty state, hides the list', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter([]),
    });
    win = window;
    await flush();
    expect(fetchCalls.some((c) => /\/v1\/profiles$/.test(c.url))).toBe(true);
    expect(isHidden(window, '[data-empty]')).toBe(false);
    expect(isHidden(window, '[data-list]')).toBe(true);
  });

  it('non-empty: renders the profile with the archetype display label + action buttons', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter([makeProfile({ id: 'prof_a', name: 'Checkout profile' })]),
    });
    win = window;
    await flush();
    expect(rowCount(window)).toBe(1);
    const text = window.document.querySelector('[data-list]')?.textContent ?? '';
    expect(text).toContain('Checkout profile');
    // archetypeLabel() maps the locked slug to the human display string.
    expect(text).toContain('iPhone 16 Pro / iOS 18.7 / Safari 26.4');
    expect(window.document.querySelector('[data-launch="prof_a"]')).toBeTruthy();
    expect(window.document.querySelector('[data-clone="prof_a"]')).toBeTruthy();
    expect(window.document.querySelector('[data-delete="prof_a"]')).toBeTruthy();
  });

  it('create: POSTs {name} and the new profile appears after refresh', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter([]),
    });
    win = window;
    await flush();
    // Submit the (hidden) create form directly — avoids the proxy-picker
    // hydrate that showCreate() triggers; the submit handler doesn't
    // require the form to be visible.
    const form = window.document.querySelector('[data-create-form]') as HTMLFormElement;
    (form.querySelector('input[name="name"]') as HTMLInputElement).value = 'Fresh profile';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    const post = fetchCalls.find((c) => c.init?.method === 'POST' && /\/v1\/profiles$/.test(c.url));
    expect(post).toBeTruthy();
    expect(JSON.parse(String(post?.init?.body)).name).toBe('Fresh profile');
    expect(rowCount(window)).toBe(1);
    expect(window.document.querySelector('[data-list]')?.textContent).toContain('Fresh profile');
  });

  it('clone: confirm-gated POST /:id/clone adds the copy after refresh', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      confirmReturns: true,
      route: makeRouter([makeProfile({ id: 'prof_a', name: 'Base' })]),
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-clone="prof_a"]') as HTMLButtonElement).click();
    await flush();
    const post = fetchCalls.find((c) => /\/v1\/profiles\/prof_a\/clone$/.test(c.url));
    expect(post?.init?.method).toBe('POST');
    expect(rowCount(window)).toBe(2);
    expect(window.document.querySelector('[data-list]')?.textContent).toContain('Base (copy)');
  });

  it('delete: confirm-gated DELETE then refresh removes the row', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      confirmReturns: true,
      route: makeRouter([makeProfile({ id: 'prof_a', name: 'Doomed' })]),
    });
    win = window;
    await flush();
    expect(rowCount(window)).toBe(1);
    (window.document.querySelector('[data-delete="prof_a"]') as HTMLButtonElement).click();
    await flush();
    const del = fetchCalls.find((c) => c.init?.method === 'DELETE');
    expect(del?.url).toMatch(/\/v1\/profiles\/prof_a$/);
    expect(isHidden(window, '[data-empty]')).toBe(false);
    expect(isHidden(window, '[data-list]')).toBe(true);
  });

  it('delete cancelled at confirm: no DELETE fired, row stays', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      confirmReturns: false,
      route: makeRouter([makeProfile({ id: 'prof_a', name: 'Keep me' })]),
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-delete="prof_a"]') as HTMLButtonElement).click();
    await flush();
    expect(fetchCalls.some((c) => c.init?.method === 'DELETE')).toBe(false);
    expect(rowCount(window)).toBe(1);
  });

  it('search: filters rendered rows by name; shows no-matches then restores on clear', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      route: makeRouter([
        makeProfile({ id: 'prof_a', name: 'Checkout flow' }),
        makeProfile({ id: 'prof_b', name: 'Login state' }),
      ]),
    });
    win = window;
    await flush();
    expect(rowCount(window)).toBe(2);
    const search = window.document.querySelector('[data-profiles-search]') as HTMLInputElement;
    expect(search).toBeTruthy();

    // Term matching only one profile hides the other.
    search.value = 'checkout';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    const rows = Array.from(
      window.document.querySelectorAll('[data-list] > li[data-profile-search]'),
    );
    const visible = rows.filter((li) => !li.classList.contains('hidden'));
    expect(visible.length).toBe(1);
    expect(visible[0]?.textContent).toContain('Checkout flow');

    // Term matching nothing → the no-matches state, list hidden.
    search.value = 'zzz-no-such-profile';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(isHidden(window, '[data-no-matches]')).toBe(false);
    expect(isHidden(window, '[data-list]')).toBe(true);

    // Clearing restores every row.
    search.value = '';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(isHidden(window, '[data-no-matches]')).toBe(true);
    expect(isHidden(window, '[data-list]')).toBe(false);
    expect(
      Array.from(window.document.querySelectorAll('[data-list] > li[data-profile-search]')).filter(
        (li) => !li.classList.contains('hidden'),
      ).length,
    ).toBe(2);
  });
});
