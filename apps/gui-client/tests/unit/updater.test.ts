// V-243 — unit tests for the in-app Tauri-updater flow. Deps are
// injected (fake check/relaunch + a fake Update whose downloadAndInstall
// drives the progress event sequence), so this runs in plain node with
// no Tauri runtime. The fakes return Promises explicitly (rather than
// `async () =>` with no await) to satisfy @typescript-eslint/require-await.

import { describe, expect, it, vi } from 'vitest';
import type { Update } from '@tauri-apps/plugin-updater';
import { checkForUpdate, isNewerVersion, type UpdaterDeps } from '../../src/lib/updater';

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
/**
 * The installed version these fixtures report.
 *
 * ⛔ Added because every `UpdaterDeps` here omitted `currentVersion`, and one
 * test was passing for the wrong reason because of it. `checkForUpdate` reaches
 * `checkManifestOnly` ONLY when `deps.check()` throws, and that function opens
 * with `await deps.currentVersion()` inside a `try` whose `catch` returns null.
 * So in the "NEVER throws — a check failure resolves to null" case, the absent
 * field threw a TypeError, the catch swallowed it, and the assertion passed —
 * ⛔ proving the FIXTURE was malformed rather than that a check failure resolves
 * to null. The test's stated subject went unverified.
 *
 * The other seven omissions are type-only: their `check` resolves, so that path
 * is never taken.
 */
const currentVersion = (): Promise<string> => Promise.resolve('0.0.1');

/**
 * These fixtures exercise the INSTALL path, so they stand for a platform that
 * may replace its own bundle (Windows/Linux). The macOS half — check permitted,
 * install denied — is covered in
 * `macos-is-told-about-updates-it-cannot-install.test.tsx`.
 *
 * ⛔ Required rather than optional on purpose. The sibling comment above records
 * an arm that passed for the wrong reason because `currentVersion` was absent
 * and the resulting TypeError was swallowed by the same catch. Making this
 * field mandatory means the compiler names every fixture that has to decide,
 * instead of a default silently deciding for them.
 */
const canSelfInstall = (): boolean => true;

describe('V-243 checkForUpdate', () => {
  it('returns null when up-to-date (check resolves null)', async () => {
    const deps: UpdaterDeps = {
      check: () => Promise.resolve(null),
      currentVersion,
      canSelfInstall,
      relaunch: vi.fn(noopRelaunch),
    };
    expect(await checkForUpdate(deps)).toBeNull();
  });

  it('NEVER throws — a check failure falls back to the manifest, and resolves to null only when THAT is unreachable too', async () => {
    const deps: UpdaterDeps = {
      check: () => Promise.reject(new Error('not allowed on the configured platform / offline')),
      currentVersion,
      canSelfInstall,
      relaunch: vi.fn(noopRelaunch),
    };
    // ⛔ STUBBED, and the reason is the finding. A rejected `check()` falls
    // through to `checkManifestOnly`, which does a REAL
    // `fetch(https://github.com/.../latest.json)`. With the fixture missing
    // `currentVersion` that fetch was never reached — the absent field threw
    // first and the catch swallowed it — so this file has been a unit test with
    // a live network dependency, hidden behind a type error. Supplying the
    // field made it reach GitHub and return the actual published 0.1.3.
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response('not found', { status: 404 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      // ⚠️ The old title claimed a check failure "resolves to null". It does not
      // in general: the fallback exists so "the customer at least learns a new
      // version exists". What the function actually guarantees is that it NEVER
      // THROWS — null here is the manifest being unreachable too, which is the
      // case this arm now genuinely covers.
      await expect(checkForUpdate(deps)).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns null when the manifest lists the SAME version as installed (botched/rolled-back release)', async () => {
    const deps: UpdaterDeps = {
      check: () => Promise.resolve(fakeUpdate({ version: '0.1.0', currentVersion: '0.1.0' })),
      currentVersion,
      canSelfInstall,
      relaunch: vi.fn(noopRelaunch),
    };
    expect(await checkForUpdate(deps)).toBeNull();
  });

  it('returns null when the manifest lists an OLDER version than installed', async () => {
    const deps: UpdaterDeps = {
      check: () => Promise.resolve(fakeUpdate({ version: '0.0.9', currentVersion: '0.1.0' })),
      currentVersion,
      canSelfInstall,
      relaunch: vi.fn(noopRelaunch),
    };
    expect(await checkForUpdate(deps)).toBeNull();
  });

  it('surfaces the offered version + current version + notes when an update is available', async () => {
    const deps: UpdaterDeps = {
      check: () => Promise.resolve(fakeUpdate()),
      currentVersion,
      canSelfInstall,
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
      currentVersion,
      canSelfInstall,
      relaunch: vi.fn(noopRelaunch),
    };
    const upd = await checkForUpdate(deps);
    expect(upd!.notes).toBeNull();
  });

  it('install() reports byte progress (ending at 1) then relaunches into the new version', async () => {
    const relaunch = vi.fn(noopRelaunch);
    const deps: UpdaterDeps = {
      check: () => Promise.resolve(fakeUpdate()),
      currentVersion,
      canSelfInstall,
      relaunch,
    };
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
      currentVersion,
      canSelfInstall,
      relaunch,
    };
    const upd = await checkForUpdate(deps);
    await expect(upd!.install()).rejects.toThrow(/signature/);
    expect(relaunch).not.toHaveBeenCalled();
  });
});

describe('isNewerVersion', () => {
  it('true only for a strictly newer semver', () => {
    expect(isNewerVersion('0.1.0', '0.0.1')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('0.0.2', '0.0.1')).toBe(true);
  });
  it('false for equal or older', () => {
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.0.1', '0.1.0')).toBe(false);
    expect(isNewerVersion('1.2.3', '1.2.4')).toBe(false);
  });
  it('tolerates a leading v and pre-release/build suffixes (compares the numeric core)', () => {
    expect(isNewerVersion('v0.2.0', '0.1.0')).toBe(true);
    expect(isNewerVersion('0.2.0-beta.1', '0.1.0')).toBe(true);
    expect(isNewerVersion('0.1.0-rc.2', '0.1.0')).toBe(false); // same core → not newer
  });
  it('false (never offer) on unparseable input', () => {
    expect(isNewerVersion('not-a-version', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.1.0', 'garbage')).toBe(false);
  });
});
