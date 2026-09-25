// The mark a SUCCESSFUL step is drawn with: a tick, or — when the server says
// there is something worth knowing about the step — a warning.
//
// A navigation the site answered with 400 or above is a success that carries
// `warning` (a page asking to sign in or to complete a verification step, or a
// whole app served under an error status, are all pages the task can go on
// from). A plain green ✓ on that row would say everything went as planned when
// the site said otherwise, and a red ✗ would claim a failure nobody knows
// about. So the row gets the ⚠ drawing in the warning colour, and its summary
// says in words what the site answered — colour is never the only signal.
//
// ONE helper, read at every place a finished step's glyph is chosen (the
// timeline row and its step line in PlanTimeline, the step bars in Turn), so
// the three can never disagree about which steps were clean.

import type { AgentIntentResult } from '@driftstack/sdk';

export interface StepMark {
  glyph: '✓' | '⚠';
  tone: 'done' | 'warn';
}

/**
 * The mark for a step that SUCCEEDED. Any warning counts, including a kind this
 * build has never heard of: the set is open, and an unknown note is still a
 * note — drawing it as a clean tick would hide exactly the step the server
 * flagged. Only a success is marked here; the other kinds keep their own
 * glyphs where they are drawn.
 */
export function stepMark(result: AgentIntentResult): StepMark {
  return result.kind === 'success' && result.warning !== undefined
    ? { glyph: '⚠', tone: 'warn' }
    : { glyph: '✓', tone: 'done' };
}

/** The ⚠ drawing for a warned step's node: the same drawing surface, stroke
 *  and caps as the rest of the AI view's icons (icons.tsx), so it never reads
 *  as a second icon set. `aria-hidden` and without a `<title>`: the row's own
 *  words say what the site answered. */
export function IconWarn(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      className="ai-i"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2.9 13.7 12.7H2.3Z M8 6.6v2.7 M8 11.2v.05" />
    </svg>
  );
}
