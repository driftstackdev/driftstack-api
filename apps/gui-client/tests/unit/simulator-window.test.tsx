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

describe('SimulatorWindow — floating iPhone', () => {
  it('renders the device frame + screen when ws/token are present in the query', () => {
    window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok');
    const { container } = render(<SimulatorWindow />);
    const device = container.querySelector('[data-component="simulator-device"]');
    const screen = container.querySelector('[data-component="simulator-screen"]');
    expect(device).not.toBeNull();
    expect(screen).not.toBeNull();
    // The bezel is a window drag-region; the screen overrides it so taps reach
    // the device (the Xcode-simulator drag-the-frame / tap-the-screen split).
    expect(device?.getAttribute('data-tauri-drag-region')).toBe('true');
    expect(screen?.getAttribute('data-tauri-drag-region')).toBe('false');
  });

  it('renders the iOS status bar (live clock + glyphs) over the screen, taps still pass through', () => {
    window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok');
    const { container } = render(<SimulatorWindow />);
    const statusBar = container.querySelector('[data-component="simulator-statusbar"]');
    expect(statusBar).not.toBeNull();
    // Live clock in iOS h:mm shape (no leading-zero hour, no AM/PM).
    expect(statusBar?.textContent).toMatch(/^\d{1,2}:\d{2}$/);
    // Cellular / Wi-Fi / battery glyphs.
    expect(statusBar?.querySelectorAll('svg').length).toBe(3);
    // The bar IS a window drag-region (founder: drag the window by the status
    // strip) — the inner clock/glyphs are pointer-events-none so a click on the
    // strip falls through to the bar and drags rather than landing on text.
    expect(statusBar?.getAttribute('data-tauri-drag-region')).toBe('true');
    expect(statusBar?.querySelector('span')?.className).toContain('pointer-events-none');
    // It lives inside the screen (over the video), not the bezel.
    const screen = container.querySelector('[data-component="simulator-screen"]');
    expect(screen?.querySelector('[data-component="simulator-statusbar"]')).not.toBeNull();
  });

  it('shows a no-session hint (no device frame) when the query lacks ws/token', () => {
    window.history.pushState({}, '', '/?window=simulator');
    const { container } = render(<SimulatorWindow />);
    expect(container.querySelector('[data-component="simulator-device"]')).toBeNull();
    expect(container.textContent).toContain('No session');
  });
});
