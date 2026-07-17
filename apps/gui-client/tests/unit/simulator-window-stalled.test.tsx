// SimulatorWindow — the 'stalled' frozen-renderer badge (A3 W2845). When the box
// reports pageState{state:'stalled'} (the renderer hung — hung JS / compositor
// deadlock — so the LiveKit pump just repeats the last frame and the stream still
// looks "live"), the GUI overlays a calm, NON-black "Reconnecting — page
// unresponsive" indicator on the (still-visible) last frame, and clears it the
// moment any non-stalled state arrives. Own file so the AgentSessionPanel→room
// mock (which surfaces a fake connected Room) doesn't leak into the base suite.

import { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
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
  AgentSessionPanel: (props: { onRoom?: (room: unknown, ownerRoom: unknown) => void }) => {
    useEffect(() => {
      props.onRoom?.(fakeRoom, fakeRoom);
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

  // #4 — TTL the latched 'stalled' badge. The server page-state store has NO TTL, so
  // a ONE-TIME stall (the renderer recovered without emitting a fresh non-stalled
  // frame) would re-apply on every poll and keep the badge lit FOREVER. The badge
  // must auto-clear once no fresh 'stalled' frame has arrived within the TTL. Fake
  // timers are installed BEFORE render so the 1s TTL-sweep interval is itself a fake
  // timer that advanceTimersByTime can drive.
  describe('#4 — stalled badge TTL', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('auto-clears the latched stalled badge after the TTL when no fresh stalled frame arrives', () => {
      vi.useFakeTimers();
      const { container } = renderSim();
      // The panel mock fires onRoom in an effect (runs during render's act); flush so
      // the data-channel consumer subscribes.
      act(() => {
        vi.advanceTimersByTime(0);
      });
      expect(fakeRoom.on.mock.calls.some((c) => c[0] === 'dataReceived')).toBe(true);
      // A single stalled frame lights the badge…
      act(() => {
        fireDataFrame({ state: 'stalled', url: 'https://app.example' });
      });
      expect(container.querySelector('[data-component="page-stalled-badge"]')).not.toBeNull();
      // …and with NO further stalled frame the TTL sweep self-clears it (the store
      // re-applying a one-time stall would otherwise keep it lit forever).
      act(() => {
        // STALLED_BADGE_TTL_MS is 12s; advance well past it.
        vi.advanceTimersByTime(15_000);
      });
      expect(container.querySelector('[data-component="page-stalled-badge"]')).toBeNull();
    });

    it('keeps the badge lit while fresh stalled frames keep arriving (a real ongoing stall re-stamps the TTL)', () => {
      vi.useFakeTimers();
      const { container } = renderSim();
      act(() => {
        vi.advanceTimersByTime(0);
      });
      expect(fakeRoom.on.mock.calls.some((c) => c[0] === 'dataReceived')).toBe(true);
      act(() => {
        fireDataFrame({ state: 'stalled', url: 'https://app.example' });
      });
      // Advance in sub-TTL steps, re-reporting 'stalled' each time — a genuinely
      // still-frozen page keeps re-sending, so the badge must stay lit throughout.
      for (let i = 0; i < 5; i++) {
        act(() => {
          vi.advanceTimersByTime(5_000);
          fireDataFrame({ state: 'stalled', url: 'https://app.example' });
        });
        expect(container.querySelector('[data-component="page-stalled-badge"]')).not.toBeNull();
      }
    });
  });
});

// W616 — page-NAVIGATION error overlay. The standalone Simulator previously dropped
// the page_state{state:'errored'} payload: the loading bar vanished and the frozen
// last frame read as a blank successful load. Now it surfaces a per-kind error
// overlay (same copy as the in-app LiveSessionView) and clears it on any
// loading/loaded state.
describe('SimulatorWindow — page-navigation error overlay (W616)', () => {
  beforeEach(() => {
    fakeRoom.on.mockClear();
  });

  it('shows the error overlay with per-kind copy on a pageState{state:errored} frame', async () => {
    const { container } = renderSim();
    await waitFor(() => {
      expect(fakeRoom.on.mock.calls.some((c) => c[0] === 'dataReceived')).toBe(true);
    });
    act(() => {
      fireDataFrame({
        state: 'errored',
        url: 'https://nope.invalid/',
        error: { kind: 'dns', message: 'lookup failed' },
      });
    });
    const overlay = container.querySelector('[data-component="page-error-overlay"]');
    expect(overlay).not.toBeNull();
    // DNS kind → the address-check copy (shared lib/page-error-copy).
    expect(overlay?.textContent).toMatch(/find this site/i);
    expect(overlay?.textContent).toMatch(/page failed to load/i);
  });

  it('renders an HTTP-status-specific message for kind:http', async () => {
    const { container } = renderSim();
    await waitFor(() => {
      expect(fakeRoom.on.mock.calls.some((c) => c[0] === 'dataReceived')).toBe(true);
    });
    act(() => {
      fireDataFrame({
        state: 'errored',
        url: 'https://app.example/',
        error: { kind: 'http', http_status: 503, message: 'service unavailable' },
      });
    });
    expect(container.querySelector('[data-component="page-error-overlay"]')?.textContent).toMatch(
      /HTTP 503/,
    );
  });

  it('clears the error overlay when a subsequent loading/loaded frame arrives', async () => {
    const { container } = renderSim();
    await waitFor(() => {
      expect(fakeRoom.on.mock.calls.some((c) => c[0] === 'dataReceived')).toBe(true);
    });
    act(() => {
      fireDataFrame({ state: 'errored', url: 'https://x/', error: { kind: 'net', message: 'x' } });
    });
    expect(container.querySelector('[data-component="page-error-overlay"]')).not.toBeNull();
    act(() => {
      fireDataFrame({ state: 'loaded', url: 'https://x/' });
    });
    expect(container.querySelector('[data-component="page-error-overlay"]')).toBeNull();
  });
});

// #72 — a LATE 'errored' frame AFTER the page already reached 'loaded'+painted is a
// sub-resource / late-request failure, NOT a top-level navigation failure. It must
// NOT pop the full-screen overlay over a working page (which would invite a "Try
// again" full refresh that nukes a perfectly good page — the founder's exact report).
// The overlay is honored ONLY before the page ever loaded.
describe('SimulatorWindow — late sub-resource error does not nuke a loaded page (#72)', () => {
  beforeEach(() => {
    fakeRoom.on.mockClear();
  });

  it('suppresses the error overlay when an errored frame arrives AFTER the page loaded', async () => {
    const { container } = renderSim();
    await waitFor(() => {
      expect(fakeRoom.on.mock.calls.some((c) => c[0] === 'dataReceived')).toBe(true);
    });
    // The page opens + paints (loaded), THEN a smaller late request fails (errored).
    act(() => {
      fireDataFrame({ state: 'loaded', url: 'https://app.example/' });
    });
    act(() => {
      fireDataFrame({
        state: 'errored',
        url: 'https://app.example/',
        error: { kind: 'net', message: 'a beacon failed' },
      });
    });
    // No overlay — the working page stays on screen, no forced refresh.
    expect(container.querySelector('[data-component="page-error-overlay"]')).toBeNull();
  });

  it('STILL shows the overlay for a top-level failure (errored before any loaded)', async () => {
    const { container } = renderSim();
    await waitFor(() => {
      expect(fakeRoom.on.mock.calls.some((c) => c[0] === 'dataReceived')).toBe(true);
    });
    // A fresh navigation that fails before ever loading → a real nav failure.
    act(() => {
      fireDataFrame({ state: 'loading', url: 'https://nope.invalid/' });
    });
    act(() => {
      fireDataFrame({
        state: 'errored',
        url: 'https://nope.invalid/',
        error: { kind: 'dns', message: 'lookup failed' },
      });
    });
    expect(container.querySelector('[data-component="page-error-overlay"]')).not.toBeNull();
  });
});
