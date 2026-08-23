// V-243 — Tauri v2 auto-update flow (the in-app half).
//
// The plugin (`tauri-plugin-updater`) is registered in src-tauri/lib.rs
// and configured in tauri.conf.json (endpoint = the GitHub-Releases
// `latest.json` manifest; pubkey verifies each bundle's minisign
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
/**
 * True iff `offered` is a strictly newer semver than `current`. Tolerant of a
 * leading `v`, pre-release/build suffixes (compared on the numeric core only),
 * and unparseable input (returns false — never offer a version we can't reason
 * about). Pure + exported for tests.
 */
export function isNewerVersion(offered: string, current: string): boolean {
  const core = (v: string): number[] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    if (m === null) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const a = core(offered);
  const b = core(current);
  if (a === null || b === null) return false;
  for (let i = 0; i < 3; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false; // equal core → not newer
}

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
  // Defend against a botched/rolled-back manifest that lists the installed
  // version (or older): Tauri's check() USUALLY filters, but with no app-side
  // guard a same/older manifest would render an "Update X available (current X)"
  // banner whose Install reinstalls the same build. Only offer a strictly NEWER
  // version. (audit)
  if (!isNewerVersion(offered.version, offered.currentVersion)) return null;

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

/**
 * Whether a found update should install itself without asking.
 *
 * Auto-update defaults ON, because a desktop client sitting on a months-old
 * build against a moving server API is how version skew turns into a support
 * ticket. But installing ends in `relaunch()`, and relaunching mid-session
 * destroys live browser state the customer cannot get back — worse than being
 * one version behind. So the preference is necessary and not sufficient: a
 * running session defers to the existing non-blocking banner, which is exactly
 * the "customer picks the moment" path that already existed.
 *
 * Pure, because the interesting part is the policy, not the plumbing.
 */
export function shouldAutoInstall(args: { autoUpdate: boolean; sessionRunning: boolean }): boolean {
  return args.autoUpdate && !args.sessionRunning;
}

/**
 * Best-effort "is the customer mid-session".
 *
 * Simulator windows are labelled `simulator-<sessionId>` by open-simulator, so
 * their presence is the concrete signal. Honest limitation: on macOS the
 * simulator is a SEPARATE application, so the main app cannot see its windows
 * and this returns false there. That errs toward auto-installing on macOS —
 * acceptable only because the failure is bounded (a relaunch of the main
 * window) and because the platform where auto-update matters most, and where
 * the simulator IS in-process, is Windows. Any throw means "unknown", and
 * unknown must not read as "safe to relaunch".
 */
export async function isSessionRunning(): Promise<boolean> {
  try {
    const { getAllWebviewWindows } = await import('@tauri-apps/api/webviewWindow');
    const all = await getAllWebviewWindows();
    return all.some((w) => w.label.startsWith('simulator-'));
  } catch {
    return true;
  }
}
