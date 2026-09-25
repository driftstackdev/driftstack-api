// P-25 — make the freeze report itself.
//
// The owner's report is the hardest shape there is: load a couple of sites, many
// activities, and at some point the app gets stuck and then freezes completely,
// with a full restart the only way out. It emits NOTHING — no error, no log, no
// crash — which is exactly why 32,000 tests and two independent static sweeps
// have not found it. This repo and the harness have jointly eliminated in-memory stores,
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

import { LazyStore } from '@tauri-apps/plugin-store';

/** A stall long enough to be a defect rather than a slow frame. */
export const STALL_THRESHOLD_MS = 3_000;

/** How often the heartbeat checks in. */
export const STALL_HEARTBEAT_MS = 1_000;

// ─── Test seam for the heartbeat interval ───────────────────────────────────
//
// Measured 2026-09-12 (the app-shell six-hour test): advancing 6 h of fake time
// through the mounted App executes 23,066 timer callbacks — 21,600 of them this
// 1 s heartbeat. Every test that mounts the App and advances fake hours pays
// that, which is why the shell test needed a 30 s budget. The 1 s heartbeat is
// right for production (it is what makes a 3 s freeze measurable), and stubbing
// the module away would make "through the mounted shell" a smaller shell — so a
// test can slow the heartbeat HERE instead, by name, and nowhere else.
//
// Production never calls the setter: `stallHeartbeatMs()` returns
// `STALL_HEARTBEAT_MS` unchanged until a test sets an override, and `App.tsx`
// reads the interval through it. `classifyStall` and the census are untouched.
let heartbeatOverrideMs: number | null = null;

/** Override the heartbeat interval for a test; `null` restores the default. */
export function setStallHeartbeatForTests(ms: number | null): void {
  heartbeatOverrideMs = ms;
}

/** The heartbeat interval the app should start: the test override, else the constant. */
export function stallHeartbeatMs(): number {
  return heartbeatOverrideMs ?? STALL_HEARTBEAT_MS;
}

/**
 * The stall threshold for a given heartbeat interval.
 *
 * ⛔ The threshold is an ELAPSED-time boundary, so it must move with the
 * heartbeat: `STALL_THRESHOLD_MS` alone means "blocked ≥ 2 s" only at the
 * production 1 s heartbeat. Passed bare to a watch running at the 60 s test
 * heartbeat, every ON-TIME tick (elapsed 60 000 ≥ 3 000) was a stall of 0 ms —
 * measured 2026-09-12: one run of the app-shell test file emitted 2,523
 * "[stall] main thread blocked 0ms" warnings and as many onStall flight-store
 * writes, where the pre-seam file emitted none. This keeps the production
 * margin (threshold − heartbeat = 2 s) at any heartbeat, and at the production
 * heartbeat is exactly `STALL_THRESHOLD_MS`. PURE, so the boundary is testable.
 */
export function stallThresholdForHeartbeat(heartbeatMs: number): number {
  return Math.max(STALL_THRESHOLD_MS, heartbeatMs + (STALL_THRESHOLD_MS - STALL_HEARTBEAT_MS));
}

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
      stallThresholdForHeartbeat(heartbeatMs),
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

/**
 * The census without the stall prefix: the counts only, plus the blocked time
 * when there WAS a stall. A periodic snapshot is not a stall, and printing
 * "[stall] main thread blocked 0ms" inside it read as one.
 */
function formatCensus(census: StallCensus): string {
  return formatStall(census)
    .replace(/^\[stall\] /, '')
    .replace(/^main thread blocked 0ms /, '');
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
  // What it means, in the line itself: a normal quit is recorded (see ExitMark),
  // so a surviving record is a crash, a force-quit, or a window that froze.
  const meaning = record.onStall
    ? 'it stopped responding, then closed'
    : 'it crashed, was force-quit, or froze';
  return `[flight-recorder]${where} previous run ended without shutting down (${meaning}) — ${why} at ${when}: ${formatCensus(record.census)}`;
}

// ─── Exit mark: telling a normal quit from a crash ──────────────────────────
//
// ⛔ THE CLEAN-SHUTDOWN MARK WAS ONLY EVER WRITTEN BY A REACT EFFECT CLEANUP, and
// quitting the app (⌘Q, the red button on the last window, an update relaunch)
// tears the webview down without unmounting anything. So EVERY normal quit read
// as "ended without shutting down": on the maintainer's Mac all five records in
// the bounded history were periodic snapshots, none a stall, and the dev log
// carried the line at every launch — for both windows.
//
// The mark now rides the store plugin's own exit hook. tauri-plugin-store 2.x
// saves every open store on `RunEvent::Exit` (plugin lib.rs, `on_event`), and
// Tauri dispatches that to plugins BEFORE it clears the resource table. So each
// run, at startup:
//   1. read the mark the previous run left (true = it exited normally);
//   2. write `false` and SAVE it — this run has not exited yet;
//   3. write `true` WITHOUT saving, into a store opened with autoSave off.
// Step 3 reaches the disk only through the plugin's exit save. A crash, a kill
// or a force-quit never runs it, and the `false` from step 2 is what the next
// launch reads.
//
// ⚠️ Known gap, stated rather than hidden: the webview's JavaScript and the
// app's exit path run on different threads. A window that FROZE and was then
// quit with ⌘Q (rather than force-quit) still exits through the plugin, so it
// reads as a normal quit. A stall that recovered long enough to be recorded is
// still reported, because its record says `onStall`. The alternative — every
// normal quit reported as a crash — is what this replaces.

/** Main window's exit-mark store. Separate from FLIGHT_STORE_FILE because it
 *  must be opened with autoSave OFF, and the recorder's store saves on purpose. */
export const EXIT_MARK_FILE = 'diagnostics-exit.json';
/** The simulator window's own exit mark (same reasoning as its flight store). */
export const SIMULATOR_EXIT_MARK_FILE = 'diagnostics-simulator-exit.json';
const EXIT_KEY = 'exitedNormally';

export interface ExitMark {
  /**
   * Did the run before this one exit normally? `true` yes, `false` no (it was
   * armed and never reached the exit save), `null` unknown — no mark at all,
   * which is the first launch of a version that writes one. Read once per
   * process and remembered, so arming can never be observed by the reader.
   */
  previousExitWasClean: () => Promise<boolean | null>;
  /** Steps 2 and 3 above. Idempotent; never throws. */
  arm: () => Promise<void>;
}

/** Build an exit mark over a store. PURE given the store, so it is testable. */
export function createExitMark(store: FlightStore): ExitMark {
  let read: Promise<boolean | null> | null = null;
  let armed: Promise<void> | null = null;
  const previousExitWasClean = (): Promise<boolean | null> => {
    read ??= (async () => {
      try {
        const v = await store.get<boolean>(EXIT_KEY);
        return typeof v === 'boolean' ? v : null;
      } catch {
        return null;
      }
    })();
    return read;
  };
  const arm = (): Promise<void> => {
    armed ??= (async () => {
      // Read first: arming before the read would report this run, not the last.
      await previousExitWasClean();
      try {
        await store.set(EXIT_KEY, false);
        await store.save();
        // In memory only — the plugin's exit save is the only writer of `true`.
        await store.set(EXIT_KEY, true);
      } catch {
        /* a diagnostic must never break startup */
      }
    })();
    return armed;
  };
  return { previousExitWasClean, arm };
}

/** A store opened with autoSave off. Constructed lazily, on first use, so
 *  importing this module never touches the store (tests, the visual harness). */
function lazyStoreWithoutAutoSave(file: string): FlightStore {
  let opened: LazyStore | null = null;
  const open = (): LazyStore => {
    opened ??= new LazyStore(file, { defaults: {}, autoSave: false });
    return opened;
  };
  return {
    get: <T>(k: string) => open().get<T>(k),
    set: (k, v) => open().set(k, v),
    save: () => open().save(),
  };
}

const exitMarks = new Map<string, ExitMark>();

/** The exit mark for a window, one per store file per JS context. */
export function exitMarkFor(windowLabel: string | undefined): ExitMark {
  const file = windowLabel === 'simulator' ? SIMULATOR_EXIT_MARK_FILE : EXIT_MARK_FILE;
  let mark = exitMarks.get(file);
  if (mark === undefined) {
    mark = createExitMark(lazyStoreWithoutAutoSave(file));
    exitMarks.set(file, mark);
  }
  return mark;
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
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
/** Surfaced records are moved here before the live key is cleared. Bounded: a
 *  ring of the last few, never appended without a cap — the "bounded by
 *  construction" rule at the top of this section still holds. */
const HISTORY_KEY = 'history';
export const FLIGHT_HISTORY_MAX = 5;

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
  /** Durable sink for the formatted line — ONE log entry, flushed to disk
   *  immediately rather than on the 1s debounce a crash loop can outrun.
   *  Optional so callers without a sink still get the toast. ⛔ The caller must
   *  not ALSO log the line from `onReport`: that is how every record came out
   *  twice, once as ERROR and once as WARN. */
  persist?: (line: string, record: FlightRecord) => void,
  /** The window's exit mark. When given, it decides: a run that exited
   *  normally is not reported, and neither is one with no mark (the first
   *  launch after this shipped — its record is the old version's normal quit).
   *  Without it, only the legacy clean-shutdown key counts. */
  exitMark?: Pick<ExitMark, 'previousExitWasClean'>,
): Promise<void> {
  try {
    const record = (await store.get<FlightRecord>(FLIGHT_KEY)) ?? null;
    const legacyClean = (await store.get<boolean>(CLEAN_KEY)) ?? false;
    const exitedNormally =
      exitMark === undefined ? false : (await exitMark.previousExitWasClean()) !== false;
    const clean = legacyClean || exitedNormally;
    if (shouldSurfaceRecord(record, clean) && record !== null) {
      const line = formatFlightRecord(record);
      // ⛔ THE ONLY COPY USED TO BE DESTROYED BY THE ACT OF REPORTING IT. The
      // toast said "a diagnostic snapshot was saved" while the lines below
      // deleted it, and console.warn was the sole other copy — in a release
      // build that is delivery to nobody. Two durable copies now, BEFORE the
      // clear: a bounded history in this store, and the line through the
      // caller's sink.
      const prior = (await store.get<FlightRecord[]>(HISTORY_KEY)) ?? [];
      await store.set(HISTORY_KEY, [record, ...prior].slice(0, FLIGHT_HISTORY_MAX));
      persist?.(line, record);
      onReport(line, record);
    }
    // Cleared unconditionally, including when nothing was surfaced: a record
    // left in place would be re-read on every subsequent launch. HISTORY is
    // what survives; this key is only the live "did the last run die" flag.
    await store.set(FLIGHT_KEY, null);
    await store.set(CLEAN_KEY, false);
    await store.save();
  } catch {
    /* a diagnostic must never break startup */
  }
}

/** The surfaced-record history, newest first — the thing the toast promises. */
export async function readFlightHistory(store: {
  get: <T>(k: string) => Promise<T | undefined>;
}): Promise<FlightRecord[]> {
  try {
    return (await store.get<FlightRecord[]>(HISTORY_KEY)) ?? [];
  } catch {
    return [];
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
  /** Armed at start so a normal quit is recorded as one. Defaults to this
   *  window's own mark when running in Tauri; nothing elsewhere. */
  exitMark: Pick<ExitMark, 'arm'> | null = inTauri() ? exitMarkFor(windowLabel) : null,
): { stop: () => Promise<void>; recordStall: (census: StallCensus) => void } {
  if (exitMark !== null) void exitMark.arm();
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
