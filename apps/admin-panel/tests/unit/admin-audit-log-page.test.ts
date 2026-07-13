// Behavioural coverage for the admin Audit Log page —
// apps/admin-panel/src/pages/audit-log.astro. The operator's view of staff
// admin actions across all accounts (actor → action, target, result, time).
// Covers auth-gate, row rendering (admin_account_id / target / resource /
// action / result badge / UTC timestamp), the empty state, the 403 admin-scope
// message, and the CLIENT-SIDE result filter.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installAdminDeadline } from './admin-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'audit-log', 'index.html');
const PAGE_URL = 'https://admin.driftstack.dev/audit-log/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface SetUpOpts {
  token?: string;
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
  installAdminDeadline(window);

  const pageScript = scriptBodies.find((s) => s.includes('data-page="admin-audit-log"'));
  if (!pageScript) throw new Error('admin-audit-log inline script not found');
  // @ts-expect-error — jsdom global has eval
  window.eval(pageScript);
  return { window: window as JSDOM['window'], fetchCalls };
}

function text(window: JSDOM['window'], selector: string): string {
  return window.document.querySelector(selector)?.textContent?.trim() ?? '';
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

const SUCCESS_ENTRY = {
  admin_account_id: 'acc_adm1',
  target_account_id: 'acc_t1',
  target_resource_id: 'prof_x9',
  timestamp: '2026-05-20T10:00:00.000Z',
  action: 'profile.force_delete',
  result: 'success',
};
// Failures are audited as `error: <code>` by every admin route's catch block
// (NOT a bare 'error'), and the result <select> offers value="error". The
// client filter must therefore PREFIX-match — using a realistic value here is
// what exercises the bug (an exact === 'error' filter would never match this).
const ERROR_ENTRY = {
  admin_account_id: 'acc_adm2',
  timestamp: '2026-05-21T08:30:00.000Z',
  action: 'account.suspend',
  result: 'error: forbidden',
};

let win: JSDOM['window'] | undefined;
afterEach(() => {
  win?.close?.();
  win = undefined;
});

describe('admin-panel Audit Log (audit-log.astro) behaviour', () => {
  it('no session token: shows the staff-admin banner and makes no API call', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      route: () => {
        throw new Error('must not fetch when unauthenticated');
      },
    });
    win = window;
    await flush();
    expect(fetchCalls.length).toBe(0);
    expect(text(window, '[data-banner]')).toContain('Sign in with a staff admin account');
  });

  it('renders a row with actor, action, target, result badge, and UTC timestamp', async () => {
    const { window, fetchCalls } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json({ data: [SUCCESS_ENTRY] }),
    });
    win = window;
    await flush();
    const list = text(window, '[data-list="audit"]');
    expect(list).toContain('acc_adm1');
    expect(list).toContain('profile.force_delete');
    expect(list).toContain('success');
    expect(list).toContain('acc_t1');
    expect(list).toContain('prof_x9');
    expect(list).toContain('2026-05-20 10:00:00 UTC');
    expect(fetchCalls[0]?.init?.signal).toBeTruthy();
  });

  it('bounds and aborts superseded reads, defers fresh-SSO start, and pins timeout recovery', () => {
    const built = readFileSync(BUILT_PAGE, 'utf8');
    expect(built).toContain('AUDIT_REQUEST_TIMEOUT_MS = 15_000');
    expect(built).toContain('Request timed out. Try again.');
    expect(built).toMatch(/if \(loadController\) loadController\.abort\(\)/);
    expect(built).toMatch(
      /document\.addEventListener\('DOMContentLoaded', start, \{ once: true \}\)/,
    );
  });

  it('empty result: shows the no-entries message', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json({ data: [] }),
    });
    win = window;
    await flush();
    expect(text(window, '[data-list="audit"]')).toContain(
      'No audit entries match the current filter',
    );
  });

  it('403: surfaces the admin-scope-required message', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json({ detail: 'forbidden' }, 403),
    });
    win = window;
    await flush();
    expect(text(window, '[data-banner]')).toContain('admin scope required');
  });

  it('manual live refresh stays red after a handled load failure', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json({ detail: 'boom' }, 500),
    });
    win = window;
    await flush();
    (window.document.querySelector('[data-live-refresh]') as HTMLButtonElement).click();
    await flush();
    expect(window.document.querySelector('[data-live-dot]')?.className).toContain('bg-red-500');
  });

  it('client-side result filter: selecting "error" hides the success rows', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), {
      token: 'tok',
      route: () => json({ data: [SUCCESS_ENTRY, ERROR_ENTRY] }),
    });
    win = window;
    await flush();
    // Both rows present initially.
    expect(text(window, '[data-list="audit"]')).toContain('profile.force_delete');
    expect(text(window, '[data-list="audit"]')).toContain('account.suspend');
    // Filter to errors only (the result filter is applied client-side after fetch).
    const resultEl = window.document.querySelector('[data-field="result"]') as HTMLSelectElement;
    resultEl.value = 'error';
    resultEl.dispatchEvent(new window.Event('change', { bubbles: true }));
    // change handler debounces 200ms before reloading.
    await new Promise((r) => setTimeout(r, 260));
    await flush();
    const list = text(window, '[data-list="audit"]');
    expect(list).toContain('account.suspend'); // the error row stays
    expect(list).not.toContain('profile.force_delete'); // success row filtered out
  });
});
