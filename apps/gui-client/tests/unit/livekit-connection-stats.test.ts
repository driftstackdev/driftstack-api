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

  it('clamps a NEGATIVE packetsLost (signed WebRTC counter) to 0% loss', () => {
    // packetsLost is a signed cumulative estimate that legitimately goes
    // negative early in a relayed stream (RTX/duplicates/reorder). It must never
    // surface as a negative loss % in the founder-facing diagnostics.
    const r = parseConnectionStats(
      report([
        { id: 'in', type: 'inbound-rtp', kind: 'video', packetsLost: -3, packetsReceived: 997 },
      ]),
    );
    expect(r.packetLossPct).toBe(0);
  });

  it('⛔ V-2168: reads the frame-attribution counters — decoded / dropped / rendered / freezes duration / jitter buffer', () => {
    // The decode>render owner report was UNDIAGNOSABLE because none of these
    // were read: nothing could separate "decoded but never presented by the
    // sink" from a compositing stall. The parser must surface every counter the
    // browser exposes, and stay null (not 0) for the ones it does not.
    const r = parseConnectionStats(
      report([
        {
          id: 'in',
          type: 'inbound-rtp',
          kind: 'video',
          framesPerSecond: 50,
          framesDecoded: 3000,
          framesDropped: 960,
          framesRendered: 2040,
          totalFreezesDuration: 4.25,
          pauseCount: 2,
          jitterBufferDelay: 12.5,
          jitterBufferEmittedCount: 2500,
        },
      ]),
    );
    expect(r.framesDecoded).toBe(3000);
    expect(r.framesDropped).toBe(960);
    expect(r.framesRendered).toBe(2040);
    expect(r.totalFreezesDurationS).toBe(4.25);
    expect(r.pauseCount).toBe(2);
    expect(r.jitterBufferDelayS).toBe(12.5);
    expect(r.jitterBufferEmittedCount).toBe(2500);
  });

  it('V-2168: a UA that does not expose the frame counters yields null, never 0', () => {
    const r = parseConnectionStats(
      report([{ id: 'in', type: 'inbound-rtp', kind: 'video', framesPerSecond: 30 }]),
    );
    expect(r.framesDecoded).toBeNull();
    expect(r.framesDropped).toBeNull();
    expect(r.framesRendered).toBeNull();
    expect(r.totalFreezesDurationS).toBeNull();
    expect(r.jitterBufferDelayS).toBeNull();
  });

  it('returns nulls (never throws) for an empty / unknown report', () => {
    const r = parseConnectionStats(report([{ id: 'x', type: 'codec' }]));
    expect(r.transport).toBeNull();
    expect(r.relayed).toBeNull();
    expect(r.rttMs).toBeNull();
    expect(r.decodeFps).toBeNull();
  });
});
