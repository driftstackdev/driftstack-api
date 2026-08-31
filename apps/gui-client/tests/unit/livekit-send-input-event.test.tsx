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

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  boundTabListUpdate,
  isBenignTeardownError,
  MAX_INPUT_EVENT_BYTES,
  MAX_INPUT_KEY_CHARS,
  MAX_INPUT_MODIFIERS,
  MAX_NAVIGATION_URL_BYTES,
  MAX_TAB_FIELD_CHARS,
  MAX_TAB_ID_CHARS,
  MAX_TAB_LIST_COUNT,
  MAX_TAB_SNAPSHOT_BYTES,
  MAX_DEVICE_TEXT_BYTES,
  sendInputEvent,
  sendNavigate,
  sendText,
  sendTabListUpdate,
  sendActivateTab,
  type InputEvent,
  type Room,
  type TabListUpdatePayload,
} from '../../src/lib/livekit';
import {
  ReliableInputCongestedError,
  setReliableInputCongested,
} from '../../src/lib/livekit-input-congestion';
import {
  pendingInputReceiptCount,
  resetInputReceipts,
  subscribeInputReceiptIssues,
  type InputReceiptIssue,
} from '../../src/lib/livekit-input-ack';

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
  it('fails fresh reliable intent fast while the room channel is congested', async () => {
    const { room, publishData } = makeRoom();
    setReliableInputCongested(room, true);
    await expect(sendNavigate(room, 'https://example.com/')).rejects.toBeInstanceOf(
      ReliableInputCongestedError,
    );
    expect(publishData).not.toHaveBeenCalled();
  });

  it('still publishes mandatory releases while congested', async () => {
    const { room, publishData } = makeRoom();
    setReliableInputCongested(room, true);
    await sendInputEvent(room, { type: 'touchEnd', x: 1, y: 2, touchId: 3 });
    await sendInputEvent(room, { type: 'keyUp', key: 'Shift' });
    expect(publishData).toHaveBeenCalledTimes(2);
  });

  it('does not gate lossy events while the reliable channel is congested', async () => {
    const { room, publishData } = makeRoom();
    setReliableInputCongested(room, true);
    await sendInputEvent(room, { type: 'ping', timestamp: 1 }, { reliable: false });
    expect(publishData).toHaveBeenCalledTimes(1);
  });

  it('adds a unique ASCII receipt id only to committed input boundaries', async () => {
    const { room, publishData } = makeRoom();
    await sendInputEvent(room, { type: 'tap', x: 1, y: 2 });
    await sendInputEvent(room, { type: 'touchEnd', x: 1, y: 2, touchId: 3 });
    await sendInputEvent(room, { type: 'keyUp', key: 'Enter' });
    await sendInputEvent(room, { type: 'text', text: 'ok' });
    const calls = publishData.mock.calls as unknown as Array<[Uint8Array, { reliable: boolean }]>;
    const ids = calls.map(([data]) => {
      const decoded = JSON.parse(new TextDecoder().decode(data)) as { id?: unknown };
      expect(decoded.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/u);
      return decoded.id;
    });
    expect(new Set(ids).size).toBe(4);
    expect(pendingInputReceiptCount(room)).toBe(4);
    resetInputReceipts(room);
  });

  it('keeps high-rate, start, ping, navigation, and tab-control frames receipt-free', async () => {
    const { room, publishData } = makeRoom();
    await sendInputEvent(room, { type: 'touchStart', x: 1, y: 2, touchId: 3 });
    await sendInputEvent(room, { type: 'touchMove', x: 2, y: 3, touchId: 3 }, { reliable: false });
    await sendInputEvent(room, { type: 'wheel', x: 1, y: 2, deltaX: 0, deltaY: 3 });
    await sendInputEvent(room, { type: 'keyDown', key: 'Enter' });
    await sendInputEvent(room, { type: 'ping', timestamp: 1 }, { reliable: false });
    await sendInputEvent(room, { type: 'navigate', url: 'https://example.com/' });
    const calls = publishData.mock.calls as unknown as Array<[Uint8Array, { reliable: boolean }]>;
    for (const [data] of calls) {
      expect(JSON.parse(new TextDecoder().decode(data))).not.toHaveProperty('id');
    }
    expect(pendingInputReceiptCount(room)).toBe(0);
  });

  it('cancels a registered receipt when publish itself fails', async () => {
    const publishData = vi.fn(() => Promise.reject(new Error('send failed')));
    const room = { localParticipant: { publishData } } as unknown as Room;
    await expect(sendInputEvent(room, { type: 'tap', x: 1, y: 2 })).rejects.toThrow(/send failed/);
    expect(pendingInputReceiptCount(room)).toBe(0);
  });

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

  it('rejects non-finite numeric payloads before they reach LiveKit', async () => {
    const invalidEvents: InputEvent[] = [
      { type: 'touchStart', x: Number.NaN, y: 20, touchId: 1 },
      { type: 'wheel', x: 10, y: 20, deltaX: 0, deltaY: Number.POSITIVE_INFINITY },
      { type: 'ping', timestamp: Number.NaN },
      {
        type: 'tabListUpdate',
        sessionId: 'agt_x',
        tabs: [{ id: 't1', url: 'https://x.test/', scrollY: Number.NaN, title: 'X' }],
        activeTabId: 't1',
      },
    ];
    for (const event of invalidEvents) {
      const { room, publishData } = makeRoom();
      await expect(sendInputEvent(room, event)).rejects.toThrow(/non-finite number/i);
      expect(publishData).not.toHaveBeenCalled();
    }
  });

  it('rejects every oversized encoded envelope before it can block the channel', async () => {
    const { room, publishData } = makeRoom();
    await expect(
      sendInputEvent(room, {
        type: 'tabListUpdate',
        sessionId: 's',
        tabs: [
          {
            id: 't',
            url: 'https://x.test/',
            scrollY: 0,
            title: 'x'.repeat(MAX_INPUT_EVENT_BYTES * 4),
          },
        ],
        activeTabId: 't',
      }),
    ).rejects.toThrow(/exceeds .* encoded bytes/i);
    expect(publishData).not.toHaveBeenCalled();
  });

  it('mirrors receiver key, modifier, URL, and paste bounds before publish', async () => {
    const invalidEvents: InputEvent[] = [
      { type: 'keyDown', key: 'k'.repeat(MAX_INPUT_KEY_CHARS + 1) },
      {
        type: 'keyUp',
        key: 'A',
        modifiers: Array.from({ length: MAX_INPUT_MODIFIERS + 1 }, () => 'shift'),
      },
      { type: 'navigate', url: `https://x.test/${'a'.repeat(MAX_NAVIGATION_URL_BYTES)}` },
      { type: 'text', text: '' },
    ];
    for (const event of invalidEvents) {
      const { room, publishData } = makeRoom();
      await expect(sendInputEvent(room, event)).rejects.toThrow(/invalid/i);
      expect(publishData).not.toHaveBeenCalled();
    }
  });
});

// Teardown-race safety: a publish that lands after the LiveKit RTCEngine is
// closed rejects with "PC manager is closed". sendInputEvent must SWALLOW that
// (and similar teardown errors) so a fire-and-forget caller can't escalate it
// to the global unhandledrejection handler and blank the whole window
// (founder-hit 2026-06-18: the fatal overlay replaced the draggable simulator).
describe('sendInputEvent — benign teardown errors', () => {
  function makeRejectingRoom(message: string): Room {
    const minimal: MinimalRoom = {
      localParticipant: { publishData: () => Promise.reject(new Error(message)) },
    };
    return minimal as unknown as Room;
  }

  it('swallows a "PC manager is closed" rejection (does not throw)', async () => {
    const room = makeRejectingRoom('PC manager is closed');
    await expect(
      sendInputEvent(room, { type: 'ping', timestamp: 1 }, { reliable: false }),
    ).resolves.toBeUndefined();
  });

  it('swallows a "client initiated disconnect" rejection', async () => {
    const room = makeRejectingRoom('Client initiated disconnect');
    await expect(sendInputEvent(room, { type: 'mouseMove', x: 0, y: 0 })).resolves.toBeUndefined();
  });

  it('RE-THROWS a genuine publish failure (not a teardown race)', async () => {
    const room = makeRejectingRoom('DataChannel buffer is full');
    await expect(sendInputEvent(room, { type: 'mouseMove', x: 0, y: 0 })).rejects.toThrow(
      /buffer is full/,
    );
  });
});

// URL navigation rides the SAME reliable data channel as taps (A3 W2668;
// founder "can't press the URL bar" — the fork's URL bar is un-tappable chrome).
// No server route (would 401 for the keychain-less Simulator app); the harness
// re-validates the URL with an http(s) allowlist + SSRF rejection.
describe('sendNavigate', () => {
  it('publishes {type:"navigate", url} on the reliable data channel', async () => {
    const { room, publishData } = makeRoom();
    await sendNavigate(room, 'https://example.com/');
    expect(publishData).toHaveBeenCalledTimes(1);
    const call = firstCall(publishData);
    expect(decodeEvent(call)).toEqual({ type: 'navigate', url: 'https://example.com/' });
    // reliable=true — a dropped navigate would silently fail to load.
    expect(call.opts.reliable).toBe(true);
  });

  it('encodes the URL as UTF-8 JSON (round-trips a query string + unicode path)', async () => {
    const { room, publishData } = makeRoom();
    await sendNavigate(room, 'https://例え.テスト/path?q=café&x=1');
    const decoded = decodeEvent(firstCall(publishData));
    if (decoded.type === 'navigate') {
      expect(decoded.url).toBe('https://例え.テスト/path?q=café&x=1');
    } else {
      throw new Error('expected a navigate event');
    }
  });

  it('swallows a benign teardown rejection (shares sendInputEvent codepath)', async () => {
    const minimal = {
      localParticipant: { publishData: () => Promise.reject(new Error('PC manager is closed')) },
    };
    await expect(
      sendNavigate(minimal as unknown as Room, 'https://example.com/'),
    ).resolves.toBeUndefined();
  });
});

// Browser-style page TABS (doc-150 item 4; locked A2↔A3 contract). The GUI emits the
// full tab list on every change + an activateTab (with a correlation requestId) on a
// switch, both over the SAME reliable data channel as taps/navigate.
/**
 * Flush microtasks until `mock` has been called `want` times.
 *
 * ⚠️ Replaces a fixed `await Promise.resolve()` x2/x3. That pinned the drain's exact
 * MICROTASK-TICK COUNT, which is scaffolding rather than the property under test — the
 * property is "once the in-flight publish settles, the drain sends the latest pending
 * snapshot and only that one". Bounding the tab-sync publish added a hop and broke both
 * arms without changing anything a customer could observe. The cap keeps a genuine
 * regression failing rather than hanging, and the call-count assertions after the final
 * release still pin the total, so nothing here can over-publish unnoticed.
 */
async function flushUntilCalls(mock: { mock: { calls: unknown[] } }, want: number): Promise<void> {
  for (let i = 0; i < 50 && mock.mock.calls.length < want; i += 1) {
    await Promise.resolve();
  }
}

describe('sendTabListUpdate', () => {
  it('a publish that never settles does not wedge tab sync forever', async () => {
    vi.useFakeTimers();
    // ⛔ Unconditional. When this arm first failed on a bad fixture, a trailing
    // `useRealTimers()` never ran and leaked fake timers into the next two tests —
    // one real failure presented as three, and the two innocent ones looked like
    // regressions in code I had not touched.
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // livekit's publishData resolves through `waitForBufferStatusLow`, which in
    // 2.19.2 settles ONLY on a `bufferedamountlow` event and rejects only on engine
    // close. A congested channel on a live engine therefore never settles. `never`
    // models exactly that: a promise with no path to resolution.
    let mode: 'never' | 'resolve' = 'never';
    const publishData = vi.fn(() =>
      mode === 'resolve' ? Promise.resolve() : new Promise<void>(() => {}),
    );
    const room = { localParticipant: { publishData } } as unknown as Room;
    const snapshot = (): TabListUpdatePayload => ({
      sessionId: 'agt_x',
      tabs: [{ id: 't1', url: 'https://a.test/', scrollY: 0, title: 'a' }],
      activeTabId: 't1',
    });

    const first = sendTabListUpdate(room, snapshot());
    await vi.advanceTimersByTimeAsync(5_000);
    // Before the bound existed this await never returned, the drain's `finally` never
    // ran, and `state.drain` stayed armed for the lifetime of the Room.
    await expect(first).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);

    // THE ASSERTION THAT MATTERS. A reset coordinator must accept new work. If
    // `state.drain` were still armed this returns the dead promise and publishes nothing.
    mode = 'resolve';
    const before = publishData.mock.calls.length;
    await sendTabListUpdate(room, snapshot());
    expect(publishData.mock.calls.length).toBeGreaterThan(before);

    // Warned once per Room, never per event: a wedged channel must not become the
    // failure by flooding the console.
    mode = 'never';
    const third = sendTabListUpdate(room, snapshot());
    await vi.advanceTimersByTimeAsync(5_000);
    await third;
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockRestore();
  });

  it('bounds semi-trusted tab fields/count before publish and retains an active tab beyond the prefix', () => {
    const longId = 'i'.repeat(MAX_TAB_ID_CHARS + 50);
    const longField = 'x'.repeat(MAX_TAB_FIELD_CHARS + 500);
    const tabs: TabListUpdatePayload['tabs'] = Array.from(
      { length: MAX_TAB_LIST_COUNT + 5 },
      (_, index) => ({
        id: index === MAX_TAB_LIST_COUNT + 4 ? longId : `t${index}`,
        url: longField,
        scrollY: index,
        title: longField,
      }),
    );
    const bounded = boundTabListUpdate({ sessionId: 's', tabs, activeTabId: longId });
    expect(bounded.tabs.length).toBeGreaterThan(0);
    expect(bounded.tabs.length).toBeLessThanOrEqual(MAX_TAB_LIST_COUNT);
    expect(bounded.activeTabId).toHaveLength(MAX_TAB_ID_CHARS);
    expect(bounded.tabs.at(-1)?.id).toBe(bounded.activeTabId);
    expect(bounded.tabs.every((tab) => tab.url.length <= MAX_TAB_FIELD_CHARS)).toBe(true);
    expect(bounded.tabs.every((tab) => tab.title.length <= MAX_TAB_FIELD_CHARS)).toBe(true);
    expect(
      new TextEncoder().encode(JSON.stringify({ type: 'tabListUpdate', ...bounded })).byteLength,
    ).toBeLessThanOrEqual(MAX_TAB_SNAPSHOT_BYTES);
  });

  it('keeps ordinary snapshots byte-identical', () => {
    const payload: TabListUpdatePayload = {
      sessionId: 's',
      tabs: [{ id: 't1', url: 'https://x.test/', scrollY: 42, title: 'Example' }],
      activeTabId: 't1',
    };
    expect(boundTabListUpdate(payload)).toEqual(payload);
  });

  it('publishes {type:"tabListUpdate", sessionId, tabs, activeTabId} reliably (full list)', async () => {
    const { room, publishData } = makeRoom();
    const tabs = [
      { id: 't1', url: 'https://a.example/', scrollY: 0, title: 'A' },
      { id: 't2', url: 'about:blank', scrollY: 120, title: 'New Tab' },
    ];
    await sendTabListUpdate(room, { sessionId: 'agt_x', tabs, activeTabId: 't2' });
    expect(publishData).toHaveBeenCalledTimes(1);
    const call = firstCall(publishData);
    expect(decodeEvent(call)).toEqual({
      type: 'tabListUpdate',
      sessionId: 'agt_x',
      tabs,
      activeTabId: 't2',
    });
    // reliable=true — a dropped list leaves the harness's tab set stale.
    expect(call.opts.reliable).toBe(true);
  });

  it('preserves the exact tab field shape + order (id/url/scrollY/title) on the wire', async () => {
    const { room, publishData } = makeRoom();
    await sendTabListUpdate(room, {
      sessionId: 's',
      tabs: [{ id: 'only', url: 'https://x.test/p?q=1', scrollY: 42, title: 'T' }],
      activeTabId: 'only',
    });
    const decoded = decodeEvent(firstCall(publishData));
    if (decoded.type === 'tabListUpdate') {
      expect(decoded.tabs).toEqual([
        { id: 'only', url: 'https://x.test/p?q=1', scrollY: 42, title: 'T' },
      ]);
    } else {
      throw new Error('expected a tabListUpdate event');
    }
  });

  it('bounds a congested reliable queue to the in-flight snapshot plus the latest truth', async () => {
    const releases: Array<() => void> = [];
    const publishData = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
    const room = { localParticipant: { publishData } } as unknown as Room;
    const snapshot = (activeTabId: string): TabListUpdatePayload => ({
      sessionId: 'agt_x',
      tabs: [{ id: activeTabId, url: `https://${activeTabId}.example/`, scrollY: 0, title: '' }],
      activeTabId,
    });

    const first = sendTabListUpdate(room, snapshot('first'));
    const obsolete = sendTabListUpdate(room, snapshot('obsolete'));
    const latest = sendTabListUpdate(room, snapshot('latest'));
    expect(publishData).toHaveBeenCalledTimes(1);
    expect(decodeEvent(firstCall(publishData))).toMatchObject({ activeTabId: 'first' });

    releases.shift()?.();
    await flushUntilCalls(publishData, 2);
    expect(publishData).toHaveBeenCalledTimes(2);
    const calls = publishData.mock.calls as unknown as Array<[Uint8Array, { reliable: boolean }]>;
    const second = calls[1];
    if (second === undefined) throw new Error('second publishData call missing');
    expect(decodeEvent({ data: second[0], opts: second[1] })).toMatchObject({
      activeTabId: 'latest',
    });

    releases.shift()?.();
    await Promise.all([first, obsolete, latest]);
    expect(publishData).toHaveBeenCalledTimes(2);
  });

  it('keeps callers without an authority predicate supported, but drops an initially stale owner', async () => {
    const { room, publishData } = makeRoom();
    const snapshot: TabListUpdatePayload = {
      sessionId: 'agt_x',
      tabs: [{ id: 't1', url: 'about:blank', scrollY: 0, title: 'New Tab' }],
      activeTabId: 't1',
    };
    await sendTabListUpdate(room, snapshot);
    expect(publishData).toHaveBeenCalledTimes(1);

    await sendTabListUpdate(room, { ...snapshot, activeTabId: null }, () => false);
    expect(publishData).toHaveBeenCalledTimes(1);
  });

  it('rechecks a queued snapshot at drain time and drops it after its epoch becomes stale', async () => {
    const releases: Array<() => void> = [];
    const publishData = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
    const room = { localParticipant: { publishData } } as unknown as Room;
    const snapshot = (activeTabId: string): TabListUpdatePayload => ({
      sessionId: 'agt_x',
      tabs: [{ id: activeTabId, url: 'about:blank', scrollY: 0, title: '' }],
      activeTabId,
    });
    let epochCurrent = true;
    const first = sendTabListUpdate(room, snapshot('first'));
    const stale = sendTabListUpdate(room, snapshot('stale'), () => epochCurrent);
    epochCurrent = false;

    releases.shift()?.();
    await Promise.all([first, stale]);
    expect(publishData).toHaveBeenCalledTimes(1);
    expect(decodeEvent(firstCall(publishData))).toMatchObject({ activeTabId: 'first' });
  });

  it('an initially stale callback cannot erase a different current pending snapshot', async () => {
    const releases: Array<() => void> = [];
    const publishData = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
    const room = { localParticipant: { publishData } } as unknown as Room;
    const snapshot = (activeTabId: string): TabListUpdatePayload => ({
      sessionId: 'agt_x',
      tabs: [{ id: activeTabId, url: 'about:blank', scrollY: 0, title: '' }],
      activeTabId,
    });
    const first = sendTabListUpdate(room, snapshot('first'));
    const current = sendTabListUpdate(room, snapshot('current'), () => true);
    const stale = sendTabListUpdate(room, snapshot('stale'), () => false);

    releases.shift()?.();
    await flushUntilCalls(publishData, 2);
    expect(publishData).toHaveBeenCalledTimes(2);
    const calls = publishData.mock.calls as unknown as Array<[Uint8Array, { reliable: boolean }]>;
    const second = calls[1];
    if (second === undefined) throw new Error('second publishData call missing');
    expect(decodeEvent({ data: second[0], opts: second[1] })).toMatchObject({
      activeTabId: 'current',
    });

    releases.shift()?.();
    await Promise.all([first, current, stale]);
    expect(publishData).toHaveBeenCalledTimes(2);
  });
});

describe('sendActivateTab', () => {
  it('lets a caller reserve the exact requestId before publish begins', async () => {
    const { room, publishData } = makeRoom();
    let requestId: string | null = null;
    const published = sendActivateTab(
      room,
      {
        sessionId: 'agt_x',
        tabId: 't2',
        prevTabId: 't1',
        url: 'https://b.example/',
        scrollY: 300,
      },
      (reservedRequestId) => {
        requestId = reservedRequestId;
        expect(publishData).not.toHaveBeenCalled();
      },
    );
    expect(requestId).not.toBeNull();
    expect(decodeEvent(firstCall(publishData))).toMatchObject({
      type: 'activateTab',
      requestId,
    });
    await expect(published).resolves.toBe(requestId);
  });

  it('publishes {type:"activateTab", requestId, sessionId, tabId, prevTabId, url, scrollY} reliably', async () => {
    const { room, publishData } = makeRoom();
    const requestId = await sendActivateTab(room, {
      sessionId: 'agt_x',
      tabId: 't2',
      prevTabId: 't1',
      url: 'https://b.example/',
      scrollY: 300,
    });
    expect(typeof requestId).toBe('string');
    expect(requestId.length).toBeGreaterThan(0);
    const call = firstCall(publishData);
    expect(decodeEvent(call)).toEqual({
      type: 'activateTab',
      requestId,
      sessionId: 'agt_x',
      tabId: 't2',
      prevTabId: 't1',
      url: 'https://b.example/',
      scrollY: 300,
    });
    expect(call.opts.reliable).toBe(true);
  });

  it('returns the SAME requestId it put on the wire (correlation contract)', async () => {
    const { room, publishData } = makeRoom();
    const requestId = await sendActivateTab(room, {
      sessionId: 's',
      tabId: 't',
      prevTabId: 'prior',
      url: 'about:blank',
      scrollY: 0,
    });
    const decoded = decodeEvent(firstCall(publishData));
    if (decoded.type === 'activateTab') {
      expect(decoded.requestId).toBe(requestId);
    } else {
      throw new Error('expected an activateTab event');
    }
  });

  it('mints a UNIQUE requestId per call', async () => {
    const { room } = makeRoom();
    const a = await sendActivateTab(room, {
      sessionId: 's',
      tabId: 't',
      prevTabId: 'prior',
      url: 'u',
      scrollY: 0,
    });
    const b = await sendActivateTab(room, {
      sessionId: 's',
      tabId: 't',
      prevTabId: 'prior',
      url: 'u',
      scrollY: 0,
    });
    expect(a).not.toBe(b);
  });
});

describe('sendText', () => {
  it('sends ONE atomic {type:"text", text} reliably (paste-into-device, not per-char)', async () => {
    const { room, publishData } = makeRoom();
    await sendText(room, 'hunter2 pa$$word');
    const call = firstCall(publishData);
    expect(decodeEvent(call)).toMatchObject({ type: 'text', text: 'hunter2 pa$$word' });
    expect(decodeEvent(call)).toHaveProperty('id');
    expect(call.opts.reliable).toBe(true);
    // exactly one publish — a long paste must never fan out into per-char keyDowns
    // (that flood is the reliable-channel HOL problem this event exists to avoid).
    expect(publishData).toHaveBeenCalledTimes(1);
  });

  it('preserves unicode + newlines round-trip through the UTF-8 JSON wire', async () => {
    const { room, publishData } = makeRoom();
    await sendText(room, 'café\n日本語\ttab');
    expect(decodeEvent(firstCall(publishData))).toMatchObject({
      type: 'text',
      text: 'café\n日本語\ttab',
    });
  });

  it('rejects oversized UTF-8 text before it can occupy the reliable channel', async () => {
    const { room, publishData } = makeRoom();
    await expect(sendText(room, 'é'.repeat(MAX_DEVICE_TEXT_BYTES / 2 + 1))).rejects.toThrow(
      /exceeds 8192 UTF-8 bytes/,
    );
    expect(publishData).not.toHaveBeenCalled();
  });

  it('accepts text exactly at the harness 8 KiB boundary', async () => {
    const { room, publishData } = makeRoom();
    const text = 'é'.repeat(MAX_DEVICE_TEXT_BYTES / 2);
    await sendText(room, text);
    expect(decodeEvent(firstCall(publishData))).toMatchObject({ type: 'text', text });
  });
});

describe('isBenignTeardownError', () => {
  it('classifies LiveKit teardown errors as benign', () => {
    for (const m of [
      'PC manager is closed',
      'Client initiated disconnect',
      'engine is closed',
      'engine closed',
      'not connected',
    ]) {
      expect(isBenignTeardownError(new Error(m))).toBe(true);
    }
  });

  it('does NOT classify real errors as benign', () => {
    for (const m of ['DataChannel buffer is full', 'unauthorized', 'network error', '']) {
      expect(isBenignTeardownError(new Error(m))).toBe(false);
    }
  });

  it('handles non-Error rejection values', () => {
    expect(isBenignTeardownError('PC manager is closed')).toBe(true);
    expect(isBenignTeardownError(null)).toBe(false);
  });
});

describe('a reliable input publish that never settles is abandoned, not awaited forever', () => {
  // ⛔ livekit-client 2.19.2 resolves publishData through `waitForBufferStatusLow`,
  // which settles ONLY on a `bufferedamountlow` event and rejects only on engine
  // close. There is no timer. A reliable channel that stays congested while the
  // engine stays up therefore produces a promise that NEVER settles.
  //
  // The tab-sync path was bounded first because that wedged a single-flight drain.
  // Input deadlocks nothing — every caller is fire-and-forget — but each abandoned
  // publish retains its promise, closure and encoded frame for the life of the
  // Room, and mandatory releases (touchEnd/keyUp/mouseUp) are exempt from
  // congestion shedding by design, so they keep publishing and keep accumulating.

  it('returns once the bound elapses instead of hanging on a promise that never settles', async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { room, publishData } = makeRoom();
    // A publish that never settles — the real congested-channel shape.
    publishData.mockReturnValue(new Promise<void>(() => undefined));

    let done = false;
    const sent = sendInputEvent(room, { type: 'keyUp', key: 'a' }).then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(4_000);
    expect(done, 'must still be waiting before the bound elapses').toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    await sent;
    expect(done, 'must return once the bound elapses').toBe(true);
  });

  it('LEAVES THE RECEIPT ARMED on timeout, so the customer is still told', async () => {
    vi.useFakeTimers();
    const { room, publishData } = makeRoom();
    onTestFinished(() => {
      vi.useRealTimers();
      resetInputReceipts(room);
    });
    publishData.mockReturnValue(new Promise<void>(() => undefined));

    const issues: InputReceiptIssue[] = [];
    const unsubscribe = subscribeInputReceiptIssues(room, (issue) => {
      issues.push(issue);
    });
    onTestFinished(unsubscribe);

    // TWO hung releases, not one: MISSED_ACKS_BEFORE_ALARM is 2, so a single
    // missed ack deliberately does not raise the badge. Two is also the realistic
    // congested case — releases are exempt from shedding, so they keep going out.
    const sent = Promise.all([
      sendInputEvent(room, { type: 'keyUp', key: 'b' }),
      sendInputEvent(room, { type: 'keyUp', key: 'c' }),
    ]);
    await vi.advanceTimersByTimeAsync(6_000);
    await sent;

    // ⛔ THIS IS THE WHOLE POINT OF THE FIX. Routing the timeout into the rejection
    // path would call cancelInputReceipt, and a cancelled receipt reports NOTHING —
    // the exact silence P-19 removed. The receipt is registered BEFORE the publish
    // precisely so its own deadline can fire the "device did not confirm" badge.
    //
    // Asserting the ISSUE rather than a residual pending count on purpose: by the
    // time the bound elapses the receipt deadline has also elapsed and correctly
    // retired the entry, so the table is empty in BOTH the fixed and the broken
    // build. What distinguishes them is whether the customer was told.
    expect(
      issues.filter((i) => i !== null),
      'a timed-out publish must still raise the receipt issue, not cancel it into silence',
    ).toContain('timeout');
  });

  it('a publish that DOES settle still resolves immediately and keeps its receipt', async () => {
    // Non-vacuity: the arms above must be measuring the bound, not a helper that
    // always waits 5s or always leaks a receipt.
    vi.useFakeTimers();
    const { room, publishData } = makeRoom();
    onTestFinished(() => {
      vi.useRealTimers();
      resetInputReceipts(room);
    });
    publishData.mockResolvedValue(undefined);

    let done = false;
    const sent = sendInputEvent(room, { type: 'keyUp', key: 'c' }).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    await sent;
    expect(done, 'a healthy publish must not wait for the bound').toBe(true);
    expect(publishData).toHaveBeenCalledTimes(1);
  });
});

describe('the bound must not silence a receipt whose deadline is LONGER than the bound', () => {
  // ⛔ The tap/key receipt deadline and the publish bound are both ~5s, and the
  // receipt timer is armed first, so it wins that tie and reports before anything
  // could cancel it. That coincidence hides the real hazard.
  //
  // `text` receipts do not share it: their deadline scales with character count
  // (min 15s, up to 15 minutes) because the harness applies bulk text at human key
  // cadence. So a bound that cancelled its receipt on timeout would retire a
  // 15-second receipt after 5 seconds and report NOTHING — a long paste that never
  // landed, with no badge. That is the P-19 silence, reintroduced.
  it('a hung text publish still raises the badge at the receipt deadline, not the bound', async () => {
    vi.useFakeTimers();
    const { room, publishData } = makeRoom();
    onTestFinished(() => {
      vi.useRealTimers();
      resetInputReceipts(room);
    });
    publishData.mockReturnValue(new Promise<void>(() => undefined));

    const issues: InputReceiptIssue[] = [];
    const unsubscribe = subscribeInputReceiptIssues(room, (issue) => {
      issues.push(issue);
    });
    onTestFinished(unsubscribe);

    const sent = Promise.all([
      sendInputEvent(room, { type: 'text', text: 'hello' }),
      sendInputEvent(room, { type: 'text', text: 'world' }),
    ]);
    await vi.advanceTimersByTimeAsync(6_000);
    await sent;
    expect(
      issues.filter((i) => i !== null),
      'the bound elapsed but the text receipt deadline (>=15s) has not — nothing to report yet',
    ).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(12_000);
    expect(
      issues.filter((i) => i !== null),
      'cancelling the receipt when the bound elapsed would retire a 15s receipt at 5s and report nothing',
    ).toContain('timeout');
  });
});
