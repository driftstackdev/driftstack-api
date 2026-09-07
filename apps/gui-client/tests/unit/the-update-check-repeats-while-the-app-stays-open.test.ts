// T-14 — the update check ran ONCE, on mount, and the owner's app process had
// been running continuously since 2026-09-05 (measured with ps). Every release
// since was cut while the app was already open, so no check ever saw 0.1.16
// through 0.1.19: the installed app sat on 0.1.15 while the endpoint served
// 0.1.19 for its platform and key.
//
// `startUpdateChecks` runs the decision once now and again every
// UPDATE_RECHECK_INTERVAL_MS, and mount and re-check share ONE decision path —
// `runUpdateCycle`: check → shouldAutoInstall (vetoed while a session runs) →
// install, else banner. The arms below drive that loop with fake time.
//
// Mutation record: deleting `handle = timers.setInterval(tick, intervalMs)` in
// startUpdateChecks reds the first arm (check stays at one call after 6h) and
// the two arms after it that depend on a second tick; the vacuity arm stays
// green, as it should — it asserts nothing happens when nothing is found.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runUpdateCycle,
  startUpdateChecks,
  UPDATE_RECHECK_INTERVAL_MS,
  type AvailableUpdate,
  type UpdateCycleDeps,
} from '../../src/lib/updater';

function update(version: string, install = vi.fn(() => Promise.resolve())): AvailableUpdate {
  return { version, currentVersion: '0.1.15', notes: null, install };
}

function deps(over: Partial<UpdateCycleDeps> = {}): UpdateCycleDeps {
  return {
    check: vi.fn(() => Promise.resolve<AvailableUpdate | null>(null)),
    autoUpdate: vi.fn(() => true),
    sessionRunning: vi.fn(() => Promise.resolve(false)),
    onOffered: vi.fn(),
    ...over,
  };
}

const SIX_HOURS = 6 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the update check repeats while the app stays open (T-14)', () => {
  it('CRITICAL the interval fires and re-checks: once on start, again every six hours, and never again after stop', async () => {
    const d = deps();
    const stop = startUpdateChecks(d);
    await vi.advanceTimersByTimeAsync(0);
    expect(d.check, 'the mount-time check is kept').toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_INTERVAL_MS - 1);
    expect(d.check, 'not before the interval has elapsed').toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(
      d.check,
      'the re-check — the call the old mount-only effect never made',
    ).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_INTERVAL_MS);
    expect(d.check).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_INTERVAL_MS * 3);
    expect(d.check, 'the effect cleanup clears the interval').toHaveBeenCalledTimes(3);
  });

  it('the interval is six hours, and the loop uses it by default', () => {
    // The number is the policy: short enough that a release lands the same
    // working day, long enough that an offline laptop is not polling.
    expect(UPDATE_RECHECK_INTERVAL_MS).toBe(SIX_HOURS);
  });

  it('CRITICAL a running session defers the install and shows the banner — on a re-check exactly as on mount', async () => {
    const install = vi.fn(() => Promise.resolve());
    const offered = update('0.1.19', install);
    const d = deps({
      check: vi.fn(() => Promise.resolve<AvailableUpdate | null>(offered)),
      sessionRunning: vi.fn(() => Promise.resolve(true)),
    });
    const stop = startUpdateChecks(d);
    await vi.advanceTimersByTimeAsync(0);
    expect(install, 'no relaunch under a live session').not.toHaveBeenCalled();
    expect(d.onOffered, 'the banner is what happens instead').toHaveBeenCalledWith(offered);

    await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_INTERVAL_MS);
    expect(d.check).toHaveBeenCalledTimes(2);
    expect(install, 'the re-check goes through the same veto').not.toHaveBeenCalled();
    expect(d.onOffered).toHaveBeenCalledTimes(2);
    stop();
  });

  it('CRITICAL with no session running and auto-update on, a re-check installs unattended and the loop then stops', async () => {
    // The control for the arm above: the veto is what deferred the install,
    // not the loop being unable to install at all.
    const install = vi.fn(() => Promise.resolve());
    const offered = update('0.1.19', install);
    let found: AvailableUpdate | null = null;
    const d = deps({ check: vi.fn(() => Promise.resolve(found)) });
    const stop = startUpdateChecks(d);
    await vi.advanceTimersByTimeAsync(0);
    expect(install).not.toHaveBeenCalled();

    // The release is cut while the app is open — the owner's exact situation.
    found = offered;
    await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_INTERVAL_MS);
    expect(d.check).toHaveBeenCalledTimes(2);
    expect(install, 'installed without asking').toHaveBeenCalledTimes(1);
    expect(d.onOffered, 'no banner for an update that is being installed').not.toHaveBeenCalled();

    // The app is on its way to a relaunch; a later tick would compare the
    // endpoint against the version still in memory and offer it again.
    await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_INTERVAL_MS * 2);
    expect(d.check, 'no further checks after an install').toHaveBeenCalledTimes(2);
    expect(install).toHaveBeenCalledTimes(1);
    stop();
  });

  it('CRITICAL an interval tick while a check is in flight is a no-op — single-flight, so two downloads cannot stack', async () => {
    let settle: (u: AvailableUpdate | null) => void = () => undefined;
    const d = deps({
      check: vi.fn(
        () =>
          new Promise<AvailableUpdate | null>((resolve) => {
            settle = resolve;
          }),
      ),
    });
    const stop = startUpdateChecks(d);
    await vi.advanceTimersByTimeAsync(0);
    expect(d.check).toHaveBeenCalledTimes(1);

    // Two intervals elapse with the first check still unresolved (a slow
    // endpoint, or an install download that takes longer than the interval).
    await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_INTERVAL_MS * 2);
    expect(d.check, 'the ticks arrived, and were dropped').toHaveBeenCalledTimes(1);

    // Once it settles, the next tick runs again — the gate is in-flight, not latched.
    settle(null);
    await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_INTERVAL_MS);
    expect(d.check).toHaveBeenCalledTimes(2);
    stop();
  });

  it('vacuity: no update → nothing happens — no banner, no install, the preference and the session are not even consulted', async () => {
    const d = deps();
    const stop = startUpdateChecks(d);
    await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_INTERVAL_MS * 4);
    expect(d.check).toHaveBeenCalledTimes(5);
    expect(d.onOffered).not.toHaveBeenCalled();
    expect(d.autoUpdate).not.toHaveBeenCalled();
    expect(d.sessionRunning).not.toHaveBeenCalled();
    stop();
  });

  it('the preference is read at decision time, so a switch flipped while the app is open decides the next re-check', async () => {
    // The old effect closed over the mount-time value. A customer who turns
    // auto-update on after launch would have waited for a relaunch to be
    // heard; one who turns it OFF would have been installed against.
    const install = vi.fn(() => Promise.resolve());
    const offered = update('0.1.19', install);
    let preference = false;
    const d = deps({
      check: vi.fn(() => Promise.resolve<AvailableUpdate | null>(offered)),
      autoUpdate: () => preference,
    });
    const stop = startUpdateChecks(d);
    await vi.advanceTimersByTimeAsync(0);
    expect(install).not.toHaveBeenCalled();
    expect(d.onOffered).toHaveBeenCalledTimes(1);

    preference = true;
    await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_INTERVAL_MS);
    expect(install).toHaveBeenCalledTimes(1);
    stop();
  });

  it('a failed unattended install degrades into the banner rather than into a dead end', async () => {
    const offered = update(
      '0.1.19',
      vi.fn(() => Promise.reject(new Error('signature mismatch'))),
    );
    const d = deps({ check: () => Promise.resolve(offered) });
    expect(await runUpdateCycle(d)).toBe('banner');
    expect(d.onOffered).toHaveBeenCalledWith(offered);
  });

  it('the three outcomes of one pass, named, so the loop and its callers agree on what happened', async () => {
    expect(await runUpdateCycle(deps())).toBe('none');
    const install = vi.fn(() => Promise.resolve());
    expect(
      await runUpdateCycle(deps({ check: () => Promise.resolve(update('0.1.19', install)) })),
    ).toBe('installed');
    expect(install).toHaveBeenCalledTimes(1);
    expect(
      await runUpdateCycle(
        deps({
          check: () => Promise.resolve(update('0.1.19')),
          autoUpdate: () => false,
        }),
      ),
    ).toBe('banner');
  });

  it('a check that throws anyway does not kill the loop — the next tick still runs', async () => {
    // checkForUpdate never throws by contract; this pins that the loop does
    // not depend on that contract, because an update check must never be able
    // to break the app it is checking.
    let calls = 0;
    const d = deps({
      check: vi.fn(() => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(null);
      }),
    });
    const stop = startUpdateChecks(d);
    await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_INTERVAL_MS);
    expect(d.check).toHaveBeenCalledTimes(2);
    stop();
  });
});
