// Shared inline error banner. Lifted out of three views during GUI8
// polish so all error surfaces look identical and dismiss the same way.

export interface ErrorBannerProps {
  message: string;
  onDismiss: () => void;
}

export function ErrorBanner({ message, onDismiss }: ErrorBannerProps): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3 rounded border border-status-error/30 bg-status-error/10 px-3 py-2">
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="section-label text-status-error/80">Error</span>
        <span className="text-sm text-ink-primary truncate">{message}</span>
      </div>
      <button type="button" className="btn-secondary" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
