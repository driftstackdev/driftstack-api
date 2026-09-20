// What the mission bar's pill says, and what the rail's active row says —
// the two places the view reports the SAME situation in different words.
//
// Stage 6 of the AI-view rebuild (spec §3.2, §3.3). Pure, no React, no clock,
// no I/O, so every branch is a unit test without a DOM — the reason
// `mission-phase.ts` next door exists in the same shape.
//
// ⚠️ EVERY read of the chat is optional-chained, for the reason mission-phase.ts
// gives: about a dozen view tests mock `useAgentChat` with a partial object, so
// a field read here may simply be absent. An absence must resolve to a status,
// never to a throw.

import type { SessionStateDescriptor } from '../../lib/session-liveness';

/**
 * The pill's colour, as a WORD rather than a class string.
 *
 * `run` is the only one worth a beating pip; `neutral` is the quiet tone every
 * "a session exists and nothing is happening in it" label wears.
 */
export type MissionPillTone = 'ready' | 'busy' | 'run' | 'neutral' | 'bad';

export interface MissionPill {
  label: string;
  tone: MissionPillTone;
  /** Hover text — always says WHY, because the label alone is ambiguous. */
  title: string;
}

/** The slice of the chat hook the pill override is derived from. */
export interface MissionStatusChat {
  sending?: boolean;
  /** A Stop request is in flight. Optional — the field itself is optional on
   *  the hook, for the partial doubles. */
  stopping?: boolean;
  pendingConfirmation?: { category: string; matchedText: string } | null;
  livePlan?: { total: number } | null;
  liveSteps?: ReadonlyArray<unknown>;
  liveStepIndex?: number | null;
}

/**
 * ⛔ THE TONE IS DECIDED BY THE LABEL, AND THAT IS DELIBERATE.
 *
 * `describeAgentSessionState` has five tones and nine labels, and the collision
 * is exactly where the bar was lying: `Session open`, `Idle` and `Paused` all
 * share `starting`, so a session merely OPEN wore the same amber as one coming
 * up; `Ended` shares `ready` with `AI ready`, so a finished session wore the
 * same green as a live one — which is how a green "Session open" came to sit
 * beside a red "Stopped at step 3". Two of the tones were also unreadable as
 * text: `stopping` computed 3.18:1 in dark and 2.47:1 in light.
 *
 * Spec §3.3 re-cuts the axis: a pill is LOUD (ready / busy / run / bad) only
 * when it is reporting something the customer should act on, and quiet
 * otherwise. That cut does not follow `tone`, so it cannot be expressed as a
 * remapping of it — and `session-liveness.ts` is deliberately untouched by this
 * stage (its `tone` is the session's own liveness, read by
 * `a-badge-must-not-call-a-dead-worker-running.test.ts`, and other surfaces may
 * come to want it).
 *
 * The cost of keying on a display string is that a label added to
 * `session-liveness.ts` without an entry here would fall to `neutral` — quiet,
 * readable, and WRONG for an error. That is what
 * `the-status-pill-is-loud-only-when-it-has-something-to-say.test.ts` refuses:
 * it reads the labels out of the session-liveness source and fails on any that
 * is missing from this table.
 */
const TONE_BY_LABEL: ReadonlyMap<string, MissionPillTone> = new Map([
  ['AI ready', 'ready' as const],
  ['Not connected', 'bad' as const],
  ['Starting', 'busy' as const],
  ['Running', 'run' as const],
  ['Idle', 'neutral' as const],
  ['Stopping', 'neutral' as const],
  ['Paused', 'neutral' as const],
  ['Session open', 'neutral' as const],
  ['Ended', 'neutral' as const],
]);

/** The one label that is not the session's: a decision is waiting. */
export const NEEDS_APPROVAL_LABEL = 'Needs your approval';

/**
 * The pill (spec §3.3): an approval outranks whatever the session is doing,
 * because it is the only state in the view that will not move on its own.
 */
export function missionPill(
  chat: MissionStatusChat,
  sessionState: SessionStateDescriptor,
): MissionPill {
  if (chat.pendingConfirmation !== undefined && chat.pendingConfirmation !== null) {
    return {
      label: NEEDS_APPROVAL_LABEL,
      tone: 'busy',
      title: 'The AI is holding — approve or deny the step below to carry on.',
    };
  }
  return {
    label: sessionState.label,
    tone: TONE_BY_LABEL.get(sessionState.label) ?? 'neutral',
    title: sessionState.title,
  };
}

/** Exposed for the cross-source guard only — not for rendering. */
export function missionPillToneLabels(): ReadonlyArray<string> {
  return [...TONE_BY_LABEL.keys()];
}

/** What the rail's row for the chat being worked on says, and how its dot reads. */
export interface LiveChatStatus {
  /** The meta line, in words — the dot is never the only signal (§3.2). */
  meta: string;
  dot: 'running' | 'approval';
}

/**
 * The live half of a rail row's meta (spec §3.2), or null when this chat is not
 * doing anything — in which case the row keeps today's `N turns · <time>`.
 *
 * The step arithmetic is the SAME expression the live turn renders
 * (`Turn.tsx`'s `at` / `showCount` / `ofTotal`), because a rail saying "step 4
 * of 6" beside a column saying "Step 3 of 6" is worse than a rail saying
 * nothing.
 */
export function liveChatStatus(chat: MissionStatusChat): LiveChatStatus | null {
  // ⛔ STOPPING OUTRANKS EVERYTHING, including a gate that is still up. It is
  // the customer's most recent instruction, and it is the one thing in this
  // list they are waiting on. It also keeps the rail from contradicting the
  // pill: `Stopping` beside "Running · step 3 of 6" is the same class of lie as
  // the green "Session open" beside a red "Stopped at step 3" that
  // `missionPill` exists to remove. (Stage 5 put the same arm at the top of the
  // composer's caption chain, for the same reason.)
  if (chat.stopping === true) return { meta: 'Stopping…', dot: 'running' };
  if (chat.pendingConfirmation !== undefined && chat.pendingConfirmation !== null) {
    return { meta: NEEDS_APPROVAL_LABEL, dot: 'approval' };
  }
  if (chat.sending !== true) return null;
  const index = chat.liveStepIndex ?? null;
  const landed = chat.liveSteps?.length ?? 0;
  const plan = chat.livePlan ?? null;
  // Nothing to point at yet: the plan is still being made.
  if (index === null && plan === null) return { meta: 'Starting…', dot: 'running' };
  const at = (index ?? landed) + 1;
  const total = plan?.total ?? null;
  const of = total === null ? '' : ` of ${String(total)}`;
  return { meta: `Running · step ${String(at)}${of}`, dot: 'running' };
}
