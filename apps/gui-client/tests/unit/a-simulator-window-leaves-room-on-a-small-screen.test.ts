// Owner, T-12: "On small screens, the simulator may take almost all of the
// screen; we may want it smaller."
//
// MEASURED: the floating Simulator is its own window. `fitWindow` and
// `resetToActualSize` in views/SimulatorWindow.tsx each clamped the window
// height with a hand-written `if (height > avail - 24) height = avail - 24`,
// and nothing else bounded it — on a 13" laptop (work area ≈ 875px) that is an
// 851px phone covering the whole screen. There was no fractional cap, no 1:1
// ceiling, and the two copies had already drifted once (#75b).
//
// The fix is one pure helper both sites call (lib/simulator-window-fit.ts):
// a small work area gives the phone at most 82% of it, a big one keeps the old
// `- 24`, and no screen ever draws the device larger than 1:1. Alongside it, the
// size the customer leaves the phone at is remembered per screen and preferred
// over the 330×718 default the next time the in-process window opens.
//
// The clamp arms are pure arithmetic. The remembered-size arms go through the
// REAL `openSimulatorWindow` with the platform reporting no separate app (the
// in-process path), a Map-backed settings store, and a fake WebviewWindow that
// records the options it was built with — so the arm proves the size that
// reaches the window constructor, not a helper the opener might not call.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveKitInfo } from '@driftstack/sdk';
import {
  fitSimulatorHeight,
  initialSimulatorSize,
  simulatorScreenKey,
} from '../../src/lib/simulator-window-fit';

// ── the settings store the opener reads the remembered size from ─────────────
const disk = new Map<string, unknown>();
let storeReadFails = false;
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    get<T>(key: string): Promise<T | undefined> {
      if (storeReadFails) return Promise.reject(new Error('settings.json unreadable'));
      return Promise.resolve(disk.get(key) as T | undefined);
    }
    set(key: string, value: unknown): Promise<void> {
      disk.set(key, value);
      return Promise.resolve();
    }
    save(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

// ── Tauri IPC: only the platform question matters here ───────────────────────
const invoke = vi.fn<(cmd: string, args: unknown) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: unknown): Promise<unknown> => invoke(cmd, args),
}));

// ── the window the opener builds, recording its options ──────────────────────
interface FakeWindow {
  label: string;
  options: Record<string, unknown>;
  once: (event: string, cb: () => void) => Promise<void>;
  setFocus: () => Promise<void>;
  close: () => Promise<void>;
}
const constructed: FakeWindow[] = [];
// A `function` expression, NOT an arrow: the source calls `new WebviewWindow(...)`.
const WebviewWindowCtor = vi.fn(function (label: string, options: Record<string, unknown>) {
  const win: FakeWindow = {
    label,
    options,
    once: (event, cb) => {
      if (event === 'tauri://created') cb();
      return Promise.resolve();
    },
    setFocus: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  constructed.push(win);
  return win;
});
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: Object.assign(WebviewWindowCtor, { getByLabel: () => Promise.resolve(null) }),
  getCurrentWebviewWindow: () => ({
    outerPosition: () => Promise.resolve({ x: 100, y: 50 }),
    outerSize: () => Promise.resolve({ width: 1000, height: 700 }),
    scaleFactor: () => Promise.resolve(1),
  }),
}));

const { openSimulatorWindow } = await import('../../src/lib/open-simulator');

const info = { ws_url: 'wss://lk.example', token: 'tok', room: 'room-1' } as LiveKitInfo;
/** The screen both ends key the remembered size by — a 13" laptop work area. */
const LAPTOP = { availWidth: 1440, availHeight: 875 };
const LAPTOP_KEY = '1440x875';
/** The defaults the opener falls back to (SIM_WIDTH / SIM_HEIGHT). */
const DEFAULT_SIZE = { width: 330, height: 718 };

describe('fitSimulatorHeight — the phone leaves room on a small screen', () => {
  it('CRITICAL a 720px work area caps a 900px phone at 82% of the screen (590), not at the old 696', () => {
    expect(fitSimulatorHeight({ desired: 900, availHeight: 720, nativeLogicalHeight: 844 })).toBe(
      590,
    );
  });

  it('and that small-screen result is also under the device at 1:1', () => {
    expect(
      fitSimulatorHeight({ desired: 900, availHeight: 720, nativeLogicalHeight: 844 }),
    ).toBeLessThanOrEqual(844);
  });

  it('a 1440px work area leaves a 900px phone alone — the fraction is for small screens only', () => {
    expect(fitSimulatorHeight({ desired: 900, availHeight: 1440 })).toBe(900);
  });

  it('CRITICAL a phone taller than the device is brought back to 1:1 (2000 with native 844 → 844)', () => {
    expect(fitSimulatorHeight({ desired: 2000, availHeight: 1440, nativeLogicalHeight: 844 })).toBe(
      844,
    );
  });

  it('VACUITY CONTROL: on a big screen the old `avail - 24` rule still applies (1440, 1500 → 1416, not 82% = 1181)', () => {
    expect(fitSimulatorHeight({ desired: 1500, availHeight: 1440 })).toBe(1416);
  });

  it('VACUITY CONTROL: an unknown work area (0) applies no screen clamp at all — as before', () => {
    expect(fitSimulatorHeight({ desired: 900, availHeight: 0 })).toBe(900);
  });

  it('the small-screen rule starts just under 900px: 899 → 82% (737)', () => {
    expect(fitSimulatorHeight({ desired: 900, availHeight: 899 })).toBe(737);
  });

  it('and 900 itself is a big screen: 900 → avail - 24 (876)', () => {
    expect(fitSimulatorHeight({ desired: 900, availHeight: 900 })).toBe(876);
  });
});

describe('simulatorScreenKey — the screen a remembered size belongs to', () => {
  it('keys by the work area WxH so both ends of the store agree', () => {
    expect(simulatorScreenKey(LAPTOP)).toBe(LAPTOP_KEY);
  });

  it('VACUITY CONTROL: a 0×0 screen (jsdom, a headless preview) has no key — nothing is remembered or read', () => {
    expect(simulatorScreenKey({ availWidth: 0, availHeight: 0 })).toBeNull();
  });

  it('and no screen at all has no key either', () => {
    expect(simulatorScreenKey(undefined)).toBeNull();
  });
});

describe('initialSimulatorSize — remembered size over the default', () => {
  const min = { width: 280, height: 560 };

  it('prefers the remembered size', () => {
    expect(
      initialSimulatorSize({
        remembered: { width: 300, height: 650 },
        fallback: DEFAULT_SIZE,
        min,
      }),
    ).toEqual({ width: 300, height: 650 });
  });

  it('VACUITY CONTROL: with nothing remembered, the default', () => {
    expect(initialSimulatorSize({ remembered: null, fallback: DEFAULT_SIZE, min })).toEqual(
      DEFAULT_SIZE,
    );
  });

  it('a remembered size below the window minimum is not "the size the customer chose" — the default', () => {
    expect(
      initialSimulatorSize({
        remembered: { width: 100, height: 200 },
        fallback: DEFAULT_SIZE,
        min,
      }),
    ).toEqual(DEFAULT_SIZE);
  });
});

describe('the in-process simulator window opens at the size remembered for this screen', () => {
  beforeEach(() => {
    disk.clear();
    storeReadFails = false;
    constructed.length = 0;
    WebviewWindowCtor.mockClear();
    invoke.mockReset();
    // No separate app on this platform → the in-process window, which is the
    // path that reads the remembered size. Every other command resolves.
    invoke.mockImplementation((cmd: string) =>
      cmd === 'simulator_app_supported' ? Promise.resolve(false) : Promise.resolve(undefined),
    );
    // Under Tauri, on a laptop screen. The node project has no `window`; the
    // opener reads `window.screen` for the screen key.
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = globalThis;
    g.__TAURI_INTERNALS__ = {};
    g.screen = LAPTOP;
  });

  it('CRITICAL prefers the size remembered for THIS screen over the 330×718 default', async () => {
    disk.set('driftstack', {
      baseUrl: 'https://api.driftstack.dev',
      simulatorWindowSize: { [LAPTOP_KEY]: { width: 300, height: 650 } },
    });
    const res = await openSimulatorWindow({ sessionId: 'agt_remembered', info });
    expect(res.opened, `the in-process path failed: ${res.reason ?? ''}`).toBe(true);
    expect(constructed[0]?.options).toMatchObject({ width: 300, height: 650 });
  });

  it('VACUITY CONTROL: with nothing remembered the window opens at the 330×718 default', async () => {
    disk.set('driftstack', { baseUrl: 'https://api.driftstack.dev' });
    await openSimulatorWindow({ sessionId: 'agt_default', info });
    expect(constructed[0]?.options).toMatchObject(DEFAULT_SIZE);
  });

  it('a size remembered for ANOTHER screen is not this screen’s size — the default', async () => {
    disk.set('driftstack', {
      simulatorWindowSize: { '1920x1055': { width: 420, height: 900 } },
    });
    await openSimulatorWindow({ sessionId: 'agt_other_screen', info });
    expect(constructed[0]?.options).toMatchObject(DEFAULT_SIZE);
  });

  it('a settings store that cannot be read still opens the window, at the default, and says why', async () => {
    storeReadFails = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const res = await openSimulatorWindow({ sessionId: 'agt_unreadable', info });
      expect(res.opened, `the launch failed on a store read: ${res.reason ?? ''}`).toBe(true);
      expect(constructed[0]?.options).toMatchObject(DEFAULT_SIZE);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('remembered window size'))).toBe(
        true,
      );
    } finally {
      warn.mockRestore();
    }
  });
});
