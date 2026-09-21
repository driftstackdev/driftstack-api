// AI PACE — WHEN an inserted pause happens, and the arithmetic that bounds how
// much of a turn it may spend.
//
// ⛔ A LEAF MODULE. It imports nothing, for the reason `agent-turn-bounds.ts`
// imports almost nothing: the executor, the runtime and the config loader all
// read these numbers, and any one of them importing another to reach them is a
// cycle. Everything here is a pure function of its arguments — the turn's wall
// clock is PASSED IN rather than imported from the runtime, so this file can be
// read, tested and recomputed without loading a turn.
//
// ⛔ WHAT PACE IS NOT. It never changes WHETHER something is allowed. The
// confirmation gate, the pre-tap look, credential substitution, halt-on-first-
// failure, every Stop check, the planner prompt and the plan itself are
// identical in every band. Pace changes WHEN things happen, inside bounds
// nothing here widens.
//
// ⛔ AND NOTHING HERE MAY BE DESCRIBED AS UNDETECTABLE. A drawn pause removes
// the EQUALITY of two spacings — the quantity a detector actually computes —
// and it does not hide the pause. The distribution is narrow and it is ours.
// See also the device fact recorded on {@link AI_PACE_BANDS}: a phone that is
// perfectly still across a long pause is itself a tell, which is why the bands
// past `fast` ship behind a default-off server flag and no customer switch.

/**
 * The three bands, and `fast` is the one that exists today.
 *
 * ⛔ `fast` IS DEFINED AS THE POLICY INSERTING NOTHING. Not "a short pause" —
 * nothing: no draw, no clock read, no dispatch, no telemetry write. That is
 * what makes "the flag off is today, byte for byte" a property a test can hold
 * rather than a sentence, and it is why {@link PacedBand} excludes it from
 * every table below: there is no `fast` row to get wrong.
 *
 * ⚠️ AND IT IS WHY slow AND medium ARE BEHIND A DEFAULT-OFF SERVER FLAG. The
 * device team reported (2026-09-20) that the phone's idle-activity option —
 * net-near-zero micro-scrolls interleaved WITHIN a pause — is OFF by default,
 * so a server-drawn `{duration_ms}` pause is a perfectly frozen phone for its
 * whole duration, and a frozen phone across a long pause is itself a tell.
 * Until idle activity is on for the nodes that serve AI sessions, or the device
 * offers it per dispatch, slow and medium are an experiment we run ourselves
 * (S7), not a setting a customer can reach.
 */
export const AI_PACE_BANDS = ['fast', 'medium', 'slow'] as const;
export type AiPaceBand = (typeof AI_PACE_BANDS)[number];

/** The bands that actually insert something. See {@link AI_PACE_BANDS}. */
export type PacedBand = Exclude<AiPaceBand, 'fast'>;

/** Narrowing helper, so callers do not re-spell the comparison. */
export function isPacedBand(band: AiPaceBand): band is PacedBand {
  return band !== 'fast';
}

// ── THE BUDGET, AND WHY IT CANNOT EAT THE TURN ───────────────────────
//
// `budget = clamp(0, (wallClock − elapsed − RESERVE) × FRACTION, SEGMENT_CAP)`
//
// ⛔ THE FRACTION BELOW 1 IS THE WHOLE PROOF, and it is worth stating as
// arithmetic rather than as a promise. Write R(e) = wallClock − RESERVE − e for
// the time a turn may still spend before it must leave the reserve alone. A
// segment starting at elapsed `e` may insert at most f·R(e), so after inserting
// (and before doing any real work at all) the remaining allowance is at least
// R(e) − f·R(e) = (1 − f)·R(e), which for f < 1 is strictly positive. Inserted
// time therefore approaches the reserve and never reaches it, and once R(e) ≤ 0
// the clamp makes the budget exactly 0 and the turn runs at fast.
//
// The failure mode is "ran out of pause budget and sped up", never "ran out of
// turn". That is what `pace-runs-out-of-budget-before-a-turn-runs-out-of-clock`
// recomputes, from these constants, with no executor in the picture.
//
// ⛔ AND THESE BOUND TIER A ONLY. Every pause this policy asks for is a
// `{duration_ms}` the SERVER drew. A device-drawn shape (`{kind:'reading'}`,
// `{kind:'decision'}`, a bare `{}`) has a duration out of the device's own
// catalogue, which is not in this repo and has no ceiling param on the wire —
// so it cannot sit inside this arithmetic, a Stop-latency argument, or a taper.
// That is Tier B, it is not built, and this file is the reason it cannot be
// switched on by accident: nothing here can express one.

/** What share of the time still spendable a segment may insert. */
export const PACE_FRACTION: Record<PacedBand, number> = { medium: 0.25, slow: 0.45 };

/** The most any ONE segment may insert, whatever the fraction works out to. */
export const PACE_SEGMENT_CAP_MS: Record<PacedBand, number> = { medium: 12_000, slow: 30_000 };

/**
 * The most any ONE inserted pause may last.
 *
 * ⛔ SET BY STOP LATENCY, NOT BY TASTE. A pause is abandoned at once when Stop
 * arrives, but the device keeps pausing (there is no cancel verb on the wire),
 * so the next turn's first dispatch can land on a device still inside a dwell.
 * Nine seconds is comfortably under `STOP_IN_FLIGHT_GRACE_MS` (15 s), which is
 * the window the executor is willing to wait on an in-flight step at all.
 * `a-pause-never-outlasts-the-grace-a-stop-is-given` relates the two.
 */
export const PACE_STEP_CAP_MS: Record<PacedBand, number> = { medium: 4_000, slow: 9_000 };

/**
 * What must remain for real work at the end of a turn: one planner call, a
 * segment of real dispatches, the 10 s read-back and the answering call.
 * Deliberately ONE number for every band — it is a statement about the work,
 * not about the pace.
 */
export const PACE_TURN_RESERVE_MS = 45_000;

/**
 * The smallest pause worth dispatching.
 *
 * ⛔ IT IS NOT TIDYING. Without a floor, a budget with 40 ms left would emit a
 * 40 ms `behavioral_pause` — a whole device round trip to ask for less than the
 * round trip costs, and, worse, a pause whose duration is the REMAINDER rather
 * than a draw. A remainder is a constant in disguise: every turn would end with
 * the same shaped last beat. Below this, the policy inserts nothing.
 */
export const PACE_MIN_PAUSE_MS = 250;

/**
 * One segment's inserted-time allowance.
 *
 * `turnWallClockMs` is passed rather than imported: this module must not import
 * the runtime (which imports the executor, which imports this). The one
 * production caller passes `MAX_TURN_WALL_CLOCK_MS`, and
 * `pace-runs-out-of-budget-before-a-turn-runs-out-of-clock` checks that the
 * number the runtime actually spends matches the one recomputed from it.
 *
 * Fails toward zero on any unusable input: a NaN clock must degrade to "no
 * pace", never to an unbounded sleep inside a customer's turn.
 */
export function paceSegmentBudgetMs(args: {
  band: PacedBand;
  elapsedMs: number;
  turnWallClockMs: number;
}): number {
  const { band, elapsedMs, turnWallClockMs } = args;
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(turnWallClockMs)) return 0;
  const spendable = turnWallClockMs - Math.max(0, elapsedMs) - PACE_TURN_RESERVE_MS;
  if (!(spendable > 0)) return 0;
  return Math.max(
    0,
    Math.min(PACE_SEGMENT_CAP_MS[band], Math.floor(spendable * PACE_FRACTION[band])),
  );
}

/**
 * The largest BASE a draw may be handed, so the drawn value cannot reach the
 * per-step cap.
 *
 * ⛔ WHY THE CAP MUST NEVER BE REACHED. Clamping a draw at the cap piles every
 * long page onto one exact number, and a repeated exact number is the signature
 * a drawn band exists to remove — the cap would manufacture the constant the
 * policy is there to avoid. So the base is lowered until the band's own maximum
 * multiplier lands under the cap, and the cap becomes a bound that is proved
 * rather than a value that is emitted.
 *
 * `maxFactor` is the executor's `DRAWN_GAP_MAX_FACTOR`, passed in for the leaf
 * reason above.
 */
export function paceBaseCeilingMs(band: PacedBand, maxFactor: number): number {
  if (!Number.isFinite(maxFactor) || maxFactor <= 0) return PACE_STEP_CAP_MS[band];
  return Math.floor(PACE_STEP_CAP_MS[band] / maxFactor);
}

// ── THE BEATS ────────────────────────────────────────────────────────

/** The four places a person's rhythm has a beat that this policy can supply. */
export const PACE_BEAT_KINDS = ['reading', 'field_to_field', 'decision', 'idle'] as const;
export type PaceBeatKind = (typeof PACE_BEAT_KINDS)[number];

/**
 * A step, as the policy needs to see it. Deliberately coarser than `AgentIntent`
 * — the policy decides on the SHAPE of a step, never on its selector, its URL
 * or anything a page or a model wrote.
 */
export type PaceStepShape =
  | 'navigate'
  | 'tap'
  | 'type'
  | 'press'
  | 'scroll'
  | 'wait'
  | 'capture'
  | 'pause'
  | 'other';

/**
 * READING TIME FOLLOWS THE PAGE, NOT THE STEP NUMBER — the primary falsifiable
 * property of the whole feature, and the reason the digest's word count is
 * threaded through the runtime at all.
 *
 * ⛔ THE RATE IS DERIVED, NOT CHOSEN — AND IT IS DERIVED AGAINST THE BASE
 * CEILING, NOT AGAINST THE PER-STEP CAP. That distinction is the whole of it,
 * and getting it wrong is silent: the executor never hands a draw the raw base,
 * it hands `min(base, paceBaseCeilingMs(band, DRAWN_GAP_MAX_FACTOR))`, which is
 * `PACE_STEP_CAP_MS[band] / 1.45` — 6,206 ms on slow and 2,758 ms on medium.
 * A rate derived against the CAP (9,000 / 4,000) clears a number the code never
 * compares against, and every page above `ceiling / rate` words then draws the
 * SAME base. That is the failure {@link paceBaseCeilingMs} exists to prevent,
 * one level down: the ceiling stops manufacturing a constant at the cap and
 * starts manufacturing one at the ceiling, on exactly the long pages the
 * reading beat is for.
 *
 * The arithmetic, per band:
 *   · the planner's digest is capped at `MAX_PAGE_DIGEST_CHARS` (4,000) chars;
 *   · at ~6 characters per word that is at most 667 words. ⚠️ **AND 6 IS AN
 *     ASSUMPTION, NOT A MEASUREMENT — it is the one residual in this
 *     derivation, and it is stated rather than left to be discovered.** A rate
 *     that clears the ceiling at 6 clears it at any LARGER figure, so the
 *     assumption fails only in one direction: a digest averaging FEWER than
 *     ~6.2 (slow) or ~6.2 (medium) characters per whitespace-separated token —
 *     `countDigestWords` splits on whitespace — packs more than 667 tokens into
 *     the cap and re-enters the plateau. The digest is element rows plus page
 *     text (`[12] button "Continue" (#submit)`), which runs well above that,
 *     but nothing here has MEASURED it: the offline corpus produces no near-cap
 *     digest, so the first place a real one is seen is S7. To close it, measure
 *     the minimum characters-per-token the digest builder actually produces and
 *     set the rate from that number instead of from 6;
 *   · so the rate must satisfy `667 × rate ≤ paceBaseCeilingMs(band, 1.45)`:
 *       slow   667 × 9 = 6,003 ≤ 6,206 ✓   (9.30 is the exact bound)
 *       medium 667 × 4 = 2,668 ≤ 2,758 ✓   (4.13 is the exact bound)
 *
 * So the LARGEST page this server can ever see still draws a base below the
 * ceiling, reading time follows the page across the WHOLE digest range rather
 * than flattening at its top, and the per-step cap stays a bound that is proved
 * instead of a value that is emitted. `reading-time-follows-the-page-not-the-
 * step-number` recomputes both lines rather than restating them.
 *
 * ⚠️ PER BAND, AND THAT IS NOT A SECOND KNOB — it is the same derivation run
 * against each band's own ceiling. Slow reads a page for longer than medium
 * does, which is what the bands are; medium's tighter per-step cap (4,000 ms,
 * set by Stop latency) is what makes its rate the smaller number.
 *
 * It is not a claim about human reading speed, and it is not offered as one.
 */
export const READING_MS_PER_WORD: Record<PacedBand, number> = { medium: 4, slow: 9 };

/** A page with almost no words is still a page somebody looked at. */
export const READING_FLOOR_MS = 350;

/** Between two consecutive typed steps. */
export const FIELD_TO_FIELD_BASE_MS = 700;

/** Before the first tap or key press after typing — the longer band, because
 *  that is the step that commits what was typed. */
export const DECISION_BASE_MS = 1_800;

/** Anywhere else a site can see a step. */
export const IDLE_BASE_MS = 1_200;

/**
 * How often a page arrival gets a reading beat.
 *
 * ⛔ THE DECISION TO PAUSE IS ITSELF A DRAW. Pausing after EVERY arrival is a
 * regular rhythm even when every duration differs, so medium pauses on about
 * half of them. Slow reads every page it arrives on, which is what slow means.
 */
export const READING_BEAT_CHANCE: Record<PacedBand, number> = { medium: 0.5, slow: 1 };

/** How often an ordinary site-visible step gets an unmotivated idle beat. */
export const IDLE_BEAT_CHANCE: Record<PacedBand, number> = { medium: 0.05, slow: 0.12 };

/**
 * What beat, if any, belongs in front of this step — the whole policy table,
 * as one pure function.
 *
 * `chance` is a unit draw in [0, 1) the caller has already taken from the
 * session's own generator. It is passed in rather than drawn here so this
 * function stays pure and the ORDER of draws stays visible at the one call
 * site, which is what makes "the flag off takes no draw" checkable by reading.
 *
 * Returns the beat and its UNBOUNDED base; the caller bounds it (per step, per
 * segment) and draws around it.
 */
export function paceBeatFor(args: {
  band: PacedBand;
  /** The step a pause would go in front of. */
  step: PaceStepShape;
  /** The step before it IN THE SAME SEGMENT; null at a segment's first step. */
  previous: PaceStepShape | null;
  /**
   * Words on the page this segment was PLANNED AGAINST, or null when the turn
   * has not read a page yet.
   *
   * ⚠️ STATED APPROXIMATION: within a segment that navigates, this is still the
   * page the segment was planned against, not the page just arrived on — the
   * server has not read the new one and will not spend a dispatch to. It is a
   * page-derived number either way, which is the property under test; it is not
   * claimed to be the word count of the page now on screen.
   */
  pageWordCount: number | null;
  /** One draw in [0, 1) from the session's generator. */
  chance: number;
}): { beat: PaceBeatKind; baseMs: number } | null {
  const { band, step, previous, pageWordCount, chance } = args;
  const unit = Number.isFinite(chance) && chance >= 0 && chance < 1 ? chance : 0.5;

  // A person hesitates before committing what they just typed. Always, in both
  // bands — this is the beat the policy is most confident about.
  if (previous === 'type' && (step === 'tap' || step === 'press')) {
    return { beat: 'decision', baseMs: DECISION_BASE_MS };
  }
  // Field to field.
  if (previous === 'type' && step === 'type') {
    return { beat: 'field_to_field', baseMs: FIELD_TO_FIELD_BASE_MS };
  }
  // A page has just been arrived on: either this segment began on one (the
  // runtime read it to plan this segment) or the step before this one navigated.
  if (previous === null || previous === 'navigate') {
    if (pageWordCount !== null && unit < READING_BEAT_CHANCE[band]) {
      return {
        beat: 'reading',
        baseMs: Math.max(READING_FLOOR_MS, Math.round(pageWordCount * READING_MS_PER_WORD[band])),
      };
    }
    return null;
  }
  // Anything else a site can see.
  if (unit < IDLE_BEAT_CHANCE[band]) return { beat: 'idle', baseMs: IDLE_BASE_MS };
  return null;
}

/**
 * The TURN's pace state: what band it runs at, what this segment may still
 * spend, the page it was planned against, and what it has spent so far.
 *
 * ⛔ OWNED BY THE RUNTIME, for the reason `elementWaitBudget` and
 * `commitmentBudget` are: a turn runs up to three plans, and a budget built
 * inside `execute()` would be three budgets — the taper, which is the single
 * property that keeps pace from being the last straw, would silently stop
 * holding. The runtime re-seeds `segmentRemainingMs` before every segment from
 * {@link paceSegmentBudgetMs} and never resets the totals.
 */
export interface PaceBudget {
  readonly band: PacedBand;
  /** What THIS segment may still insert. Re-seeded per segment, debited per
   *  pause, and never negative. */
  segmentRemainingMs: number;
  /** The digest's word count for the page this segment was planned against. */
  pageWordCount: number | null;
  /** C8 — has the customer been shown a step yet THIS TURN? Nothing is ever
   *  inserted before the first one, so `time_to_first_progress_ms` cannot be
   *  degraded by pace. Set by the executor as it emits. */
  anyStepEmitted: boolean;
  /** Telemetry, per turn. Pauses that were dispatched and answered. */
  insertedPauses: number;
  pausedMs: number;
}

export function newPaceBudget(band: PacedBand): PaceBudget {
  return {
    band,
    segmentRemainingMs: 0,
    pageWordCount: null,
    anyStepEmitted: false,
    insertedPauses: 0,
    pausedMs: 0,
  };
}

/**
 * The digest's word count.
 *
 * ⛔ COUNTED OFF THE DIGEST, WHICH IS BOUNDED, and that is half the reason the
 * reading band is bounded at all. The digest the planner is shown is capped at
 * `MAX_PAGE_DIGEST_CHARS`, so this can never return a number a whole-document
 * read could produce. Null for an absent or empty digest, which the policy
 * reads as "no page to read yet" rather than as zero words.
 */
export function countDigestWords(digest: string | undefined | null): number | null {
  if (digest === undefined || digest === null) return null;
  const trimmed = digest.trim();
  if (trimmed.length === 0) return null;
  return trimmed.split(/\s+/u).length;
}
