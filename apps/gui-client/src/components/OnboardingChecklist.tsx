// Onboarding checklist — first-run guidance (demo-concepts arc; previewed
// as the Get-set-up card mock in the hub demo).
//
// Pure presentational: the caller derives each step's done-state from data
// it already has (api key present, profile count, live sessions) — this
// component renders progress and routes the next action. Dismissal is the
// caller's concern (persisted however the caller likes); the component
// just emits onDismiss.

export interface ChecklistStep {
  id: string;
  label: string;
  /** `true` done, `false` not done, `null` NOT KNOWN YET.
   *
   *  The third state exists because the callers derive these from data that can
   *  be absent: a count that has not loaded, or a fetch that failed. Coercing
   *  that absence to `false` renders "you have not done this" as a fact about
   *  the account, which is the one thing the checklist must never get wrong --
   *  it is the surface that tells a returning user they are a new user.
   *  An unknown step is never counted as done, so the card cannot auto-hide on
   *  a guess, and never becomes the highlighted next action, so the user is
   *  never sent somewhere on the strength of data we do not have. */
  done: boolean | null;
  /** Optional click-through for the next incomplete step. */
  go?: () => void;
}

export function OnboardingChecklist({
  steps,
  onDismiss,
}: {
  steps: ChecklistStep[];
  onDismiss: () => void;
}): JSX.Element | null {
  const doneCount = steps.filter((s) => s.done === true).length;
  if (steps.length === 0 || doneCount === steps.length) return null;
  // Strictly `false` -- an unknown step must not be promoted to the call to
  // action, because we cannot say it is outstanding.
  const next = steps.find((s) => s.done === false);

  return (
    <div
      data-component="onboarding-checklist"
      className="rounded-lg border border-surface-divider bg-surface-raised p-4"
    >
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-ink-primary">Get set up</p>
        <div className="flex items-center gap-3">
          <span className="mono text-2xs text-ink-muted">
            {doneCount}/{steps.length}
          </span>
          <button
            type="button"
            aria-label="Dismiss checklist"
            className="text-xs text-ink-muted hover:text-ink-primary"
            onClick={onDismiss}
          >
            ✕
          </button>
        </div>
      </div>
      <ul className="mt-2.5 flex flex-col gap-1.5">
        {steps.map((step) => (
          <li key={step.id} className="flex items-center gap-2 text-xs">
            {step.done === true ? (
              <span aria-hidden="true" className="text-status-ready">
                ✓
              </span>
            ) : step.done === null ? (
              <span
                aria-hidden="true"
                className="text-ink-muted"
                title="Not known yet — still checking"
              >
                ·
              </span>
            ) : step.id === next?.id ? (
              <span aria-hidden="true" className="text-accent">
                →
              </span>
            ) : (
              <span aria-hidden="true" className="text-ink-muted">
                ○
              </span>
            )}
            {step.done === false && step.go ? (
              <button
                type="button"
                className={`underline-offset-2 hover:underline ${
                  step.id === next?.id ? 'text-ink-primary' : 'text-ink-muted'
                }`}
                onClick={step.go}
              >
                {step.label}
              </button>
            ) : (
              <span
                className={step.done === true ? 'text-ink-muted line-through' : 'text-ink-muted'}
              >
                {step.label}
                {step.done === null ? (
                  <span className="ml-1.5 text-2xs text-ink-muted">checking…</span>
                ) : null}
              </span>
            )}
          </li>
        ))}
      </ul>
      <div
        className="mt-3 h-1 overflow-hidden rounded-full bg-surface-inset"
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={doneCount}
      >
        <div
          className="h-full rounded-full bg-accent transition-all"
          style={{ width: `${String(Math.round((doneCount / steps.length) * 100))}%` }}
        />
      </div>
    </div>
  );
}
