// SimulatorWindow — Tauri-integrated behaviours (founder 2026-06-18):
//   • MODE-AWARE close: closing in MANUAL mode ends the session before the
//     window closes; in agent-driven (ai/pair) or unknown mode it just closes
//     and leaves the session running in the background.
//   • dynamic macOS Dock tile: set with the proxy country on mount (live
//     session), reset on no-session / unmount.
//
// These need `__TAURI_INTERNALS__` present + the Tauri dynamic imports mocked
// (the other simulator-window tests run with no Tauri, so those effects no-op).
// Kept in a SEPARATE file so the mocks don't leak into the no-Tauri suite.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

/** The screen host carries `cursor-none` in manual/pair but NOT in ai mode, so
 *  it doubles as a "the control mode has loaded into render" signal — we wait on
 *  it before firing the close handler so we exercise the LOADED-mode handler
 *  (the effect first registers a null-mode handler, then re-registers once the
 *  mode resolves). */
function host(): HTMLElement | null {
  return document.querySelector('[data-component="simulator-screen-host"]');
}

vi.mock('../../src/lib/livekit', () => ({
  createLivekitRoom: () => ({ on: vi.fn(), disconnect: vi.fn() }),
  connectToAgentSession: () => new Promise(() => {}),
  sendInputEvent: vi.fn(() => Promise.resolve()),
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    Disconnected: 'disconnected',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
  },
}));

// Control transport: getAgentSession seeds the mode; endAgentSession is spied.
let sessionMode: 'ai' | 'manual' | 'pair' = 'manual';
// getAgentSession is a spy so a test can make it REJECT (control unreachable),
// which exercises the default-to-manual-but-UNCONFIRMED close-safety path.
const getAgentSession =
  vi.fn<(id: string, auth: unknown) => Promise<{ mode: string; pairKind: null }>>();
const endAgentSession = vi.fn<(id: string, auth: unknown) => Promise<void>>().mockResolvedValue();
vi.mock('../../src/lib/agent-session-control', () => ({
  uploadAgentSessionFile: vi.fn(() => Promise.resolve({ status: 'unavailable', handle: null })),
  listAgentSessionDownloads: vi.fn(() => Promise.resolve({ status: 'unavailable', files: null })),
  fetchAgentSessionDownload: vi.fn(() => Promise.resolve({ status: 'unavailable', file: null })),
  getAgentSession: (id: string, auth: unknown): Promise<{ mode: string; pairKind: null }> =>
    getAgentSession(id, auth),
  getAgentSessionPageState: () => Promise.resolve(null),
  setSessionMode: vi.fn(),
  takeoverSession: vi.fn(),
  handbackSession: vi.fn(),
  sendAgentMessage: vi.fn(),
  endAgentSession: (id: string, auth: unknown): Promise<void> => endAgentSession(id, auth),
  AgentSessionControlError: class extends Error {},
}));

// The real @tauri-apps/api `invoke` just calls `window.__TAURI_INTERNALS__.invoke`
// — so we route it to a spy via the Tauri IPC seam (the canonical test pattern),
// rather than mocking the module (whose dynamic-import interception is flaky for
// the module-level applyDockTile helper).
const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
const localStore = new Map<string, string>();

// Capture the onCloseRequested handler so a test can fire a close + a preventable
// event object so we can observe whether the manual path preventDefaults.
let closeHandler: ((event: { preventDefault: () => void }) => void | Promise<void>) | null = null;
const destroy = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({
    onCloseRequested: (h: (event: { preventDefault: () => void }) => void | Promise<void>) => {
      closeHandler = h;
      return Promise.resolve(() => {});
    },
    destroy,
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
}));

const { SimulatorWindow } = await import('../../src/views/SimulatorWindow');
const { RecordingsProvider } = await import('../../src/lib/recordings');

function renderSim(): void {
  render(
    <RecordingsProvider>
      <SimulatorWindow />
    </RecordingsProvider>,
  );
}

describe('SimulatorWindow — Tauri close + Dock tile', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    endAgentSession.mockClear();
    destroy.mockClear();
    closeHandler = null;
    localStore.clear();
    vi.stubGlobal('localStorage', {
      get length(): number {
        return localStore.size;
      },
      getItem: (key: string): string | null => localStore.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        localStore.set(key, value);
      },
      removeItem: (key: string): void => {
        localStore.delete(key);
      },
      clear: (): void => localStore.clear(),
      key: (index: number): string | null => [...localStore.keys()][index] ?? null,
    });
    sessionMode = 'manual';
    // Default: control fetch succeeds → CONFIRMED mode (seeded from sessionMode).
    getAgentSession.mockReset();
    getAgentSession.mockImplementation(() =>
      Promise.resolve({ mode: sessionMode, pairKind: null }),
    );
    // Tauri IPC seam: the real `invoke` calls window.__TAURI_INTERNALS__.invoke.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  /** Find the args of the first invoke of `cmd` (the real `invoke` appends an
   *  `options` arg + defaults `args` to `{}`, so we match on cmd + arg0 only). */
  function invokeArgs(cmd: string): unknown {
    return invoke.mock.calls.find((c) => c[0] === cmd)?.[1];
  }

  it('sets the Dock tile with the proxy country + profile name on mount when a session is live', async () => {
    window.history.pushState(
      {},
      '',
      '/?window=simulator&ws=wss://lk&token=tok&session=agt_1&cc=US&profile=Amsterdam%20Shopper',
    );
    renderSim();
    // The join token is parsed into state synchronously, then scrubbed from URL
    // history by a layout effect before the first paint.
    expect(window.location.search).toBe('?window=simulator&session=agt_1');
    await waitFor(() => {
      // The flag is derived from the country code; the profile name rides the
      // icon as the caption (founder 2026-06-18).
      expect(invokeArgs('set_dock_tile')).toEqual({
        countryCode: 'US',
        profileName: 'Amsterdam Shopper',
      });
    });
  });

  it('scrubs the LiveKit/control secrets and persists the control key only in Keychain', async () => {
    window.history.pushState(
      {},
      '',
      '/?window=simulator&ws=wss://lk&token=livekit-secret&session=agt_key&ck=gck_secret',
    );
    renderSim();

    expect(window.location.search).toBe('?window=simulator&session=agt_key');
    expect(window.location.href).not.toContain('livekit-secret');
    expect(window.location.href).not.toContain('gck_secret');
    await waitFor(() => {
      expect(invokeArgs('secret_save')).toEqual({
        key: 'gui_control:agt_key',
        value: 'gck_secret',
      });
    });
    expect(getAgentSession).toHaveBeenCalledWith('agt_key', { controlKey: 'gck_secret' });
  });

  it('sets the Dock tile with an empty profile name when the session has none (flag only)', async () => {
    window.history.pushState(
      {},
      '',
      '/?window=simulator&ws=wss://lk&token=tok&session=agt_1&cc=US',
    );
    renderSim();
    await waitFor(() => {
      expect(invokeArgs('set_dock_tile')).toEqual({ countryCode: 'US', profileName: '' });
    });
  });

  it('resets the Dock tile when there is no session', async () => {
    localStorage.setItem('ds-gck-agt_legacy', 'gck_plaintext');
    window.history.pushState({}, '', '/?window=simulator');
    renderSim();
    await waitFor(() => {
      expect(invoke.mock.calls.some((c) => c[0] === 'reset_dock_tile')).toBe(true);
      expect(localStorage.getItem('ds-gck-agt_legacy')).toBeNull();
    });
    expect(invoke.mock.calls.some((c) => c[0] === 'set_dock_tile')).toBe(false);
  });

  it('MANUAL mode: closing ENDS the session, preventDefaults, then destroys the window', async () => {
    sessionMode = 'manual';
    window.history.pushState(
      {},
      '',
      '/?window=simulator&ws=wss://lk&token=tok&session=agt_42&cc=US',
    );
    renderSim();
    // Wait until the manual mode has loaded into render (cursor-none present),
    // so the LOADED-mode close handler (not the initial null-mode one) is live.
    await waitFor(() => expect(host()?.className).toContain('cursor-none'));
    expect(closeHandler).not.toBeNull();
    const event = { preventDefault: vi.fn() };
    await closeHandler?.(event);
    // Manual → end the session, prevent the default close, then destroy. The
    // controlAuth is null here (no ?ck= in the query → in-app/API-key path).
    expect(event.preventDefault).toHaveBeenCalled();
    expect(endAgentSession).toHaveBeenCalledWith('agt_42', null);
    expect(destroy).toHaveBeenCalled();
  });

  it('UNCONFIRMED manual (control fetch FAILED → defaulted to manual): closing does NOT end the session', async () => {
    // The separate Simulator app reopened without its per-session control key →
    // getAgentSession rejects → controlMode defaults to 'manual' but is NOT
    // confirmed. Closing must NOT end what could be a live agent session (audit).
    sessionMode = 'manual';
    getAgentSession.mockRejectedValue(new Error('control unreachable'));
    window.history.pushState(
      {},
      '',
      '/?window=simulator&ws=wss://lk&token=tok&session=agt_77&cc=US',
    );
    renderSim();
    // The default-to-manual still flips the host to cursor-none (manual cursor),
    // so wait on that to confirm the mode resolved into render + the handler
    // re-registered with the (unconfirmed) manual mode.
    await waitFor(() => expect(host()?.className).toContain('cursor-none'));
    expect(closeHandler).not.toBeNull();
    const event = { preventDefault: vi.fn() };
    await closeHandler?.(event);
    // Unconfirmed manual → treated as non-manual: window closes, session lives on.
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(endAgentSession).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it('AGENT (ai) mode: closing does NOT end the session and lets the window close (no preventDefault/destroy)', async () => {
    sessionMode = 'ai';
    window.history.pushState(
      {},
      '',
      '/?window=simulator&ws=wss://lk&token=tok&session=agt_99&cc=US',
    );
    renderSim();
    // ai mode drops cursor-none on the host — wait for that to confirm the mode
    // loaded before firing close (otherwise we'd hit the null-mode handler).
    await waitFor(() => expect(host()?.className).not.toContain('cursor-none'));
    expect(closeHandler).not.toBeNull();
    const event = { preventDefault: vi.fn() };
    await closeHandler?.(event);
    // Agent-driven → window just closes; the session keeps running in the bg.
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(endAgentSession).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });
});
