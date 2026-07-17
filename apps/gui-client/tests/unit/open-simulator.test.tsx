// openSimulatorWindow (lib/open-simulator) — pins the session HANDOFF payload
// + the no-fallback failure contract.
//
// The opener launches the SEPARATE "Driftstack Simulator" app: it base64-encodes
// the simulator query string and hands it to the Rust `launch_simulator`
// command. This test pins exactly which fields land in that payload — including
// the proxy exit `cc` (country code) that drives the separate app's macOS Dock
// tile (founder 2026-06-18) — so a future refactor can't silently drop one. The
// complete payload crosses Tauri IPC once; Rust stores it in an owner-only,
// single-use handoff file and launches the separate app with only the plain
// session label in argv. This pins that no secondary secret-bearing command is
// reintroduced.
//
// There is NO in-app webview fallback: when `launch_simulator` rejects the
// opener returns `opened:false` with a reason for the caller to surface (the
// inline window read as embedded in the main GUI + a silent fallback caused the
// founder's multi-hour "still the same window" saga). This file pins that
// failure contract so the fallback can't be reintroduced.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { LiveKitInfo } from '@driftstack/sdk';

const invoke = vi.fn<(cmd: string, args: unknown) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: unknown): Promise<unknown> => invoke(cmd, args),
}));
// The opener no longer touches @tauri-apps/api/webviewWindow at all (the
// in-process WebviewWindow fallback was removed). The constructor is mocked to
// THROW so any accidental reintroduction of `new WebviewWindow(...)` fails this
// suite loudly instead of silently opening an embedded window.
const WebviewWindowCtor = vi.fn(() => {
  throw new Error('open-simulator must not construct an in-app WebviewWindow');
});
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: WebviewWindowCtor,
}));

const { openSimulatorWindow, openSessionById } = await import('../../src/lib/open-simulator');

const info = { ws_url: 'wss://lk.example', token: 'tok', room_name: 'room-1' } as LiveKitInfo;

/** Pull the decoded query string out of the captured launch_simulator payload. */
function launchedQuery(): URLSearchParams {
  const call = invoke.mock.calls.find((c) => c[0] === 'launch_simulator');
  expect(call, 'launch_simulator was invoked').not.toBeUndefined();
  const { payload } = (call as [string, { payload: string }])[1];
  return new URLSearchParams(atob(payload));
}

describe('openSimulatorWindow — session handoff payload', () => {
  beforeEach(() => {
    invoke.mockReset();
    // Default: every command resolves OK (launch_simulator "succeeds" → the
    // separate-app path is taken, the in-process WebviewWindow fallback isn't).
    invoke.mockResolvedValue(undefined);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });

  it('encodes all session fields — including the proxy exit country (cc) for the Dock tile', async () => {
    const res = await openSimulatorWindow({
      sessionId: 'agt_abc',
      info,
      deviceName: 'iPhone 17',
      profileName: 'Amsterdam Shopper',
      proxyLabel: 'NL exit · proxy.example:1080',
      countryCode: 'NL',
    });
    expect(res.opened).toBe(true);
    const q = launchedQuery();
    expect(q.get('window')).toBe('simulator');
    expect(q.get('ws')).toBe('wss://lk.example');
    expect(q.get('token')).toBe('tok');
    expect(q.get('name')).toBe('iPhone 17');
    expect(q.get('profile')).toBe('Amsterdam Shopper');
    expect(q.get('proxy')).toBe('NL exit · proxy.example:1080');
    expect(q.get('session')).toBe('agt_abc');
    expect(q.has('ck')).toBe(false);
    expect(q.has('cke')).toBe(false);
    // The proxy exit country rides the payload → the separate app's Dock tile.
    expect(q.get('cc')).toBe('NL');
  });

  it('defaults the country code to empty when none is supplied (no Dock badge)', async () => {
    await openSimulatorWindow({ sessionId: 'agt_x', info, deviceName: 'iPhone' });
    expect(launchedQuery().get('cc')).toBe('');
  });

  it('a null country code encodes as empty (probe had no exit country)', async () => {
    await openSimulatorWindow({ sessionId: 'agt_x', info, countryCode: null });
    expect(launchedQuery().get('cc')).toBe('');
  });

  it('hands the control key + exact API expiry off once inside the protected launch payload', async () => {
    const key = `gck_${'a'.repeat(32)}`;
    const expiresAt = '2099-07-17T12:34:56.789Z';
    await openSimulatorWindow({
      sessionId: 'agt_k',
      info,
      countryCode: 'US',
      controlCredential: { key, expiresAt },
    });
    expect(invoke.mock.calls.filter(([command]) => command === 'launch_simulator')).toHaveLength(1);
    expect(invoke.mock.calls.some(([command]) => command.startsWith('sim_key'))).toBe(false);
    // Rust persists this complete encoded payload in a 0600 single-use file and
    // passes only sessionLabel in argv. The WebView gets the token/key without a
    // second racing handoff.
    const q = launchedQuery();
    expect(q.get('ck')).toBe(key);
    expect(q.get('cke')).toBe(String(Date.parse(expiresAt)));
    const launchArgs = invoke.mock.calls.find(
      ([command]) => command === 'launch_simulator',
    )?.[1] as { payload: unknown; sessionLabel: unknown } | undefined;
    expect(Object.keys(launchArgs ?? {}).sort()).toEqual(['payload', 'sessionLabel']);
    expect(typeof launchArgs?.payload).toBe('string');
    expect(launchArgs?.sessionLabel).toBe('agt_k');
  });

  it('hands the API base URL off in the query payload (base=) so the separate app targets the real server, not localhost (founder 2026-06-23 control-failed root)', () => {
    // The SEPARATE Simulator app has its OWN (often empty) settings store →
    // loadSettings() defaults baseUrl to localhost:3000, so every control call
    // (mode / End-session / cookies) failed before reaching prod. The launch now
    // hands off the PUBLIC API host (non-secret); SimulatorWindow persists it +
    // carries it on ControlAuth so authedFetch targets the real server.
    return openSimulatorWindow({
      sessionId: 'agt_b',
      info,
      countryCode: 'US',
      baseUrl: 'https://api.driftstack.dev',
    }).then(() => {
      expect(launchedQuery().get('base')).toBe('https://api.driftstack.dev');
    });
  });

  it('omits the base URL (empty) when none is provided → the app keeps its own configured baseUrl', () => {
    return openSimulatorWindow({ sessionId: 'agt_nb', info, countryCode: 'US' }).then(() => {
      expect(launchedQuery().get('base')).toBe('');
    });
  });

  it('surfaces a failure (opened:false + reason) WITHOUT opening an in-app window when launch_simulator rejects', async () => {
    // launch_simulator rejects (separate app not installed / spawn failed). The
    // opener must NOT fall back to an in-process WebviewWindow — it returns a
    // clean reason so the caller shows a user-facing "couldn't open" error.
    invoke.mockImplementation((cmd: string) =>
      cmd === 'launch_simulator'
        ? Promise.reject(new Error('app not installed'))
        : Promise.resolve(undefined),
    );
    const res = await openSimulatorWindow({ sessionId: 'agt_fail', info, countryCode: 'US' });
    expect(res.opened).toBe(false);
    expect(res.reason).toBe('app not installed');
    // No in-app fallback window was ever constructed.
    expect(WebviewWindowCtor).not.toHaveBeenCalled();
  });

  it('returns opened:false (browser preview) when not running under Tauri', async () => {
    // Drop the Tauri marker so the early guard fires (a browser/dev preview must
    // not attempt any launch + must not construct a window).
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const res = await openSimulatorWindow({ sessionId: 'agt_browser', info });
    expect(res.opened).toBe(false);
    expect(res.reason).toMatch(/browser preview/);
    expect(invoke).not.toHaveBeenCalledWith('launch_simulator', expect.anything());
    expect(WebviewWindowCtor).not.toHaveBeenCalled();
  });
});

// openSessionById — the dashboard "Open in desktop client" deep-link
// (driftstack://session/open?session_id=…) routes here. It mints a fresh LiveKit
// token + a per-session control key, then opens the floating Simulator window.
describe('openSessionById — session-open deep-link reopen', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });

  function fakeClient(
    livekitToken: () => Promise<LiveKitInfo>,
  ): Parameters<typeof openSessionById>[0]['client'] {
    return {
      agentSessions: { livekitToken },
    } as unknown as Parameters<typeof openSessionById>[0]['client'];
  }

  it('returns opened:false (not signed in) when there is no client', async () => {
    const res = await openSessionById({
      client: null,
      baseUrl: 'https://api.driftstack.dev',
      apiKey: 'ds_x',
      sessionId: 'agt_1',
    });
    expect(res.opened).toBe(false);
    expect(res.reason).toMatch(/not signed in/);
    expect(invoke).not.toHaveBeenCalledWith('launch_simulator', expect.anything());
  });

  it('mints a token + opens the simulator for a live session', async () => {
    // mintGuiControlKey raw-fetches GET …/gui-control-key — stub a strict key
    // and its API-owned future expiry.
    const key = `gck_${'b'.repeat(32)}`;
    const expiresAt = '2099-07-17T12:34:56.789Z';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ gui_control_key: key, expires_at: expiresAt }), {
        status: 200,
      }),
    );
    const res = await openSessionById({
      client: fakeClient(() => Promise.resolve(info)),
      baseUrl: 'https://api.driftstack.dev',
      apiKey: 'ds_key',
      sessionId: 'agt_live',
    });
    expect(res.opened).toBe(true);
    const q = launchedQuery();
    expect(q.get('session')).toBe('agt_live');
    expect(q.get('ws')).toBe('wss://lk.example');
    expect(q.get('token')).toBe('tok');
    // The minted control key rode the handoff so the separate app can drive control.
    expect(q.get('ck')).toBe(key);
    expect(q.get('cke')).toBe(String(Date.parse(expiresAt)));
    // The API host was handed off so control calls hit the real server.
    expect(q.get('base')).toBe('https://api.driftstack.dev');
    fetchSpy.mockRestore();
  });

  it('returns opened:false with a reason when the session is closed/missing (token mint throws)', async () => {
    const res = await openSessionById({
      client: fakeClient(() =>
        Promise.reject(new Error('Cannot mint LiveKit token for closed session')),
      ),
      baseUrl: 'https://api.driftstack.dev',
      apiKey: 'ds_key',
      sessionId: 'agt_closed',
    });
    expect(res.opened).toBe(false);
    expect(res.reason).toMatch(/closed/);
    expect(invoke).not.toHaveBeenCalledWith('launch_simulator', expect.anything());
  });
});
