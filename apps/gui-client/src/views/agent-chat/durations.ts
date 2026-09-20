// How long a turn took, and how long each of its steps took — in words.
//
// Stage 3 of the AI-view rebuild (spec §7) gives the timeline a clock. Both
// functions here exist to enforce ONE rule, which is why they are pure and
// separate from the components that call them:
//
//   ⛔ AN UNKNOWN DURATION IS AN ABSENCE, NEVER A ZERO.
//
// The timings are what THIS client observed. A restored chat has none, a chat
// stored by an older build has none, a response the server replayed from its
// idempotency store has none, and a step whose start frame never arrived has
// none. Every one of those must render as nothing at all: "0.0s" under a step
// that took four seconds is not a smaller truth than "4.0s", it is a false one,
// and a row of zeros reads as "the product is broken" rather than "the product
// wasn't watching". So each function returns `null` for everything it cannot
// state, and every call site renders nothing when it gets one.

/**
 * The smallest duration worth printing, in ms. Below this the one-decimal form
 * rounds to "0.0s" — a measured 12 ms step would claim to have taken no time —
 * so the row stays silent instead. (It is also the range where the number is
 * mostly this client's own render latency, and says nothing about the page.)
 */
const FLOOR_MS = 50;

/** Past this, a one-decimal second count is noise and a clock reads better. */
const CLOCK_FROM_MS = 60_000;

/** Whether a value is a duration at all: a real, finite, non-negative number.
 *  `null`, `undefined`, NaN and a negative clock skew are all "not measured". */
function measured(ms: number | null | undefined): ms is number {
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0;
}

/** `m:ss`, the shape the flight strip's meta uses ("0:41", "1:12"). Minutes are
 *  not wrapped at 60: a turn is capped near 50 minutes, and "62:03" is still
 *  unambiguous where "2:03" after an hour would be a lie. */
function clock(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}

/**
 * How long ONE step took, for the mono chip at the end of its row — "3.1s",
 * "14.6s", "2:04" — or null when there is nothing honest to print.
 */
export function formatStepDuration(ms: number | null | undefined): string | null {
  if (!measured(ms)) return null;
  if (ms < FLOOR_MS) return null;
  if (ms >= CLOCK_FROM_MS) return clock(ms);
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * How long the WHOLE turn took (or has taken, while it runs) — "0:41" — or null
 * when the turn was never timed.
 *
 * ⛔ Unlike a step, a turn is never too short to print: "0:00" in the elapsed
 * slot of a turn that is one second old is the truth, and the slot is a clock
 * that the customer watches move. The floor above is about a duration printed
 * once beside a finished step, which is a different claim.
 */
export function formatElapsed(ms: number | null | undefined): string | null {
  if (!measured(ms)) return null;
  return clock(ms);
}

/**
 * The elapsed text for a turn that started at `startedAt`, as of `now` — null
 * when it was never timed, or when the clock has run backwards far enough that
 * the answer would be a negative duration (a system clock change mid-turn).
 */
export function elapsedSince(startedAt: number | null | undefined, now: number): string | null {
  if (!measured(startedAt)) return null;
  return formatElapsed(now - startedAt);
}
