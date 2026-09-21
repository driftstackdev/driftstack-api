// ⛔ THE VIDEO ELEMENT SURVIVES THE FRAME.
//
// The AI view has its own named test for this exact defect class
// (`the-iphone-does-not-remount-when-the-window-does.test.tsx`): React
// remounts a child when its position among its siblings changes, when its
// key changes, or when a conditional WRAPPER appears or disappears around
// it. The simulator round-2 frame (owner: "also icons, can we change it to
// look better only?") adds four new `.sim-key` side-button spans as
// UNCONDITIONAL siblings of `.sim-aura` inside `simulator-device` (a first
// pass instead added a whole new `simulator-device-wrap` ancestor — dropped
// after `scripts/gui-visual-check.mjs` Phase E measured it inflating an
// ancestor's `scrollWidth`; see index.css's `.sim-key` comment). A remount
// here is not cosmetic: it would tear down and rebuild the
// `AgentSessionPanel`/LiveKit room inside `simulator-screen-host` — the
// founder watches the phone go black and come back — and no screenshot can
// show it, because every frame still looks right.
//
// This holds the identity of three elements — the bezel, the screen, and the
// screen host — across two things that change beneath them without
// touching the frame at all: a DRAWER PANE switch (open → different pane →
// closed). If a future edit puts `.sim-key` behind a condition, or moves it
// back into a sibling wrapper inconsistently, this fails with a clear
// identity break instead of a silent black-video bug.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

const fakeRoom = {
  on: vi.fn(),
  off: vi.fn(),
  disconnect: vi.fn(() => Promise.resolve()),
  localParticipant: { publishData: vi.fn(() => Promise.resolve()) },
};

vi.mock('../../src/lib/livekit', () => ({
  createLivekitRoom: () => fakeRoom,
  connectToAgentSession: () => new Promise(() => {}),
  sendInputEvent: vi.fn(() => Promise.resolve()),
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    Disconnected: 'disconnected',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
  },
}));

vi.mock('../../src/lib/agent-session-control', () => ({
  getAgentSession: () =>
    Promise.resolve({
      mode: 'manual',
      pairKind: null,
      terminal: false,
      status: 'active',
      closedReason: null,
      capabilityReport: { manual_input_available: true },
    }),
  getAgentSessionPageState: () => Promise.resolve(null),
  getAgentSessionCookies: () => Promise.resolve({ status: 'unavailable', cookies: null }),
  setAgentSessionCookies: vi.fn(),
  navigateAgentSessionHistory: vi.fn(),
  uploadAgentSessionFile: vi.fn(() => Promise.resolve({ status: 'unavailable', handle: null })),
  listAgentSessionDownloads: vi.fn(() => Promise.resolve({ status: 'unavailable', files: null })),
  fetchAgentSessionDownload: vi.fn(() => Promise.resolve({ status: 'unavailable', file: null })),
  setSessionMode: vi.fn(),
  takeoverSession: vi.fn(),
  handbackSession: vi.fn(),
  sendAgentMessage: vi.fn(),
  endAgentSession: vi.fn(),
  AgentSessionControlError: class extends Error {},
}));

const EMPTY_CONN = {
  transport: null,
  relayed: null,
  rttMs: null,
  packetLossPct: null,
  jitterMs: null,
  decodeFps: null,
  freezeCount: null,
};
vi.mock('../../src/lib/livekit-connection-stats', () => ({
  useConnectionStats: () => EMPTY_CONN,
  useTransportTelemetry: () => undefined,
  CONNECTION_STATS_INTERVAL_MS: 3000,
}));

const { SimulatorWindow } = await import('../../src/views/SimulatorWindow');
const { RecordingsProvider } = await import('../../src/lib/recordings');

function renderSim(): ReturnType<typeof render> {
  window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_x');
  return render(
    <RecordingsProvider>
      <SimulatorWindow />
    </RecordingsProvider>,
  );
}

beforeEach(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

function frameNodes(container: HTMLElement): {
  device: Element | null;
  screen: Element | null;
  host: Element | null;
} {
  return {
    device: container.querySelector('[data-component="simulator-device"]'),
    screen: container.querySelector('[data-component="simulator-screen"]'),
    host: container.querySelector('[data-component="simulator-screen-host"]'),
  };
}

describe('the frame survives a drawer pane switch', () => {
  it('the bezel, the screen and the screen host keep IDENTITY across open → different pane → close', async () => {
    const { container } = renderSim();
    const before = frameNodes(container);
    expect(before.device).not.toBeNull();
    expect(before.screen).not.toBeNull();
    expect(before.host).not.toBeNull();

    fireEvent.click(container.querySelector('[data-component="sim-rail-controls"]') as Element);
    await waitFor(() =>
      expect(container.querySelector('[data-component="sim-drawer-panel"]')).not.toBeNull(),
    );
    const duringControls = frameNodes(container);
    expect(duringControls.device).toBe(before.device);
    expect(duringControls.screen).toBe(before.screen);
    expect(duringControls.host).toBe(before.host);

    fireEvent.click(container.querySelector('[data-component="sim-rail-diagnostics"]') as Element);
    await waitFor(() =>
      expect(
        container.querySelector('[data-component="sim-drawer-panel"]')?.getAttribute('data-state'),
      ).toBe('open'),
    );
    const duringDiagnostics = frameNodes(container);
    expect(duringDiagnostics.device).toBe(before.device);
    expect(duringDiagnostics.screen).toBe(before.screen);
    expect(duringDiagnostics.host).toBe(before.host);

    fireEvent.click(container.querySelector('[data-component="sim-rail-diagnostics"]') as Element);
    await waitFor(() =>
      expect(
        container.querySelector('[data-component="sim-drawer-panel"]')?.getAttribute('data-state'),
      ).toBe('closed'),
    );
    const after = frameNodes(container);
    expect(after.device).toBe(before.device);
    expect(after.screen).toBe(before.screen);
    expect(after.host).toBe(before.host);
  });

  it('the 4 side buttons are the SAME 4 nodes across the same transitions (never toggled off/on)', async () => {
    const { container } = renderSim();
    const device = () => container.querySelector('[data-component="simulator-device"]');
    const keys = (): Element[] => Array.from(device()?.querySelectorAll(':scope > .sim-key') ?? []);
    const before = keys();
    expect(before.length).toBe(4);

    fireEvent.click(container.querySelector('[data-component="sim-rail-files"]') as Element);
    await waitFor(() =>
      expect(container.querySelector('[data-component="sim-drawer-panel"]')).not.toBeNull(),
    );
    const after = keys();
    expect(after.length).toBe(4);
    for (let i = 0; i < 4; i += 1) expect(after[i]).toBe(before[i]);
  });

  it('NEGATIVE CONTROL — identity comparison actually discriminates (two different elements are not `toBe`)', () => {
    const { container } = renderSim();
    const a = container.querySelector('[data-component="simulator-device"]');
    const b = container.querySelector('[data-component="simulator-toolbar"]');
    expect(a).not.toBe(b);
  });
});
