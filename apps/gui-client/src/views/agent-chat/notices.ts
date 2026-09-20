// The sentences the AI view says about its own state, in one place.
//
// Stage 0 of the AI-view rebuild (spec §9): moved out of AgentChatView.tsx so
// the composer and the transcript can both say the SAME sentence without either
// importing the view. AgentChatView re-exports every one of them, so a test that
// reads them from there keeps working — and the strings themselves are byte-for-
// byte what shipped.
//
// Customer-facing copy: each names the TASK, never any part of how this is built.

/** (l) #8 — the reattach notice: the composer caption, the notice row and the
 *  disabled Send's title all say the same thing. */
export const REATTACHING_NOTICE = 'Reattaching to the previous session…';
/**
 * P6 — what the composer says between Stop and the stopped turn actually
 * finishing. Stop frees the composer; the task itself keeps running, and a send
 * during that window is refused. Naming the state is the difference between a
 * customer who waits a moment and a customer who gets an error they did nothing
 * to deserve.
 */
export const STILL_FINISHING_NOTICE = 'Still finishing the previous task…';
/**
 * B2 — between pressing Stop and the server ending the turn. The steps that ran
 * stay on screen; the composer comes back the moment the turn's own response
 * says it is over (or, bounded, when that cannot be confirmed).
 */
export const STOPPING_NOTICE = 'Stopping…';
/** B2 — offered beside the still-finishing notice when a Stop could not be confirmed. */
export const STOP_AGAIN_LABEL = 'Try stopping again';
/** (l) #8 — appended when Enter was pressed during the reattach. */
export const SEND_HELD_SUFFIX = 'Your message is kept; Send unlocks when it settles.';
