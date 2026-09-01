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
  /**
   * True when this app CANNOT install the update itself and the customer has to
   * fetch it manually.
   *
   * ⚠️ NO PLATFORM SETS THIS TODAY (2026-09-01). macOS did, on the grounds that a
   * minisign-only artifact must not replace an OS-signed bundle — but the shipped
   * build is adhoc-signed with no Team ID and spctl rejects it, so there was no
   * code requirement to protect and the guard only cost every Mac customer a
   * manual download. See capabilities/updater-check-macos.json for the
   * measurement.
   *
   * ⛔ KEPT, NOT DELETED. It becomes live again the moment a platform is granted
   * `updater:allow-check` without `updater:default`, and Developer ID signing is
   * exactly when that trade-off should be re-argued. Deleting it would mean the
   * next platform in that position silently gets a button that always fails.
   */
  downloadOnly?: boolean;
  /** Where to send a `downloadOnly` customer. */
  downloadUrl?: string;
}

/** The release page — always the newest, so it cannot go stale at the next cut. */
export const RELEASES_URL = 'https://github.com/driftstackdev/driftstack-api/releases/latest';
const MANIFEST_URL = `${RELEASES_URL}/download/latest.json`;

export interface UpdaterDeps {
  /** Resolves the available `Update`, or null when up-to-date. */
  check: () => Promise<Update | null>;
  /** Restart the app into the freshly-installed version. */
  relaunch: () => Promise<void>;
  /**
   * The running version, for the manifest-only path where the plugin is not
   * available to report it. Null when it cannot be determined — in which case
   * there is nothing to compare against and no update is offered.
   */
  currentVersion: () => Promise<string | null>;
  /**
   * Whether THIS platform is allowed to replace its own bundle.
   *
   * ⛔ False on macOS, and that is a capability fact rather than a preference:
   * `updater-check-macos` grants `updater:allow-check` and nothing else, so
   * `check()` resolves but `downloadAndInstall()` is denied at the IPC layer.
   * Without this, a successful check would hand the UI an Install button whose
   * only possible outcome is a permission error.
   */
  canSelfInstall: () => boolean;
  /** False on Windows: its installer restarts the app itself. Optional so a
   *  deps object predating it keeps the old always-relaunch behaviour. */
  needsManualRelaunch?: () => boolean;
}

/**
 * Whether this platform may install an update itself.
 *
 * ⛔ Was `return !mac`. macOS is now granted `updater:default` + `process:default`
 * like Windows and Linux, because the reason it was withheld — protecting the
 * code requirement of an OS-signed bundle — described a bundle that does not
 * exist: `codesign` reports Signature=adhoc, TeamIdentifier=not set, and `spctl`
 * rejects the shipped app outright. The owner's install sat two releases behind
 * because of it.
 *
 * Still injected through `UpdaterDeps` so BOTH branches stay reachable from a
 * test: the download-only path is dead code today but must keep working for the
 * day a platform is granted check-without-install again.
 */
function platformCanSelfInstall(): boolean {
  return true;
}

/**
 * Whether THIS app must relaunch itself after installing, or whether the
 * platform's installer owns the restart.
 *
 * ⛔ WINDOWS OWNS ITS OWN RESTART AND CALLING relaunch() THERE BREAKS THE UPDATE.
 * Owner-reported on 0.1.8, 2026-09-01: "it installs, and then the program just
 * shutdowns, no new update installed."
 *
 * On Windows `downloadAndInstall()` launches the NSIS installer and the app must
 * EXIT so the installer can overwrite the running .exe. Calling `relaunch()`
 * instead spawns a fresh copy of the OLD binary and exits the current one — so a
 * process is still holding the file the installer is trying to replace. The
 * install fails, the app disappears, and the customer is left on the old version
 * with no error: exactly the reported symptom.
 *
 * macOS and Linux are the opposite: the bundle is swapped in place while the app
 * runs, and nothing restarts it unless we do.
 *
 * ⚠️ UNVERIFIED ON WINDOWS FROM HERE — this box is a Mac. The reasoning is from
 * Tauri v2's documented platform split plus the reported symptom; it should be
 * confirmed on a real Windows install before this row is called closed.
 */
function platformNeedsManualRelaunch(): boolean {
  if (typeof navigator === 'undefined') return true;
  const win = /Win/i.test(navigator.platform ?? '') || /Windows/i.test(navigator.userAgent ?? '');
  return !win;
}

const defaultDeps: UpdaterDeps = {
  canSelfInstall: platformCanSelfInstall,
  needsManualRelaunch: platformNeedsManualRelaunch,
  currentVersion: async () => {
    try {
      const { resolveAppVersion } = await import('./app-version');
      return await resolveAppVersion();
    } catch {
      return null;
    }
  },
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
    // The plugin is not permitted here (macOS) or the check genuinely failed.
    // Fall back to READING the manifest, which needs no updater capability, so
    // the customer at least learns a new version exists.
    return checkManifestOnly(deps);
  }
  if (!update) return null;

  const offered = update;
  // ⭐ THE macOS PATH, and it is why this function exists in this shape.
  //
  // macOS holds `updater:allow-check` ONLY. The check itself is Rust-side, so it
  // is not subject to the webview CORS rule that silently broke the manifest
  // fallback (GitHub's release-asset redirect sends no Access-Control-Allow-Origin,
  // so `fetch` rejected before the app could read the version and the customer was
  // told nothing). Checking works here; installing must not be offered, because
  // the capability denies it and the button could only ever fail.
  const canInstall = deps.canSelfInstall();
  // Defend against a botched/rolled-back manifest that lists the installed
  // version (or older): Tauri's check() USUALLY filters, but with no app-side
  // guard a same/older manifest would render an "Update X available (current X)"
  // banner whose Install reinstalls the same build. Only offer a strictly NEWER
  // version. (audit)
  if (!isNewerVersion(offered.version, offered.currentVersion)) return null;

  if (!canInstall) {
    return {
      version: offered.version,
      currentVersion: offered.currentVersion,
      notes: offered.body ?? null,
      downloadOnly: true,
      downloadUrl: RELEASES_URL,
      // Same contract as `checkManifestOnly`: never silently no-op, so a caller
      // that ignored `downloadOnly` fails loudly instead of appearing to update.
      install: () =>
        Promise.reject(
          new Error('This platform installs updates manually — open the releases page.'),
        ),
    };
  }

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
      // The bundle is installed (and verified).
      //
      // ⛔ ONLY WHERE WE OWN THE RESTART. On Windows the NSIS installer owns it,
      // and relaunching here respawns the OLD binary onto the file the installer
      // is mid-way through replacing — the update then fails silently and the
      // app vanishes. Elsewhere the bundle is swapped in place and nothing
      // restarts the app unless we do, so the customer would sit on the old
      // version until they quit.
      // ⚠️ `?? true` — a deps object that predates this field keeps the OLD
      // behaviour (always relaunch) instead of throwing. Only a caller that
      // explicitly says "the installer owns the restart" skips it, so the
      // dangerous direction requires an affirmative statement.
      if (deps.needsManualRelaunch?.() ?? true) await deps.relaunch();
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

/**
 * Version check WITHOUT the updater plugin: fetch the same `latest.json` the
 * plugin would and compare versions ourselves.
 *
 * This is the macOS path. Reading a JSON file needs no updater capability, so
 * it works where `check()` is not permitted — and it deliberately cannot
 * install anything, which is the property that makes it safe to run there.
 *
 * Best-effort in every direction: offline, a malformed manifest, a missing
 * version field and an unreadable current version all resolve to null rather
 * than throwing into the shell. An update check must never be able to break
 * the app it is checking.
 */
async function checkManifestOnly(deps: UpdaterDeps): Promise<AvailableUpdate | null> {
  try {
    const currentVersion = await deps.currentVersion();
    if (currentVersion === null) return null;
    const res = await fetch(MANIFEST_URL, { redirect: 'follow' });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const version =
      typeof body === 'object' &&
      body !== null &&
      typeof (body as { version?: unknown }).version === 'string'
        ? (body as { version: string }).version
        : null;
    if (version === null || !isNewerVersion(version, currentVersion)) return null;
    const notes =
      typeof body === 'object' &&
      body !== null &&
      typeof (body as { notes?: unknown }).notes === 'string'
        ? (body as { notes: string }).notes
        : null;
    return {
      version,
      currentVersion,
      notes,
      downloadOnly: true,
      downloadUrl: RELEASES_URL,
      // Never silently no-op: a caller that ignored downloadOnly and called
      // install() must fail loudly rather than appear to have updated.
      install: () =>
        Promise.reject(
          new Error('This platform installs updates manually — open the releases page.'),
        ),
    };
  } catch {
    return null;
  }
}
