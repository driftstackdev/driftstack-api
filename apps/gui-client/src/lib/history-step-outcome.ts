// What the back/forward buttons should say when a history step does not apply.
//
// ⛔ WHY THIS IS A FUNCTION AND NOT THREE LINES AT THE CALL SITE. The call site
// used to be `void navigateAgentSessionHistory(...).catch(...)` — only the
// TRANSPORT failure was handled, and the resolved body was dropped on the floor.
// The route builds a discriminated 200 for every outcome and puts a customer-safe
// sentence in `reason`; `NavigateHistoryResult`'s own doc says those statuses are
// what "the back/forward buttons surface calmly". Nothing read them. So a step
// that failed for a plain, explainable reason — the session is not running, the
// device could not be reached — rendered as a dead button: no notice, no
// explanation, the loading bar still lit until an unrelated watchdog eventually
// offered a Retry.
//
// Pulling the decision out here makes it testable against a REAL-shaped result.
// The existing simulator tests mock the call as `vi.fn(() => Promise.resolve())`,
// which resolves `undefined` — a mock that cannot express the contract it stands
// in for, and therefore cannot fail when the contract is ignored.

import type { NavigateHistoryResult } from './agent-session-control';

/**
 * The notice to show for a history step's outcome, or `null` for "say nothing".
 *
 * `null` is returned in the two cases where a message would be WRONG, not merely
 * unnecessary:
 *
 *  - `ok` — the step applied; the page-state frames drive the UI from here.
 *  - `timeout` — the device did not answer inside the request budget. That is not
 *    a failure, it is an ABSENCE of an answer: the step may still land. Saying
 *    "could not go back" would assert an outcome nobody measured, and the armed
 *    load watchdog is the instrument that can actually observe a stuck step.
 *
 * `unavailable` and `error` are definite — the server knows the step did not
 * happen — so they surface, preferring the server's own sentence over a generic
 * one, because it is the half that tells the customer WHY.
 */
export function historyStepNotice(
  result: NavigateHistoryResult | undefined,
  direction: 'back' | 'forward',
): string | null {
  const fallback = `Could not go ${direction}`;
  // A transport that resolves nothing has not reported success — it has reported
  // nothing, and the honest reading of nothing is not "it worked".
  if (result === undefined) return fallback;
  if (result.status === 'ok' || result.status === 'timeout') return null;
  const reason = result.reason;
  return reason !== undefined && reason.trim() !== '' ? reason : fallback;
}
