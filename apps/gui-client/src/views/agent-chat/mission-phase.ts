// What the AI is doing, as ONE word.
//
// Stage 0 of the AI-view rebuild (spec §3.1). Nothing renders it yet — stage 4
// hangs the room light, the device rim, the status pill tone and the stage
// caption off `data-ai-phase` — but it lands here, pure and unit-tested, for two
// reasons. The phase is read by six different places, and six places deriving
// "is it running?" from six different reads of the hook is exactly how the
// header came to show a green "Session open" beside a red "Stopped at step 3".
// And a pure function over a plain object is testable without a DOM, so the
// arms that are awkward to stage in a render — a denied step, a stopped turn, a
// zero-step plan — are cheap to pin.
//
// ⚠️ EVERY read is optional-chained. About a dozen view tests mock `useAgentChat`
// with a partial object, so a field this function reads may simply be absent;
// the absence must resolve to a phase, never to a throw.
//
// ⚠️ Two deliberate departures from the spec table, both named so a later stage
// can overrule them on purpose rather than discover them:
//
//   1. The spec writes the signature `missionPhase(chat, liveSession)`. None of
//      the six rules reads the session: they are all about the TURN. The session
//      lifecycle drives the HUD chip and the status pill (§3.4), which are a
//      different axis — a session can be open with nothing running. So this
//      takes the chat alone rather than carrying an argument it ignores.
//   2. `done` requires at least one result. Read literally, "every result
//      succeeded" is vacuously true of a turn with NO results — and a
//      plan-executed turn with zero results is the "I couldn't turn that into
//      browser actions to run" reply. Blooming the room green for a turn that
//      ran nothing would be the view telling a small lie; that turn is `idle`.

import type { AgentIntentResult } from '@driftstack/sdk';
import type { ChatTurn } from '../../lib/use-agent-chat';

/** The one word. `thinking` and `acting` are both "it is working"; they differ
 *  in whether there is a step to point at yet. */
export type MissionPhase = 'idle' | 'thinking' | 'acting' | 'paused' | 'done' | 'trouble';

/** The slice of the chat hook the phase is derived from. Every field optional:
 *  a partial hook double must still produce a phase. */
export interface MissionPhaseChat {
  turns?: ReadonlyArray<ChatTurn>;
  sending?: boolean;
  pendingConfirmation?: { category: string; matchedText: string } | null;
  liveSteps?: ReadonlyArray<AgentIntentResult>;
  liveStepIndex?: number | null;
  /** Turn ids whose consequential step the customer denied. */
  deniedTurnIds?: ReadonlySet<number>;
}

/** The last agent turn, or undefined when the chat has none. A user turn is
 *  never the subject: the phase describes what the AI did, and the customer's
 *  own message tells us nothing about that. */
function lastAgentTurn(turns: ReadonlyArray<ChatTurn>): ChatTurn | undefined {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn !== undefined && turn.role === 'agent') return turn;
  }
  return undefined;
}

/** A step that failed outright, or a consequential step the customer denied. */
function wentWrong(results: ReadonlyArray<AgentIntentResult>, denied: boolean): boolean {
  return results.some(
    (r) => r.kind === 'failure' || (denied && r.kind === 'confirmation_required'),
  );
}

export function missionPhase(chat: MissionPhaseChat): MissionPhase {
  // Nothing moves until the customer decides. A halted turn has SETTLED
  // (`sending` is false) and the gate is still up, so this outranks every
  // turn-shaped rule below it.
  //
  // ⛔ PIN MOVED IN STAGE 5, ON PURPOSE. Stage 0 wrote this as "paused outranks
  // a send that is somehow still in flight" — and stage 5 found that the send
  // is not "somehow", it is a designed path. "Or send a new instruction instead
  // of approving" (§3.7) keeps the composer usable while the gate is up, and
  // during that send the halted turn is still the last AGENT turn, so
  // `pendingConfirmation` is still set. `approve()` is the same shape: it
  // re-sends and resolves the gate only after the re-send succeeds, so the
  // approved step RUNS with the dock still mounted and its buttons disabled.
  //
  // In both, the AI is working. `paused` is what stops every infinite animation
  // in the view (§3.6) and hangs the amber room light — a still, amber room
  // over a plan streaming new steps is the view contradicting what the customer
  // can see. The gate being up is the DOCK's business; the phase describes what
  // the AI is doing, and what it is doing is working.
  const gated = chat.pendingConfirmation !== undefined && chat.pendingConfirmation !== null;
  if (gated && chat.sending !== true) return 'paused';

  if (chat.sending === true) {
    // No step to point at yet: the plan is still being made, or the first step
    // has not started. That is a different picture from a step landing.
    const started = (chat.liveStepIndex ?? null) !== null || (chat.liveSteps?.length ?? 0) > 0;
    return started ? 'acting' : 'thinking';
  }

  const turn = lastAgentTurn(chat.turns ?? []);
  if (turn === undefined) return 'idle';
  // A turn that stopped partway kept what ran; it did not finish.
  if (turn.interrupted !== undefined) return 'trouble';
  const response = turn.response;
  if (response === undefined) return 'idle';
  if (response.kind === 'refuse' || response.kind === 'stopped') return 'trouble';
  if (response.kind !== 'plan-executed') return 'idle'; // clarify, logged-manual, unknown
  if (wentWrong(response.results, chat.deniedTurnIds?.has(turn.id) ?? false)) return 'trouble';
  // Departure 2 above: a plan that executed NO steps did not finish a task.
  if (response.results.length === 0) return 'idle';
  return response.results.every((r) => r.kind === 'success') ? 'done' : 'idle';
}
