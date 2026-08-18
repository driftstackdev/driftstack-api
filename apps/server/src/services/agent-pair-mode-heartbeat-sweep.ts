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
// Scheduling: WIRED. `bootstrap.ts` constructs this service and drives
// `tickOnce(now)` from a 5s `setInterval`
// (`PAIR_MODE_HEARTBEAT_SWEEP_INTERVAL_MS = 5_000`), cleared on teardown.
// A timer rather than a scheduled_jobs chain on purpose: the customer-visible
// behaviour is an interactive auto-handback, so it needs sub-minute latency,
// and V-784's move of the DAY-cadence sweeps onto durable chains deliberately
// left this one alone — a 5s interval reaches its first tick immediately, which
// is the property that made the 24h timers unsafe.
//
// V-808 — this used to say the tick existed for a future scheduled-jobs entry
// and that sub-slice 8.13d would wire it. It has been wired since that slice
// landed.

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
  /** Re-entrancy guard for the fixed-interval (5s) bootstrap wiring. */
  private running = false;

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
   *   3. Atomically persist only if the active pair-mode row still has the
   *      inspected state (a concurrent input/mode transition wins otherwise)
   *   4. Emit an audit row via accountAudit.record (best-effort —
   *      failures don't break the sweep)
   *   5. Forget only the stale heartbeat snapshot. If a heartbeat refreshed
   *      while the database write was in flight, roll back this exact timeout
   *      transition instead of erasing the live heartbeat or auditing a false
   *      timeout.
   */
  async tickOnce(now: Date): Promise<SweepTickResult> {
    // Re-entrancy guard. bootstrap wires this on a fixed 5s setInterval that does
    // NOT await the previous tick (fire-and-forget). A slow tick (a large stale
    // set × per-session DB round-trips under load) would otherwise overlap the
    // next, and since `forget` runs only AFTER the persist, both ticks would
    // process the SAME stale session → duplicate agent_session.pair_mode.timeout
    // audit rows + a raced read-then-write of pair_mode_state. Skip the
    // overlapping invocation; the next interval picks up any remainder.
    if (this.running) return { inspected: 0, transitioned: 0, truncated: false };
    this.running = true;
    try {
      return await this.sweepOnce(now);
    } finally {
      this.running = false;
    }
  }

  private async sweepOnce(now: Date): Promise<SweepTickResult> {
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
      // findStaleSessions returns a snapshot. A request can refresh its
      // in-memory heartbeat while the session lookup above is awaiting the DB,
      // so validate the exact observation again immediately before the CAS.
      const observedHeartbeatAt = this.deps.tracker.getLastHeartbeatAt(sessionId);
      const staleBefore = now.getTime() - this.ttlMs;
      if (observedHeartbeatAt === null || observedHeartbeatAt.getTime() >= staleBefore) {
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
      const updated = await this.deps.sessions.compareAndSetPairModeState(
        sessionId,
        rec.pairModeState,
        nextState,
      );
      if (updated === null) {
        // The customer or another transition changed mode/state/status after
        // our read. Never overwrite that winner or emit a timeout audit for a
        // transition we did not commit. Keep the tracker observation: it may
        // already contain a heartbeat refreshed while the CAS was in flight.
        continue;
      }
      const latestHeartbeatAt = this.deps.tracker.getLastHeartbeatAt(sessionId);
      if (latestHeartbeatAt?.getTime() !== observedHeartbeatAt.getTime()) {
        // A live request refreshed its heartbeat while our database CAS was in
        // flight. Undo only the exact timeout state we just wrote. If another
        // state/mode/status writer has already won, its CAS predicate wins and
        // the rollback safely becomes a no-op. Either way, no false timeout
        // audit is emitted and the fresh heartbeat remains tracked.
        await this.deps.sessions.compareAndSetPairModeState(
          sessionId,
          nextState,
          rec.pairModeState,
        );
        continue;
      }
      // Delete the validated stale observation before the first subsequent
      // await. A heartbeat arriving after this point creates a fresh entry and
      // cannot be erased by slow audit I/O.
      this.deps.tracker.forget(sessionId);
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
      transitioned += 1;
    }

    return { inspected: handled.length, transitioned, truncated };
  }
}
