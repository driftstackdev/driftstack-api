// Arc 4 Wave 2.B sub-slice 8.13c (v2-#8) — pair-mode heartbeat sweep.
//
// Walks PairModeHeartbeatTracker.findStaleSessions(), fires the
// `heartbeat-timeout` state-machine transition for each, persists
// the post-transition state, and emits an
// `agent_session.pair_mode.timeout` customer audit row. Bounded by
// the in-memory tracker's session count + the TTL — typical sweep
// touches zero sessions; under heavy use it touches one per stale
// pair-mode session.
//
// Scheduling: this service exposes `tickOnce(now)` for a future
// scheduled-jobs entry. Sub-slice 8.13d will wire bootstrap to fire
// this every 5s alongside the other rotation-reminder jobs.

import type { AgentSessionsRepo } from './agent-sessions.js';
import type { AccountAuditService } from './account-audit.js';
import type { PairModeHeartbeatTracker } from './agent-pair-mode-heartbeat.js';
import { PAIR_MODE_HEARTBEAT_TTL_MS } from './agent-pair-mode-heartbeat.js';
import {
  applyPairModeTransition,
  initialPairModeState,
  type PairModeState,
} from './agent-pair-mode-state.js';

export interface PairModeHeartbeatSweepDeps {
  readonly tracker: PairModeHeartbeatTracker;
  readonly sessions: AgentSessionsRepo;
  readonly accountAudit?: AccountAuditService;
  /** Override the 30s default for testing. */
  readonly ttlMs?: number;
  /** Cap on sessions handled per tick so a flood of stale sessions
   *  doesn't block the scheduler. Default 100. */
  readonly maxPerTick?: number;
}

export interface SweepTickResult {
  readonly inspected: number;
  readonly transitioned: number;
  /** Truncated when the stale set exceeded maxPerTick. */
  readonly truncated: boolean;
}

export class PairModeHeartbeatSweep {
  private readonly ttlMs: number;
  private readonly maxPerTick: number;

  constructor(private readonly deps: PairModeHeartbeatSweepDeps) {
    this.ttlMs = deps.ttlMs ?? PAIR_MODE_HEARTBEAT_TTL_MS;
    this.maxPerTick = deps.maxPerTick ?? 100;
  }

  /**
   * Walk one sweep cycle. For each session whose lastHeartbeatAt is
   * older than now - ttlMs:
   *   1. Look up the session record (skip if it no longer exists)
   *   2. Compute the heartbeat-timeout transition against the current
   *      pair_mode_state (silent no-op when already in ai-driving)
   *   3. Persist the new state via sessions.setPairModeState
   *   4. Emit an audit row via accountAudit.record (best-effort —
   *      failures don't break the sweep)
   *   5. Forget the session in the tracker (so the next tick doesn't
   *      keep firing for an already-handled timeout)
   */
  async tickOnce(now: Date): Promise<SweepTickResult> {
    const stale = this.deps.tracker.findStaleSessions({ now, ttlMs: this.ttlMs });
    const truncated = stale.length > this.maxPerTick;
    const handled = truncated ? stale.slice(0, this.maxPerTick) : stale;
    let transitioned = 0;

    for (const sessionId of handled) {
      const rec = await this.deps.sessions.get(sessionId);
      if (rec === null) {
        // Session destroyed/gc'd — forget so the tracker doesn't
        // keep flagging.
        this.deps.tracker.forget(sessionId);
        continue;
      }
      // Closed session: the customer's pair-mode session is done.
      // No point firing a heartbeat-timeout transition (closed
      // sessions can't transition state anyway, and the audit row
      // would be misleading — "auto-handback after 30s" on a row
      // that's been closed for hours). Forget the tracker entry +
      // continue.
      if (rec.status === 'closed') {
        this.deps.tracker.forget(sessionId);
        continue;
      }
      const currentState = (rec.pairModeState as PairModeState | null) ?? initialPairModeState();
      // The heartbeat-timeout transition is idempotent on ai-driving
      // (silent no-op). The state machine accepts it from every state
      // so the sweep doesn't need to inspect state first.
      const nextState = applyPairModeTransition(currentState, {
        kind: 'heartbeat-timeout',
        at: now.toISOString(),
      });
      if (nextState.kind === currentState.kind) {
        // No-op transition (e.g. already in ai-driving). Skip the
        // persist + audit emit — there's no state change to record.
        this.deps.tracker.forget(sessionId);
        continue;
      }
      await this.deps.sessions.setPairModeState(sessionId, nextState);
      try {
        await this.deps.accountAudit?.record({
          accountId: rec.accountId,
          actorType: 'system',
          action: 'agent_session.pair_mode.timeout',
          targetResourceId: `agent_session_${sessionId}`,
          payload: { from: currentState.kind, to: nextState.kind },
        });
      } catch {
        /* swallow — sweep continues even when audit emit fails */
      }
      this.deps.tracker.forget(sessionId);
      transitioned += 1;
    }

    return { inspected: handled.length, transitioned, truncated };
  }
}
