// SimulatorWindow — the client-side VIDEO-FREEZE badge ("Video frozen — reconnecting").
// A pure client decode stall (decodeFps holds 0 for ~4s after frames were flowing)
// surfaces a calm freeze pill over the last frame. The badge must NOT fire during a
// LiveKit transport drop (disconnected/reconnecting): the panel's own "The live stream
// disconnected" overlay is the single source of truth there, and showing BOTH was a
// contradictory double-message (edge-errors review). Own file so the panel→room +
// connection-stats mocks don't leak into the base suite.

import { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';

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

// Controllable decode-fps so the test can drive frames-flowing → frozen.
const conn = {
  transport: null as string | null,
  relayed: null as boolean | null,
  rttMs: null as number | null,
  packetLossPct: null as number | null,
  jitterMs: null as number | null,
  decodeFps: null as number | null,
  freezeCount: null as number | null,
};
vi.mock('../../src/lib/livekit-connection-stats', () => ({
  useConnectionStats: () => conn,
  CONNECTION_STATS_INTERVAL_MS: 3000,
}));

// The panel mock surfaces a fake room + driveable connection/publisher state.
const fakeRoom = {
  on: vi.fn(),
  off: vi.fn(),
  localParticipant: { publishData: vi.fn(() => Promise.resolve()) },
};
const panelCbs: {
  onStateChange?: (s: { kind: string }) => void;
  onPublisher?: (p: string) => void;
} = {};
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: (props: {
    onRoom?: (room: unknown) => void;
    onStateChange?: (s: { kind: string }) => void;
    onPublisher?: (p: string) => void;
  }) => {
    panelCbs.onStateChange = props.onStateChange;
    panelCbs.onPublisher = props.onPublisher;
    // Fire the initial live state ONCE (empty deps). Re-asserting 'connected' on every
    // render would clobber a test-driven 'reconnecting' transition.
    useEffect(() => {
      props.onRoom?.(fakeRoom);
      props.onStateChange?.({ kind: 'connected' });
      props.onPublisher?.('publishing');
    }, []);
    return <div data-component="agent-session-panel-mock" />;
  },
}));

vi.mock('../../src/lib/agent-session-control', () => ({
  uploadAgentSessionFile: vi.fn(() => Promise.resolve({ status: 'unavailable', handle: null })),
  listAgentSessionDownloads: vi.fn(() => Promise.resolve({ status: 'unavailable', files: null })),
  fetchAgentSessionDownload: vi.fn(() => Promise.resolve({ status: 'unavailable', file: null })),
  getAgentSession: () => Promise.resolve({ mode: 'manual', pairKind: null }),
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

function frozenBadge(c: HTMLElement): Element | null {
  return c.querySelector('[data-component="video-frozen-badge"]');
}

describe('SimulatorWindow — client video-freeze badge', () => {
  beforeEach(() => {
    conn.decodeFps = null;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flags a freeze while CONNECTED (frames flowed, then decodeFps holds 0 for ~4s)', () => {
    vi.useFakeTimers();
    conn.decodeFps = 30; // frames flowing
    const { container } = renderSim();
    // No freeze while frames flow.
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(frozenBadge(container)).toBeNull();
    // Decode stalls (still connected). After the 4s threshold the badge shows.
    conn.decodeFps = 0;
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(frozenBadge(container)).not.toBeNull();
  });

  it('does NOT flag a freeze when the connection itself dropped (panel overlay owns that)', () => {
    vi.useFakeTimers();
    conn.decodeFps = 30;
    const { container } = renderSim();
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    // The transport drops — decodeFps naturally goes to 0, but the connection is no
    // longer 'connected'. The freeze badge must stay suppressed (the panel's
    // disconnected overlay is the single source of truth).
    act(() => {
      panelCbs.onStateChange?.({ kind: 'reconnecting' });
    });
    conn.decodeFps = 0;
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(frozenBadge(container)).toBeNull();
  });
});
