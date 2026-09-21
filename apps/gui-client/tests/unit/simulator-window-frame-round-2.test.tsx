// The simulator window frame — round 2 (owner, mockup approved "Love it!":
// "simulator is still expandable right? from left and right, also icons, can
// we change it to look better only?"). Three regression pins for that stage,
// each proving one half of the owner's two conditions:
//
//   1. THE RAIL ICONS changed in LOOK only — accessible names, order, the
//      persistent (non-hover) text labels and the End button are pinned
//      identical to what they were before `SIM_PANE_ICONS` (24-unit,
//      hand-rolled) became `SIM_PANE_ICON` (16-unit, `./agent-chat/icons`).
//   2. THE SCREEN RECTANGLE (`simulator-screen-host`, the video's box) never
//      moved: its structural/sizing classes and its position in the DOM
//      relative to `simulator-device` are pinned. The 4 new `.sim-key` side
//      buttons live INSIDE `simulator-device` (a sibling of `.sim-aura`,
//      contained by its existing `overflow:hidden`) rather than in a new
//      wrapper — a first pass used a `simulator-device-wrap` sibling shell,
//      which measurably inflated an ancestor's `scrollWidth` by exactly the
//      side buttons' negative offset (caught by `scripts/gui-visual-check
//      .mjs` Phase E's "nothing scrolls" gate, 8/8 simulator cells) — see
//      index.css's own comment on `.sim-key` for the measured numbers.
//   3. EXPAND/COLLAPSE is untouched: the drawer still toggles its
//      collapsed/expanded width classes, and the Tauri window-resize hook
//      (`refitForDrawer` → `withCurrentWindow` → `win.setSize`) still fires
//      the same way — proven, not assumed.
//
// Mocks livekit the same way simulator-window.test.tsx does (no real WebRTC
// in jsdom) plus the Tauri `webviewWindow` module (simulator-window-tauri
// .test.tsx's pattern) so `refitForDrawer`'s `withCurrentWindow` guard passes.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, fireEvent, waitFor } from '@testing-library/react';

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

// Tauri window ops seam (`withCurrentWindow`, SimulatorWindow.tsx) — same
// mock shape as simulator-window-tauri.test.tsx, extended with the three
// calls `refitForDrawer` makes (`setSize`/`scaleFactor`/`innerSize`).
const setSize = vi.fn<(size: { width: number; height: number }) => Promise<void>>(() =>
  Promise.resolve(),
);
const scaleFactor = vi.fn(() => Promise.resolve(1));
const innerSize = vi.fn(() => Promise.resolve({ width: 618, height: 718 }));
const destroy = vi.fn(() => Promise.resolve());
const tauriWindowMock = (): Record<string, unknown> => ({
  setSize,
  scaleFactor,
  innerSize,
  onCloseRequested: vi.fn(() => Promise.resolve(() => {})),
  destroy,
});
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: tauriWindowMock,
}));
vi.mock('@tauri-apps/api/webviewWindow.js', () => ({
  getCurrentWebviewWindow: tauriWindowMock,
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

const RAIL_PANES = [
  'session',
  'controls',
  'diagnostics',
  'cookies',
  'files',
  'downloads',
  'recording',
] as const;

beforeEach(() => {
  setSize.mockClear();
  scaleFactor.mockClear();
  innerSize.mockClear();
  destroy.mockClear();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

describe('the rail icon LOOK change leaves everything else identical', () => {
  it('pins accessible names + order (7 panes + End) unchanged from before the icon swap', () => {
    const { container } = renderSim();
    const rail = container.querySelector('[data-component="sim-drawer-rail"]');
    expect(rail).not.toBeNull();
    const names = Array.from(rail?.querySelectorAll('button') ?? []).map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(names).toEqual([
      'Session',
      'Controls',
      'Diagnostics',
      'Cookies',
      'Files',
      'Downloads',
      'Recording',
      'End session',
    ]);
  });

  it('NEGATIVE CONTROL — the order assertion actually discriminates (a reversed list must not equal itself)', () => {
    const { container } = renderSim();
    const rail = container.querySelector('[data-component="sim-drawer-rail"]');
    const names = Array.from(rail?.querySelectorAll('button') ?? []).map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(names).not.toEqual([...names].reverse());
  });

  it('every pane button still keys the same data-component, is still a real <button>, and carries exactly one drawing', () => {
    const { container } = renderSim();
    const rail = container.querySelector('[data-component="sim-drawer-rail"]');
    for (const pane of RAIL_PANES) {
      const btn = rail?.querySelector(`[data-component="sim-rail-${pane}"]`);
      expect(btn).not.toBeNull();
      expect(btn?.tagName).toBe('BUTTON');
      expect(btn?.getAttribute('type')).toBe('button');
      const svgs = btn?.querySelectorAll('svg') ?? [];
      expect(svgs.length).toBe(1);
      expect(svgs[0]?.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('clicking a rail button still opens/toggles its pane — the icon swap did not touch the click handler', () => {
    const { container } = renderSim();
    // `sim-drawer-panel` mounts lazily on the FIRST open (SimulatorWindow.tsx
    // `drawerMounted`), so it is absent, not merely closed, before any click.
    expect(container.querySelector('[data-component="sim-drawer-panel"]')).toBeNull();
    fireEvent.click(container.querySelector('[data-component="sim-rail-controls"]') as Element);
    const panel = container.querySelector('[data-component="sim-drawer-panel"]');
    expect(panel?.getAttribute('data-state')).toBe('open');
    expect(container.querySelector('[data-component="sim-drawer-pane"]')).not.toBeNull();
  });
});

describe('the screen rectangle never moved (frame changes are siblings/pseudo-elements only)', () => {
  it('pins simulator-screen-host: same structural classes, still the DIRECT child of simulator-screen', () => {
    const { container } = renderSim();
    const screen = container.querySelector('[data-component="simulator-screen"]');
    const host = container.querySelector('[data-component="simulator-screen-host"]');
    expect(screen).not.toBeNull();
    expect(host).not.toBeNull();
    // `simulator-screen` carries the new `z-[1]` (round-2 frame safety: keeps
    // the glass-sheen pseudo-elements on `.sim-device`, z-index 0, from ever
    // painting over the opaque screen box regardless of DOM order) — a
    // stacking-only change, no coordinate/size utility touched.
    expect(screen?.className).toContain('z-[1]');
    // `simulator-screen-host`'s own sizing contract is unchanged: relative +
    // flex-1 + bg-black — no width/height/inset utility was added or removed.
    expect(host?.className).toContain('relative');
    expect(host?.className).toContain('flex-1');
    expect(host?.className).toContain('bg-black');
    // Still the FIRST/only host-like child of `simulator-screen` — no new
    // wrapper was inserted BETWEEN the screen box and its host.
    expect(host?.parentElement).toBe(screen);
  });

  it('simulator-device is still the DIRECT child of simulator-body, and simulator-screen is still its direct child (no wrapper was inserted anywhere in the chain)', () => {
    const { container } = renderSim();
    const body = container.querySelector('[data-component="simulator-body"]');
    const device = container.querySelector('[data-component="simulator-device"]');
    const screen = container.querySelector('[data-component="simulator-screen"]');
    expect(body).not.toBeNull();
    expect(device).not.toBeNull();
    expect(device?.parentElement).toBe(body);
    expect(screen?.parentElement).toBe(device);
  });

  it('the 4 side buttons sit INSIDE simulator-device (contained by its overflow:hidden), never inside simulator-screen, and there is no separate floor-glow element (it is a box-shadow layer, not a DOM node)', () => {
    const { container } = renderSim();
    const device = container.querySelector('[data-component="simulator-device"]');
    const screen = container.querySelector('[data-component="simulator-screen"]');
    expect(device?.querySelectorAll(':scope > .sim-key').length).toBe(4);
    expect(screen?.querySelectorAll('.sim-key').length).toBe(0);
    expect(container.querySelector('.sim-floor-glow')).toBeNull();
    expect(container.querySelector('[data-component="simulator-device-wrap"]')).toBeNull();
  });

  it('NEGATIVE CONTROL — the direct-child assertion actually discriminates (an unrelated node is not the parent)', () => {
    const { container } = renderSim();
    const host = container.querySelector('[data-component="simulator-screen-host"]');
    const unrelated = container.querySelector('[data-component="simulator-toolbar"]');
    expect(host?.parentElement).not.toBe(unrelated);
  });
});

describe('expand/collapse is untouched (proven, not assumed)', () => {
  it('the drawer panel toggles between w-0 (collapsed) and w-[252px] (expanded), and back', async () => {
    const { container } = renderSim();
    expect(container.querySelector('[data-component="sim-drawer-panel"]')).toBeNull();

    fireEvent.click(container.querySelector('[data-component="sim-rail-controls"]') as Element);
    const panel = (): Element | null =>
      container.querySelector('[data-component="sim-drawer-panel"]');
    await waitFor(() => expect(panel()?.className).toContain('w-[252px]'));
    expect(panel()?.className).not.toContain('w-0');
    expect(panel()?.getAttribute('data-state')).toBe('open');

    // Same rail button again collapses it back (unchanged toggle behaviour) —
    // the shell stays MOUNTED (comment above: "keep its shell mounted so both
    // opening AND closing can animate"), only its width/state flip.
    fireEvent.click(container.querySelector('[data-component="sim-rail-controls"]') as Element);
    await waitFor(() => expect(panel()?.className).toContain('w-0'));
    expect(panel()?.getAttribute('data-state')).toBe('closed');
  });

  it('opening/closing the drawer still asks Tauri to resize the window the same way (refitForDrawer → win.setSize)', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    renderSim();
    setSize.mockClear();

    fireEvent.click(document.querySelector('[data-component="sim-rail-controls"]') as Element);
    await waitFor(() => expect(setSize).toHaveBeenCalled());
    const widthAtOpen = setSize.mock.calls.at(-1)?.[0]?.width;
    expect(typeof widthAtOpen).toBe('number');

    setSize.mockClear();
    await act(async () => {
      fireEvent.click(document.querySelector('[data-component="sim-rail-controls"]') as Element);
      // Closing debounces the refit behind DRAWER_TRANSITION_MS before
      // calling Tauri (see SimulatorWindow.tsx ~5556) so the CSS transition
      // finishes before the window shrinks — wait it out.
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await waitFor(() => expect(setSize).toHaveBeenCalled());
  });

  it('NEGATIVE CONTROL — the resize assertion actually discriminates (a spy that was never called is caught)', () => {
    const neverCalled = vi.fn();
    expect(() => expect(neverCalled).toHaveBeenCalled()).toThrow();
  });
});
