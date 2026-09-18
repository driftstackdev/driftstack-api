// The join between the executor's TWO index spaces, in one place, with a name.
//
// ⛔ THE PROBLEM THIS EXISTS FOR. The executor announces a step START on the PLAN
// index (`args.onStepStart?.(intent, planIndex)`,
// agent-executor-control-plane.ts:186) and reports a step RESULT on
// `results.length - 1` (:153). Those are two different index spaces. Every
// attempt count in the eval report is the difference between a start mark and an
// end mark — a join across them, previously written with no check that they line
// up and a `?? previousEnd ?? 0` fallback that turned a mis-key into a confident
// number rather than a failure.
//
// They agree TODAY only because every announced plan index happens to emit
// exactly one result. That is a property of the executor's control flow, not of
// any contract, and it is exactly the kind of property that changes without
// anybody noticing the report changed with it.
//
// So: the start mark is held PENDING and attached to the result it belongs to as
// that result lands, which puts both marks in ONE space by construction, and
// anything that does not fit is NAMED rather than absorbed.
//
// The one legitimate shape with no start is the consequential-action halt: the
// gate emits its result BEFORE announcing the step, deliberately, because
// announcing first told the customer the agent was doing the very thing the gate
// was blocking. Nothing is dispatched for such a step, so start equals end —
// stated here, not inferred from a neighbour's mark.
//
// ⛔ AND THE HALT'S MISSING START IS NOW RECORDED, NOT PAPERED OVER. Setting
// `startMarks[i] = end` makes the halted step read as ZERO ATTEMPTS, which is
// the right number for the wrong reason: it is zero because nothing was ever
// announced, not because the harness measured a step that dispatched nothing.
// Those two are indistinguishable downstream, and the one case that difference
// matters for is exactly the one F6's criterion rests on. So every result that
// arrived without a start is named in {@link StepMarkTracker.noStartAnnounced},
// the scorer carries it onto the step as `startAnnounced: false`, and F6's
// criterion stops trusting the attempt count and asks the DISPATCH LOG instead.

/** What a result looks like to the tracker. Narrow on purpose: the tracker must
 *  not be able to reach anything but the one discriminator it needs. */
export type ResultKindForMarks = 'success' | 'failure' | 'confirmation_required';

export class StepMarkTracker {
  readonly startMarks = new Map<number, number>();
  readonly endMarks = new Map<number, number>();
  readonly planIndexForResult = new Map<number, number | null>();
  /**
   * Result indices that arrived with NO step_start announced.
   *
   * ⛔ THE POINT IS THAT IT IS A SET AND NOT A SILENCE. A step with no start has
   * no measured attempt count at all; `startMarks` is filled with the end mark
   * so the arithmetic downstream stays defined, and membership here is what
   * distinguishes "measured zero dispatches" from "nothing was measured".
   */
  readonly noStartAnnounced = new Set<number>();
  readonly anomalies: string[] = [];

  private pending: { planIndex: number; mark: number } | null = null;

  /**
   * Where the look before a tap began, when one is in flight for a step not yet
   * announced.
   *
   * ⛔ THE LOOK BELONGS TO THE STEP AFTER IT. The executor looks at a tap's
   * target BEFORE the confirmation gate — the gate reads what the look says —
   * and announces the step only AFTER the gate, so the look's dispatches land
   * before the step's start. Marked from the step's announce, they would belong
   * to no step: a tap the look refused would read as "nothing dispatched" and
   * die unclassified. So the first look after a result opens the step's span.
   */
  private lookMark: number | null = null;

  /** A look before a tap is about to be dispatched (log length BEFORE it). */
  lookStarted(dispatchLogLength: number): void {
    if (this.pending !== null) return; // inside an announced step: already its span
    this.lookMark ??= dispatchLogLength;
  }

  /** The executor announced a step, keyed on the PLAN index. */
  stepStarted(planIndex: number, dispatchLogLength: number): void {
    if (this.pending !== null) {
      this.anomalies.push(
        `plan index ${String(planIndex)} started while plan index ${String(this.pending.planIndex)} had produced no result — a step vanished and its dispatches would be attributed to the next one`,
      );
    }
    this.pending = { planIndex, mark: this.lookMark ?? dispatchLogLength };
    this.lookMark = null;
  }

  /** The executor produced a result, keyed on the RESULTS index. */
  stepFinished(resultIndex: number, kind: ResultKindForMarks, dispatchLogLength: number): void {
    this.endMarks.set(resultIndex, dispatchLogLength);
    if (this.pending === null) {
      // Recorded FIRST, so the absence is a fact in the report rather than an
      // inference a reader has to make from a zero.
      this.noStartAnnounced.add(resultIndex);
      // A halt the look's own reading raised DID dispatch something — the look —
      // and the span says so rather than reading as zero.
      this.startMarks.set(resultIndex, this.lookMark ?? dispatchLogLength);
      this.lookMark = null;
      this.planIndexForResult.set(resultIndex, null);
      if (kind !== 'confirmation_required') {
        this.anomalies.push(
          `result ${String(resultIndex)} (${kind}) arrived with no step_start; only a consequential halt may do that`,
        );
      }
      return;
    }
    this.startMarks.set(resultIndex, this.pending.mark);
    this.planIndexForResult.set(resultIndex, this.pending.planIndex);
    if (this.pending.planIndex !== resultIndex) {
      this.anomalies.push(
        `plan index ${String(this.pending.planIndex)} produced results index ${String(resultIndex)} — the two index spaces have diverged and every attempt count in this run is a join across them`,
      );
    }
    this.pending = null;
  }

  /** Called once the turn is over. A start with no result is not an anomaly on
   *  its own — the turn can legitimately end mid-step when authority is lost —
   *  but it IS a step whose dispatches are attributed to nothing, so say so. */
  finish(): void {
    if (this.pending === null) return;
    this.anomalies.push(
      `plan index ${String(this.pending.planIndex)} started and never produced a result — any dispatches it made are unattributed`,
    );
    this.pending = null;
  }
}
