// 2026-06-23 — CP bootId consumer (A2 W2813 / A3 W2827).
//
// A3 now puts a per-PROCESS `bootId` (`ProcessInfo.processInfo.globallyUniqueString`,
// captured once per daemon process) on the Heartbeat wire. This is the missing third
// leg of the CP↔daemon reconcile (A2 W2808/W2809 keystone #3): it distinguishes a
// daemon RESTART from a mere reconnect.
//
// Why it's needed: the worker-disconnect reaper (worker-disconnect-reaper.ts) closes a
// node's active sessions only after the disconnect GRACE expires. A daemon that crashes
// and respawns FAST — reconnecting inside that grace window — cancels the reaper, so its
// prior in-memory sessions (gone with the dead process) are never cleaned up: they linger
// CP-active (billed, holding a concurrency slot, phantom in the GUI) until the 12h
// orphan_reap. The W2809 reconcile doesn't catch them either (it only re-issues sessionEnd
// for sessions the worker REPORTS active that the CP holds terminal — the reverse case).
//
// The bootId CHANGE is the precise signal: same node id, new process ⇒ its old sessions
// are gone. We then close the sessions the CP still holds active for that node, EXCEPT the
// ones the NEW boot reaffirms in this beat's `activeSessionStates` (a session freshly
// assigned to the new process — reported active/provisioning). That keep-set makes the
// sweep safe against the reconnect→first-beat new-session race: a just-dispatched session
// is reaffirmed by the node, so it's never swept.
//
// SAFE BY DESIGN:
//   - fires ONLY on a CONFIRMED change (a previously-recorded bootId that now differs) —
//     the FIRST bootId we see for a node (incl. after a CP restart, which empties the map)
//     records only, never closes, so a CP restart can't mass-close the fleet;
//   - the close is node-scoped + status='active'-anchored (closeActiveByNodeExcept) → never
//     touches another node's or an already-closed session;
//   - reaffirmed (kept) ids exclude the new boot's live sessions → no new-session race kill;
//   - best-effort off the receive loop: a throw is swallowed+logged; the disconnect reaper +
//     12h orphan_reap remain the backstops.

import type { Logger } from '../lib/logger.js';

/** closed_reason stamped on sessions swept by a node restart (bootId change). */
export const WORKER_RESTARTED_CLOSE_REASON = 'worker-restarted';

export interface NodeBootReconcileDeps {
  /** Just the node-scoped close primitive — keeps this helper decoupled + unit-testable. */
  readonly agentSessions: {
    closeActiveByNodeExcept(
      nodeId: string,
      keepIds: readonly string[],
      reason: string,
    ): Promise<number>;
  };
  readonly macNodeId: string;
  /** Heartbeat.bootId — undefined on an older/quieter node's beat (then this is a no-op). */
  readonly bootId: string | undefined;
  /**
   * Session ids the node currently reports (Heartbeat.activeSessionStates keys). Kept
   * across the restart sweep so a session freshly assigned to the NEW boot is never swept.
   */
  readonly reaffirmedSessionIds: readonly string[];
  /**
   * Caller-owned PERSISTENT map (macNodeId → last-seen bootId). Mutated here. Lives for the
   * process lifetime so a change is detectable across beats; reset on CP restart (intended —
   * see the SAFE-BY-DESIGN note: a CP restart records-only on the first beat, never closes).
   */
  readonly bootIdByNode: Map<string, string>;
  readonly logger: Logger;
}

/**
 * Track a node's `bootId` and, on a CONFIRMED change (= daemon restart), close the node's
 * CP-active sessions the new boot does not reaffirm. See the module header for the contract
 * + safety guard. Resolves once the (at most one) sweep is done; never rejects.
 */
export async function reconcileNodeBootChange(deps: NodeBootReconcileDeps): Promise<void> {
  const { agentSessions, macNodeId, bootId, reaffirmedSessionIds, bootIdByNode, logger } = deps;
  if (bootId === undefined) return; // no signal on the wire (older node) — nothing to do
  const prev = bootIdByNode.get(macNodeId);
  bootIdByNode.set(macNodeId, bootId);
  // First bootId we've seen for this node (incl. right after a CP restart) → record only.
  // We can't infer a restart from a single observation, and mass-closing on CP restart
  // would be catastrophic. Unchanged → same process, just a reconnect → nothing to do.
  if (prev === undefined || prev === bootId) return;
  try {
    const closed = await agentSessions.closeActiveByNodeExcept(
      macNodeId,
      reaffirmedSessionIds,
      WORKER_RESTARTED_CLOSE_REASON,
    );
    logger.info(
      {
        component: 'node-boot-reconcile',
        nodeId: macNodeId,
        prevBootId: prev,
        bootId,
        closed,
        reaffirmed: reaffirmedSessionIds.length,
      },
      `node restarted (bootId changed) — closed ${closed} orphaned session(s)`,
    );
  } catch (err) {
    logger.warn(
      { component: 'node-boot-reconcile', nodeId: macNodeId, err: String(err) },
      'node-restart session sweep failed (disconnect reaper + 12h orphan_reap remain backstops)',
    );
  }
}
