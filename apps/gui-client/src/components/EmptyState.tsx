// Shared empty-state — a consistent icon + heading + description + optional
// action for the "nothing here yet" moment across list views. Before W462
// each view rolled its own (some a bare <p>, some a polished icon+copy block),
// so the app's empty screens read inconsistently — a "basic" tell. This
// centralises the pattern so every empty state looks deliberate and the same.
//
// Design-system tokens only (surface-*, ink-*); the dashed border + centred
// column matches the existing Profiles"No profiles yet" treatment. The icon
// + description + action are all optional so a view can use as much as it has.

import type { JSX, ReactNode } from 'react';

export interface EmptyStateProps {
  /** Optional Lucide-style stroke icon (20px), rendered in a muted chip. */
  icon?: ReactNode;
  /** Required one-line heading, e.g. "No sessions yet". */
  title: string;
  /** Optional supporting sentence explaining what will appear here / how. */
  description?: string;
  /** Optional primary action (e.g. a "Create" button) for the empty state. */
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-surface-divider px-6 py-12 text-center">
      {icon !== undefined && (
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-inset text-ink-muted">
          {icon}
        </div>
      )}
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-medium text-ink-primary">{title}</h3>
        {description !== undefined && (
          <p className="max-w-md text-sm leading-relaxed text-ink-secondary">{description}</p>
        )}
      </div>
      {action !== undefined && <div className="mt-1">{action}</div>}
    </div>
  );
}
