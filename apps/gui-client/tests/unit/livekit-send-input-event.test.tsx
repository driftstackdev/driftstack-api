// LK.6.a — sendInputEvent unit tests.
//
// The function wraps `room.localParticipant.publishData(data, opts)`
// with two responsibilities:
//   1. JSON-encode the InputEvent + UTF-8 encode the JSON string.
//   2. Default to `reliable: true` (TCP-style) unless caller opts
//      into lossy mode for high-frequency mouseMove streams.
//
// Both responsibilities are wire-contract invariants:
//   - The Mac-side decoder (Agent 1's Swift RoomDataDispatcher) parses
//     a UTF-8 JSON byte stream — any encoding drift breaks decode.
//   - Reliable=true by default ensures mouse/key events arrive in
//     order; drift to lossy-by-default would lose click chains under
//     congestion (silent UX failure).
//
// Pure-function-ish tests; we mock just the publishData call site.

import { describe, expect, it, vi } from 'vitest';
import { sendInputEvent, type InputEvent, type Room } from '../../src/lib/livekit';

interface MinimalRoom {
  localParticipant: {
    publishData: (data: Uint8Array, opts: { reliable: boolean }) => Promise<void>;
  };
}

function makeRoom(): {
  room: Room;
  publishData: ReturnType<typeof vi.fn>;
} {
  const publishData = vi.fn(() => Promise.resolve());
  const minimal: MinimalRoom = { localParticipant: { publishData } };
  return {
    publishData,
    room: minimal as unknown as Room,
  };
}

interface DataCall {
  data: Uint8Array;
  opts: { reliable: boolean };
}

function firstCall(publishData: ReturnType<typeof vi.fn>): DataCall {
  const calls = publishData.mock.calls as unknown as Array<[Uint8Array, { reliable: boolean }]>;
  const first = calls[0];
  if (!first) throw new Error('publishData was not called');
  return { data: first[0], opts: first[1] };
}

function decodeEvent(call: DataCall): InputEvent {
  return JSON.parse(new TextDecoder().decode(call.data)) as InputEvent;
}

describe('sendInputEvent', () => {
  it('JSON-encodes a mouseMove event + UTF-8 encodes the JSON string', async () => {
    const { room, publishData } = makeRoom();
    await sendInputEvent(room, { type: 'mouseMove', x: 100, y: 200 });
    expect(publishData).toHaveBeenCalledTimes(1);
    expect(decodeEvent(firstCall(publishData))).toEqual({
      type: 'mouseMove',
      x: 100,
      y: 200,
    });
  });

  it('defaults to reliable=true (TCP-style; mouse/key events must arrive in order)', async () => {
    const { room, publishData } = makeRoom();
    await sendInputEvent(room, { type: 'mouseDown', x: 0, y: 0, button: 0 });
    expect(firstCall(publishData).opts.reliable).toBe(true);
  });

  it('respects an explicit reliable=false (mouseMove lossy mode)', async () => {
    const { room, publishData } = makeRoom();
    await sendInputEvent(room, { type: 'mouseMove', x: 1, y: 2 }, { reliable: false });
    expect(firstCall(publishData).opts.reliable).toBe(false);
  });

  it('respects an explicit reliable=true (round-trips the caller intent)', async () => {
    const { room, publishData } = makeRoom();
    await sendInputEvent(room, { type: 'keyDown', key: 'Enter' }, { reliable: true });
    expect(firstCall(publishData).opts.reliable).toBe(true);
  });

  it('round-trips a keyDown event with modifiers array (no field re-ordering)', async () => {
    const { room, publishData } = makeRoom();
    await sendInputEvent(room, {
      type: 'keyDown',
      key: 'A',
      modifiers: ['shift', 'ctrl'],
    });
    const decoded = decodeEvent(firstCall(publishData));
    expect(decoded).toEqual({ type: 'keyDown', key: 'A', modifiers: ['shift', 'ctrl'] });
    // Modifier order is preserved exactly — drift to alphabetical
    // sort would mask the canonical cmd→ctrl→shift→option order
    // emitted by modifiersFromEvent (2026-05-20 lock — Mac-native
    // vocabulary).
    if (decoded.type === 'keyDown') {
      expect(decoded.modifiers).toEqual(['shift', 'ctrl']);
    }
  });

  it('round-trips a wheel event with all 4 numeric fields', async () => {
    const { room, publishData } = makeRoom();
    await sendInputEvent(room, { type: 'wheel', x: 10, y: 20, deltaX: -5, deltaY: 50 });
    expect(decodeEvent(firstCall(publishData))).toEqual({
      type: 'wheel',
      x: 10,
      y: 20,
      deltaX: -5,
      deltaY: 50,
    });
  });

  it('round-trips a ping event (LK.6.e latency probe)', async () => {
    const { room, publishData } = makeRoom();
    await sendInputEvent(room, { type: 'ping', timestamp: 1700000000123 });
    expect(decodeEvent(firstCall(publishData))).toEqual({
      type: 'ping',
      timestamp: 1700000000123,
    });
  });

  it('encodes high Unicode codepoints correctly (UTF-8 byte stream survives)', async () => {
    const { room, publishData } = makeRoom();
    // A key value with characters outside ASCII — confirms the
    // TextEncoder/Decoder round-trip survives full Unicode (the Mac
    // decoder uses Swift's String(data:encoding:.utf8) which expects
    // valid UTF-8).
    await sendInputEvent(room, { type: 'keyDown', key: '€' });
    const decoded = decodeEvent(firstCall(publishData));
    if (decoded.type === 'keyDown') {
      expect(decoded.key).toBe('€');
    }
  });

  it('returns a Promise that resolves to undefined (matches signature)', async () => {
    const { room } = makeRoom();
    const result = await sendInputEvent(room, { type: 'mouseMove', x: 0, y: 0 });
    expect(result).toBeUndefined();
  });
});
