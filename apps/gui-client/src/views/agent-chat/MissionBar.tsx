// The bar across the top of the AI view: what this is, what the session is
// doing, and the controls that belong to the whole chat.
//
// Stage 0 of the AI-view rebuild (spec §9): lifted out of AgentChatView.tsx with
// the DOM byte-identical — the same `<header>` and its wrap behaviour, the same
// `data-component="agent-status-pill"`, the same `aria-label="Profile"` /
// `aria-label="Model"` selects with the same titles and option text, the same
// `Save as task` / `New chat` / `Toggle live view` names. Stage 6 makes it one
// row; nothing here anticipates that.

import { type AgentSession } from '@driftstack/sdk';
import { CHAT_MODELS, NEEDS_OWN_KEY_SUFFIX, modelNeedsOwnKey } from '../../lib/chat-models';
import type { SessionStateDescriptor } from '../../lib/session-liveness';
import { type ChatModel } from '../../lib/use-agent-chat';
import { IconSparkle } from './icons';

/* Written out in full rather than composed, because Tailwind's scanner only
   sees class names that appear literally in the source.

   ⛔ `stopping` IS NOT A HUE, it is the NEUTRAL tone (spec §3.3). The grey
   status token was being used as TEXT on its own 15% wash: 3.18:1 in dark and
   2.47:1 in light, both under the 4.5 a 10px label needs — measured by
   scripts/gui-text-quality.mjs the moment the audit-agent-chat-stopping scene
   existed to render it, which is why it shipped unseen for months (no harness
   scene had ever reached a terminating session). The fix is not a lighter grey:
   a pill that says "Stopping" is a piece of QUIET copy, so it wears the ink that
   already means quiet — ink-secondary on an elevated surface with a divider
   ring — which reads 7.91:1 in dark and 6.85:1 in light. The grey PIP beside it
   keeps --status-idle: it is a 6px dot, not text, and it is never the only
   signal (the label says the same thing in words).

   Stage 6 moves `Session open` / `Idle` / `Paused` / `Ended` onto this same
   neutral tone and adds the `Needs your approval` override; stage 1 fixes only
   the failure the gate can now see. */
const STATUS_PILL_TONE: Record<SessionStateDescriptor['tone'], string> = {
  running: 'bg-accent/15 text-accent-text',
  starting: 'bg-status-busy/15 text-status-busy',
  stopping: 'bg-surface-elevated/80 text-ink-secondary ring-1 ring-surface-divider',
  ready: 'bg-status-ready/15 text-status-ready',
  error: 'bg-status-error/15 text-status-error',
};
const STATUS_DOT_TONE: Record<SessionStateDescriptor['tone'], string> = {
  running: 'bg-accent',
  starting: 'bg-status-busy',
  stopping: 'bg-status-idle',
  ready: 'bg-status-ready',
  error: 'bg-status-error',
};

export function MissionBar({
  sessionState,
  session,
  liveOpen,
  onToggleLiveView,
  profileId,
  profiles,
  onProfileChange,
  model,
  onModelChange,
  hasOwnKey,
  started,
  sending,
  canSaveRecipe,
  onSaveAsTask,
  onNewChat,
}: {
  sessionState: SessionStateDescriptor;
  session: AgentSession | null;
  liveOpen: boolean;
  onToggleLiveView: () => void;
  profileId: string;
  profiles: ReadonlyArray<{ id: string; name: string }>;
  onProfileChange: (id: string) => void;
  model: string;
  onModelChange: (m: ChatModel) => void;
  /** null = unknown; only a KNOWN false marks the own-key-only models. */
  hasOwnKey: boolean | null;
  started: boolean;
  sending: boolean;
  canSaveRecipe: boolean;
  onSaveAsTask: () => void;
  onNewChat: () => void;
}): JSX.Element {
  return (
    /* Header — #139: flex-wrap + min-w-0 so the dense control cluster (live
       toggle, budget, profile, model, save, new chat) WRAPS to a second row
       at narrow widths instead of pushing the rightmost buttons off the
       panel edge (founder: "buttons cut off / run outside the panel"). */
    <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-surface-divider px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded bg-accent-subtle text-accent">
          <IconSparkle />
        </span>
        <div className="flex flex-col">
          <span className="text-sm font-medium text-ink-primary">AI Browser Automation</span>
          <span className="text-2xs text-ink-muted">natural-language automation</span>
        </div>
        {/* V-1611 — this pill reported API-KEY PRESENCE and called it "AI
            ready": a claim about CONFIGURATION worn as a claim about STATE.
            A customer with a key and no session, and one with a session
            running right now, saw the identical pill. The freshest session
            we hold wins — the poll's copy if it has answered, else the one
            the chat hook created. */}
        <span
          data-component="agent-status-pill"
          className={`ml-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium ${STATUS_PILL_TONE[sessionState.tone]}`}
          title={sessionState.title}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT_TONE[sessionState.tone]} ${
              sessionState.tone === 'running' ? 'animate-pulse' : ''
            }`}
          />
          {sessionState.label}
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {/* Below lg the live-view pane is hidden; this button reveals it as a
            slide-over (hidden at lg+, where the pane is always inline). */}
        <button
          type="button"
          aria-label="Toggle live view"
          onClick={onToggleLiveView}
          className="rounded border border-surface-divider px-2 py-1 text-2xs font-medium text-ink-secondary hover:text-ink-primary lg:hidden"
        >
          {liveOpen ? 'Hide live' : 'Live view'}
        </button>
        {session !== null && (
          <BudgetMeter
            remaining={session.token_budget_remaining}
            total={session.token_budget_total}
          />
        )}
        <select
          aria-label="Profile"
          value={profileId}
          // Lock once started OR while the FIRST send is in flight: during the
          // first send `started` is still false (turns.length===0 until the
          // reply lands), so without `|| chat.sending` the customer could change
          // the profile after Send — the session is created with the OLD value
          // while the header shows the new one and the persist writes the new
          // one, desyncing saved chat metadata from the actual session (audit).
          disabled={started || sending}
          onChange={(e) => onProfileChange(e.target.value)}
          className="max-w-[10rem] truncate rounded border border-surface-divider bg-surface-inset px-2 py-1 text-xs text-ink-secondary disabled:opacity-60"
          title={
            started || sending
              ? 'Profile is locked for this chat — start a new chat to change it'
              : 'Which profile the agent works on. Temporary = a throwaway session that saves nothing.'
          }
        >
          <option value="">Temporary profile (saves nothing)</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Model"
          value={model}
          // Same first-send race as the Profile select above — lock on
          // `started || chat.sending` so the model can't change after Send
          // creates the session with the prior value.
          disabled={started || sending}
          onChange={(e) => onModelChange(e.target.value as ChatModel)}
          className="rounded border border-surface-divider bg-surface-inset px-2 py-1 text-xs text-ink-secondary disabled:opacity-60"
          title={
            started || sending
              ? 'Model is locked for the current chat — start a new chat to change it'
              : hasOwnKey === false
                ? 'Some models run only on your own Anthropic key. Add one in Settings → AI & billing.'
                : 'Model'
          }
        >
          {/* An own-key-only model stays IN the list when the account has no
              key, only disabled: a reopened chat stored on it must still match
              an option, or the select would silently show a different model
              from the one the chat ran on. */}
          {CHAT_MODELS.map((m) => {
            const needsKey = hasOwnKey === false && modelNeedsOwnKey(m.id);
            return (
              <option key={m.id} value={m.id} disabled={needsKey}>
                {needsKey ? `${m.label} ${NEEDS_OWN_KEY_SUFFIX}` : m.label}
              </option>
            );
          })}
        </select>
        <button
          type="button"
          onClick={onSaveAsTask}
          disabled={!canSaveRecipe || sending}
          className="btn-secondary px-2 py-1 text-xs disabled:opacity-50"
          title={
            canSaveRecipe
              ? 'Save this chat as a task you can run again later'
              : 'Run at least one task first, then save it to replay later'
          }
        >
          Save as task
        </button>
        <button
          type="button"
          onClick={onNewChat}
          disabled={!started || sending}
          className="btn-secondary px-2 py-1 text-xs disabled:opacity-50"
        >
          New chat
        </button>
      </div>
    </header>
  );
}

function BudgetMeter({ remaining, total }: { remaining: number; total: number }): JSX.Element {
  const pct = total > 0 ? Math.max(0, Math.min(100, (remaining / total) * 100)) : 0;
  return (
    <div className="flex items-center gap-1.5" title={`${remaining} / ${total} tokens remaining`}>
      <span className="section-label">budget</span>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-inset">
        <span
          className={`block h-full rounded-full ${pct < 15 ? 'bg-status-error' : 'bg-status-ready'}`}
          style={{ width: `${pct}%` }}
        />
      </span>
      {/* Show the percentage inline — a bare bar with no number read as
          meaningless (journey audit L5); the hover title keeps the exact ratio. */}
      <span className="text-2xs tabular-nums text-ink-muted">{Math.round(pct)}%</span>
    </div>
  );
}
