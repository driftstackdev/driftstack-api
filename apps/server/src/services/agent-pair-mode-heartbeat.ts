// Arc 4 Wave 2.B sub-slice 8.13b (v2-#8) — pair-mode heartbeat tracker.
//
// Pure data structure that maps `sessionId → lastHeartbeatAt` and
// exposes `findStaleSessions(now, ttlMs)` so a sweep service can
// fire the `heartbeat-timeout` state-machine transition (sub-slice
// 8.13) for each stale session.
//
// The sweep service itself is intentionally not wired here — that
// follow-up adds a scheduled-job entry that scans this tracker every
// 5s and fires the transition + audit emit (sub-slice 8.13c). This
// slice ships the tracker primitive in isolation so its semantics
// are pinned by unit tests before any cron-driver couples to it.
//
// Single-replica today. A future redis-backed swap can replace the
// in-memory Map with redis-hash storage; the public interface stays
// the same so the swap is invisible to callers.

export interface PairModeHeartbeatTracker {
  /**
   * Record a fresh heartbeat for the given session. Idempotent —
   * subsequent calls just overwrite the timestamp.
   */
  recordHeartbeat(args: { sessionId: string; at: Date }): void;

  /**
   * Forget a session's heartbeat (called on session close or
   * explicit handback-complete so the tracker doesn't accumulate
   * stale entries indefinitely).
   */
  forget(sessionId: string): void;

  /**
   * Return sessionIds whose lastHeartbeatAt is older than `now - ttlMs`.
   * The sweep service walks these and fires the heartbeat-timeout
   * transition on each.
   *
   * Returns sessions sorted by lastHeartbeatAt ascending (oldest
   * first) so the sweep handles the most-stuck sessions first if it
   * has to truncate.
   */
  findStaleSessions(args: { now: Date; ttlMs: number }): readonly string[];

  /** Test-only: read the current last-heartbeat for a session. */
  getLastHeartbeatAt(sessionId: string): Date | null;
}

/** In-memory implementation. Single-replica today; redis-backed
 *  swap is a v1.1 follow-up. */
export class InMemoryPairModeHeartbeatTracker implements PairModeHeartbeatTracker {
  private readonly entries = new Map<string, Date>();

  recordHeartbeat(args: { sessionId: string; at: Date }): void {
    this.entries.set(args.sessionId, args.at);
  }

  forget(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  findStaleSessions(args: { now: Date; ttlMs: number }): readonly string[] {
    const cutoff = args.now.getTime() - args.ttlMs;
    const stale: Array<{ id: string; ts: number }> = [];
    for (const [sessionId, last] of this.entries) {
      const ts = last.getTime();
      if (ts < cutoff) stale.push({ id: sessionId, ts });
    }
    stale.sort((a, b) => a.ts - b.ts);
    return stale.map((s) => s.id);
  }

  getLastHeartbeatAt(sessionId: string): Date | null {
    return this.entries.get(sessionId) ?? null;
  }
}

/** Default heartbeat-timeout window per founder verdict on the
 *  Wave 2.A 8.13 transition (30 seconds). Exported as a constant so
 *  the sweep service + docs + state-machine commentary stay aligned. */
export const PAIR_MODE_HEARTBEAT_TTL_MS = 30_000;
