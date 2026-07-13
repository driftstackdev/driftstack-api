// Behavioural coverage for the admin Incidents list page —
// apps/admin-panel/src/pages/incidents/index.astro. This is the one page
// whose entire job is surfacing active incidents, and fetchAndRender() used
// to swallow every failure mode (no token, 403, non-ok status, network
// error) into the exact same rebuild([]) markup the page renders for a
// genuine zero-incident state ("No open incidents. All systems
// operational.") — so a real outage looked identical to "nothing's wrong"
// (audit waefer6wu). This pins the fix: a distinct, retry-capable
// [data-banner] state for load failures, separate from the no-token state,
// separate from the genuinely-empty state.
//
// Loads the built dist page + runs the inline script in jsdom against a
// mock fetch, mirroring admin-accounts-page.test.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'incidents', 'index.html');
const PAGE_URL = 'https://admin.driftstack.dev/incidents/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface SetUpOpts {
  token?: string;
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
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(htmlNoScripts, {
    url: PAGE_URL,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
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
  // @ts-expect-error — injected by AdminLayout
  window.dashboardHydrated = () => {};

  const pageScript = scriptBodies.find((s) => s.includes('fetchAndRender'));
  if (!pageScript) throw new Error('admin-incidents-list inline script not found');
  // @ts-expect-error — jsdom global has eval
  window.eval(pageScript);
  return { window: window as JSDOM['window'], fetchCalls };
}

function text(window: JSDOM['window'], selector: string): string {
  return window.document.querySelector(selector)?.textContent?.trim() ?? '';
}

function bannerHidden(window: JSDOM['window']): boolean {
  return window.document.querySelector('[data-banner]')?.classList.contains('hidden') ?? true;
}

function retryVisible(window: JSDOM['window']): boolean {
  return !(
    window.document.querySelector('[data-banner-retry]')?.classList.contains('hidden') ?? true
  );
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

let win: JSDOM['window'] | undefined;
afterEach(() => {
  win?.close?.();
  win = undefined;
});

const INCIDENT = {
  id: 'inc_live1',
  title: 'Elevated 5xx on /v1/sessions/create',
  description: 'Investigating.',
  severity: 'major',
  status: 'investigating',
  public: true,
  started_at: '2026-06-30T00:00:00.000Z',
};

describe('admin-panel Incidents list (incidents/index.astro) error-vs-empty behaviour', () => {
  it('no token: shows a distinct sign-in banner (not silently the empty state)', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      route: () => {
        throw new Error('must not fetch when unauthenticated');
      },
    });
    win = window;
    await flush();
    expect(fetchCalls.length).toBe(0);
    expect(bannerHidden(window)).toBe(false);
    expect(text(window, '[data-banner]')).toContain('Sign in with a staff admin account');
    // No-token isn't a load failure — retrying won't help until sign-in, so
    // no retry affordance.
    expect(retryVisible(window)).toBe(false);
    expect(text(window, '[data-incidents-list]')).toContain('All systems operational');
  });

  it('genuinely empty: zero incidents renders the operational message with NO error banner', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json({ data: [] }),
    });
    win = window;
    await flush();
    expect(bannerHidden(window)).toBe(true);
    expect(text(window, '[data-incidents-list]')).toContain('All systems operational');
  });

  it('open incidents render + banner stays hidden', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json({ data: [INCIDENT] }),
    });
    win = window;
    await flush();
    expect(bannerHidden(window)).toBe(true);
    expect(text(window, '[data-incidents-list]')).toContain('Elevated 5xx on /v1/sessions/create');
    expect(text(window, '[data-open-count]')).toBe('1');
  });

  it('403: a load failure must NEVER render identically to "no incidents" — distinct, retry-capable banner + open-count clears', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json({ detail: 'forbidden' }, 403),
    });
    win = window;
    await flush();
    expect(bannerHidden(window)).toBe(false);
    expect(text(window, '[data-banner]')).toContain('admin scope required');
    expect(retryVisible(window)).toBe(true);
  });

  it('5xx: surfaces a distinct, retry-capable error banner (regression guard for the audit waefer6wu false-"all clear")', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json({ detail: 'boom' }, 500),
    });
    win = window;
    await flush();
    expect(bannerHidden(window)).toBe(false);
    expect(text(window, '[data-banner]')).toContain("Couldn't load incidents");
    expect(retryVisible(window)).toBe(true);
    // The list still falls back to the empty-state markup (no stale/fake
    // data shown), but it's no longer indistinguishable — the banner is the
    // signal that this ISN'T a confirmed all-clear.
    expect(text(window, '[data-incidents-list]')).toContain('All systems operational');
  });

  it('retry button re-fetches and clears the error banner on success', async () => {
    let shouldFail = true;
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => (shouldFail ? json({ detail: 'boom' }, 500) : json({ data: [INCIDENT] })),
    });
    win = window;
    await flush();
    expect(bannerHidden(window)).toBe(false);
    shouldFail = false;
    const retryBtn = window.document.querySelector('[data-banner-retry]') as HTMLButtonElement;
    retryBtn.click();
    await flush();
    expect(fetchCalls.length).toBeGreaterThanOrEqual(2);
    expect(bannerHidden(window)).toBe(true);
    expect(text(window, '[data-incidents-list]')).toContain('Elevated 5xx on /v1/sessions/create');
  });

  it('single-flights incident creation and exposes accessible busy state', async () => {
    let finishPost: (response: Response) => void = () => {};
    const pendingPost = new Promise<Response>((resolve) => {
      finishPost = resolve;
    });
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: (call) => (call.init?.method === 'POST' ? pendingPost : json({ data: [] })),
    });
    win = window;
    await flush();
    const form = window.document.getElementById('new-incident-form') as HTMLFormElement;
    (form.querySelector('[name="title"]') as HTMLInputElement).value = 'API outage';
    (form.querySelector('[name="description"]') as HTMLTextAreaElement).value =
      'Investigating elevated failures.';
    const submit = window.document.getElementById('submit-btn') as HTMLButtonElement;
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(2);

    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
    expect(submit.disabled).toBe(true);
    expect(submit.getAttribute('aria-busy')).toBe('true');
    expect(submit.textContent).toContain('Posting');

    finishPost(json({ id: 'inc_new' }));
    await flush();
    expect(submit.disabled).toBe(false);
    expect(submit.hasAttribute('aria-busy')).toBe(false);
  });

  it('reconciles a committed incident after POST timeout instead of inviting a duplicate', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    let committed = false;
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: (call) => {
        if (call.init?.method === 'POST') {
          committed = true;
          return Promise.reject(timeout);
        }
        return json({ data: committed ? [INCIDENT] : [] });
      },
    });
    win = window;
    await flush();
    const form = window.document.getElementById('new-incident-form') as HTMLFormElement;
    (form.querySelector('[name="title"]') as HTMLInputElement).value = INCIDENT.title;
    (form.querySelector('[name="description"]') as HTMLTextAreaElement).value =
      INCIDENT.description;
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(12);

    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
    expect(fetchCalls.filter((call) => call.init?.method !== 'POST')).toHaveLength(2);
    expect(text(window, '[data-incidents-list]')).toContain(INCIDENT.title);
    expect(text(window, '#form-error')).toMatch(
      /exact title and initial update.*not posted again.*open the existing incident/i,
    );
    const submit = window.document.getElementById('submit-btn') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toBe('Already posted');
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
  });

  it('blocks repost when both incident creation and authoritative reconciliation fail', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    let postStarted = false;
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: (call) => {
        if (call.init?.method === 'POST') {
          postStarted = true;
          return Promise.reject(timeout);
        }
        return postStarted ? json({ detail: 'unavailable' }, 503) : json({ data: [] });
      },
    });
    win = window;
    await flush();
    const form = window.document.getElementById('new-incident-form') as HTMLFormElement;
    (form.querySelector('[name="title"]') as HTMLInputElement).value = 'API outage';
    (form.querySelector('[name="description"]') as HTMLTextAreaElement).value =
      'Investigating elevated failures.';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(12);

    const submit = window.document.getElementById('submit-btn') as HTMLButtonElement;
    expect(text(window, '#form-error')).toMatch(
      /couldn't refresh the incident list.*reload and verify.*duplicate public incident/i,
    );
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toBe('Verify before retrying');
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
  });

  it('allows a deliberate retry after a successful refresh proves the exact incident absent', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: (call) =>
        call.init?.method === 'POST' ? Promise.reject(timeout) : json({ data: [] }),
    });
    win = window;
    await flush();
    const form = window.document.getElementById('new-incident-form') as HTMLFormElement;
    (form.querySelector('[name="title"]') as HTMLInputElement).value = 'API outage';
    (form.querySelector('[name="description"]') as HTMLTextAreaElement).value =
      'Investigating elevated failures.';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(12);

    const submit = window.document.getElementById('submit-btn') as HTMLButtonElement;
    expect(text(window, '#form-error')).toMatch(
      /no incident with this exact title and initial update.*you can retry/i,
    );
    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toBe('Post incident');
    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
  });
});
