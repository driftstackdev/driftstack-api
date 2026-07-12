// SimulatorWindow (floating-iPhone window, founder 2026-06-11) — validates the
// device frame renders from the URL query, and the bezel-vs-screen drag-region
// split (drag the frame to move the window; taps on the screen reach the
// device). Mocks the livekit wrapper so no real WebRTC spins up in jsdom.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

vi.mock('../../src/lib/livekit', () => ({
  createLivekitRoom: () => ({ on: vi.fn(), disconnect: vi.fn() }),
  connectToAgentSession: () => new Promise(() => {}), // stays connecting
  sendInputEvent: vi.fn(() => Promise.resolve()),
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    Disconnected: 'disconnected',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
  },
}));

// The transport diagnostic hook reads a live RTCStatsReport; in jsdom there's no
// real track, so drive it with a controllable stub for the fallback-badge test.
const EMPTY_CONN = {
  transport: null,
  relayed: null,
  rttMs: null,
  packetLossPct: null,
  jitterMs: null,
  decodeFps: null,
  freezeCount: null,
};
let mockConn: typeof EMPTY_CONN = { ...EMPTY_CONN };
vi.mock('../../src/lib/livekit-connection-stats', () => ({
  useConnectionStats: () => mockConn,
  // #60 transport telemetry is a side-effect-only hook (returns void); stub it as
  // a no-op so SimulatorWindow renders without the real POST.
  useTransportTelemetry: () => undefined,
  CONNECTION_STATS_INTERVAL_MS: 3000,
}));

const { SimulatorWindow } = await import('../../src/views/SimulatorWindow');
const { RecordingsProvider } = await import('../../src/lib/recordings');

describe('SimulatorWindow — floating iPhone', () => {
  // The drawer starts COLLAPSED (rail icons only; founder 2026-06-24 — no auto-open).
  // jsdom in this project ships a non-functional localStorage (its methods throw), so
  // install a working Map-backed one. (ds-sim-navigated is legacy — it no longer drives
  // any auto-open; harmless to leave seeded.)
  const lsStore = new Map<string, string>();
  beforeEach(() => {
    mockConn = { ...EMPTY_CONN };
    lsStore.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string): string | null => lsStore.get(k) ?? null,
      setItem: (k: string, v: string): void => {
        lsStore.set(k, v);
      },
      removeItem: (k: string): void => {
        lsStore.delete(k);
      },
      clear: (): void => lsStore.clear(),
      key: (): string | null => null,
      length: 0,
    });
    localStorage.setItem('ds-sim-navigated', '1');
    // Browser mode defaults ON (founder 2026-06-21); most tests assert the
    // device-identity toolbar, so default them to OFF. The browser-mode test
    // overrides to exercise the on/default path.
    localStorage.setItem('ds-sim-browser-mode', '0');
  });

  it('renders the device frame + screen when ws/token are present in the query', () => {
    window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok');
    const { container } = render(
      <RecordingsProvider>
        <SimulatorWindow />
      </RecordingsProvider>,
    );
    const device = container.querySelector('[data-component="simulator-device"]');
    const screen = container.querySelector('[data-component="simulator-screen"]');
    expect(device).not.toBeNull();
    expect(screen).not.toBeNull();
    // The bezel is a window drag-region; the screen overrides it so taps reach
    // the device (the Xcode-simulator drag-the-frame / tap-the-screen split).
    expect(device?.getAttribute('data-tauri-drag-region')).toBe('true');
    expect(screen?.getAttribute('data-tauri-drag-region')).toBe('false');
  });

  it('renders the iOS status bar as a dedicated strip ABOVE the content (never overlapping the page)', () => {
    window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok');
    const { container } = render(
      <RecordingsProvider>
        <SimulatorWindow />
      </RecordingsProvider>,
    );
    const statusBar = container.querySelector('[data-component="simulator-statusbar"]');
    expect(statusBar).not.toBeNull();
    // Live clock in iOS h:mm shape (no leading-zero hour, no AM/PM).
    expect(statusBar?.textContent).toMatch(/^\d{1,2}:\d{2}$/);
    // Cellular / Wi-Fi / battery glyphs.
    expect(statusBar?.querySelectorAll('svg').length).toBe(3);
    // The bar IS a window drag-region (founder: drag the window by the status
    // strip) — the inner clock is pointer-events-none so a click on the strip
    // falls through to the bar and drags rather than landing on text.
    expect(statusBar?.getAttribute('data-tauri-drag-region')).toBe('true');
    expect(statusBar?.querySelector('span')?.className).toContain('pointer-events-none');
    // Founder 2026-06-12: the bar must NOT overlap browser content — it is a
    // reserved strip (first child of the screen, video below), not an absolute
    // overlay on the page pixels.
    const screen = container.querySelector('[data-component="simulator-screen"]');
    expect(screen?.firstElementChild).toBe(statusBar);
    expect(statusBar?.className).not.toContain('absolute');
    expect(statusBar?.className).toContain('shrink-0');
  });

  it('renders the Driftstack control toolbar above the device: device name + close/minimize + the keyboard toggle (controls live in the expandable panel)', () => {
    window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&name=iPhone%2017');
    const { container } = render(
      <RecordingsProvider>
        <SimulatorWindow />
      </RecordingsProvider>,
    );
    const toolbar = container.querySelector('[data-component="simulator-toolbar"]');
    expect(toolbar).not.toBeNull();
    // Device name (from the ?name= query) shows in the toolbar.
    expect(toolbar?.textContent).toContain('iPhone 17');
    // Window controls live in the slim bar. The window is BORDERLESS (the iPhone
    // look, founder 2026-06-18 "back like it was"), so close/minimize live here —
    // the separate Dock icon comes from the standalone app, not a title bar. (The
    // drawer is now an always-docked rail, so the old Show-controls chevron is gone.)
    // aria-labels are the contract.
    for (const label of ['Close', 'Minimize']) {
      expect(toolbar?.querySelector(`[aria-label="${label}"]`), label).not.toBeNull();
    }
    // Founder 2026-06-25: the recording dot was REMOVED from the chrome ("a dot for
    // recording which I don't like to be there") — recording lives in the drawer's
    // recording pane now, not the slim bar.
    expect(toolbar?.querySelector('[aria-label="Start recording"]')).toBeNull();
    // The on-screen keyboard toggle stays in the chrome.
    expect(toolbar?.querySelector('[data-component="simulator-keyboard-toggle"]')).not.toBeNull();
    // Founder 2026-06-17: the rotate / pin / info controls moved into
    // the EXPANDABLE panel, so the default (collapsed) chrome stays minimal —
    // they are NOT in the DOM until the panel is expanded.
    const wrap = container.querySelector('[data-component="simulator-toolbar-wrap"]');
    expect(wrap?.querySelector('[data-component="simulator-controls"]')).toBeNull();
    expect(
      wrap?.querySelector('[aria-label="Rotate to landscape"], [aria-label="Rotate to portrait"]'),
    ).toBeNull();
    // The toolbar is the window drag handle via a real OS startDragging on
    // pointer-down (data-tauri-drag-region was flaky on the borderless macOS
    // toolbar — founder 2026-06-18 "not the whole topbar drags"); the device
    // bezel remains an explicit drag region so the phone body drags too.
    expect(toolbar).not.toBeNull();
    const device = container.querySelector('[data-component="simulator-device"]');
    expect(device?.getAttribute('data-tauri-drag-region')).toBe('true');
    // The toolbar is wrapped (so the absolute control panel can anchor to it);
    // the WRAP is what sits directly above the device in the shell.
    const shell = container.querySelector('[data-component="simulator-shell"]');
    expect(shell?.firstElementChild).toBe(wrap);
    expect(wrap?.querySelector('[data-component="simulator-toolbar"]')).toBe(toolbar);
  });

  it('starts COLLAPSED on launch — only the rail icons show, nothing auto-opens (founder 2026-06-24); a rail click expands a pane', () => {
    // Founder: "when started, nothing should be toggled on from these icons." A fresh
    // user (never navigated) gets ONLY the docked rail — no pane, no Address bar — until
    // they click a rail icon. (Replaces the old auto-open-Controls discoverability; the
    // rail's hover tooltips cover that now.)
    localStorage.removeItem('ds-sim-navigated');
    window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&name=iPhone%2017');
    const { container } = render(
      <RecordingsProvider>
        <SimulatorWindow />
      </RecordingsProvider>,
    );
    const drawer = container.querySelector('[data-component="simulator-drawer"]');
    expect(drawer).not.toBeNull();
    // The icon rail is always docked beside the phone...
    expect(drawer?.querySelector('[data-component="sim-rail-controls"]')).not.toBeNull();
    // ...but NOTHING is expanded on a fresh open: no Address bar (the Controls pane is closed).
    expect(container.querySelector('[data-component="simulator-address"]')).toBeNull();
    // Clicking the Controls rail icon expands its pane → the Address bar appears.
    fireEvent.click(drawer!.querySelector('[data-component="sim-rail-controls"]')!);
    expect(container.querySelector('[data-component="simulator-address"]')).not.toBeNull();
  });

  it('shows a LOUD transport-fallback badge when the WebRTC media is relayed / TCP (the #1 latency suspect — A3 wmdoil11r)', () => {
    window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&name=iPhone%2017');
    // No fallback → no badge.
    mockConn = { ...EMPTY_CONN, transport: 'udp', relayed: false };
    const { container, rerender } = render(
      <RecordingsProvider>
        <SimulatorWindow />
      </RecordingsProvider>,
    );
    expect(container.querySelector('[data-component="transport-fallback-badge"]')).toBeNull();
    // Relayed/TCP → the badge appears (even with the info overlay closed).
    mockConn = { ...EMPTY_CONN, transport: 'tcp', relayed: true };
    rerender(
      <RecordingsProvider>
        <SimulatorWindow />
      </RecordingsProvider>,
    );
    const badge = container.querySelector('[data-component="transport-fallback-badge"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain('Slow link');
  });

  it('Browser mode: DEFAULT ON → native address bar in the toolbar; explicit off → device identity (founder 2026-06-21)', () => {
    window.history.pushState(
      {},
      '',
      '/?window=simulator&ws=wss://lk&token=tok&name=iPhone%2017&profile=Amsterdam%20Shopper',
    );

    // DEFAULT (no stored pref) → ON: a native address field in the toolbar.
    localStorage.removeItem('ds-sim-browser-mode');
    const on = render(
      <RecordingsProvider>
        <SimulatorWindow />
      </RecordingsProvider>,
    );
    const bar = on.container.querySelector('[data-component="simulator-address-bar"]');
    expect(bar).not.toBeNull();
    expect(bar?.querySelector('[aria-label="Address bar"]')).not.toBeNull();
    on.unmount();

    // Explicit opt-out ('0') → identity in the toolbar, no address bar.
    localStorage.setItem('ds-sim-browser-mode', '0');
    const off = render(
      <RecordingsProvider>
        <SimulatorWindow />
      </RecordingsProvider>,
    );
    const toolbarOff = off.container.querySelector('[data-component="simulator-toolbar"]');
    expect(toolbarOff?.textContent).toContain('Amsterdam Shopper');
    expect(off.container.querySelector('[data-component="simulator-address-bar"]')).toBeNull();
  });

  it('the always-docked rail expands a pane on icon click — the Session pane Mode segmented control (Agent/Pair/Manual) + the Controls pane rotate / pin / info', () => {
    window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&name=iPhone%2017');
    const { container } = render(
      <RecordingsProvider>
        <SimulatorWindow />
      </RecordingsProvider>,
    );
    // Activity-bar drawer: the icon RAIL is ALWAYS docked beside the phone (no
    // chevron). Clicking a rail icon EXPANDS its content PANE (only the active
    // section renders). Default (navigated) is collapsed — open Session first.
    const panel = container.querySelector('[data-component="simulator-drawer"]');
    expect(panel).not.toBeNull();
    fireEvent.click(panel?.querySelector('[data-component="sim-rail-session"]') as Element);
    // The Session pane's Mode segmented control is its hero (three modes as a
    // radio group).
    expect(panel?.querySelector('[data-component="simulator-control-section"]')).not.toBeNull();
    expect(panel?.querySelector('[aria-label="Agent mode"]')).not.toBeNull();
    expect(panel?.querySelector('[aria-label="Pair mode"]')).not.toBeNull();
    expect(panel?.querySelector('[aria-label="Manual mode"]')).not.toBeNull();
    // The labelled window controls live in the Controls pane (one rail click away).
    fireEvent.click(panel?.querySelector('[data-component="sim-rail-controls"]') as Element);
    expect(
      panel?.querySelector('[aria-label="Rotate to landscape"], [aria-label="Rotate to portrait"]'),
    ).not.toBeNull();
    // Pin toggle (always-on-top) — the window opens NOT always-on-top by default
    // (a normal, switchable, minimizable window), so the pin control reads "Pin
    // on top"; the toggle floats it on demand.
    expect(panel?.querySelector('[aria-label="Pin on top"]')).not.toBeNull();
    // Diagnostics is its own pane (select its rail icon to render it). The drawer
    // close ✕ now lives in the pinned status strip — always visible.
    fireEvent.click(panel?.querySelector('[data-component="sim-rail-diagnostics"]') as Element);
    expect(panel?.querySelector('[data-component="drawer-diagnostics"]')).not.toBeNull();
    expect(panel?.querySelector('[aria-label="Close drawer"]')).not.toBeNull();
  });

  it('the drawer rail persistently labels every section without relying on hover', () => {
    window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_x');
    const { container } = render(
      <RecordingsProvider>
        <SimulatorWindow />
      </RecordingsProvider>,
    );
    const rail = container.querySelector('[data-component="sim-drawer-rail"]');
    expect(rail).not.toBeNull();
    for (const [pane, label] of [
      ['session', 'Session'],
      ['controls', 'Controls'],
      ['diagnostics', 'Health'],
      ['cookies', 'Cookies'],
      ['files', 'Files'],
      ['downloads', 'Downloads'],
      ['recording', 'Record'],
    ] as const) {
      const persistent = rail?.querySelector(`[data-component="sim-rail-label-${pane}"]`);
      expect(persistent?.textContent).toBe(label);
      expect(persistent?.className).not.toContain('opacity-0');
    }
    expect(rail?.querySelector('[data-component="sim-rail-end"]')?.textContent).toContain('End');
  });

  it('brands the toolbar: Drift mark + profile name (primary) with the device muted beside it', () => {
    window.history.pushState(
      {},
      '',
      '/?window=simulator&ws=wss://lk&token=tok&name=iPhone%2017&profile=Amsterdam%20Shopper',
    );
    const { container } = render(
      <RecordingsProvider>
        <SimulatorWindow />
      </RecordingsProvider>,
    );
    const toolbar = container.querySelector('[data-component="simulator-toolbar"]');
    // The Drift mark renders in the toolbar (brand presence on the window).
    expect(toolbar?.querySelector('[data-component="drift-mark"]')).not.toBeNull();
    // Profile identity is primary; the device rides muted beside it.
    expect(toolbar?.textContent).toContain('Amsterdam Shopper');
    expect(toolbar?.textContent).toContain('iPhone 17');
  });

  it('toolbar without a profile name falls back to the device name only (no dangling separator)', () => {
    window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&name=iPhone%2017');
    const { container } = render(
      <RecordingsProvider>
        <SimulatorWindow />
      </RecordingsProvider>,
    );
    const toolbar = container.querySelector('[data-component="simulator-toolbar"]');
    expect(toolbar?.querySelector('[data-component="drift-mark"]')).not.toBeNull();
    expect(toolbar?.textContent).toContain('iPhone 17');
    expect(toolbar?.textContent).not.toContain('·');
  });

  it('an open pane collapses on Escape back to the always-docked rail (docked panel — not on an outside pointer-down)', () => {
    window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&name=iPhone%2017');
    const { container } = render(
      <RecordingsProvider>
        <SimulatorWindow />
      </RecordingsProvider>,
    );
    // The rail (drawer) is always docked; open a pane by clicking its rail icon.
    const drawer = container.querySelector('[data-component="simulator-drawer"]');
    expect(drawer).not.toBeNull();
    fireEvent.click(drawer?.querySelector('[data-component="sim-rail-session"]') as Element);
    expect(container.querySelector('[data-component="sim-drawer-panel"]')).not.toBeNull();
    // The panel is DOCKED (a sibling of the device), so it does NOT dismiss on an
    // outside pointer-down (that would collapse it on its own clicks).
    fireEvent.pointerDown(document.body);
    expect(container.querySelector('[data-component="sim-drawer-panel"]')).not.toBeNull();
    // Escape collapses the pane (the rail stays docked, the panel goes).
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.querySelector('[data-component="sim-drawer-panel"]')).toBeNull();
    expect(container.querySelector('[data-component="simulator-drawer"]')).not.toBeNull();
  });

  it('iOS tap cursor: a pointer-down on the screen blooms a tap-ripple ring (purely visual — never intercepts the tap)', () => {
    window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&name=iPhone%2017');
    const { container } = render(
      <RecordingsProvider>
        <SimulatorWindow />
      </RecordingsProvider>,
    );
    const host = container.querySelector('[data-component="simulator-screen-host"]');
    expect(host).not.toBeNull();
    // jsdom gives a zero-rect by default; the handler guards on width===0, so
    // stub a real rect to exercise the in-bounds path.
    (host as HTMLElement).getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 300, height: 600 }) as DOMRect;
    // No ripple before any tap.
    expect(container.querySelector('[data-component="tap-ripple"]')).toBeNull();
    // jsdom has no native PointerEvent constructor, so create the bubbling event and
    // stamp finite coordinates explicitly (the production handler rejects non-finite
    // geometry instead of emitting a React `left: NaN` style warning).
    const pointerDown = new Event('pointerdown', { bubbles: true });
    Object.defineProperties(pointerDown, {
      clientX: { value: 120 },
      clientY: { value: 240 },
    });
    fireEvent(host as Element, pointerDown);
    const ripple = container.querySelector('[data-component="tap-ripple"]');
    expect(ripple).not.toBeNull();
    // The ring renders inside the screen host and never intercepts the tap
    // (the one-shot bloom animation + exact anchor are CSS / live-event detail
    // jsdom can't carry — the pointer coords don't survive its PointerEvent).
    expect(host?.contains(ripple as Node)).toBe(true);
    expect(ripple?.className).toContain('pointer-events-none');
    expect(ripple?.className).toContain('ds-tap-ring');
    // The bloom is a SOFT translucent disc (matches the .ds-touch-dot fingertip),
    // not a stark hard white outline that reads as a QA/click-test marker. Lock in
    // the thin translucent stroke + faint fill so it can't regress to the old
    // border-2 border-white/80 ring (legibility on light pages comes from the
    // .ds-tap-ring drop-shadow in CSS, which jsdom can't carry).
    expect(ripple?.className).toContain('border-white/55');
    expect(ripple?.className).toContain('bg-white/10');
    expect(ripple?.className).not.toContain('border-2');
  });

  it('iOS touch-point cursor: the screen host hides the PC arrow (cursor-none) and a pointer-move over the screen shows a fingertip dot that never intercepts the tap', () => {
    window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&name=iPhone%2017');
    const { container } = render(
      <RecordingsProvider>
        <SimulatorWindow />
      </RecordingsProvider>,
    );
    const host = container.querySelector('[data-component="simulator-screen-host"]');
    expect(host).not.toBeNull();
    // The PC cursor is hidden over the device screen (the fingertip replaces it).
    expect(host?.className).toContain('cursor-none');
    // The isolated overlay stays mounted but hidden so pointer entry never
    // rerenders the simulator host.
    const cursor = container.querySelector('[data-component="touch-cursor"]') as HTMLElement;
    expect(cursor.hidden).toBe(true);
    (host as HTMLElement).getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 300, height: 600 }) as DOMRect;
    fireEvent.pointerMove(host as Element, { clientX: 120, clientY: 240 });
    const dot = container.querySelector('[data-component="touch-cursor"]') as HTMLElement;
    expect(dot.hidden).toBe(false);
    expect(dot.className).toContain('pointer-events-none');
    // Leaving the screen hides the fingertip again.
    fireEvent.pointerLeave(host as Element);
    expect(dot.hidden).toBe(true);
  });

  it('shows a Connecting indicator on bind — not Live — until the stream connects (founder Track A)', () => {
    window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_1');
    const { container } = render(
      <RecordingsProvider>
        <SimulatorWindow />
      </RecordingsProvider>,
    );
    // A bound session whose video hasn't connected yet reads "Connecting…", never
    // "Live" — the green badge must not lie before the stream actually arrives.
    expect(
      container.querySelector('[data-component="simulator-connecting-indicator"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-component="simulator-running-indicator"]')).toBeNull();
  });

  it('the always-docked rail exposes an explicit End session control (the true Stop, reachable even when collapsed)', () => {
    window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_1');
    const { container } = render(
      <RecordingsProvider>
        <SimulatorWindow />
      </RecordingsProvider>,
    );
    // The End-session button lives at the BOTTOM of the always-docked rail (no
    // pane needs to be open — default is collapsed), so it is reachable at all
    // times. It is the dedicated rail control, not the section icons.
    const drawer = container.querySelector('[data-component="simulator-drawer"]');
    expect(drawer?.querySelector('[data-component="sim-drawer-panel"]')).toBeNull();
    expect(drawer?.querySelector('[data-component="sim-rail-end"]')).not.toBeNull();
    expect(drawer?.querySelector('[aria-label="End session"]')).not.toBeNull();
  });

  it('no End session control when there is no bound session (the empty window)', () => {
    window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok');
    const { container } = render(
      <RecordingsProvider>
        <SimulatorWindow />
      </RecordingsProvider>,
    );
    // No `session=` in the query → running is false → no running cue + no End on
    // the rail.
    expect(container.querySelector('[data-component="simulator-running-indicator"]')).toBeNull();
    const drawer = container.querySelector('[data-component="simulator-drawer"]');
    expect(drawer?.querySelector('[data-component="sim-rail-end"]')).toBeNull();
    expect(drawer?.querySelector('[aria-label="End session"]')).toBeNull();
  });

  it('shows a no-session hint (no device frame) when the query lacks ws/token', () => {
    window.history.pushState({}, '', '/?window=simulator');
    const { container } = render(
      <RecordingsProvider>
        <SimulatorWindow />
      </RecordingsProvider>,
    );
    expect(container.querySelector('[data-component="simulator-device"]')).toBeNull();
    expect(container.textContent).toContain('No session');
  });
});
