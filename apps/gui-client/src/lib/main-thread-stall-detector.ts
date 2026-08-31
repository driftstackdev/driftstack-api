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

// ─── Flight recorder ────────────────────────────────────────────────────────
//
// ⛔ THE STALL WATCH ABOVE CANNOT SEE THE FAILURE THE OWNER ACTUALLY REPORTED.
// It detects a stall by a timer firing LATE, which means the thread recovered
// enough to run it. A freeze that never lets go fires nothing, and the customer
// cannot open devtools during it — the report is "nothing is usable, I have to
// restart", so the console is gone by the time anyone could read it.
//
// So the census is also written to disk periodically. A terminal freeze then
// leaves its last known state behind, and the next startup finds it. That is the
// difference between "it froze again" and "it froze holding 9 videos, 41k DOM
// nodes and 128 pending receipts".
//
// ⚠️ Bounded by construction: ONE key, overwritten in place, never appended. A
// diagnostic that grows without limit while investigating a suspected resource
// leak would be its own punchline.

export interface FlightRecord {
  /** Epoch ms of the snapshot. */
  at: number;
  census: StallCensus;
  /** True when written because a stall was detected, not on the schedule. */
  onStall: boolean;
  /**
   * Which webview produced it. Absent on records written before this field
   * existed, which is why every reader treats it as optional rather than
   * assuming the main window.
   */
  window?: string;
}

export const FLIGHT_RECORDER_INTERVAL_MS = 30_000;

/**
 * Should a recovered record be surfaced to the user?
 *
 * PURE so the decision is testable without a store. A record only means
 * something if the previous run ended WITHOUT clearing it — a clean shutdown
 * clears the key, so a surviving record is evidence the process died holding
 * that state.
 */
export function shouldSurfaceRecord(record: FlightRecord | null, cleanShutdown: boolean): boolean {
  if (record === null) return false;
  // ⛔ A clean shutdown that failed to clear the key would otherwise report a
  // freeze on every subsequent launch, forever, from one stale write.
  if (cleanShutdown) return false;
  return true;
}

/** One line describing what the previous run was holding when it died. */
export function formatFlightRecord(record: FlightRecord): string {
  const when = new Date(record.at).toISOString();
  const why = record.onStall ? 'after a detected stall' : 'last periodic snapshot';
  // ⛔ WHICH WINDOW FROZE IS THE FIRST THING THE RECORD MUST SAY. The app runs two
  // independent webviews on two independent main threads, and "it froze" means
  // something different for each: the main window is chrome, the simulator is
  // where the customer actually browses. A record that does not name the thread
  // sends the next investigation to the wrong one.
  const where = record.window === undefined ? '' : ` [${record.window}]`;
  return `[flight-recorder]${where} previous run ended without shutting down — ${why} at ${when}: ${formatStall(record.census)}`;
}

/** Separate from settings.json: a diagnostic must not risk the file that holds
 *  the customer's configuration. */
export const FLIGHT_STORE_FILE = 'diagnostics.json';

/**
 * The simulator webview records to its OWN file.
 *
 * ⛔ Not a stylistic choice — a correctness one, and the same one `log-buffer.ts`
 * already made for the same reason (#137). The two windows are separate JS
 * contexts writing one store; sharing a key means the main window's CLEAN-shutdown
 * mark erases the simulator's crash evidence, and a clean main window is the
 * normal case when the simulator is the half that froze. Separate files cannot
 * clobber each other.
 */
export const SIMULATOR_FLIGHT_STORE_FILE = 'diagnostics-simulator.json';
const FLIGHT_KEY = 'lastRun';
const CLEAN_KEY = 'cleanShutdown';

/**
 * Read whatever the previous run left behind, report it, then clear it.
 *
 * ⚠️ Every failure here is swallowed. A diagnostic that breaks the app it is
 * diagnosing is worse than no diagnostic, and this runs on the startup path.
 */
export async function reportPreviousRun(
  store: {
    get: <T>(k: string) => Promise<T | undefined>;
    set: (k: string, v: unknown) => Promise<void>;
    save: () => Promise<void>;
  },
  onReport: (line: string, record: FlightRecord) => void,
): Promise<void> {
  try {
    const record = (await store.get<FlightRecord>(FLIGHT_KEY)) ?? null;
    const clean = (await store.get<boolean>(CLEAN_KEY)) ?? false;
    if (shouldSurfaceRecord(record, clean) && record !== null) {
      onReport(formatFlightRecord(record), record);
    }
    // Cleared unconditionally, including when nothing was surfaced: a record
    // left in place would be re-read on every subsequent launch.
    await store.set(FLIGHT_KEY, null);
    await store.set(CLEAN_KEY, false);
    await store.save();
  } catch {
    /* a diagnostic must never break startup */
  }
}

export interface FlightStore {
  get: <T>(k: string) => Promise<T | undefined>;
  set: (k: string, v: unknown) => Promise<void>;
  save: () => Promise<void>;
}

/**
 * Persist the census on a schedule and on every stall. Returns a stop function
 * that marks the shutdown clean.
 *
 * ⭐ The schedule is what makes a TERMINAL freeze reportable: the stall watch
 * needs the thread to recover before it can fire, and the reported failure never
 * does. The last periodic snapshot is the state the process died holding.
 */
export function startFlightRecorder(
  store: FlightStore,
  deps: StallCensusDeps,
  intervalMs: number = FLIGHT_RECORDER_INTERVAL_MS,
  windowLabel?: string,
): { stop: () => Promise<void>; recordStall: (census: StallCensus) => void } {
  const write = (census: StallCensus, onStall: boolean): void => {
    const record: FlightRecord = {
      at: Date.now(),
      census,
      onStall,
      ...(windowLabel === undefined ? {} : { window: windowLabel }),
    };
    void (async () => {
      try {
        await store.set(FLIGHT_KEY, record);
        await store.save();
      } catch {
        /* never break the app to record a diagnostic */
      }
    })();
  };

  const handle =
    typeof window === 'undefined'
      ? 0
      : window.setInterval(() => {
          write(takeStallCensus(0, deps), false);
        }, intervalMs);

  return {
    recordStall: (census) => {
      write(census, true);
    },
    stop: async () => {
      if (handle !== 0) window.clearInterval(handle);
      try {
        // ⛔ The clean-shutdown mark is what stops a stale record announcing a
        // freeze on every launch forever.
        await store.set(CLEAN_KEY, true);
        await store.save();
      } catch {
        /* swallow */
      }
    },
  };
}
