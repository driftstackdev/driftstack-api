// THE FOUR NUMBERS THAT DECIDE HOW LONG ONE AI TURN CAN STILL BE RUNNING.
//
// They live here, together and in a module that imports nothing from the turn,
// for one reason: the cross-process stop claim's TTL has to be DERIVED from them
// (agent-turn-stop-channel.ts), and the claim channel cannot import the runtime,
// the executor or the planner without importing the thing that imports it back.
// A leaf module is what lets the arithmetic be real instead of asserted.
//
// ⛔ WHY THAT MATTERS. The TTL used to be a literal justified in prose as
// "several times the longest turn that can exist" — and the arithmetic said
// otherwise by ten minutes. A comment that certifies a stale premise as a
// checked one is worse than no comment, because everyone downstream reads it as
// evidence. The guard is `the-stop-claim-outlives-the-longest-turn-the-
// constants-permit`, which fails the day one of these grows past the TTL.

import {
  HARNESS_INTENT_NAMES,
  type HarnessIntentName,
} from '../schemas/harness-control-protocol.js';
import { dispatchTimeoutMs } from './harness-dispatch-correlator.js';

/**
 * The turn's HARD stop: past this, the executor's step loop starts no further
 * step and returns between steps.
 *
 * ⛔ NOT THE SAME BOUND AS `MAX_TURN_WALL_CLOCK_MS` (three minutes), and it does
 * not replace it. That one stops the turn asking for a NEW SEGMENT; it is
 * checked at the top of the turn loop, so a segment already running is outside
 * it entirely. The executor's step loop had no clock at all, which is how eight
 * steps each pausing near the device's 300 s cap, each with a 315 s dispatch
 * deadline, could spend ~40 minutes inside ONE segment before reaching the bound
 * that would have refused segment 2. This is the bound that stops that, and it
 * costs nothing in the ordinary case because the three-minute bound gets there
 * first whenever the turn is asking for more work.
 *
 * Five minutes: comfortably past the three-minute point where the turn stops
 * starting segments, so an ordinary turn never meets it, and short enough that a
 * customer watching a chat is not left with tens of minutes of nothing.
 *
 * ⛔ ONE VALUE, THREADED AS A DEADLINE. The executor is told `turnHardStopAtMs`
 * — an instant, not a duration — because a turn runs up to three plans and a
 * per-run duration would silently be three hard stops (the same trap the
 * element-wait budget was rebuilt to avoid). The runtime computes that instant
 * from this constant at the top of the turn, so a per-pace value later replaces
 * one expression in one place and the executor never learns a new concept.
 */
export const TURN_HARD_STOP_MS = 300_000;

/**
 * The longest a single dispatch can hold the wire — the correlator's own
 * per-intent deadline, maximised over every intent name the protocol defines.
 *
 * ⛔ COMPUTED WITH THE CORRELATOR'S OWN FUNCTION, never re-derived from the
 * producer budgets beside it. A second copy of that arithmetic is a number that
 * agrees today and drifts silently the day one class of intent gets its own
 * budget.
 *
 * Today's maximum is `login`/`search` (600 s producer deadline + transport
 * slack), and no AgentIntent maps onto either of those names — the longest a
 * PLAN step can actually dispatch is 315 s. So this term already carries about
 * five minutes of headroom over the worst real step, which is where a step's own
 * bounded retries are absorbed.
 */
export const LONGEST_DISPATCH_DEADLINE_MS: number = Math.max(
  ...HARNESS_INTENT_NAMES.map((name: HarnessIntentName) => dispatchTimeoutMs(name)),
);

/**
 * The read-back deadline. `get_page_source` on a healthy box returns in under
 * 2 s; a hung one would otherwise burn the full 30 s dispatch budget AFTER the
 * plan has already succeeded and been recorded. Ten seconds cleanly separates
 * "alive but slow" from "hung", so the read-back degrades to "no answer, the
 * plan result stands" fast instead of freezing the turn.
 *
 * Read by the control-plane executor as its observe timeout, and by the claim
 * TTL below as the read that can still be in flight after the last step.
 */
export const TURN_READ_BACK_TIMEOUT_MS = 10_000;

/**
 * The PLANNING read's own budget — the look between segments that the
 * planner is shown, as opposed to {@link TURN_READ_BACK_TIMEOUT_MS}'s look at
 * the very end that only improves an already-succeeded plan result.
 *
 * ⛔ WHY A SEPARATE, LARGER NUMBER. The read-back degrades cheaply: the plan
 * already succeeded, so a slow read just costs the answer. A planning read
 * that gives up too early instead throws away the one thing that keeps a
 * turn from guessing — incident: a production turn raced `get_page_source`
 * against the read-back's own 10 s budget between EVERY segment, lost the
 * race five times running (7.5 s average against the 10 s cap), and planned
 * five blind `wait_for`s before the no-progress guard stopped it on a page
 * that was never read. 25 s is comfortably past that observed p-something-
 * slow tail while staying far inside the correlator's own 30 s per-intent
 * budget for `get_page_source`, so the read can still time out on a box that
 * really is hung rather than wait the full 30 s twice (see the retry in
 * agent-runtime.ts).
 *
 * ⛔ CHECKED AGAINST THE TURN'S HARD STOP BEFORE IT STARTS, NOT AFTER. A
 * planning read that were allowed to start unconditionally could run the hard
 * stop out by its own budget on top of whatever else the turn had already
 * spent — so the runtime asks `turnHardStopAtMs` before EVERY planning read
 * (the first segment's look and every re-plan's), the same way the step loop
 * asks it before every step. That is what keeps the line below true: this
 * budget is smaller than {@link LONGEST_DISPATCH_DEADLINE_MS}, the one
 * dispatch the composed worst-case turn already allows past the hard stop, so
 * a planning read can only ever be the SMALLER of the two overruns already
 * being carried — never a second one stacked on top.
 */
export const PLANNING_OBSERVE_TIMEOUT_MS = 25_000;

/**
 * The absolute cap on one streamed model call — the answering call is the last
 * thing a turn does, and it starts after everything above has already run.
 *
 * The streamed planner uses an IDLE timer as its real discriminator (silence,
 * re-armed by every delta); this is the backstop that ends a stream which is
 * genuinely stuck, and so it is the term that belongs in a worst-case turn.
 */
export const TURN_ANSWER_STREAM_CAP_MS = 300_000;

/**
 * The longest a turn can still be running, as its four bounds actually compose:
 * the step loop stops starting steps at the hard stop, the step that started
 * just before it runs to its own dispatch deadline, the read-back follows, and
 * the answering call streams to its absolute cap.
 *
 * ⛔ ONE DISPATCH IN THAT TAIL, AND THE EXECUTOR IS WHAT MAKES THAT TRUE. A step
 * is not one dispatch: its retry budgets (two general retries, eight cold-start
 * retries, one element wait) can each send a fresh one with its own deadline, so
 * read as arithmetic alone this line would be short by two more dispatch
 * deadlines — a `wait` retried twice at the `wait_for` deadline is ~945 s where
 * this models 615 s. `runIntent` asks this same hard stop before starting
 * another attempt, which is what leaves exactly one dispatch past the deadline.
 * Move that check and this number stops being true.
 *
 * ⛔ STILL NOT A WORST-CASE PROOF, AND SAID SO. The pre-tap look, the debits and
 * transcript writes, and the clock skew between the process that writes the
 * claim and the one that reads it are not modelled here; they are what the
 * margin on the TTL is for. It IS the composition C4 asked for, and it is the
 * number the claim TTL is derived from rather than compared against by eye.
 *
 * ⛔ A PLANNING READ IS NOT A FIFTH TERM, AND `turnHardStopAtMs` IS WHY. Every
 * planning read (the first segment's look, and every re-plan's — including its
 * one retry) is asked whether the turn's hard stop has already passed BEFORE
 * it is allowed to start; see the runtime's segment loop. So a planning read
 * can only ever push the clock past the hard stop by its OWN budget,
 * {@link PLANNING_OBSERVE_TIMEOUT_MS} (25 s) — and that is smaller than
 * {@link LONGEST_DISPATCH_DEADLINE_MS} (615 s today), the one dispatch this
 * line already carries past the hard stop for the step that started just
 * before it. The two overruns are never stacked: a planning read that starts
 * at all proves the hard stop had not yet been reached, so its 25 s is the
 * SMALLER of the two amounts this composition already allows for, not an
 * additional one. Move the hard-stop check off the front of a planning read
 * and this stops being true, exactly as moving it off `runIntent`'s retries
 * would.
 */
export const LONGEST_TURN_THE_CONSTANTS_PERMIT_MS =
  TURN_HARD_STOP_MS +
  LONGEST_DISPATCH_DEADLINE_MS +
  TURN_READ_BACK_TIMEOUT_MS +
  TURN_ANSWER_STREAM_CAP_MS;
