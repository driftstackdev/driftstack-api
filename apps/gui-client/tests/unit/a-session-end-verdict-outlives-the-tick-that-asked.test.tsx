// Session-end detection failed exactly when the control plane was slow — the one
// condition it exists for.
//
// The 5s lifecycle poll is what stops the GUI "showing reconnecting and retrying forever
// against a session that's gone" (its own header). Every tick opens with
// `++controlReadGenerationRef.current`, and the `.then` used to return on
// `reqControlEpoch !== controlReadGenerationRef.current` BEFORE reaching `if (s.terminal)`.
//
// So a response that arrives after the next tick started is discarded — verdict included.
// On a control plane slower than 5s that is EVERY response, and the terminal state never
// latches at all.
//
// ── measured before changing anything ─────────────────────────────────────────
//
//   poll calls after mount:                              1
//   poll calls after one 5s interval:                    2
//   sessionEnded after the first tick answers 'closed':  null      ← discarded
//   sessionEnded when the LATEST tick answers in time:   {"reason":"worker_closed"}
//
// The second line is the positive control: the mechanism works, and only the overlap
// case fails. That is the same shape as the input-receipt badge fixed the day before —
// a staleness mechanism that breaks precisely when the thing it watches is slow.
//
// ── why hoisting the latch is safe ────────────────────────────────────────────
//
// The epoch counter is bumped by FIVE call sites: this tick, `refreshControl`, and the
// three mode-mutation lifecycle points. Its documented purpose is to stop a slow
// pre-confirmation snapshot overwriting a freshly confirmed MODE. A terminal verdict is
// not that: it is one-way, keyed to this session id, and the code already states no
// later read can contradict it ("a non-terminal read after a real end can't happen for
// the same id"). There is nothing for the epoch to protect against, so the latch moves
// ahead of it while `mode`/`modeConfirmed` stay behind — an ending session's mode is not
// worth clobbering an in-flight mutation for.
//
// ⚠️ `cancelled` and the session-id check stay in front of the latch. Those are not
// staleness heuristics: they are "this component is gone" and "this is a different
// session", and a verdict about another session must never latch onto this one.
//
// ⚠️ Two other properties of this `.then` are NOT covered by the arms below, stated so
// nobody reads a green here as covering them. Removing the epoch guard outright, or
// dropping the session-id check from the hoisted latch, both leave all three arms
// passing. The first is the pre-existing protection of the NON-terminal path — untouched
// by this commit, and needing an observable for `manualInputControl` that this harness
// does not have. The second is below.
//
// ⚠️ That session-id property is NOT covered by an arm here, and the reason is worth stating
// rather than leaving as a gap someone assumes is closed. An arm was written for it and
// deleted: `sessionId` is parsed once from `location.search` and SimulatorWindow has no
// `popstate` listener, so a test cannot move the window to another session — the
// attempted arm "failed" only because the session had never changed, which is a wrong
// premise, not a defect. The check itself is unchanged by this commit; it sits in front
// of the hoisted latch exactly as it did in front of the epoch guard.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

const sendNavigate = vi.fn(() => Promise.resolve());
const sendActivateTab = vi.fn(() => Promise.resolve('req_test'));
const getAgentSession = vi.fn((): Promise<unknown> => new Promise(() => {}));

const TERMINAL = {
  mode: 'manual' as const,
  pairKind: null,
  terminal: true,
  status: 'closed' as const,
  closedReason: 'worker_closed',
  capabilityReport: { manual_input_available: true },
};

const ALIVE = {
  mode: 'manual' as const,
  pairKind: null,
  terminal: false,
  status: 'active' as const,
  closedReason: null,
  capabilityReport: { manual_input_available: true },
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  getAgentSession.mockReset();
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
  onRoom?: (room: unknown, ownerRoom: unknown) => void;
  sessionEnded?: { reason?: string | null } | null;
} = {};
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: (props: {
    onRoom?: (r: unknown, o: unknown) => void;
    sessionEnded?: { reason?: string | null } | null;
  }) => {
    panelCbs.onRoom = props.onRoom;
    panelCbs.sessionEnded = props.sessionEnded;
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

function renderSim() {
  window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_x');
  return render(
    <RecordingsProvider>
      <SimulatorWindow />
    </RecordingsProvider>,
  );
}

/**
 * Hold every POLL response open so the test decides when each answers.
 *
 * Keyed on the third argument (`{ heartbeatClientId }`), which only the lifecycle poll
 * passes — `refreshControl` calls with two. Without that split a blanket mock proves
 * nothing about WHICH caller produced a transition, and refreshControl is left pending
 * here so it cannot supply one.
 */
function holdThePoll(): Array<(v: unknown) => void> {
  const resolvers: Array<(v: unknown) => void> = [];
  getAgentSession.mockImplementation((..._args: unknown[]) =>
    _args.length >= 3 ? new Promise((res) => resolvers.push(res)) : new Promise(() => {}),
  );
  return resolvers;
}

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('a session-end verdict outlives the tick that asked for it', () => {
  it('CRITICAL the LATEST tick answering in time still latches. Every other arm asserts a verdict surviving something, and a build where terminal latching was simply broken — or where it latched unconditionally — would satisfy them; this is the arm that says the mechanism works at all.', async () => {
    const polls = holdThePoll();
    renderSim();
    act(() => panelCbs.onRoom?.(fakeRoom, fakeRoom));
    await act(async () => {
      await settle();
    });
    expect(polls.length, 'the lifecycle poll never fired').toBeGreaterThanOrEqual(1);
    expect(panelCbs.sessionEnded ?? null, 'the session ended before anything said so').toBeNull();

    await act(async () => {
      polls[polls.length - 1]?.(TERMINAL);
      await settle();
    });
    expect(panelCbs.sessionEnded?.reason, 'an in-time terminal verdict did not latch').toBe(
      'worker_closed',
    );
  });

  it('CRITICAL a terminal verdict from an OVERLAPPED tick still latches. Each tick bumps the shared epoch as it starts, so on a control plane slower than the 5s interval every response is invalidated by its successor — measured null before the fix, for the exact failure this poll was written to prevent.', async () => {
    const polls = holdThePoll();
    renderSim();
    act(() => panelCbs.onRoom?.(fakeRoom, fakeRoom));
    await act(async () => {
      await settle();
    });
    const firstTick = polls.length;

    // The next tick starts before the first has answered.
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(
      polls.length,
      'a second tick did not start, so nothing overlapped and this arm proves nothing',
    ).toBeGreaterThan(firstTick);

    // The FIRST tick finally answers, and it says the session is closed.
    await act(async () => {
      polls[firstTick - 1]?.(TERMINAL);
      await settle();
    });
    expect(
      panelCbs.sessionEnded?.reason,
      'a terminal verdict was discarded because a newer tick had started — on a slow control plane that is every verdict, and the session never reads as ended',
    ).toBe('worker_closed');
  });

  it('CRITICAL once a session has ended, a stale in-flight "still alive" response cannot un-end it. Terminal is one-way, and the mechanism is the effect TEARDOWN — latching sessionEnded re-runs the effect, whose cleanup sets `cancelled`, so responses already in flight are inert. Verified by mutation: an un-ending branch guarded by `!cancelled` never fires, and the same branch WITHOUT it fails this arm.', async () => {
    const polls = holdThePoll();
    renderSim();
    act(() => panelCbs.onRoom?.(fakeRoom, fakeRoom));
    await act(async () => {
      await settle();
    });
    const firstTick = polls.length;

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });

    // Newest tick says CLOSED and answers first.
    await act(async () => {
      polls[polls.length - 1]?.(TERMINAL);
      await settle();
    });
    expect(panelCbs.sessionEnded?.reason).toBe('worker_closed');

    // The stale tick then answers "still alive". Terminal is one-way; it must not win.
    await act(async () => {
      polls[firstTick - 1]?.(ALIVE);
      await settle();
    });
    expect(
      panelCbs.sessionEnded?.reason,
      'a stale non-terminal snapshot un-ended a closed session',
    ).toBe('worker_closed');
  });
});
