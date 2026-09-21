// The Fleet page's declared-vs-measured build columns (A3 2026-09-19).
//
// The page has shown `harnessVersion` since W2189. A3 then observed that value
// naming a commit the running binary was not built from, and `webkitForkBuild`
// naming a checkout 20 commits behind the real build — so what this page rendered
// with complete confidence was, on at least two occasions, wrong. The measured
// digests are what make that visible, and these arms are about the page saying so
// rather than quietly continuing to show only the declared string.
//
// ⛔ THE PAGE RENDERS THE SERVER'S VERDICT; IT DOES NOT COMPUTE ONE. Whether two
// devices contradict each other is decided once, in `fleet-build-drift.ts`. What
// is asserted here is that the verdict ARRIVES intact, that "not reported" and
// "unreadable" stay distinguishable on screen, and that a failure never leaves a
// clean-looking drift report behind.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installAdminDeadline } from './admin-test-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'fleet', 'index.html');
const PAGE_URL = 'https://admin.driftstack.io/fleet/';

const NODE_ONE_ID = '11111111-1111-4111-8111-111111111111';
const NODE_TWO_ID = '22222222-2222-4222-8222-222222222222';
const A = 'aaaaaaaaaaaa';
const B = 'bbbbbbbbbbbb';
const C = 'cccccccccccc';

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

function setUpDom(
  html: string,
  route: (call: MockFetchCall) => Response,
): { window: JSDOM['window'] } {
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
  // @ts-expect-error — jsdom global is loose
  if (typeof window.Response !== 'function') window.Response = Response;
  // @ts-expect-error — jsdom global is loose
  window.fetch = (input: string, init: RequestInit | undefined) =>
    Promise.resolve().then(() => route({ url: String(input), init }));
  window.localStorage.setItem('ds_web_session_token', 'staff-tok');
  installAdminDeadline(window);
  const pageScript = scriptBodies.find((s) => s.includes('data-page="admin-fleet"'));
  if (!pageScript) throw new Error('admin fleet inline script not found');
  // @ts-expect-error — jsdom global has eval
  window.eval(pageScript);
  return { window: window as JSDOM['window'] };
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fleetNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: NODE_ONE_ID,
    display_name: 'mac-001',
    region: 'us',
    hardware_class: 'mac-mini-m2',
    registered_at: '2026-09-19T10:00:00Z',
    last_seen_at: '2026-09-19T19:10:00Z',
    has_livekit: true,
    connected: true,
    last_heartbeat: {
      beatAt: '2026-09-19T19:10:00Z',
      cpuPercent: 5,
      memoryPercent: 10,
      activeSessionCount: 0,
      harnessVersion: '88d2d0da2',
    },
    ...overrides,
  };
}

function driftDevice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deviceId: NODE_ONE_ID,
    declaredHarnessVersion: '88d2d0da2',
    declaredWebkitForkBuild: '4410edcd9',
    harnessBinary: { state: 'measured', sha256: A },
    frameworks: {
      state: 'measured',
      parts: {
        wc: { state: 'measured', sha256: A },
        wk: { state: 'measured', sha256: B },
        jsc: { state: 'measured', sha256: C },
      },
    },
    flags: [],
    ...overrides,
  };
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('admin fleet page — declared vs measured build identity', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });
  const loadBuiltPage = (): string => readFileSync(BUILT_PAGE, 'utf8');

  it('CRITICAL renders the measured binary and per-framework digests beside the declared values', async () => {
    const { window } = setUpDom(loadBuiltPage(), () =>
      json({
        data: [fleetNode()],
        build_drift: { devices: [driftDevice()], findings: [] },
      }),
    );
    win = window;
    await flush();
    const text = window.document.body.textContent ?? '';
    // Declared, as before.
    expect(text).toContain('88d2d0da2');
    expect(text).toContain('4410edcd9');
    // Measured — the half the page could not show before.
    expect(text).toContain(A);
    expect(text).toContain(`wc:${A}`);
    expect(text).toContain(`wk:${B}`);
    expect(text).toContain(`jsc:${C}`);
  });

  it('CRITICAL "not reported" and "unreadable" stay distinguishable on screen', async () => {
    // They are different problems. An operator chasing a device that SENT
    // something wrong must not be sent looking for one that sent nothing.
    const { window } = setUpDom(loadBuiltPage(), () =>
      json({
        data: [fleetNode(), fleetNode({ id: NODE_TWO_ID, display_name: 'mac-002' })],
        build_drift: {
          devices: [
            driftDevice({ harnessBinary: { state: 'absent' }, frameworks: { state: 'absent' } }),
            driftDevice({
              deviceId: NODE_TWO_ID,
              harnessBinary: { state: 'unreadable', raw: 'NOT-A-DIGEST' },
              frameworks: { state: 'unreadable', raw: 'wc:x' },
            }),
          ],
          findings: [],
        },
      }),
    );
    win = window;
    await flush();
    const text = window.document.body.textContent ?? '';
    expect(text).toContain('not reported');
    expect(text).toContain('unreadable');
  });

  it('CRITICAL a drift finding is listed in full, naming WHICH framework moved', async () => {
    const { window } = setUpDom(loadBuiltPage(), () =>
      json({
        data: [fleetNode()],
        build_drift: {
          devices: [driftDevice({ flags: ['webkit_framework_drift'] })],
          findings: [
            {
              code: 'webkit_framework_drift',
              declaredField: 'webkitForkBuild',
              declaredValue: '4410edcd9',
              deviceIds: [NODE_ONE_ID],
              sessionIds: [],
              frameworks: ['jsc'],
              detail:
                '2 devices declare webkitForkBuild 4410edcd9 but their measured frameworks differ: JavaScriptCore (cccccccccccc vs dddddddddddd).',
            },
          ],
        },
      }),
    );
    win = window;
    await flush();
    const text = window.document.body.textContent ?? '';
    expect(text).toContain('Build drift');
    expect(text).toContain('framework drift');
    expect(text).toContain('JavaScriptCore');
  });

  it('CRITICAL an empty findings list reads as CLEAN, and a missing block reads as UNCHECKED', async () => {
    // These are not the same answer and the page must never merge them: an older
    // control plane that does not compute drift has not found a clean fleet.
    const clean = setUpDom(loadBuiltPage(), () =>
      json({ data: [fleetNode()], build_drift: { devices: [driftDevice()], findings: [] } }),
    );
    win = clean.window;
    await flush();
    expect(clean.window.document.body.textContent ?? '').toContain(
      'No device contradicts its own declared build',
    );
    clean.window.close?.();

    const unchecked = setUpDom(loadBuiltPage(), () => json({ data: [fleetNode()] }));
    win = unchecked.window;
    await flush();
    const text = unchecked.window.document.body.textContent ?? '';
    expect(text).toContain('does not report build drift');
    expect(text).toContain('not the same as no drift');
    expect(text, 'an unchecked fleet must not read as a clean one').not.toContain(
      'No device contradicts its own declared build',
    );
  });

  it('CRITICAL a failed load leaves NO drift report on screen', async () => {
    // W604 discipline: stale findings would read as current, and an emptied list
    // would read as a fleet that just came back clean.
    const { window } = setUpDom(loadBuiltPage(), () => json({ error: 'nope' }, 500));
    win = window;
    await flush();
    const section = window.document.querySelector('[data-section="build-drift"]');
    expect(section?.classList.contains('hidden')).toBe(true);
    expect(window.document.querySelector('[data-list="build-drift"]')?.innerHTML).toBe('');
  });

  it('NEGATIVE CONTROL — a malformed drift block fails the load honestly, never half-renders', async () => {
    // A half-read safety report is worse than a visible error: the half that was
    // dropped is the half nobody knows to look for.
    const { window } = setUpDom(loadBuiltPage(), () =>
      json({
        data: [fleetNode()],
        build_drift: { devices: [{ deviceId: NODE_ONE_ID }], findings: [] },
      }),
    );
    win = window;
    await flush();
    const text = window.document.body.textContent ?? '';
    expect(text).toContain('Could not load fleet nodes');
    expect(text).not.toContain(A);
  });

  it('NEGATIVE CONTROL — the rest of the page is untouched by the new columns', async () => {
    const { window } = setUpDom(loadBuiltPage(), () =>
      json({ data: [fleetNode()], build_drift: { devices: [driftDevice()], findings: [] } }),
    );
    win = window;
    await flush();
    const text = window.document.body.textContent ?? '';
    expect(text).toContain('mac-001');
    expect(text).toContain('connected');
    expect(text).toContain('1 node registered');
  });
});

// ── REVIEW FIX (2026-09-20) ─────────────────────────────────────────────
//
// ⛔ EVERY STRING IN THIS PAYLOAD ORIGINATES AT A DEVICE. The declared fork
// build is typed at deploy; the `raw` text inside a finding's detail is whatever
// the node put on the wire when it could not produce a digest. Both reach
// `innerHTML`. The escapes are there and the repo's AST census agrees — but that
// census cannot follow a value through a helper PARAMETER (it says so in its own
// header), and `driftBadges(drift, deviceId, declaredField)` is exactly that
// shape, with the detail landing inside a `title="…"` ATTRIBUTE where a bare `"`
// is enough to break out. So this arm goes through the built page end to end and
// looks at the DOM, not the source.
describe('a hostile device cannot inject markup into the operator page', () => {
  let win: JSDOM['window'] | null = null;
  afterEach(() => {
    win?.close?.();
    win = null;
  });

  const HOSTILE_FORK = '<img src=x onerror="window.__pwned=1">';
  const HOSTILE_RAW = '" onmouseover="window.__pwned=1" x="';

  it('CRITICAL markup in a declared value and in a finding detail renders as TEXT', async () => {
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), () =>
      json({
        data: [fleetNode()],
        build_drift: {
          devices: [
            driftDevice({
              declaredWebkitForkBuild: HOSTILE_FORK,
              harnessBinary: { state: 'unreadable', raw: HOSTILE_RAW },
              flags: ['measured_digest_missing'],
            }),
          ],
          findings: [
            {
              code: 'measured_digest_missing',
              declaredField: 'harnessVersion',
              declaredValue: '88d2d0da2',
              deviceIds: [NODE_ONE_ID],
              sessionIds: [],
              frameworks: [],
              detail: `node sent ${HOSTILE_RAW} and ${HOSTILE_FORK}`,
            },
          ],
        },
      }),
    );
    win = window;
    await flush();

    // Nothing executed, and nothing became an element.
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    // ⛔ SCOPED TO THE FLEET SURFACES, NOT THE DOCUMENT. The layout's own header
    // carries two legitimate <img> logos, so a document-wide count of 0 is a
    // detector whose shape assumption misses its population — it reds on a clean
    // page and would have to be loosened until it proved nothing. What must be
    // empty is the markup BUILT FROM DEVICE DATA.
    const deviceMarkup = '[data-list="fleet"], [data-list="build-drift"]';
    for (const host of window.document.querySelectorAll(deviceMarkup)) {
      expect(host.querySelectorAll('img, script, iframe').length).toBe(0);
      expect(host.querySelectorAll('[onerror], [onmouseover], [onload]').length).toBe(0);
    }
    // The text is still SHOWN — escaping must not have silently dropped it, or
    // an operator loses the one clue about what the device actually sent.
    const text = window.document.body.textContent ?? '';
    expect(text).toContain('onerror');
    // An unreadable digest still reads as the word, never as the raw bytes.
    expect(text).toContain('unreadable');
  });

  it('CRITICAL an over-long detail fails the load honestly rather than half-rendering', async () => {
    // The server bounds `detail` (FLEET_BUILD_DRIFT_DETAIL_MAX_LENGTH). This is
    // the panel's half of that contract: if a detail ever arrives over the bound,
    // the page must say it could not load rather than render a partial report.
    const { window } = setUpDom(readFileSync(BUILT_PAGE, 'utf8'), () =>
      json({
        data: [fleetNode()],
        build_drift: {
          devices: [driftDevice()],
          findings: [
            {
              code: 'harness_binary_drift',
              declaredField: 'harnessVersion',
              declaredValue: 'v9',
              deviceIds: [NODE_ONE_ID],
              sessionIds: [],
              frameworks: [],
              detail: 'x'.repeat(4097),
            },
          ],
        },
      }),
    );
    win = window;
    await flush();
    expect(window.document.querySelector('[data-section="build-drift"]')?.className).toContain(
      'hidden',
    );
    expect(window.document.body.textContent ?? '').toContain('Could not load fleet nodes');
  });
});
