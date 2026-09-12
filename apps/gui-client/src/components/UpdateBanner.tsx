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

export function UpdateBanner({ update, onDismiss }: UpdateBannerProps): JSX.Element {
  // ⛔ 'retrying' WAS A PHASE AND IS NOW A FLAG. As a phase it REPLACED
  // 'installing', so the render dropped the live fraction for the whole second
  // attempt: `onProgress` kept firing and `setFraction` kept updating state
  // nothing displayed, and the customer watched a static "Retrying…" through a
  // second ~26 MiB download. That is precisely the "it just sat there" report the
  // visible retry exists to prevent (see UpdateInstallHooks.onRetry). Worse, the
  // phase had no exit on success: `platformNeedsManualRelaunch()` is false on
  // Windows, so `install()` RESOLVES rather than relaunching, and the banner sat
  // on "Retrying…" for good. A flag keeps the progress phase intact and only
  // changes the verb.
  const [phase, setPhase] = useState<'idle' | 'installing' | 'error'>('idle');
  const [retried, setRetried] = useState(false);
  const [fraction, setFraction] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // U1 — the plugin's untouched text. Empty when the rejection carried none,
  // and the disclosure is then not rendered at all rather than opening onto
  // nothing.
  const [reason, setReason] = useState('');
  // ⛔ THE RETRY USED TO MAKE THE CUSTOMER-VISIBLE HALF LESS DIAGNOSABLE THAN THE
  // LOG. Only the LAST attempt's reason was disclosed and copied, and attempt 2's
  // reason is frequently an artefact of attempt 1's damage rather than the cause
  // — on the macOS non-authorization path the live bundle has already been moved
  // out (updater.rs:1255), so attempt 2 reports "No such file or directory
  // (os error 2)" about nothing, and THAT is what got pasted into an issue.
  const [firstReason, setFirstReason] = useState('');
  const [attempts, setAttempts] = useState(1);
  const [stage, setStage] = useState<UpdateInstallStage>('unknown');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  /** What "Copy details" puts on the clipboard — the whole diagnostic, not just
   *  the reason, so a paste into an issue needs no follow-up questions. */
  const details = [
    `Driftstack update ${update.currentVersion} → ${update.version}`,
    `platform: ${updatePlatformLabel()}`,
    `stage: ${stage}`,
    `attempts: ${attempts}`,
    ...(firstReason === '' ? [] : [`first attempt: ${firstReason}`]),
    `reason: ${reason}`,
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
      const raw = rawUpdateFailureReason(e);
      const installError = e instanceof UpdateInstallError ? e : null;
      const failedStage = installError?.stage ?? 'unknown';
      setPhase('error');
      setStage(failedStage);
      setReason(raw);
      setAttempts(installError?.attempts ?? 1);
      // Prefer the error's copy: a caller-supplied closure may ignore `hooks`
      // entirely, and the diagnostic carries it either way.
      if (installError !== null && installError.firstReason !== '') {
        setFirstReason(installError.firstReason);
      }
      setError(
        failedStage === 'relaunch'
          ? // ⛔ THE OLD MESSAGE WAS A LIE ON THIS PATH. `relaunch()` is awaited
            // inside the same `try` as `downloadAndInstall()`, and macOS always
            // relaunches — so an install that SUCCEEDED and then failed to
            // restart rendered "Update couldn't be installed", wrong in both
            // halves. The stage is what lets this say the true thing.
            `Update ${update.version} installed, but the app couldn't restart itself. Quit and reopen Driftstack.`
          : // ⚠️ "Try again." IS FALSE ONCE THE APP HAS ALREADY TRIED TWICE, and
            // it invites a third full download (plus, on macOS, another admin
            // prompt) for a failure that has now failed twice. Only the FALLBACK
            // changes — a reason `humanizeError` can classify still gets its own
            // sentence, and the classifier stays shared and untouched.
            humanizeError(
              e,
              installError?.attempts === 2
                ? "Update couldn't be installed. Driftstack already retried once."
                : "Update couldn't be installed. Try again.",
            ),
      );
      // Anything that did NOT come through the installable closure in
      // lib/updater.ts has not been recorded yet — a `downloadOnly` platform's
      // deliberate reject, or a caller-supplied closure. A reason shown to the
      // customer that no log carries is the exact defect this row is about, so
      // the gap is closed here; the closure's own report is never duplicated.
      if (!(e instanceof UpdateInstallError)) {
        void recordUpdateFailure({
          stage: 'unknown',
          reason: raw,
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
            {reason !== '' ? (
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
