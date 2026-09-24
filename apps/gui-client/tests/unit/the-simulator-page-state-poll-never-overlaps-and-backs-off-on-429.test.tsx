// GUI audit #12 — the Simulator's page-state poll ran on a fixed interval (2 s, and
// 500 ms while a navigation is pending) with a 15 s deadline per request, so against
// a slow control plane it could hold ~30 requests open at once, and it ignored a 429.
// It now keeps its cadence but skips a tick while the previous request is still out
// (lib/guarded-poll), and a 429 holds it back by the server's Retry-After.
//
// Harness copied from simulator-window-pagestate-poll.test.tsx (the real
// SimulatorWindow, a controllable page-state mock, fake timers).

import { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';

const sendNavigate = vi.fn(() => Promise.resolve());
// Controllable page-state poll — each test sets what the ~2s poll returns.
const pageStateMock = vi.fn(() => Promise.resolve<unknown>(null));
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

vi.mock('../../src/lib/livekit', () => ({
  createLivekitRoom: () => ({ on: vi.fn(), disconnect: vi.fn() }),
  connectToAgentSession: () => new Promise(() => {}),
  sendInputEvent: vi.fn(() => Promise.resolve()),
  sendNavigate: (...a: unknown[]) => sendNavigate(...(a as [])),
  sendTabListUpdate: vi.fn(() => Promise.resolve()),
  sendActivateTab: vi.fn(() => Promise.resolve('req_test')),
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    Disconnected: 'disconnected',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
    DataReceived: 'dataReceived',
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
    onStateChange?: (s: { kind: string }, room: unknown) => void;
    onPublisher?: (p: string, room: unknown) => void;
  }) => {
    useEffect(() => {
      props.onRoom?.(fakeRoom, fakeRoom);
      props.onStateChange?.({ kind: 'connected' }, fakeRoom);
      props.onPublisher?.('publishing', fakeRoom);
    }, [props]);
    return <div data-component="agent-session-panel-mock" />;
  },
}));

// Typed to the REAL signature (id, challengeId, auth?) rather than a bare
// zero-arg stub: an untyped `vi.fn(() => …)` has an empty call tuple, so the
// spread below is a type error and `mock.calls[0][1]` — the challenge id this
// suite exists to assert — is not even indexable.
const resumeChallengedSessionMock = vi.fn<
  (id: string, challengeId: string | null, auth?: unknown) => Promise<void>
>(() => Promise.resolve());
vi.mock('../../src/lib/agent-session-control', () => ({
  resumeChallengedSession: (id: string, challengeId: string | null, auth?: unknown) =>
    resumeChallengedSessionMock(id, challengeId, auth),
  uploadAgentSessionFile: vi.fn(() => Promise.resolve({ status: 'unavailable', handle: null })),
  listAgentSessionDownloads: vi.fn(() => Promise.resolve({ status: 'unavailable', files: null })),
  fetchAgentSessionDownload: vi.fn(() => Promise.resolve({ status: 'unavailable', file: null })),
  getAgentSession: () =>
    immediateControl({
      mode: 'manual',
      pairKind: null,
      status: 'active',
      terminal: false,
      capabilityReport: { manual_input_available: true },
    }),
  getAgentSessionPageState: () => pageStateMock(),
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

// Let pending promises (the poll result) resolve + React flush, under fake timers.
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// Advance the fake clock by `ms` and flush the resulting poll tick + React updates.
async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('SimulatorWindow — the page-state poll never overlaps and backs off on 429', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeRoom.on.mockClear();
    pageStateMock.mockReset();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('CRITICAL a request the server has not answered is never joined by another', async () => {
    pageStateMock.mockImplementation(() => new Promise(() => {}));
    renderSim();
    await flush();
    const first = pageStateMock.mock.calls.length;
    expect(first).toBe(1);
    await advance(20_000);
    expect(pageStateMock.mock.calls.length).toBe(first);
  });

  it('CRITICAL a 429 holds the next request back by its Retry-After', async () => {
    pageStateMock.mockImplementation(() =>
      Promise.reject(
        Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 30_000 }),
      ),
    );
    renderSim();
    await flush();
    expect(pageStateMock.mock.calls.length).toBe(1);
    await advance(25_000);
    expect(pageStateMock.mock.calls.length).toBe(1);
    await advance(10_000);
    expect(pageStateMock.mock.calls.length).toBe(2);
  });

  it('CONTROL — a healthy session is still polled about every 2 s', async () => {
    pageStateMock.mockResolvedValue(null);
    renderSim();
    await flush();
    // A tick at a time, so each request settles before the next is due.
    for (let i = 0; i < 5; i += 1) await advance(2_000);
    expect(pageStateMock.mock.calls.length).toBeGreaterThanOrEqual(5);
  });
});
