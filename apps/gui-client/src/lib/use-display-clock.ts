// ONE shared display clock for the surfaces that age a reading.
//
// ⛔ WHY THIS EXISTS. Every window in proxy-reading-windows is applied by
// `deriveProbeViewState`, which reads `Date.now()` — and that derivation only ran
// when the probe cache was WRITTEN (ProxiesView's refresh and cache subscription,
// ProfilesView's `useMemo` on `[probeCache]`). Neither view had a clock, so the
// windows were not enforced continuously: a chip stayed green long past its
// window and then flipped grey the moment some unrelated write happened by. That
// is why the owner saw it as ERRATIC ("sometimes … green on quic, and later not
// green box") rather than as timed — a timed window would at least have been
// predictable. Widening the windows without this would only have made the drift
// longer.
//
// ONE timer for the whole app, not one per view or per chip: the tick exists to
// make a pure derivation re-run, and two timers would re-run it twice for nothing.
// It starts with the first subscriber and is cleared when the last one unmounts,
// so a build with neither view open runs no interval at all.
//
// ⛔ NO NETWORK, no measurement, no cache write. This only moves the reference
// moment the existing pure derivations already take as an argument.

import { useEffect, useState } from 'react';

/**
 * How often the shared clock fires.
 *
 * Sixty seconds. The finest thing it has to keep honest is an age label, which
 * is written in whole minutes and hours (`measuredAgo`), so a faster tick could
 * not change a single rendered character; and the windows it enforces are hours
 * wide, so a minute of lag on a boundary is invisible. It is also the reason this
 * is affordable — one `setInterval` and one state bump a minute, against a
 * derivation that is pure and already runs on every cache write.
 */
export const DISPLAY_CLOCK_INTERVAL_MS = 60 * 1000;

type DisplayClockListener = () => void;

const listeners = new Set<DisplayClockListener>();
let timer: ReturnType<typeof setInterval> | null = null;

function stopIfIdle(): void {
  if (listeners.size === 0 && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Subscribe to the shared tick. Returns an unsubscribe.
 *
 * Iterates a COPY, so a listener that unsubscribes itself inside the callback
 * cannot mutate the set mid-iteration, and a throwing listener is contained —
 * the same rule `emitProbeCache` follows, and for the same reason: one broken
 * subscriber must not stop the clock for every other surface.
 */
export function subscribeDisplayClock(fn: DisplayClockListener): () => void {
  listeners.add(fn);
  if (timer === null) {
    timer = setInterval(() => {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          /* a subscriber's fault is not the clock's problem */
        }
      }
    }, DISPLAY_CLOCK_INTERVAL_MS);
  }
  return () => {
    listeners.delete(fn);
    stopIfIdle();
  };
}

/**
 * A counter that advances once a minute, for a component that derives something
 * from the current time.
 *
 * Used as a `useMemo`/`useEffect` DEPENDENCY, never as the time itself: the
 * derivation still reads `Date.now()` (or takes an injected `nowMs`), so nothing
 * here becomes a second source of truth about what time it is. The number's only
 * job is to be different from the last one.
 */
export function useDisplayClock(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => subscribeDisplayClock(() => setTick((n) => n + 1)), []);
  return tick;
}
