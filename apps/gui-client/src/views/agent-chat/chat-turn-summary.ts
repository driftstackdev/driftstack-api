// One history-rail line for a stored turn.
//
// Stage 0 of the AI-view rebuild (spec §9): moved out of AgentChatView.tsx so
// the rail can import it WITHOUT importing the view (the view re-exports it, so
// nothing that used to read it from there has to change). The body is byte-for-
// byte what shipped.

import { type ChatTurn } from '../../lib/use-agent-chat';
import { summariseTurn, type TurnSummary } from '../../lib/chat-history';

/**
 * B2 — one history-rail line for a stored turn, with the stopped turn answered
 * HERE before the shared summariser sees it.
 *
 * `summariseTurn` switches over the response kinds it knows and has no arm for
 * `stopped`, so for a stopped turn it returns nothing at runtime and the rail's
 * `summary.role` throws — taking the chat view down the moment a saved chat that
 * holds a Stop is expanded. Answering it first keeps the rail up whatever that
 * switch knows. Exported for its test.
 */
export function summariseChatTurn(turn: ChatTurn): TurnSummary {
  const r = turn.role === 'agent' && turn.interrupted === undefined ? turn.response : undefined;
  if (r?.kind === 'stopped') {
    const n = r.results.length;
    const ran = n === 0 ? 'nothing ran' : `${String(n)} step${n === 1 ? '' : 's'} ran`;
    const flat = r.notice.replace(/\s+/g, ' ').trim();
    const notice = flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
    return {
      role: 'agent',
      headline: `stopped — ${ran}: ${notice}`,
      intentCount: n,
      ok: false,
    };
  }
  return summariseTurn(turn);
}

/**
 * How a saved chat ENDED, as one word — the rail's outcome dot (spec §3.2).
 *
 * `ok` = the last thing the AI did worked; `bad` = it stopped, was interrupted,
 * declined, or a step failed; `idle` = nothing conclusive happened (no agent
 * turn yet, a question back, a turn driven by hand).
 *
 * ⛔ THIS DELIBERATELY DOES NOT GO THROUGH `summariseChatTurn`, and the reason
 * is not style. The prose summariser calls `summariseTurn` out of
 * `lib/chat-history`, and about a dozen view tests `vi.mock` that module with a
 * partial object — four of them mock it WITH saved chats and WITHOUT
 * `summariseTurn`, including the two that pin the own-key model picker. Every
 * row of the rail would then call `undefined(...)`. The spec's note ("the empty
 * path must not call chatTurnCount/summariseTurn") saw the empty half of the
 * same trap.
 *
 * It is also a different question. The headline is what the turn SAYS; this is
 * whether it worked, and it is answered from the turn's own shape — the same
 * reads `missionPhase` makes about the live turn. `a-saved-chat-wears-the-
 * outcome-of-its-last-turn.test.ts` holds the two together: wherever
 * `summariseChatTurn(...).ok` is defined, this must agree with it.
 */
export type ChatOutcome = 'ok' | 'bad' | 'idle';

export function chatOutcome(turns: ReadonlyArray<ChatTurn>): ChatOutcome {
  let turn: ChatTurn | undefined;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i];
    if (t !== undefined && t.role === 'agent') {
      turn = t;
      break;
    }
  }
  if (turn === undefined) return 'idle';
  // A turn that stopped partway kept what ran; it did not finish.
  if (turn.interrupted !== undefined) return 'bad';
  const r = turn.response;
  if (r === undefined) return 'idle';
  if (r.kind === 'stopped' || r.kind === 'refuse') return 'bad';
  if (r.kind !== 'plan-executed') return 'idle'; // clarify, logged-manual, unknown
  return r.ok ? 'ok' : 'bad';
}
