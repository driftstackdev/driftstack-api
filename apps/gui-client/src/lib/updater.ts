// V-243 — Tauri v2 auto-update flow (the in-app half).
//
// The plugin (`tauri-plugin-updater`) is registered in src-tauri/lib.rs
// and configured in tauri.conf.json (endpoint = the GitHub-Releases
// `gui-latest.json` manifest; pubkey verifies each bundle's minisign
// signature). But Tauri v2's updater is PROGRAMMATIC — unlike v1 there
// is no built-in "check on startup + dialog" (the stale `dialog:true`
// config key did nothing in v2). This module is the missing half: it
// checks the endpoint, and — on the user's confirmation — downloads +
// installs the signed bundle and relaunches into the new version.
//
// Design ("best way" for a developer-tool desktop app):
//   - Check ONCE on startup, silently. A check failure (offline, no
//     endpoint, not a Tauri context / dev mode) resolves to `null` and
//     NEVER blocks or errors the app — update checks are best-effort.
//   - If an update is available, surface a NON-blocking banner (the UI
//     layer) so the customer decides when to install — predictable for
//     a tool they may be mid-session with — rather than a surprise
//     restart.
//   - On confirm: downloadAndInstall (signature verified by the plugin
//     against the embedded pubkey) with byte progress, then relaunch.
//
// Dependency-injected so the flow is unit-testable without a Tauri
// runtime: the real `check`/`relaunch` are LAZY dynamic imports inside
// the default deps (so importing this module in a node test never loads
// the Tauri plugins), and tests pass fakes.

import type { Update } from '@tauri-apps/plugin-updater';

/** What the UI needs to render the prompt + drive the install. */
export interface AvailableUpdate {
  /** The version offered by the manifest (e.g. "0.1.0"). */
  version: string;
  /** The version currently running. */
  currentVersion: string;
  /** Release notes from the manifest, if any. */
  notes: string | null;
  /**
   * Download + install the signed bundle, then relaunch into it.
   * `onProgress` receives a 0..1 fraction (0 if the manifest omits a
   * content-length). Rejects if the download/verify/install fails — the
   * UI should surface that and leave the running app untouched.
   */
  install: (onProgress?: (fraction: number) => void) => Promise<void>;
}

export interface UpdaterDeps {
  /** Resolves the available `Update`, or null when up-to-date. */
  check: () => Promise<Update | null>;
  /** Restart the app into the freshly-installed version. */
  relaunch: () => Promise<void>;
}

const defaultDeps: UpdaterDeps = {
  // Lazy so a node unit test importing this module doesn't pull in the
  // Tauri plugin runtime (which only resolves inside the app).
  check: async () => {
    const { check } = await import('@tauri-apps/plugin-updater');
    return check();
  },
  relaunch: async () => {
    const { relaunch } = await import('@tauri-apps/plugin-process');
    return relaunch();
  },
};

/**
 * Check the configured endpoint for an update. Returns an
 * {@link AvailableUpdate} (carrying the install closure) when one is
 * available, else `null`. NEVER throws — any failure (offline, endpoint
 * down, signature/manifest error, or running outside a Tauri context)
 * is swallowed to `null`, so a startup check can't break the app.
 */
export async function checkForUpdate(
  deps: UpdaterDeps = defaultDeps,
): Promise<AvailableUpdate | null> {
  let update: Update | null;
  try {
    update = await deps.check();
  } catch {
    return null;
  }
  if (!update) return null;

  const offered = update;
  return {
    version: offered.version,
    currentVersion: offered.currentVersion,
    notes: offered.body ?? null,
    install: async (onProgress) => {
      let contentLength = 0;
      let downloaded = 0;
      await offered.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            contentLength = event.data.contentLength ?? 0;
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            if (onProgress) onProgress(contentLength > 0 ? downloaded / contentLength : 0);
            break;
          case 'Finished':
            if (onProgress) onProgress(1);
            break;
        }
      });
      // The bundle is installed (and verified). Relaunch so the customer
      // lands in the new version immediately rather than on next launch.
      await deps.relaunch();
    },
  };
}
