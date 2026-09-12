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
   *
   * Rejects with an {@link UpdateInstallError} on the installable path, so the
   * caller learns WHICH awaited call failed and keeps the plugin's own text.
   * `hooks` is optional in both directions: a caller that does not pass it gets
   * the retry anyway (just invisibly), and a fake `install` in a test may ignore
   * it entirely.
   */
  install: (onProgress?: (fraction: number) => void, hooks?: UpdateInstallHooks) => Promise<void>;
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

// ─────────────────────────────────────────────────────────────────────────────
// U1/U2 — the install failure's own vocabulary.
//
// Owner, 2026-09-12: *"Update to 0.1.51 failed: Update couldn't be installed.
// Try again."* — *"often this happens! i see it very often"*.
//
// ⛔ THE REASON WAS DESTROYED AT THE MOMENT IT HAPPENED, TWICE OVER.
//   1. `UpdateBanner` caught the rejection and handed it to
//      `humanizeError(e, "Update couldn't be installed. Try again.")`, which
//      classifies by regex over the message and returns the FALLBACK for
//      anything unmatched. Measured 2026-09-12 by running 32 real
//      `tauri-plugin-updater` 2.10.1 Display strings through the four regexes
//      lifted byte-exactly out of `humanize-error.ts`: 29 of 32 reach the
//      fallback. So the owner's sentence is itself a measurement — it rules
//      OUT every signature-named class and the timeout class, and leaves a
//      filesystem / extract / permission error, an `os error N`, an HTTP
//      status, or a failed relaunch.
//   2. Nothing logged it either. `installLogCapture` (lib/log-buffer.ts) patches
//      `console.*` and the window `error` / `unhandledrejection` listeners —
//      an awaited rejection inside a `try` fires neither, so the dev log is
//      structurally blind to it. Sentry is crash-only with `Breadcrumbs`
//      dropped and `GlobalHandlers` kept, so it is blind for the same reason.
//
// ⚠️ WHICH COPY RULE APPLIES HERE, AND WHY IT IS NOT THE ONE THAT BANS THIS.
// The customer-facing-copy policy — `humanize-error.ts:13-16` and the guard in
// `tests/unit/sdk-error-copy-boundary.test.ts` — bans reflecting error PROSE
// into the installed client. Read the guard: it is scoped to eight SDK-backed
// views under `src/views`, and it forbids exactly `err.title`, `err.detail` and
// `DriftstackError…err.message`. Its subject is the REMOTE problem body, which
// is server-authored, can name internal hosts, and has been observed carrying a
// request id and a connection string. A `tauri-plugin-updater` rejection is
// none of that: it is THIS machine's own OS error about THIS machine's own
// filesystem ("Permission denied (os error 13)", "Failed to move the new app
// into place", "Invalid cross-device link (os error 18)"). Withholding it from
// the person sitting at the machine is what produced this row, so it is
// DISCLOSED — behind a details/Copy-details affordance, with the human sentence
// still the headline, never a raw stack in the sentence.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHICH of the install closure's awaited calls rejected.
 *
 * ⛔ THE BANNER'S MESSAGE COULD BE A LIE AND THIS IS WHY. The closure awaits
 * `downloadAndInstall()` AND then `relaunch()` inside ONE `try`, and
 * `platformNeedsManualRelaunch()` is true on macOS — so an install that
 * SUCCEEDED and then failed to restart rendered *"Update to 0.1.51 failed:
 * Update couldn't be installed."*, which is false in both halves. Recording the
 * message alone would have inherited that ambiguity, so the stage is recorded
 * with it and the banner says something different for each.
 *
 * `unknown` is for a rejection that did not come through that closure at all (a
 * `downloadOnly` platform's deliberate reject, or a caller-supplied fake).
 */
export type UpdateInstallStage = 'download' | 'relaunch' | 'unknown';

/** Optional progress-adjacent callbacks for {@link AvailableUpdate.install}. */
export interface UpdateInstallHooks {
  /**
   * A transient download failure is about to be retried, once. Called BEFORE
   * the second attempt with the attempt number it is starting (2) and the raw
   * reason the first one gave.
   *
   * U2 — the retry has to be VISIBLE: a silent retry is indistinguishable from
   * one slow first attempt, and "it just sat there" is the report we would get
   * instead of the one we fixed.
   */
  onRetry?: (attempt: number, reason: string) => void;
}

/** Everything a maintainer needs to name ONE install failure. */
export interface UpdateInstallDiagnostic {
  stage: UpdateInstallStage;
  /** The plugin's own text, verbatim — never humanized, never truncated. */
  reason: string;
  /** 1 for the first attempt, 2 for the single retry. */
  attempt: number;
  /**
   * On attempt 2 ONLY: what attempt 1 said.
   *
   * ⛔ WITHOUT IT THE RETRY MAKES THE FAILURE LESS DIAGNOSABLE THAN IT WAS,
   * which is the opposite of U1's row. Attempt 2's reason is frequently an
   * artefact of attempt 1's damage rather than the cause: on the macOS
   * non-authorization path `install_inner` moves the live bundle out at
   * updater.rs:1255 before the final rename, so a second attempt's
   * `fs::rename(extract_path → …)` reports *"No such file or directory
   * (os error 2)"* — pointing at nothing, and that is the reason the customer
   * reads, copies and forwards.
   */
  firstReason?: string;
  /** True when this failure is about to be retried, so the log carries the pair. */
  willRetry: boolean;
  /** The running version. "0.1.51 failed" alone does not say what it failed FROM. */
  fromVersion: string;
  /** The offered version. */
  toVersion: string;
  /** `navigator.platform` (UA as a fallback), so a Windows report is not read as a Mac one. */
  platform: string;
}

/**
 * The platform string that goes in the diagnostic. Not a capability check — a
 * LABEL, so a maintainer reading one line knows which of the three install
 * mechanics produced it (in-place bundle swap, NSIS installer, AppImage).
 */
export function updatePlatformLabel(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  const platform = navigator.platform ?? '';
  if (platform !== '') return platform;
  const ua = navigator.userAgent ?? '';
  return ua !== '' ? ua : 'unknown';
}

/**
 * Strip the QUERY STRING out of any URL the reason cites, keeping scheme, host
 * and path.
 *
 * ⛔ THE DOWNLOAD'S OWN ERROR CARRIES A CREDENTIAL, AND DISCLOSING THE REASON IS
 * WHAT PUT IT IN FRONT OF THREE SINKS. The download runs in Rust via reqwest,
 * whose `Display` appends ` for url (<url>)` to every send/body/redirect error
 * (reqwest-0.13.3/src/error.rs:236-284) — and the URL is GitHub's release-asset
 * redirect target. MEASURED 2026-09-12 against the live release:
 *
 *   https://release-assets.githubusercontent.com/…/<blob>?sp=r&sv=…&se=…
 *     &skoid=…&sig=<Azure SAS signature>&jwt=<JWT>&response-content-type=…
 *
 * So on the commonest network failure the reason string contains a SAS
 * signature and a bearer JWT — and this area sends the reason to Sentry, to
 * `$APPDATA/recordings/dev-log.txt`, and to the customer's clipboard. The
 * existing telemetry scrubber does NOT save us: `scrubText`'s param list
 * (telemetry.ts:250-262, 300-309) has `token`, `secret` and `signature` but
 * neither `sig` nor `jwt`, and `contexts.update.reason` goes through the
 * key-name-based `scrubObject`, where the key is `reason` and the value is
 * untouched. Short-lived, read-only and scoped to one blob, so the blast radius
 * is small — but a credential in telemetry is exactly what that scrubber exists
 * to prevent, and this is the first path in the app that funnels an arbitrary
 * reqwest message into `captureException`.
 *
 * ⛔ THE WHOLE QUERY GOES, not a list of param names. Enumerating names is the
 * mistake already in the tree (it is why `sig`/`jwt` survive), and this query is
 * pure SAS/JWT machinery with no diagnostic value — scheme + host + path already
 * say which CDN served which asset. Applied at the single choke point below so
 * every sink, the classifier, and `UpdateInstallError.message` get the same
 * text; a reason with no URL is returned byte-for-byte unchanged.
 *
 * ⚠️ THE MARKER'S CHARACTERS ARE LOAD-BEARING and the first version got this
 * wrong. `?<redacted>` is not a fixed point: `<` and `>` are excluded from the
 * URL character class, so a second pass matched `…/p` + `?` + zero chars and
 * appended a second marker (`…/p?<redacted><redacted>`). `[redacted]` uses only
 * characters the class accepts, so re-running the replace reproduces the same
 * string — MEASURED, not assumed; the previous sentence here claimed idempotence
 * that the code did not have. The delimiter is captured rather than normalised
 * to `?` so a stripped fragment is not reported as a stripped query.
 *
 * ⚠️ `telemetry.ts` should still learn `sig`/`jwt` — that file belongs to
 * another area, and it covers every OTHER caller. This is the local half.
 */
export function redactUpdateReason(reason: string): string {
  return reason.replace(/(https?:\/\/[^\s()<>"'`]+?)([?#])[^\s()<>"'`]*/gi, '$1$2[redacted]');
}

/**
 * The plugin's own text out of a rejection, whatever shape it arrived in —
 * verbatim except for {@link redactUpdateReason}.
 *
 * ⛔ IT IS USUALLY A BARE `string`, NOT AN `Error`, and a reader that only
 * handles `Error` gets an empty reason on the exact path that matters. Traced
 * 2026-09-12 through the vendored plugin: `Error` serializes via
 * `serializer.serialize_str(self.to_string())`
 * (tauri-plugin-updater-2.10.1/src/error.rs), the IPC response is
 * `application/json` so `response.json()` yields a string, and
 * `__TAURI_INTERNALS__.invoke` rejects with that value verbatim. Hence
 * `e instanceof Error === false` for a real macOS install failure.
 */
export function rawUpdateFailureReason(error: unknown): string {
  return redactUpdateReason(rejectionText(error));
}

function rejectionText(error: unknown): string {
  if (error instanceof UpdateInstallError) return error.reason;
  if (typeof error === 'string') return error.trim();
  if (error instanceof Error) return error.message.trim();
  if (error === null || error === undefined) return '';
  if (typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message.trim();
    // ⛔ NOT `String(error)`. An object with no `message` stringifies to
    // "[object Object]", and putting THAT in a dev log and on a customer's
    // screen is worse than an empty reason: it reads as a real reason and
    // sends the reader after it. `formatUpdateFailure` says "(the rejection
    // carried no text)" for the empty case, which is the truth.
    return '';
  }
  // Only the primitives whose stringification MEANS something. A rejection that
  // is a symbol or a function carries no reason, and `String()` over those
  // (like over a bare object) manufactures text that reads as one.
  if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') {
    return String(error);
  }
  return '';
}

/**
 * A rejection from the installable `install()` closure, carrying the stage and
 * the plugin's untouched text.
 *
 * `message` IS the raw reason on purpose: `humanizeError` still classifies the
 * real text (a signature failure keeps its verification copy rather than
 * degrading to the generic fallback), and existing assertions phrased as
 * `rejects.toThrow(/signature/)` keep meaning what they said.
 */
export class UpdateInstallError extends Error {
  readonly stage: UpdateInstallStage;
  readonly reason: string;
  /** How many `downloadAndInstall` attempts were made — 1, or 2 after a retry. */
  readonly attempts: number;
  /** Attempt 1's reason when `attempts === 2`, else `''`. See the field of the
   *  same name on {@link UpdateInstallDiagnostic} for why it has to travel. */
  readonly firstReason: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly platform: string;

  constructor(diag: UpdateInstallDiagnostic, attempts: number) {
    super(diag.reason);
    this.name = 'UpdateInstallError';
    this.stage = diag.stage;
    this.reason = diag.reason;
    this.attempts = attempts;
    this.firstReason = diag.firstReason ?? '';
    this.fromVersion = diag.fromVersion;
    this.toVersion = diag.toVersion;
    this.platform = diag.platform;
  }
}

/**
 * Failures a second identical attempt provably cannot fix. Checked FIRST, and
 * that order carries real weight now that the allowlist below matches reqwest
 * errors — whose text ends in ` for url (<the release-asset URL>)`, a string
 * the product does not control.
 *
 * ⛔ WHY THIS IS NOT THE ONLY TEST — a denylist alone RETRIES A SIGNATURE
 * FAILURE. Measured 2026-09-12 in the vendored plugin: two verification
 * failures do not contain the word "signature" at all —
 * `minisign_verify::Error::InvalidEncoding` Displays as *"Invalid encoding in
 * minisign data"*, and `Error::Base64` as base64 0.22.1's own
 * `"Invalid symbol 33, offset 5."` / `"Invalid last symbol 61, offset 42."` /
 * `"Invalid input length: 21"` / `"Invalid padding"`. A gate phrased as "retry
 * unless the message names a signature" therefore violates U2's hard rule — a
 * bad signature must fail once, loudly, forever — while reading as if it
 * enforced it.
 *
 * `no space left` / `not enough space` (the Windows wording) / `quota exceeded`
 * / `invalid gzip` are here for a different reason: the signature is verified
 * BEFORE extraction, so bytes that reach `invalid gzip header` are authentic and
 * a re-download returns the same ones. A retry there costs the customer a second
 * full download and buys nothing.
 *
 * ⛔ THE FILESYSTEM MEMBERS ARE THE ONES THE ALLOWLIST'S TEXT TERMS WOULD
 * OTHERWISE CATCH, and every one of them is deterministic:
 *   • `cross-device` — EXDEV. The mount topology is identical on attempt 2. It
 *     is also the DANGEROUS one: read `install_inner`
 *     (tauri-plugin-updater-2.10.1/src/updater.rs:1254-1303) — the live bundle
 *     is renamed into a `TempDir` BEFORE the final rename, and if that final
 *     rename fails both `TempDir`s drop and delete the only copy of the app. So
 *     a retry there runs against a partially-dismantled install for no possible
 *     gain.
 *   • `no such file or directory` — a missing path does not appear on a retry,
 *     and on macOS it is the SIGNATURE of the case above: after a failed final
 *     rename `extract_path` is gone, so attempt 2 reports ENOENT about nothing.
 *   • `read-only file system` — the volume does not become writable.
 */
const NEVER_RETRY_INSTALL =
  /signature|minisign|checksum|integrity|verif(?:y|ied|ication)|base64|invalid (?:last )?symbol|invalid (?:padding|encoding)|invalid input length|untrusted|public ?key|pubkey|no space left|not enough space|quota exceeded|invalid gzip|not supported|unsupported|cross-device|no such file or directory|read-only file system/;

/**
 * Classes where a SECOND attempt plausibly succeeds. An allowlist, so anything
 * unrecognised does NOT retry — the conservative direction, because a wrong
 * retry costs a second full download and, on macOS, a second admin prompt.
 *
 * ⛔ THE NETWORK HALF USED TO BE UNREACHABLE, WHICH IS THE CLASS U2 NAMES FIRST.
 * Its vocabulary was BROWSER-fetch vocabulary (`failed to fetch`, `load failed`,
 * `connection reset`, `dns`) — but the plugin does not download in the webview.
 * It downloads in Rust via reqwest (`.send()` at
 * tauri-plugin-updater-2.10.1/src/updater.rs:686, then `bytes_stream()` chunk
 * errors at :706), and `Error::Reqwest` is `#[error(transparent)]`, so ONLY
 * reqwest's own top line crosses the IPC — hyper's source chain ("connection
 * closed before message completed") is dropped. reqwest's `Display`
 * (reqwest-0.13.3/src/error.rs:236-284) can emit just five kinds plus
 * ` for url (…)`, and MEASURED 2026-09-12 none of them matched: a dropped
 * connection part-way through a ~26 MiB bundle rendered the owner's exact
 * sentence with NO retry. The three that a second attempt can clear are now
 * named; `builder error` and the status kinds deliberately are not.
 *
 * ⛔ `os error \d+` IS GONE, and it was a wildcard over every errno rather than
 * the "measured failure set" this comment used to claim. MEASURED: it retried
 * `Read-only file system (os error 30)`, `Not a directory (os error 20)`,
 * `File exists (os error 17)`, `Too many levels of symbolic links (os error 62)`
 * and `No such file or directory (os error 2)` — each deterministic, each
 * costing the customer a second full download, and the last one being the
 * macOS dismantled-install signature (see `NEVER_RETRY_INSTALL`). The errnos
 * that CAN clear are matched by their own OS text instead, which is also
 * platform-independent in a way an errno number is not (`os error 13` is EACCES
 * on Unix and ERROR_INVALID_DATA on Windows): `permission denied` /
 * `access is denied`, `not permitted`, the busy family, `interrupted`, and
 * Windows' `used by another process` sharing violation.
 *
 * The filesystem terms are now only what the vendored code can actually emit
 * (updater.rs:1217-1310 + tar-0.4.45/src/entry.rs:685): tar's
 * `failed to unpack `X` into `Y`` from the pre-backup extract loop — where the
 * live app has not been touched yet — and the AppleScript
 * `with administrator privileges` escalation whose one non-transparent message
 * is *"Failed to move the new app into place"* (updater.rs:1291-1294), reached
 * when the admin prompt is cancelled or the password is mistyped, which is
 * exactly a retryable event. `failed to rename|move|extract|remove` matched no
 * string the plugin or tar produces and were dropped with the wildcard.
 * `authentication failed` is the same event on Linux: `Error::AuthenticationFailed`
 * ("Authentication failed or was cancelled") is raised only when zenity AND
 * kdialog both fail to return a password (updater.rs:1148-1175).
 *
 * ⚠️ CAVEAT WORTH KNOWING BEFORE TRUSTING "the app is unchanged". In the
 * non-authorization branch the old bundle is renamed into a `TempDir` backup
 * BEFORE the final rename, and that `TempDir` drops (deleting the backup) if
 * the final rename fails. The two errors that final rename can realistically
 * emit — EXDEV and a vanished path — are now vetoed above rather than retried,
 * but the claim "the app is unchanged" is still not universally true on macOS,
 * and `SettingsView.tsx:1243` states it as though it were.
 */
const TRANSIENT_INSTALL_FAILURE =
  /permission denied|not permitted|access is denied|resource (?:temporarily unavailable|busy)|(?:device or resource|text file) busy|used by another process|broken pipe|interrupted|failed to unpack|move the new app into place|authentication failed|timed? out|timeout|network|connection (?:reset|refused|closed|aborted|failed|lost)|offline|dns|failed to fetch|fetch failed|error sending request|error decoding response body|request or response body error|error (?:following redirect|upgrading connection)|status:? (?:408|425|429|5\d\d)|temporarily/;

/**
 * U2 — is this failure worth ONE more `downloadAndInstall`?
 *
 * Pure + exported so the policy is testable without a Tauri runtime, and so the
 * "never a signature" rule is provable on the exact strings the plugin emits
 * rather than on a paraphrase of them.
 */
export function isRetryableInstallFailure(reason: string): boolean {
  const normalized = reason.toLowerCase();
  if (normalized === '') return false; // no text → no class → no retry
  if (NEVER_RETRY_INSTALL.test(normalized)) return false;
  return TRANSIENT_INSTALL_FAILURE.test(normalized);
}

/**
 * The one-line dev-log form. Metadata first, raw reason LAST — the reason is the
 * only unbounded part, so everything a reader scans for stays at a fixed offset.
 */
export function formatUpdateFailure(diag: UpdateInstallDiagnostic): string {
  const reason = diag.reason === '' ? '(the rejection carried no text)' : diag.reason;
  return (
    `[updater] install failed — stage=${diag.stage} attempt=${diag.attempt} ` +
    `${diag.fromVersion} → ${diag.toVersion} platform=${diag.platform} ` +
    `retrying=${diag.willRetry ? 'yes' : 'no'} reason: ${reason}`
  );
}

/**
 * Resolve a module ONCE per process and reuse it.
 *
 * The two sinks below stay LAZY for the reason in the file header (importing
 * `updater.ts` in a node unit test must not pull the Tauri plugin runtime or
 * the Sentry SDK), and they are memoized for two more:
 *
 *   • the retry pair reports TWO failures in the same tick, and re-entering the
 *     resolver twice per sink for that buys nothing; and
 *   • ⛔ MEASURED 2026-09-12 — two CONCURRENT `import()` of the same mocked
 *     module hand back two DIFFERENT namespace objects under Vitest: for the
 *     second in-flight import, `ns.captureException === theSpy` is `false`, so
 *     the second capture lands on a detached function and a guard counting
 *     captures across the retry pair under-counts by exactly one while both
 *     calls provably happened. That is an INSTRUMENT defect rather than a
 *     product one — production `import()` is registry-cached and returns one
 *     namespace — but an instrument that cannot count the second sink cannot
 *     guard it, and a guard that silently reads 1-of-2 is the shape of a
 *     vacuous one.
 *
 * A REJECTED import is deliberately not cached, so a later failure re-tries the
 * resolve instead of being permanently unrecordable.
 */
function memoizeImport<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load().catch((err: unknown) => {
      pending = null;
      throw err;
    });
    return pending;
  };
}

const importLogBuffer = memoizeImport(() => import('./log-buffer'));
const importSentry = memoizeImport(() => import('@sentry/browser'));

/**
 * U1 — record ONE install failure where BOTH the owner and a maintainer can
 * read it.
 *
 *   • the app's own dev log — `record('error', …)` lands in the in-app
 *     DevLogPanel and is flushed to `$APPDATA/recordings/dev-log.txt`
 *     IMMEDIATELY (log-buffer.ts:142 cancels the 1 s debounce for `error`), so
 *     it survives the relaunch this path is one step away from;
 *   • Sentry — `captureException` directly, because the crash-only integration
 *     set (`GlobalHandlers`, `Breadcrumbs` dropped) hooks `onerror` /
 *     `onunhandledrejection` and a CAUGHT rejection reaches neither. The
 *     privacy contract is unaffected: `scrubEvent` is wired as `beforeSend` on
 *     the singleton client (telemetry.ts:114) and applies to every capture,
 *     and with telemetry opted out there is no client and this is a no-op.
 *
 * Both imports are LAZY, matching this module's stated convention (see the file
 * header): importing `updater.ts` in a node unit test must not pull the Tauri
 * plugin runtime or the Sentry SDK.
 *
 * Never throws and never rethrows. A diagnostic that can break the thing it is
 * diagnosing is worse than no diagnostic — and the two sinks are independent,
 * so one being unavailable must not cost the other.
 */
export async function recordUpdateFailure(diag: UpdateInstallDiagnostic): Promise<void> {
  const line = formatUpdateFailure(diag);
  try {
    const { record } = await importLogBuffer();
    record('error', [line]);
  } catch {
    /* best-effort: Sentry below is the second, independent sink */
  }
  // ⛔ A SUCCESSFUL UPDATE USED TO MINT AN `error` SENTRY EVENT. `report` runs
  // inside `attemptDownload`'s catch, before the outcome is known, so a first
  // attempt that failed and a second that SUCCEEDED left an
  // `UpdateInstallFailure` fingerprinted `['update-install-failed','download']`
  // behind it, with nothing to retract it. Combined with the pair on a genuinely
  // failed retry, the issue's event count equalled neither the number of
  // failures nor the number of affected customers — and that count is exactly
  // what the owner's *"i see it very often"* has to be checked against.
  //
  // The dev-log line above is the DIAGNOSTIC and is written either way (it says
  // `retrying=yes`, which is the honest thing and is how a maintainer learns the
  // retry fired at all). Sentry is the FREQUENCY signal, so it gets one event
  // per user-visible failure: `willRetry` means the customer has not been told
  // anything yet and may never be.
  if (diag.willRetry) return;
  try {
    const Sentry = await importSentry();
    const captured = new Error(line);
    captured.name = 'UpdateInstallFailure';
    Sentry.captureException(captured, {
      level: 'error',
      // Group by the CALL that failed, not by the reason text: an `os error 13`
      // carries a machine-specific path and would otherwise mint a fresh Sentry
      // issue per customer, hiding the frequency the owner is reporting.
      fingerprint: ['update-install-failed', diag.stage],
      tags: {
        update_stage: diag.stage,
        update_attempt: String(diag.attempt),
        update_from: diag.fromVersion,
        update_to: diag.toVersion,
        update_platform: diag.platform,
      },
      contexts: { update: { ...diag } },
    });
  } catch {
    /* telemetry may be opted out, unconfigured, or absent — never fatal */
  }
}

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
  /**
   * U1 — where an install failure is recorded. Defaults to
   * {@link recordUpdateFailure} (dev log + Sentry), which is what production
   * uses; a test injects a spy to read the diagnostic synchronously.
   *
   * ⚠️ Optional, and the DEFAULT is the production path on purpose: a
   * verification-only sink would prove a different proposition than the one
   * that matters, so the guard that drives the banner end-to-end deliberately
   * does NOT inject and asserts against the real dev log.
   */
  onInstallFailure?: (diagnostic: UpdateInstallDiagnostic) => void;
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
    install: async (onProgress, hooks) => {
      const identity = {
        fromVersion: offered.currentVersion,
        toVersion: offered.version,
        platform: updatePlatformLabel(),
      };
      // ⚠️ FIRE AND FORGET, AND A DELIBERATE AWAIT WAS TRIED AND REMOVED. The
      // worry was real-sounding: `recordUpdateFailure` awaits a lazy `import()`
      // before it calls `record()`, and on the retry-that-SUCCEEDS path the next
      // thing that happens is `deps.relaunch()` replacing the process — so
      // attempt 1's line, the only evidence of how often the retry actually
      // WORKS, looked losable. MEASURED 2026-09-12: it is not. `./log-buffer` is
      // a STATIC import at main.tsx:4, so it is in the module registry from boot
      // and `importLogBuffer()` settles in one microtask; and between the report
      // and the relaunch sits attempt 2's entire `downloadAndInstall`, which is
      // a full bundle download. An `await settleReports(pending)` here was
      // written, and its guard read GREEN when the await was deleted — i.e. it
      // guarded nothing, and the 2 s timeout and timer it needed were complexity
      // bought for a race that does not occur. The ordering is still PINNED, in
      // update-banner-error.test.tsx, as a property rather than as a mechanism.
      const report =
        deps.onInstallFailure ??
        ((diagnostic: UpdateInstallDiagnostic): void => {
          void recordUpdateFailure(diagnostic);
        });

      /**
       * ONE `downloadAndInstall`. Resolves `null` on success, or the diagnostic
       * it has ALREADY reported on failure.
       *
       * Reporting here rather than at the throw is deliberate: the retried
       * first attempt reaches the log too, and the PAIR is what tells a
       * maintainer the retry fired and what it was retrying. `contentLength` /
       * `downloaded` are per-attempt locals so the second attempt's progress
       * starts from 0 instead of resuming a fraction that already read 100%.
       */
      const attemptDownload = async (
        attempt: number,
        firstReason?: string,
      ): Promise<UpdateInstallDiagnostic | null> => {
        let contentLength = 0;
        let downloaded = 0;
        try {
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
          return null;
        } catch (e) {
          const reason = rawUpdateFailureReason(e);
          const diagnostic: UpdateInstallDiagnostic = {
            ...identity,
            stage: 'download',
            reason,
            attempt,
            willRetry: attempt === 1 && isRetryableInstallFailure(reason),
            ...(firstReason === undefined ? {} : { firstReason }),
          };
          report(diagnostic);
          return diagnostic;
        }
      };

      // U2 — EXACTLY ONE retry, expressed as two calls rather than a loop so
      // "never twice" is a property of the shape and not of a bound. "Often"
      // is a frequency claim and this path had no retry at all, while the
      // measured failure set is dominated by classes a second attempt can
      // clear (a cancelled admin prompt, a busy file, a dropped connection).
      const first = await attemptDownload(1);
      if (first !== null) {
        if (!first.willRetry) throw new UpdateInstallError(first, 1);
        hooks?.onRetry?.(2, first.reason);
        const second = await attemptDownload(2, first.reason);
        if (second !== null) throw new UpdateInstallError(second, 2);
      }

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
      if (deps.needsManualRelaunch?.() ?? true) {
        try {
          await deps.relaunch();
        } catch (e) {
          // ⛔ NOT RETRIED, AND NOT THE SAME FAILURE. The bundle is already
          // installed; re-running `downloadAndInstall` would re-download and
          // re-replace a build that is on disk. This is the case that used to
          // render "Update couldn't be installed" about an update that WAS
          // installed — the stage is what lets the banner say so instead.
          const diagnostic: UpdateInstallDiagnostic = {
            ...identity,
            stage: 'relaunch',
            reason: rawUpdateFailureReason(e),
            attempt: 1,
            willRetry: false,
          };
          // Reported, not kept: nothing relaunches after this, and the throw is
          // what the banner renders.
          report(diagnostic);
          throw new UpdateInstallError(diagnostic, 1);
        }
      }
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
  // ⛔ AN UNATTENDED INSTALL OF A `downloadOnly` UPDATE IS GUARANTEED TO FAIL.
  // Both download-only closures exist precisely to "never silently no-op" and
  // reject on sight (`checkForUpdateVerbose`'s `!canInstall` branch and
  // `checkManifestVerbose`), and this function never consulted the flag — so it
  // called an `install()` that could only throw, swallowed it below, and
  // recorded nothing. The banner and Settings both check it; this was the one
  // caller that did not, and the manifest fallback that produces such an update
  // is reached exactly when the plugin is unavailable, i.e. on the machines most
  // likely to be there.
  if (update.downloadOnly === true) {
    deps.onOffered(update);
    return 'banner';
  }
  if (
    shouldAutoInstall({
      autoUpdate: deps.autoUpdate(),
      sessionRunning: await deps.sessionRunning(),
    })
  ) {
    try {
      await update.install();
      return 'installed';
    } catch (e) {
      // ⛔ A FAILED RELAUNCH IS TERMINAL, NOT A REASON TO TRY AGAIN IN SIX HOURS.
      // The bundle IS installed; the process is simply still the old one, so the
      // next `check()` offers the same update, `shouldAutoInstall` is still true,
      // and this ran the whole install again — a second ~26 MiB download and a
      // second pass through `install_inner`'s rename window (which, per
      // `NEVER_RETRY_INSTALL`, can leave no app at all) against a build that was
      // already updated, every six hours, forever. Reporting 'installed' is both
      // the truth and what makes `startUpdateChecks` stop the loop.
      //
      // ⚠️ It also means no banner, and the customer is not told to quit and
      // reopen. The alternative — offering a banner whose Install re-runs that
      // window — is worse, and the honest fix (a "quit and reopen" notice for
      // the UNATTENDED path) needs a surface this function does not own:
      // `onOffered` takes an `AvailableUpdate`, and its caller is App.tsx.
      if (e instanceof UpdateInstallError && e.stage === 'relaunch') return 'installed';
      // Otherwise fall through to the banner. ⚠️ Swallowing here USED TO MAKE
      // THE UNATTENDED FAILURE COMPLETELY INVISIBLE — no UI, no log, and the
      // customer just saw the banner reappear with no hint that an install had
      // been tried and failed. Every rejection the installable closure throws is
      // now reported (dev log, plus Sentry for the attempt the customer sees)
      // BEFORE it is thrown, so it is on record. The catch adds no reporting of
      // its own on purpose: with the `downloadOnly` call above removed, the only
      // rejections that reach here without one are from a caller-supplied
      // closure, and an update check must never be able to break the app it is
      // checking.
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
