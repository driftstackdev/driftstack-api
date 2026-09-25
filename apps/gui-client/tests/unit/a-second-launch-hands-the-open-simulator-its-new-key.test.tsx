// Windows / Linux: launching a profile whose Simulator window is already open
// used to FOCUS that window and throw the newly minted control key away. That
// only worked while the server echoed the same key back. Now a mint by a
// different principal rotates the key and the old one stops working, so the
// open window would lose control of its session.
//
// The new key (with the fresh join token) is now handed to the open window,
// the way the macOS app hands a relaunch to its window: the `ds-session`
// event, addressed to THAT window only. The Simulator window listens for it on
// its own window, not on every window — a handoff for one session must never
// be picked up by another session's window.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { LiveKitInfo } from '@driftstack/sdk';

const invoke = vi.fn<(cmd: string, args: unknown) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: unknown): Promise<unknown> => invoke(cmd, args),
}));

const emitTo = vi.fn<(target: unknown, event: string, payload: unknown) => Promise<void>>(() =>
  Promise.resolve(),
);
const globalEmit = vi.fn(() => Promise.resolve());
vi.mock('@tauri-apps/api/event', () => ({
  emitTo: (target: unknown, event: string, payload: unknown) => emitTo(target, event, payload),
  emit: () => globalEmit(),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const existing = {
  label: 'simulator-agt_open',
  setFocus: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
};
const WebviewWindowCtor = vi.fn();
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: Object.assign(WebviewWindowCtor, {
    getByLabel: (l: string) => Promise.resolve(l === existing.label ? existing : null),
  }),
  getCurrentWebviewWindow: () => ({
    outerPosition: () => Promise.resolve({ x: 0, y: 0 }),
    outerSize: () => Promise.resolve({ width: 1200, height: 800 }),
    scaleFactor: () => Promise.resolve(1),
  }),
}));

const { openSimulatorWindow } = await import('../../src/lib/open-simulator');

const info = { ws_url: 'wss://lk.example', token: 'fresh-join-token', room: 'r' } as LiveKitInfo;
const NEW_KEY = `gck_${'b'.repeat(32)}`;

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) =>
    cmd === 'simulator_app_supported' ? Promise.resolve(false) : Promise.resolve(undefined),
  );
  emitTo.mockClear();
  globalEmit.mockClear();
  existing.setFocus.mockClear();
  WebviewWindowCtor.mockClear();
  (globalThis as unknown as { window: unknown }).window = globalThis;
  (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

describe('a second launch of a session whose window is open (Windows, Linux)', () => {
  it('CRITICAL hands the open window the NEW key and join token — addressed to that window only', async () => {
    const res = await openSimulatorWindow({
      sessionId: 'agt_open',
      info,
      controlCredential: {
        key: NEW_KEY,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      baseUrl: 'https://api.example.test',
    });
    expect(res.opened).toBe(true);
    expect(WebviewWindowCtor, 'no second window').not.toHaveBeenCalled();
    expect(emitTo).toHaveBeenCalledTimes(1);
    const [target, event, payload] = emitTo.mock.calls[0]!;
    expect(target).toEqual({ kind: 'WebviewWindow', label: 'simulator-agt_open' });
    expect(event).toBe('ds-session');
    const query = new URLSearchParams(atob(String(payload)));
    expect(query.get('ck')).toBe(NEW_KEY);
    expect(query.get('token')).toBe('fresh-join-token');
    expect(query.get('session')).toBe('agt_open');
    expect(globalEmit, 'never broadcast to every window').not.toHaveBeenCalled();
    expect(existing.setFocus).toHaveBeenCalled();
  });

  it('CONTROL — a first launch builds the window and hands nothing off', async () => {
    WebviewWindowCtor.mockImplementation(function (this: unknown) {
      return {
        once: (ev: string, cb: () => void) => {
          if (ev === 'tauri://created') cb();
          return Promise.resolve();
        },
      };
    });
    const res = await openSimulatorWindow({ sessionId: 'agt_new', info });
    expect(res.opened).toBe(true);
    expect(WebviewWindowCtor).toHaveBeenCalledTimes(1);
    expect(emitTo).not.toHaveBeenCalled();
  });
});
