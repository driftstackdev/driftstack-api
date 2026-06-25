// SimulatorWindow — the 'stalled' frozen-renderer badge (A3 W2845). When the box
// reports pageState{state:'stalled'} (the renderer hung — hung JS / compositor
// deadlock — so the LiveKit pump just repeats the last frame and the stream still
// looks "live"), the GUI overlays a calm, NON-black "Reconnecting — page
// unresponsive" indicator on the (still-visible) last frame, and clears it the
// moment any non-stalled state arrives. Own file so the AgentSessionPanel→room
// mock (which surfaces a fake connected Room) doesn't leak into the base suite.

import { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';

vi.mock('../../src/lib/livekit', () => ({
  createLivekitRoom: () => ({ on: vi.fn(), disconnect: vi.fn() }),
  connectToAgentSession: () => new Promise(() => {}),
  sendInputEvent: vi.fn(() => Promise.resolve()),
  sendNavigate: vi.fn(() => Promise.resolve()),
  // Browser-style page tabs (doc-150 item 4) — the component sends these on mount
  // (the seed tab's list publish); the mock must export them or the call throws.
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

// Surface a fake connected Room upward (jsdom can't do a real WebRTC connect) so
// the data-channel consumer subscribes. `on` records handlers so the test can fire
// a pageState frame; `off` + publishData keep the other effects from throwing.
const fakeRoom = {
  on: vi.fn(),
  off: vi.fn(),
  localParticipant: { publishData: vi.fn(() => Promise.resolve()) },
};
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: (props: { onRoom?: (room: unknown) => void }) => {
    useEffect(() => {
      props.onRoom?.(fakeRoom);
    }, [props]);
    return <div data-component="agent-session-panel-mock" />;
  },
}));

// Control transport — manual mode (full chrome). The page-state POLL resolves null
// so ONLY the data channel drives the badge in these tests (deterministic).
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

// Fire a page_state frame to every DataReceived subscriber (the page-state consumer
// + the latency-ping hook both subscribe; the latter ignores a non-ping message).
function fireDataFrame(obj: unknown): void {
  const payload = new TextEncoder().encode(JSON.stringify(obj));
  fakeRoom.on.mock.calls
    .filter((c) => c[0] === 'dataReceived')
    .forEach((c) => {
      try {
        (c[1] as (p: Uint8Array) => void)(payload);
      } catch {
        /* a non-page-state DataReceived subscriber (latency ping) — ignores it */
      }
    });
}

describe('SimulatorWindow — stalled (frozen-renderer) badge (A3 W2845)', () => {
  beforeEach(() => {
    fakeRoom.on.mockClear();
  });

  it('shows a non-black "Reconnecting — page unresponsive" badge on a pageState{state:stalled} data-channel frame', async () => {
    const { container } = renderSim();
    await waitFor(() => {
      expect(fakeRoom.on.mock.calls.some((c) => c[0] === 'dataReceived')).toBe(true);
    });
    act(() => {
      fireDataFrame({ state: 'stalled', url: 'https://app.example' });
    });
    const badge = container.querySelector('[data-component="page-stalled-badge"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toMatch(/unresponsive/i);
  });

  it('clears the stalled badge when a subsequent non-stalled (loaded) frame arrives', async () => {
    const { container } = renderSim();
    await waitFor(() => {
      expect(fakeRoom.on.mock.calls.some((c) => c[0] === 'dataReceived')).toBe(true);
    });
    act(() => {
      fireDataFrame({ state: 'stalled', url: 'https://app.example' });
    });
    expect(container.querySelector('[data-component="page-stalled-badge"]')).not.toBeNull();
    act(() => {
      fireDataFrame({ state: 'loaded', url: 'https://app.example' });
    });
    expect(container.querySelector('[data-component="page-stalled-badge"]')).toBeNull();
  });
});
