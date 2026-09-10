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
//   - Check on startup, silently, and again every UPDATE_RECHECK_INTERVAL_MS
//     while the app stays open (T-14 — it used to be once, and an app left
//     running for days never saw a release cut after it started). A check
//     failure (offline, no endpoint, not a Tauri context / dev mode) resolves
//     to `null` and NEVER blocks or errors the app — update checks are
//     best-effort.
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
   * ⛔ (RETIRED 2026-09-01 — was false on macOS), and that is a capability fact rather than a preference:
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

export const defaultDeps: UpdaterDeps = {
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

/** #6 — a discriminated update-check result. `checkForUpdate` collapses it to
 *  AvailableUpdate | null for the auto-update loop, but the MANUAL Settings check needs
 *  to tell "you are up to date" (none) apart from "the check could not reach the update
 *  server" (unreachable) — collapsing both to null made a failed manual check read as
 *  "You are on the latest version." (owner-adjacent audit finding). */
export interface UpdateCheckResult {
  status: 'none' | 'found' | 'unreachable';
  update?: AvailableUpdate;
}

/** Back-compat wrapper preserving the never-throws, null-on-no-update contract every
 *  existing caller (incl. the App.tsx auto-update loop) relies on. */
export async function checkForUpdate(
  deps: UpdaterDeps = defaultDeps,
): Promise<AvailableUpdate | null> {
  const result = await checkForUpdateVerbose(deps);
  return result.status === 'found' ? (result.update ?? null) : null;
}

export async function checkForUpdateVerbose(
  deps: UpdaterDeps = defaultDeps,
): Promise<UpdateCheckResult> {
  let update: Update | null;
  try {
    update = await deps.check();
  } catch {
    // The plugin is not permitted here (macOS) or the check genuinely failed.
    // Fall back to READING the manifest, which needs no updater capability, so the
    // customer at least learns a new version exists AND whether the server was reachable.
    return checkManifestVerbose(deps);
  }
  if (!update) return { status: 'none' };

  const offered = update;
  // ⭐ WHY THIS FUNCTION EXISTS IN THIS SHAPE — historical, and the history is
  // now RETIRED. macOS used to hold `updater:allow-check` ONLY, so installing
  // could not be offered: the capability denied it and the button could only
  // ever fail. That is no longer true (V-2190, 2026-09-01) — macOS holds
  // `updater:default` + `process:default` like every other platform, because
  // the exclusion protected the code requirement of an OS-signed bundle and the
  // shipped app is adhoc-signed with no Team ID.
  //
  // ⚠️ The Rust-side check still matters and is unchanged: it is not subject to
  // the webview CORS rule that silently broke the manifest fallback (GitHub's
  // release-asset redirect sends no Access-Control-Allow-Origin, so `fetch`
  // rejected before the app could read the version and the customer was told
  // nothing at all).
  //
  // ⛔ The `!canInstall` branch below is therefore UNREACHABLE through
  // `defaultDeps` today. It is kept, not deleted — see `downloadOnly`.
  const canInstall = deps.canSelfInstall();
  // Defend against a botched/rolled-back manifest that lists the installed
  // version (or older): Tauri's check() USUALLY filters, but with no app-side
  // guard a same/older manifest would render an "Update X available (current X)"
  // banner whose Install reinstalls the same build. Only offer a strictly NEWER
  // version. (audit)
  if (!isNewerVersion(offered.version, offered.currentVersion)) return { status: 'none' };

  if (!canInstall) {
    const downloadOnlyUpdate: AvailableUpdate = {
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
    return { status: 'found', update: downloadOnlyUpdate };
  }

  const installableUpdate: AvailableUpdate = {
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
  return { status: 'found', update: installableUpdate };
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
 * A cross-platform signal source for {@link isSessionRunning}, injected so the
 * server-list path stays testable without a live SDK client.
 */
export interface SessionSignalDeps {
  /**
   * The account's ACTIVE-session count, or `null` when it cannot be determined
   * (no client / route unavailable / the fetch failed / slow). `null` is
   * "unknown" and, because a relaunch mid-session is unrecoverable, is treated
   * as "a session may be running" — the veto defers to the banner rather than
   * auto-installing on an inconclusive answer.
   */
  activeSessionCount?: () => Promise<number | null>;
}

/**
 * Best-effort "is the customer mid-session" — the load-bearing veto that stops
 * an unattended install from relaunching the app out from under live work.
 *
 * TWO independent signals, because neither alone covers every platform:
 *
 *   1. In-process simulator WINDOWS, labelled `simulator-<sessionId>` by
 *      open-simulator. On Windows/Linux the simulator runs inside the main app,
 *      so a live session has a visible window — a free, concrete "yes".
 *
 *   2. The account's active-session COUNT from the server (injected via
 *      `deps.activeSessionCount`). ⛔ BUG (T-14): on macOS the simulator is a
 *      SEPARATE application whose windows are invisible here, and a ProfilesView
 *      bulk-launch loop holds only server-side agent sessions with NO window at
 *      all — so signal 1 alone reported `false` on macOS even mid-session. With
 *      auto-update now defaulting ON and macOS able to self-install, that false
 *      let the 6-hour recheck relaunch the main app and abort in-flight work
 *      with no prompt. The server count sees the session regardless of platform,
 *      which is what makes the "never auto-install while a session runs" guard
 *      actually fire on Mac.
 *
 * Fail SAFE: a relaunch mid-session is unrecoverable, so anything short of a
 * confident "no session" defers to the banner. A window probe that throws, and a
 * server count that comes back `null` (call failed/slow/unavailable), both read
 * as "a session may be running". An install proceeds only on an affirmative "no
 * window AND the server says zero" — or, when no server signal is wired, a window
 * probe that succeeded and found none.
 */
export async function isSessionRunning(deps: SessionSignalDeps = {}): Promise<boolean> {
  // Signal 1 — in-process windows (Windows/Linux). A visible simulator window is
  // a definite yes. A probe that THROWS is "unknown", not "no": remember that
  // rather than concluding false from a failed enumeration.
  let windowProbeFailed = false;
  try {
    const { getAllWebviewWindows } = await import('@tauri-apps/api/webviewWindow');
    const all = await getAllWebviewWindows();
    if (all.some((w) => w.label.startsWith('simulator-'))) return true;
  } catch {
    windowProbeFailed = true;
  }

  // Signal 2 — the server's active-session count (all platforms, incl. macOS,
  // where signal 1 is structurally blind). A positive count is a session; a
  // `null` is unknown and must not read as "safe to relaunch".
  if (deps.activeSessionCount !== undefined) {
    let count: number | null;
    try {
      count = await deps.activeSessionCount();
    } catch {
      count = null;
    }
    if (count === null) return true; // unknown → defer to the banner
    return count > 0;
  }

  // No server signal wired: the window probe is all we have. A probe that threw
  // is unknown (→ running); a probe that found no window is a confident "no".
  return windowProbeFailed;
}

/**
 * T-14 — how often an app that stays open re-asks the endpoint.
 *
 * The check used to run ONCE, on mount. The owner's app process had been running
 * continuously since 2026-09-05 (measured with ps), and every release since was
 * cut while it was open — so no check ever saw 0.1.16 through 0.1.19, and the
 * installed app sat four versions behind an endpoint that served the newest one
 * for its platform and key. Six hours is short enough that a release lands the
 * same working day and long enough that an offline laptop is not polling.
 */
export const UPDATE_RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** What one pass of the update decision did. */
export type UpdateOutcome = 'none' | 'installed' | 'banner';

/**
 * The decision path's inputs, injected so the mount-time check and every later
 * re-check go through ONE function — and so a test can drive the whole path
 * without a Tauri runtime. Production wires `checkForUpdate`, the customer's
 * live `autoUpdate` preference, `isSessionRunning`, and the banner's setter.
 */
export interface UpdateCycleDeps {
  /** `checkForUpdate` — the offered update, or null when up to date. Never throws. */
  check: () => Promise<AvailableUpdate | null>;
  /** The customer's CURRENT preference, read at decision time, never captured earlier. */
  autoUpdate: () => boolean;
  /** `isSessionRunning` — the not-while-a-session-runs veto. */
  sessionRunning: () => Promise<boolean>;
  /**
   * Surface the offered update — the banner. Called only for a real update that
   * was NOT installed, so a null result and a successful unattended install both
   * leave whatever is on screen alone.
   */
  onOffered: (update: AvailableUpdate) => void;
}

/**
 * ONE pass of the decision: `check` → `shouldAutoInstall` (with the
 * not-while-a-session-runs guard) → install, else banner.
 *
 * T-14 — extracted from the App-shell mount effect so the periodic re-check
 * cannot drift from it: there is exactly one place that decides, and the effect
 * only says when to run it. A failed unattended install degrades into the
 * banner rather than into a dead end, and nothing here throws, because an
 * update check must never be able to break the app it is checking.
 */
export async function runUpdateCycle(deps: UpdateCycleDeps): Promise<UpdateOutcome> {
  const update = await deps.check();
  if (update === null) return 'none';
  if (
    shouldAutoInstall({
      autoUpdate: deps.autoUpdate(),
      sessionRunning: await deps.sessionRunning(),
    })
  ) {
    try {
      await update.install();
      return 'installed';
    } catch {
      /* fall through to the banner */
    }
  }
  deps.onOffered(update);
  return 'banner';
}

/** The timer pair, injectable so a test can drive the loop with fake time. */
export interface UpdateLoopTimers {
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

/**
 * Run the decision once now and again every `intervalMs` until the returned
 * stop function is called (the effect's cleanup).
 *
 * Single-flight: a tick that arrives while a pass is still in flight — a slow
 * endpoint, or an install download — is a no-op rather than a second download
 * stacked on the first. And once a pass has INSTALLED, the loop stops: the app
 * is on its way to a relaunch, and a later tick would compare the endpoint
 * against the version still in memory and offer the same update again.
 */
export function startUpdateChecks(
  deps: UpdateCycleDeps,
  options: { intervalMs?: number; timers?: UpdateLoopTimers } = {},
): () => void {
  const intervalMs = options.intervalMs ?? UPDATE_RECHECK_INTERVAL_MS;
  // Resolved at call time, so fake timers installed before the loop starts are
  // the ones it uses.
  const timers: UpdateLoopTimers = options.timers ?? {
    setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
    clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  };
  let inFlight = false;
  let stopped = false;
  let handle: unknown = null;
  const stop = (): void => {
    stopped = true;
    if (handle !== null) timers.clearInterval(handle);
    handle = null;
  };
  const tick = (): void => {
    if (stopped || inFlight) return;
    inFlight = true;
    void runUpdateCycle(deps)
      .then((outcome) => {
        if (outcome === 'installed') stop();
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  };
  tick();
  handle = timers.setInterval(tick, intervalMs);
  return stop;
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
async function checkManifestVerbose(deps: UpdaterDeps): Promise<UpdateCheckResult> {
  try {
    const currentVersion = await deps.currentVersion();
    if (currentVersion === null) return { status: 'none' };
    const res = await fetch(MANIFEST_URL, { redirect: 'follow' });
    if (!res.ok) return { status: 'unreachable' };
    const body: unknown = await res.json();
    const version =
      typeof body === 'object' &&
      body !== null &&
      typeof (body as { version?: unknown }).version === 'string'
        ? (body as { version: string }).version
        : null;
    if (version === null || !isNewerVersion(version, currentVersion)) return { status: 'none' };
    const notes =
      typeof body === 'object' &&
      body !== null &&
      typeof (body as { notes?: unknown }).notes === 'string'
        ? (body as { notes: string }).notes
        : null;
    const manifestUpdate: AvailableUpdate = {
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
    return { status: 'found', update: manifestUpdate };
  } catch {
    // A thrown fetch/json is the manifest fallback's own "could not reach" signal.
    return { status: 'unreachable' };
  }
}
