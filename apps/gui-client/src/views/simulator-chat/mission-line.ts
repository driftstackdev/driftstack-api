// The simulator drawer's mission line — round 2 stage B (design brief §2,
// mockup `.mission-line`: one state WORD in an `.ai-chip` tone, one plain
// sentence beside it). NOTES.md §2 calls this out explicitly: "Not a
// component that exists elsewhere; it's the AI view's HUD idea (`.ai-hud`/
// `.ai-now`, spec §3.4) compressed to fit the drawer's width" — so this is a
// NEW, small derivation, not a re-render of `MissionBar` (which carries the
// profile/model pickers, the budget meter and Save-as-task — none of which
// belong in the drawer, which already has its own Mode switch and the
// session's own profile) or of `Stage`'s HUD (which reports whether the
// LiveKit stream is being watched — a different axis the simulator's phone
// does not have, since it always shows the live video).
//
// It reuses the AI view's OWN vocabulary for the two things that must never
// drift from it: `missionPhase` (mission-phase.ts) for what phase a turn is
// in, and `stepsThatRan` (agent-chat/stage-copy.ts) for the trouble
// sentence's step count — the same function the AI view's own stage caption
// uses, so "Stopped at step 3" can never disagree between the two surfaces.
//
// ⛔ NEVER a per-second ticking sentence. Every word this function returns is
// a snapshot of `chat` at render time (a plan label, a step count, a fixed
// phrase) — never a computed elapsed time — because the mission line sits
// beside the panel's own `aria-live="polite"` transcript and a rewriting
// clock there would re-announce itself every tick (the exact rule Turn.tsx's
// `ElapsedClock` and ApprovalDock's `PausedClock` are hidden leaves to avoid).

import type { SessionMode } from '../../lib/agent-session-control';
import type { LivePlan, UseAgentChatResult } from '../../lib/use-agent-chat';
import { missionPhase, type MissionPhaseChat } from '../agent-chat/mission-phase';
import { stepsThatRan } from '../agent-chat/stage-copy';

/** The four tones the mockup's `.ai-chip` family already carries — reused
 *  byte-for-byte (index.css `tone-live`/`tone-hold`/`tone-ready`/`tone-quiet`,
 *  already shipped for the drawer's pinned status strip). No fifth "bad"/error
 *  tone: a trouble phase reads quiet, not alarming — the same rule the sim
 *  device's own room light follows for a state this mockup does not model
 *  ("Never red — trouble states… would map to --ink-muted-rgb, same rule as
 *  the AI view"). */
export type SimMissionTone = 'live' | 'hold' | 'ready' | 'quiet';

export interface SimMissionLine {
  /** The chip's word, upper-cased in the DOM the same way the mockup draws
   *  it and the AI view's own HUD chip does (`StageHud.chip`) — a state name,
   *  not a sentence, so the text gate measures it as real text. */
  word: string;
  tone: SimMissionTone;
  /** The pip beats only while something is genuinely in flight (acting/
   *  thinking, live or pair) — never while paused, done, stopped or idle. */
  beat: boolean;
  /** The one sentence beside the chip. Never a live region on its own (the
   *  panel's transcript already is one) and never a ticking clock — see the
   *  header note. */
  sentence: string;
}

/** A plan label / phase caption, when it is a real, non-empty string. */
function nonEmpty(v: string | null | undefined): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** The sentence for a turn genuinely in flight: the step the plan is on right
 *  now, falling back to the server's own phase caption, falling back to a
 *  plain "Working…" — the SAME fallback chain `stage-copy.ts`'s own
 *  `stageCaption` uses for its `acting`/`thinking` branch (kept as a literal
 *  copy here rather than imported: that function's `subject` is meant to
 *  follow a `lead`/`icon` pair inside a two-part caption, not stand alone as
 *  one sentence). */
function actingSentence(
  livePlan: LivePlan | null,
  liveStepIndex: number | null,
  livePhase: string | null,
): string {
  const planned = livePlan?.labels[liveStepIndex ?? -1];
  return nonEmpty(planned) ?? nonEmpty(livePhase) ?? 'Working…';
}

/** The sentence for a turn that finished — or, for `trouble`, stopped partway.
 *  `sessionActive` is whether this chat still has a live server session (the
 *  same fact `TurnRow`'s own "carries on from here" reads), which is what
 *  makes "the iPhone is still on this page" a true clause to add. */
function settledSentence(
  phase: 'done' | 'trouble',
  turns: UseAgentChatResult['turns'] | undefined,
  sessionActive: boolean,
): string {
  const stillThere = sessionActive ? ' — the iPhone is still on this page' : '';
  if (phase === 'done') return `Finished${stillThere}`;
  const n = stepsThatRan(turns);
  const lead = typeof n === 'number' && n > 0 ? `Stopped at step ${String(n)}` : 'Stopped';
  return `${lead}${stillThere}`;
}

/** The slice of the chat hook this derivation reads — every field optional,
 *  matching `MissionPhaseChat`'s own contract (about a dozen tests mock the
 *  hook with a partial object; an absent field must produce a line, never a
 *  throw). */
export interface SimMissionChat extends MissionPhaseChat {
  livePlan?: LivePlan | null;
  livePhase?: string | null;
  session?: unknown;
}

/**
 * The mission line for the simulator's Agent/Pair conversation panel.
 *
 * `mode` only changes the WORD, and only while something is genuinely
 * running: a live turn reads "Pair" in pair mode (matching the mockup's own
 * `?state=pair`) and "Running" in agent mode. Every other phase's word is
 * mode-independent — "Paused"/"Done"/"Stopped"/"Ready" describe the TURN, not
 * who is driving.
 */
export function simulatorMissionLine(
  chat: SimMissionChat,
  mode: SessionMode | null,
): SimMissionLine {
  const phase = missionPhase(chat);
  const sessionActive = chat.session !== null && chat.session !== undefined;
  switch (phase) {
    case 'paused':
      return {
        word: 'Paused',
        tone: 'hold',
        beat: false,
        sentence: 'Nothing moves until you decide',
      };
    case 'acting':
    case 'thinking':
      return {
        word: mode === 'pair' ? 'Pair' : 'Running',
        tone: 'live',
        beat: true,
        sentence: actingSentence(
          chat.livePlan ?? null,
          chat.liveStepIndex ?? null,
          chat.livePhase ?? null,
        ),
      };
    case 'done':
      return {
        word: 'Done',
        tone: 'ready',
        beat: false,
        sentence: settledSentence('done', chat.turns, sessionActive),
      };
    case 'trouble':
      return {
        word: 'Stopped',
        tone: 'quiet',
        beat: false,
        sentence: settledSentence('trouble', chat.turns, sessionActive),
      };
    case 'idle':
      return {
        word: 'Ready',
        tone: 'quiet',
        beat: false,
        sentence: 'Describe a task below to get started.',
      };
  }
}
