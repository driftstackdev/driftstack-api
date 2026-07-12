// Shared inline error banner. Lifted out of three views during GUI8
// polish so all error surfaces look identical and dismiss the same way.

import { useEffect } from 'react';
import { record } from '../lib/log-buffer';

export interface ErrorBannerProps {
  message: string;
  onDismiss: () => void;
  /** Optional recovery action for request-scoped failures. Existing callers
   *  remain dismiss-only unless they explicitly provide it. */
  onRetry?: () => void;
  /** Keeps the retry action single-flight and names the work in progress. */
  retrying?: boolean;
}

export function ErrorBanner({
  message,
  onDismiss,
  onRetry,
  retrying = false,
}: ErrorBannerProps): JSX.Element {
  // W609 — Dev Logs productivity: every error a user SEES also lands in
  // the Dev Logs panel (views render friendly messages without touching
  // console.*, so before this the panel was empty during visible errors).
  // Effect keyed on message → re-logs only when the text changes.
  useEffect(() => {
    record('error', ['[ui] ' + message]);
  }, [message]);
  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-3 rounded border border-status-error/30 bg-status-error/10 px-3 py-2"
    >
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="section-label text-status-error/80">Error</span>
        {/* 2026-05-20 — whitespace-pre-line so multi-line diagnostic
            messages from diagnosticFetchError render with their
            newlines + bullet points intact. truncate dropped because
            it collapses everything to a single line; for an error
            banner we'd rather wrap. */}
        <span className="whitespace-pre-line text-sm text-ink-primary">{message}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {onRetry !== undefined && (
          <button
            type="button"
            className="btn-primary"
            onClick={onRetry}
            disabled={retrying}
            aria-busy={retrying}
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        )}
        <button type="button" className="btn-secondary" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
