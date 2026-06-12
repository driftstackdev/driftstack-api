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
  done: boolean;
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
  const doneCount = steps.filter((s) => s.done).length;
  if (steps.length === 0 || doneCount === steps.length) return null;
  const next = steps.find((s) => !s.done);

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
            {step.done ? (
              <span aria-hidden="true" className="text-status-ready">
                ✓
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
            {!step.done && step.go ? (
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
              <span className={step.done ? 'text-ink-muted line-through' : 'text-ink-muted'}>
                {step.label}
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-surface-inset">
        <div
          className="h-full rounded-full bg-accent transition-all"
          style={{ width: `${String(Math.round((doneCount / steps.length) * 100))}%` }}
        />
      </div>
    </div>
  );
}
