// V-243 — unit tests for the in-app Tauri-updater flow. Deps are
// injected (fake check/relaunch + a fake Update whose downloadAndInstall
// drives the progress event sequence), so this runs in plain node with
// no Tauri runtime. The fakes return Promises explicitly (rather than
// `async () =>` with no await) to satisfy @typescript-eslint/require-await.

import { describe, expect, it, vi } from 'vitest';
import type { Update } from '@tauri-apps/plugin-updater';
import { checkForUpdate, type UpdaterDeps } from '../../src/lib/updater';

function fakeUpdate(over: Partial<Record<string, unknown>> = {}): Update {
  return {
    version: '0.1.0',
    currentVersion: '0.0.1',
    body: 'Release notes here',
    downloadAndInstall: (onEvent?: (e: unknown) => void): Promise<void> => {
      onEvent?.({ event: 'Started', data: { contentLength: 100 } });
      onEvent?.({ event: 'Progress', data: { chunkLength: 40 } });
      onEvent?.({ event: 'Progress', data: { chunkLength: 60 } });
      onEvent?.({ event: 'Finished' });
      return Promise.resolve();
    },
    ...over,
  } as unknown as Update;
}

const noopRelaunch = (): Promise<void> => Promise.resolve();

describe('V-243 checkForUpdate', () => {
  it('returns null when up-to-date (check resolves null)', async () => {
    const deps: UpdaterDeps = { check: () => Promise.resolve(null), relaunch: vi.fn(noopRelaunch) };
    expect(await checkForUpdate(deps)).toBeNull();
  });

  it('NEVER throws — a check failure (offline / no endpoint / not a Tauri context) resolves to null', async () => {
    const deps: UpdaterDeps = {
      check: () => Promise.reject(new Error('not allowed on the configured platform / offline')),
      relaunch: vi.fn(noopRelaunch),
    };
    await expect(checkForUpdate(deps)).resolves.toBeNull();
  });

  it('surfaces the offered version + current version + notes when an update is available', async () => {
    const deps: UpdaterDeps = {
      check: () => Promise.resolve(fakeUpdate()),
      relaunch: vi.fn(noopRelaunch),
    };
    const upd = await checkForUpdate(deps);
    expect(upd).not.toBeNull();
    expect(upd!.version).toBe('0.1.0');
    expect(upd!.currentVersion).toBe('0.0.1');
    expect(upd!.notes).toBe('Release notes here');
  });

  it('notes is null when the manifest omits a body', async () => {
    const deps: UpdaterDeps = {
      check: () => Promise.resolve(fakeUpdate({ body: undefined })),
      relaunch: vi.fn(noopRelaunch),
    };
    const upd = await checkForUpdate(deps);
    expect(upd!.notes).toBeNull();
  });

  it('install() reports byte progress (ending at 1) then relaunches into the new version', async () => {
    const relaunch = vi.fn(noopRelaunch);
    const deps: UpdaterDeps = { check: () => Promise.resolve(fakeUpdate()), relaunch };
    const upd = await checkForUpdate(deps);
    const fractions: number[] = [];
    await upd!.install((f) => fractions.push(f));
    // Started(len=100) → Progress(40)=0.4 → Progress(60)=1.0 → Finished→1
    expect(fractions[0]).toBeCloseTo(0.4);
    expect(fractions[fractions.length - 1]).toBe(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it('install() that fails to download/verify rejects and does NOT relaunch (running app untouched)', async () => {
    const relaunch = vi.fn(noopRelaunch);
    const deps: UpdaterDeps = {
      check: () =>
        Promise.resolve(
          fakeUpdate({
            downloadAndInstall: (): Promise<void> =>
              Promise.reject(new Error('signature verification failed')),
          }),
        ),
      relaunch,
    };
    const upd = await checkForUpdate(deps);
    await expect(upd!.install()).rejects.toThrow(/signature/);
    expect(relaunch).not.toHaveBeenCalled();
  });
});
