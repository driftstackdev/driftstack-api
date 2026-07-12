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
});
