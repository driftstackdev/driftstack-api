// PLANNING READ MODE — which page-read primitive plans a segment's turn: the
// page's text digest (`get_page_source`, today's behaviour) or its element
// list (`perceive` with no selector, a bounded, one-round-trip listing of the
// page's controls).
//
// ⛔ A LEAF MODULE, for the reason agent-pace.ts is one: `lib/config.ts` (the
// env loader), `agent-runtime.ts` (the switch itself), `agent-turn-telemetry.ts`
// (the counts this mode contributes to `agent_turn_action_paths`, the same line
// pace's own band counts ride) and the live eval's `_lib/live-config.ts` all
// need this enum, and none of them may import one another to reach it without a
// cycle — agent-runtime.ts already imports VALUES from agent-turn-telemetry.ts,
// so telemetry.ts can only ever import TYPES back from agent-runtime.ts.
//
// The three values are DRIFTSTACK_PLANNING_READ's own vocabulary:
//   `text`               — today's behaviour, byte for byte. The default.
//   `elements`            — the element list is the PRIMARY planning read;
//                            the text digest is read only when the list came
//                            back empty or refused, with today's budget.
//   `elements_then_text`  — both are read, elements first, and the planner is
//                            handed both under a short labelled boundary.
export const PLANNING_READ_MODES = ['text', 'elements', 'elements_then_text'] as const;
export type PlanningReadMode = (typeof PLANNING_READ_MODES)[number];
