// Owner's developer log, 2026-09-23:
//   [ERROR] [updater] install failed — stage=download attempt=1 0.1.68 → 0.1.70
//           platform=MacIntel retrying=no reason: Read-only file system (os error 30)
// twice, 18 s apart. The app was running from somewhere it cannot write — the
// mounted disk image, or the read-only copy macOS runs an app from when it is
// opened straight from Downloads. Every attempt downloaded the whole bundle,
// failed the same way, logged an ERROR, and the banner offered "Retry".
//
// Contract: the location is checked BEFORE anything is downloaded; the customer
// is told "Move Driftstack to your Applications folder, then open it again to
// update."; the log says so ONCE, as a WARN; nothing is reported as a failed
// install; and no Install/Retry is offered that cannot work.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { Update } from '@tauri-apps/plugin-updater';
import {
  checkForUpdateVerbose,
  installLocationProblem,
  MOVE_TO_APPLICATIONS_SENTENCE,
  resetInstallLocationLogForTests,
  runUpdateCycle,
  UpdateLocationError,
  type AvailableUpdate,
  type UpdaterDeps,
} from '../../src/lib/updater';
import { UpdateBanner } from '../../src/components/UpdateBanner';
import { clearLogEntries, getLogEntries } from '../../src/lib/log-buffer';

const TRANSLOCATED =
  '/private/var/folders/x1/abc/T/AppTranslocation/0F1E2D3C-AAAA-BBBB-CCCC-111122223333/d/Driftstack.app/Contents/Resources';
const DISK_IMAGE = '/Volumes/Driftstack 0.1.68/Driftstack.app/Contents/Resources';
const INSTALLED = '/Applications/Driftstack.app/Contents/Resources';

function fakeUpdate(downloadAndInstall: Update['downloadAndInstall']): Update {
  return {
    version: '0.1.70',
    currentVersion: '0.1.68',
    body: null,
    downloadAndInstall,
  } as unknown as Update;
}

function deps(
  bundlePath: string | null,
  downloadAndInstall: Update['downloadAndInstall'],
  onInstallFailure = vi.fn(),
): UpdaterDeps {
  return {
    check: () => Promise.resolve(fakeUpdate(downloadAndInstall)),
    relaunch: () => Promise.resolve(),
    currentVersion: () => Promise.resolve('0.1.68'),
    canSelfInstall: () => true,
    needsManualRelaunch: () => false,
    onInstallFailure,
    bundlePath: () => Promise.resolve(bundlePath),
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

function updaterLines(): Array<{ level: string; text: string }> {
  return getLogEntries()
    .filter((e) => e.text.startsWith('[updater]'))
    .map((e) => ({ level: e.level, text: e.text }));
}

beforeEach(() => {
  resetInstallLocationLogForTests();
  clearLogEntries();
});

afterEach(() => {
  cleanup();
});

describe('where the app runs from', () => {
  it('recognises the translocated copy and a disk image, and nothing else', () => {
    expect(installLocationProblem(TRANSLOCATED)).toBe('translocated');
    expect(installLocationProblem(DISK_IMAGE)).toBe('disk-image');
    expect(installLocationProblem(INSTALLED)).toBeNull();
    // An app installed in a folder on an external drive is not a disk image.
    expect(
      installLocationProblem('/Volumes/External/Applications/Driftstack.app/Contents/Resources'),
    ).toBeNull();
    expect(installLocationProblem(null)).toBeNull();
  });
});

describe('an update is not attempted from a disk image or a translocated copy', () => {
  it('CRITICAL from the translocated copy: nothing is downloaded, the customer is told what to do, one WARN, no failure report', async () => {
    const download = vi.fn(() => Promise.resolve());
    const onInstallFailure = vi.fn();
    const result = await checkForUpdateVerbose(deps(TRANSLOCATED, download, onInstallFailure));
    expect(result.status).toBe('found');
    expect(result.update?.installBlocked).toBe('translocated');

    await expect(result.update?.install()).rejects.toBeInstanceOf(UpdateLocationError);
    // A second check (the 6-hourly re-check) logs nothing more.
    await checkForUpdateVerbose(deps(TRANSLOCATED, download, onInstallFailure));
    await settle();

    expect(download).not.toHaveBeenCalled();
    expect(onInstallFailure).not.toHaveBeenCalled();
    const lines = updaterLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe('warn');
    expect(lines[0]?.text).toMatch(/0\.1\.70 can't be installed: Driftstack is running from/);
  });

  it('CRITICAL the unattended cycle does not try, and hands the banner the update instead', async () => {
    const download = vi.fn(() => Promise.resolve());
    const result = await checkForUpdateVerbose(deps(DISK_IMAGE, download));
    const onOffered = vi.fn();
    const outcome = await runUpdateCycle({
      check: () => Promise.resolve(result.update ?? null),
      autoUpdate: () => true,
      sessionRunning: () => Promise.resolve(false),
      onOffered,
    });
    expect(outcome).toBe('banner');
    expect(download).not.toHaveBeenCalled();
    expect(onOffered).toHaveBeenCalledTimes(1);
  });

  it('CRITICAL a read-only failure the path check could not see ends the same way: one WARN, no ERROR, no retry, and the next check does not download again', async () => {
    const download = vi.fn(() => Promise.reject(new Error('Read-only file system (os error 30)')));
    const onInstallFailure = vi.fn();
    const first = await checkForUpdateVerbose(deps(null, download, onInstallFailure));
    expect(first.update?.installBlocked).toBeUndefined();

    await expect(first.update?.install()).rejects.toBeInstanceOf(UpdateLocationError);
    expect(download).toHaveBeenCalledTimes(1);
    expect(onInstallFailure).not.toHaveBeenCalled();

    const again = await checkForUpdateVerbose(deps(null, download, onInstallFailure));
    expect(again.update?.installBlocked).toBe('read-only');
    await expect(again.update?.install()).rejects.toBeInstanceOf(UpdateLocationError);
    expect(download).toHaveBeenCalledTimes(1);

    await settle();
    const lines = updaterLines();
    expect(lines.map((l) => l.level)).toEqual(['warn']);
    expect(lines.some((l) => l.text.includes('install failed'))).toBe(false);
  });

  it('CONTROL from Applications the install runs as before', async () => {
    const download = vi.fn(() => Promise.resolve());
    const result = await checkForUpdateVerbose(deps(INSTALLED, download));
    expect(result.update?.installBlocked).toBeUndefined();
    await result.update?.install();
    expect(download).toHaveBeenCalledTimes(1);
  });
});

describe('the banner says what to do, and offers nothing that cannot work', () => {
  function blocked(over: Partial<AvailableUpdate> = {}): AvailableUpdate {
    return {
      version: '0.1.70',
      currentVersion: '0.1.68',
      notes: null,
      installBlocked: 'disk-image',
      install: () => Promise.reject(new UpdateLocationError('disk-image')),
      ...over,
    };
  }

  it('CRITICAL a blocked update shows the move sentence and no Install, Retry or failure', () => {
    render(<UpdateBanner update={blocked()} onDismiss={() => undefined} />);
    expect(screen.getByTestId('update-location-blocked')).toHaveTextContent(
      MOVE_TO_APPLICATIONS_SENTENCE,
    );
    expect(screen.queryByTestId('update-install')).toBeNull();
    expect(screen.queryByTestId('update-error-headline')).toBeNull();
    expect(screen.getByTestId('update-dismiss')).toBeInTheDocument();
  });

  it('an Install that meets a read-only folder turns into the same sentence, not "Update failed"', async () => {
    const update = blocked({
      installBlocked: undefined,
      install: () => Promise.reject(new UpdateLocationError('read-only')),
    });
    render(<UpdateBanner update={update} onDismiss={() => undefined} />);
    fireEvent.click(screen.getByTestId('update-install'));
    expect(await screen.findByTestId('update-location-blocked')).toHaveTextContent(
      MOVE_TO_APPLICATIONS_SENTENCE,
    );
    expect(screen.queryByTestId('update-error-headline')).toBeNull();
    expect(screen.queryByTestId('update-install')).toBeNull();
  });
});
