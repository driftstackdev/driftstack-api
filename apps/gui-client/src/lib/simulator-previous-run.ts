// A Simulator crash must be reported somewhere someone can see it.
//
// The Simulator window records a periodic snapshot of what it is holding
// (lib/main-thread-stall-detector.ts, SIMULATOR_FLIGHT_STORE_FILE), and a
// normal quit is marked by the store plugin's save-on-exit (the exit mark). The
// record of a run that died is read at the next launch and reported.
//
// ⛔ WHO READS IT DEPENDS ON WHERE IT WAS WRITTEN. Store files live in the
// writing app's own data folder:
//   • On Windows and Linux the Simulator is a window of the main app, so its
//     record sits in the main app's folder and the MAIN window reports it at
//     launch (App.tsx) — the window a customer gets back after a freeze.
//   • On macOS the Simulator is a separate app (dev.driftstack.simulator) with
//     its own folder, which the main app never reads. Its crashes were reported
//     nowhere. So the separate app's window reports its own previous run.
// Each record is therefore reported by exactly one reader, never twice.

import type { ExitMark, FlightRecord, FlightStore } from './main-thread-stall-detector';
import { reportPreviousRun } from './main-thread-stall-detector';

/** The separate macOS Simulator app's bundle identifier. */
export const SIMULATOR_APP_IDENTIFIER = 'dev.driftstack.simulator';

/** What the Simulator window says about its own previous run (the developer's
 *  copy is the WARN line in its log). */
export const SIMULATOR_PREVIOUS_RUN_NOTICE = {
  froze: 'The Simulator stopped responding last time. A diagnostic snapshot was saved.',
  closed: 'The Simulator closed unexpectedly last time. A diagnostic snapshot was saved.',
} as const;

export function simulatorPreviousRunNotice(record: FlightRecord): string {
  return record.onStall
    ? SIMULATOR_PREVIOUS_RUN_NOTICE.froze
    : SIMULATOR_PREVIOUS_RUN_NOTICE.closed;
}

/**
 * Report the previous run, in the separate Simulator app only. Never throws: a
 * diagnostic must not break start-up.
 */
export async function reportSimulatorPreviousRun(deps: {
  store: FlightStore;
  /** The running app's bundle identifier (`getIdentifier` in the app). */
  appIdentifier: () => Promise<string>;
  exitMark: Pick<ExitMark, 'previousExitWasClean'>;
  /** ONE durable log entry per record (WARN, flushed): the line says what it means. */
  log: (line: string) => void;
  /** The customer's copy, in this window. */
  notify: (message: string) => void;
}): Promise<void> {
  let identifier: string;
  try {
    identifier = await deps.appIdentifier();
  } catch {
    return;
  }
  if (identifier !== SIMULATOR_APP_IDENTIFIER) return;
  await reportPreviousRun(
    deps.store,
    (_line, record) => deps.notify(simulatorPreviousRunNotice(record)),
    (line) => deps.log(line),
    deps.exitMark,
  );
}
