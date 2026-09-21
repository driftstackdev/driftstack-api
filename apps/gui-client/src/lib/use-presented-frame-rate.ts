// HOW MANY FRAMES THE CUSTOMER IS ACTUALLY BEING SHOWN — measured, or nothing.
//
// The mockup draws `30 fps · 84 ms` beside the phone and three review rounds
// refused to build it, for the one reason that matters: a number printed beside
// a live video of the thing it describes is checkable by eye. The latency half
// still has no honest source (end-to-end latency needs a clock on the SENDER;
// LiveKit's `getStats()` jitter/RTT is a different quantity and must not wear
// that label), so it is not built. The frame rate does have an honest source —
// the browser tells us when it hands a frame to the compositor — and this is
// that measurement and nothing else.
//
// ⛔ THE THREE RULES THAT MAKE IT A MEASUREMENT RATHER THAN A DECORATION:
//
//   1. NEVER A GUESS AND NEVER A CONSTANT. `requestVideoFrameCallback` is the
//      source. Where it is missing (the two old WebViews this app still ships
//      into) the decoded-frame counter `getVideoPlaybackQuality()` is sampled
//      instead. Where NEITHER exists there is no number, so there is no chip —
//      the caller renders nothing rather than a plausible 30.
//   2. NOTHING UNTIL A WHOLE WINDOW HAS BEEN MEASURED. The first second of a
//      stream is the encoder finding its feet; a rate computed from it is real
//      but it is not the rate the customer is watching. Nothing is reported
//      until `WINDOW_MS` of wall time has passed under the same element.
//   3. A STALE NUMBER IS A LIE. If frames stop arriving the chip goes, it does
//      not freeze on its last value: the emit tick runs on its own clock rather
//      than on the frame callback, so silence is measurable here (a frozen
//      stream reports null within ~1s), which it would not be inside a
//      per-frame chain.
//
// ⛔ AND ONE PERFORMANCE RULE. A 60 fps stream fires this callback 60 times a
// second, for as long as a task runs. There is NO React state update per frame:
// the window is accumulated in the effect's own closure and `setState` is
// called at most once a second, and then only when the whole number changed.
// The closure rather than a `useRef` is deliberate — a re-arm (new element, or
// StrictMode's simulated remount) starts a FRESH window with no carry-over,
// where a ref would blend the old stream's frames into the new one's rate.
//
// ⛔ IT NEVER TOUCHES THE ELEMENT. `requestVideoFrameCallback` is an
// observation: no attribute is set, no method that could re-resolve the media
// is called, and the element is never rendered by this module. `Stage.tsx`'s
// header rule 1 — the screen and the panel are never keyed, never conditionally
// wrapped, because a remount RECONNECTS the LiveKit room — applies to this
// measurement exactly as it applies to the markup around it.
//
// The clock and the video API are both injected so the whole thing is testable
// with a fake video presenting frames on a fake clock, which is the only way to
// assert "60 frames over 2 s reads 30" without a device, a stream or a wait.

import { useEffect, useRef, useState } from 'react';

/** The sliding window the rate is computed over. ~2 s: long enough that one
 *  late frame does not move the number, short enough that the chip follows a
 *  stream that genuinely degrades rather than averaging it away. */
export const FRAME_RATE_WINDOW_MS = 2_000;

/** How often the chip may change. Whole frames per second, so anything faster
 *  is a repaint nobody can read. It is also the emit tick that makes a FROZEN
 *  stream visible: the value is recomputed on this clock, not on frame
 *  arrivals, so "no frames arrived" is a measurement rather than a silence. */
export const FRAME_RATE_EMIT_MS = 1_000;

/**
 * The three members of `HTMLVideoElement` this measurement reads — and nothing
 * else, so a test can hand it an object with no DOM behind it.
 *
 * Every one is optional because every one is genuinely absent somewhere:
 * `requestVideoFrameCallback` has no WebKitGTK implementation on the oldest
 * Linux target and is unshipped on the older macOS WKWebView, and
 * `getVideoPlaybackQuality` is absent on the same vintage. A real
 * `HTMLVideoElement` satisfies this type structurally.
 *
 * ⚠️ THE DECLARED TYPE IS NOT THE RUNTIME TRUTH HERE. `lib.dom.d.ts` declares
 * `requestVideoFrameCallback` as REQUIRED on `HTMLVideoElement`, so TypeScript
 * would let a caller assume it exists on the two WebViews where it does not.
 * Every use below is a runtime `typeof … === 'function'` check for that reason.
 */
export interface FrameRateVideo {
  requestVideoFrameCallback?: (callback: (now: number) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
  getVideoPlaybackQuality?: () => { totalVideoFrames: number };
}

/** The clock and the scheduler, injected. In the app these are
 *  `performance.now` and `window.setInterval`; in a test they are a fake whose
 *  time the test moves by hand. */
export interface FrameRateClock {
  now: () => number;
  setInterval: (fn: () => void, ms: number) => number;
  clearInterval: (handle: number) => void;
}

/** ONE module-level object, so the default is referentially stable: the effect
 *  below depends on the clock, and a fresh literal per render would re-arm the
 *  whole measurement on every parent render. */
const REAL_CLOCK: FrameRateClock = {
  now: () => performance.now(),
  setInterval: (fn, ms) => window.setInterval(fn, ms),
  clearInterval: (handle) => {
    window.clearInterval(handle);
  },
};

/**
 * One reading: how many frames had been presented, and when.
 *
 * A CUMULATIVE count rather than a per-sample delta, because the two sources
 * count differently — `requestVideoFrameCallback` fires once per frame while
 * `getVideoPlaybackQuality` hands back a running total — and a cumulative pair
 * makes them the same shape, so the window arithmetic below is written once.
 */
export interface FrameSample {
  at: number;
  frames: number;
}

/**
 * Drop what the window has left behind, IN PLACE.
 *
 * ⛔ IT KEEPS THE SAMPLE THAT STRADDLES THE LEFT EDGE, and that is the whole
 * subtlety. Dropping everything older than the cut-off would leave a window
 * that measures from the first sample INSIDE it — at 60 fps that is 16 ms of
 * slack, at 2 fps it is half a second — so the denominator would be short by
 * up to one frame interval and the rate would read high, worst on the slow
 * streams where the number matters most. Keeping one sample at or before the
 * edge means the span is always the full window.
 */
export function pruneFrameWindow(
  samples: FrameSample[],
  now: number,
  windowMs = FRAME_RATE_WINDOW_MS,
): void {
  const edge = now - windowMs;
  while (samples.length >= 2) {
    const second = samples[1];
    if (second === undefined || second.at > edge) break;
    samples.shift();
  }
}

/**
 * The rate the window holds, as a whole number — or null when the window
 * cannot support one.
 *
 * Null, never a zero and never a guess, in all four cases:
 *   • fewer than two readings — one point has no rate;
 *   • no time between them — a clock that did not move;
 *   • no frames between them — a stream that has stopped is not a 0 fps
 *     stream, it is a stream with nothing to report, and the chip goes;
 *   • the newest reading is a whole `FRAME_RATE_EMIT_MS` old — frames were
 *     arriving and have stopped, and the last known rate is now a claim about
 *     the past. This is the arm that makes a freeze visible within a second
 *     instead of holding `30 fps` over a still picture. Without it the window
 *     still holds real frames for two more seconds and would keep reporting the
 *     rate they arrived at, beside a picture that has not moved.
 * A rate that rounds to 0 is also null: `0 fps` beside a moving picture reads
 * as a broken readout, and beside a still one the case above has already fired.
 */
export function frameRateOver(
  samples: readonly FrameSample[],
  now: number,
  emitMs = FRAME_RATE_EMIT_MS,
): number | null {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first === undefined || last === undefined) return null;
  if (now - last.at >= emitMs) return null;
  const span = last.at - first.at;
  const frames = last.frames - first.frames;
  if (span <= 0 || frames <= 0) return null;
  const rate = Math.round((frames * 1000) / span);
  return rate > 0 ? rate : null;
}

/**
 * The frame rate of the picture this element is presenting, or null.
 *
 * Null covers every case in which there is nothing honest to show, and the
 * caller renders NOTHING for it — no placeholder, no dash, no last known value:
 * not live, no element, no API to measure with, and the first window of every
 * stream.
 */
export function usePresentedFrameRate({
  video,
  live,
  clock = REAL_CLOCK,
}: {
  /** The element painting the stream, or null when none is mounted. */
  video: FrameRateVideo | null;
  /** Whether that element is showing a LIVE stream. A stand-in image, a
   *  placeholder, a reconnect and an ended session are all `false`: the chip
   *  belongs to the stream, so it goes the moment the stream does rather than
   *  lingering over whatever replaced it. */
  live: boolean;
  clock?: FrameRateClock;
}): number | null {
  const [rate, setRate] = useState<number | null>(null);
  // ⛔ WHAT REACT HAS BEEN TOLD, kept across re-arms so it is never told the
  // same thing twice. `setState` with an unchanged value is not free: React
  // bails out of the SUBTREE but may still re-render the component itself
  // once, so a chip that re-set `30` every second re-rendered the stage every
  // second for the length of a task. Measured: with this ref the 120-frame
  // fixture renders twice (the mount, and nothing → 30); without it, three
  // times, and the third is a render that changed nothing on screen.
  const reported = useRef<number | null>(null);
  useEffect(() => {
    if (reported.current !== null) {
      reported.current = null;
      setRate(null);
    }
    if (video === null || !live) return undefined;

    // ⛔ FEATURE-DETECTED AT RUNTIME, NOT FROM THE TYPE (see FrameRateVideo).
    // Bound to the element: these are methods, and a bare reference called
    // without its receiver throws "Illegal invocation" in every browser.
    const request =
      typeof video.requestVideoFrameCallback === 'function' &&
      typeof video.cancelVideoFrameCallback === 'function'
        ? video.requestVideoFrameCallback.bind(video)
        : null;
    const cancel =
      typeof video.cancelVideoFrameCallback === 'function'
        ? video.cancelVideoFrameCallback.bind(video)
        : null;
    const quality =
      typeof video.getVideoPlaybackQuality === 'function'
        ? video.getVideoPlaybackQuality.bind(video)
        : null;
    // NEITHER API: there is no measurement to be had on this element, so there
    // is no number and no chip — for the whole life of this stream, silently.
    if (request === null && quality === null) return undefined;

    const armedAt = clock.now();
    // The window, in the closure: nothing here survives a re-arm, and nothing
    // here is React state.
    const samples: FrameSample[] = [{ at: armedAt, frames: 0 }];
    let frames = 0;
    // ⛔ THE FALLBACK'S ZERO IS READ AT ARMING, NOT ON THE FIRST TICK. Taken a
    // tick late it would pair a window that starts at `armedAt` with a count
    // that starts a second later, and every rate would read HALF — a wrong
    // number that looks entirely plausible beside a video.
    let baseline = request === null && quality !== null ? quality().totalVideoFrames : 0;
    let handle: number | null = null;
    let stopped = false;

    if (request !== null) {
      // ⛔ rVFC IS ONE-SHOT: the chain is re-armed inside its own callback and
      // would otherwise stop after a single frame. `stopped` is checked first
      // because a callback already queued when this effect is torn down still
      // runs — re-arming from it is how a cancelled loop comes back to life on
      // an element the next stream no longer owns.
      const onFrame = (): void => {
        if (stopped) return;
        frames += 1;
        samples.push({ at: clock.now(), frames });
        handle = request(onFrame);
      };
      handle = request(onFrame);
    }

    const emit = (): void => {
      const now = clock.now();
      // The fallback source: a running total of decoded frames, read on this
      // same tick. It is a coarser number than rVFC's (it counts frames the
      // decoder produced, not frames the compositor showed) which is why it is
      // second choice — but it is measured, and that is the bar.
      if (request === null && quality !== null) {
        const total = quality().totalVideoFrames;
        const counted = total - baseline;
        // A counter that went BACKWARDS is a new track on the same element
        // (a resubscribe, a reconnect). Re-baseline rather than report the
        // negative delta as a collapse in frame rate.
        if (counted < frames) {
          baseline = total;
          frames = 0;
          samples.length = 0;
          samples.push({ at: now, frames: 0 });
        } else if (counted > frames) {
          frames = counted;
          samples.push({ at: now, frames });
        }
        // ⛔ A TICK WITH NO FRAME IN IT RECORDS NOTHING — and that omission is
        // what makes RULE 3 reachable on this path at all. `frameRateOver`
        // refuses a newest reading a whole `FRAME_RATE_EMIT_MS` old, which is
        // the arm that turns a frozen picture into no number within a second.
        // This branch used to push a sample at `now` on EVERY tick, so
        // `now - last.at` was 0 for ever here and that rule could never fire:
        // what the window held instead was the last real frames spread over a
        // span that was half freeze, so the chip DECAYED through a run of
        // plausible wrong numbers. Measured in a real browser, on a real
        // <video> playing a real 30 fps MediaStream whose painter was stopped
        // at 4.0 s: `15 fps` at 5.0 s, `10 fps` at 6.0 s, nothing at 7.0 s —
        // three seconds of a falling frame rate beside a picture that had not
        // moved at all, while the rVFC path on the same element went quiet at
        // 5.0 s. A plausible wrong number is the one failure this whole module
        // exists to prevent, and it was reachable only on the fallback, which
        // is the path the two old WebViews take.
        // Recording nothing leaves the newest reading where the frames actually
        // stopped, so the rVFC path and this one now lose the number after the
        // same one tick of tolerance.
      }
      pruneFrameWindow(samples, now);
      // RULE 2: nothing at all until a whole window has passed under this
      // element. Measured from when the loop armed, not from the first frame:
      // a stream that takes a second to produce its first frame has still only
      // been watched for a second.
      const next = now - armedAt >= FRAME_RATE_WINDOW_MS ? frameRateOver(samples, now) : null;
      // Same number → React is not told at all → no render. The stream sits at
      // one whole number for minutes at a time, so this is the common case.
      if (next !== reported.current) {
        reported.current = next;
        setRate(next);
      }
    };
    const ticker = clock.setInterval(emit, FRAME_RATE_EMIT_MS);

    return () => {
      stopped = true;
      clock.clearInterval(ticker);
      // RULE: the loop is cancelled on unmount AND on stream change. Without
      // this the old element keeps a live callback chain — two chains on a
      // re-armed element, and a torn-down view still doing per-frame work.
      if (handle !== null && cancel !== null) cancel(handle);
    };
  }, [video, live, clock]);
  return rate;
}
