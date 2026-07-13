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
//   - 'active'-guard — a cheap short-circuit on the initial `get()` read, but
//     NOT what actually makes this race-safe (that read is stale the instant
//     another closer's write lands between it and our own). Real safety comes
//     from agent-sessions-repo.ts's closeWithReason itself being ATOMIC — a
//     single `UPDATE … WHERE id=$id AND status='active' RETURNING *` — so a
//     duplicate terminal frame, a row already closed by DELETE / a backstop,
//     OR a genuine same-instant race against another closer (e.g. this node's
//     own bootId sweep) all safely no-op without clobbering the winner's
//     closed_reason (audit fix 2026-07-01; see closeWithReason's own header).
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
import type { SessionPageStateStore } from './session-page-state-store.js';
import type { SessionCapabilityReportStore } from './session-capability-report-store.js';
import type { SessionStatus } from '../schemas/harness-control-protocol.js';
import type { Logger } from '../lib/logger.js';
import { makeBoundedNodeLatestRelay } from './bounded-node-latest-relay.js';
import { isCrossNodeSpoof } from './fleet-session-ownership.js';

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
  /**
   * Audit 2026-07-01 (MEDIUM) — optional in-memory pageState store. Every
   * OTHER session-termination path (customer DELETE) already evicts this
   * session's cached pageState on close (session-page-state-evict-on-close-
   * guard.test.ts); this one — the fast, PRECISE worker-connected terminal
   * close — did not, so a session that ended this way (idle_timeout /
   * browser_crashed / …) could leave its LAST reported state, possibly
   * 'stalled' (the frozen-renderer signal this whole feature exists to
   * detect), served by GET /:id/page-state indefinitely. Dropped regardless of
   * whether we actually closed the row here (mirrors `livenessStore` below —
   * the worker has signalled this session is gone either way). Absent (no
   * fleet control plane / stateless deploy) → skipped.
   */
  readonly sessionPageStateStore?: SessionPageStateStore;
  readonly sessionCapabilityReportStore?: SessionCapabilityReportStore;
}

/**
 * Close the agent_sessions row a STILL-CONNECTED worker just terminated. See the
 * module header for the contract. Resolves once the close (or its no-op) settles;
 * never rejects (a failure is swallowed + logged so it can't crash the WS loop).
 */
export async function closeAgentSessionOnTerminalStatus(
  deps: CloseAgentSessionOnTerminalStatusDeps,
): Promise<void> {
  const {
    agentSessions,
    frame,
    reportingNodeId,
    logger,
    livenessStore,
    sessionPageStateStore,
    sessionCapabilityReportStore,
  } = deps;
  const reason = frame.reason ?? `session-${frame.status}`;
  try {
    const existing = await agentSessions.get(frame.sessionId);
    // #5 — only the session's exact OWNING node may terminate it. An authenticated
    // fleet frame targeting a NULL-owner row has no ownership proof and fails closed;
    // dispatch persists node_id before sending the assignment. An absent reporting
    // node remains accepted only for legacy non-registry callers.
    if (existing && isCrossNodeSpoof(existing.nodeId, reportingNodeId)) {
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
    // 'active'-guard = a cheap short-circuit (skip the write entirely when
    // this SAME read already shows the row inactive) — a duplicate terminal
    // frame, or a row already closed by DELETE / a backstop reaper, is a
    // no-op. It is NOT relied on for correctness: `existing` is a stale
    // snapshot, so another closer (e.g. this node's own bootId sweep, or a
    // concurrent customer DELETE / budget-exhausted close) can still land
    // between this read and the closeWithReason call below. Safety instead
    // comes from closeWithReason itself now being ATOMIC — a single
    // `UPDATE … WHERE id=$id AND status='active'` (agent-sessions-repo.ts) —
    // so a race can never clobber another closer's true closed_reason.
    if (existing && existing.status === 'active') {
      const updated = await agentSessions.closeWithReason(frame.sessionId, reason);
      if (updated.closedReason === reason) {
        logger.info?.(
          { component: 'agent-session-terminal-close', sessionId: frame.sessionId, reason },
          'closed agent session on terminal worker status (worker-connected auto-close)',
        );
      } else {
        // We lost the race: closeWithReason's atomic WHERE status='active'
        // guard no longer matched (another closer's UPDATE already landed),
        // so it no-opped and handed back the OTHER closer's row untouched.
        // Nothing to re-log/re-process here — the row correctly keeps the
        // other closer's true teardown reason, not ours.
        logger.info?.(
          {
            component: 'agent-session-terminal-close',
            sessionId: frame.sessionId,
            attemptedReason: reason,
            actualClosedReason: updated.closedReason,
          },
          'terminal sessionStatus raced another closer; session already closed under a different reason (no-op)',
        );
      }
    }
    // Drop the liveness entry regardless of whether we closed the row — the
    // worker has signalled this session is gone, so its store entry is stale.
    livenessStore?.delete(frame.sessionId);
    // Audit 2026-07-01 — same reasoning: evict the cached pageState too, so a
    // dead session's last (possibly 'stalled') report doesn't keep serving
    // from GET /:id/page-state after the worker has told us it's gone.
    sessionPageStateStore?.delete(frame.sessionId);
    sessionCapabilityReportStore?.delete(frame.sessionId);
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

export type AgentSessionTerminalStatusRelayDeps = Omit<
  CloseAgentSessionOnTerminalStatusDeps,
  'frame' | 'reportingNodeId'
>;

/**
 * Build the authenticated FleetControlRegistry terminal-status consumer. A
 * compromised node cannot turn unique fake session ids into unlimited DB work:
 * each reporting node gets the shared 512-session admission budget and eight
 * concurrent close operations. Repeated pending status for one session keeps
 * only the newest successor; the atomic close path still guarantees first
 * successful close wins and later duplicates cannot overwrite its reason.
 */
export function makeAgentSessionTerminalStatusRelay(
  deps: AgentSessionTerminalStatusRelayDeps,
): (frame: SessionStatus, reportingNodeId: string) => void {
  return makeBoundedNodeLatestRelay({
    getSessionId: (frame: SessionStatus) => frame.sessionId,
    process: (frame, reportingNodeId) =>
      closeAgentSessionOnTerminalStatus({ ...deps, frame, reportingNodeId }),
    onError: ({ error, reportingNodeId, sessionId }) => {
      deps.logger.error(
        {
          component: 'agent-session-terminal-close',
          sessionId,
          reportingNodeId,
          err: error,
        },
        'terminal sessionStatus relay failed unexpectedly',
      );
    },
    onOverflow: ({ reportingNodeId, sessionBudget, sessionId }) => {
      deps.logger.warn(
        {
          component: 'agent-session-terminal-close',
          sessionId,
          reportingNodeId,
          sessionBudget,
        },
        'dropped terminal sessionStatus because the reporting node exceeded its relay session budget',
      );
    },
  });
}
