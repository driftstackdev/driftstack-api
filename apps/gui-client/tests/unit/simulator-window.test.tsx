// SimulatorWindow (floating-iPhone window, founder 2026-06-11) — validates the
// device frame renders from the URL query, and the bezel-vs-screen drag-region
// split (drag the frame to move the window; taps on the screen reach the
// device). Mocks the livekit wrapper so no real WebRTC spins up in jsdom.

import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('../../src/lib/livekit', () => ({
  createLivekitRoom: () => ({ on: vi.fn(), disconnect: vi.fn() }),
  connectToAgentSession: () => new Promise(() => {}), // stays connecting
  sendInputEvent: vi.fn(),
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    Disconnected: 'disconnected',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
  },
}));

const { SimulatorWindow } = await import('../../src/views/SimulatorWindow');
const { RecordingsProvider } = await import('../../src/lib/recordings');

describe('SimulatorWindow — floating iPhone', () => {
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

  it('renders the Driftstack control toolbar above the device: device name + close/minimize + screenshot/rotate', () => {
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
    // Window controls + actions present (the window is borderless, so close/
    // minimize live here). aria-labels are the stable contract.
    for (const label of ['Close', 'Minimize', 'Screenshot']) {
      expect(toolbar?.querySelector(`[aria-label="${label}"]`), label).not.toBeNull();
    }
    // Rotate toggles its label between portrait/landscape — match either.
    expect(
      toolbar?.querySelector(
        '[aria-label="Rotate to landscape"], [aria-label="Rotate to portrait"]',
      ),
    ).not.toBeNull();
    // Pin toggle (always-on-top) — defaults pinned (the floating-iPhone
    // vision); unpinned = a normal sibling window (Cmd+backtick / Mission
    // Control identity).
    expect(toolbar?.querySelector('[aria-label="Unpin (stop floating on top)"]')).not.toBeNull();
    // The toolbar is a drag-region (drag the window by it); the button clusters
    // opt out so clicks land.
    expect(toolbar?.getAttribute('data-tauri-drag-region')).toBe('true');
    // It sits above the device in the shell (not inside the bezel).
    const shell = container.querySelector('[data-component="simulator-shell"]');
    expect(shell?.firstElementChild).toBe(toolbar);
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
