// useConnectionStats — transport/RTT reset on a mid-session track loss.
//
// The transport pill (udp emerald / tcp rose) is the founder's "are we on TCP?"
// indicator. During a freeze-recovery resubscribe blip the subscribed video
// track is briefly absent; the poll must NOT keep showing the last transport /
// RTT (which no longer describes the live PeerConnection) — it has to fall back
// to EMPTY ("link…") until a real report lands again. These tests drive the
// hook over a mock Room whose subscribed track can be dropped + restored.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useConnectionStats,
  CONNECTION_STATS_INTERVAL_MS,
} from '../../src/lib/livekit-connection-stats';

/** A getRTCStatsReport() report describing a direct UDP path at 50ms RTT. */
function udpReport(): RTCStatsReport {
  return new Map<string, Record<string, unknown>>([
    [
      'cp',
      {
        id: 'cp',
        type: 'candidate-pair',
        nominated: true,
        bytesReceived: 1000,
        currentRoundTripTime: 0.05,
        localCandidateId: 'lc',
        remoteCandidateId: 'rc',
      },
    ],
    ['lc', { id: 'lc', type: 'local-candidate', candidateType: 'srflx', protocol: 'udp' }],
    ['rc', { id: 'rc', type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' }],
  ]);
}

/** A Room whose single subscribed video track can be dropped at will. */
function makeRoom(): { room: never; dropTrack: () => void; restoreTrack: () => void } {
  const track = {
    getRTCStatsReport: () => Promise.resolve(udpReport()),
  };
  const pub = { isSubscribed: true, track: track as unknown };
  const participant = { videoTrackPublications: new Map([['v', pub]]) };
  const room = {
    remoteParticipants: new Map([['p', participant]]),
  };
  return {
    room: room as never,
    dropTrack: () => {
      pub.isSubscribed = false;
      pub.track = null;
    },
    restoreTrack: () => {
      pub.isSubscribed = true;
      pub.track = track;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useConnectionStats — track-loss reset', () => {
  it('resets to EMPTY when the subscribed track drops mid-session', async () => {
    const { room, dropTrack } = makeRoom();
    const { result } = renderHook(() => useConnectionStats({ room, enabled: true }));

    // Initial poll resolves the UDP report.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.transport).toBe('udp');
    expect(result.current.rttMs).toBe(50);

    // Track drops (resubscribe blip); the next poll finds no track.
    dropTrack();
    await act(async () => {
      vi.advanceTimersByTime(CONNECTION_STATS_INTERVAL_MS);
      await Promise.resolve();
    });

    // Stats fall back to EMPTY rather than the stale udp/50ms.
    expect(result.current.transport).toBeNull();
    expect(result.current.rttMs).toBeNull();
  });

  it('re-populates when the track comes back after recovery', async () => {
    const { room, dropTrack, restoreTrack } = makeRoom();
    const { result } = renderHook(() => useConnectionStats({ room, enabled: true }));

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.transport).toBe('udp');

    dropTrack();
    await act(async () => {
      vi.advanceTimersByTime(CONNECTION_STATS_INTERVAL_MS);
      await Promise.resolve();
    });
    expect(result.current.transport).toBeNull();

    // Resubscribe completes → the next poll re-reads a real report.
    restoreTrack();
    await act(async () => {
      vi.advanceTimersByTime(CONNECTION_STATS_INTERVAL_MS);
      await Promise.resolve();
    });
    expect(result.current.transport).toBe('udp');
    expect(result.current.rttMs).toBe(50);
  });
});
