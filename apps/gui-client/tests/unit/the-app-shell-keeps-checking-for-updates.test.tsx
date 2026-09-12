// T-14 — the App shell's update check used to be one effect that ran once on
// mount. The loop that repeats it lives in lib/updater.ts and is pinned with
// fake time in the-update-check-repeats-while-the-app-stays-open.test.ts —
// which proves the loop, not that the shell USES it. A helper proven by its
// own tests can still be unreachable from the path that matters, so this file
// renders the real App and watches `checkForUpdate` get called again after
// the interval, through the mounted shell.
//
// Partial mock of lib/updater (importOriginal): only `checkForUpdate` and
// `isSessionRunning` are replaced — the endpoint and the session probe, the two
// things a jsdom shell cannot have — so `startUpdateChecks`, `runUpdateCycle`
// and `shouldAutoInstall` are the production ones: the arms exercise the
// wiring, not a stand-in.
//
// The second describe is the shell-level truth table the pure-policy files
// cannot give: what the shell HANDS the loop. The customer's stored OFF and the
// running-session veto each stop an install through the mounted App, with the
// ON-and-idle install as the positive control that proves an offered update
// CAN be installed here (so the two vetoes are not passing on a dead path).
// And the per-version "Later": the same version re-offered stays hidden, a
// newer one surfaces — the positive control the first describe's vacuity arm
// (no banner at any tick) needs, since a shell whose banner never renders
// passes that arm identically.
//
// Mutation record, all in App.tsx:
//   • replacing the `startUpdateChecks(...)` effect body with a single
//     `void checkForUpdate()` (the old one-shot) reds the first arm; the loop
//     file stays green, which is exactly why this file exists.
//   • `autoUpdate: () => autoUpdateRef.current` → `() => true` reds the
//     stored-OFF arm (install called, no banner) while the loop and loader
//     files stay green.
//   • `sessionRunning: isSessionRunning` → `() => Promise.resolve(false)` reds
//     the running-session arm the same way.
//   • deleting `else if (u.version !== lastOfferedVersionRef.current)
//     setUpdateDismissed(false);` in onOffered reds the "Later" arm at the
//     newer-version step.
//   • dropping the third argument of `startStallWatch(...)` (the heartbeat
//     seam) reds the seam arm: the interval registers at 1000, not 60000.
//   • in main-thread-stall-detector.ts, `stallThresholdForHeartbeat(heartbeatMs)`
//     at the classifyStall call in startStallWatch → the bare
//     `STALL_THRESHOLD_MS` reds the seam arm's console.warn assertion: the
//     on-time 60 s tick is reported as "[stall] main thread blocked 0ms" and
//     recorded as an onStall flight record (measured 2026-09-12: 2,523 such
//     warnings per run of this file before the threshold moved with the seam).

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type * as Updater from '../../src/lib/updater';
import { SETTINGS_VERSION } from '../../src/lib/settings';
import {
  setStallHeartbeatForTests,
  STALL_HEARTBEAT_MS,
} from '../../src/lib/main-thread-stall-detector';

// Hoisted so the vi.mock factory below can reach them.
const checkForUpdate = vi.hoisted(() =>
  vi.fn<() => Promise<Updater.AvailableUpdate | null>>(() => Promise.resolve(null)),
);
const isSessionRunning = vi.hoisted(() =>
  vi.fn<() => Promise<boolean>>(() => Promise.resolve(false)),
);

vi.mock('../../src/lib/updater', async (importOriginal) => {
  const actual = await importOriginal<typeof Updater>();
  return { ...actual, checkForUpdate, isSessionRunning };
});

// The Tauri surface the App touches at boot, as the other App-shell suites mock it.
const invokeStore = new Map<string, string>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((cmd: string, args: { key: string; value?: string }): Promise<unknown> => {
    if (cmd === 'secret_load') return Promise.resolve(invokeStore.get(args.key) ?? null);
    if (cmd === 'secret_save') invokeStore.set(args.key, args.value ?? '');
    if (cmd === 'secret_delete') invokeStore.delete(args.key);
    return Promise.resolve(undefined);
  }),
}));
const tauriStore = new Map<string, unknown>();
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    get<T>(k: string): Promise<T | null> {
      return Promise.resolve((tauriStore.get(k) as T) ?? null);
    }
    set(k: string, v: unknown): Promise<void> {
      tauriStore.set(k, v);
      return Promise.resolve();
    }
    save(): Promise<void> {
      return Promise.resolve();
    }
  },
}));
vi.mock('@tauri-apps/plugin-deep-link', () => ({
  onOpenUrl: vi.fn(() => Promise.resolve(() => undefined)),
}));
vi.mock('@tauri-apps/plugin-shell', () => ({
  open: vi.fn(() => Promise.resolve()),
}));
vi.mock('@sentry/browser', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
  withScope: vi.fn(),
  Replay: class {},
  BrowserTracing: class {},
}));

const SIX_HOURS = 6 * 60 * 60 * 1000;

// The suite's own localStorage — jsdom's is not writable here (the onboarding
// suites install the same Map-backed shim). "Later" persists per version in it,
// so one arm's dismissal must not leak into the next.
const storedValues = new Map<string, string>();
const testStorage: Storage = {
  get length() {
    return storedValues.size;
  },
  clear() {
    storedValues.clear();
  },
  getItem(key) {
    return storedValues.get(key) ?? null;
  },
  key(index) {
    return [...storedValues.keys()][index] ?? null;
  },
  removeItem(key) {
    storedValues.delete(key);
  },
  setItem(key, value) {
    storedValues.set(key, value);
  },
};

beforeEach(() => {
  checkForUpdate.mockReset();
  checkForUpdate.mockImplementation(() => Promise.resolve(null));
  isSessionRunning.mockReset();
  isSessionRunning.mockImplementation(() => Promise.resolve(false));
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: testStorage });
  Object.defineProperty(window, 'localStorage', { configurable: true, value: testStorage });
  storedValues.clear();
  invokeStore.clear();
  tauriStore.clear();
  // Signed in, so the shell (not the wizard) renders — the update loop lives in Shell.
  tauriStore.set('driftstack', {
    baseUrl: 'https://api.example.test',
    telemetryOptIn: null,
  });
  invokeStore.set('api_key:api.example.test', 'ds_live_test_existing_key');
  window.fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({}), { status: 200 })));
  // Fake time is installed BEFORE render so the interval the shell registers
  // is a fake one; `shouldAdvanceTime` keeps waitFor's real polling alive.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // Every fake interval the mounted shell registers RUNS through an advance,
  // so an arm's real cost scales with fake hours. Measured 2026-09-12: one 6 h
  // advance executed 23,066 timer callbacks, 21,600 of them the 1 s main-thread
  // stall heartbeat. At 60 s through the detector's own seam the same advance
  // runs 1,826 (360 heartbeats; the 30 s flight-recorder census and the 30 s
  // connection probe 720 each, the 15 min proxy sweep 24, this loop's tick 1),
  // and the shell is still the real shell — the detector is started, not
  // stubbed. That is what retired the 30 s LONG_ADVANCE budget the ≥ 6 h arms
  // used to carry (alone: 1175 / 764 / 439 / 813 ms → 554 / 163 / 135 / 253 ms).
  // setup.ts does not know this seam, so this file restores it below.
  setStallHeartbeatForTests(60_000);
});

let setIntervalSpy: MockInstance<typeof window.setInterval> | undefined;

afterEach(() => {
  setIntervalSpy?.mockRestore();
  setIntervalSpy = undefined;
  setStallHeartbeatForTests(null);
});

describe('the App shell keeps checking for updates while it stays open (T-14)', () => {
  it('CRITICAL checkForUpdate runs on mount and AGAIN six hours later, through the mounted shell', async () => {
    const { App } = await import('../../src/App');
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByText('Welcome to Driftstack')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(checkForUpdate, 'the mount-time check is kept').toHaveBeenCalledTimes(1);
    });

    // A one-minute margin, not one millisecond: `shouldAdvanceTime` moves the
    // fake clock with real time, and the waitFor polls above already spent some
    // of the interval — the exact boundary is pinned in the loop's own file.
    await vi.advanceTimersByTimeAsync(SIX_HOURS - 60_000);
    expect(checkForUpdate, 'not before the interval').toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await waitFor(() => {
      expect(
        checkForUpdate,
        'the re-check the old mount-only effect never made',
      ).toHaveBeenCalledTimes(2);
    });
    await vi.advanceTimersByTimeAsync(SIX_HOURS);
    await waitFor(() => {
      expect(checkForUpdate).toHaveBeenCalledTimes(3);
    });
  });

  it('vacuity: with nothing to offer, no banner appears at any tick', async () => {
    // The control for the arm above: three checks that found nothing must
    // leave the shell exactly as it was — no Install button, no Later.
    const { App } = await import('../../src/App');
    render(<App />);
    await waitFor(() => {
      expect(checkForUpdate).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(SIX_HOURS * 2);
    await waitFor(() => {
      expect(checkForUpdate).toHaveBeenCalledTimes(3);
    });
    expect(screen.queryByTestId('update-install')).toBeNull();
    expect(screen.queryByTestId('update-download')).toBeNull();
  });

  it('CRITICAL the heartbeat seam is honoured THROUGH the mounted shell: at 60 s, advancing 30 s runs no heartbeat tick and 61 s runs one, and no 1 s interval is ever registered', async () => {
    // Observed at the registration, not by stubbing the detector: every
    // interval the shell registers is wrapped to count its ticks per delay, so
    // the heartbeat is the real one and the count is of it actually running.
    const ticksByDelay = new Map<number, number>();
    const registeredDelays: number[] = [];
    const fakeSetInterval = window.setInterval.bind(window);
    setIntervalSpy = vi.spyOn(window, 'setInterval').mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
    ): number => {
      const delay = timeout ?? 0;
      registeredDelays.push(delay);
      if (typeof handler !== 'function') return fakeSetInterval(handler, timeout);
      const tick = handler as () => void;
      return fakeSetInterval(() => {
        ticksByDelay.set(delay, (ticksByDelay.get(delay) ?? 0) + 1);
        tick();
      }, timeout);
    }) as typeof window.setInterval);

    // The detector's own effect: the shell's onStall is `console.warn(line,
    // census)` + a flight-store write. A slowed heartbeat whose on-time tick is
    // classified as a stall shows up here as "[stall] main thread blocked 0ms".
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stallWarnings = (): unknown[][] =>
      warn.mock.calls.filter(([first]) => typeof first === 'string' && first.startsWith('[stall]'));

    await renderShell();
    expect(registeredDelays, "the shell started the heartbeat at the seam's 60 s").toContain(
      60_000,
    );
    expect(registeredDelays, 'and never at the production 1 s').not.toContain(STALL_HEARTBEAT_MS);

    // 30 s, not 59: `shouldAdvanceTime` moves the fake clock with real time,
    // and under a full parallel suite this file ran ~8x slower than alone —
    // a 1 s margin is the load flake the first arm above guards against with
    // its own 60 s margin.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ticksByDelay.get(60_000) ?? 0, 'no heartbeat tick before 60 s').toBe(0);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(ticksByDelay.get(60_000), 'one tick once 61 s have passed').toBe(1);
    expect(ticksByDelay.get(STALL_HEARTBEAT_MS), 'nothing ran on a 1 s interval').toBeUndefined();
    expect(
      stallWarnings(),
      'the on-time tick at the slowed heartbeat is NOT a stall through the mounted shell',
    ).toEqual([]);
    warn.mockRestore();
  });
});

/** An offered, installable update with its install spy. */
function offered(version: string): {
  update: Updater.AvailableUpdate;
  install: ReturnType<typeof vi.fn>;
} {
  const install = vi.fn(() => Promise.resolve());
  return { install, update: { version, currentVersion: '0.1.15', notes: null, install } };
}

/** Render the signed-in shell and wait for its mount-time check. */
async function renderShell(): Promise<void> {
  const { App } = await import('../../src/App');
  render(<App />);
  await waitFor(() => {
    expect(screen.queryByText('Welcome to Driftstack')).not.toBeInTheDocument();
  });
  await waitFor(() => {
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
  });
}

/**
 * Let a decision pass that has already been observed at the endpoint finish:
 * `check → sessionRunning → install | onOffered` is one microtask chain, so a
 * small fake-time step drains it, and `act` flushes the render it caused. A
 * "no banner" assertion after this is about a pass that ran, not one still in
 * flight.
 */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(50);
  await act(async () => {});
}

describe("the shell hands the customer's preference and the session veto to the loop (T-14)", () => {
  it('CRITICAL an OFF the customer chose reaches the decision through the shell: the offered update is NOT installed, the banner is', async () => {
    // Under the layout marker, so the loader keeps the `false` as a choice —
    // the case the shell has to honour, and the one the loop file proves only
    // with a hand-wired `autoUpdate: () => false`.
    tauriStore.set('driftstack', {
      baseUrl: 'https://api.example.test',
      telemetryOptIn: null,
      autoUpdate: false,
      settingsVersion: SETTINGS_VERSION,
    });
    const { update, install } = offered('0.9.9');
    checkForUpdate.mockResolvedValue(update);
    await renderShell();
    await screen.findByTestId('update-install');
    expect(install, 'the stored OFF is the veto, read through the shell').not.toHaveBeenCalled();
  });

  it('CRITICAL a running session vetoes the unattended install through the shell — the banner, never a relaunch under a live session', async () => {
    // autoUpdate absent → ON by default, so only the session probe can stop it.
    isSessionRunning.mockResolvedValue(true);
    const { update, install } = offered('0.9.9');
    checkForUpdate.mockResolvedValue(update);
    await renderShell();
    await screen.findByTestId('update-install');
    expect(isSessionRunning, 'the shell asked the probe').toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it('control: ON and idle installs unattended through the shell — install called once, no banner, and the loop stops', async () => {
    const { update, install } = offered('0.9.9');
    checkForUpdate.mockResolvedValue(update);
    await renderShell();
    await waitFor(() => {
      expect(install).toHaveBeenCalledTimes(1);
    });
    await settle();
    expect(screen.queryByTestId('update-install'), 'installed, so nothing to offer').toBeNull();
    // After an install the app is on its way to a relaunch; a later tick would
    // offer the same version against the in-memory one. Through the shell.
    await vi.advanceTimersByTimeAsync(SIX_HOURS + 60_000);
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('"Later" hides the banner for THAT version: the same version re-offered stays hidden, a newer one surfaces again', async () => {
    tauriStore.set('driftstack', {
      baseUrl: 'https://api.example.test',
      telemetryOptIn: null,
      autoUpdate: false,
      settingsVersion: SETTINGS_VERSION,
    });
    checkForUpdate.mockResolvedValue(offered('0.9.9').update);
    await renderShell();
    await screen.findByTestId('update-install');
    fireEvent.click(screen.getByTestId('update-dismiss'));
    expect(screen.queryByTestId('update-install')).toBeNull();
    expect(localStorage.getItem('ds_update_dismissed')).toBe('0.9.9');

    // Re-check finds the SAME version: the dismissal holds (M16 — no re-nag).
    await vi.advanceTimersByTimeAsync(SIX_HOURS + 60_000);
    await waitFor(() => {
      expect(checkForUpdate).toHaveBeenCalledTimes(2);
    });
    await settle();
    expect(screen.queryByTestId('update-install'), 'the same version does not re-nag').toBeNull();

    // Re-check finds a NEWER version: it is not the one that was dismissed, so
    // it surfaces — the positive control for every "no banner" assertion in
    // this file, and the arm that pins the re-surface rule in onOffered.
    checkForUpdate.mockResolvedValue(offered('0.9.10').update);
    await vi.advanceTimersByTimeAsync(SIX_HOURS);
    await waitFor(() => {
      expect(checkForUpdate).toHaveBeenCalledTimes(3);
    });
    await screen.findByTestId('update-install');
    expect(screen.getByText('0.9.10')).toBeInTheDocument();
    // Still nothing installed: OFF stayed OFF across three passes.
    expect(screen.queryByTestId('update-download')).toBeNull();
  });
});
