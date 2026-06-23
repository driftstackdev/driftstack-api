// 2026-06-19 — worker-CONNECTED orphan auto-close (A3 W2682).
//
// The PRECISE, fast complement to the worker-DISCONNECT reaper
// (worker-disconnect-reaper.ts) and the 12h orphan sweeper: when a STILL-
// CONNECTED worker tears a session down (idle timeout / max duration / customer
// close / node drain / crash / egress loss / resource overuse / shutdown), it
// emits a TERMINAL `sessionStatus` frame (status ∈ {ended, errored}) up the
// fleet WS. The registry's onSessionStatus consumer hands the terminal frame
// here, and we close the matching agent_sessions row in SECONDS — the row would
// otherwise linger `status='active'` (which only otherwise flips on explicit
// DELETE / budget exhaustion / a backstop reaper), holding the worker's
// concurrent-session slot and showing the GUI a phantom "open session".
//
// frame.sessionId IS the agt_ agent-session id (== the sessionAssign.sessionId
// == created.id, A3 W2682) — NO ses_/agt_ translation. The close reason is the
// frame's clean snake_case `reason` (idle_timeout / max_duration /
// browser_crashed / …); a terminal frame that omits it (e.g. a provisioning-
// failure errored frame carries reason:nil — but those are assign-time
// rejections, not orphans) falls back to a synthesized `session-<status>`. We
// key on `reason`/`status` ONLY and never parse `detail`.
//
// Idempotent + best-effort, mirroring worker-disconnect-reaper.ts:131-156:
//   - 'active'-guard — only an `active` row is closed, so a duplicate terminal
//     frame (or a row already closed by DELETE / a backstop) is a no-op.
//   - try/catch swallow+log — this runs off the fleet WS receive loop; a throw
//     here must NOT escape into that loop. A close failure just leaves the
//     worker-disconnect reaper + 12h orphan_reap backstop to catch the row.
//
// SECURITY: the close reason becomes the row's internal-only closed_reason. We
// use `reason` (clean snake_case), never `detail`, so the egress-leak
// `direct=<node-ip>` diagnostic (W1859) that can ride `detail` never reaches it.
// If a future webhook/SDK ever surfaces closed_reason, scrub `direct=` first.

import type { AgentSessionsRepo } from './agent-sessions.js';
import type { SessionLivenessStore } from './session-liveness-store.js';
import type { SessionStatus } from '../schemas/harness-control-protocol.js';
import type { Logger } from '../lib/logger.js';

export interface CloseAgentSessionOnTerminalStatusDeps {
  readonly agentSessions: AgentSessionsRepo;
  /** The terminal `sessionStatus` frame (status ∈ TERMINAL_SESSION_STATUSES). */
  readonly frame: SessionStatus;
  /**
   * #5 — the reporting connection's authenticated nodeId. When set, the close is
   * gated on the session belonging to THIS node (cross-node spoof guard): a rogue
   * node can't close/error another node's session. Optional for backwards-compat;
   * undefined → no node gate (legacy callers).
   */
  readonly reportingNodeId?: string;
  readonly logger: Logger;
  /**
   * Optional per-session liveness store — drop the ended session's entry
   * immediately so the agent-sessions `liveness` read-shape field stops
   * reporting it as live, rather than waiting for the next heartbeat's
   * absence-reconcile. Absent (no fleet control plane / stateless deploy) → skipped.
   */
  readonly livenessStore?: SessionLivenessStore;
}

/**
 * Close the agent_sessions row a STILL-CONNECTED worker just terminated. See the
 * module header for the contract. Resolves once the close (or its no-op) settles;
 * never rejects (a failure is swallowed + logged so it can't crash the WS loop).
 */
export async function closeAgentSessionOnTerminalStatus(
  deps: CloseAgentSessionOnTerminalStatusDeps,
): Promise<void> {
  const { agentSessions, frame, reportingNodeId, logger, livenessStore } = deps;
  const reason = frame.reason ?? `session-${frame.status}`;
  try {
    const existing = await agentSessions.get(frame.sessionId);
    // #5 — only the session's OWNING node may terminate it. Drop ONLY on a CONFIRMED
    // cross-node mismatch (the row's node_id is set AND differs from the reporting
    // node); a NULL node_id (legacy / never-dispatched / manual session) is ALLOWED, or
    // legit teardown regresses. An absent reportingNodeId (legacy caller) → no gate.
    if (
      existing &&
      reportingNodeId !== undefined &&
      existing.nodeId !== null &&
      existing.nodeId !== reportingNodeId
    ) {
      logger.warn?.(
        {
          component: 'agent-session-terminal-close',
          sessionId: frame.sessionId,
          ownerNodeId: existing.nodeId,
          reportingNodeId,
        },
        'dropped terminal sessionStatus from a non-owning node (cross-node spoof guard)',
      );
      return;
    }
    // 'active'-guard = idempotent: a duplicate terminal frame, or a row already
    // closed by DELETE / a backstop reaper, is a no-op (closeWithReason on a
    // non-active row would just re-stamp it / not exist).
    if (existing && existing.status === 'active') {
      await agentSessions.closeWithReason(frame.sessionId, reason);
      logger.info?.(
        { component: 'agent-session-terminal-close', sessionId: frame.sessionId, reason },
        'closed agent session on terminal worker status (worker-connected auto-close)',
      );
    }
    // Drop the liveness entry regardless of whether we closed the row — the
    // worker has signalled this session is gone, so its store entry is stale.
    livenessStore?.delete(frame.sessionId);
  } catch (err) {
    // A close failure must not crash the WS receive loop (an uncaught throw
    // there is a process-level uncaughtException). Log + leave the
    // worker-disconnect reaper / 12h orphan_reap backstop to catch the row.
    logger.warn?.(
      {
        component: 'agent-session-terminal-close',
        sessionId: frame.sessionId,
        status: frame.status,
        err: err instanceof Error ? err.message : String(err),
      },
      'closeAgentSessionOnTerminalStatus failed (worker-disconnect / 12h orphan_reap backstop holds)',
    );
  }
}
