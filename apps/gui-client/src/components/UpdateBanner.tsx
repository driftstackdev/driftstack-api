// V-243 — auto-update prompt. Rendered in the Shell when
// `checkForUpdate()` (src/lib/updater.ts) finds a newer signed bundle.
// Non-blocking: the customer chooses when to install (predictable for a
// tool they may be mid-session with) rather than a surprise restart.
// On install the bundle is downloaded + signature-verified + applied,
// then the app relaunches into the new version.

import { useState } from 'react';
import type { AvailableUpdate } from '../lib/updater';

interface UpdateBannerProps {
  update: AvailableUpdate;
  onDismiss: () => void;
}

export function UpdateBanner({ update, onDismiss }: UpdateBannerProps): JSX.Element {
  const [phase, setPhase] = useState<'idle' | 'installing' | 'error'>('idle');
  const [fraction, setFraction] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function install(): Promise<void> {
    setPhase('installing');
    setError(null);
    try {
      await update.install((f) => setFraction(f));
      // relaunch() replaces the running process; we don't normally
      // reach here. If a platform returns instead of relaunching, the
      // banner simply stays in the (completed) installing state.
    } catch (e) {
      setPhase('error');
      setError(e instanceof Error ? e.message : 'Update failed.');
    }
  }

  return (
    <div
      role="status"
      className={`flex items-center justify-between gap-4 border-b bg-surface-raised px-4 py-2 text-sm ${
        phase === 'error' ? 'border-status-error/30' : 'border-surface-divider'
      }`}
    >
      <div className="min-w-0">
        {phase === 'error' ? (
          <span className="text-ink-secondary">
            Update to {update.version} failed: <span className="text-status-error">{error}</span>
          </span>
        ) : (
          <span className="text-ink-secondary">
            Update <span className="font-medium text-ink-primary">{update.version}</span> available{' '}
            <span className="text-ink-muted">(current {update.currentVersion})</span>
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {phase === 'installing' ? (
          <span className="section-label text-ink-muted" aria-live="polite">
            Installing… {Math.round(fraction * 100)}%
          </span>
        ) : (
          <>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void install()}
              data-testid="update-install"
            >
              {phase === 'error' ? 'Retry' : 'Install & restart'}
            </button>
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
