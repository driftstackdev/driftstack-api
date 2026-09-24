// The bar across the top of the AI view: what this is, what the session is
// doing, and the controls that belong to the whole chat.
//
// Stage 6 of the AI-view rebuild (spec §3.3). ONE ROW AT EVERY SUPPORTED WIDTH.
// What it replaces: a `flex-wrap` header that took two rows at the 1280px
// default and THREE at the 960px minimum — a title row, a control row, and a
// row holding nothing but "New chat" — spending 122px of a 564px-tall view on
// chrome before the customer's first template was reached. The wrap was a
// deliberate 2026 fix for buttons running off the panel edge; this stage removes
// the pressure that made it necessary instead of the wrap alone:
//
//   · the "New chat" button is GONE from the bar. There was never a reason for
//     two of them — the rail's "+ New chat" is the one the customer already
//     reaches for, and it is the one the redesign draws. (The pin that named
//     the bar's copy, `getByRole('button', { name: 'New chat' })`, now names the
//     rail's `'+ New chat'`; see the model-picker test.)
//   · the subtitle "natural-language automation" is gone (spec §10) — it said
//     nothing the title and the first screen do not.
//   · the two pickers stop being form fields the moment the chat has started.
//     They are still the SAME `<select disabled>` elements with the same titles
//     and the same options; they are just drawn as what they have become —
//     quiet, locked context with a lock beside it — which costs a third of the
//     width a bordered field does.
//   · the sparkle chip and the budget bar step aside in the narrow tier.
//
// ⛔ THE PILL'S TONE NO LONGER COMES FROM `sessionState.tone`. See
// `mission-status.ts` for why (five tones, nine labels, and two of the
// collisions were the bar telling the customer something false). The pill is
// NOT `role="status"`: the no-key idle state must contain exactly one, and that
// one is the API-key gate card in the column.

import { type AgentSession } from '@driftstack/sdk';
import { CHAT_MODELS, NEEDS_OWN_KEY_SUFFIX, modelNeedsOwnKey } from '../../lib/chat-models';
import type { SessionStateDescriptor } from '../../lib/session-liveness';
import { type ChatModel } from '../../lib/use-agent-chat';
import { IconBookmark, IconLock, IconScreen, IconSparkle } from './icons';
import { missionPill, type MissionStatusChat, type MissionPillTone } from './mission-status';

/* Written out in full rather than composed, because Tailwind's scanner only
   sees class names that appear literally in the source.

   ⛔ `neutral` IS NOT A HUE, and it is what four of these labels wear. The grey
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

   Stage 1 gave `Stopping` this tone to close the failure the gate could see.
   Stage 6 moves `Session open`, `Idle`, `Paused` and `Ended` onto it too, so
   that a session merely OPEN stops wearing the amber of one coming up and a
   session that has ENDED stops wearing the green of one that is ready. */
const PILL_TONE: Record<MissionPillTone, string> = {
  run: 'bg-accent/15 text-accent-text',
  busy: 'bg-status-busy/15 text-status-busy',
  neutral: 'bg-surface-elevated/80 text-ink-secondary ring-1 ring-surface-divider',
  ready: 'bg-status-ready/15 text-status-ready',
  bad: 'bg-status-error/15 text-status-error-text',
};
const PIP_TONE: Record<MissionPillTone, string> = {
  run: 'bg-accent',
  busy: 'bg-status-busy',
  neutral: 'bg-status-idle',
  ready: 'bg-status-ready',
  bad: 'bg-status-error',
};

export function MissionBar({
  chat,
  sessionState,
  session,
  stageShown,
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
}: {
  /** Only for the pill's approval override — every read is optional-chained. */
  chat: MissionStatusChat;
  sessionState: SessionStateDescriptor;
  session: AgentSession | null;
  /** Whether the stage is showing (the toggle's `aria-pressed`). */
  stageShown: boolean;
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
}): JSX.Element {
  const pill = missionPill(chat, sessionState);
  // The lock rule is UNCHANGED (spec §6): lock once started OR while the FIRST
  // send is in flight. During the first send `started` is still false (turns
  // stay empty until the reply lands), so without `|| sending` the customer
  // could change the profile after Send — the session is created with the OLD
  // value while the bar shows the new one and the persist writes the new one,
  // desyncing saved chat metadata from the session that actually ran.
  const locked = started || sending;
  return (
    <header className="ai-bar">
      <div className="ai-bar-id">
        <span className="ai-bar-chip" aria-hidden="true">
          <IconSparkle />
        </span>
        <span className="ai-bar-title">AI Browser Automation</span>
      </div>
      {/* V-1611 — this pill reported API-KEY PRESENCE and called it "AI
          ready": a claim about CONFIGURATION worn as a claim about STATE.
          A customer with a key and no session, and one with a session
          running right now, saw the identical pill. The freshest session
          we hold wins — the poll's copy if it has answered, else the one
          the chat hook created. */}
      <span
        data-component="agent-status-pill"
        className={`ai-pill ${PILL_TONE[pill.tone]}`}
        title={pill.title}
      >
        <span
          className={`ai-pip ${PIP_TONE[pill.tone]} ${pill.tone === 'run' ? 'ai-beat-slow' : ''}`}
        />
        {pill.label}
      </span>
      <div className="ai-bar-r">
        {session !== null && (
          <BudgetMeter
            remaining={session.token_budget_remaining}
            total={session.token_budget_total}
          />
        )}
        <label className="ai-field" data-locked={locked ? '' : undefined}>
          {locked && (
            <span className="ai-field-lock" aria-hidden="true">
              <IconLock />
            </span>
          )}
          <select
            aria-label="Profile"
            value={profileId}
            disabled={locked}
            onChange={(e) => onProfileChange(e.target.value)}
            className="ai-select"
            title={
              locked
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
        </label>
        <label className="ai-field" data-locked={locked ? '' : undefined}>
          <select
            aria-label="Model"
            value={model}
            disabled={locked}
            onChange={(e) => onModelChange(e.target.value as ChatModel)}
            className="ai-select"
            title={
              locked
                ? 'Model is locked for the current chat — start a new chat to change it'
                : hasOwnKey === false
                  ? 'Some models run only on your own Anthropic key. Add one in the web dashboard at app.driftstack.io.'
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
        </label>
        <button
          type="button"
          onClick={onSaveAsTask}
          disabled={!canSaveRecipe || sending}
          className="btn-secondary ai-bar-btn disabled:opacity-50"
          title={
            canSaveRecipe
              ? 'Save this chat as a task you can run again later'
              : 'Available once a task has finished in this chat'
          }
        >
          {/* aria-hidden, so the accessible name stays exactly "Save as task" */}
          <span className="ai-bar-btn-i" aria-hidden="true">
            <IconBookmark />
          </span>
          Save as task
        </button>
        {/* ⛔ PIN MOVED IN STAGE 4, DELIBERATELY. This used to carry the visible
            words "Live view" / "Hide live" and to exist only below the `lg`
            VIEWPORT breakpoint, where it was the only way to reach a live pane
            that had been hidden outright. The stage is now INLINE at every
            supported width, so the button has one job left — give the phone's
            room back to the conversation — and it is an icon button with
            `aria-pressed` saying whether the stage is showing. The accessible
            name is unchanged and still exactly `Toggle live view`; the visible
            text is gone, so the pin that read `Hide live` moved with it (see
            the-mission-bar-is-one-row… and agent-chat-save-recipe).
            Hidden in the narrow tier by CSS: at 960px the stage is 252px of the
            view and taking it away leaves a text box on its own. */}
        <button
          type="button"
          aria-label="Toggle live view"
          aria-pressed={stageShown}
          onClick={onToggleLiveView}
          className="ai-bar-btn-icon ai-bar-btn-quiet"
          title={stageShown ? 'Hide the live view' : 'Show the live view'}
        >
          <span className="ai-bar-btn-i" aria-hidden="true">
            <IconScreen />
          </span>
        </button>
      </div>
    </header>
  );
}

/**
 * The AI budget, as ONE reading: "82% left" and a 44px bar (spec §3.3).
 *
 * `role="img"` + `aria-label` because the meter is three elements saying one
 * thing — a mark, a number and a bar. Without it a screen reader reads "82%
 * left" with no idea what is 82% left of, which is the same complaint the
 * journey audit made about the bare bar this replaces (a percentage with no
 * number read as meaningless). The visible text is still real text on a real
 * background, so the contrast gate measures it.
 *
 * The wide tier spells "AI budget" out in front instead of leaving it to the
 * sparkle; that is a CSS decision (`.ai-budget-wide`), not a React one, so the
 * bar does not re-render on a resize.
 */
function BudgetMeter({ remaining, total }: { remaining: number; total: number }): JSX.Element {
  const pct = total > 0 ? Math.max(0, Math.min(100, (remaining / total) * 100)) : 0;
  const shown = Math.round(pct);
  // Below 15% the reading turns to error ink AND keeps its place in the narrow
  // tier, where the budget is otherwise the first thing to go.
  const low = pct < 15;
  const sentence = `AI budget: ${String(shown)}% of this session's budget is left`;
  return (
    <span
      className="ai-budget"
      data-low={low ? '' : undefined}
      role="img"
      aria-label={sentence}
      title={sentence}
    >
      <span className="ai-budget-mark" aria-hidden="true">
        <IconSparkle />
      </span>
      <span className="ai-budget-read tabular-nums">
        <span className="ai-budget-wide">AI budget · </span>
        {shown}%<span className="ai-budget-mid"> left</span>
      </span>
      <span className="ai-budget-bar" aria-hidden="true">
        <span className="ai-budget-fill" style={{ width: `${String(shown)}%` }} />
      </span>
    </span>
  );
}
