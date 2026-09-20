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
