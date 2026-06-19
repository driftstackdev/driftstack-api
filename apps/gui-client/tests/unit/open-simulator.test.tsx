// openSimulatorWindow (lib/open-simulator) — pins the session HANDOFF payload.
//
// The opener prefers the SEPARATE "Driftstack Simulator" app: it base64-encodes
// the simulator query string and hands it to the Rust `launch_simulator`
// command (argv is `ps`-visible, so only the non-secret session fields ride
// here; the control key goes via the 0600 temp file). This test pins exactly
// which fields land in that payload — including the proxy exit `cc` (country
// code) that drives the separate app's macOS Dock tile (founder 2026-06-18) —
// so a future refactor can't silently drop one. The control key is asserted to
// go via sim_key_write (NOT the query payload).

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { LiveKitInfo } from '@driftstack/sdk';

const invoke = vi.fn<(cmd: string, args: unknown) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: unknown): Promise<unknown> => invoke(cmd, args),
}));
// getByLabel is consulted up-front (focus an existing window). Return null so
// the opener proceeds to the launch_simulator handoff path under test.
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: { getByLabel: () => Promise.resolve(null) },
  getCurrentWebviewWindow: () => ({
    outerPosition: () => Promise.resolve({ x: 0, y: 0 }),
    outerSize: () => Promise.resolve({ width: 0, height: 0 }),
    scaleFactor: () => Promise.resolve(1),
  }),
}));

const { openSimulatorWindow } = await import('../../src/lib/open-simulator');

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

  it('hands the control key off via sim_key_write — never in the query payload', async () => {
    await openSimulatorWindow({
      sessionId: 'agt_k',
      info,
      countryCode: 'US',
      controlKey: 'gck_secret',
    });
    // The control key is written to the 0600 temp file...
    expect(invoke).toHaveBeenCalledWith('sim_key_write', {
      sessionId: 'agt_k',
      key: 'gck_secret',
    });
    // ...and is NOT present anywhere in the ps-visible launch payload.
    const q = launchedQuery();
    expect(q.get('ck')).toBeNull();
    expect(
      atob(
        (
          invoke.mock.calls.find((c) => c[0] === 'launch_simulator') as [
            string,
            { payload: string },
          ]
        )[1].payload,
      ),
    ).not.toContain('gck_secret');
  });
});
