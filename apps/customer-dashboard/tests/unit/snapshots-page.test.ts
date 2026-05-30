// Local integration test for the /snapshots page's inline script
// (V-375 + V-470). Loads the BUILT page, strips the inline scripts,
// executes the snapshots page script inside jsdom with a mocked
// localStorage + fetch, and asserts the hydrated DOM across the real
// branches: list render (label + "From <parent> · captured" + the
// parent-deleted indicator), the V-470 inline RESTORE form (reveal,
// default-name prefill, name-required validation, POST body shape,
// success banner, inline error surfacing), and the confirm-gated
// DELETE.
//
// Mirrors recipes-page.test.ts / cli-authorize.test.ts. The page
// fetches on LOAD, so the fetch plan is seeded BEFORE the script is
// eval'd. The restore/delete fetches are appended to the same plan and
// consumed in order as the scripted interactions fire.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'snapshots', 'index.html');
const PAGE_URL = 'https://app.driftstack.dev/snapshots/';

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
      console.warn('[snapshots-page test] unplanned fetch:', call.url);
      return Promise.resolve(new Response('{}', { status: 500 }));
    }
    return Promise.resolve(handler(call));
  };
  if (opts.token !== undefined) window.localStorage.setItem('ds_web_session_token', opts.token);
  const __cr = opts.confirmReturns ?? true;
  // @ts-expect-error — driftstackConfirm is injected by DashboardLayout (not eval'd here)
  window.driftstackConfirm = () => Promise.resolve(__cr);
  window.confirm = () => __cr;
  // jsdom doesn't implement scrollIntoView; the restore form calls it
  // when revealed. No-op it so the click handler doesn't throw.
  window.HTMLElement.prototype.scrollIntoView = () => {};

  const pageScript = scriptBodies.find((s) => s.includes('data-page="snapshots"'));
  if (!pageScript) throw new Error('snapshots inline script not found');
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

// Node global Response: the fetch plan is seeded before the jsdom
// `window` const exists (the page fetches on load), so plan closures
// can't reference it. .ok / .status / .json() work across realms.
function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

const SNAP_A = {
  id: 'snp_aaaa',
  label: 'Checkout profile snap',
  description: 'frozen example.com checkout profile',
  parent_name: 'Checkout profile',
  parent_profile_id: 'prof_1',
  captured_at: '2026-05-20T10:00:00.000Z',
};
const SNAP_B = {
  id: 'snp_bbbb',
  label: 'Orphaned snap',
  description: null,
  parent_name: 'Deleted profile',
  parent_profile_id: null, // parent profile deleted
  captured_at: '2026-05-19T10:00:00.000Z',
};

describe('snapshots page — local integration', () => {
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
    expect(fetchCalls[0]?.url).toMatch(/\/v1\/profile-snapshots$/);
    expect(isHidden(window, '[data-empty]')).toBe(false);
    expect(isHidden(window, '[data-list]')).toBe(true);
  });

  it('non-empty: renders rows + parent-deleted indicator for null parent_profile_id', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [() => json({ data: [SNAP_A, SNAP_B] })],
    });
    win = window;
    await flush();
    expect(isHidden(window, '[data-list]')).toBe(false);
    expect(isHidden(window, '[data-empty]')).toBe(true);
    expect(rowCount(window)).toBe(2);
    const text = window.document.querySelector('[data-list]')?.textContent ?? '';
    expect(text).toContain('Checkout profile snap');
    expect(text).toContain('From Checkout profile');
    // SNAP_B's source profile was deleted → explicit indicator.
    expect(text).toContain('(parent profile deleted)');
  });

  it('restore: reveals the inline form with the default "<parent> (restored)" name, POSTs {name}, banners success', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [
        () => json({ data: [SNAP_A] }),
        // restore POST → 200 with the new profile name.
        () => json({ name: 'Checkout profile (restored)' }, 200),
        // refresh after restore.
        () => json({ data: [SNAP_A] }),
      ],
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-restore]') as HTMLButtonElement).click();
    expect(isHidden(window, '[data-restore-form-wrap]')).toBe(false);
    const nameInput = window.document.querySelector(
      '[data-restore-name-input]',
    ) as HTMLInputElement;
    expect(nameInput.value).toBe('Checkout profile (restored)');
    (window.document.querySelector('[data-restore-form]') as HTMLFormElement).dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true }),
    );
    await flush(6);
    const post = fetchCalls.find((c) => /\/restore$/.test(c.url));
    expect(post?.url).toMatch(/\/v1\/profile-snapshots\/snp_aaaa\/restore$/);
    expect(post?.init?.method).toBe('POST');
    expect(JSON.parse(String(post?.init?.body))).toEqual({ name: 'Checkout profile (restored)' });
    const banner = window.document.querySelector('[data-banner]')?.textContent ?? '';
    expect(banner).toMatch(/Restored to new profile: Checkout profile \(restored\)/);
  });

  it('restore validation: empty name shows "Name is required." inline, fires no fetch', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [() => json({ data: [SNAP_A] })],
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-restore]') as HTMLButtonElement).click();
    const nameInput = window.document.querySelector(
      '[data-restore-name-input]',
    ) as HTMLInputElement;
    nameInput.value = '   ';
    (window.document.querySelector('[data-restore-form]') as HTMLFormElement).dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true }),
    );
    await flush();
    const err = window.document.querySelector('[data-restore-error]');
    expect(err?.classList.contains('hidden')).toBe(false);
    expect(err?.textContent).toMatch(/Name is required\./);
    // Only the initial load fetch — no restore POST.
    expect(fetchCalls.length).toBe(1);
  });

  it('restore error: 409 surfaces the server detail inline (not the page banner)', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [
        () => json({ data: [SNAP_A] }),
        () => json({ title: 'Conflict', detail: 'A profile with that name already exists.' }, 409),
      ],
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-restore]') as HTMLButtonElement).click();
    (window.document.querySelector('[data-restore-form]') as HTMLFormElement).dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true }),
    );
    await flush(6);
    const err = window.document.querySelector('[data-restore-error]');
    expect(err?.classList.contains('hidden')).toBe(false);
    expect(err?.textContent).toMatch(/A profile with that name already exists\./);
  });

  it('delete: confirm-gated DELETE then refresh (204 → empty)', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      confirmReturns: true,
      fetchPlan: [
        () => json({ data: [SNAP_A] }),
        () => new Response(null, { status: 204 }),
        () => json({ data: [] }),
      ],
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-delete]') as HTMLButtonElement).click();
    await flush(6);
    const del = fetchCalls.find((c) => c.init?.method === 'DELETE');
    expect(del?.url).toMatch(/\/v1\/profile-snapshots\/snp_aaaa$/);
    expect(isHidden(window, '[data-empty]')).toBe(false);
    expect(isHidden(window, '[data-list]')).toBe(true);
  });

  it('delete cancelled at confirm: no DELETE fetch fired', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      confirmReturns: false,
      fetchPlan: [() => json({ data: [SNAP_A] })],
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-delete]') as HTMLButtonElement).click();
    await flush();
    expect(fetchCalls.some((c) => c.init?.method === 'DELETE')).toBe(false);
    expect(rowCount(window)).toBe(1);
  });

  it('search: filters rendered rows by label; shows no-matches then restores on clear', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [() => json({ data: [SNAP_A, SNAP_B] })],
    });
    win = window;
    await flush();
    expect(rowCount(window)).toBe(2);
    const search = window.document.querySelector('[data-snapshots-search]') as HTMLInputElement;
    expect(search).toBeTruthy();

    // 'checkout' matches SNAP_A only.
    search.value = 'checkout';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    const visible = Array.from(
      window.document.querySelectorAll('[data-list] > li[data-snapshot-search]'),
    ).filter((li) => !li.classList.contains('hidden'));
    expect(visible.length).toBe(1);
    expect(visible[0]?.textContent).toContain('Checkout profile snap');

    // No match → no-matches state, list hidden.
    search.value = 'zzz-no-such-snapshot';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(isHidden(window, '[data-no-matches]')).toBe(false);
    expect(isHidden(window, '[data-list]')).toBe(true);

    // Clear restores both.
    search.value = '';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(isHidden(window, '[data-no-matches]')).toBe(true);
    expect(isHidden(window, '[data-list]')).toBe(false);
  });

  it('"/" focuses the search when snapshots exist (matches the admin accounts convention)', async () => {
    const { window } = setUpDom(loadBuiltPage(), {
      token: 'tok',
      fetchPlan: [() => json({ data: [SNAP_A, SNAP_B] })],
    });
    win = window;
    await flush();
    const search = window.document.querySelector('[data-snapshots-search]') as HTMLInputElement;
    expect(search).toBeTruthy();
    expect(window.document.activeElement).not.toBe(search);
    const ev = new window.KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
    window.document.body.dispatchEvent(ev);
    expect(window.document.activeElement).toBe(search);
    expect(ev.defaultPrevented).toBe(true);
  });
});
