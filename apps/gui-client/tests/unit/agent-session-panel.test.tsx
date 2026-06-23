// AgentSessionPanel overlay UX — the connection-state overlay (spinner while
// connecting, and a Reconnect affordance that recovers from an error/disconnect
// without reloading). Mocks only the livekit-client wrapper so we drive the
// connection state machine deterministically.

import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { AgentSessionPanel, friendlyConnectError } from '../../src/components/AgentSessionPanel';

const connectMock = vi.fn();

vi.mock('../../src/lib/livekit', () => ({
  createLivekitRoom: () => ({ on: vi.fn(), disconnect: vi.fn() }),
  connectToAgentSession: (...args: unknown[]) => connectMock(...args) as unknown,
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    Disconnected: 'disconnected',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
  },
}));

const INFO = { ws_url: 'wss://lk', token: 'tok' } as never;

describe('friendlyConnectError — raw LiveKit errors → customer copy', () => {
  it('maps an invalid/expired token to a friendly Reconnect message', () => {
    const m = friendlyConnectError(
      new Error('could not establish signal connection: invalid authorization token'),
    );
    expect(m).toMatch(/video link is no longer valid/i);
    expect(m).not.toMatch(/authorization token/i); // raw jargon hidden
  });
  it('maps a transport/signal failure to a connection-check message', () => {
    expect(friendlyConnectError(new Error('could not establish signal connection'))).toMatch(
      /reach the live-stream server/i,
    );
    expect(friendlyConnectError(new Error('WebSocket connection timeout'))).toMatch(
      /reach the live-stream server/i,
    );
  });
  it('maps a closed/disconnect to a close-or-reconnect message', () => {
    expect(friendlyConnectError(new Error('room closed'))).toMatch(/connection closed/i);
  });
  it('falls back to the raw text for unrecognized errors, else a generic line', () => {
    expect(friendlyConnectError(new Error('weird thing'))).toBe('weird thing');
    expect(friendlyConnectError(null)).toMatch(/could not connect/i);
  });
});

describe('AgentSessionPanel overlay UX', () => {
  it('shows a connecting spinner (no Reconnect button) before connect resolves', () => {
    connectMock.mockReset();
    connectMock.mockReturnValueOnce(new Promise(() => {})); // never resolves → stays connecting
    const { container } = render(<AgentSessionPanel info={INFO} />);
    const overlay = container.querySelector('[data-overlay="connection-state"]');
    expect(overlay?.getAttribute('data-state')).toBe('connecting');
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(container.querySelector('[data-action="reconnect-stream"]')).toBeNull();
  });

  it('keeps the FIXED canonical box aspect on loadedmetadata (NOT the SFU-drifted live aspect) + still reports real dims for the window resize (A3 W2840)', () => {
    connectMock.mockReset();
    connectMock.mockReturnValueOnce(new Promise(() => {}));
    const dims: Array<[number, number]> = [];
    const { container } = render(
      <AgentSessionPanel info={INFO} onVideoDimensions={(w, h) => dims.push([w, h])} />,
    );
    const panel = container.querySelector('[data-component="agent-session-panel"]') as HTMLElement;
    const video = container.querySelector('video') as HTMLVideoElement;
    // The box aspect is the fixed canonical device aspect (402:874 ≡ 1206/2622).
    expect(panel.style.aspectRatio).toBe((1206 / 2622).toString());
    // Simulate metadata arriving with a SFU-downscaled, slightly-off resolution.
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1320 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 2868 });
    fireEvent.loadedMetadata(video);
    // Founder 2026-06-23 / A3 W2840: the box must NOT adopt the drifted live aspect
    // (that letterboxed the view inside the exactly-402:874 host → "iPhone smaller").
    // It stays the canonical aspect; the <video> object-contain absorbs the drift.
    // The real dims still flow to the parent's one-time WINDOW resize.
    expect(panel.style.aspectRatio).toBe((1206 / 2622).toString());
    expect(dims).toEqual([[1320, 2868]]);
  });

  it('on a connect error shows a Reconnect button that re-triggers the connect', async () => {
    connectMock.mockReset();
    connectMock.mockRejectedValueOnce(new Error('boom')).mockReturnValue(new Promise(() => {})); // the retry stays connecting (no churn)
    const { container } = render(<AgentSessionPanel info={INFO} />);
    const btn = await waitFor(() => {
      const b = container.querySelector('[data-action="reconnect-stream"]');
      if (b === null) throw new Error('reconnect button not rendered yet');
      return b as HTMLButtonElement;
    });
    const callsBeforeClick = connectMock.mock.calls.length;
    fireEvent.click(btn);
    await waitFor(() => {
      expect(connectMock.mock.calls.length).toBeGreaterThan(callsBeforeClick);
    });
  });
});
