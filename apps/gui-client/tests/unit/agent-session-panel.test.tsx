// AgentSessionPanel overlay UX — the connection-state overlay (spinner while
// connecting, and a Reconnect affordance that recovers from an error/disconnect
// without reloading). Mocks only the livekit-client wrapper so we drive the
// connection state machine deterministically.

import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { AgentSessionPanel } from '../../src/components/AgentSessionPanel';

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

  it('adopts the stream REAL aspect on loadedmetadata + reports dimensions (archetype-driven sizing)', () => {
    connectMock.mockReset();
    connectMock.mockReturnValueOnce(new Promise(() => {}));
    const dims: Array<[number, number]> = [];
    const { container } = render(
      <AgentSessionPanel info={INFO} onVideoDimensions={(w, h) => dims.push([w, h])} />,
    );
    const panel = container.querySelector('[data-component="agent-session-panel"]') as HTMLElement;
    const video = container.querySelector('video') as HTMLVideoElement;
    // Pre-metadata: the static fallback aspect (iPhone 16 Pro geometry).
    expect(panel.style.aspectRatio).toBe((1206 / 2622).toString());
    // jsdom videos have no real dimensions — simulate the metadata arriving
    // with a DIFFERENT archetype's resolution (e.g. a hypothetical 1320×2868).
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1320 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 2868 });
    fireEvent.loadedMetadata(video);
    // The live aspect wins over the static prop; the parent hears the dims.
    expect(panel.style.aspectRatio).toBe((1320 / 2868).toString());
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
