// Which worker faults are worth a log line.
//
// A worker reports its LATEST fault on every heartbeat (`lastErrorSummary` +
// `lastErrorAtMs`), not only the beat after it happened, so a single fault is
// re-reported every beat until the worker restarts or faults again. Logging
// every beat that carries one turned ONE fault into 7,873 identical warnings in
// a day in production (2026-09-22/23: one `proxy_connection_failed` at a fixed
// `lastErrorAtMs`, re-sent on every beat), which buries every other warning.
//
// A fault is logged the FIRST time this process sees it for a node, and again
// only when the node reports a DIFFERENT fault — a new summary, or a new
// `lastErrorAtMs`. What an operator needs from the log is still there: every
// distinct fault leaves exactly one line, and a restart of this process logs
// each node's current fault once more (the map is in memory, on purpose: a
// fault still standing after a deploy is worth one line again).
//
// Bounded: one entry per node, and the map is cleared if it ever holds more
// nodes than any realistic estate, so a stream of made-up node ids cannot grow
// it without limit.

const MAX_TRACKED_NODES = 1_000;

/** The last fault logged per node, as `<summary>\u0000<atMs>`. */
const lastLoggedFault = new Map<string, string>();

/**
 * True when this beat's fault is one this process has not logged for the node
 * yet, and records it as logged. `atMs` absent is treated as its own value, so
 * a worker that never sends a timestamp is still logged once per summary.
 */
export function isNewWorkerFault(nodeId: string, summary: string, atMs?: number): boolean {
  const key = `${summary}\u0000${atMs === undefined ? '' : String(atMs)}`;
  if (lastLoggedFault.get(nodeId) === key) return false;
  if (!lastLoggedFault.has(nodeId) && lastLoggedFault.size >= MAX_TRACKED_NODES) {
    lastLoggedFault.clear();
  }
  lastLoggedFault.set(nodeId, key);
  return true;
}

/** Test seam: forget every logged fault. */
export function resetWorkerFaultLog(): void {
  lastLoggedFault.clear();
}
