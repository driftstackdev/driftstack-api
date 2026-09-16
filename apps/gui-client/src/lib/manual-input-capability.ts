/**
 * The THREE states of the device's `manual_input_available` signal, derived ONCE
 * for every surface that speaks about whether the phone accepts taps.
 *
 * ⛔ The defect this closes (owner report 2026-09-16): an ABSENT capability
 * report read as NOTHING. When the device reports `manual_input_available:
 * false` the simulator shows a badge ("View only — device input is unavailable")
 * and a matching keyboard tooltip. When the report NEVER ARRIVES, the value was
 * simply `undefined`, every `=== false` test was false, and the customer saw an
 * indefinite "connecting…" with no statement at all — a healthy-but-slow session
 * and a session whose phone never said a word rendered identically. The owner
 * closed theirs after 33 seconds having been told nothing.
 *
 * That is the mirror of asserting a field as a measurement: here ABSENCE reads
 * as fine. A two-valued `=== false` test over a three-valued signal structurally
 * cannot say "not yet", so the tri-state is NAMED here instead of being spelled
 * out at each callsite — and the "we have not been told" state gets copy of its
 * own, distinct from the device's explicit "input is unavailable".
 *
 * ⛔ 'unreported' covers BOTH "no capability report at all" (the report key is
 * omitted from GET /v1/agent-sessions/:id until the device sends one, and
 * `capabilityReportOf` then yields undefined) AND "a report that carried no
 * manual_input_available" (the parser maps a missing or wrong-typed key to
 * null). Those are the same customer-facing fact — the phone has not told us —
 * and NEITHER may ever render as available.
 *
 * Kept OUT of SimulatorWindow.tsx (a ~10k-line file mocked by ~17 suites) so the
 * derivation is unit-testable on its own and no SimulatorWindow export can break
 * those mocks — mirrors lib/capability-report-equal.ts and lib/url-bar-inflight.ts.
 *
 * ⛔ SHARED, deliberately: this is conjunct (E) of the simulator's
 * `ownsManualInputAuthority` — the one predicate that unlocks both the address
 * bar and remote control. A surface that explains WHY control is still locked
 * must read the same three states from here rather than re-deriving
 * `capability_report?.manual_input_available === true`, or the explanation and
 * the gate can disagree about the same session.
 */

/** available = the phone said it accepts input; unavailable = the phone said it
 *  does NOT; unreported = the phone has not said either way (no report yet, or a
 *  report without the field). `unreported` is never a synonym for `unavailable`:
 *  one is the device's answer, the other is the absence of one. */
export type ManualInputCapability = 'available' | 'unavailable' | 'unreported';

/**
 * The tri-state from the raw flag as the client parser produces it: `true` /
 * `false` when the device answered, `null` when a report arrived without a
 * usable value, `undefined` when there is no report at all.
 */
export function manualInputCapabilityFromFlag(
  flag: boolean | null | undefined,
): ManualInputCapability {
  if (flag === true) return 'available';
  if (flag === false) return 'unavailable';
  return 'unreported';
}

/**
 * The tri-state for a session's capability report — `null`/`undefined` (no
 * report has arrived) is 'unreported', never 'unavailable' and never available.
 */
export function manualInputCapabilityOf(
  report: { manual_input_available: boolean | null } | null | undefined,
): ManualInputCapability {
  return manualInputCapabilityFromFlag(report?.manual_input_available);
}

/** The device's EXPLICIT negative — it reported, and the answer was no. */
export const MANUAL_INPUT_UNAVAILABLE_BADGE = 'View only — device input is unavailable';

/** ⛔ The ABSENCE — deliberately different words from the explicit negative
 *  above, because it is a different fact: nobody has said input is unavailable,
 *  and nobody has said it works either. It names what we are waiting for, so an
 *  indefinite wait is legible instead of silent. */
export const MANUAL_INPUT_UNREPORTED_BADGE =
  'Waiting on the phone — it has not reported yet whether it can accept taps';

/** The same absence in the Session pane's mode caption, where the alternative
 *  ("Manual — tap the screen to drive") CLAIMS input works. */
export const MANUAL_INPUT_UNREPORTED_CAPTION =
  'Manual — the phone has not reported yet whether it can accept taps';

/** The same absence as the keyboard toggle's tooltip + label, where the old copy
 *  blamed the agent ("The agent is driving — switch to Manual to type") for a
 *  session already in Manual whose phone had simply not answered. */
export const MANUAL_INPUT_UNREPORTED_TOOLTIP =
  'The phone has not reported yet whether it can accept taps — input stays off until it does';
export const MANUAL_INPUT_UNREPORTED_LABEL =
  'Keyboard unavailable — the phone has not reported yet whether it can accept taps';

/**
 * ⛔ THE ABSENCE HAS A LIFETIME. Every sentence above is a statement about a
 * session that is still running; none of them may be spoken about one that is
 * over. The control plane deliberately stops projecting the capability report
 * the moment a session closes (`if (rec.status !== 'closed')` in
 * routes/agent-sessions.ts), so a phone that reported `manual_input_available:
 * true` for an entire session arrives at the client, after it ends, as
 * 'unreported'. Rendering the wait wording there states OUR OWN serialisation
 * rule as the device's silence, and promises that input stays off "until it
 * does" for a device that will never report again — this item's failure mode
 * inverted: a verdict we were given, erased, and re-read as an absence.
 *
 * So the ended session gets its own caption, and the badge/tooltip that speak
 * about the report are suppressed outright (SimulatorWindow gates them on
 * lib/manual-input-wait's `input-unreported` group, which a terminal session
 * never reaches — `ended` is answered first).
 */
export const MANUAL_INPUT_SESSION_OVER_CAPTION = 'Manual — this session has ended';
