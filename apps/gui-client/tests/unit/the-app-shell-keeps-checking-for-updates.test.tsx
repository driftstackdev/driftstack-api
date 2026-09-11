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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type * as Updater from '../../src/lib/updater';
import { SETTINGS_VERSION } from '../../src/lib/settings';

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

// Polish — measured 2026-09-11, this file alone on an idle Mac: every fake
// interval the mounted shell registers RUNS through an advance, so an arm's
// real cost scales with fake hours. One 6 h advance executes 23,066 timer
// callbacks — the 1 s main-thread stall heartbeat 21,600 of them, the 30 s
// flight-recorder census and the 30 s connection probe 720 each, the 15 min
// proxy sweep 24, this loop's own tick 1 (12 h: 46,131). Alone that is
// ~1.2 s for a 12 h arm and ~0.4 s for a 6 h one; under the full parallel
// suite on a loaded machine the same arms crossed the project's 10 s
// testTimeout. Fake timers cannot advance past one interval without executing
// the others, and stubbing the stall detector would make "through the mounted
// shell" a smaller shell — so every arm that advances ≥ 6 h carries this
// budget instead. The assertions are untouched.
const LONG_ADVANCE = { timeout: 30_000 };

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
});

describe('the App shell keeps checking for updates while it stays open (T-14)', () => {
  it(
    'CRITICAL checkForUpdate runs on mount and AGAIN six hours later, through the mounted shell',
    LONG_ADVANCE,
    async () => {
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
    },
  );

  it('vacuity: with nothing to offer, no banner appears at any tick', LONG_ADVANCE, async () => {
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

  it(
    'control: ON and idle installs unattended through the shell — install called once, no banner, and the loop stops',
    LONG_ADVANCE,
    async () => {
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
    },
  );

  it(
    '"Later" hides the banner for THAT version: the same version re-offered stays hidden, a newer one surfaces again',
    LONG_ADVANCE,
    async () => {
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
    },
  );
});
