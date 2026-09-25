// A page that took too long to LOAD is not a page that FROZE.
//
// The phone reports both as `stalled`: a load that timed out carries
// `error.kind: 'timeout'` (the soft "taking longer to load" advisory), a frozen
// renderer carries no error (the "page unresponsive" badge). The live data
// channel told them apart; the 2 s page-state POLL did not — it raised the
// unresponsive badge for any `stalled`. Once the phone's timeout terminal
// reaches the server's stored copy, every poll would have lit "page
// unresponsive" for up to two minutes over a page that is not frozen. Both
// paths now read one helper (`isFreezeStall`), so they cannot drift.

import { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';

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
  sendNavigate: vi.fn(() => Promise.resolve()),
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

vi.mock('../../src/lib/agent-session-control', () => ({
  resumeChallengedSession: vi.fn(() => Promise.resolve()),
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

function fireDataFrame(obj: unknown): void {
  const payload = new TextEncoder().encode(JSON.stringify(obj));
  fakeRoom.on.mock.calls
    .filter((c) => c[0] === 'dataReceived')
    .forEach((c) => {
      try {
        (c[1] as (p: Uint8Array) => void)(payload);
      } catch {
        /* a non-page_state subscriber ignores this frame */
      }
    });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

const unresponsive = (c: HTMLElement): Element | null =>
  c.querySelector('[data-component="page-stalled-badge"]');

describe('a load that timed out is not a frozen page — on the poll path too', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeRoom.on.mockClear();
    pageStateMock.mockReset();
    pageStateMock.mockResolvedValue(null);
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('CRITICAL a polled `stalled` with error.kind "timeout" never raises "page unresponsive"', async () => {
    const { container } = renderSim();
    await flush();
    pageStateMock.mockResolvedValue({
      state: 'stalled',
      url: 'https://slow.example/',
      error: { kind: 'timeout', message: 'navigation is still pending' },
    });
    for (let i = 0; i < 3; i += 1) {
      await advance(2000);
      expect(unresponsive(container), `poll ${String(i + 1)}`).toBeNull();
    }
  });

  it('CONTROL — a polled freeze `stalled` (no timeout kind, no fresh live frame) still raises it', async () => {
    const { container } = renderSim();
    await flush();
    pageStateMock.mockResolvedValue({ state: 'stalled', url: 'https://frozen.example/' });
    await advance(2000);
    expect(unresponsive(container)).not.toBeNull();
  });

  it('CONTROL — the live channel keeps the same rule: timeout no, freeze yes', async () => {
    const { container } = renderSim();
    await flush();
    act(() =>
      fireDataFrame({
        state: 'stalled',
        url: 'https://slow.example/',
        error: { kind: 'timeout', message: 'navigation is still pending' },
      }),
    );
    expect(unresponsive(container)).toBeNull();
    act(() => fireDataFrame({ state: 'stalled', url: 'https://frozen.example/' }));
    expect(unresponsive(container)).not.toBeNull();
  });
});
