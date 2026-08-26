// P-25 — make the freeze report itself.
//
// The owner's report is the hardest shape there is: load a couple of sites, many
// activities, and at some point the app gets stuck and then freezes completely,
// with a full restart the only way out. It emits NOTHING — no error, no log, no
// crash — which is exactly why 32,000 tests and two independent static sweeps
// have not found it. A2 and A3 have jointly eliminated in-memory stores,
// listener leaks, timers, the input-receipt table, uncapped React state,
// per-tick re-renders and the send/backpressure path, all statically and neither
// under load. Every candidate still standing is one only a running app can show.
//
// ⭐ So this does not try to find the bug. It makes the NEXT occurrence carry
// evidence instead of a restart, which is the difference between a report we
// cannot act on and a measurement we can.
//
// HOW IT WORKS, and why the technique is sound: a timer callback cannot run
// while the main thread is blocked. So if a 1s interval fires 9s late, the
// thread was unavailable for ~8s — the gap IS the stall, measured rather than
// inferred. That is the whole mechanism, and it costs one timestamp comparison
// per second, which matters because a watchdog heavy enough to affect what it
// watches is worse than none.
//
// ⚠️ A BACKGROUNDED WINDOW THROTTLES TIMERS AND LOOKS EXACTLY LIKE A STALL.
// Reporting those would bury a real freeze in noise from every minimised window,
// so a sample whose window was hidden at either end is discarded rather than
// reported. That is a deliberate loss of coverage: a freeze that begins while
// hidden is invisible here, and the alternative is an instrument nobody trusts.

/** A stall long enough to be a defect rather than a slow frame. */
export const STALL_THRESHOLD_MS = 3_000;

/** How often the heartbeat checks in. */
export const STALL_HEARTBEAT_MS = 1_000;

export interface StallSample {
  /** Wall-clock gap between consecutive heartbeats. */
  elapsedMs: number;
  /** Was the window visible for the WHOLE interval? */
  visibleThroughout: boolean;
}

export interface StallVerdict {
  stalled: boolean;
  /** How long the thread was unavailable, excluding the expected interval. */
  blockedMs: number;
  /** Why a gap was not reported, when it was not. */
  discardedReason: 'hidden' | null;
}

/**
 * Classify one heartbeat gap. PURE — no timers, no DOM — so every branch is
 * testable without a running GUI, which is the same convention
 * `session-diagnostics.ts` follows and for the same reason.
 */
export function classifyStall(
  sample: StallSample,
  thresholdMs: number = STALL_THRESHOLD_MS,
  heartbeatMs: number = STALL_HEARTBEAT_MS,
): StallVerdict {
  const blockedMs = Math.max(0, sample.elapsedMs - heartbeatMs);
  if (sample.elapsedMs < thresholdMs) {
    return { stalled: false, blockedMs, discardedReason: null };
  }
  // ⛔ Checked AFTER the threshold, not before: a hidden window that did NOT
  // stall is an ordinary sample and carries no reason, so `discardedReason`
  // stays null for it. Only a gap we would otherwise have reported can be
  // discarded, which keeps the field meaning "a stall was suppressed".
  if (!sample.visibleThroughout) {
    return { stalled: false, blockedMs, discardedReason: 'hidden' };
  }
  return { stalled: true, blockedMs, discardedReason: null };
}

/**
 * What the app was holding when it stalled.
 *
 * Deliberately counts rather than dumps: the point is to see which resource was
 * large at the moment of the freeze, and a census that itself allocates heavily
 * would perturb the thing being measured.
 */
export interface StallCensus {
  blockedMs: number;
  /** Live `<video>` elements — one per simulator surface. */
  videoElements: number;
  /** Open simulator tabs, if the caller can supply it. */
  tabCount: number | null;
  /** Input receipts awaiting an ack. Bounded at 128; a pinned 128 is a signal. */
  pendingReceipts: number | null;
  /** JS heap in MiB where the runtime exposes it, else null. */
  heapUsedMiB: number | null;
  /** Total listeners the app registered through its own helper, if tracked. */
  documentChildren: number;
}

export interface StallCensusDeps {
  videoElements: () => number;
  documentChildren: () => number;
  tabCount?: () => number | null;
  pendingReceipts?: () => number | null;
  heapUsedMiB?: () => number | null;
}

/** Assemble the census. PURE given its deps, so the shape is unit-testable. */
export function takeStallCensus(blockedMs: number, deps: StallCensusDeps): StallCensus {
  return {
    blockedMs,
    videoElements: deps.videoElements(),
    documentChildren: deps.documentChildren(),
    tabCount: deps.tabCount ? deps.tabCount() : null,
    pendingReceipts: deps.pendingReceipts ? deps.pendingReceipts() : null,
    heapUsedMiB: deps.heapUsedMiB ? deps.heapUsedMiB() : null,
  };
}

/**
 * One paste-ready line per stall.
 *
 * Single line on purpose: the customer reporting this is copying it out of a
 * console into a bug report, and a multi-line dump gets truncated on the way.
 */
export function formatStall(census: StallCensus): string {
  const parts = [
    `main thread blocked ${String(Math.round(census.blockedMs))}ms`,
    `video=${String(census.videoElements)}`,
    `dom=${String(census.documentChildren)}`,
  ];
  if (census.tabCount !== null) parts.push(`tabs=${String(census.tabCount)}`);
  if (census.pendingReceipts !== null) parts.push(`receipts=${String(census.pendingReceipts)}`);
  if (census.heapUsedMiB !== null) parts.push(`heap=${String(census.heapUsedMiB)}MiB`);
  return `[stall] ${parts.join(' ')}`;
}

/**
 * Start the heartbeat. Returns a stop function.
 *
 * ⚠️ Wiring matters more than the module: an instrument that is never started is
 * a library, not a diagnostic, and P-25 exists because the failure emits nothing.
 *
 * Visibility is sampled at BOTH ends of each interval and ANDed. Reading it only
 * on arrival would call a window that was hidden for 59 of 60 seconds "visible"
 * and report a throttle as a freeze — the exact false positive that would make
 * this untrustworthy on its first day.
 */
export function startStallWatch(
  onStall: (line: string, census: StallCensus) => void,
  deps: StallCensusDeps,
  heartbeatMs: number = STALL_HEARTBEAT_MS,
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  let last = Date.now();
  let visibleSinceLastTick = document.visibilityState === 'visible';

  const onVisibility = (): void => {
    // Once hidden during an interval, the interval is tainted; it resets on the
    // next tick. A window that flickers hidden mid-stall is not reported, which
    // is the safe direction.
    if (document.visibilityState !== 'visible') visibleSinceLastTick = false;
  };
  document.addEventListener('visibilitychange', onVisibility);

  const handle = window.setInterval(() => {
    const now = Date.now();
    const verdict = classifyStall(
      {
        elapsedMs: now - last,
        visibleThroughout: visibleSinceLastTick && document.visibilityState === 'visible',
      },
      STALL_THRESHOLD_MS,
      heartbeatMs,
    );
    last = now;
    visibleSinceLastTick = document.visibilityState === 'visible';
    if (!verdict.stalled) return;
    const census = takeStallCensus(verdict.blockedMs, deps);
    onStall(formatStall(census), census);
  }, heartbeatMs);

  return () => {
    window.clearInterval(handle);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/** The probes, wired to what the running app can actually see. */
export function browserStallCensusDeps(extra: Partial<StallCensusDeps> = {}): StallCensusDeps {
  return {
    videoElements: () => document.querySelectorAll('video').length,
    documentChildren: () => document.getElementsByTagName('*').length,
    heapUsedMiB: () => {
      // `performance.memory` is Chromium-only and absent under a strict runtime,
      // so it degrades to null rather than throwing — see the test.
      const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
      const used = mem?.usedJSHeapSize;
      return typeof used === 'number' ? Math.round(used / (1024 * 1024)) : null;
    },
    ...extra,
  };
}
