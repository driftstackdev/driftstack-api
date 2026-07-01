// In-memory latest-worker-liveness-per-AGENT-session store (A2 W2679 re-base;
// A3 driftstack f52699c37).
//
// The harness emits Heartbeat.activeSessionStates — a {agentSessionId → state}
// map of the sessions a node is actually driving right now (active /
// provisioning / idle / terminating) — keyed by the sessionAssign.sessionId
// (== the agt_ agent-session id, A3 W1254; the same id pageState uses). The
// fleet-control-registry's onHeartbeat consumer feeds every beat here; the
// agent-sessions read shape's `liveness` field reads it so the GUI can tell a
// genuinely-running session from a `status='active'` row whose worker crashed
// or never started (the founder-noted "always says open session" bug). This is
// the SERVER half of replacing the GUI's client-side page-state probe + 90s
// grace heuristic.
//
// Absence semantics are SAFE only when scoped per-node: a session is evicted
// only when its OWNING node beats WITHOUT it (a per-node absence = the node
// ended/orphaned it). A DIFFERENT node's beat says nothing about another node's
// sessions and must NEVER evict them; a node that has gone silent must not flip
// its sessions to absent either (a beatAt staleness guard, plus the
// worker-disconnect reaper + 12h orphan sweeper, are the backstops for that —
// never treat a missing/stale entry as authoritatively "dead").
//
// Bounded (oldest-evicted) like SessionPageStateStore so dead sessions can't
// grow it unbounded; liveness is re-emitted on the next ~10s beat, so dropping
// a stale entry is safe (the reader falls back to "unknown → trust the binding").

/** The worker-reported lifecycle state for a session it is driving. */
export type SessionLivenessState = 'active' | 'provisioning' | 'idle' | 'terminating';

/** Default freshness window: a node beats ~every 10s, so 3-4 missed beats
 *  (~35s) means the node has gone quiet — fall back to "unknown" rather than
 *  trusting a stale 'active' entry forever. Agrees with the worker-disconnect
 *  reaper grace so the two backstops don't disagree. */
export const SESSION_LIVENESS_TTL_MS = 35_000;

/** A single session's latest liveness, with the owning node + beat timestamp so
 *  the reader can apply the per-node staleness guard. */
export interface SessionLivenessEntry {
  state: SessionLivenessState;
  nodeId: string;
  beatAt: number;
}

export class SessionLivenessStore {
  private readonly map = new Map<string, SessionLivenessEntry>();

  constructor(private readonly maxEntries = 5_000) {}

  /**
   * Record a node's per-session liveness from one heartbeat.
   *
   * For every sessionId PRESENT in `states`, (re)write its entry as live from
   * `macNodeId` at `beatAt`. For every sessionId previously seen FROM THIS node
   * but now ABSENT from `states`, evict it (per-node absence = ended/orphaned).
   * Entries owned by OTHER nodes are left untouched — a different node's beat
   * never evicts another node's sessions (anti-cross-node-poison; the upstream
   * macNodeId==JWT-nodeId guard in fleet-control-registry keeps a spoofed beat
   * from claiming another node's id in the first place).
   */
  recordBeat(
    macNodeId: string,
    states: Record<string, SessionLivenessState>,
    beatAt: number,
  ): void {
    // Reconcile-evict first: any session this node previously owned but didn't
    // report in this beat has ended on that node.
    for (const [sessionId, entry] of this.map) {
      if (entry.nodeId === macNodeId && !(sessionId in states)) {
        this.map.delete(sessionId);
      }
    }
    // Then (re)write every present session as live from this node.
    for (const [sessionId, state] of Object.entries(states)) {
      // delete+set moves the key to newest in insertion order, so the
      // per-node eviction below drops THIS node's genuinely-stalest sessions.
      this.map.delete(sessionId);
      this.map.set(sessionId, { state, nodeId: macNodeId, beatAt });
    }
    // Size-cap eviction — SCOPED PER-NODE (security-audit hardening,
    // 2026-06-30): a node's beat may ONLY evict its OWN oldest entries, never
    // another node's. The prior global-oldest eviction here was a SEPARATE
    // cross-node-poison hole from the per-node absence-evict logic above: one
    // node fabricating enough session ids in a single heartbeat (bounded by
    // the schema-level HARNESS_HEARTBEAT_MAX_ACTIVE_SESSION_STATES cap) could
    // otherwise evict every OTHER node's real liveness entries from this
    // process-wide shared map. Self-evicts only once THIS node's own share of
    // the map exceeds its fair allocation (maxEntries split evenly across the
    // distinct nodes currently present) — a well-behaved fleet with few
    // sessions per node never trips this; only a node hoarding more than its
    // fair share self-trims, complementing the schema-level cap.
    if (this.map.size > this.maxEntries) {
      this.evictOwnOverflow(macNodeId);
    }
  }

  /**
   * Evict `macNodeId`'s own oldest entries down to its fair share of
   * `maxEntries` (NEVER another node's) — the per-node-scoped complement to
   * the size cap. No-ops if this node isn't over its own fair share, so a
   * single well-behaved (or even a different over-fair-share) node's beat can
   * never trigger eviction of entries this node doesn't own.
   */
  private evictOwnOverflow(macNodeId: string): void {
    const nodeIds = new Set<string>();
    let ownCount = 0;
    for (const entry of this.map.values()) {
      nodeIds.add(entry.nodeId);
      if (entry.nodeId === macNodeId) ownCount++;
    }
    const fairShare = Math.max(1, Math.floor(this.maxEntries / nodeIds.size));
    let toEvict = ownCount - fairShare;
    if (toEvict <= 0) return;
    // Map iteration order is insertion order, so this walks macNodeId's own
    // entries oldest-first (recordBeat's delete+set re-inserts a still-live
    // session at the newest position every beat).
    for (const [sessionId, entry] of this.map) {
      if (toEvict <= 0) break;
      if (entry.nodeId === macNodeId) {
        this.map.delete(sessionId);
        toEvict--;
      }
    }
  }

  /** Latest liveness for an agent session, or null if none reported yet. */
  get(sessionId: string): SessionLivenessEntry | null {
    return this.map.get(sessionId) ?? null;
  }

  /**
   * Whether an entry's beat is recent enough to trust. A silent node's stale
   * 'active' entry returns false so the reader falls back to "unknown" instead
   * of trusting it forever. `now` is injectable for tests.
   */
  isFresh(entry: SessionLivenessEntry, ttlMs = SESSION_LIVENESS_TTL_MS, now = Date.now()): boolean {
    return now - entry.beatAt <= ttlMs;
  }

  /** Drop a session's entry (e.g. on session end). */
  delete(sessionId: string): void {
    this.map.delete(sessionId);
  }

  /** Active entry count — for tests + size assertions. */
  get size(): number {
    return this.map.size;
  }
}
