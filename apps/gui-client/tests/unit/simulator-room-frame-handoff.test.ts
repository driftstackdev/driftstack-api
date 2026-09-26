// The hand-off of room frames between the Simulator's per-epoch listeners
// (lib/simulator-room-frame-handoff.ts). The window-level behaviour — a restore
// and a focus report landing while the window is still taking control — is
// pinned in the-phones-next-focus-frames-drive-the-keyboard-as-intended.test.tsx.

import { describe, expect, it } from 'vitest';
import {
  HELD_ROOM_FRAMES_MAX,
  heldRoomFramesFor,
  holdRoomFrame,
} from '../../src/lib/simulator-room-frame-handoff';

const roomA = { name: 'room-a' };
const roomB = { name: 'room-b' };
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (frames: Uint8Array[]): string[] => frames.map((f) => new TextDecoder().decode(f));

describe('holding room frames for the next listener', () => {
  it('keeps them in arrival order for the same session and room', () => {
    let held = holdRoomFrame(null, 'agt_1', roomA, bytes('restore'));
    held = holdRoomFrame(held, 'agt_1', roomA, bytes('focus'));
    expect(text(heldRoomFramesFor(held, 'agt_1', roomA))).toEqual(['restore', 'focus']);
  });

  it('gives none to another room or another session', () => {
    const held = holdRoomFrame(null, 'agt_1', roomA, bytes('focus'));
    expect(heldRoomFramesFor(held, 'agt_1', roomB)).toEqual([]);
    expect(heldRoomFramesFor(held, 'agt_2', roomA)).toEqual([]);
    expect(heldRoomFramesFor(null, 'agt_1', roomA)).toEqual([]);
  });

  it('starts over when a frame for a different room is held', () => {
    let held = holdRoomFrame(null, 'agt_1', roomA, bytes('old room'));
    held = holdRoomFrame(held, 'agt_1', roomB, bytes('new room'));
    expect(text(heldRoomFramesFor(held, 'agt_1', roomB))).toEqual(['new room']);
    expect(heldRoomFramesFor(held, 'agt_1', roomA)).toEqual([]);
  });

  it('keeps a copy, not the buffer the transport may reuse', () => {
    const payload = bytes('focus');
    const held = holdRoomFrame(null, 'agt_1', roomA, payload);
    payload.fill(0);
    expect(text(heldRoomFramesFor(held, 'agt_1', roomA))).toEqual(['focus']);
  });

  it('is bounded, dropping the oldest first', () => {
    let held = holdRoomFrame(null, 'agt_1', roomA, bytes('0'));
    for (let i = 1; i <= HELD_ROOM_FRAMES_MAX; i += 1) {
      held = holdRoomFrame(held, 'agt_1', roomA, bytes(String(i)));
    }
    const kept = text(heldRoomFramesFor(held, 'agt_1', roomA));
    expect(kept).toHaveLength(HELD_ROOM_FRAMES_MAX);
    expect(kept[0]).toBe('1');
    expect(kept[kept.length - 1]).toBe(String(HELD_ROOM_FRAMES_MAX));
  });
});
