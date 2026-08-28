import { describe, expect, it, vi } from 'vitest';
import { pasteClipboardToDevice } from '../../src/lib/device-paste';
import { ReliableInputCongestedError } from '../../src/lib/livekit-input-congestion';

describe('pasteClipboardToDevice', () => {
  it('does not send after an in-place session swap during clipboard read', async () => {
    let current = true;
    const send = vi.fn(() => Promise.resolve());
    const result = await pasteClipboardToDevice(
      () => {
        current = false;
        return Promise.resolve('private value');
      },
      send,
      () => current,
      8_192,
    );
    expect(result).toBe('stale');
    expect(send).not.toHaveBeenCalled();
  });

  it('distinguishes clipboard-read failures from device-send failures', async () => {
    await expect(
      pasteClipboardToDevice(
        () => Promise.reject(new Error('permission denied')),
        vi.fn(),
        () => true,
        8_192,
      ),
    ).resolves.toBe('clipboard_error');
    await expect(
      pasteClipboardToDevice(
        () => Promise.resolve('hello'),
        () => Promise.reject(new Error('data channel closed')),
        () => true,
        8_192,
      ),
    ).resolves.toBe('send_error');
  });

  it('distinguishes temporary reliable-channel congestion from a real send failure', async () => {
    await expect(
      pasteClipboardToDevice(
        () => Promise.resolve('hello'),
        () => Promise.reject(new ReliableInputCongestedError()),
        () => true,
        8_192,
      ),
    ).resolves.toBe('congested');
  });

  it('enforces the UTF-8 byte limit before sending', async () => {
    const send = vi.fn(() => Promise.resolve());
    await expect(
      pasteClipboardToDevice(
        () => Promise.resolve('🙂🙂'),
        send,
        () => true,
        7,
      ),
    ).resolves.toBe('too_large');
    expect(send).not.toHaveBeenCalled();
  });

  // ── the send-side of the "both awaits" claim ───────────────────────────────
  // The source says `isCurrent` is checked across BOTH awaits so a session swap
  // never delivers clipboard contents into the previous session's room. The arm
  // above proves the READ-side swap. These prove the send-side, which is the
  // half a refactor to "check once at the top" would silently remove.
  it('CRITICAL a swap DURING send is reported stale, not ok — a success notice for a paste that landed in the wrong room is the worst outcome this function has', async () => {
    let current = true;
    const result = await pasteClipboardToDevice(
      () => Promise.resolve('private value'),
      () => {
        current = false; // the swap happens while the send is in flight
        return Promise.resolve();
      },
      () => current,
      8_192,
    );
    expect(result).toBe('stale');
  });

  it('CRITICAL a swap during a CONGESTED send is stale, not congested — "paste again in a moment" after the session moved would invite a second paste into the wrong room', async () => {
    let current = true;
    const result = await pasteClipboardToDevice(
      () => Promise.resolve('private value'),
      () => {
        current = false;
        return Promise.reject(new ReliableInputCongestedError());
      },
      () => current,
      8_192,
    );
    expect(result).toBe('stale');
  });

  it('a swap during a FAILED send is stale, not send_error, for the same reason', async () => {
    let current = true;
    const result = await pasteClipboardToDevice(
      () => Promise.resolve('private value'),
      () => {
        current = false;
        return Promise.reject(new Error('data channel closed'));
      },
      () => current,
      8_192,
    );
    expect(result).toBe('stale');
  });

  it('the happy path is ok, and an empty clipboard is empty without touching the device', async () => {
    const send = vi.fn(() => Promise.resolve());
    await expect(
      pasteClipboardToDevice(
        () => Promise.resolve('hello'),
        send,
        () => true,
        8_192,
      ),
    ).resolves.toBe('ok');
    expect(send).toHaveBeenCalledWith('hello');

    const untouched = vi.fn(() => Promise.resolve());
    await expect(
      pasteClipboardToDevice(
        () => Promise.resolve(''),
        untouched,
        () => true,
        8_192,
      ),
    ).resolves.toBe('empty');
    expect(untouched).not.toHaveBeenCalled();
  });
});
