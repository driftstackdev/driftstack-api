// P-25 — the reliable-publish stall bound.
//
// The freeze the owner reported ("load several sites, drive many activities, at
// some point it gets stuck — nothing usable, full restart is the only way") has a
// verified mechanism: the vendored livekit-client's reliable publishData awaits a
// buffer event with NO timer, so a wedged channel parks every later publish
// forever, released only by engine close. These arms pin the bound that stops
// the GUI from creating those parked publishes in the first place. One property
// per arm; a lossy-channel control proves the bound is scoped to the reliable
// channel; a navigate arm pins the deliberate loss of its congestion exemption.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendInputEvent, sendNavigate, type InputEvent, type Room } from '../../src/lib/livekit';
import {
  inflightReliablePublishCount,
  MAX_INFLIGHT_RELIABLE_PUBLISHES,
  ReliableChannelStalledError,
  resetInputReceipts,
  subscribeInputReceiptIssues,
  type InputReceiptIssue,
} from '../../src/lib/livekit-input-ack';

/** A Room whose publishes NEVER settle until `drain()` is called — the wedge. */
function makeWedgedRoom(): { room: Room; drain: () => void; calls: () => number } {
  const resolvers: Array<() => void> = [];
  const publishData = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolvers.push(resolve);
      }),
  );
  return {
    room: { localParticipant: { publishData } } as unknown as Room,
    drain: () => {
      for (const r of resolvers.splice(0)) r();
    },
    calls: () => publishData.mock.calls.length,
  };
}

const tap = (i: number): InputEvent => ({ type: 'tap', x: i, y: i });
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

describe('P-25 reliable-publish stall bound', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('CRITICAL accepts exactly MAX parked reliable publishes, then REFUSES the next by throwing — publishData is not called for it, so nothing is parked that a timeout could never release', async () => {
    const { room, calls } = makeWedgedRoom();
    for (let i = 0; i < MAX_INFLIGHT_RELIABLE_PUBLISHES; i += 1) {
      void sendInputEvent(room, tap(i));
    }
    await flush();
    expect(calls()).toBe(MAX_INFLIGHT_RELIABLE_PUBLISHES);
    expect(inflightReliablePublishCount(room)).toBe(MAX_INFLIGHT_RELIABLE_PUBLISHES);
    await expect(sendInputEvent(room, tap(999))).rejects.toBeInstanceOf(
      ReliableChannelStalledError,
    );
    // The refusal is a refusal: the SDK was not asked.
    expect(calls()).toBe(MAX_INFLIGHT_RELIABLE_PUBLISHES);
    resetInputReceipts(room);
  });

  it('CRITICAL the refusal lights the badge with `stalled` — the customer is told the channel is wedged instead of watching inputs vanish', async () => {
    const { room } = makeWedgedRoom();
    const seen: InputReceiptIssue[] = [];
    const unsubscribe = subscribeInputReceiptIssues(room, (issue) => seen.push(issue));
    for (let i = 0; i < MAX_INFLIGHT_RELIABLE_PUBLISHES; i += 1) void sendInputEvent(room, tap(i));
    await flush();
    await sendInputEvent(room, tap(999)).catch(() => undefined);
    expect(seen).toContain('stalled');
    unsubscribe();
    resetInputReceipts(room);
  });

  it('CRITICAL when the channel drains the gate reopens by itself and the next confirmed send CLEARS the badge — recovery needs no restart once the channel moves', async () => {
    const { room, drain } = makeWedgedRoom();
    const seen: InputReceiptIssue[] = [];
    const unsubscribe = subscribeInputReceiptIssues(room, (issue) => seen.push(issue));
    for (let i = 0; i < MAX_INFLIGHT_RELIABLE_PUBLISHES; i += 1) void sendInputEvent(room, tap(i));
    await flush();
    await sendInputEvent(room, tap(999)).catch(() => undefined);
    expect(seen.at(-1)).toBe('stalled');
    drain(); // every parked publish settles
    await flush();
    expect(inflightReliablePublishCount(room)).toBe(0);
    // A fresh publish on the drained room resolves immediately here (drain() also
    // resolves it, because the double queues every call); it is a confirmed send.
    const p = sendInputEvent(room, tap(1000));
    drain();
    await p;
    expect(seen.at(-1)).toBeNull();
    unsubscribe();
    resetInputReceipts(room);
  });

  it('CONTROL lossy publishes are not counted against the bound — the lossy channel already self-drops, and a wedge there cannot park anything', async () => {
    const { room, calls } = makeWedgedRoom();
    for (let i = 0; i < MAX_INFLIGHT_RELIABLE_PUBLISHES + 5; i += 1) {
      void sendInputEvent(room, { type: 'mouseMove', x: i, y: i }, { reliable: false });
    }
    await flush();
    expect(calls()).toBe(MAX_INFLIGHT_RELIABLE_PUBLISHES + 5);
    expect(inflightReliablePublishCount(room)).toBe(0);
    resetInputReceipts(room);
  });

  it("CRITICAL navigate loses its congestion exemption AT THE STALL BOUND — a 33rd navigate parked behind 32 others cannot escape anything; the badge's reconnect is the escape", async () => {
    const { room, calls } = makeWedgedRoom();
    for (let i = 0; i < MAX_INFLIGHT_RELIABLE_PUBLISHES; i += 1) void sendInputEvent(room, tap(i));
    await flush();
    await expect(sendNavigate(room, 'https://example.com/')).rejects.toBeInstanceOf(
      ReliableChannelStalledError,
    );
    expect(calls()).toBe(MAX_INFLIGHT_RELIABLE_PUBLISHES);
    resetInputReceipts(room);
  });

  it('the bound is 32 — small enough that the retained memory at the limit is hundreds of KB, large enough that a healthy channel never touches it', () => {
    expect(MAX_INFLIGHT_RELIABLE_PUBLISHES).toBe(32);
  });
});
