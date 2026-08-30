// V-2168 — the "type like a human" paste driver.
//
// The property that matters is NOT that the characters arrive: it is that they
// arrive as keystrokes, spaced by a real cadence model, with a per-session
// seed. A paste that sets a field's value in one event, or types at a constant
// interval, is the automation tell this product exists to avoid — so these arms
// pin the timing shape, not just the output.

import { describe, expect, it } from 'vitest';
import {
  pasteAsHumanTyping,
  isHumanPasteChord,
  HUMAN_PASTE_MAX_CHARS,
  type HumanPasteDeps,
} from '../../src/lib/human-paste';

/** A driver harness that records what was sent and how long it waited. */
function harness(
  text: string,
  over: Partial<HumanPasteDeps> = {},
): { deps: HumanPasteDeps; keys: string[]; delays: number[] } {
  const keys: string[] = [];
  const delays: number[] = [];
  const deps: HumanPasteDeps = {
    readClipboard: () => Promise.resolve(text),
    sendKey: (k) => {
      keys.push(k);
      return true;
    },
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
    seed: 'session-a',
    ...over,
  };
  return { deps, keys, delays };
}

describe('pasteAsHumanTyping', () => {
  it('types every character as its own keystroke — never one bulk value', async () => {
    const { deps, keys } = harness('hello');
    const res = await pasteAsHumanTyping(deps);
    expect(res).toMatchObject({ status: 'typed', chars: 5 });
    expect(keys).toEqual(['h', 'e', 'l', 'l', 'o']);
  });

  it('⛔ spaces the keystrokes with a VARIED cadence — a constant interval is the tell', async () => {
    const { deps, delays } = harness('the quick brown fox jumps');
    await pasteAsHumanTyping(deps);
    expect(delays.length).toBeGreaterThan(5);
    // Every delay positive, and genuinely varied: a uniform loop would collapse
    // this set to one value.
    expect(delays.every((d) => d > 0)).toBe(true);
    expect(new Set(delays).size).toBeGreaterThan(3);
  });

  it('⛔ a different session seed produces a different keystroke rhythm — same text, no correlation', async () => {
    const a = harness('correlate me');
    const b = harness('correlate me', { seed: 'session-b' });
    await pasteAsHumanTyping(a.deps);
    await pasteAsHumanTyping(b.deps);
    expect(a.keys).toEqual(b.keys); // same text typed
    expect(a.delays).not.toEqual(b.delays); // different rhythm
  });

  it('a newline is typed as Enter — a literal "\\n" key does nothing on a device', async () => {
    const { deps, keys } = harness('a\nb');
    await pasteAsHumanTyping(deps);
    expect(keys).toEqual(['a', 'Enter', 'b']);
  });

  it('an emoji is ONE keystroke, not its surrogate halves', async () => {
    const { deps, keys } = harness('a🙂b');
    await pasteAsHumanTyping(deps);
    expect(keys).toEqual(['a', '🙂', 'b']);
  });

  it('stops immediately when the caller refuses a key (authority lost / channel congested)', async () => {
    let sent = 0;
    const keys: string[] = [];
    const { deps } = harness('abcdefgh', {
      sendKey: (k) => {
        keys.push(k);
        sent += 1;
        return sent < 4; // the 4th key is refused
      },
    });
    const res = await pasteAsHumanTyping(deps);
    expect(res).toEqual({ status: 'interrupted', chars: 3 });
    expect(keys).toHaveLength(4); // 3 accepted + the refused one
  });

  it('refuses an over-long clipboard rather than flooding the reliable channel', async () => {
    const { deps, keys } = harness('x'.repeat(HUMAN_PASTE_MAX_CHARS + 1));
    const res = await pasteAsHumanTyping(deps);
    expect(res).toEqual({
      status: 'too-long',
      chars: HUMAN_PASTE_MAX_CHARS + 1,
      max: HUMAN_PASTE_MAX_CHARS,
    });
    expect(keys).toHaveLength(0);
  });

  it('reports an empty clipboard, and a denied one, without throwing', async () => {
    expect(await pasteAsHumanTyping(harness('').deps)).toEqual({ status: 'empty' });

    const denied = harness('x', {
      readClipboard: () => Promise.reject(new Error('clipboard unavailable')),
    });
    const res = await pasteAsHumanTyping(denied.deps);
    expect(res).toMatchObject({ status: 'unavailable' });
    expect(denied.keys).toHaveLength(0);
  });
});

describe('isHumanPasteChord', () => {
  const base = { key: 'V', shiftKey: true, ctrlKey: false, metaKey: false, altKey: false };

  it('accepts Ctrl+Shift+V and Cmd+Shift+V', () => {
    expect(isHumanPasteChord({ ...base, ctrlKey: true })).toBe(true);
    expect(isHumanPasteChord({ ...base, metaKey: true })).toBe(true);
    expect(isHumanPasteChord({ ...base, key: 'v', ctrlKey: true })).toBe(true);
  });

  it('⛔ does NOT swallow a plain paste — Cmd/Ctrl+V must still reach the device', () => {
    expect(isHumanPasteChord({ ...base, shiftKey: false, metaKey: true })).toBe(false);
    expect(isHumanPasteChord({ ...base, shiftKey: false, ctrlKey: true })).toBe(false);
  });

  it('ignores an unmodified V, and a chord carrying Alt', () => {
    expect(isHumanPasteChord(base)).toBe(false);
    expect(isHumanPasteChord({ ...base, ctrlKey: true, altKey: true })).toBe(false);
    expect(isHumanPasteChord({ ...base, key: 'c', ctrlKey: true })).toBe(false);
  });
});
