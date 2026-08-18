// The control-health badge carried TWO independent conditions on ONE boolean, and each
// writer silently cleared the other's warning.
//
// Found by carrying this morning's input-receipt defect forward as a class rather than
// an incident. That one was a warning whose only clear path was a later success of the
// same kind. This is its neighbour: a warning whose clear path belongs to a DIFFERENT
// kind entirely.
//
// `controlUnreachable` was one `useState(false)` with two unrelated sources:
//
//   receipt health   subscribeInputReceiptIssues -> setControlUnreachable(issue !== null)
//                    "Device did not confirm / dropped / could not apply the last input"
//   control-plane    refreshControl + the 5s session poll + onPublishError
//                    "Control may not be reaching the device"
//
// Both wrote the same flag last-write-wins, so:
//
//   • `refreshControl`'s SUCCESS path called setControlUnreachable(false). It runs on
//     mount and every time a pane opens — so opening a pane wiped a live receipt
//     timeout while inputs were genuinely still unconfirmed, and nothing re-raised it
//     until the next input settled.
//
//   • a CONFIRMED input called setControlUnreachable(false), clearing the badge the
//     expired-`gui_control_key` branch raises. That branch's own comment says it exists
//     so "the operator knows live-status detection is degraded and to reopen the
//     session" — and one successful tap, which says nothing whatsoever about the
//     control plane, erased it.
//
// ⚠️ The two halves are not equally severe. The second self-repairs within 5s because
// the lifecycle poll re-raises on its next tick, so it flickers. The FIRST does not:
// `refreshControl` has no interval ("seed on mount + re-read whenever a pane opens, no
// idle polling") and the receipt subscriber only fires on a NEW settle, so a wiped
// receipt warning stays wiped. The fix is the same for both.
//
// The fix stores the two separately and DERIVES the badge as their OR, so resolving one
// condition can no longer silence the other.
//
// ⚠️ TWO THINGS FOUND HERE ARE DELIBERATELY NOT FIXED, because this harness cannot
// prove either and an unproven source change is the thing this file exists to argue
// against:
//
//   1. The lifecycle poll's `.catch` raises the badge on EVERY rejection. Its own
//      comment says "transient/network/5xx errors stay silent (retry next tick)", but
//      nothing filters on status — and the `.then` never lowers it. So a momentary
//      blip is indistinguishable from an expired gui_control_key.
//   2. That poll and `refreshControl` share ONE `controlReadGenerationRef` counter, so
//      each invalidates the other's in-flight result. A poll response arriving after
//      any refreshControl call is discarded, degraded-state signal included. This is
//      why arms driving the poll here could not raise the badge at all: isolating the
//      poll (only it passes a third argument) made the badge stop appearing entirely.
//
// Both need a harness that can separate the two callers. Recorded rather than patched.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

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
/** Resolve synchronously so a control round-trip lands inside one act(). */
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

beforeEach(() => {
  sendNavigate.mockClear();
  sendActivateTab.mockReset();
  sendActivateTab.mockImplementation((_room, _payload, onRequestId) => {
    onRequestId?.('req_test');
    return Promise.resolve('req_test');
  });
  getAgentSession.mockReset();
  getAgentSession.mockImplementation(() => immediateControl(manualControlState));
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
  on: vi.fn(),
  off: vi.fn(),
  localParticipant: { publishData: vi.fn(() => Promise.resolve()) },
};

const panelCbs: {
  onPublishError?: (room: unknown) => void;
  onRoom?: (room: unknown, ownerRoom: unknown) => void;
} = {};
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: (props: {
    onPublishError?: (room: unknown) => void;
    onRoom?: (room: unknown, ownerRoom: unknown) => void;
  }) => {
    panelCbs.onPublishError = props.onPublishError;
    panelCbs.onRoom = props.onRoom;
    return <div data-component="agent-session-panel-mock" />;
  },
}));

vi.mock('../../src/lib/agent-session-control', () => ({
  uploadAgentSessionFile: vi.fn(() => Promise.resolve({ status: 'unavailable', handle: null })),
  listAgentSessionDownloads: vi.fn(() => Promise.resolve({ status: 'unavailable', files: null })),
  fetchAgentSessionDownload: vi.fn(() => Promise.resolve({ status: 'unavailable', file: null })),
  getAgentSession,
  getAgentSessionPageState: () => Promise.resolve(null),
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
const { handleInputAck, registerInputReceipt } = await import('../../src/lib/livekit-input-ack');

function renderSim() {
  window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_x');
  return render(
    <RecordingsProvider>
      <SimulatorWindow />
    </RecordingsProvider>,
  );
}

const BADGE = '[data-component="control-unreachable-badge"]';

function failAnInput(id: string): void {
  registerInputReceipt(fakeRoom as never, id, 10_000);
  handleInputAck(fakeRoom as never, { type: 'inputAck', id, status: 'failed' });
}

/** Settle the receipt half cleanly. */
function confirmAnInput(id: string): void {
  registerInputReceipt(fakeRoom as never, id, 10_000);
  handleInputAck(fakeRoom as never, { type: 'inputAck', id, status: 'applied' });
}

describe('two warnings sharing one flag erase each other', () => {
  it('CRITICAL each condition raises the badge on its own, and clears on its own. Every other arm here asserts that one condition SURVIVES another being resolved, and a badge that simply never cleared would satisfy them all while being the original latching bug this file sits next to.', () => {
    const { container } = renderSim();
    act(() => panelCbs.onRoom?.(fakeRoom, fakeRoom));
    expect(container.querySelector(BADGE), 'the badge is up before anything failed').toBeNull();

    // Receipt half alone.
    act(() => failAnInput('input_solo_1'));
    expect(container.querySelector(BADGE), 'a failed input did not raise the badge').not.toBeNull();
    act(() => confirmAnInput('input_solo_2'));
    expect(container.querySelector(BADGE), 'a confirmed input did not clear it').toBeNull();

    // Control-plane half alone.
    act(() => panelCbs.onPublishError?.(fakeRoom));
    expect(
      container.querySelector(BADGE),
      'a publish failure did not raise the badge',
    ).not.toBeNull();
    act(() => panelCbs.onRoom?.(fakeRoom, fakeRoom));
    expect(container.querySelector(BADGE), 'a reconnected room did not clear it').toBeNull();
  });

  it('CRITICAL a CONFIRMED input does not clear a control-plane failure. The control-plane warning is what tells an operator that live-status detection is degraded and the session needs reopening; a successful tap says nothing about the control plane, and used to erase it anyway because both wrote the same boolean.', () => {
    const { container } = renderSim();
    act(() => panelCbs.onRoom?.(fakeRoom, fakeRoom));

    act(() => panelCbs.onPublishError?.(fakeRoom));
    expect(container.querySelector(BADGE)).not.toBeNull();

    act(() => confirmAnInput('input_ack_over_link'));
    expect(
      container.querySelector(BADGE),
      'a confirmed input erased the control-plane warning it says nothing about',
    ).not.toBeNull();
  });

  it('CRITICAL both conditions at once need BOTH resolved before the badge goes. Clearing one of two live problems and calling it green is the same defect as clearing one that was never yours — the customer still has an unreachable control plane.', () => {
    const { container } = renderSim();
    act(() => panelCbs.onRoom?.(fakeRoom, fakeRoom));

    act(() => {
      failAnInput('input_both');
      panelCbs.onPublishError?.(fakeRoom);
    });
    expect(container.querySelector(BADGE)).not.toBeNull();

    // Resolve ONLY the receipt half.
    act(() => confirmAnInput('input_both_ok'));
    expect(
      container.querySelector(BADGE),
      'resolving the input half dismissed a still-failing control plane',
    ).not.toBeNull();

    // Now resolve the control half too.
    act(() => panelCbs.onRoom?.(fakeRoom, fakeRoom));
    expect(
      container.querySelector(BADGE),
      'both conditions resolved but the badge stayed',
    ).toBeNull();
  });
});
