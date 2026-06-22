// 2026-06-22 — CP↔daemon bidirectional reconcile (A2 W2808 / A3 W2804).
//
// The PRECISE complement to the W2682 worker→CP terminal-status auto-close
// (agent-session-terminal-close.ts). That handler covers one direction: a still-
// connected worker reports a session ENDED → the CP closes the row. This handler
// covers the OTHER direction: a still-connected worker reports a session ACTIVE in
// its heartbeat `activeSessionStates` that the CP ALREADY holds TERMINAL → the CP
// re-issues `sessionEnd` to that node so it tears the orphan down.
//
// Why it's needed (audit w6cm8sipg): CP→daemon frames are best-effort (no ack /
// replay). A `sessionEnd` the CP sends while the WSS link is down is GONE on
// reconnect; with the W2813 idle-reset-on-GUI-input fix a customer who keeps
// interacting never idle-times-out, so the orphan runs to the max-duration hard
// cap — still BILLED, still holding a concurrency slot. No pure-harness fix closes
// this; it needs the CP re-issue.
//
// SAFE BY DESIGN — this re-issues `sessionEnd`, which kills a session, so the guard
// is deliberately narrow:
//   - acts ONLY on a row that EXISTS and is non-'active' (the CP already considers
//     it ended) → never kills a live session;
//   - an ABSENT row is SKIPPED — a just-created session may not be committed to the
//     DB yet when its first heartbeat arrives, so absence is treated as "unknown,
//     leave it", never "orphan, kill it" (no new-session race);
//   - idempotent — the harness no-ops a `sessionEnd` for a session it no longer
//     holds, so a duplicate re-issue across beats is harmless.
//
// Best-effort, off the fleet WS receive loop: a throw here must NOT escape into
// that loop (an uncaught throw there is a process-level uncaughtException). Each
// per-session reconcile is independently try/caught; the 12h orphan_reap + the
// worker-disconnect reaper remain the backstops.

import type { AgentSessionsRepo } from './agent-sessions.js';
import type { Logger } from '../lib/logger.js';

export interface ReconcileWorkerReportedOrphansDeps {
  readonly agentSessions: AgentSessionsRepo;
  /** sessionId → worker-reported state, from Heartbeat.activeSessionStates. */
  readonly activeSessionStates: Readonly<Record<string, string>>;
  /** The reporting node id (for logging + the caller's send targeting). */
  readonly macNodeId: string;
  /**
   * Re-issue a `sessionEnd` to the reporting node for `sessionId`. The caller
   * wires this to `registry.get(macNodeId)?.sendSessionEnd(serializeSessionEnd(id))`
   * so this helper stays decoupled from the registry (and unit-testable).
   */
  readonly sendSessionEnd: (sessionId: string) => void;
  readonly logger: Logger;
}

/**
 * Re-issue `sessionEnd` for any session a still-connected worker reports ACTIVE
 * that the CP already holds TERMINAL. See the module header for the contract +
 * safety guard. Resolves once every session in the beat has been checked; never
 * rejects (each per-session failure is swallowed + logged).
 */
export async function reconcileWorkerReportedOrphans(
  deps: ReconcileWorkerReportedOrphansDeps,
): Promise<void> {
  const { agentSessions, activeSessionStates, macNodeId, sendSessionEnd, logger } = deps;
  for (const sessionId of Object.keys(activeSessionStates)) {
    try {
      const existing = await agentSessions.get(sessionId);
      // Reconcile ONLY an EXISTING + non-'active' (CP-terminal) row. Absent → skip
      // (new-session race); 'active' → live, leave it untouched.
      if (existing !== null && existing.status !== 'active') {
        sendSessionEnd(sessionId);
        logger.info?.(
          { component: 'cp-daemon-reconcile', sessionId, macNodeId, cpStatus: existing.status },
          're-issued sessionEnd for worker-reported orphan (CP holds it terminal)',
        );
      }
    } catch (err) {
      // Per-session try/catch: one bad lookup must not abort the rest, and a throw
      // must never escape into the fleet WS receive loop.
      logger.warn?.(
        {
          component: 'cp-daemon-reconcile',
          sessionId,
          macNodeId,
          err: err instanceof Error ? err.message : String(err),
        },
        'reconcileWorkerReportedOrphans: per-session reconcile failed (backstops hold)',
      );
    }
  }
}
