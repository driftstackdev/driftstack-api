// The first screen: nothing has run yet, so this is where the customer finds
// out what the thing does and picks somewhere to start.
//
// Stage 0 of the AI-view rebuild (spec §9): lifted out of AgentChatView.tsx
// (where it was called `EmptyState`) with the DOM byte-identical — the same
// headline, the same sentence, the same four template buttons in the same order
// with the same label + description. Stage 2 rewrites it as the hero; the
// template buttons keep filling, focusing and growing the composer.

import { DEFAULT_ASSISTANT_TEMPLATES } from '../../lib/assistant-templates';
import { IconSparkle } from './icons';

export function IdleHero({ onPick }: { onPick: (text: string) => void }): JSX.Element {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 py-12 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-subtle text-accent">
        <IconSparkle />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-base font-medium text-ink-primary">
          Start from a template or describe a task
        </p>
        <p className="text-sm text-ink-muted">
          Pick a template below, or describe what you want in plain language. Driftstack plans the
          steps and runs them on a session — pausing for your approval before anything
          consequential.
        </p>
      </div>
      <div className="flex w-full flex-col gap-1.5">
        {DEFAULT_ASSISTANT_TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onPick(t.prompt)}
            className="flex flex-col gap-0.5 rounded-md border border-surface-divider bg-surface-raised px-3 py-2 text-left transition-colors hover:border-accent/50"
          >
            <span className="text-xs font-medium text-ink-primary">{t.label}</span>
            <span className="text-2xs text-ink-muted">{t.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
