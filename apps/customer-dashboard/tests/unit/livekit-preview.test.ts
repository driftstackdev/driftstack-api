// Unit tests for the dashboard live-stream preview connector. Fully
// dependency-injected — no livekit-client / no jsdom needed; we fake the
// Room, the RoomEvent names, fetch, and the attach fn, and assert the
// connection state machine: token mint -> connect -> attach video, plus the
// error paths (bad token, non-2xx, throw) all surface onState('error').

import { describe, expect, it, vi } from 'vitest';
import {
  startLivekitPreview,
  type PreviewState,
  type RoomLike,
} from '../../src/lib/livekit-preview';

const EVENTS = {
  trackSubscribed: 'trackSubscribed',
  disconnected: 'disconnected',
  reconnecting: 'reconnecting',
  reconnected: 'reconnected',
};

function makeFakeRoom() {
  const handlers: Record<string, (...a: unknown[]) => void> = {};
  const room: RoomLike & {
    connectCalls: Array<[string, string]>;
    disconnected: boolean;
    fire: (e: string, ...a: unknown[]) => void;
  } = {
    connectCalls: [],
    disconnected: false,
    on(event, cb) {
      handlers[event] = cb;
    },
    async connect(wsUrl, token) {
      room.connectCalls.push([wsUrl, token]);
    },
    disconnect() {
      room.disconnected = true;
    },
    fire(event, ...args) {
      handlers[event]?.(...args);
    },
  };
  return room;
}

function okJson(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as unknown as Response;
}

function deps(over: Partial<Parameters<typeof startLivekitPreview>[0]> = {}) {
  const states: PreviewState[] = [];
  const room = makeFakeRoom();
  const attach = vi.fn();
  const base = {
    apiBaseUrl: 'https://api.example.com',
    sessionId: 'agt_1',
    authHeaders: { authorization: 'Bearer ds_test_x' },
    videoEl: {} as HTMLVideoElement,
    onState: (s: PreviewState) => states.push(s),
    createRoom: () => room,
    events: EVENTS,
    attachVideoTrack: attach,
    fetchFn: vi.fn(() => Promise.resolve(okJson({ ws_url: 'wss://lk', token: 'tok' }))),
    ...over,
  };
  return { base, states, room, attach };
}

describe('startLivekitPreview', () => {
  it('happy path: mints token, connects with ws_url+token, transitions connecting -> streaming', async () => {
    const { base, states, room } = deps();
    await startLivekitPreview(base);
    expect(room.connectCalls).toEqual([['wss://lk', 'tok']]);
    expect(states).toEqual(['connecting', 'streaming']);
    // token POST hit the LK.3 endpoint with auth.
    expect(base.fetchFn).toHaveBeenCalledWith(
      'https://api.example.com/v1/agent-sessions/agt_1/livekit-token',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('attaches the VIDEO track on TrackSubscribed (ignores non-video)', async () => {
    const { base, room, attach } = deps();
    await startLivekitPreview(base);
    room.fire(EVENTS.trackSubscribed, { kind: 'audio' });
    expect(attach).not.toHaveBeenCalled();
    const vt = { kind: 'video' };
    room.fire(EVENTS.trackSubscribed, vt);
    expect(attach).toHaveBeenCalledWith(vt, base.videoEl);
  });

  it('reconnect/disconnect events drive state', async () => {
    const { base, states, room } = deps();
    await startLivekitPreview(base);
    room.fire(EVENTS.reconnecting);
    room.fire(EVENTS.reconnected);
    room.fire(EVENTS.disconnected);
    expect(states).toEqual(['connecting', 'streaming', 'reconnecting', 'streaming', 'offline']);
  });

  it('bad token body (missing ws_url/token) -> error, no connect', async () => {
    const { base, states, room } = deps({
      fetchFn: vi.fn(() => Promise.resolve(okJson({ token: 'tok' }))),
    });
    await startLivekitPreview(base);
    expect(states).toEqual(['connecting', 'error']);
    expect(room.connectCalls).toEqual([]);
  });

  it('non-2xx token response -> error, no connect', async () => {
    const { base, states, room } = deps({
      fetchFn: vi.fn(() =>
        Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as unknown as Response),
      ),
    });
    await startLivekitPreview(base);
    expect(states).toEqual(['connecting', 'error']);
    expect(room.connectCalls).toEqual([]);
  });

  it('fetch throw -> error (never throws out)', async () => {
    const { base, states } = deps({ fetchFn: vi.fn(() => Promise.reject(new Error('net'))) });
    await expect(startLivekitPreview(base)).resolves.toBeTypeOf('function');
    expect(states).toEqual(['connecting', 'error']);
  });

  it('teardown disconnects the room', async () => {
    const { base, room } = deps();
    const teardown = await startLivekitPreview(base);
    teardown();
    expect(room.disconnected).toBe(true);
  });
});
