// On Windows and Linux, launching a profile — the product's central action —
// could not work at all.
//
// The simulator opens by spawning the SEPARATE "Driftstack Simulator" app. That app
// is a macOS .app bundle; `launch_simulator`'s `#[cfg(not(target_os = "macos"))]`
// branch answers `Err("the separate simulator app is macOS-only")`. Until this
// change nothing caught that error: `0b1fe535f` removed the in-process fallback and
// `openSimulatorWindow` returned `opened:false` with that message. So a Windows user
// could install the app, sign in, see their profiles, manage proxies — and then get
// an error every single time they pressed Launch.
//
// ── why the removal was right and still left this hole ────────────────────────
//
// `0b1fe535f` deleted the fallback because "the separate Driftstack Simulator app is
// reliably installed now", after a founder-hit saga where a borderless in-app window
// read as embedded in the main GUI ("still in the same window"). That reasoning is
// sound — and entirely about macOS. The branch it deleted was the one every other
// platform depended on, and the deleted code said so in as many words:
//
//     // not installed / non-macOS / spawn failed → in-process window fallback.
//
// So the fallback is restored for non-macOS ONLY. macOS keeps the no-fallback
// contract exactly, pinned by `open-simulator.test.tsx`.
//
// ── the selector ──────────────────────────────────────────────────────────────
//
// `simulator_app_supported` is a Rust `cfg!(target_os = "macos")` — a compile-time
// constant answering the same question `launch_simulator`'s own gate asks. Chosen
// over matching the error STRING (which would break the moment that message is
// reworded) and over a new OS plugin dependency.
//
// ⚠️ Only an explicit `false` selects the in-process path. A rejection — an older
// binary that predates the command — or any non-boolean keeps macOS behaviour. That
// direction is deliberate: silently gaining an inline window on macOS is the exact
// failure `0b1fe535f` was written to end, whereas a pre-command binary on Windows
// could not launch a profile either way, so the conservative default costs nothing.
//
// ⚠️ NOT covered here, and not claimed: that the restored window actually renders a
// working simulator on Windows. These arms establish which path is taken and that
// the handoff survives it. Whether WebView2 renders the LiveKit video correctly is a
// real-device question, and no jsdom test can answer it.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { LiveKitInfo } from '@driftstack/sdk';

const invoke = vi.fn<(cmd: string, args: unknown) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: unknown): Promise<unknown> => invoke(cmd, args),
}));

interface FakeWindow {
  label: string;
  options: Record<string, unknown>;
  once: (event: string, cb: (e?: { payload?: unknown }) => void) => Promise<void>;
  setFocus: () => Promise<void>;
  close: () => Promise<void>;
}

const constructed: FakeWindow[] = [];
/** Windows the backend already knows about, keyed by label. */
const registry = new Map<string, FakeWindow>();
/** What the next `tauri://` lifecycle event should be. */
let nextLifecycle: { event: 'created' } | { event: 'error'; payload: string } = {
  event: 'created',
};

// A `function` expression, NOT an arrow: the source calls `new WebviewWindow(...)`
// and an arrow function is not constructable ("is not a constructor").
const WebviewWindowCtor = vi.fn(function (label: string, options: Record<string, unknown>) {
  const win: FakeWindow = {
    label,
    options,
    once: (event, cb) => {
      const want = nextLifecycle.event === 'created' ? 'tauri://created' : 'tauri://error';
      if (event === want) {
        cb(nextLifecycle.event === 'error' ? { payload: nextLifecycle.payload } : undefined);
      }
      return Promise.resolve();
    },
    setFocus: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  constructed.push(win);
  return win;
});

const getByLabel = vi.fn((label: string) => Promise.resolve(registry.get(label) ?? null));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: Object.assign(WebviewWindowCtor, { getByLabel: (l: string) => getByLabel(l) }),
  getCurrentWebviewWindow: () => ({
    outerPosition: () => Promise.resolve({ x: 100, y: 50 }),
    outerSize: () => Promise.resolve({ width: 1200, height: 800 }),
    scaleFactor: () => Promise.resolve(1),
  }),
}));

const { openSimulatorWindow } = await import('../../src/lib/open-simulator');

const info = { ws_url: 'wss://lk.example', token: 'tok', room_name: 'room-1' } as LiveKitInfo;

/** Answer `simulator_app_supported` with `value`; every other command resolves. */
function platformReports(value: unknown): void {
  invoke.mockImplementation((cmd: string) =>
    cmd === 'simulator_app_supported' ? Promise.resolve(value) : Promise.resolve(undefined),
  );
}

const launchCalls = (): unknown[] => invoke.mock.calls.filter((c) => c[0] === 'launch_simulator');

beforeEach(() => {
  invoke.mockReset();
  WebviewWindowCtor.mockClear();
  getByLabel.mockClear();
  constructed.length = 0;
  registry.clear();
  nextLifecycle = { event: 'created' };
  // Under Tauri, or every call short-circuits on the browser-preview guard and
  // no arm below would be exercising anything.
  (globalThis as unknown as { window: unknown }).window = globalThis;
  (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

describe('the simulator opens on a platform with no separate app', () => {
  it('CRITICAL when the platform HAS the separate app, the separate app is still what launches and NO in-process window is built. This is the control: every other arm asserts an in-process window appears, and a build that had simply switched everyone to the inline window would satisfy them while undoing the founder-hit decision on macOS.', async () => {
    platformReports(true);
    const res = await openSimulatorWindow({ sessionId: 'agt_mac', info });
    expect(res.opened, `the macOS path failed: ${res.reason ?? ''}`).toBe(true);
    expect(
      launchCalls().length,
      'launch_simulator was not used on the platform that has the app',
    ).toBe(1);
    expect(
      WebviewWindowCtor,
      'an in-process window was built on macOS — the "still in the same window" regression',
    ).not.toHaveBeenCalled();
  });

  it('CRITICAL when the platform reports NO separate app, an in-process window IS built and launch_simulator is NOT called. Calling it would only produce Err("the separate simulator app is macOS-only"), which is precisely the dead end a Windows user hit on every Launch press.', async () => {
    platformReports(false);
    const res = await openSimulatorWindow({ sessionId: 'agt_win', info });
    expect(res.opened, `the in-process path failed: ${res.reason ?? ''}`).toBe(true);
    expect(
      launchCalls().length,
      'launch_simulator was called on a platform that has no separate app to launch',
    ).toBe(0);
    expect(WebviewWindowCtor, 'no in-process simulator window was created').toHaveBeenCalledTimes(
      1,
    );
    expect(constructed[0]?.label, 'the window is not labelled per session').toBe(
      'simulator-agt_win',
    );
  });

  it('CRITICAL the in-process window carries the SAME handoff the separate app gets. A window that opens without ws/token/session hangs on "Connecting…" forever, which reads as a broken product rather than a missing parameter — and it is the failure mode the separate-app path already has an explicit guard against.', async () => {
    platformReports(false);
    await openSimulatorWindow({
      sessionId: 'agt_handoff',
      info,
      deviceName: 'iPhone 17',
      profileName: 'Ada',
      baseUrl: 'https://api.driftstack.dev',
      controlCredential: { key: 'gck_secret', expiresAt: '2030-01-01T00:00:00.000Z' },
    });
    const raw = constructed[0]?.options.url;
    const url = typeof raw === 'string' ? raw : '';
    const q = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    expect(q.get('window'), 'the window is not the simulator view').toBe('simulator');
    expect(q.get('ws'), 'no LiveKit url reached the window').toBe('wss://lk.example');
    expect(q.get('token'), 'no LiveKit token reached the window').toBe('tok');
    expect(q.get('session'), 'no session id reached the window').toBe('agt_handoff');
    expect(
      q.get('base'),
      'no API base reached the window — control calls would hit localhost',
    ).toBe('https://api.driftstack.dev');
    expect(q.get('ck'), 'the per-session control key did not reach the window').toBe('gck_secret');
    expect(q.get('name')).toBe('iPhone 17');
    expect(q.get('profile')).toBe('Ada');
  });

  it('CRITICAL a REJECTED capability check keeps the macOS path, and so does a non-boolean answer. An older binary without the command must not silently gain an inline window on macOS — that is the regression 0b1fe535f exists to prevent — so only an explicit false may switch.', async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === 'simulator_app_supported'
        ? Promise.reject(new Error('unknown command'))
        : Promise.resolve(undefined),
    );
    await openSimulatorWindow({ sessionId: 'agt_old', info });
    expect(
      WebviewWindowCtor,
      'a rejected capability check fell through to an in-app window',
    ).not.toHaveBeenCalled();
    expect(launchCalls().length, 'the separate-app path was not taken').toBe(1);

    // And an answer that is not a boolean at all.
    invoke.mockReset();
    WebviewWindowCtor.mockClear();
    platformReports(undefined);
    await openSimulatorWindow({ sessionId: 'agt_undef', info });
    expect(
      WebviewWindowCtor,
      'a non-boolean capability answer fell through to an in-app window',
    ).not.toHaveBeenCalled();
    expect(launchCalls().length, 'the separate-app path was not taken for a non-boolean').toBe(1);
  });

  it('CRITICAL a second launch of the SAME session focuses the existing window instead of building another. One phone per session is the multi-window contract; duplicating it would leave two windows driving one device.', async () => {
    platformReports(false);
    await openSimulatorWindow({ sessionId: 'agt_dup', info });
    expect(WebviewWindowCtor).toHaveBeenCalledTimes(1);

    // The backend now knows the label.
    const first = constructed[0];
    expect(first).toBeDefined();
    registry.set('simulator-agt_dup', first as FakeWindow);

    const again = await openSimulatorWindow({ sessionId: 'agt_dup', info });
    expect(again.opened).toBe(true);
    expect(
      WebviewWindowCtor,
      'a second launch of the same session built a second window',
    ).toHaveBeenCalledTimes(1);
  });

  it('CRITICAL an incomplete session token is refused BEFORE either path runs. URLSearchParams stringifies a missing token to the literal "undefined", so without this the window opens and hangs on "Connecting…" with nothing to surface — and the in-process path must not be the one that loses that guard.', async () => {
    platformReports(false);
    const res = await openSimulatorWindow({
      sessionId: 'agt_bad',
      info: { ws_url: 'wss://lk.example' } as LiveKitInfo,
    });
    expect(res.opened, 'a session with no token still opened a window').toBe(false);
    expect(res.reason ?? '', 'no reason was surfaced for the refusal').toContain('incomplete');
    expect(WebviewWindowCtor, 'a window was built for an incomplete token').not.toHaveBeenCalled();
  });

  it('CRITICAL a window-creation failure surfaces a reason rather than reporting success. The whole point of the no-silent-fallback rule is that the caller can tell the user WHY nothing opened; the in-process path has to honour that too.', async () => {
    platformReports(false);
    nextLifecycle = { event: 'error', payload: 'webview creation failed' };
    const res = await openSimulatorWindow({ sessionId: 'agt_fail', info });
    expect(res.opened, 'a failed window creation reported success').toBe(false);
    expect(res.reason ?? '', 'the failure reason was swallowed').toContain(
      'webview creation failed',
    );
  });
});
