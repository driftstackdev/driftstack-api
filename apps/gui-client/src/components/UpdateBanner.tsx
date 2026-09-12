// V-243 — auto-update prompt. Rendered in the Shell when
// `checkForUpdate()` (src/lib/updater.ts) finds a newer signed bundle.
// Non-blocking: the customer chooses when to install (predictable for a
// tool they may be mid-session with) rather than a surprise restart.
// On install the bundle is downloaded + signature-verified + applied,
// then the app relaunches into the new version.
//
// U1–U3 (owner 2026-09-12: *"Update to 0.1.51 failed: Update couldn't be
// installed. Try again."* — *"often this happens! i see it very often"*):
//
//   U1 the real reason is no longer thrown away. The human sentence stays the
//      HEADLINE; the plugin's own text sits behind a disclosure with a Copy
//      details button, so the customer can read and forward it without a
//      devtools trip. See the long note at the top of lib/updater.ts for which
//      copy rule applies and why the one that bans reflecting error prose (the
//      REMOTE problem body) is not this.
//   U2 a transient download failure retries once, VISIBLY ("Retrying…") — the
//      retry itself lives in the install closure so all three callers (this
//      banner, Settings, and the unattended cycle) get it.
//   U3 a failed install is never a dead end: the release link renders beside
//      Retry, through the SAME element the `downloadOnly` platform uses.

import { useState } from 'react';
import { humanizeError } from '../lib/humanize-error';
import { writeClipboardText } from '../lib/clipboard';
import {
  RELEASES_URL,
  UpdateInstallError,
  rawUpdateFailureReason,
  recordUpdateFailure,
  updatePlatformLabel,
  type AvailableUpdate,
  type UpdateInstallStage,
} from '../lib/updater';

interface UpdateBannerProps {
  update: AvailableUpdate;
  onDismiss: () => void;
}

/**
 * U3 — the ONE release link, rendered in two situations:
 *
 *   • a `downloadOnly` platform, which can never install for itself; and
 *   • after a FAILED install, where "Retry" alone is a dead end whenever the
 *     failure is deterministic (a denied filesystem permission, an unverifiable
 *     bundle) and the customer still needs the version.
 *
 * Extracted rather than duplicated, per U3's "reuse it rather than writing a
 * second one": one element, one `data-testid`, one place to change. `tone` is
 * the only difference — beside Retry the release link is the secondary action,
 * where on a download-only platform it is the primary (and only) one.
 */
function DownloadReleaseLink({
  href,
  tone,
}: {
  href: string;
  tone: 'primary' | 'secondary';
}): JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={tone === 'primary' ? 'btn-primary' : 'btn-secondary'}
      data-testid="update-download"
    >
      Download
    </a>
  );
}

/** The complete error render for ONE rejection. */
interface UpdateFailureView {
  stage: UpdateInstallStage;
  /** The plugin's own text for the attempt that ended it, redacted. */
  reason: string;
  /** Attempt 1's text when there were two, else ''. */
  firstReason: string;
  /** 1, or 2 after the single automatic retry. */
  attempts: number;
  /** The customer-facing sentence — the headline. */
  sentence: string;
}

/**
 * ⛔ THE BANNER HAS TWO WAYS IN AND THEY HAVE TO SAY THE SAME THING. Until now
 * only the Install button could produce a failure, so the entire error render
 * lived in its catch. But the UNATTENDED cycle installs too — auto-update
 * defaults ON and App.tsx runs `runUpdateCycle` at startup and every 6 h — and
 * when THAT install failed, the cycle swallowed the rejection and handed
 * `onOffered` the same update, so the banner mounted at `phase:'idle'` and the
 * whole of what a customer could read was:
 *
 *     Update 0.1.52 available (current 0.1.51)  [Install & restart]  [Later]
 *
 * after two failed ~26 MiB attempts: no reason, no statement that anything had
 * been tried, no download link, and a primary button inviting attempts 3 and 4.
 * That is the SHIPPED DEFAULT path, and the likeliest generator of the owner's
 * *"i see it very often"* — the install fails in the background after every
 * release and the banner just keeps offering the update. MEASURED off the
 * running harness with Playwright 2026-09-12.
 *
 * The failure now travels on the update itself
 * ({@link AvailableUpdate.lastInstallFailure}) and BOTH entry points render it
 * through here, so the seeded banner and the clicked one share one sentence,
 * one disclosure and one set of actions by construction rather than by a second
 * copy that can drift.
 */
function failureState(e: unknown, version: string): UpdateFailureView {
  const installError = e instanceof UpdateInstallError ? e : null;
  const stage = installError?.stage ?? 'unknown';
  const attempts = installError?.attempts ?? 1;
  return {
    stage,
    reason: rawUpdateFailureReason(e),
    firstReason: installError?.firstReason ?? '',
    attempts,
    sentence:
      stage === 'relaunch'
        ? // ⛔ THE OLD MESSAGE WAS A LIE ON THIS PATH. `relaunch()` is awaited
          // inside the same `try` as `downloadAndInstall()`, and macOS always
          // relaunches — so an install that SUCCEEDED and then failed to restart
          // rendered "Update couldn't be installed", wrong in both halves. The
          // stage is what lets this say the true thing.
          `Update ${version} installed, but the app couldn't restart itself. Quit and reopen Driftstack.`
        : // ⚠️ "Try again." IS FALSE ONCE THE APP HAS ALREADY TRIED TWICE, and it
          // invites a third full download (plus, on macOS, another admin prompt)
          // for a failure that has now failed twice. The classifier stays shared
          // and untouched — a reason `humanizeError` can classify still gets its
          // own sentence.
          //
          // ⛔ THE RETRY CLAUSE WAS INSIDE THE FALLBACK ARGUMENT, WHICH IS THE ONE
          // PLACE IT COULD NEVER REACH THE CLASS THE RETRY WAS BUILT FOR.
          // `humanizeError(e, fallback)` returns `fallback` only when NO regex
          // matched, so "Driftstack already retried once." was reachable only for
          // an UNCLASSIFIED reason. reqwest's `error sending request` is
          // classified (the network arm) and IS retried, so two full ~26 MiB
          // attempts ended on *"Check your connection and try again."* — silent
          // about the retry and ending in the very "try again" this note calls
          // false, on the class the closure's own comment calls "the commonest
          // failure there is".
          //
          // So the clause is appended to WHATEVER sentence is shown, keyed on the
          // attempt count rather than on whether a regex happened to fire. The
          // unclassified string is unchanged byte-for-byte ("Update couldn't be
          // installed." + " Driftstack already retried once."), and a failure
          // that was never retried never gains it.
          attempts === 2
          ? `${humanizeError(e, "Update couldn't be installed.")} Driftstack already retried once.`
          : humanizeError(e, "Update couldn't be installed. Try again."),
  };
}

export function UpdateBanner({ update, onDismiss }: UpdateBannerProps): JSX.Element {
  // ⛔ 'retrying' WAS A PHASE AND IS NOW A FLAG. As a phase it REPLACED
  // 'installing', so the render dropped the live fraction for the whole second
  // attempt: `onProgress` kept firing and `setFraction` kept updating state
  // nothing displayed, and the customer watched a static "Retrying…" through a
  // second ~26 MiB download. That is precisely the "it just sat there" report the
  // visible retry exists to prevent (see UpdateInstallHooks.onRetry). A flag
  // keeps the progress phase intact and only changes the verb.
  //
  // ⚠️ THE SECOND HALF OF THIS NOTE USED TO CLAIM THE FLAG ALSO FIXED THE
  // NO-EXIT-ON-SUCCESS CASE. IT DOES NOT, MEASURED 2026-09-12 off the running
  // harness with `needsManualRelaunch: () => false` (the Windows configuration,
  // where the NSIS installer owns the restart so `install()` RESOLVES instead of
  // relaunching). There is no `setPhase` after the `try`, so the banner's
  // terminal state on a SUCCESSFUL Windows install is:
  //   • clean install  → "Update 0.1.52 available (current 0.1.51) Installing… 100%"
  //   • after a retry  → "…  Retrying… 100%"
  // both with NO "Later" button, i.e. still unable to be dismissed and still
  // headlined "available". The flag changed the VERB; "sat on Retrying… for
  // good" survives it. Left as-is deliberately here — it is the SUCCESS path and
  // a different proposition from the owner's install-failure row — and reported
  // rather than silently patched. The `relaunch() replaces the running process`
  // note inside `install()` below states that stay-in-the-installing-state
  // behaviour accurately.

  // ⚠️ THE UNATTENDED INSTALL'S FAILURE, WHEN THAT IS WHY THIS BANNER EXISTS.
  // `undefined` on an ordinary offer, and every state below then keeps its idle
  // value. Read in the lazy initializers rather than in an effect so the failure
  // is on screen in the FIRST paint: a frame of "Update 0.1.52 available ·
  // Install & restart" is the exact claim this seeding exists to stop making.
  const seeded =
    update.lastInstallFailure === undefined
      ? null
      : failureState(update.lastInstallFailure, update.version);
  const [phase, setPhase] = useState<'idle' | 'installing' | 'error'>(
    seeded === null ? 'idle' : 'error',
  );
  const [retried, setRetried] = useState(false);
  const [fraction, setFraction] = useState(0);
  const [error, setError] = useState<string | null>(seeded?.sentence ?? null);
  // U1 — the plugin's untouched text for the attempt that ended the install.
  // Empty when that rejection carried none; the disclosure then falls back to
  // attempt 1's reason, and is not rendered at all when neither exists rather
  // than opening onto nothing.
  const [reason, setReason] = useState(seeded?.reason ?? '');
  // ⛔ THE RETRY USED TO MAKE THE CUSTOMER-VISIBLE HALF LESS DIAGNOSABLE THAN THE
  // LOG. Only the LAST attempt's reason was disclosed and copied, and attempt 2's
  // reason is frequently an artefact of attempt 1's damage rather than the cause
  // — on the macOS non-authorization path the live bundle has already been moved
  // out (updater.rs:1255), so attempt 2 reports "No such file or directory
  // (os error 2)" about nothing, and THAT is what got pasted into an issue.
  const [firstReason, setFirstReason] = useState(seeded?.firstReason ?? '');
  const [attempts, setAttempts] = useState(seeded?.attempts ?? 1);
  const [stage, setStage] = useState<UpdateInstallStage>(seeded?.stage ?? 'unknown');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  /** What "Copy details" puts on the clipboard — the whole diagnostic, not just
   *  the reason, so a paste into an issue needs no follow-up questions. */
  const details = [
    `Driftstack update ${update.currentVersion} → ${update.version}`,
    `platform: ${updatePlatformLabel()}`,
    `stage: ${stage}`,
    `attempts: ${attempts}`,
    ...(firstReason === '' ? [] : [`first attempt: ${firstReason}`]),
    // The disclosure can now exist with an EMPTY attempt-2 reason (attempt 1's
    // survived it), and `reason: ` with nothing after it reads as a dropped
    // field rather than as a rejection that carried no text. Same words the dev
    // log uses for the same fact — see `formatUpdateFailure`.
    `reason: ${reason === '' ? '(the rejection carried no text)' : reason}`,
  ].join('\n');

  const copyDetails = (): void => {
    setCopyState('idle');
    void writeClipboardText(details).then(
      () => setCopyState('copied'),
      // A locked-down WKWebView can leave navigator.clipboard undefined; say so
      // rather than leaving a dead click, since the text is still selectable.
      () => setCopyState('failed'),
    );
  };

  async function install(): Promise<void> {
    setPhase('installing');
    setRetried(false);
    setError(null);
    setReason('');
    setFirstReason('');
    setAttempts(1);
    setStage('unknown');
    setCopyState('idle');
    setFraction(0);
    try {
      await update.install((f) => setFraction(f), {
        onRetry: (_attempt, firstAttemptReason) => {
          // U2 — visible, not silent. Progress resets because the retry is a
          // fresh download, and a bar left at 100% would claim otherwise; the
          // label switches verb but keeps showing the percentage.
          setFraction(0);
          setRetried(true);
          setFirstReason(firstAttemptReason);
        },
      });
      // relaunch() replaces the running process; we don't normally
      // reach here. If a platform returns instead of relaunching, the
      // banner simply stays in the (completed) installing state.
    } catch (e) {
      const failure = failureState(e, update.version);
      setPhase('error');
      setStage(failure.stage);
      setReason(failure.reason);
      setAttempts(failure.attempts);
      setError(failure.sentence);
      // Prefer the error's own copy — INCLUDING AN EMPTY ONE.
      //
      // ⛔ THE GUARD USED TO BE `installError.firstReason !== ''`, and that kept
      // an already-RECOVERED download error on a relaunch failure: attempt 1
      // drops the connection, `onRetry` sets firstReason, attempt 2 SUCCEEDS,
      // and `relaunch()` then rejects — whose diagnostic carries `firstReason:
      // ''` by construction. The stale one survived, so the disclosure labelled
      // a network error "First attempt" under a headline saying the update
      // INSTALLED, and Copy details read `attempts: 1` beside a `first attempt:`
      // line. MEASURED off the running harness 2026-09-12.
      //
      // A rejection that is NOT an UpdateInstallError carries no copy at all (a
      // caller-supplied closure may ignore `hooks` entirely), so there the
      // `onRetry` hook's value still stands.
      if (e instanceof UpdateInstallError) setFirstReason(failure.firstReason);
      // Anything that did NOT come through the installable closure in
      // lib/updater.ts has not been recorded yet — a `downloadOnly` platform's
      // deliberate reject, or a caller-supplied closure. A reason shown to the
      // customer that no log carries is the exact defect this row is about, so
      // the gap is closed here; the closure's own report is never duplicated.
      if (!(e instanceof UpdateInstallError)) {
        void recordUpdateFailure({
          stage: 'unknown',
          reason: failure.reason,
          attempt: 1,
          willRetry: false,
          fromVersion: update.currentVersion,
          toVersion: update.version,
          platform: updatePlatformLabel(),
        });
      }
    }
  }

  const busy = phase === 'installing';

  /**
   * ⛔ A RELAUNCH-STAGE FAILURE MUST OFFER NEITHER BUTTON, because both deny the
   * headline sitting right next to them — *"Update 0.1.51 installed, but the app
   * couldn't restart itself."*
   *
   *   • "Retry" called `update.install()` again, re-downloading the full bundle
   *     and re-running `install_inner` against an app that is ALREADY on the new
   *     version — including the window at
   *     tauri-plugin-updater-2.10.1/src/updater.rs:1255-1302 where the live
   *     bundle has been renamed into a `TempDir` that is deleted if the final
   *     rename fails. So the recovery for "it installed but did not restart"
   *     risked leaving no app at all, for no possible gain.
   *   • "Download" sent the customer to fetch a version already on their disk.
   *
   * U3's "never a dead end" is satisfied without either: the customer HAS the
   * version, and the headline tells them the one action that works. "Later"
   * remains, so the banner can still be dismissed.
   *
   * ⚠️ The closure's internal retry was already correct here (the relaunch stage
   * is never auto-retried); this is the BUTTON, which is a different proposition
   * and was asserted by nothing.
   */
  const installActionsApply = !(phase === 'error' && stage === 'relaunch');

  return (
    <div
      role="status"
      className={`flex justify-between gap-4 border-b bg-surface-raised px-4 py-2 text-sm ${
        phase === 'error'
          ? 'items-start border-status-error/30'
          : 'items-center border-surface-divider'
      }`}
    >
      <div className="min-w-0">
        {phase === 'error' ? (
          <>
            <span className="text-ink-secondary" data-testid="update-error-headline">
              {stage === 'relaunch' ? (
                <span className="text-status-error">{error}</span>
              ) : (
                <>
                  Update to {update.version} failed:{' '}
                  <span className="text-status-error">{error}</span>
                </>
              )}
            </span>
            {/* ⛔ EITHER REASON OPENS IT. Gated on `reason !== ''` alone, a
                TEXTLESS attempt 2 deleted the whole disclosure and took attempt
                1's perfectly good reason with it: the app was HOLDING
                "Permission denied (os error 13)" in `firstReason` while the only
                thing a person could read was "Update to 0.1.52 failed: Update
                couldn't be installed. Driftstack already retried once." — the
                owner's own sentence, regenerated, with a retry clause bolted on.
                A rejection carrying no text is not hypothetical:
                `formatUpdateFailure` has a case for it, and the plugin rejects
                with whatever the IPC decoded. MEASURED off the running harness
                2026-09-12. */}
            {reason !== '' || firstReason !== '' ? (
              <details className="mt-1" data-testid="update-error-details">
                <summary className="cursor-pointer text-xs text-ink-muted hover:text-ink-secondary">
                  What went wrong
                </summary>
                <div className="mt-1 flex items-start gap-2">
                  <div className="min-w-0 flex-1 space-y-1">
                    {firstReason !== '' ? (
                      <div className="min-w-0">
                        <span className="text-xs text-ink-muted">First attempt</span>
                        <code
                          className="mono block max-h-24 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-inset px-2 py-1 text-ink-secondary"
                          data-testid="update-error-first-reason"
                        >
                          {firstReason}
                        </code>
                      </div>
                    ) : null}
                    {/* …and the block that would be EMPTY is the one that is
                        dropped, rather than a labelled box opening onto nothing.
                        `attempts === 2` alone would render "Second attempt" over
                        an empty `<code>`. */}
                    {reason !== '' ? (
                      <div className="min-w-0">
                        {attempts === 2 ? (
                          <span className="text-xs text-ink-muted">Second attempt</span>
                        ) : null}
                        <code
                          className="mono block max-h-24 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-inset px-2 py-1 text-ink-secondary"
                          data-testid="update-error-reason"
                        >
                          {reason}
                        </code>
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="shrink-0 text-xs text-ink-muted hover:text-ink-secondary"
                    onClick={copyDetails}
                    data-testid="update-copy-details"
                  >
                    {copyState === 'copied'
                      ? 'Copied'
                      : copyState === 'failed'
                        ? "Couldn't copy"
                        : 'Copy details'}
                  </button>
                </div>
              </details>
            ) : null}
          </>
        ) : (
          <span className="text-ink-secondary">
            Update <span className="font-medium text-ink-primary">{update.version}</span> available{' '}
            <span className="text-ink-muted">(current {update.currentVersion})</span>
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {busy ? (
          <span className="section-label text-ink-muted" aria-live="polite">
            {`${retried ? 'Retrying' : 'Installing'}… ${Math.round(fraction * 100)}%`}
          </span>
        ) : (
          <>
            {update.downloadOnly === true ? (
              // This platform cannot install for itself (kept live for the day a
              // platform is granted check-without-install again). Offering
              // "Install & restart" here would be a button that cannot do what
              // it says, so send them to the release instead.
              <DownloadReleaseLink href={update.downloadUrl ?? RELEASES_URL} tone="primary" />
            ) : (
              <>
                {installActionsApply ? (
                  <>
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => void install()}
                      data-testid="update-install"
                    >
                      {phase === 'error' ? 'Retry' : 'Install & restart'}
                    </button>
                    {phase === 'error' ? (
                      <DownloadReleaseLink
                        href={update.downloadUrl ?? RELEASES_URL}
                        tone="secondary"
                      />
                    ) : null}
                  </>
                ) : null}
              </>
            )}
            <button
              type="button"
              className="text-ink-muted hover:text-ink-secondary"
              onClick={onDismiss}
              data-testid="update-dismiss"
            >
              Later
            </button>
          </>
        )}
      </div>
    </div>
  );
}
