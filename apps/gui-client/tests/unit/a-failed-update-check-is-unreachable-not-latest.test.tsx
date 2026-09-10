// #6 (audit) — the manual "Check for updates" in Settings reported "You are on the
// latest version." even when the check had FAILED (offline / endpoint unreachable),
// because checkForUpdate collapsed both "no update" and "could not reach the server" to
// null. checkForUpdateVerbose is the discriminated result Settings now consults: it must
// return 'unreachable' (→ the honest "Couldn't reach the update server" copy) rather than
// 'none' (→ "latest") when neither the updater plugin nor the manifest fallback can reach.
//
// Injected deps + a stubbed global fetch, so this runs without a Tauri/network runtime.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkForUpdateVerbose, type UpdaterDeps } from '../../src/lib/updater';
import type { Update } from '@tauri-apps/plugin-updater';

const CURRENT = '0.1.0';

function newerUpdate(): Update {
  return {
    version: '0.2.0',
    currentVersion: CURRENT,
    body: 'notes',
    downloadAndInstall: (): Promise<void> => Promise.resolve(),
  } as unknown as Update;
}

function deps(over: Partial<UpdaterDeps> = {}): UpdaterDeps {
  return {
    check: () => Promise.resolve(null),
    currentVersion: () => Promise.resolve(CURRENT),
    canSelfInstall: () => true,
    relaunch: () => Promise.resolve(),
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('#6 — checkForUpdateVerbose distinguishes none / found / unreachable', () => {
  it("is 'none' when the updater plugin says there is no update (the up-to-date case)", async () => {
    const r = await checkForUpdateVerbose(deps({ check: () => Promise.resolve(null) }));
    expect(r.status).toBe('none');
    expect(r.update).toBeUndefined();
  });

  it("is 'found' with an installable update when a strictly newer version is offered", async () => {
    const r = await checkForUpdateVerbose(deps({ check: () => Promise.resolve(newerUpdate()) }));
    expect(r.status).toBe('found');
    expect(r.update?.version).toBe('0.2.0');
  });

  it("is 'unreachable' (NOT 'none') when the plugin fails AND the manifest fetch is not ok — the load-bearing arm for the 'latest' bug", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 503 } as Response)),
    );
    const r = await checkForUpdateVerbose(
      deps({ check: () => Promise.reject(new Error('plugin denied')) }),
    );
    expect(r.status).toBe('unreachable');
  });

  it("is 'unreachable' when the plugin fails AND the manifest fetch throws (offline)", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network down'))),
    );
    const r = await checkForUpdateVerbose(
      deps({ check: () => Promise.reject(new Error('plugin denied')) }),
    );
    expect(r.status).toBe('unreachable');
  });

  it("is 'none' when the plugin fails but the manifest IS reachable and reports no newer version (reachable ≠ update)", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ version: CURRENT }),
        } as unknown as Response),
      ),
    );
    const r = await checkForUpdateVerbose(
      deps({ check: () => Promise.reject(new Error('plugin denied')) }),
    );
    expect(r.status).toBe('none');
  });
});
