// Unit coverage for parseConnectionStats — the pure RTCStatsReport parser
// behind the simulator's transport diagnostic (founder's "are we on TCP?"
// question). A JS Map stands in for RTCStatsReport (same forEach contract).

import { describe, expect, it } from 'vitest';
import { parseConnectionStats } from '../../src/lib/livekit-connection-stats';

function report(stats: Array<Record<string, unknown>>): RTCStatsReport {
  // RTCStatsReport is Map-like (forEach(value, key)); a real Map matches.
  return new Map(stats.map((s) => [s.id as string, s]));
}

describe('parseConnectionStats', () => {
  it('reports a direct UDP path with fps/loss/jitter/freezes', () => {
    const r = parseConnectionStats(
      report([
        {
          id: 'cp',
          type: 'candidate-pair',
          nominated: true,
          bytesReceived: 1000,
          currentRoundTripTime: 0.05,
          localCandidateId: 'lc',
          remoteCandidateId: 'rc',
        },
        { id: 'lc', type: 'local-candidate', candidateType: 'srflx', protocol: 'udp' },
        { id: 'rc', type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' },
        {
          id: 'in',
          type: 'inbound-rtp',
          kind: 'video',
          framesPerSecond: 30,
          packetsLost: 0,
          packetsReceived: 1000,
          jitter: 0.005,
          freezeCount: 0,
        },
      ]),
    );
    expect(r.transport).toBe('udp');
    expect(r.relayed).toBe(false);
    expect(r.rttMs).toBe(50);
    expect(r.decodeFps).toBe(30);
    expect(r.packetLossPct).toBe(0);
    expect(r.jitterMs).toBe(5);
    expect(r.freezeCount).toBe(0);
  });

  it('flags a TURN relay over TCP (the worse-than-RDP case)', () => {
    const r = parseConnectionStats(
      report([
        {
          id: 'cp',
          type: 'candidate-pair',
          nominated: true,
          bytesReceived: 500,
          localCandidateId: 'lc',
          remoteCandidateId: 'rc',
        },
        // A relay candidate whose relay leg is TCP.
        {
          id: 'lc',
          type: 'local-candidate',
          candidateType: 'relay',
          relayProtocol: 'tcp',
          protocol: 'udp',
        },
        { id: 'rc', type: 'remote-candidate', candidateType: 'relay', protocol: 'udp' },
      ]),
    );
    expect(r.relayed).toBe(true);
    expect(r.transport).toBe('tcp');
  });

  it('computes inbound packet-loss percent', () => {
    const r = parseConnectionStats(
      report([
        { id: 'in', type: 'inbound-rtp', kind: 'video', packetsLost: 50, packetsReceived: 950 },
      ]),
    );
    expect(r.packetLossPct).toBe(5);
  });

  it('returns nulls (never throws) for an empty / unknown report', () => {
    const r = parseConnectionStats(report([{ id: 'x', type: 'codec' }]));
    expect(r.transport).toBeNull();
    expect(r.relayed).toBeNull();
    expect(r.rttMs).toBeNull();
    expect(r.decodeFps).toBeNull();
  });
});
