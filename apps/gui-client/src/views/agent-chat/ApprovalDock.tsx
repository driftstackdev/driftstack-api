// The consequential-action gate: the AI has stopped, and nothing moves until
// the customer decides.
//
// Stage 0 of the AI-view rebuild (spec §9): lifted out of AgentChatView.tsx with
// the DOM byte-identical — the same `role="alert"` container (a screen-reader
// user sitting in the composer must HEAR that a purchase is waiting), the same
// "Confirm before continuing" heading, the same sentence, and `Deny` / `Approve`
// under exactly those names. Stage 5 rewrites the copy and the composition; the
// names and the alert role survive it.

export function ApprovalDock({
  category,
  matchedText,
  sending,
  onDeny,
  onApprove,
}: {
  category: string;
  matchedText: string;
  sending: boolean;
  onDeny: () => void;
  onApprove: () => void;
}): JSX.Element {
  return (
    // a11y: announce the "confirm before continuing" gate — a screen-reader user on
    // the composer must hear that the agent is waiting to run a consequential action
    // (audit 2026-07-09), or they can't approve/deny something they never knew about.
    <div role="alert" className="border-t border-status-busy/40 bg-status-busy/10 px-4 py-3">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-ink-primary">Confirm before continuing</p>
          <p className="text-xs text-ink-secondary [overflow-wrap:anywhere]">
            The agent wants to perform a {categoryLabel(category)}:{' '}
            <span className="font-medium text-ink-primary">“{matchedText}”</span>
          </p>
          <p className="mt-0.5 text-2xs text-ink-muted">
            Approve to let this step run, or Deny to stop the task here.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onDeny}
            disabled={sending}
            className="btn-secondary px-3 py-1 text-xs disabled:opacity-50"
          >
            Deny
          </button>
          <button
            type="button"
            onClick={onApprove}
            disabled={sending}
            className="btn-primary px-3 py-1 text-xs disabled:opacity-50"
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}

export function categoryLabel(category: string): string {
  switch (category) {
    case 'purchase':
      return 'purchase';
    case 'payment':
      return 'payment';
    case 'account_deletion':
      return 'account deletion';
    default:
      return category;
  }
}
