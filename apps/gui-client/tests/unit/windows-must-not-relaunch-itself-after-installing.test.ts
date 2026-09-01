import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkForUpdate } from '../../src/lib/updater';

/**
 * Owner, 2026-09-01, on 0.1.8: "I just tried updating from a windows and it
 * installs, and then the program just shutdowns, no new update installed."
 *
 * ⛔ Windows owns its own restart. `downloadAndInstall()` launches the NSIS
 * installer and the app must EXIT so the installer can overwrite the running
 * .exe. Calling `relaunch()` instead spawns a fresh copy of the OLD binary and
 * exits the current one — so a process is still holding the file the installer
 * is trying to replace. The install fails, the app disappears, and the customer
 * is left on the old version with no error. Exactly the reported symptom.
 *
 * macOS and Linux are the opposite: the bundle is swapped in place while the app
 * runs, and nothing restarts it unless we do — so dropping relaunch everywhere
 * would trade this bug for "the customer sits on the old version until they
 * happen to quit", which is quieter and therefore worse.
 *
 * ⚠️ Reasoned from Tauri v2's documented platform split plus the symptom, and
 * NOT verified on real Windows from this machine. Both branches are pinned so
 * whichever way a real test lands, the change is deliberate.
 */

function deps(over: Record<string, unknown> = {}): Record<string, unknown> {
  const update = {
    version: '0.2.0',
    currentVersion: '0.1.8',
    body: null,
    downloadAndInstall: vi.fn((cb: (e: { event: string; data?: unknown }) => void) => {
      cb({ event: 'Started', data: { contentLength: 10 } });
      cb({ event: 'Finished' });
      return Promise.resolve();
    }),
  };
  return {
    canSelfInstall: () => true,
    needsManualRelaunch: () => true,
    currentVersion: () => Promise.resolve('0.1.8'),
    check: () => Promise.resolve(update),
    relaunch: vi.fn(() => Promise.resolve(undefined)),
    __update: update,
    ...over,
  };
}

describe('Windows must not relaunch itself after installing', () => {
  it('⛔ does NOT call relaunch on Windows — the installer owns the restart', async () => {
    const d = deps({ needsManualRelaunch: () => false });
    const offered = await checkForUpdate(d as never);
    expect(offered).not.toBeNull();
    await offered?.install?.();
    expect(
      d.relaunch,
      'relaunching on Windows respawns the old binary onto the file NSIS is replacing',
    ).not.toHaveBeenCalled();
    // The install itself must still have run.
    expect((d.__update as { downloadAndInstall: unknown }).downloadAndInstall).toHaveBeenCalled();
  });

  it('DOES relaunch where the bundle is swapped in place (macOS/Linux)', async () => {
    // Dropping relaunch everywhere would leave these customers on the old
    // version until they quit — quieter than the Windows bug, and worse for it.
    const d = deps({ needsManualRelaunch: () => true });
    const offered = await checkForUpdate(d as never);
    await offered?.install?.();
    expect(d.relaunch).toHaveBeenCalledTimes(1);
  });

  it('the platform predicate is injected, so both branches stay reachable', () => {
    const src = readFileSync(new URL('../../src/lib/updater.ts', import.meta.url).pathname, 'utf8');
    // A hard-coded `true` would make the Windows branch untestable and the bug
    // un-catchable — the same shape as the mac sniff this file replaced.
    expect(src).toContain('needsManualRelaunch');
    expect(src).toMatch(/deps\.needsManualRelaunch\?\.\(\) \?\? true/);
  });
});
