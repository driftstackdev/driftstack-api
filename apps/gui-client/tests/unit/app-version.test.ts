// P2 #11 — the title-bar version must be the REAL build version, not a hardcoded
// literal. resolveAppVersion reads the Tauri runtime version when available and
// falls back cleanly otherwise.

import { afterEach, describe, expect, it, vi } from 'vitest';
// resolveAppVersion is re-imported dynamically inside each test (after vi.doMock)
// so the runtime mock is picked up; only FALLBACK_APP_VERSION is used statically.
import { FALLBACK_APP_VERSION } from '../../src/lib/app-version';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('resolveAppVersion', () => {
  it('returns the Tauri runtime version when available', async () => {
    vi.doMock('@tauri-apps/api/app', () => ({ getVersion: () => Promise.resolve('1.4.2') }));
    // Re-import so the dynamic import inside resolveAppVersion picks up the mock.
    const { resolveAppVersion: resolve } = await import('../../src/lib/app-version');
    expect(await resolve()).toBe('1.4.2');
  });

  it('falls back when the Tauri call throws (browser preview / no runtime)', async () => {
    vi.doMock('@tauri-apps/api/app', () => ({
      getVersion: () => Promise.reject(new Error('no tauri')),
    }));
    const { resolveAppVersion: resolve, FALLBACK_APP_VERSION: fb } =
      await import('../../src/lib/app-version');
    expect(await resolve()).toBe(fb);
  });

  it('falls back on an empty version string', async () => {
    vi.doMock('@tauri-apps/api/app', () => ({ getVersion: () => Promise.resolve('') }));
    const { resolveAppVersion: resolve, FALLBACK_APP_VERSION: fb } =
      await import('../../src/lib/app-version');
    expect(await resolve()).toBe(fb);
  });

  it('exposes a non-empty fallback so the version slot is never blank', () => {
    expect(FALLBACK_APP_VERSION.length).toBeGreaterThan(0);
  });
});
