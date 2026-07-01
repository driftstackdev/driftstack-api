// 2026-06-19 — worker-disconnect agent-session reaper (fast, precise).
//
// Agent sessions only flip to `closed` on an explicit DELETE or budget
// exhaustion. The wall-clock backstop (agent-session-orphan-sweeper, 12h cap)
// guarantees a session orphaned by a dead worker eventually closes — but a
// crashed/restarted worker holds its concurrent-session slot (harness
// maxConcurrent) for up to 12h, which at small maxConcurrent shows up as
// at_capacity refusals.
//
// This reaper closes the gap to MINUTES. It is the PRECISE complement to the
// coarse backstop (and to the GUI page-state liveness): when a node's
// control-plane connection DISCONNECTS (socket close/error → registry
// unregister), it arms a per-node grace timer. If the node has NOT re-registered
// when the timer fires, it closes that node's `status='active'` sessions
// (closeActiveByNode, reason='worker-disconnected') — freeing the slots.
//
// The grace window is what prevents a transient WS blip (or a deliberate worker
// restart) from false-closing live sessions: a re-register within the grace
// CANCELS the timer, so no close happens. DRIFTSTACK_WORKER_DISCONNECT_GRACE_SECONDS
// (default 120). A non-finite / non-positive override falls back to the default,
// so a fat-fingered env var can never disable the grace (which would make a
// blip close live sessions) nor push it to 0.
//
// Wiring (bootstrap, behind FLEET_CONTROL_PLANE_ENABLED): the reaper's
// `onNodeRegistered` / `onNodeDisconnected` are threaded into the
// FleetControlRegistry constructor (positional args 6 + 7). No scheduled job —
// the timers are in-process, armed/cancelled by the live WS lifecycle. (A
// process restart drops the in-flight timers; the 12h orphan_reap backstop
// still closes anything missed, so no slot leaks permanently.)

import type { AgentSessionsRepo } from './agent-sessions.js';
import type { Logger } from '../lib/logger.js';

export const WORKER_DISCONNECTED_CLOSE_REASON = 'worker-disconnected';

const DEFAULT_GRACE_SECONDS = 120;

/**
 * Read the disconnect grace (in seconds) from the environment, falling back to
 * the 120s default. A non-finite / non-positive value falls back too, so a
 * fat-fingered env var can never disable the grace (which would let a transient
 * WS blip false-close live sessions).
 */
export function resolveDisconnectGraceSeconds(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.DRIFTSTACK_WORKER_DISCONNECT_GRACE_SECONDS;
  if (raw === undefined) return DEFAULT_GRACE_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_GRACE_SECONDS;
  return parsed;
}

export interface WorkerDisconnectReaperDeps {
  readonly repo: AgentSessionsRepo;
  readonly logger: Logger;
  /** Seconds a disconnected node may stay gone before its active sessions are
   *  closed. Defaults to DRIFTSTACK_WORKER_DISCONNECT_GRACE_SECONDS / 120. */
  readonly graceSeconds?: number;
  /**
   * Timer seam — defaults to global setTimeout/clearTimeout. Overridden in
   * tests (fake timers / a manual queue). Typed to accept the Node return so a
   * real setTimeout slots in without a cast.
   */
  readonly setTimeoutFn?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Per-node grace timers for the worker-disconnect close. Arm on disconnect,
 * cancel on (re)register, fire `closeActiveByNode` on expiry.
 */
export class WorkerDisconnectReaperService {
  private readonly graceMs: number;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: WorkerDisconnectReaperDeps) {
    this.graceMs = (deps.graceSeconds ?? resolveDisconnectGraceSeconds()) * 1000;
    this.setTimeoutFn = deps.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutFn = deps.clearTimeoutFn ?? ((h) => clearTimeout(h));
  }

  /**
   * The node's connection just dropped (socket close/error → registry
   * unregister). Arm the grace timer. If a timer is already pending for this
   * node (e.g. a flapping socket), it is replaced (the latest disconnect wins —
   * the window restarts), so a node that drops repeatedly without ever
   * re-registering still gets closed exactly `grace` after its LAST drop.
   */
  onNodeDisconnected(nodeId: string): void {
    this.cancel(nodeId);
    const handle = this.setTimeoutFn(() => {
      // Clear our own bookkeeping FIRST — the timer has fired; it's no longer
      // pending, so a later register() must not try to clear a dead handle.
      this.timers.delete(nodeId);
      void this.closeNode(nodeId);
    }, this.graceMs);
    this.timers.set(nodeId, handle);
  }

  /**
   * The node (re)connected. CANCEL any pending grace timer for it — a
   * reconnect within the grace means the worker is alive, so its sessions stay
   * open (no close). A register with no pending timer is a harmless no-op.
   */
  onNodeRegistered(nodeId: string): void {
    this.cancel(nodeId);
  }

  /** Pending grace timers (test/inspection helper). */
  pendingCount(): number {
    return this.timers.size;
  }

  /** Clear all pending timers (graceful-shutdown helper; the 12h backstop covers
   *  anything dropped on shutdown). */
  stop(): void {
    for (const handle of this.timers.values()) this.clearTimeoutFn(handle);
    this.timers.clear();
  }

  private cancel(nodeId: string): void {
    const handle = this.timers.get(nodeId);
    if (handle === undefined) return;
    this.clearTimeoutFn(handle);
    this.timers.delete(nodeId);
  }

  private async closeNode(nodeId: string): Promise<void> {
    try {
      // Audit 2026-07-01 (MEDIUM) — this bulk close does NOT evict the closed
      // sessions' entries from session-page-state-store.ts (unlike the
      // customer DELETE route and agent-session-terminal-close.ts, which both
      // know the exact session id being closed). closeActiveByNode only
      // returns a row COUNT, not the affected session ids, so there is no
      // cheap id to call store.delete() with here — getting one would need an
      // AgentSessionsRepo signature change (agent-sessions.ts /
      // agent-sessions-repo.ts), out of scope for this fix. This is safe: GET
      // /:id/page-state (routes/agent-sessions.ts) cross-checks the session's
      // live `status` — which THIS call flips to 'closed' in the same
      // statement — before ever reading the page-state store, so a session
      // closed here can never serve a stale cached pageState regardless of
      // whether this store entry is proactively evicted.
      const closed = await this.deps.repo.closeActiveByNode(
        nodeId,
        WORKER_DISCONNECTED_CLOSE_REASON,
      );
      this.deps.logger.info?.(
        { component: 'worker-disconnect-reaper', nodeId, closed },
        closed > 0
          ? 'closed disconnected node active sessions (grace expired)'
          : 'grace expired with no active sessions to close',
      );
    } catch (err) {
      // A close failure must not crash the timer callback (an uncaught throw in
      // a setTimeout cb is a process-level uncaughtException). Log + leave the
      // 12h orphan_reap backstop to catch anything missed.
      this.deps.logger.warn?.(
        {
          component: 'worker-disconnect-reaper',
          nodeId,
          err: err instanceof Error ? err.message : String(err),
        },
        'closeActiveByNode failed on grace expiry (12h orphan_reap backstop holds)',
      );
    }
  }
}
