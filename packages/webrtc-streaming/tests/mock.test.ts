import { describe, expect, it } from 'vitest';
import { MockWebRtcStreamingService, type StreamConfig, type StreamEvent } from '../src/index.js';

const CONFIG: StreamConfig = {
  targetFps: 30,
  targetBitrateKbps: 1500,
  audio: false,
  iceServers: [{ urls: 'stun:stun.example.test:3478' }],
};

describe('MockWebRtcStreamingService', () => {
  it('createStream returns a stream id + SDP offer', async () => {
    const svc = new MockWebRtcStreamingService();
    const result = await svc.createStream({ sessionId: 'ses_test', config: CONFIG });
    expect(result.streamId).toMatch(/^mock_stream_/);
    expect(result.offer.type).toBe('offer');
    expect(result.offer.sdp.length).toBeGreaterThan(0);
  });

  it('negotiate(answer) transitions state to connected', async () => {
    const svc = new MockWebRtcStreamingService();
    const { streamId } = await svc.createStream({ sessionId: 'ses_test', config: CONFIG });
    await svc.negotiate(streamId, { type: 'answer', sdp: 'v=0\r\n' });
    const stats = await svc.getStats(streamId);
    expect(stats?.state).toBe('connected');
    expect(stats?.fpsAvg).toBe(30);
    expect(stats?.bitrateKbpsAvg).toBe(1500);
  });

  it('subscribe receives state-change events', async () => {
    const svc = new MockWebRtcStreamingService();
    const { streamId } = await svc.createStream({ sessionId: 'ses_test', config: CONFIG });

    const events: StreamEvent[] = [];
    svc.subscribe(streamId, (event) => events.push(event));

    await svc.negotiate(streamId, { type: 'answer', sdp: 'v=0\r\n' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'state_changed', state: 'connected' });
  });

  it('subscribe returns an unsubscribe function', async () => {
    const svc = new MockWebRtcStreamingService();
    const { streamId } = await svc.createStream({ sessionId: 'ses_test', config: CONFIG });

    let receivedCount = 0;
    const unsubscribe = svc.subscribe(streamId, () => {
      receivedCount += 1;
    });
    unsubscribe();
    await svc.negotiate(streamId, { type: 'answer', sdp: 'v=0\r\n' });
    expect(receivedCount).toBe(0);
  });

  it('close transitions state to closed + clears subscribers', async () => {
    const svc = new MockWebRtcStreamingService();
    const { streamId } = await svc.createStream({ sessionId: 'ses_test', config: CONFIG });
    await svc.close(streamId);
    const stats = await svc.getStats(streamId);
    expect(stats?.state).toBe('closed');
    expect(stats?.fpsAvg).toBe(0);
  });

  it('close on unknown stream is a no-op', async () => {
    const svc = new MockWebRtcStreamingService();
    await expect(svc.close('mock_stream_nonexistent')).resolves.toBeUndefined();
  });

  it('getStats on unknown stream returns null', async () => {
    const svc = new MockWebRtcStreamingService();
    expect(await svc.getStats('mock_stream_nonexistent')).toBeNull();
  });

  it('list filters by state', async () => {
    const svc = new MockWebRtcStreamingService();
    const a = await svc.createStream({ sessionId: 'ses_a', config: CONFIG });
    await svc.createStream({ sessionId: 'ses_b', config: CONFIG });
    await svc.negotiate(a.streamId, { type: 'answer', sdp: 'v=0\r\n' });

    const all = await svc.list();
    expect(all).toHaveLength(2);

    const connected = await svc.list({ state: 'connected' });
    expect(connected).toHaveLength(1);
    expect(connected[0]?.streamId).toBe(a.streamId);

    const connecting = await svc.list({ state: 'connecting' });
    expect(connecting).toHaveLength(1);
  });

  it('advanceClock changes ageMs in stats', async () => {
    const svc = new MockWebRtcStreamingService();
    const { streamId } = await svc.createStream({ sessionId: 'ses_test', config: CONFIG });
    svc.advanceClock(60_000);
    const stats = await svc.getStats(streamId);
    expect(stats?.ageMs).toBe(60_000);
  });
});
