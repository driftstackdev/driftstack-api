// SimulatorWindow — control-channel health + address-bar connect state.
//
// Two quick-win fixes covered here:
//   1. The amber "control may not be reaching the device" badge (set on the
//      first failed input-publish) used to LATCH forever — it was never reset on
//      recovery. It must clear when a fresh/reconnected room arrives.
//   2. While the room is still connecting (up to ~30s) the address bar is
//      disabled. A bare disabled field reads as broken, so the bar surfaces an
//      explicit "connecting…" affordance, distinct from a real failure (which
//      surfaces as a navigate-error notice toast).
//   3. A reliable-channel congestion latch that never receives its buffer-low
//      event has a deterministic full Room reconnect instead of pausing input
//      forever behind a passive badge.
//   4. Harness inputAck dropped/failed/deadline outcomes use the same actionable
//      badge and are cleared across renderer ownership/reconnect boundaries.
//
// A controllable AgentSessionPanel mock exposes onPublishError + onRoom so the
// test can drive the failed-publish → recovery sequence (the real panel needs a
// live WebRTC connect jsdom can't do).

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';

const sendNavigate = vi.fn(() => Promise.resolve());
const sendActivateTab = vi.fn(
  (_room: unknown, _payload: unknown, onRequestId?: (requestId: string) => void) => {
    onRequestId?.('req_test');
    return Promise.resolve('req_test');
  },
);
const getAgentSession = vi.fn((): Promise<unknown> => new Promise(() => {}));
const manualControlState = {
  mode: 'manual' as const,
  pairKind: null,
  terminal: false,
  status: 'active' as const,
  closedReason: null,
  capabilityReport: { manual_input_available: true },
};
function immediateControl<T>(value: T): Promise<T> {
  return {
    then: (onfulfilled: (resolved: T) => unknown) => {
      try {
        return Promise.resolve(onfulfilled(value));
      } catch (err: unknown) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  } as unknown as Promise<T>;
}
let dataHandler: ((payload: Uint8Array) => void) | null = null;

// Browser mode defaults ON (founder 2026-06-21), which hosts the URL bar in the
// toolbar and hides the panel's NavigateAddressBar. These tests exercise the
// panel address bar's connecting affordance, so pin Browser mode OFF with a
// working localStorage stub (jsdom's is non-functional here).
beforeEach(() => {
  sendNavigate.mockClear();
  sendActivateTab.mockReset();
  sendActivateTab.mockImplementation((_room, _payload, onRequestId) => {
    onRequestId?.('req_test');
    return Promise.resolve('req_test');
  });
  getAgentSession.mockReset();
  getAgentSession.mockImplementation(() => immediateControl(manualControlState));
  dataHandler = null;
  const store = new Map<string, string>([
    ['ds-sim-browser-mode', '0'],
    ['ds-sim-navigated', '1'],
  ]);
  vi.stubGlobal('localStorage', {
    getItem: (k: string): string | null => store.get(k) ?? null,
    setItem: (k: string, v: string): void => {
      store.set(k, v);
    },
    removeItem: (k: string): void => {
      store.delete(k);
    },
    clear: (): void => store.clear(),
    key: (): string | null => null,
    length: 0,
  });
});

vi.mock('../../src/lib/livekit', () => ({
  createLivekitRoom: () => ({ on: vi.fn(), disconnect: vi.fn() }),
  connectToAgentSession: () => new Promise(() => {}),
  sendInputEvent: vi.fn(() => Promise.resolve()),
  sendNavigate,
  sendTabListUpdate: vi.fn(() => Promise.resolve()),
  sendActivateTab,
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    DataReceived: 'dataReceived',
    Disconnected: 'disconnected',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
  },
}));

const fakeRoom = {
  on: vi.fn((event: string, cb: (payload: Uint8Array) => void) => {
    if (event === 'dataReceived') dataHandler = cb;
  }),
  off: vi.fn(),
  localParticipant: { publishData: vi.fn(() => Promise.resolve()) },
};

// Capture the panel's callbacks so the test can fire onPublishError / onRoom on
// demand (the real panel only surfaces these after a live connect).
const panelCbs: {
  onPublishError?: (room: unknown) => void;
  onInputCongestionChange?: (congested: boolean, room: unknown) => void;
  onRoom?: (room: unknown, ownerRoom: unknown) => void;
  onStateChange?: (s: { kind: string }, room: unknown) => void;
  onPublisher?: (p: string, room: unknown) => void;
  interactive?: boolean;
  recoverAction?: { nonce: number; mode: 'resubscribe' | 'rebuild' };
} = {};
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: (props: {
    onPublishError?: (room: unknown) => void;
    onInputCongestionChange?: (congested: boolean, room: unknown) => void;
    onRoom?: (room: unknown, ownerRoom: unknown) => void;
    onStateChange?: (s: { kind: string }, room: unknown) => void;
    onPublisher?: (p: string, room: unknown) => void;
    interactive?: boolean;
    recoverAction?: { nonce: number; mode: 'resubscribe' | 'rebuild' };
  }) => {
    panelCbs.onPublishError = props.onPublishError;
    panelCbs.onInputCongestionChange = props.onInputCongestionChange;
    panelCbs.onRoom = props.onRoom;
    panelCbs.onStateChange = props.onStateChange;
    panelCbs.onPublisher = props.onPublisher;
    panelCbs.interactive = props.interactive;
    panelCbs.recoverAction = props.recoverAction;
    return <div data-component="agent-session-panel-mock" />;
  },
}));

// Control transport stays pending so a control round-trip can't itself clear the
// badge — isolates the room-recovery reset path.
vi.mock('../../src/lib/agent-session-control', () => ({
  uploadAgentSessionFile: vi.fn(() => Promise.resolve({ status: 'unavailable', handle: null })),
  listAgentSessionDownloads: vi.fn(() => Promise.resolve({ status: 'unavailable', files: null })),
  fetchAgentSessionDownload: vi.fn(() => Promise.resolve({ status: 'unavailable', file: null })),
  getAgentSession,
  getAgentSessionPageState: () => Promise.resolve(null),
  // The cookies drawer poll (founder #48) calls this once the room connects; the
  // mock must export it or the poll's tick throws + crashes the component.
  getAgentSessionCookies: () => Promise.resolve({ status: 'unavailable', cookies: null }),
  setSessionMode: vi.fn(),
  takeoverSession: vi.fn(),
  handbackSession: vi.fn(),
  sendAgentMessage: vi.fn(),
  endAgentSession: vi.fn(),
  AgentSessionControlError: class extends Error {},
}));

const { SimulatorWindow } = await import('../../src/views/SimulatorWindow');
const { RecordingsProvider } = await import('../../src/lib/recordings');
const { handleInputAck, pendingInputReceiptCount, registerInputReceipt } =
  await import('../../src/lib/livekit-input-ack');

function renderSim() {
  window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_x');
  return render(
    <RecordingsProvider>
      <SimulatorWindow />
    </RecordingsProvider>,
  );
}

describe('SimulatorWindow — controlUnreachable badge does not latch', () => {
  it('fails closed while control ownership is unknown, then enables only after manual resolves', async () => {
    let resolveControl: ((value: unknown) => void) | null = null;
    const heldControl = new Promise((resolve) => {
      resolveControl = resolve;
    });
    getAgentSession.mockImplementation(() => heldControl);
    const { container } = renderSim();
    act(() => {
      panelCbs.onRoom?.(fakeRoom, fakeRoom);
      panelCbs.onStateChange?.({ kind: 'connected' }, fakeRoom);
      panelCbs.onPublisher?.('publishing', fakeRoom);
    });

    expect(panelCbs.interactive).toBe(false);
    expect(container.querySelector('[data-component="simulator-keyboard-toggle"]')).toBeDisabled();
    act(() => {
      dataHandler?.(
        new TextEncoder().encode(
          JSON.stringify({ state: 'loaded', url: 'https://example.com/', inputFocused: true }),
        ),
      );
    });
    expect(container.querySelector('[data-component="ios-keyboard-overlay"]')).toBeNull();

    await act(async () => {
      resolveControl?.({
        mode: 'manual',
        pairKind: null,
        terminal: false,
        status: 'active',
        closedReason: null,
        capabilityReport: { manual_input_available: true },
      });
      await Promise.resolve();
    });
    expect(panelCbs.interactive).toBe(true);
    expect(
      container.querySelector('[data-component="simulator-keyboard-toggle"]'),
    ).not.toBeDisabled();

    act(() => {
      dataHandler?.(
        new TextEncoder().encode(
          JSON.stringify({ state: 'loaded', url: 'https://example.com/', inputFocused: false }),
        ),
      );
      dataHandler?.(
        new TextEncoder().encode(
          JSON.stringify({ state: 'loaded', url: 'https://example.com/', inputFocused: true }),
        ),
      );
    });
    expect(container.querySelector('[data-component="simulator-keyboard-toggle"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('shows the badge on a failed input-publish, then CLEARS it when a room (re)connects', () => {
    const { container } = renderSim();
    act(() => panelCbs.onRoom?.(fakeRoom, fakeRoom));
    // No badge initially.
    expect(container.querySelector('[data-component="control-unreachable-badge"]')).toBeNull();
    // A failed publish raises the badge.
    act(() => panelCbs.onPublishError?.(fakeRoom));
    expect(container.querySelector('[data-component="control-unreachable-badge"]')).not.toBeNull();
    // A fresh/reconnected room clears it (the latch is gone).
    act(() => panelCbs.onRoom?.(fakeRoom, fakeRoom));
    expect(container.querySelector('[data-component="control-unreachable-badge"]')).toBeNull();
  });

  it('surfaces truthful receipt failure copy and clears it on a confirmed input', () => {
    const { container } = renderSim();
    act(() => panelCbs.onRoom?.(fakeRoom, fakeRoom));
    act(() => {
      registerInputReceipt(fakeRoom as never, 'input_1', 10_000);
      handleInputAck(fakeRoom as never, {
        type: 'inputAck',
        id: 'input_1',
        status: 'dropped',
      });
    });
    expect(
      container.querySelector('[data-component="control-unreachable-badge"]'),
    ).toHaveTextContent('Device dropped the last input');

    act(() => {
      registerInputReceipt(fakeRoom as never, 'input_2', 10_000);
      handleInputAck(fakeRoom as never, {
        type: 'inputAck',
        id: 'input_2',
        status: 'applied',
      });
    });
    expect(container.querySelector('[data-component="control-unreachable-badge"]')).toBeNull();
  });

  it('invalidates pending receipts when tab ownership changes', async () => {
    localStorage.setItem('ds-sim-browser-mode', '1');
    const { container } = renderSim();
    act(() => {
      panelCbs.onRoom?.(fakeRoom, fakeRoom);
      panelCbs.onStateChange?.({ kind: 'connected' }, fakeRoom);
      panelCbs.onPublisher?.('publishing', fakeRoom);
    });
    act(() => registerInputReceipt(fakeRoom as never, 'old_tab_input', 10_000));
    expect(pendingInputReceiptCount(fakeRoom as never)).toBe(1);

    fireEvent.click(container.querySelector('[aria-label="New tab"]') as HTMLButtonElement);
    await act(async () => Promise.resolve());
    expect(pendingInputReceiptCount(fakeRoom as never)).toBe(0);
    expect(container.querySelector('[data-component="control-unreachable-badge"]')).toBeNull();
  });
});

describe('SimulatorWindow — harness capability health', () => {
  it('becomes honestly view-only and surfaces blank capture + dead proxy state', async () => {
    localStorage.setItem('ds-sim-browser-mode', '1');
    getAgentSession.mockImplementation(() =>
      immediateControl({
        mode: 'manual',
        pairKind: null,
        terminal: false,
        status: 'active',
        closedReason: null,
        capabilityReport: {
          manual_input_available: false,
          streaming_state: 'blank',
          egress_state: 'dead_proxy',
        },
      }),
    );

    const { container } = renderSim();
    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-component="view-only-capability-badge"]'),
      ).not.toBeNull();
    });
    expect(panelCbs.interactive).toBe(false);
    expect(
      container.querySelector('[data-component="streaming-capability-error"]'),
    ).toHaveTextContent('capture is blank');
    expect(
      container.querySelector('[data-component="dead-proxy-capability-badge"]'),
    ).toHaveTextContent('Proxy connection failed');
    expect(container.querySelector('[role="tablist"]')).toHaveAttribute('aria-disabled', 'true');
    expect(container.querySelector('[aria-label="New tab"]')).toBeDisabled();
    expect(container.querySelector('[data-component="simulator-keyboard-toggle"]')).toBeDisabled();
    expect(container.querySelector('[data-component="touch-cursor-overlay"]')).toBeNull();
  });
});

describe('SimulatorWindow — temporary input congestion feedback', () => {
  it('shows a calm catching-up badge during congestion and clears it on drain', () => {
    const { container } = renderSim();
    act(() => panelCbs.onRoom?.(fakeRoom, fakeRoom));
    expect(container.querySelector('[data-component="input-congestion-badge"]')).toBeNull();

    act(() => panelCbs.onInputCongestionChange?.(true, fakeRoom));
    const badge = container.querySelector('[data-component="input-congestion-badge"]');
    expect(badge).not.toBeNull();
    expect(badge).toHaveTextContent('Connection catching up — input paused briefly');

    act(() => panelCbs.onInputCongestionChange?.(false, fakeRoom));
    expect(container.querySelector('[data-component="input-congestion-badge"]')).toBeNull();
  });

  it('offers a full Room reconnect when congestion does not drain', () => {
    const { container } = renderSim();
    act(() => panelCbs.onRoom?.(fakeRoom, fakeRoom));
    const initialNonce = panelCbs.recoverAction?.nonce ?? 0;

    act(() => panelCbs.onInputCongestionChange?.(true, fakeRoom));
    const reconnect = container.querySelector(
      '[data-component="input-congestion-reconnect"]',
    ) as HTMLButtonElement;
    expect(reconnect).not.toBeNull();
    expect(reconnect).toHaveTextContent('Reconnect');

    fireEvent.click(reconnect);

    expect(panelCbs.recoverAction).toEqual({ nonce: initialNonce + 1, mode: 'rebuild' });
    expect(reconnect).toBeDisabled();
    expect(reconnect).toHaveTextContent('Reconnecting…');
    expect(container.querySelector('[data-component="input-congestion-badge"]')).not.toBeNull();
  });

  it('rolls back an optimistic tab switch when congestion wins the publish race', async () => {
    const { ReliableInputCongestedError } = await import('../../src/lib/livekit-input-congestion');
    localStorage.setItem('ds-sim-browser-mode', '1');
    const { container } = renderSim();
    act(() => {
      panelCbs.onRoom?.(fakeRoom, fakeRoom);
      panelCbs.onStateChange?.({ kind: 'connected' }, fakeRoom);
      panelCbs.onPublisher?.('publishing', fakeRoom);
    });

    fireEvent.click(container.querySelector('[aria-label="New tab"]') as HTMLButtonElement);
    await act(async () => {
      await Promise.resolve();
    });
    const tabs = [...container.querySelectorAll('[data-component="simulator-tab"]')];
    expect(tabs).toHaveLength(2);
    const previouslyActive = tabs.find((tab) => tab.getAttribute('data-active') === 'true');
    const target = tabs.find((tab) => tab !== previouslyActive);
    expect(previouslyActive).toBeDefined();
    expect(target).toBeDefined();

    sendActivateTab.mockRejectedValueOnce(new ReliableInputCongestedError());
    fireEvent.click(target as Element);
    await act(async () => {
      await Promise.resolve();
    });
    expect(previouslyActive?.getAttribute('data-active')).toBe('true');
    expect(target?.getAttribute('data-active')).toBe('false');
    expect(container.textContent).toContain('Connection catching up — tab switch paused');
  });

  it('restores the previous address when congestion wins the navigation publish race', async () => {
    const { ReliableInputCongestedError } = await import('../../src/lib/livekit-input-congestion');
    localStorage.setItem('ds-sim-browser-mode', '1');
    const { container } = renderSim();
    act(() => {
      panelCbs.onRoom?.(fakeRoom, fakeRoom);
      panelCbs.onStateChange?.({ kind: 'connected' }, fakeRoom);
      panelCbs.onPublisher?.('publishing', fakeRoom);
    });
    const address = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    expect(address.value).toBe('');

    sendNavigate.mockRejectedValueOnce(new ReliableInputCongestedError());
    fireEvent.change(address, { target: { value: 'example.com' } });
    fireEvent.submit(address.closest('form') as HTMLFormElement);
    await act(async () => {
      await Promise.resolve();
    });

    expect(sendNavigate).toHaveBeenCalledTimes(1);
    expect((container.querySelector('[aria-label="Address bar"]') as HTMLInputElement).value).toBe(
      '',
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('Connection catching up — navigation paused');
  });

  it('cancels active-tab-close convergence when readiness replaces its authority epoch', async () => {
    const { ReliableInputCongestedError } = await import('../../src/lib/livekit-input-congestion');
    localStorage.setItem('ds-sim-browser-mode', '1');
    const { container } = renderSim();
    act(() => {
      panelCbs.onRoom?.(fakeRoom, fakeRoom);
      panelCbs.onStateChange?.({ kind: 'connected' }, fakeRoom);
      panelCbs.onPublisher?.('publishing', fakeRoom);
    });

    fireEvent.click(container.querySelector('[aria-label="New tab"]') as HTMLButtonElement);
    await act(async () => {
      await Promise.resolve();
    });
    sendActivateTab.mockClear();
    sendActivateTab.mockRejectedValueOnce(new ReliableInputCongestedError());
    const active = [...container.querySelectorAll('[data-component="simulator-tab"]')].find(
      (tab) => tab.getAttribute('data-active') === 'true',
    );
    fireEvent.click(active?.querySelector('[aria-label="Close tab"]') as HTMLButtonElement);
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelectorAll('[data-component="simulator-tab"]')).toHaveLength(1);
    expect(sendActivateTab).toHaveBeenCalledTimes(1);

    act(() => panelCbs.onInputCongestionChange?.(true, fakeRoom));
    // A reconnect/publisher transition replaces the exact manual-input epoch. The
    // old close activation is canceled rather than lent the later ready authority.
    act(() => {
      panelCbs.onStateChange?.({ kind: 'reconnecting' }, fakeRoom);
      panelCbs.onPublisher?.('waiting', fakeRoom);
      panelCbs.onInputCongestionChange?.(false, fakeRoom);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(sendActivateTab).toHaveBeenCalledTimes(1);
    act(() => panelCbs.onStateChange?.({ kind: 'connected' }, fakeRoom));
    expect(sendActivateTab).toHaveBeenCalledTimes(1); // publisher still waiting
    act(() => panelCbs.onPublisher?.('publishing', fakeRoom));
    await act(async () => {
      await Promise.resolve();
    });
    expect(sendActivateTab).toHaveBeenCalledTimes(1);
  });

  it('cancels a retry and its cover during a same-Room readiness epoch replacement', async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem('ds-sim-browser-mode', '1');
      const { container } = renderSim();
      act(() => {
        panelCbs.onRoom?.(fakeRoom, fakeRoom);
        panelCbs.onStateChange?.({ kind: 'connected' }, fakeRoom);
        panelCbs.onPublisher?.('publishing', fakeRoom);
      });

      fireEvent.click(container.querySelector('[aria-label="New tab"]') as HTMLButtonElement);
      expect(sendActivateTab).toHaveBeenCalledTimes(1);
      act(() => {
        panelCbs.onStateChange?.({ kind: 'reconnecting' }, fakeRoom);
        panelCbs.onPublisher?.('waiting', fakeRoom);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1200);
      });
      expect(sendActivateTab).toHaveBeenCalledTimes(1);
      act(() => {
        dataHandler?.(
          new TextEncoder().encode(
            JSON.stringify({
              type: 'page_state',
              state: 'loaded',
              url: 'https://target.example/',
              title: 'Target',
            }),
          ),
        );
      });
      // The readiness change revoked the old epoch synchronously: its visual cover,
      // retry and deferred owner are all gone before any later terminal frame.
      expect(container.querySelector('[data-component="simulator-switch-blank"]')).toBeNull();

      act(() => panelCbs.onStateChange?.({ kind: 'connected' }, fakeRoom));
      expect(sendActivateTab).toHaveBeenCalledTimes(1);
      act(() => panelCbs.onPublisher?.('publishing', fakeRoom));
      expect(sendActivateTab).toHaveBeenCalledTimes(1);
      act(() => {
        dataHandler?.(
          new TextEncoder().encode(
            JSON.stringify({
              type: 'activateTabResult',
              requestId: 'req_test',
              ok: true,
              wasWarm: true,
            }),
          ),
        );
      });
      expect(container.querySelector('[data-component="simulator-switch-blank"]')).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(sendActivateTab).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not resurrect a revoked switch cover or wire owner after readiness returns', async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem('ds-sim-browser-mode', '1');
      const { container } = renderSim();
      act(() => {
        panelCbs.onRoom?.(fakeRoom, fakeRoom);
        panelCbs.onStateChange?.({ kind: 'connected' }, fakeRoom);
        panelCbs.onPublisher?.('publishing', fakeRoom);
      });
      fireEvent.click(container.querySelector('[aria-label="New tab"]') as HTMLButtonElement);
      act(() => {
        panelCbs.onStateChange?.({ kind: 'reconnecting' }, fakeRoom);
        panelCbs.onPublisher?.('waiting', fakeRoom);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(sendActivateTab).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[data-component="simulator-switch-blank"]')).toBeNull();

      act(() => {
        panelCbs.onStateChange?.({ kind: 'connected' }, fakeRoom);
        panelCbs.onPublisher?.('publishing', fakeRoom);
      });
      expect(sendActivateTab).toHaveBeenCalledTimes(1);
      // A newer ready epoch must not recreate the old visual or lend it transport.
      expect(container.querySelector('[data-component="simulator-switch-blank"]')).toBeNull();
      act(() => {
        dataHandler?.(
          new TextEncoder().encode(
            JSON.stringify({
              type: 'activateTabResult',
              requestId: 'req_test',
              ok: true,
              wasWarm: true,
            }),
          ),
        );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(sendActivateTab).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[data-component="simulator-switch-blank"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not optimistically create a tab or navigate while input is paused', () => {
    localStorage.setItem('ds-sim-browser-mode', '1');
    const { container } = renderSim();
    act(() => {
      panelCbs.onRoom?.(fakeRoom, fakeRoom);
      panelCbs.onStateChange?.({ kind: 'connected' }, fakeRoom);
      panelCbs.onPublisher?.('publishing', fakeRoom);
    });
    expect(container.querySelectorAll('[data-component="simulator-tab"]')).toHaveLength(1);

    act(() => panelCbs.onInputCongestionChange?.(true, fakeRoom));
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as HTMLButtonElement);
    expect(container.querySelectorAll('[data-component="simulator-tab"]')).toHaveLength(1);

    const address = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    fireEvent.change(address, { target: { value: 'example.com' } });
    fireEvent.submit(address.closest('form') as HTMLFormElement);
    expect(sendNavigate).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Connection catching up — try again in a moment');
  });
});

describe('SimulatorWindow — address bar connect state', () => {
  it('reads "connecting…" (not broken) while the room is still connecting, and unlocks once connected', () => {
    const { container } = renderSim();
    // The icon rail is always docked; click the Controls rail icon to expand its
    // pane — the panel address bar lives in the Controls pane (activity-bar drawer:
    // an always-docked rail + a single expandable pane).
    fireEvent.click(container.querySelector('[data-component="sim-rail-controls"]') as Element);

    const addressInput = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    expect(addressInput).not.toBeNull();
    // While connecting: disabled, an explicit connecting placeholder + tooltip,
    // and a "connecting…" caption beside the Address label.
    expect(addressInput.disabled).toBe(true);
    expect(addressInput.getAttribute('placeholder')).toContain('connecting…');
    expect(addressInput.getAttribute('title')).toContain('Connecting');
    expect(
      container.querySelector('[data-component="simulator-address-connecting"]'),
    ).not.toBeNull();

    // The Room object existing (onRoom) + a 'connected' signal is NOT enough — without a
    // video track publishing, the box renderer isn't up, so the bar STAYS locked
    // ("connecting…"). This is the edge-errors fix: navigation no longer enables on
    // room !== null during connect.
    act(() => {
      panelCbs.onRoom?.(fakeRoom, fakeRoom);
      panelCbs.onStateChange?.({ kind: 'connected' }, fakeRoom);
    });
    expect(
      (container.querySelector('[aria-label="Address bar"]') as HTMLInputElement).disabled,
    ).toBe(true);

    // Once a video track is actually publishing the device is live → the bar unlocks and
    // the connecting caption is gone.
    act(() => panelCbs.onPublisher?.('publishing', fakeRoom));
    const connectedInput = container.querySelector(
      '[aria-label="Address bar"]',
    ) as HTMLInputElement;
    expect(connectedInput.disabled).toBe(false);
    expect(connectedInput.getAttribute('placeholder')).toContain('Search or enter');
    expect(container.querySelector('[data-component="simulator-address-connecting"]')).toBeNull();
  });
});
