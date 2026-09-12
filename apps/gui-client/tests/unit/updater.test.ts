// V-243 — unit tests for the in-app Tauri-updater flow. Deps are
// injected (fake check/relaunch + a fake Update whose downloadAndInstall
// drives the progress event sequence), so this runs in plain node with
// no Tauri runtime. The fakes return Promises explicitly (rather than
// `async () =>` with no await) to satisfy @typescript-eslint/require-await.

import { describe, expect, it, vi } from 'vitest';
import type { Update } from '@tauri-apps/plugin-updater';
import {
  checkForUpdate,
  formatUpdateFailure,
  isNewerVersion,
  isRetryableInstallFailure,
  rawUpdateFailureReason,
  redactUpdateReason,
  runUpdateCycle,
  UpdateInstallError,
  updatePlatformLabel,
  type AvailableUpdate,
  type UpdateCycleDeps,
  type UpdateInstallDiagnostic,
  type UpdaterDeps,
} from '../../src/lib/updater';

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
 * ⛔ A BARE STRING, WHICH IS THE REAL REJECTION SHAPE — and the single reason
 * this file disables `prefer-promise-reject-errors`. Traced 2026-09-12: the
 * plugin's `Error` serializes as `serializer.serialize_str(self.to_string())`
 * (tauri-plugin-updater-2.10.1/src/error.rs), the IPC response is
 * `application/json` so `response.json()` yields a string, and
 * `__TAURI_INTERNALS__.invoke` rejects with that value verbatim. A fixture that
 * rejected with `new Error(...)` would exercise a shape the real updater never
 * produces and would leave `rawUpdateFailureReason`'s string branch — the one
 * the owner's failure actually takes — untested.
 */
function rejectLikeThePlugin(text: string): Promise<never> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- see above: the plugin rejects with a bare string, not an Error.
  return Promise.reject(text);
}

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
      onInstallFailure: () => undefined,
    };
    const upd = await checkForUpdate(deps);
    // The raw text still reaches the rejection: `UpdateInstallError.message` IS
    // the plugin's reason, which is what keeps this assertion meaning what it
    // said before the error type existed.
    await expect(upd!.install()).rejects.toThrow(/signature/);
    expect(relaunch).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// U1/U2 (owner 2026-09-12) — the install failure's diagnostic + the retry gate.
//
// MUTATIONS RUN 2026-09-12, each restored and verified byte-identical by sha256
// against a snapshot (not by eye). Counts are the observed ones, measured over
// this file + update-banner-error.test.tsx together (29 tests):
//   • `isRetryableInstallFailure` → `return !/signature/.test(normalized)` —
//     the denylist U2 forbids → 3 failed | 26 passed: the two policy arms here
//     plus the banner's minisign arm.
//   • the retry pair in the install closure → a single `attemptDownload(1)`
//     → 4 failed | 25 passed.
//   • `report(diagnostic)` deleted from `attemptDownload`'s catch
//     → 4 failed | 25 passed.
// ─────────────────────────────────────────────────────────────────────────────

describe('U2 isRetryableInstallFailure — an allowlist, never "unless it says signature"', () => {
  it('⛔ NEVER retries a verification failure, including the two that do not contain the word "signature"', () => {
    // The first three name a signature. The last two do NOT, and they are the
    // whole reason this is not a denylist: measured against the vendored
    // tauri-plugin-updater 2.10.1, `minisign_verify::Error::InvalidEncoding`
    // and `Error::Base64(DecodeError)` Display like this, and a gate phrased
    // "retry unless the message names a signature" would retry a SIGNATURE
    // failure — the one thing U2 forbids.
    for (const reason of [
      'The signature verification failed',
      'The signature was created with a different key than the one provided',
      'Unexpected signature algorithm',
      'Invalid encoding in minisign data',
      'Invalid symbol 33, offset 5.',
    ]) {
      expect(isRetryableInstallFailure(reason), reason).toBe(false);
    }
  });

  it('retries the measured transient classes — filesystem, admin prompt, network, timeout', () => {
    for (const reason of [
      'Permission denied (os error 13)',
      'Operation not permitted (os error 1)',
      'failed to unpack `Driftstack.app` into `/var/folders/x/tauri_updated_app`',
      'Failed to move the new app into place',
      'Download request failed with status: 503 Service Unavailable',
      'operation timed out',
      // ⛔ THE REQWEST SET, WHICH THE ALLOWLIST USED TO MISS ENTIRELY — U2 names
      // network first and only IO had landed. The plugin does NOT download in
      // the webview: `.send()` at tauri-plugin-updater-2.10.1/src/updater.rs:686
      // and the `bytes_stream()` chunk read at :706 are reqwest, whose
      // `Error::Reqwest` is `#[error(transparent)]`, so ONLY reqwest's own top
      // line crosses the IPC — the browser vocabulary the allowlist carried
      // (`failed to fetch`, `load failed`, `connection reset`, `dns`) can never
      // match it, and hyper's source chain is dropped. These four are the kinds
      // reqwest's `Display` can emit for a download
      // (reqwest-0.13.3/src/error.rs:236-284), and each one meant a dropped
      // connection part-way through ~26 MiB rendered the owner's exact sentence
      // with no retry at all.
      'error sending request for url (https://objects.githubusercontent.com/x)',
      'error decoding response body for url (https://objects.githubusercontent.com/x)',
      'request or response body error for url (https://objects.githubusercontent.com/x)',
      'error following redirect for url (https://github.com/x)',
      // Linux's half of the cancelled-credential-prompt case: raised only when
      // zenity AND kdialog both fail to return a password (updater.rs:1148-1175).
      // The comment claimed this class was covered; measured, it was not.
      'Authentication failed or was cancelled',
      // Windows' sharing violation — the analogue of ETXTBSY, and exactly the
      // "something still holds the file" case a second attempt clears.
      'The process cannot access the file because it is being used by another process. (os error 32)',
    ]) {
      expect(isRetryableInstallFailure(reason), reason).toBe(true);
    }
  });

  it('does NOT retry what a second identical attempt provably cannot fix, nor an unrecognised class', () => {
    for (const reason of [
      'No space left on device (os error 28)', // a retry costs a second full download
      'There is not enough space on the disk. (os error 112)', // the Windows wording
      'invalid gzip header', // signature already verified → same bytes come back
      'Download request failed with status: 403 Forbidden', // deterministic
      'resource id 7 is not valid', // Error::Tauri, a stale rid
      'something nobody has classified yet',
      '', // no text → no class → no retry
      // ⛔ MOVED OFF THE RETRY LIST, DELIBERATELY. These were retried by the bare
      // `os error \d+` wildcard the allowlist used to open with — which the
      // comment beside it called "the measured macOS `install_inner` failure
      // set" while in fact matching every errno on every platform. Each one is
      // deterministic, so a retry buys a second full download and nothing else:
      'Read-only file system (os error 30)',
      'Not a directory (os error 20)',
      'File exists (os error 17)',
      'Too many levels of symbolic links (os error 62)',
      // …and these two are the DANGEROUS pair. `install_inner` renames the live
      // bundle into a `TempDir` BEFORE the final rename
      // (tauri-plugin-updater-2.10.1/src/updater.rs:1254-1302), and both
      // `TempDir`s drop — deleting the only copy of the app — if that final
      // rename fails. EXDEV cannot clear (the mount topology is the same on
      // attempt 2), and ENOENT is the SIGNATURE of that case: `extract_path` is
      // already gone, so attempt 2 reports "No such file or directory" about
      // nothing. Retrying either runs against a dismantled install for no gain.
      'Invalid cross-device link (os error 18)',
      'No such file or directory (os error 2)',
    ]) {
      expect(isRetryableInstallFailure(reason), reason).toBe(false);
    }
  });

  it('⛔ the veto is checked FIRST, and that order is what survives a widened allowlist', () => {
    // ⛔ THE VETO'S VERIFICATION HALF WAS VACUOUS AND READ GREEN. Deleting
    // `signature|minisign|…|invalid (?:last )?symbol|…` from NEVER_RETRY_INSTALL
    // left every arm above passing, because the five verification strings return
    // false via the ALLOWLIST not matching them rather than via the veto vetoing.
    // So the arm titled "NEVER retries a verification failure" and the source's
    // "Checked FIRST, and that order is the whole design" were both true by
    // accident, and the veto could only be observed on a string that matches
    // BOTH lists.
    //
    // ⚠️ THESE STRINGS ARE CONSTRUCTED, and that is the point rather than a
    // weakness: no single string the vendored crates emit today sits in the
    // intersection, so the property is unobservable on real output. What the
    // veto exists for is the FUTURE widening of the allowlist — which this very
    // change did twice (reqwest's kinds, `authentication failed`), and whose
    // strings end in ` for url (<the release-asset URL>)`, text the product does
    // not control. Each string below pairs a real verification Display with a
    // real transient Display; MEASURED, each flips to `true` the moment the
    // veto's verification half is removed.
    for (const reason of [
      'failed to unpack `x`: The signature verification failed',
      'Invalid encoding in minisign data (os error 13): permission denied',
      'error sending request for url (https://h/p?X-Amz-Signature=deadbeef)',
      'Invalid last symbol 61, offset 42. — connection reset',
      // The same property for the filesystem members the veto gained. On their
      // own they are defence-in-depth — nothing in the allowlist matches them
      // today, so DELETING them from the veto reads green — and this is the one
      // place their presence is observable. They are the deterministic and (for
      // the first two) DANGEROUS cases: a retry there runs against an install
      // `install_inner` has already dismantled.
      'Invalid cross-device link (os error 18): permission denied',
      'No such file or directory (os error 2) — connection reset',
      'Read-only file system (os error 30): operation not permitted',
      'There is not enough space on the disk. (os error 112): resource busy',
    ]) {
      expect(isRetryableInstallFailure(reason), reason).toBe(false);
    }
    // The positive control in the same breath: strip the vetoed token and the
    // same strings ARE retryable, so every string above is being vetoed rather
    // than merely unmatched.
    for (const reason of [
      'failed to unpack `x`: it went wrong',
      '(os error 13): permission denied',
      'error sending request for url (https://h/p?[redacted])',
      'offset 42. — connection reset',
      'Invalid link (os error 18): permission denied',
      'A path (os error 2) — connection reset',
      'Some file system (os error 30): operation not permitted',
      'There is not much room on the disk. (os error 112): resource busy',
    ]) {
      expect(isRetryableInstallFailure(reason), reason).toBe(true);
    }
  });
});

describe('U1 rawUpdateFailureReason — the rejection is usually a bare string', () => {
  it('reads the plugin string, an Error, an UpdateInstallError, and degrades safely', () => {
    // ⛔ THE BARE STRING IS THE REAL SHAPE. The plugin's `Error` serializes as
    // `serialize_str(self.to_string())`, the IPC response is JSON, and `invoke`
    // rejects with the parsed value verbatim — so `e instanceof Error` is FALSE
    // for a real macOS install failure, and a reader that only handles `Error`
    // gets an empty reason on exactly the path that matters.
    expect(rawUpdateFailureReason('Permission denied (os error 13)')).toBe(
      'Permission denied (os error 13)',
    );
    expect(rawUpdateFailureReason(new Error(' spawn helper ENOENT '))).toBe('spawn helper ENOENT');
    const diag: UpdateInstallDiagnostic = {
      stage: 'download',
      reason: 'Permission denied (os error 13)',
      attempt: 2,
      willRetry: false,
      fromVersion: '0.1.50',
      toVersion: '0.1.51',
      platform: 'MacIntel',
    };
    expect(rawUpdateFailureReason(new UpdateInstallError(diag, 2))).toBe(
      'Permission denied (os error 13)',
    );
    expect(rawUpdateFailureReason(null)).toBe('');
    expect(rawUpdateFailureReason(undefined)).toBe('');
    expect(rawUpdateFailureReason({ message: 'object-shaped' })).toBe('object-shaped');
    // ⛔ NEVER `String(error)`. The source argues this at length and nothing
    // pinned it: an object with no `message` must come back EMPTY, because
    // "[object Object]" reads as a real reason on a customer's screen and in a
    // dev log, and sends the reader after it. `formatUpdateFailure` says "(the
    // rejection carried no text)" for the empty case, which is the truth.
    expect(rawUpdateFailureReason({ code: 13 })).toBe('');
    expect(rawUpdateFailureReason(Symbol('nope'))).toBe('');
  });

  it('⛔ strips the query string out of any URL the reason cites — it carries a live credential', () => {
    // MEASURED 2026-09-12 with `curl -I -L` on the real release asset: GitHub
    // 302s to release-assets.githubusercontent.com with an Azure SAS query
    // carrying `sig=<signature>` and `jwt=<bearer>`. reqwest appends
    // ` for url (<that>)` to every send/body/redirect error
    // (reqwest-0.13.3/src/error.rs:279-281), so on the commonest download
    // failure the reason IS a credential — and this area sends the reason to
    // Sentry, to $APPDATA/recordings/dev-log.txt, and to the clipboard.
    // `scrubText` does not save us: its param list (telemetry.ts:250-262) has
    // `token`, `secret` and `signature` but neither `sig` nor `jwt`.
    const live =
      'error sending request for url (https://release-assets.githubusercontent.com/ghpra/1227137202/d8e08a16?sp=r&sv=2018-11-09&se=2026-09-12T13%3A37%3A52Z&sig=7GLePhCRf%2BEs7E%2BmYgN0dCupKwCsDMz8l0ICbeOYggE%3D&jwt=eyJ0eXAiOiJKV1QifQ.p.s)';
    const redacted = redactUpdateReason(live);
    expect(redacted).not.toMatch(/\bsig=/);
    expect(redacted).not.toMatch(/\bjwt=/);
    // Still diagnostic: which CDN served which asset survives.
    expect(redacted).toContain(
      'https://release-assets.githubusercontent.com/ghpra/1227137202/d8e08a16',
    );
    expect(redacted).toContain('error sending request');
    // It is the ONE choke point, so the exported reader agrees with it.
    expect(rawUpdateFailureReason(live)).toBe(redacted);

    // ⚠️ IDEMPOTENT, and the first implementation was NOT — `?<redacted>` used
    // characters the URL class excludes, so a second pass appended a second
    // marker. The source comment claimed idempotence the code did not have.
    expect(redactUpdateReason(redacted)).toBe(redacted);

    // …and a no-op for every reason that cites no URL, which is most of them.
    for (const plain of [
      'Permission denied (os error 13)',
      'failed to unpack `Driftstack.app` into `/var/folders/x/tauri_updated_app`',
      'error following redirect for url (https://github.com/a/b/releases)',
      '',
    ]) {
      expect(redactUpdateReason(plain), plain).toBe(plain);
    }
  });

  it('updatePlatformLabel reports a real value, and falls back to the UA rather than to nothing', () => {
    // ⛔ THE EXISTING PLATFORM ASSERTIONS WERE VACUOUS: `expect(log).toContain(
    // 'platform=')` matches `formatUpdateFailure`'s own format string whatever
    // the value is, so a build whose label came back EMPTY shipped clean —
    // measured by mutating this function to `return ''` and watching every arm
    // stay green. U1 requires the platform in the record so a Windows report is
    // not read as a Mac one.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const stub = (platform: string, userAgent: string): void => {
      Object.defineProperty(globalThis, 'navigator', {
        value: { platform, userAgent },
        configurable: true,
      });
    };
    try {
      stub('MacIntel', 'Mozilla/5.0 (Macintosh)');
      expect(updatePlatformLabel()).toBe('MacIntel');
      // `navigator.platform` is deprecated and some WebViews return ''. The UA
      // still names the OS, and "unknown" is strictly worse than a UA string.
      stub('', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
      expect(updatePlatformLabel()).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
      stub('', '');
      expect(updatePlatformLabel()).toBe('unknown');
    } finally {
      if (original === undefined) {
        delete (globalThis as Record<string, unknown>).navigator;
      } else {
        Object.defineProperty(globalThis, 'navigator', original);
      }
    }
  });

  it('the dev-log line carries the reason, the stage, the version pair and the platform', () => {
    const line = formatUpdateFailure({
      stage: 'relaunch',
      reason: 'process.restart not allowed',
      attempt: 1,
      willRetry: false,
      fromVersion: '0.1.50',
      toVersion: '0.1.51',
      platform: 'MacIntel',
    });
    expect(line).toContain('stage=relaunch');
    expect(line).toContain('attempt=1');
    expect(line).toContain('0.1.50 → 0.1.51');
    expect(line).toContain('platform=MacIntel');
    expect(line).toContain('retrying=no');
    expect(line).toContain('reason: process.restart not allowed');
    // An empty rejection must still say something a reader can act on rather
    // than ending the line at "reason:".
    expect(
      formatUpdateFailure({
        stage: 'unknown',
        reason: '',
        attempt: 1,
        willRetry: false,
        fromVersion: '0.1.50',
        toVersion: '0.1.51',
        platform: 'MacIntel',
      }),
    ).toContain('reason: (the rejection carried no text)');
  });
});

describe('U1/U2 the install closure records the failure and retries exactly once', () => {
  /** `checkForUpdate` over a fake plugin Update, with the diagnostics captured. */
  async function harness(over: {
    downloadAndInstall: () => Promise<void>;
    relaunch?: () => Promise<void>;
  }): Promise<{
    install: (h?: { onRetry?: (attempt: number, reason: string) => void }) => Promise<void>;
    reports: UpdateInstallDiagnostic[];
    relaunch: ReturnType<typeof vi.fn>;
  }> {
    const reports: UpdateInstallDiagnostic[] = [];
    const relaunch = vi.fn(over.relaunch ?? noopRelaunch);
    const upd = await checkForUpdate({
      check: () => Promise.resolve(fakeUpdate({ downloadAndInstall: over.downloadAndInstall })),
      currentVersion,
      canSelfInstall,
      relaunch,
      needsManualRelaunch: () => true,
      onInstallFailure: (d) => reports.push(d),
    });
    if (upd === null) throw new Error('fixture did not offer an update');
    return { install: (h) => upd.install(undefined, h), reports, relaunch };
  }

  it('CRITICAL an os error 13 is retried EXACTLY once, and BOTH attempts are reported', async () => {
    const downloadAndInstall = vi.fn(() => rejectLikeThePlugin('Permission denied (os error 13)'));
    const { install, reports, relaunch } = await harness({ downloadAndInstall });
    const onRetry = vi.fn();

    const thrown = await install({ onRetry }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(UpdateInstallError);
    const installError = thrown as UpdateInstallError;
    expect(installError.attempts).toBe(2);
    expect(installError.firstReason).toBe('Permission denied (os error 13)');

    expect(downloadAndInstall, 'exactly one retry — never two').toHaveBeenCalledTimes(2);
    // The PAIR is what tells a maintainer the retry fired and what it retried.
    expect(reports.map((r) => [r.attempt, r.willRetry, r.stage])).toEqual([
      [1, true, 'download'],
      [2, false, 'download'],
    ]);
    expect(reports[0]?.reason).toBe('Permission denied (os error 13)');
    expect(reports[0]?.fromVersion).toBe('0.0.1');
    expect(reports[0]?.toVersion).toBe('0.1.0');
    // ⛔ ATTEMPT 2 CARRIES ATTEMPT 1'S REASON, because attempt 2's own is often
    // an artefact of attempt 1's damage rather than the cause — on the macOS
    // non-authorization path the live bundle has already been moved out
    // (updater.rs:1255), so a second attempt reports ENOENT about nothing. The
    // error that reaches the banner carries it too, which is the only way the
    // customer's disclosure and Copy details can show the cause.
    expect(reports[0]?.firstReason, 'attempt 1 has no earlier attempt').toBeUndefined();
    expect(reports[1]?.firstReason).toBe('Permission denied (os error 13)');
    // U2 — visible, not silent.
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(2, 'Permission denied (os error 13)');
    expect(relaunch, 'a failed install never relaunches').not.toHaveBeenCalled();
  });

  it('⛔ a signature failure is reported ONCE and never retried', async () => {
    const downloadAndInstall = vi.fn(() =>
      rejectLikeThePlugin('The signature verification failed'),
    );
    const { install, reports } = await harness({ downloadAndInstall });
    const onRetry = vi.fn();

    const thrown = await install({ onRetry }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((thrown as Error).message).toMatch(/signature/);
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.willRetry).toBe(false);
    expect(onRetry).not.toHaveBeenCalled();
    // One attempt → nothing earlier to name, and the banner must not render a
    // "First attempt" block onto an empty string.
    expect((thrown as UpdateInstallError).attempts).toBe(1);
    expect((thrown as UpdateInstallError).firstReason).toBe('');
  });

  it('a retry that SUCCEEDS resolves, relaunches, and reports only the first attempt', async () => {
    // The positive control: without it, a closure that always rejected would
    // pass the two arms above identically.
    let calls = 0;
    const downloadAndInstall = vi.fn((): Promise<void> => {
      calls += 1;
      return calls === 1
        ? rejectLikeThePlugin('Permission denied (os error 13)')
        : Promise.resolve();
    });
    const { install, reports, relaunch } = await harness({ downloadAndInstall });

    await expect(install()).resolves.toBeUndefined();
    expect(downloadAndInstall).toHaveBeenCalledTimes(2);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.willRetry).toBe(true);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it('CRITICAL a failed RELAUNCH is stage=relaunch, is not retried, and the install is NOT re-run', async () => {
    // ⛔ The case whose message was a LIE. `relaunch()` is awaited in the same
    // `try` as `downloadAndInstall()`, and macOS always relaunches — so an
    // install that SUCCEEDED then failed to restart rendered "Update couldn't
    // be installed". The stage is what lets the banner say the true thing, and
    // re-downloading a bundle that is already on disk would be the wrong
    // recovery.
    const downloadAndInstall = vi.fn(() => Promise.resolve());
    const { install, reports } = await harness({
      downloadAndInstall,
      relaunch: () => rejectLikeThePlugin('process.restart not allowed'),
    });

    await expect(install()).rejects.toThrow(/process\.restart not allowed/);
    expect(downloadAndInstall, 'the bundle is already installed').toHaveBeenCalledTimes(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.stage).toBe('relaunch');
    expect(reports[0]?.willRetry).toBe(false);
  });
});

describe('runUpdateCycle — the two install decisions it used to get wrong', () => {
  function cycleDeps(over: Partial<UpdateCycleDeps> = {}): UpdateCycleDeps {
    return {
      check: vi.fn(() => Promise.resolve<AvailableUpdate | null>(null)),
      autoUpdate: vi.fn(() => true),
      sessionRunning: vi.fn(() => Promise.resolve(false)),
      onOffered: vi.fn(),
      ...over,
    };
  }

  it('⛔ NEVER installs a downloadOnly update — that call could only ever fail', async () => {
    // Both download-only closures reject on sight, on purpose ("never silently
    // no-op"). This function never consulted the flag, so on such an update it
    // called an `install()` that was GUARANTEED to throw, swallowed it in the
    // bare catch, and recorded nothing — and the manifest fallback that produces
    // one is reached exactly when the plugin is unavailable, i.e. on the machines
    // most likely to be there. The banner and Settings both check the flag; this
    // was the one caller that did not.
    const install = vi.fn(() => Promise.reject(new Error('installs manually')));
    const update: AvailableUpdate = {
      version: '0.1.19',
      currentVersion: '0.1.15',
      notes: null,
      downloadOnly: true,
      install,
    };
    const d = cycleDeps({ check: () => Promise.resolve(update) });

    expect(await runUpdateCycle(d)).toBe('banner');
    expect(install, 'an install that cannot work is not attempted').not.toHaveBeenCalled();
    expect(d.onOffered).toHaveBeenCalledWith(update);
    // The positive control: the same cycle DOES install an installable update,
    // so the arm above is about `downloadOnly` and not about the fixture.
    const installable = vi.fn(() => Promise.resolve());
    expect(
      await runUpdateCycle(
        cycleDeps({
          check: () =>
            Promise.resolve({
              version: '0.1.19',
              currentVersion: '0.1.15',
              notes: null,
              install: installable,
            }),
        }),
      ),
    ).toBe('installed');
    expect(installable).toHaveBeenCalledTimes(1);
  });

  it('CRITICAL a failed RELAUNCH is terminal — it must not re-install every six hours forever', async () => {
    // ⛔ The bundle IS installed; only the process is still the old one. So the
    // next check offered the same update, `shouldAutoInstall` was still true,
    // and this ran the whole install again — a second ~26 MiB download plus
    // another pass through `install_inner`'s rename window (which can leave no
    // app at all) against a build that was already updated, every six hours.
    // 'installed' is both the truth and what makes `startUpdateChecks` stop.
    const diag: UpdateInstallDiagnostic = {
      stage: 'relaunch',
      reason: 'process.restart not allowed',
      attempt: 1,
      willRetry: false,
      fromVersion: '0.1.15',
      toVersion: '0.1.19',
      platform: 'MacIntel',
    };
    const d = cycleDeps({
      check: () =>
        Promise.resolve({
          version: '0.1.19',
          currentVersion: '0.1.15',
          notes: null,
          install: vi.fn(() => Promise.reject(new UpdateInstallError(diag, 1))),
        }),
    });
    expect(await runUpdateCycle(d)).toBe('installed');
    expect(d.onOffered, 'no banner whose Install would re-run that window').not.toHaveBeenCalled();

    // The DOWNLOAD stage is the opposite and must still degrade into the banner:
    // nothing was installed, so offering it again is the right recovery.
    const downloadStage = cycleDeps({
      check: () =>
        Promise.resolve({
          version: '0.1.19',
          currentVersion: '0.1.15',
          notes: null,
          install: vi.fn(() =>
            Promise.reject(new UpdateInstallError({ ...diag, stage: 'download' }, 1)),
          ),
        }),
    });
    expect(await runUpdateCycle(downloadStage)).toBe('banner');
    expect(downloadStage.onOffered).toHaveBeenCalled();
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
