// T-9 — per-agent-session bounded ring of network-log entries.
//
// The harness (A3, the fork) emits HarnessOutbound.networkRequests keyed by the
// AGENT session id: the per-request rows the simulator's DevTools-style Network
// pane shows (URL, method, status, and — the point of the feature — the
// negotiated wire protocol h1/h2/h3). The ownership-gated relay
// (session-network-log-relay.ts) is the only writer; GET /v1/agent-sessions/
// :id/network reads it.
//
// A ring, not a single latest value (unlike SessionPageStateStore): the pane
// needs the RECENT HISTORY of requests, not just the last one. Each session
// keeps at most NETWORK_LOG_RING_MAX_ENTRIES rows; the oldest is evicted once it
// grows past that, so a long-lived, request-heavy session cannot grow one
// session's ring unbounded.
//
// Bounded across sessions too (LRU + TTL, the exit-identity-cache pattern): a
// session whose frames stop arriving is swept on the next append rather than
// retained forever, and once the map exceeds `maxSessions` the stalest session
// is evicted. Both bounds are memory hygiene — the data is live + ephemeral (the
// fork re-emits as the session keeps browsing), so dropping a stale session's
// ring is safe: at worst the pane shows nothing until the next frame.
//
// The read cursor is the SERVER's own monotonic per-session sequence
// (`lastSeq`), never a harness-supplied entry id: the id is attacker-influenced
// (a node fills it) and need not be unique or ordered, so keying the "give me
// what's new since X" cursor on it would let a node stall or replay a client's
// poll. `next_after` is that server seq as a string, and a client passes it back
// as `after` to fetch only rows appended since.

import type { NetworkRequestEntry } from '../schemas/harness-control-protocol.js';
import { NETWORK_LOG_RING_MAX_ENTRIES } from '../schemas/harness-control-protocol.js';

/** One retained row: the customer-facing entry plus the server seq that orders
 *  it. `seq` is the read cursor; it is stripped before an entry crosses to a
 *  caller (only the entry payload is returned). */
interface RingRow {
  seq: number;
  entry: NetworkRequestEntry;
}

/** Per-session state: the bounded ring, the monotonic seq high-water mark, and
 *  the wall-clock time the session was last written (for the TTL sweep). */
interface SessionRing {
  ring: RingRow[];
  lastSeq: number;
  at: number;
}

/** What GET /v1/agent-sessions/:id/network returns for a live session. */
export interface SessionNetworkLog {
  entries: NetworkRequestEntry[];
  /** The newest server seq in the ring as a string, or null when the ring is
   *  empty. A client passes it back as `after` to poll only newer rows. */
  next_after: string | null;
}

/** Idle-session eviction window. A session whose frames stop arriving is swept
 *  on the next append after this long. Generous (a live pane may sit idle while
 *  the user reads a page) but bounded so a dead session cannot be retained
 *  forever. Injectable via the constructor for deterministic tests. */
export const NETWORK_LOG_SESSION_TTL_MS = 30 * 60 * 1000;

export class SessionNetworkLogStore {
  private readonly map = new Map<string, SessionRing>();

  constructor(
    /** Hard cap on concurrent sessions (stalest-inserted evicted on overflow). */
    private readonly maxSessions = 5_000,
    /** Idle-session lifetime in ms. */
    private readonly ttlMs = NETWORK_LOG_SESSION_TTL_MS,
    /** Clock seam (ms epoch) — overridden in tests for deterministic TTL math. */
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /**
   * Append validated + already-capped entries to a session's ring. Each row is
   * stamped with the next server seq. The ring is size-capped (oldest evicted)
   * AFTER the append, and the cross-session map is swept for expired sessions +
   * LRU-capped so neither axis grows unbounded.
   */
  append(sessionId: string, entries: readonly NetworkRequestEntry[]): void {
    const now = this.clock();
    // TTL sweep across sessions — drop any whose last write is older than the
    // idle window, so a session that stopped reporting is not retained forever.
    for (const [id, state] of this.map) {
      if (now - state.at > this.ttlMs) this.map.delete(id);
    }
    // delete+set moves the key to newest in insertion order, so the size cap
    // below evicts the genuinely-stalest session.
    const existing = this.map.get(sessionId);
    this.map.delete(sessionId);
    const state: SessionRing = existing ?? { ring: [], lastSeq: 0, at: now };
    for (const entry of entries) {
      state.lastSeq += 1;
      state.ring.push({ seq: state.lastSeq, entry });
    }
    // Ring size cap — evict oldest past the ceiling. `while`, not `if`: one
    // append can push the ring several rows over the cap.
    while (state.ring.length > NETWORK_LOG_RING_MAX_ENTRIES) state.ring.shift();
    state.at = now;
    this.map.set(sessionId, state);
    while (this.map.size > this.maxSessions) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /**
   * Read a session's ring. `afterSeq` (default 0) is the server seq a client
   * last saw — only rows strictly newer are returned, so a poll gets just what
   * has been appended since. `next_after` is the newest seq in the ring (null on
   * an empty ring) for the client's next poll. A miss (unknown/swept session)
   * reads as an empty ring, never an error.
   */
  get(sessionId: string, afterSeq = 0): SessionNetworkLog {
    const state = this.map.get(sessionId);
    if (state === undefined) return { entries: [], next_after: null };
    const entries = state.ring.filter((row) => row.seq > afterSeq).map((row) => row.entry);
    const newest = state.ring[state.ring.length - 1];
    const next_after = newest !== undefined ? String(newest.seq) : null;
    return { entries, next_after };
  }

  /** Drop a session's ring (e.g. on session end). Provided but not wired to
   *  terminal-close: the TTL + LRU bounds above are the backstop, mirroring the
   *  exit-identity cache's posture. */
  delete(sessionId: string): void {
    this.map.delete(sessionId);
  }

  /** Active session count — for tests + size assertions. */
  get size(): number {
    return this.map.size;
  }
}
