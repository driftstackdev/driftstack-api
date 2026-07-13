// W629 — behavioral test for the admin /fleet page's inline script.
// Loads the built dist page, mocks localStorage + fetch, and asserts:
//   - it fetches GET /v1/mac-nodes with bearer auth;
//   - it renders a connected/offline + LiveKit badge per node;
//   - on a load failure it shows an honest error (NO fabricated rows —
//     W604 discipline);
//   - on an empty fleet it tells the operator how to start a worker.
// Admin pages are prerendered, so the built dist HTML is loadable.
// Mirrors admin-sessions-page.test.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installAdminDeadline } from './admin-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'fleet', 'index.html');
const PAGE_URL = 'https://admin.driftstack.dev/fleet/';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}
interface SetUpOpts {
  route: (call: MockFetchCall) => Response | Promise<Response>;
  noToken?: boolean;
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
    return Promise.resolve().then(() => opts.route(call));
  };
  if (opts.noToken !== true) window.localStorage.setItem('ds_web_session_token', 'staff-tok');
  installAdminDeadline(window);

  const pageScript = scriptBodies.find((s) => s.includes('data-page="admin-fleet"'));
  if (!pageScript) throw new Error('admin fleet inline script not found');
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

describe('admin fleet page — operator visibility', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });
  const loadBuiltPage = (): string => readFileSync(BUILT_PAGE, 'utf8');

  it('fetches GET /v1/mac-nodes with bearer auth and renders connected + LiveKit state per node', async () => {
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: () =>
        json({
          data: [
            {
              id: 'node-1',
              display_name: 'mac-001',
              region: 'eu',
              hardware_class: 'mac-mini-m2',
              registered_at: '2026-06-11T10:00:00Z',
              last_seen_at: '2026-06-11T12:00:00Z',
              has_livekit: true,
              connected: true,
            },
            {
              id: 'node-2',
              display_name: 'mac-002',
              region: 'us',
              hardware_class: 'mac-mini-m2',
              registered_at: '2026-06-11T09:00:00Z',
              last_seen_at: null,
              has_livekit: false,
              connected: false,
            },
          ],
        }),
    });
    win = window;
    await flush();
    const get = fetchCalls.find((c) => /\/v1\/mac-nodes$/.test(c.url));
    expect(get).toBeTruthy();
    expect(String((get?.init?.headers as Record<string, string>)?.authorization)).toContain(
      'Bearer staff-tok',
    );
    expect(get?.init?.signal).toBeTruthy();
    const text = window.document.body.textContent ?? '';
    expect(text).toContain('mac-001');
    expect(text).toContain('connected');
    expect(text).toContain('offline');
    // footnote summarises connected count
    expect(text).toContain('2 nodes registered');
    expect(text).toContain('1 connected');
  });

  it('empty fleet → tells the operator to start a worker (no fabricated rows)', async () => {
    const { window } = setUpDom(loadBuiltPage(), { route: () => json({ data: [] }) });
    win = window;
    await flush();
    const text = window.document.body.textContent ?? '';
    expect(text).toContain('No fleet nodes registered yet');
    expect(text).toContain('DRIFTSTACK_ENABLE_DRIVE_BRIDGE=1');
  });

  it('W604: a failed load shows an honest error, NOT fabricated rows', async () => {
    const { window } = setUpDom(loadBuiltPage(), { route: () => json({ detail: 'boom' }, 500) });
    win = window;
    await flush();
    const text = window.document.body.textContent ?? '';
    expect(text).toContain('Could not load fleet nodes');
    // No node rows leaked in.
    expect(text).not.toContain('mac-001');
  });

  it('W630 auto-refresh: the inline script arms a 15s poll so connected state updates live during worker bring-up', async () => {
    const html = loadBuiltPage();
    expect(html).toContain('setInterval');
    expect(html).toContain('15000');
  });

  it('bounds fleet reads/controls, rejects stale polls, and defers fresh-SSO loading', () => {
    const html = loadBuiltPage();
    expect(html).toContain('FLEET_REQUEST_TIMEOUT_MS = 15_000');
    expect(html).toContain('Request timed out. Try again.');
    expect(html).toMatch(/if \(loadController\) loadController\.abort\(\)/);
    expect(html).toMatch(/const generation = \+\+loadGeneration/);
    expect(html).toMatch(/if \(generation !== loadGeneration\) return/);
    expect(html).toMatch(
      /document\.addEventListener\('DOMContentLoaded', start, \{ once: true \}\)/,
    );
  });

  it('locks an affected node after an unknown control outcome and blocks a blind replay', async () => {
    let getCount = 0;
    const { window, fetchCalls } = setUpDom(loadBuiltPage(), {
      route: (call) => {
        if (call.init?.method === 'POST') {
          const timeout = new Error('request timed out');
          timeout.name = 'AbortError';
          return Promise.reject(timeout);
        }
        getCount += 1;
        return json({
          data: [
            {
              id: 'node-1',
              display_name: 'mac-001',
              region: 'us',
              last_seen_at: '2026-06-11T12:00:00Z',
              has_livekit: true,
              connected: true,
              last_heartbeat: getCount > 1 ? { drainState: 'draining' } : null,
            },
          ],
        });
      },
    });
    win = window;
    // @ts-expect-error — app modal helper is attached by AdminLayout at runtime
    window.driftstackConfirm = () => Promise.resolve(true);
    await flush();

    const restart = window.document.querySelector<HTMLButtonElement>(
      'button[data-control="restart"]',
    );
    expect(restart).not.toBeNull();
    restart!.click();
    await flush(12);
    // Even a queued/synthetic second activation of the original button must
    // not dispatch another destructive command after the timeout.
    restart!.click();
    await flush();

    expect(fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
    expect(window.document.querySelectorAll('button[data-control]')).toHaveLength(0);
    const text = window.document.body.textContent ?? '';
    expect(text).toContain('Restart outcome is unknown because the response timed out');
    expect(text).toContain('Outcome unknown — verify, then reload');
    expect(text).toContain('Controls for this node are locked for this page');
    expect(text).toContain('do not send the command again blindly');
  });

  it('403 → access-denied banner (customer account, not staff admin)', async () => {
    const { window } = setUpDom(loadBuiltPage(), { route: () => json({ detail: 'no' }, 403) });
    win = window;
    await flush();
    const text = window.document.body.textContent ?? '';
    expect(text).toContain('staff admin scope required');
  });
});
