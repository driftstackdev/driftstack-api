// SimulatorWindow — Tauri-integrated behaviours (founder 2026-06-18):
//   • MODE-AWARE close: closing in MANUAL mode ends the session before the
//     window closes; in agent-driven (ai/pair) or unknown mode it just closes
//     and leaves the session running in the background.
//   • dynamic macOS Dock tile: set with the proxy country on mount (live
//     session), reset on no-session / unmount.
//
// These need `__TAURI_INTERNALS__` present + the Tauri window APIs mocked
// (the other simulator-window tests run with no Tauri, so those effects no-op).
// Kept in a SEPARATE file so the mocks don't leak into the no-Tauri suite.

import { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

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

const fakeRoom = {
  on: vi.fn(),
  off: vi.fn(),
  localParticipant: { publishData: vi.fn(() => Promise.resolve()) },
};
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: (props: {
    onRoom?: (room: unknown, ownerRoom: unknown) => void;
    onStateChange?: (state: { kind: string }, ownerRoom: unknown) => void;
    onPublisher?: (publisher: string, ownerRoom: unknown) => void;
  }) => {
    useEffect(() => {
      props.onRoom?.(fakeRoom, fakeRoom);
      props.onStateChange?.({ kind: 'connected' }, fakeRoom);
      props.onPublisher?.('publishing', fakeRoom);
    }, [props]);
    return <div data-component="agent-session-panel-mock" />;
  },
}));

// Control transport: getAgentSession seeds the mode; endAgentSession is spied.
let sessionMode: 'ai' | 'manual' | 'pair' = 'manual';
// getAgentSession is a spy so a test can make it REJECT (control unreachable),
// which exercises the default-to-manual-but-UNCONFIRMED close-safety path.
const getAgentSession = vi.fn<(id: string, auth: unknown) => Promise<Record<string, unknown>>>();
const endAgentSession = vi.fn<(id: string, auth: unknown) => Promise<void>>().mockResolvedValue();
vi.mock('../../src/lib/agent-session-control', () => ({
  uploadAgentSessionFile: vi.fn(() => Promise.resolve({ status: 'unavailable', handle: null })),
  listAgentSessionDownloads: vi.fn(() => Promise.resolve({ status: 'unavailable', files: null })),
  fetchAgentSessionDownload: vi.fn(() => Promise.resolve({ status: 'unavailable', file: null })),
  getAgentSession: (id: string, auth: unknown): Promise<Record<string, unknown>> =>
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

const destroy = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({
    onCloseRequested: vi.fn(() => Promise.resolve(() => {})),
    destroy,
  }),
}));
// Vite resolves the package export above to this concrete ESM subpath before a
// dynamic import runs. Mock both identities so Vitest cannot externalize the
// resolved `.js` module and silently bypass the close-listener seam.
vi.mock('@tauri-apps/api/webviewWindow.js', () => ({
  getCurrentWebviewWindow: () => ({
    onCloseRequested: vi.fn(() => Promise.resolve(() => {})),
    destroy,
  }),
}));
let dsSessionListener: ((event: { payload: string }) => void) | null = null;
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, listener: (event: { payload: string }) => void) => {
    if (name === 'ds-session') dsSessionListener = listener;
    return Promise.resolve(() => {});
  },
}));

const { SimulatorWindow, controlAuthBoundaryForQuery, handleSimulatorCloseRequest } =
  await import('../../src/views/SimulatorWindow');
const { RecordingsProvider } = await import('../../src/lib/recordings');

function renderSim(): ReturnType<typeof render> {
  return render(
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
    dsSessionListener = null;
    // Default: control fetch succeeds → CONFIRMED mode (seeded from sessionMode).
    getAgentSession.mockReset();
    getAgentSession.mockImplementation(() =>
      Promise.resolve({
        mode: sessionMode,
        pairKind: null,
        status: 'active',
        terminal: false,
        capabilityReport: { manual_input_available: true },
      }),
    );
    // Tauri IPC seam: the real `invoke` calls window.__TAURI_INTERNALS__.invoke.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
  });
  // No per-test teardown of __TAURI_INTERNALS__ — deliberately. A control chain
  // still settling when a test returns (End's credential-cleanup race, the
  // aspect-lock debounce) re-enters Tauri AFTER the hook ran; a deleted stub
  // turns that straggler into a thrown TypeError -> the swallow guard's
  // console.warn -> the warn's rpc forward lands after vitest's rpcDone
  // snapshot and the worker rejects it: "Closing rpc while onUserConsoleLog
  // was pending" (V-2138's 1-in-2 full-suite flake; mechanism + deterministic
  // probe in V-2141). The stub lives for the whole file; jsdom isolation
  // discards it with the environment.

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

  it('loads the exact native generation while exposing no control key to the WebView', async () => {
    invoke.mockImplementation((command: string, args?: unknown) => {
      if (command === 'simulator_control_key_load') {
        expect(args).toEqual({ sessionId: 'agt_key', generation: 7 });
        return Promise.resolve('gck_secret');
      }
      return Promise.resolve(undefined);
    });
    window.history.pushState(
      {},
      '',
      '/?window=simulator&ws=wss://lk&token=livekit-secret&session=agt_key&cg=7',
    );
    renderSim();

    expect(window.location.search).toBe('?window=simulator&session=agt_key&cg=7');
    expect(window.location.href).not.toContain('livekit-secret');
    expect(window.location.href).not.toContain('gck_secret');
    await waitFor(() => {
      expect(invokeArgs('simulator_control_key_load')).toEqual({
        sessionId: 'agt_key',
        generation: 7,
      });
      expect(getAgentSession).toHaveBeenCalledWith('agt_key', { controlKey: 'gck_secret' });
    });
    expect(invoke.mock.calls.some(([command]) => String(command).startsWith('secret_'))).toBe(
      false,
    );
  });

  it('keeps a malformed native generation fail-closed instead of using account auth', async () => {
    window.history.pushState(
      {},
      '',
      '/?window=simulator&ws=wss://lk&token=livekit-secret&session=agt_bad&cg=not-a-number',
    );
    const firstMount = renderSim();

    await waitFor(() => {
      expect(getAgentSession).toHaveBeenCalledWith('agt_bad', { controlKey: null });
    });
    expect(invoke.mock.calls.some(([command]) => command === 'simulator_control_key_load')).toBe(
      false,
    );
    expect(window.location.search).toBe('?window=simulator&session=agt_bad&cg=0');

    // The scrubbed URL itself remains fail-closed across a WebView reload. If
    // cg=0 were removed, infoFromQuery would reinterpret this as the deliberate
    // in-app path and could read the account credential.
    firstMount.unmount();
    getAgentSession.mockClear();
    renderSim();
    await waitFor(() => {
      expect(getAgentSession).toHaveBeenCalledWith('agt_bad', { controlKey: null });
    });
    expect(getAgentSession.mock.calls.some(([, auth]) => auth === null)).toBe(false);
  });

  it('keeps a native marker with no accepted session fail-closed', async () => {
    window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&cg=0');
    renderSim();

    await waitFor(() => {
      expect(window.location.search).toBe('?window=simulator&cg=0');
    });
    expect(controlAuthBoundaryForQuery('', 0, '')).toEqual({
      auth: { controlKey: null },
      needsNativeLoad: false,
    });
    expect(controlAuthBoundaryForQuery('', null, '')).toEqual({
      auth: null,
      needsNativeLoad: false,
    });
    expect(getAgentSession).not.toHaveBeenCalled();
    expect(invoke.mock.calls.some(([command]) => command === 'simulator_control_key_load')).toBe(
      false,
    );
  });

  it('never exposes session A native auth while session B native auth is loading', async () => {
    let releaseB: (() => void) | undefined;
    invoke.mockImplementation((command: string, args?: unknown) => {
      if (command !== 'simulator_control_key_load') return Promise.resolve(undefined);
      const generation = (args as { generation?: number } | undefined)?.generation;
      if (generation === 1) return Promise.resolve('gck_session_a');
      if (generation === 2) {
        return new Promise<string>((resolve) => {
          releaseB = () => resolve('gck_session_b');
        });
      }
      return Promise.resolve(undefined);
    });
    window.history.pushState(
      {},
      '',
      '/?window=simulator&ws=wss://lk&token=a-token&session=agt_a&cg=1',
    );
    renderSim();
    await waitFor(() => {
      expect(getAgentSession).toHaveBeenCalledWith('agt_a', { controlKey: 'gck_session_a' });
      expect(dsSessionListener).not.toBeNull();
    });

    dsSessionListener?.({
      payload: btoa('?window=simulator&ws=wss://lk&token=b-token&session=agt_b&cg=2'),
    });
    await waitFor(() => {
      expect(releaseB).toBeTypeOf('function');
      expect(getAgentSession.mock.calls.some(([id]) => id === 'agt_b')).toBe(true);
    });
    const bLoadingAuth = getAgentSession.mock.calls
      .filter(([id]) => id === 'agt_b')
      .map(([, auth]) => auth);
    expect(bLoadingAuth.some((auth) => auth === null)).toBe(false);
    expect(
      bLoadingAuth.some(
        (auth) => (auth as { controlKey?: unknown } | null)?.controlKey === 'gck_session_a',
      ),
    ).toBe(false);
    expect(
      bLoadingAuth.some((auth) => (auth as { controlKey?: unknown } | null)?.controlKey === null),
    ).toBe(true);

    releaseB?.();
    await waitFor(() => {
      expect(getAgentSession).toHaveBeenCalledWith('agt_b', { controlKey: 'gck_session_b' });
    });
  });

  it('never falls back to account auth when an in-app session switches to native auth', async () => {
    let releaseNative: (() => void) | undefined;
    invoke.mockImplementation((command: string) => {
      if (command === 'simulator_control_key_load') {
        return new Promise<string>((resolve) => {
          releaseNative = () => resolve('gck_native_b');
        });
      }
      return Promise.resolve(undefined);
    });
    window.history.pushState(
      {},
      '',
      '/?window=simulator&ws=wss://lk&token=a-token&session=agt_account',
    );
    renderSim();
    await waitFor(() => {
      expect(getAgentSession).toHaveBeenCalledWith('agt_account', null);
      expect(dsSessionListener).not.toBeNull();
    });

    dsSessionListener?.({
      payload: btoa('?window=simulator&ws=wss://lk&token=b-token&session=agt_native&cg=8'),
    });
    await waitFor(() => {
      expect(releaseNative).toBeTypeOf('function');
      expect(getAgentSession.mock.calls.some(([id]) => id === 'agt_native')).toBe(true);
    });
    const loadingCalls = getAgentSession.mock.calls.filter(([id]) => id === 'agt_native');
    expect(loadingCalls.some(([, auth]) => auth === null)).toBe(false);
    expect(
      loadingCalls.some(
        ([, auth]) => (auth as { controlKey?: unknown } | null)?.controlKey === null,
      ),
    ).toBe(true);

    releaseNative?.();
    await waitFor(() => {
      expect(getAgentSession).toHaveBeenCalledWith('agt_native', { controlKey: 'gck_native_b' });
    });
  });

  it('ignores a retired same-session generation load after its successor binds', async () => {
    let releaseOld: (() => void) | undefined;
    invoke.mockImplementation((command: string, args?: unknown) => {
      if (command !== 'simulator_control_key_load') return Promise.resolve(undefined);
      const generation = (args as { generation?: number } | undefined)?.generation;
      if (generation === 1) {
        return new Promise<string>((resolve) => {
          releaseOld = () => resolve('gck_retired');
        });
      }
      if (generation === 2) return Promise.resolve('gck_successor');
      return Promise.resolve(undefined);
    });
    window.history.pushState(
      {},
      '',
      '/?window=simulator&ws=wss://lk&token=old-token&session=agt_same&cg=1',
    );
    renderSim();
    await waitFor(() => {
      expect(releaseOld).toBeTypeOf('function');
      expect(dsSessionListener).not.toBeNull();
    });

    dsSessionListener?.({
      payload: btoa('?window=simulator&ws=wss://lk&token=new-token&session=agt_same&cg=2'),
    });
    await waitFor(() => {
      expect(getAgentSession).toHaveBeenCalledWith('agt_same', { controlKey: 'gck_successor' });
    });
    releaseOld?.();
    await Promise.resolve();

    expect(
      getAgentSession.mock.calls.some(([, auth]) =>
        Object.is((auth as { controlKey?: unknown } | null)?.controlKey, 'gck_retired'),
      ),
    ).toBe(false);
  });

  it('keeps same-session generation 1 inert when it resolves before held generation 2', async () => {
    let releaseOld: (() => void) | undefined;
    let releaseSuccessor: (() => void) | undefined;
    invoke.mockImplementation((command: string, args?: unknown) => {
      if (command !== 'simulator_control_key_load') return Promise.resolve(undefined);
      const generation = (args as { generation?: number } | undefined)?.generation;
      if (generation === 1) {
        return new Promise<string>((resolve) => {
          releaseOld = () => resolve('gck_retired_first');
        });
      }
      if (generation === 2) {
        return new Promise<string>((resolve) => {
          releaseSuccessor = () => resolve('gck_successor_held');
        });
      }
      return Promise.resolve(undefined);
    });
    window.history.pushState(
      {},
      '',
      '/?window=simulator&ws=wss://lk&token=old-token&session=agt_reused&cg=1',
    );
    renderSim();
    await waitFor(() => {
      expect(releaseOld).toBeTypeOf('function');
      expect(dsSessionListener).not.toBeNull();
    });

    dsSessionListener?.({
      payload: btoa('?window=simulator&ws=wss://lk&token=new-token&session=agt_reused&cg=2'),
    });
    await waitFor(() => expect(releaseSuccessor).toBeTypeOf('function'));
    releaseOld?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(
      getAgentSession.mock.calls.some(
        ([, auth]) => (auth as { controlKey?: unknown } | null)?.controlKey === 'gck_retired_first',
      ),
    ).toBe(false);

    releaseSuccessor?.();
    await waitFor(() => {
      expect(getAgentSession).toHaveBeenCalledWith('agt_reused', {
        controlKey: 'gck_successor_held',
      });
    });
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
    const event = { preventDefault: vi.fn() };
    await handleSimulatorCloseRequest({
      event,
      controlMode: 'manual',
      controlModeConfirmed: true,
      endSession: () => endAgentSession('agt_42', null),
      destroyWindow: destroy,
    });
    // Manual → end the session, prevent the default close, then destroy. The
    // controlAuth is null here (no ?ck= in the query → in-app/API-key path).
    expect(event.preventDefault).toHaveBeenCalled();
    expect(endAgentSession).toHaveBeenCalledWith('agt_42', null);
    expect(destroy).toHaveBeenCalled();
  });

  it('UNCONFIRMED control state (control fetch FAILED): closing does NOT end the session', async () => {
    const event = { preventDefault: vi.fn() };
    await handleSimulatorCloseRequest({
      event,
      controlMode: null,
      controlModeConfirmed: false,
      endSession: () => endAgentSession('agt_77', null),
      destroyWindow: destroy,
    });
    // Unconfirmed manual → treated as non-manual: window closes, session lives on.
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(endAgentSession).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it('AGENT (ai) mode: closing does NOT end the session and lets the window close (no preventDefault/destroy)', async () => {
    const event = { preventDefault: vi.fn() };
    await handleSimulatorCloseRequest({
      event,
      controlMode: 'ai',
      controlModeConfirmed: true,
      endSession: () => endAgentSession('agt_99', null),
      destroyWindow: destroy,
    });
    // Agent-driven → window just closes; the session keeps running in the bg.
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(endAgentSession).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });
});
