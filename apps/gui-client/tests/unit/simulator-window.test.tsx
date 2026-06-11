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

  it('shows a no-session hint (no device frame) when the query lacks ws/token', () => {
    window.history.pushState({}, '', '/?window=simulator');
    const { container } = render(<SimulatorWindow />);
    expect(container.querySelector('[data-component="simulator-device"]')).toBeNull();
    expect(container.textContent).toContain('No session');
  });
});
