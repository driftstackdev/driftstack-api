// macOS was never told an update existed.
//
// The updater capability is granted to Windows and Linux only, deliberately —
// a minisign-only artifact must not be able to replace the bundle and change
// its code requirement. But `checkForUpdate` wrapped the plugin call in
// `catch { return null }`, so on macOS the unpermitted call threw, was
// swallowed, and the customer saw nothing. Not "you must update manually" —
// nothing. Silence is the worst of the three available outcomes.
//
// The fallback reads the same `latest.json` the plugin would. Reading a JSON
// file needs no updater capability, so it works where `check()` does not, and
// it CANNOT install anything, which is the property that makes it safe to run
// on the platform that excluded the installer on purpose.
//
// ⛔⛔ 2026-08-27 — THAT FALLBACK NEVER WORKED IN THE REAL APP, and this file
// could not have caught it. "Reading a JSON file needs no updater capability" is
// true about CAPABILITIES and insufficient about CORS. `MANIFEST_URL` 302s twice
// and lands on `release-assets.githubusercontent.com`, which sends NO
// `Access-Control-Allow-Origin` on any hop (measured). A webview `fetch` is
// cross-origin, so WebKit rejected the response before the app could read it,
// `checkManifestOnly`'s catch returned null, and the macOS customer was told
// nothing — the exact silence this file was written to end. The arms below stub
// `fetch`, and a stub has no origin, so no test in this shape can observe it.
//
// ⭐ THE FIX: macOS now holds `updater:allow-check` (capability
// `updater-check-macos`). That check runs in RUST, so CORS does not apply and the
// signature is verified. Download and install remain denied, so the security
// property is unchanged. The manifest fallback is kept for the genuinely offline
// case — it is now the second line, not the only one.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Update } from '@tauri-apps/plugin-updater';
import { render, screen } from '@testing-library/react';
import { checkForUpdate, RELEASES_URL, type UpdaterDeps } from '../../src/lib/updater';
import { UpdateBanner } from '../../src/components/UpdateBanner';

const MANIFEST = { version: '0.2.0', notes: 'newer' };

function deps(over: Partial<UpdaterDeps> = {}): UpdaterDeps {
  return {
    // The macOS reality: the plugin is not permitted, so this throws.
    check: () => Promise.reject(new Error('updater.check not allowed')),
    relaunch: () => Promise.resolve(),
    currentVersion: () => Promise.resolve('0.1.3'),
    // macOS holds `updater:allow-check` and nothing else.
    canSelfInstall: () => false,
    ...over,
  };
}

function mockFetch(body: unknown, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response)),
  );
}

// stubGlobal('fetch') is process-wide. Left in place it leaks into every
// sibling suite sharing this worker, which is a defect I would then be tempted
// to log as someone else's flake.
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('macOS is told about updates it cannot install', () => {
  it('CRITICAL a newer version is surfaced even though the plugin check threw — the case that used to be silent', async () => {
    mockFetch(MANIFEST);
    const u = await checkForUpdate(deps());
    expect(u).not.toBeNull();
    expect(u?.version).toBe('0.2.0');
    expect(u?.downloadOnly).toBe(true);
    expect(u?.downloadUrl).toBe(RELEASES_URL);
  });

  it('CRITICAL check() now SUCCEEDS on macOS (allow-check) and is still offered as download-only', async () => {
    // The real macOS path after the capability fix: the Rust-side check resolves,
    // so `checkManifestOnly` is never reached and CORS never enters the picture.
    const offered = {
      version: '0.2.0',
      currentVersion: '0.1.3',
      body: 'newer',
      downloadAndInstall: () => Promise.reject(new Error('must never be called on macOS')),
    } as unknown as Update;
    const u = await checkForUpdate(
      deps({ check: () => Promise.resolve(offered), canSelfInstall: () => false }),
    );
    expect(u).not.toBeNull();
    expect(u?.version).toBe('0.2.0');
    // ⛔ The whole point: a permitted CHECK must not become an offered INSTALL.
    // The capability denies download/install, so an Install button could only fail.
    expect(u?.downloadOnly).toBe(true);
    expect(u?.downloadUrl).toBe(RELEASES_URL);
    await expect(u?.install()).rejects.toThrow(/installs updates manually/);
  });

  it('a platform that CAN self-install still gets a real install closure', async () => {
    // The control. Without it, `downloadOnly: true` everywhere would pass the arm
    // above while silently removing self-update from Windows and Linux.
    const installed = vi.fn(() => Promise.resolve());
    const offered = {
      version: '0.2.0',
      currentVersion: '0.1.3',
      body: null,
      downloadAndInstall: installed,
    } as unknown as Update;
    const u = await checkForUpdate(
      deps({ check: () => Promise.resolve(offered), canSelfInstall: () => true }),
    );
    expect(u?.downloadOnly).toBeUndefined();
    await u?.install();
    expect(installed).toHaveBeenCalledTimes(1);
  });

  it('offers Download, not a button that cannot do what it says', async () => {
    mockFetch(MANIFEST);
    const u = await checkForUpdate(deps());
    render(<UpdateBanner update={u!} onDismiss={() => undefined} />);
    const link = screen.getByTestId('update-download');
    expect(link).toHaveAttribute('href', RELEASES_URL);
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    // The install button must be ABSENT, not merely disabled.
    expect(screen.queryByTestId('update-install')).toBeNull();
  });

  it('install() rejects rather than silently doing nothing, if a caller ignores downloadOnly', async () => {
    mockFetch(MANIFEST);
    const u = await checkForUpdate(deps());
    await expect(u!.install()).rejects.toThrow(/installs updates manually/i);
  });

  it('the SAME version is not offered — a manifest that lists what is running is not an update', async () => {
    mockFetch({ version: '0.1.3' });
    expect(await checkForUpdate(deps())).toBeNull();
  });

  it('an OLDER version is not offered, so a rolled-back manifest cannot advertise a downgrade', async () => {
    mockFetch({ version: '0.1.0' });
    expect(await checkForUpdate(deps())).toBeNull();
  });

  it('stays silent rather than throwing when the manifest is unreachable, malformed, or version-less', async () => {
    // An update check must never be able to break the app it is checking.
    mockFetch({}, false);
    expect(await checkForUpdate(deps())).toBeNull();

    mockFetch({ notes: 'no version field here' });
    expect(await checkForUpdate(deps())).toBeNull();

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    expect(await checkForUpdate(deps())).toBeNull();
  });

  it('offers nothing when the running version cannot be determined — there is nothing to compare against', async () => {
    mockFetch(MANIFEST);
    expect(await checkForUpdate(deps({ currentVersion: () => Promise.resolve(null) }))).toBeNull();
  });
});
